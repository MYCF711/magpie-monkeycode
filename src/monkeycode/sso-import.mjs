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
// 邀请码只改**这一条导航的 URL**（`?redirect=&inviter_id=<code>`），拼法在站点表里定义：
// 那是「哪家服务器认哪个参数名」的知识，不在这里复制一遍。
import { ssoEntryUrlWithInvite } from "../sites.mjs"
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

/**
 * 记下「这个百智云账号已经开通过 MonkeyCode」。
 *
 * 停用词是**成功之后**：中途失败（授权没完成 / 换 Key 失败）不能写，否则这个号
 * 会被永久跳过，用户点多少次都轮不到它。
 *
 * 对外导出是给**自动开通**（`src/monkeycode/provision.mjs`）用的：那条路不走
 * `importOneBaizhiAccount`，而是自己 `auth.set` 写凭据 —— 回读校验通过之后必须
 * 复用**同一份**台账（同一个文件、同一种格式），否则手动路径会把这个号再导一遍。
 *
 * @param {string} identity 百智云账号的稳定身份（`readBaizhiSessions()` 给的 `identity`）
 */
export function markImported(identity) {
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

/**
 * 现在还能不能再导入一个？（**同步、零网络**）
 *
 * `runtime.mjs` 的 `authorize()` 要**立刻**返回，不能为了判断「还有没有号可导」
 * 去开浏览器 —— 这条只用本地两个文件（账号库 + 已导入状态）就能回答：
 * 有带 `session_cookie` 的 baizhi 条目、且至少一个没被 `markImported` 过。
 *
 * ⚠ 只是**预判**：真到导入时账号库可能已经变了，`importOneBaizhiAccount` 自己
 * 还会再判一次，两边判据必须是同一套（`readBaizhiSessions` + `readImported` +
 * `nextUnimported`），否则会出现「说能导、点下去说没有」。
 *
 * @param {string} [file] 账号库路径（只给单测换成临时文件用）
 * @returns {boolean}
 */
export function hasUnimportedBaizhiSession(file = authStorePath()) {
  const sessions = readBaizhiSessions(file)
  if (sessions.length === 0) return false
  return nextUnimported(sessions, readImported()) !== undefined
}

// ── 复用已登录的百智云会话（照顺序试，不重复开窗） ────────────────────

/** 一条来源返回的东西可能是裸 cookie 串，也可能是 `{ cookie }`；空的一律当「没有」。 */
function cookieFromSource(value) {
  if (typeof value === "string") return value.trim().length > 0 ? value : undefined
  if (value !== null && typeof value === "object") {
    const cookie = value.cookie
    if (typeof cookie === "string" && cookie.trim().length > 0) return value
  }
  return undefined
}

/**
 * 按给定顺序取**第一条**可用的百智云会话 cookie。
 *
 * 为什么把「来源」交给调用方（而不是在这里 import 一堆读盘模块）：
 * 复用顺序是**产品决策**（账号库 → 桌面客户端 → 持久 profile → 最后才开窗，
 * 见 docs/login-unification-audit.md §3.2），而「怎么读」各自有独立实现与单测。
 * 这里只负责那条规矩里最容易写错的部分：**顺序固定、命中即停、空值继续**。
 *
 * · 命中即停：有账号库会话时绝不去碰桌面客户端 / profile（少读一次盘，也避免覆盖判断）；
 * · `read()` 抛错 = 这条来源没有（比如没有桌面客户端），不能因此中断整条链；
 * · 全空返回 `undefined` —— 调用方据此提示「先用桌面版登录一次」或开窗，别在这里擅自开窗。
 *
 * @param {Array<{ name?: string, read: () => (string | { cookie?: string } | undefined | Promise<string | { cookie?: string } | undefined>) }>} [sources]
 * @returns {Promise<string | { cookie?: string } | undefined>}
 */
export async function resolveBaizhiCookie(sources) {
  if (!Array.isArray(sources)) return undefined
  for (const source of sources) {
    if (source === null || typeof source !== "object") continue
    if (typeof source.read !== "function") continue
    let value
    try {
      value = await source.read()
    } catch {
      // 这条来源不可用（文件不存在 / 权限 / 解析失败）→ 继续下一条。
      continue
    }
    const usable = cookieFromSource(value)
    if (usable !== undefined) return usable
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

/**
 * 启动器直接失败（`ENOENT` 没装 / `EACCES` 没执行权限 / 路径其实是个目录）时，
 * 拼一个**结构化**的错给上层：`code` 保留系统错误码，`cause` 保留原始错。
 *
 * 为什么要单独拼：`spawn()` 对这类失败**不会同步抛**，它异步发 `error` 事件；
 * 没有监听器时那个事件会变成 uncaught exception（整个插件进程崩掉），
 * 而只靠轮询则要空等满 60 秒才报「没有打开调试端口」—— 真实原因全丢了。
 */
function spawnFailure(error) {
  const fallback = "unknown"
  const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : fallback
  const detail = error instanceof Error ? error.message : String(error)
  const failure = new Error(`受控浏览器启动失败（${code}）：${detail}`)
  failure.code = code
  failure.cause = error
  return failure
}

async function openPage(url, { browser = findBrowser() } = {}) {
  if (!browser?.path) throw new Error("没有可用的 Chromium 浏览器")
  const port = await freePort()
  const profile = mkdtempSync(join(tmpdir(), "magpie-sso-"))
  let child
  let ws
  // 启动器的异步失败先记在这里，由下面的循环/收尾统一 throw（见 spawnFailure）。
  let spawnError

  // 收尸：无头 Chromium 是**我们**起的，临时 profile 是**我们**建的 ——
  // 失败路径没人替你收，漏一次就是用户多一个孤儿进程 + 一份放不住的临时目录。
  const close = () => {
    try {
      child?.kill()
    } catch {}
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {}
  }

  try {
    child = spawn(browser.path, [
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

    // ⚠ 必须有：没有这个监听器，`ENOENT`/`EACCES` 会以 uncaught exception 的形式
    // 掀掉整个进程（spawn 的失败是异步 `error` 事件，不是同步 throw）。
    child.on("error", (error) => {
      spawnError = spawnFailure(error)
    })

    const deadline = Date.now() + 60_000
    let pageWs = ""
    while (Date.now() < deadline && pageWs.length === 0) {
      // 启动器已经失败了（ENOENT/EACCES）就别再空等 —— 立刻进 catch 收尸并如实报错。
      if (spawnError !== undefined) throw spawnError
      await new Promise((resolve) => setTimeout(resolve, 300))
      try {
        const pages = await getJson(`http://127.0.0.1:${port}/json/list`)
        pageWs = pages.find((page) => page.type === "page" && page.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? ""
      } catch {}
    }
    // 边界：错误恰好在 deadline 那一刻到达（循环条件先失效）。
    if (spawnError !== undefined) throw spawnError
    if (pageWs.length === 0) throw new Error("受控浏览器没有打开调试端口")

    ws = new WebSocket(pageWs)
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true })
      ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连不上")), { once: true })
    })
    await cdpSend(ws, 1, "Network.enable").catch(() => {})
    await cdpSend(ws, 2, "Page.enable").catch(() => {})
    return { ws, close }
  } catch (error) {
    // 调试端口没起来 / WebSocket 构造抛错 / 连不上 —— 三条都必须先收尸再把错抛出去。
    try {
      ws?.close()
    } catch {}
    close()
    throw error
  }
}

/**
 * 显示名：`GET /api/v1/users/status` 上游回的是 `user.name`（2026-11-04 桌面会话实测
 * `{ id, name: "观猹员 0632" }`），**不是** `nickname`；而 `credits.mjs` 的
 * `fetchProfile` 又把 name / nickname / display_name / username 归一到 `nickname`。
 *
 * 所以两个都认、谁有值用谁。只认一个的后果是「卡片上的账号名变成供应商名」——
 * 它不报错、测试也不会自己发现，只能靠这里和 `tests/sso-import.test.mjs` 锁住。
 *
 * @param {{ name?: string, nickname?: string } | undefined} profile
 * @returns {string | undefined}
 */
function nicknameOf(profile) {
  if (profile === null || typeof profile !== "object") return undefined
  const found = [profile.name, profile.nickname]
    .find((value) => typeof value === "string" && value.trim().length > 0)
  return found === undefined ? undefined : found.trim()
}

/**
 * 用一条百智云会话换一个 MonkeyCode 账号。
 *
 * @param {string} baizhiCookie 百智云的 `baizhi_session=…` 串
 * @param {{ id?: string, platformBaseUrl: string, sessionCookie: string }} site MonkeyCode 站点
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, inviteCode?: string }} [options]
 *   `inviteCode` 可选：填了就在**首次建号**的这次登录上带邀请人（国内站 `inviter_id`）。
 *   邀请只在建号那一刻生效、事后补不了；已存在的号带上它也无副作用（服务端照旧 302）。
 *   国际站的拼法恒为裸登录接口 —— 「国际版保持独立」由 `ssoEntryUrlWithInvite` 保证。
 * @returns {Promise<{ credential: object, nickname?: string, userId?: string }>}
 */
export async function signInWithBaizhiSession(baizhiCookie, site, { fetchImpl = fetch, timeoutMs = 120_000, inviteCode = "" } = {}) {
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
    //
    // 带邀请码时只在这条 URL 上加 query（国内站 `?redirect=&inviter_id=<code>`）；
    // 没填码 / 国际站都退回原来那个裸接口，行为与本改动前**一字不差**。
    await cdpSend(ws, 11, "Page.navigate", { url: ssoEntryUrlWithInvite(site, inviteCode) })

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
      // 上游 status 给的是 `name`（credits.mjs 归一成 `nickname`）—— nicknameOf 两个都认。
      nickname: nicknameOf(profile),
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
 * @param {{ id?: string, platformBaseUrl: string, sessionCookie: string }} site
 * @param {{ fetchImpl?: typeof fetch, inviteCode?: string }} [options]
 *   `inviteCode` 原样透传给 `signInWithBaizhiSession` —— 只是「这次建号挂谁的名」，
 *   不参与选号逻辑：选号仍然只看「哪个 baizhi 账号还没 `markImported`」。
 * @returns {Promise<{ ok: true, access: string, accountId: string, uid: string, remaining: number } | { ok: false, error: string, remaining: number }>}
 */
export async function importOneBaizhiAccount(site, { fetchImpl, inviteCode = "" } = {}) {
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
    const result = await signInWithBaizhiSession(next.cookie, site, { fetchImpl, inviteCode })
    // 只有真换成凭据才登记：中途失败（授权没完成 / 换 Key 失败）不写状态，
    // 不然这个号会被永久跳过，用户点多少次都轮不到它。
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

// 单测的接缝：`openPage` 与 `nicknameOf` 都只有跑真实浏览器/真实平台才碰得到，
// 所以把它们暴露出来，让 `tests/sso-import.test.mjs` 能直接验「失败要收尸」和
// 「只有 `name` 时显示名不能丢」这两条会静默退化的行为。
export const _internal = { authStorePath, statePath, readJson, writeJson, openPage, nicknameOf }
