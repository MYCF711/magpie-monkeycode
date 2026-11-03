// 用已登录的百智云账号「开通」MonkeyCode 账号（OAuth SSO）。
//
// ## 为什么这条链走得通
//
// MonkeyCode 登录页的「百智云登录 - 推荐」是一个 GET 入口（2026-11-03 从 SPAL 页
// 的 `<a href>` 与 302 响应实测）：
//
//   GET https://monkeycode-ai.com/api/v1/users/login
//     → 302 https://baizhi.cloud/oauth/authorize?client_id=monkeycode-ai
//            &redirect_uri=<monkeycode>/api/v1/users/baizhi/callback
//            &response_type=code&scope=user+phone&state=<uuid>
//     → 百智云看 cookie：已登录就直接 302 回 callback?code=…
//     → MonkeyCode 签发自己的 `monkeycode_ai_session`
//
// 所以只要有百智云的会话 cookie，就能在受控浏览器里**零交互**换出一个
// MonkeyCode 账号（首次登录时由 MonkeyCode 侧自动建号）。
//
// ## 账号从哪来
//
// 读 magpie 自己的账号库（`~/.config/magpie/plugin-auth.json`）里 **baizhi** 的条目：
// 每条凭据 JSON 里都带 `session_cookie`（浏览器登录时存下来的）。插件对 magpie 的
// 目录只有读的份（HOOKS 的规矩），这里只读不写。
//
// ## 一次一个
//
// magpie 的登录契约是「一次 authorize 返回一个账号」，所以这里每调用一次只导一个，
// 已导入的记在本地状态文件里，下一次跳过。用户点 N 次导入 N 个号。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"

import { findBrowser } from "../browser-login.mjs"
import { exchangeSessionForKey, fetchProfile, resolveTier } from "./credits.mjs"
import { warmCatalog } from "./catalog.mjs"
import { parseCredential } from "../credential.mjs"

/** magpie 的账号库位置（Windows / macOS / Linux 同一套约定）。 */
function authStorePath() {
  return join(homedir(), ".config", "magpie", "plugin-auth.json")
}

/** 本地状态：已导入过哪些百智云账号（按百智云 user_id 或 key 身份记）。 */
function statePath() {
  return join(homedir(), ".cache", "magpie", "monkeycode-imported.json")
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  mkdirSync(join(file, ".."), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * 从 magpie 的账号库里取出所有 baizhi 账号的会话 cookie。
 *
 * 条目形如 `{"type":"api"|"oauth", "access": "<JSON 字符串>", ...}`，
 * 里面解析出来的 `session_cookie` 才是我们需要的。
 */
export function readBaizhiSessions(file = authStorePath()) {
  const store = readJson(file, {})
  if (store === null || typeof store !== "object") return []
  const out = []
  for (const [key, value] of Object.entries(store)) {
    if (key !== "baizhi" && !key.startsWith("baizhi#")) continue
    if (value === null || typeof value !== "object") continue
    const raw = typeof value.access === "string" ? value.access : (typeof value.key === "string" ? value.key : "")
    if (raw.length === 0) continue
    // 一条能用的百智云账号 = 有 session_cookie（导入只需要它去走 SSO）。
    // 只有 cookie、没有 sk- key 的账号正是「手抄 cookie 进来」的那种，照样能开通
    // MonkeyCode —— 别把这类账号挡在门外。
    const credential = parseCredential(raw)
    if (credential === undefined) continue
    if (typeof credential.session_cookie !== "string" || credential.session_cookie.trim().length === 0) continue
    out.push({
      key,
      cookie: credential.session_cookie.trim(),
      // 百智云的稳定身份（有就用来去重）。
      identity: credential.user_id ?? credential.access_token ?? key,
      accountId: value.accountId ?? "",
    })
  }
  return out
}

function readImported() {
  const state = readJson(statePath(), {})
  return new Set(Array.isArray(state.imported) ? state.imported : [])
}

function markImported(identity) {
  const state = readJson(statePath(), {})
  const list = new Set(Array.isArray(state.imported) ? state.imported : [])
  list.add(identity)
  writeJson(statePath(), { imported: [...list], updatedAt: new Date().toISOString() })
}

/** 取一个还没导入过的百智云账号；没有返回 undefined。 */
export function nextUnimported(sessions, imported) {
  for (const session of sessions) {
    if (!imported.has(session.identity)) return session
  }
  return undefined
}

// ── 受控浏览器（只为了 SSO 这一次） ────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

async function getJson(url, timeoutMs = 1_500) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

function cdpSend(ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id !== id) return
      ws.removeEventListener("message", onMessage)
      if (message.error) reject(new Error(message.error.message || "CDP error"))
      else resolve(message.result)
    }
    ws.addEventListener("message", onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function openPage(url) {
  const browser = findBrowser()
  if (!browser?.path) throw new Error("没有可用的 Chromium 浏览器")
  const profile = mkdtempSync(join(tmpdir(), "magpie-sso-"))
  const port = await freePort()
  const child = spawn(browser.path, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    // 无头：SSO 是纯后台动作，弹窗只会让人以为插件又开了个浏览器。
    "--headless=new",
    url,
  ], { stdio: "ignore", windowsHide: true })

  const close = () => {
    try {
      child.kill()
    } catch {}
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {}
  }

  const deadline = Date.now() + 60_000
  let pageWs = ""
  while (Date.now() < deadline && pageWs.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    try {
      const pages = await getJson(`http://127.0.0.1:${port}/json/list`)
      pageWs = pages.find((page) => page.type === "page" && page.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? ""
    } catch {}
  }
  if (pageWs.length === 0) {
    close()
    throw new Error("受控浏览器没有打开调试端口")
  }
  const ws = new WebSocket(pageWs)
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true })
    ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连不上")), { once: true })
  })
  await cdpSend(ws, 1, "Network.enable").catch(() => {})
  await cdpSend(ws, 2, "Page.enable").catch(() => {})
  return { ws, close }
}

/**
 * 用一条百智云会话换一个 MonkeyCode 账号。
 *
 * @param {string} baizhiCookie 百智云的 `baizhi_session=…` 串
 * @param {{ platformBaseUrl: string, sessionCookie: string }} site MonkeyCode 站点
 * @returns {Promise<{ credential: object, nickname?: string, userId?: string }>}
 */
export async function signInWithBaizhiSession(baizhiCookie, site, { fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  const { ws, close } = await openPage("about:blank")
  try {
    // 把百智云的**每一枚** cookie 都塞进这个一次性浏览器。
    //
    // ⚠ 不能只设 baizhi_session：控制台同时要 sl-session（设备/风控），
    // 只带一枚时 /api/v1/user/profile 回 401。
    // ⚠ 用 `url` 而不是 `domain`：用 domain 时 CDP 会做一遍 sanitize，
    // 含 `/` 和 `==` 的 sl-session 值会被判 "Sanitizing cookie failed"。
    let cookieId = 10
    for (const pair of baizhiCookie.split(";")) {
      const trimmed = pair.trim()
      if (trimmed.length === 0) continue
      const eq = trimmed.indexOf("=")
      if (eq <= 0) continue
      const name = trimmed.slice(0, eq).trim()
      const value = trimmed.slice(eq + 1)
      if (name.length === 0 || value.length === 0) continue
      await cdpSend(ws, cookieId++, "Network.setCookie", {
        name,
        value,
        url: "https://baizhi.cloud/",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    }

    // 登录入口自己会 302 到百智云的授权页，再 302 回 callback。
    await cdpSend(ws, 11, "Page.navigate", { url: `${site.platformBaseUrl}/api/v1/users/login` })

    const deadline = Date.now() + timeoutMs
    let cookieHeader
    let tick = 500
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      // 百智云的 OAuth 授权页是一张**确认页**（「OAuth 授权确认 · 确认授权 / 取消」），
      // 不会自己跳过去。用 CDP 点掉它 —— 这一步正是「复用本机账号」和「再登一次」的区别。
      await cdpSend(ws, tick++, "Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const btn = [...document.querySelectorAll('button,a,[role=button]')]
            .find((el) => /确认授权|同意授权|允许授权|^授权$/.test(((el.textContent || '') + '').trim()));
          if (!btn) return 'none';
          btn.click();
          return 'clicked';
        })()`,
      }).catch(() => {})
      const { cookies } = await cdpSend(ws, tick++, "Network.getAllCookies")
      const session = (cookies ?? []).find((cookie) => cookie.name === site.sessionCookie && cookie.value)
      if (session) {
        cookieHeader = `${session.name}=${session.value}`
        break
      }
    }
    if (cookieHeader === undefined) throw new Error("百智云授权没有完成（60 秒内没有拿到 MonkeyCode 会话）")

    const issued = await exchangeSessionForKey(cookieHeader, site, { fetchImpl, timeoutMs: 30_000 })
    if (!issued.ok) throw new Error(`已拿到 MonkeyCode 会话，但换取网关凭据失败（${issued.error}）`)
    const profile = await fetchProfile(cookieHeader, site, { fetchImpl, timeoutMs: 30_000 })
    // 顺手把平台目录拉一次落盘，并探测「这个号到底能用哪些」：
    // 模型 id 是平台下发的 UUID（内置快照早对不上），而上架 ≠ 有权限。
    // 登录成功就落盘目录（不探测：平台清单本身就是这个账号能调什么）。
    const tier = await resolveTier(cookieHeader, site, { fetchImpl }).catch(() => undefined)
    await warmCatalog(cookieHeader, site, { fetchImpl, tier }).catch(() => {})
    return {
      credential: {
        access_token: issued.apiKey,
        signing_secret: issued.signingSecret,
        session_cookie: cookieHeader,
        ...(profile?.userId === undefined ? {} : { user_id: profile.userId }),
      },
      nickname: profile?.nickname,
      userId: profile?.userId,
    }
  } finally {
    try {
      ws.close()
    } catch {}
    close()
  }
}

/**
 * 导入一个还没导入过的百智云账号。
 *
 * @returns {Promise<{ ok: true, access: string, accountId: string, uid: string, remaining: number } | { ok: false, error: string, remaining: number }>}
 */
export async function importOneBaizhiAccount(site, { fetchImpl } = {}) {
  const sessions = readBaizhiSessions()
  const imported = readImported()
  const pending = sessions.filter((session) => !imported.has(session.identity))
  if (sessions.length === 0) {
    return {
      ok: false,
      remaining: 0,
      error: "magpie 里还没有已登录的百智云账号 —— 先在「百智云 BaiZhiCloud」卡片上用浏览器登录一次",
    }
  }
  const next = nextUnimported(sessions, imported)
  if (next === undefined) {
    return { ok: false, remaining: 0, error: `百智云的 ${sessions.length} 个账号都已经导入过了` }
  }
  try {
    const result = await signInWithBaizhiSession(next.cookie, site, { fetchImpl })
    markImported(next.identity)
    return {
      ok: true,
      access: JSON.stringify(result.credential),
      accountId: result.nickname ?? "",
      uid: result.userId ?? "",
      remaining: sessions.length - imported.size - 1,
    }
  } catch (error) {
    return {
      ok: false,
      remaining: sessions.length - imported.size,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export const _internal = { authStorePath, statePath, readJson, writeJson }
