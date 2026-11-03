// 浏览器会话登录（通用）：打开一个一次性 Chromium 窗口，等用户在官方页面登完，
// 从 CDP 读出会话 cookie，再交给调用方判断「这算不算登录成功」。
//
// MonkeyCode 与百智云共用：两家都是「网页登录后下发一张长期凭据」，
// 且都需要容忍「窗口一开就有匿名 cookie」这种中间态。
//
// ## 为什么不能「读到 cookie 就算登录成功」
//
// 窗口一打开，服务端就下发了**匿名** `monkeycode_ai_session` —— 「读到 cookie」
// 远早于「用户登完」。拿匿名会话去换 Key **必然** 401。所以这里的循环是：
// 读 cookie → 试换 Key → 401 就继续等 → 换到了才算登录成功。
// 早期实现把「读到 cookie」当成功，用户刚登完却看到「会话已失效」，白登一次。
//
// ## 为什么复用脚手架而不是自己起浏览器
//
// `src/browser-login.mjs` 已经覆盖 Chrome / Edge / 国产 Chromium 的候选顺序与
// 注册表查找；这里只补 CDP 轮询。窗口用一次性 user-data-dir，不碰用户日常配置。

import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { findBrowser } from "./browser-login.mjs"

/** 默认等用户登录的上限（毫秒）。 */
export const BROWSER_LOGIN_TIMEOUT_MS = 240_000
/** 两轮尝试之间的间隔（毫秒）。 */
export const BROWSER_LOGIN_POLL_MS = 1_000

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

async function cdpCookies(pageWsUrl) {
  const ws = new WebSocket(pageWsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true })
    ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连不上")), { once: true })
  })
  try {
    return await cookiesOn(ws)
  } finally {
    try {
      ws.close()
    } catch {}
  }
}

/**
 * 从 cookie 列表里挑出需要的会话 cookie，拼成 `Cookie` 头。
 *
 * @param {Array} cookies
 * @param {string[]} names 必须**全部**到齐才算登录完成
 * @param {string[]} [domains] 只认这些域（不含子域），不传则不限制
 * @returns {string | undefined}
 */
function sessionCookieOf(cookies, names, domains) {
  const wanted = new Set(names)
  const allow = domains === undefined ? undefined : new Set(domains.map((d) => d.replace(/^\./, "").toLowerCase()))
  const found = new Map()
  for (const cookie of cookies ?? []) {
    if (!cookie || typeof cookie.value !== "string" || cookie.value === "") continue
    if (!wanted.has(cookie.name)) continue
    if (allow !== undefined) {
      const domain = typeof cookie.domain === "string" ? cookie.domain.replace(/^\./, "").toLowerCase() : ""
      if (!allow.has(domain)) continue
    }
    // 同名多域时保留第一个（调用方传了 domains 就不会撞）。
    if (!found.has(cookie.name)) found.set(cookie.name, cookie.value)
  }
  for (const name of names) if (!found.has(name)) return undefined
  return names.map((name) => `${name}=${found.get(name)}`).join("; ")
}

/** 从已连上的 CDP 会话读全部 cookie。 */
async function cookiesOn(ws) {
  await cdpSend(ws, 1, "Network.enable").catch(() => {})
  const result = await cdpSend(ws, 2, "Network.getAllCookies")
  return result?.cookies ?? []
}

/**
 * 持久 profile 目录（登录态跨次保留）。
 *
 * 为什么要持久：用户登录一次百智云之后，MonkeyCode 国内站与国际站的 SSO
 * 应该都**不用再登**（两家共用同一个百智云身份）。临时 profile 每次都把
 * cookie 丢掉，等于每站都要重登一遍 —— 华为云的 codearts/officeace 正是靠
 * 同一个持久 profile 做到「一个账号两个供应商都能进」。
 *
 * 放在 `~/.cache/magpie/`：与 magpie 自己的缓存同处，卸载插件不会误删用户数据。
 */
export function profileDirFor(name) {
  return join(homedir(), ".cache", "magpie", `monkeycode-${name}`, "profile")
}

/**
 * 起一个受控浏览器并连上它的页面。
 *
 * @returns {Promise<{ ws: WebSocket, close: () => void, profileDir: string, persistent: boolean }>}
 */
export async function openControlledBrowser({ url = "about:blank", profileDir, headless = false, browser = findBrowser() } = {}) {
  if (!browser?.path) throw new Error("没有可用的 Chromium 浏览器（Chrome / Edge / 国产 Chromium 都行）")
  const persistent = profileDir !== undefined
  const profile = persistent ? profileDir : mkdtempSync(join(tmpdir(), "magpie-session-login-"))
  if (persistent) mkdirSync(profile, { recursive: true })
  const port = await freePort()
  const child = spawn(browser.path, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    ...(headless ? ["--headless=new"] : []),
    url,
  ], { stdio: "ignore", windowsHide: headless })

  const close = () => {
    try {
      child.kill()
    } catch {}
    // 持久 profile 是用户的登录态，不能删；只有临时目录才回收。
    if (!persistent) {
      try {
        rmSync(profile, { recursive: true, force: true })
      } catch {}
    }
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
    throw new Error("受控浏览器没有打开调试端口（浏览器可能吞掉了 --remote-debugging-port）")
  }
  const ws = new WebSocket(pageWs)
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true })
    ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连不上")), { once: true })
  })
  // 启动参数里的 URL 不一定被采纳（尤其 headless）：连上后显式导航一次，
  // 免得用户对着 about:blank 不知道该干什么。
  if (url !== "about:blank") {
    await cdpSend(ws, 0, "Page.enable").catch(() => {})
    await cdpSend(ws, -1, "Page.navigate", { url }).catch(() => {})
  }
  return { ws, close, profileDir: profile, persistent }
}

/**
 * 静默读一次 cookie（无头 + 持久 profile，读完就关）。
 *
 * 用来回答「这个账号是不是已经登过了」——登过就不用再弹窗。
 * 读不到返回 undefined，不抛错（没登录是正常路径）。
 */
export async function readCookiesSilently({ url = "about:blank", cookieName, cookieNames, cookieDomains, profileDir, browser } = {}) {
  const names = Array.isArray(cookieNames) && cookieNames.length > 0 ? cookieNames : [cookieName]
  let handle
  try {
    handle = await openControlledBrowser({ url, profileDir, headless: true, browser })
    const cookies = await cookiesOn(handle.ws).catch(() => [])
    return sessionCookieOf(cookies, names, cookieDomains)
  } catch {
    return undefined
  } finally {
    try {
      handle?.ws?.close()
    } catch {}
    try {
      handle?.close?.()
    } catch {}
  }
}

/**
 * 打开受控浏览器，等用户登录，返回会话 cookie。
 *
 * @param {object} options
 * @param {string} options.url 登录页
 * @param {string} [options.cookieName] 单枚会话 cookie 名
 * @param {string[]} [options.cookieNames] 多枚（全部到齐才算登录完成）
 * @param {string[]} [options.cookieDomains] 只认这些域（不含子域）
 * @param {string} [options.profileDir] 传了就持久化（登录态跨次保留）
 * @param {number} [options.timeoutMs]
 * @param {(cookie: string) => Promise<boolean>} options.accept 拿到 cookie 后的判据
 * @param {AbortSignal} [options.signal]
 */
export async function browserLogin({
  url,
  cookieName,
  cookieNames,
  cookieDomains,
  timeoutMs = BROWSER_LOGIN_TIMEOUT_MS,
  accept,
  signal,
  profileDir,
  browser = findBrowser(),
  /** 同 startBrowserLogin：一段每秒执行一次的小动作（勾协议、点「确认授权」）。 */
  onPoll,
}) {
  // 单名（MonkeyCode）与多名（百智云要 sl-session + baizhi_session）两种用法。
  const names = Array.isArray(cookieNames) && cookieNames.length > 0 ? cookieNames : [cookieName]

  const handle = await openControlledBrowser({ url, profileDir, browser })
  const deadline = Date.now() + timeoutMs
  let tick = 900
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("登录已取消")
      if (typeof onPoll === "string" && onPoll.length > 0) {
        await cdpSend(handle.ws, tick++, "Runtime.evaluate", { expression: onPoll, returnByValue: true }).catch(() => {})
      }
      const cookies = await cookiesOn(handle.ws).catch(() => [])
      const cookie = sessionCookieOf(cookies, names, cookieDomains)
      // 没有会话就继续等；有会话但换不到 Key（匿名会话）也继续等 ——
      // 用户可能只是还没在窗口里点完登录。
      if (cookie !== undefined && await accept(cookie)) return { cookie, browser: browser.name }
      await new Promise((resolve) => setTimeout(resolve, BROWSER_LOGIN_POLL_MS))
    }
    throw new Error("登录超时：浏览器窗口里还没有完成登录")
  } finally {
    handle.close()
  }
}

/**
 * 「先启动、后等待」形态的浏览器登录。
 *
 * 为什么要拆开：magpie 的登录面板在 `authorize()` 返回后才进入等待态。如果窗口
 * 等到 `callback()` 里才开始启动（要查注册表、要等浏览器起来），面板会先显示
 * 「正在开始登录…」而屏幕上一个窗口都没有 —— 用户不知道要等多久，也拿不到
 * 可手动打开的地址。所以这里在 authorize() 里就把窗口支起来：
 *
 * - 启动失败 → 抛错，调用方把 `opened` 置 false，让 magpie 自己开系统浏览器
 *   （用户至少能登进去、拿到 cookie），并把地址写进说明；
 * - 启动成功 → 返回 `wait()`，callback() 里只等结果。
 *
 * @returns {Promise<{ wait: () => Promise<{cookie: string, browser: string}> , close: () => void }>}
 */
export async function startBrowserLogin({
  url,
  cookieName,
  cookieNames,
  cookieDomains,
  timeoutMs = BROWSER_LOGIN_TIMEOUT_MS,
  accept,
  signal,
  profileDir,
  browser = findBrowser(),
  /**
   * 可选：等待期间每秒跑一次的小动作（例如替用户勾掉「我已同意用户协议」）。
   *
   * 为什么要这个钩子：有的平台把「同意协议」做成**必须先勾**，不勾时扫码/登录
   * 会在背后静默失败 —— 用户以为是自己没扫上，其实是被那个复选框挡住了。
   *
   * @param {string} onPoll 一段 JS 表达式，每秒在主页面执行一次
   */
  onPoll,
}) {
  const names = Array.isArray(cookieNames) && cookieNames.length > 0 ? cookieNames : [cookieName]
  const handle = await openControlledBrowser({ url, profileDir, browser })
  // 存活检查：浏览器可能因为 profile 被占用 / 被策略拦掉而**立刻退出**，
  // 这时 CDP 端口谁也连不上，早点报错比让用户对着空面板等 4 分钟强。
  const closed = () => handle.ws.readyState !== 1
  return {
    close: handle.close,
    async wait() {
      const deadline = Date.now() + timeoutMs
      let pollId = 500
      try {
        while (Date.now() < deadline) {
          if (signal?.aborted) throw new Error("登录已取消")
          if (closed()) throw new Error("受控浏览器窗口被关掉了（或被系统拦下没能启动）")
          if (typeof onPoll === "string" && onPoll.length > 0) {
            await cdpSend(handle.ws, pollId++, "Runtime.evaluate", { expression: onPoll, returnByValue: true }).catch(() => {})
          }
          const cookies = await cookiesOn(handle.ws).catch(() => [])
          const cookie = sessionCookieOf(cookies, names, cookieDomains)
          if (cookie !== undefined && await accept(cookie)) return { cookie, browser: browser.name }
          await new Promise((resolve) => setTimeout(resolve, BROWSER_LOGIN_POLL_MS))
        }
        throw new Error("登录超时：浏览器窗口里还没有完成登录")
      } finally {
        handle.close()
      }
    },
  }
}

export const _internal = { cdpCookies, freePort, sessionCookieOf, cookiesOn }
