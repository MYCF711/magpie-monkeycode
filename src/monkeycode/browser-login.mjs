// MonkeyCode 浏览器登录：打开一个一次性 Chromium 窗口，等用户在官方页面登完，
// 从 CDP 读出 `monkeycode_ai_session`，再用它换一对网关凭据。
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
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { findBrowser } from "../browser-login.mjs"

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
    await cdpSend(ws, 1, "Network.enable")
    const result = await cdpSend(ws, 2, "Network.getAllCookies")
    return result?.cookies ?? []
  } finally {
    try {
      ws.close()
    } catch {}
  }
}

/** 从 cookie 列表里挑出会话 cookie 的值。 */
function sessionCookieOf(cookies, name) {
  for (const cookie of cookies ?? []) {
    if (cookie?.name !== name) continue
    if (typeof cookie.value !== "string" || cookie.value === "") continue
    return `${name}=${cookie.value}`
  }
  return undefined
}

/**
 * 打开受控浏览器，等用户登录，返回会话 cookie。
 *
 * 与脚手架的 `chromiumLogin` 不同：那里「拿到 cookie 就返回」，这里只是
 * 「读到会话」，是否登录成功由调用方拿它去换 Key 才知道。
 *
 * @param {object} options
 * @param {string} options.url 登录页
 * @param {string} options.cookieName 会话 cookie 名
 * @param {number} [options.timeoutMs]
 * @param {(cookie: string) => Promise<boolean>} options.accept 拿到 cookie 后的判据（换 Key 成功才算登录）
 * @param {AbortSignal} [options.signal]
 * @param {object} [options.browser] 测试注入
 */
export async function browserLogin({ url, cookieName, timeoutMs = BROWSER_LOGIN_TIMEOUT_MS, accept, signal, browser = findBrowser() }) {
  if (!browser?.path) throw new Error("没有可用的 Chromium 浏览器（Chrome / Edge / 国产 Chromium 都行）")

  const profile = mkdtempSync(join(tmpdir(), "magpie-monkeycode-"))
  const port = await freePort()
  const child = spawn(browser.path, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    url,
  ], { stdio: "ignore", windowsHide: false })

  const cleanup = () => {
    try {
      child.kill()
    } catch {}
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {}
  }

  const deadline = Date.now() + timeoutMs
  try {
    let pageWs = ""
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("登录已取消")
      try {
        const pages = await getJson(`http://127.0.0.1:${port}/json/list`)
        pageWs = pages.find((page) => page.type === "page" && page.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? ""
        if (pageWs) break
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    if (!pageWs) throw new Error("受控浏览器没有打开调试端口（浏览器可能吞掉了 --remote-debugging-port）")

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("登录已取消")
      const cookies = await cdpCookies(pageWs).catch(() => [])
      const cookie = sessionCookieOf(cookies, cookieName)
      // 没有会话就继续等；有会话但换不到 Key（匿名会话）也继续等 ——
      // 用户可能只是还没在窗口里点完登录。
      if (cookie !== undefined && await accept(cookie)) return { cookie, browser: browser.name }
      await new Promise((resolve) => setTimeout(resolve, BROWSER_LOGIN_POLL_MS))
    }
    throw new Error("登录超时：浏览器窗口里还没有完成登录")
  } finally {
    cleanup()
  }
}

export const _internal = { cdpCookies, freePort, sessionCookieOf }
