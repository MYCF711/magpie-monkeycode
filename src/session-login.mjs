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

import { findBrowser, selectPageTarget } from "./browser-login.mjs"

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

/** 建连也有 finish 语义：close-only、构造器异常和超时都不能把登录流程永久挂住。 */
function connectWebSocket(pageWsUrl, { timeoutMs = 10_000, create = (url) => new WebSocket(url) } = {}) {
  return new Promise((resolve, reject) => {
    let ws
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      ws?.removeEventListener("open", onOpen)
      ws?.removeEventListener("close", onClose)
      ws?.removeEventListener("error", onError)
    }
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      cleanup()
      callback(value)
    }
    const fail = (error) => {
      finish(reject, error)
      try { ws?.close() } catch {}
    }
    const onOpen = () => finish(resolve, ws)
    const onClose = () => fail(new Error("CDP WebSocket 握手期间关闭"))
    const onError = () => fail(new Error("CDP WebSocket 连不上"))
    const timer = setTimeout(() => fail(new Error("CDP WebSocket 握手超时")), timeoutMs)
    try {
      ws = create(pageWsUrl)
      ws.addEventListener("open", onOpen)
      ws.addEventListener("close", onClose)
      ws.addEventListener("error", onError)
    } catch (error) {
      fail(error)
    }
  })
}

function cdpSend(ws, id, method, params = {}, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      ws.removeEventListener("message", onMessage)
      ws.removeEventListener("close", onClose)
      ws.removeEventListener("error", onError)
    }
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      cleanup()
      callback(value)
    }
    const onMessage = (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id !== id) return
      if (message.error) finish(reject, new Error(message.error.message || "CDP error"))
      else finish(resolve, message.result)
    }
    const onClose = () => finish(reject, new Error(`CDP WebSocket 已关闭（${method}）`))
    const onError = () => finish(reject, new Error(`CDP WebSocket 错误（${method}）`))
    const timer = setTimeout(() => finish(reject, new Error(`CDP 命令超时（${method}）`)), timeoutMs)
    ws.addEventListener("message", onMessage)
    ws.addEventListener("close", onClose)
    ws.addEventListener("error", onError)
    try {
      ws.send(JSON.stringify({ id, method, params }))
    } catch (error) {
      finish(reject, error)
    }
  })
}

async function cdpCookies(pageWsUrl) {
  let ws
  try {
    ws = await connectWebSocket(pageWsUrl)
    return await cookiesOn(ws)
  } finally {
    try {
      ws?.close()
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

/** 原 target 有 id 时，id 消失就是目标被回收；同源新 target 不能把它伪装成普通断线。 */
function diagnosePageTargets(pages, url, pageTargetId) {
  if (pageTargetId) {
    const sameTarget = (pages ?? []).some((p) => p?.id === pageTargetId && p.type === "page")
    return sameTarget ? "detached" : "target-gone"
  }
  return selectPageTarget(pages, url, { fallback: false }) ? "detached" : "target-gone"
}

/** browserLogin 与 startBrowserLogin 共用的断开检查；命令失败时即使 WS 仍 OPEN 也可强制查目标。 */
async function assertBrowserConnected(handle, { force = false } = {}) {
  const open = handle.ws.readyState === 1
  if (open && !force) return
  const reason = await handle.diagnoseDisconnect()
  // 目标仍在且 WS 仍 OPEN：这次命令失败可以是瞬时的，让外层继续轮询。
  if (reason === "detached" && open) return
  if (reason === "target-gone") {
    throw new Error("受控浏览器中的登录页面目标消失了（可能被浏览器回收；窗口不一定被关闭）")
  }
  if (reason === "detached") {
    throw new Error("受控浏览器的 CDP 连接断开了，但登录页面仍在；请重试浏览器登录")
  }
  if (reason === "browser-closed") {
    throw new Error("受控浏览器进程已退出（窗口可能已关闭，或被系统拦截）")
  }
  throw new Error("受控浏览器的 CDP 调试端口不可达（窗口可能仍在运行，也可能是连接被拦截）")
}

/** 读 cookie 失败也查一次 target：夸克可能在 WS 仍 OPEN 时销毁页面目标。 */
async function loginCookies(handle) {
  try {
    return await cookiesOn(handle.ws)
  } catch {
    await assertBrowserConnected(handle, { force: true })
    return []
  }
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
export async function openControlledBrowser({ url = "about:blank", profileDir, headless = false, browser = findBrowser(), spawnImpl = spawn } = {}) {
  if (!browser?.path) throw new Error("没有可用的 Chromium 浏览器（Chrome / Edge / 国产 Chromium 都行）")
  const persistent = profileDir !== undefined
  const profile = persistent ? profileDir : mkdtempSync(join(tmpdir(), "magpie-session-login-"))
  if (persistent) mkdirSync(profile, { recursive: true })
  const port = await freePort()
  const child = spawnImpl(browser.path, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    ...(headless ? ["--headless=new"] : []),
    url,
  ], { stdio: "ignore", windowsHide: headless })
  let childExited = false
  let spawnError = null
  child.once("exit", () => {
    childExited = true
  })
  child.once("error", (error) => {
    spawnError = error
  })

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

  const assertProcessRunning = () => {
    if (spawnError) {
      close()
      throw new Error(`受控浏览器启动失败：${spawnError.message}`)
    }
    if (childExited) {
      close()
      throw new Error("受控浏览器进程已退出（可能被安全软件拦截）")
    }
  }

  const deadline = Date.now() + 60_000
  let pageWs = ""
  let pageTargetId = ""
  while (Date.now() < deadline && pageWs.length === 0) {
    assertProcessRunning()
    await new Promise((resolve) => setTimeout(resolve, 300))
    try {
      const pages = await getJson(`http://127.0.0.1:${port}/json/list`)
      // 必须按登录 URL 的 origin 选目标：夸克等浏览器会把内部页插到 `/json/list` 首位。
      const target = selectPageTarget(pages, url)
      pageWs = target?.webSocketDebuggerUrl ?? ""
      pageTargetId = target?.id ?? ""
    } catch {}
  }
  if (pageWs.length === 0) {
    close()
    throw new Error("受控浏览器没有打开调试端口（浏览器可能吞掉了 --remote-debugging-port）")
  }
  let ws
  try {
    // 构造器也在 connectWebSocket 的 try 内；任何建连失败都回收子进程与临时 profile。
    ws = await connectWebSocket(pageWs)
  } catch (error) {
    close()
    throw error
  }
  // 启动参数里的 URL 不一定被采纳（尤其 headless）：连上后显式导航一次，
  // 免得用户对着 about:blank 不知道该干什么。
  if (url !== "about:blank") {
    await cdpSend(ws, 0, "Page.enable").catch(() => {})
    await cdpSend(ws, -1, "Page.navigate", { url }).catch(() => {})
  }

  /**
   * WS 断开后查一次目标列表，区分「页面目标被回收」与「整个浏览器/调试端口消失」。
   * 只在失败路径调用，不给正常轮询增加额外请求。
   */
  const diagnoseDisconnect = async () => {
    if (childExited) return "browser-closed"
    try {
      const pages = await getJson(`http://127.0.0.1:${port}/json/list`, 1000)
      return diagnosePageTargets(pages, url, pageTargetId)
    } catch {
      // 单次超时 / JSON 错误不能证明窗口被关；只有进程 exit 才归到 browser-closed。
      return childExited ? "browser-closed" : "browser-unreachable"
    }
  }

  return { ws, close, profileDir: profile, persistent, diagnoseDisconnect }
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
      await assertBrowserConnected(handle)
      if (typeof onPoll === "string" && onPoll.length > 0) {
        await cdpSend(handle.ws, tick++, "Runtime.evaluate", { expression: onPoll, returnByValue: true }).catch(() => {})
      }
      const cookies = await loginCookies(handle)
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
  // 存活检查：区分页面 target 被回收、CDP 断开、进程退出与单纯端口不可达，
  // 不再把所有 readyState 非 OPEN 都误报成「用户关了窗口」。
  return {
    close: handle.close,
    async wait() {
      const deadline = Date.now() + timeoutMs
      let pollId = 500
      try {
        while (Date.now() < deadline) {
          if (signal?.aborted) throw new Error("登录已取消")
          await assertBrowserConnected(handle)
          if (typeof onPoll === "string" && onPoll.length > 0) {
            await cdpSend(handle.ws, pollId++, "Runtime.evaluate", { expression: onPoll, returnByValue: true }).catch(() => {})
          }
          const cookies = await loginCookies(handle)
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

export const _internal = { cdpCookies, cdpSend, connectWebSocket, freePort, sessionCookieOf, cookiesOn, assertBrowserConnected, diagnosePageTargets, loginCookies }
