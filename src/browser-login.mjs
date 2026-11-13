// src/browser-login.mjs —— 打开一个受控 Chromium 窗口，让用户正常登录，再从 CDP 取 Cookie
//
// 什么时候用：厂商没有 OAuth 回调、也没有桌面客户端可导入，但网页登录后 Cookie 就是凭据。
// 比「让用户自己 F12 复制 Cookie」可靠：用户只需要在窗口里登录一次。
//
// 设计取舍（来自 WPS 灵犀 0.4.11 的实测实现，MIT；见 NOTICE.md）：
//   · 任意 Chromium 内核浏览器都行（Chrome / Edge / 360 / QQ / Brave / Vivaldi…），
//     不止 Chrome；国产浏览器在 Windows 上很常见，漏了它们这条登录路对用户就不存在。
//   · Windows 优先读系统默认浏览器，但只接受 CDP 已验证较稳定的 Chrome / Edge /
//     Chromium / Brave / Vivaldi / Opera；其余候选里 Quark 最后兜底（它的内部页会扰动 CDP 目标）。
//   · 用一次性 user-data-dir，不碰用户日常浏览器配置；登录态只在本次窗口里。
//   · 退出码不可靠：浏览器可能把调试参数吞掉，所以以「CDP 端口能不能连上」为准。
//
// ⚠ 只读 Cookie，不写浏览器数据；窗口关闭后临时 profile 会被删掉。
// ⚠ 本模块不依赖任何第三方包；Node 22+ 的全局 WebSocket 足够。

import { spawn } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import { execFileSync } from "node:child_process"

const WIN_CDP_STABLE = new Map([
  ["chrome.exe", "Chrome"],
  ["msedge.exe", "Edge"],
  ["chromium.exe", "Chromium"],
  ["brave.exe", "Brave"],
  ["vivaldi.exe", "Vivaldi"],
  ["opera.exe", "Opera"],
])

const WIN_EXES = [
  "chrome.exe",
  "msedge.exe",
  "chromium.exe",
  "Brave.exe",
  "vivaldi.exe",
  "opera.exe",
  "360ChromeX.exe",
  "360chrome.exe",
  "360se.exe",
  "QQBrowser.exe",
  "SogouExplorer.exe",
  "2345Explorer.exe",
  "liebao.exe",
  "Maxthon.exe",
  "UCBrowser.exe",
  "Quark.exe",
]

/**
 * 查一条注册表字符串；查不到返回空串。
 * stderr 必须丢弃：逐候选探测时「键不存在」是正常分支，不该刷满 magpie 的 app.log。
 */
export function registryQuery(key, value, { exec = execFileSync, platform = process.platform } = {}) {
  if (platform !== "win32") return ""
  try {
    const args = ["query", key, ...(value ? ["/v", value] : ["/ve"])]
    const out = exec("reg", args, {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const line = out.split(/\r?\n/).find((l) => /REG_SZ\s+/i.test(l) && (!value || l.includes(value)))
    return line?.split(/\s+REG_SZ\s+/i)[1]?.trim() ?? ""
  } catch {
    return ""
  }
}

/** Windows 注册表 App Paths 查浏览器；查不到返回空串。 */
export function registryAppPath(exe) {
  if (process.platform !== "win32") return ""
  for (const root of ["HKCU", "HKLM"]) {
    for (const tail of [
      `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
      `SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    ]) {
      const path = registryQuery(`${root}\\${tail}`)
      if (path && existsSync(path)) return path
    }
  }
  return ""
}

/** 从 `shell\open\command` 的默认命令里抽出 exe 路径（兼容带空格与带引号路径）。 */
function executableFromCommand(command) {
  const match = command.trim().match(/^"([^"]+\.exe)"|^(.+?\.exe)(?:\s|$)/i)
  return (match?.[1] ?? match?.[2] ?? "").trim()
}

/**
 * Windows 系统默认浏览器：UserChoice → Classes\<ProgId>\shell\open\command → exe。
 *
 * 只返回 CDP 稳定白名单。夸克等浏览器即便被设为默认，也走后面的普通候选顺序，
 * 避免「能开调试端口，但内部页回收登录目标」的浏览器被第一顺位选中。
 */
export function systemDefaultBrowser({ platform = process.platform, query = registryQuery } = {}) {
  if (platform !== "win32") return null
  const progId = query("HKCU\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice", "ProgId")
  if (!progId) return null
  for (const root of ["HKCU\\SOFTWARE\\Classes", "HKLM\\SOFTWARE\\Classes", "HKCR"]) {
    const command = query(`${root}\\${progId}\\shell\\open\\command`)
    if (!command) continue
    const path = executableFromCommand(command)
    const exe = path.split(/[\\/]/).pop()?.toLowerCase() ?? ""
    const name = WIN_CDP_STABLE.get(exe)
    if (name) return { name, path }
  }
  return null
}

/** 从自定义 exe 路径取一个可显示的名字。 */
function browserNameFromPath(path) {
  const filename = path.split(/[\\/]/).pop() ?? path
  return WIN_CDP_STABLE.get(filename.toLowerCase()) ?? filename.replace(/\.exe$/i, "")
}

/**
 * 候选浏览器（按优先级）。不做存在性检查，方便测试与排序。
 * @param {{platform?:string, env?:Record<string,string>, lookup?:(exe:string)=>string, defaultBrowser?:{name:string,path:string}|null}} [o]
 * @returns {{name:string, path:string}[]}
 */
export function browserCandidates({ platform = process.platform, env = process.env, lookup = registryAppPath, defaultBrowser = null } = {}) {
  const h = env.HOME || env.USERPROFILE || ""
  const local = env.LOCALAPPDATA || ""
  const roaming = env.APPDATA || ""
  const pf = env.PROGRAMFILES || ""
  const pf86 = env["PROGRAMFILES(X86)"] || env["ProgramFiles(x86)"] || ""
  const add = (list, name, path) => {
    if (path) list.push({ name, path })
  }
  const preferred = []
  const override = env.MAGPIE_BROWSER?.trim().replace(/^"([\s\S]*)"$/g, "$1") ?? ""
  if (override) add(preferred, browserNameFromPath(override), override)
  if (defaultBrowser?.path) add(preferred, defaultBrowser.name, defaultBrowser.path)

  if (platform === "win32") {
    const list = []
    const quarkFallback = []
    for (const exe of WIN_EXES) {
      const fromRegistry = lookup(exe)
      // 仅夸克的注册表命中延后；否则会抢在标准路径里的 Chrome/Edge 前。
      // 名字统一用白名单 canonical 名（Chrome / Edge…），不要带注册表 exe 的小写形态。
      if (fromRegistry) {
        const name = WIN_CDP_STABLE.get(exe.toLowerCase()) ?? exe.replace(/\.exe$/i, "")
        add(exe.toLowerCase() === "quark.exe" ? quarkFallback : list, name, fromRegistry)
      }
    }
    add(list, "Chrome", join(pf, "Google", "Chrome", "Application", "chrome.exe"))
    add(list, "Chrome", join(pf86, "Google", "Chrome", "Application", "chrome.exe"))
    add(list, "Chrome", join(local, "Google", "Chrome", "Application", "chrome.exe"))
    add(list, "Chromium", join(local, "Chromium", "Application", "chrome.exe"))
    add(list, "Chromium", join(pf, "Chromium", "Application", "chrome.exe"))
    add(list, "Brave", join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))
    add(list, "Brave", join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))
    add(list, "Vivaldi", join(local, "Vivaldi", "Application", "vivaldi.exe"))
    add(list, "Opera", join(local, "Programs", "Opera", "opera.exe"))
    add(list, "Opera", join(roaming, "Opera Software", "Opera Stable", "opera.exe"))
    add(list, "Edge", join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"))
    add(list, "Edge", join(pf, "Microsoft", "Edge", "Application", "msedge.exe"))
    add(list, "360极速浏览器X", join(local, "360ChromeX", "Chrome", "Application", "360ChromeX.exe"))
    add(list, "360浏览器", join(local, "360Chrome", "Chrome", "Application", "360chrome.exe"))
    add(list, "360安全浏览器", join(roaming, "secoresdk", "360se6", "Application", "360se.exe"))
    add(list, "QQ浏览器", join(local, "Tencent", "QQBrowser", "Application", "QQBrowser.exe"))
    add(list, "搜狗浏览器", join(local, "SogouExplorer", "SogouExplorer.exe"))
    add(list, "2345浏览器", join(local, "2345Explorer", "2345Explorer.exe"))
    add(list, "猎豹浏览器", join(local, "liebao", "liebao.exe"))
    add(list, "Maxthon", join(roaming, "Maxthon3", "Bin", "Maxthon.exe"))
    add(list, "UC浏览器", join(local, "UCBrowser", "Application", "UCBrowser.exe"))
    // 夸克最后兜底：它能开 CDP 端口，但内部页会注入 /json/list，并可能回收登录 page 目标。
    add(list, "夸克浏览器", join(local, "Quark", "Quark.exe"))
    return dedupe([...preferred, ...list, ...quarkFallback])
  }

  if (platform === "darwin") {
    return dedupe([
      ...preferred,
      ...[
        ["Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
        ["Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
        ["Brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
        ["Vivaldi", "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi"],
        ["Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
      ].map(([name, path]) => ({ name, path })),
    ])
  }

  return dedupe([
    ...preferred,
    ...[
      ["Chrome", join(h, ".config/google-chrome/chrome")],
      ["Chromium", join(h, ".config/chromium/chrome")],
      ["Brave", join(h, ".config/BraveSoftware/Brave-Browser/brave")],
      ["Vivaldi", join(h, ".config/vivaldi/vivaldi")],
      ["Edge", join(h, ".config/microsoft-edge/msedge")],
    ].map(([name, path]) => ({ name, path })),
  ])
}

function dedupe(list) {
  const seen = new Set()
  return list.filter((x) => {
    const key = x.path.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 第一个真实存在的候选；没有返回 null。 */
export function findBrowser({ platform = process.platform, env = process.env, exists = existsSync, lookup = registryAppPath, defaultBrowser, query = registryQuery } = {}) {
  const preferDefault = env.MAGPIE_BROWSER_PREFER_DEFAULT !== "0" && !env.MAGPIE_BROWSER?.trim()
  const resolvedDefault = preferDefault
    ? (defaultBrowser === undefined ? systemDefaultBrowser({ platform, query }) : defaultBrowser)
    : null
  return browserCandidates({ platform, env, lookup, defaultBrowser: resolvedDefault }).find((b) => exists(b.path)) ?? null
}

/** 从 CDP 的 cookie 列表里挑需要的名字；返回 header 字符串与命中的键。 */
export function selectCookies(cookies, names) {
  const want = new Set(names)
  const found = {}
  for (const c of cookies ?? []) {
    if (!c?.name || !want.has(c.name)) continue
    if (typeof c.value !== "string" || c.value === "") continue
    found[c.name] = c.value
  }
  return { header: Object.entries(found).map(([k, v]) => `${k}=${v}`).join("; "), found }
}

/** 等一个文件出现；超时返回 false，不抛。 */
export async function waitForFile(file, timeoutMs = 30_000, stepMs = 200) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (existsSync(file)) return true
    await new Promise((r) => setTimeout(r, stepMs))
  }
  return false
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

async function getJson(url, timeoutMs = 5000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
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

/**
 * 从 `/json/list` 选登录 page：优先登录 URL 的 origin，找不到才退回第一个 page。
 * 不能直接取首位 —— 夸克等浏览器会把 `uccd://…` 内部页插到登录页前面。
 * `fallback:false` 用于断开诊断：没有同源页就如实报目标消失，不把内部页当登录页。
 */
export function selectPageTarget(pages, url, { fallback = true } = {}) {
  const candidates = (pages ?? []).filter((p) => p?.type === "page" && p.webSocketDebuggerUrl)
  if (url === "about:blank") {
    const match = candidates.find((p) => p.url === "about:blank")
    return match ?? (fallback ? candidates[0] : undefined)
  }
  let origin = ""
  try {
    const parsed = new URL(url)
    if (parsed.protocol === "http:" || parsed.protocol === "https:") origin = parsed.origin
  } catch {}
  if (origin) {
    const match = candidates.find((p) => {
      try {
        return new URL(p.url).origin === origin
      } catch {
        return false
      }
    })
    if (match) return match
  }
  return fallback ? candidates[0] : undefined
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
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (msg.id !== id) return
      if (msg.error) finish(reject, new Error(msg.error.message || "CDP error"))
      else finish(resolve, msg.result)
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
    await cdpSend(ws, 1, "Network.enable")
    const result = await cdpSend(ws, 2, "Network.getAllCookies")
    return result?.cookies ?? []
  } finally {
    try { ws?.close() } catch {}
  }
}

/**
 * 打开受控浏览器，等用户登录，返回需要的 Cookie。
 *
 * @param {object} o
 * @param {{name:string,path:string}} o.browser findBrowser() 的返回值
 * @param {string} o.url 登录页
 * @param {string[]} [o.cookieNames] 必须拿到的 cookie 名
 * @param {number} [o.timeoutMs] 默认 5 分钟
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{cookie:string, found:Record<string,string>, browser:string}>}
 */
export async function chromiumLogin({ browser, url, cookieNames = [], timeoutMs = 5 * 60_000, signal }) {
  if (!browser?.path) throw new Error("没有可用的 Chromium 浏览器")
  const profile = mkdtempSync(join(tmpdir(), "magpie-login-"))
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
  let spawnError = null
  child.once("error", (error) => {
    spawnError = error
  })
  const assertSpawned = () => {
    if (spawnError) throw new Error(`受控浏览器启动失败：${spawnError.message}`)
  }

  const cleanup = () => {
    try { child.kill() } catch {}
    try { rmSync(profile, { recursive: true, force: true }) } catch {}
  }
  const deadline = Date.now() + timeoutMs
  try {
    let pageWs = ""
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("登录已取消")
      assertSpawned()
      try {
        const pages = await getJson(`http://127.0.0.1:${port}/json/list`, 1000)
        pageWs = selectPageTarget(pages, url)?.webSocketDebuggerUrl ?? ""
        if (pageWs) break
      } catch {}
      await new Promise((r) => setTimeout(r, 300))
    }
    if (!pageWs) throw new Error("受控浏览器没有打开调试端口（浏览器可能吞掉了 --remote-debugging-port）")

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("登录已取消")
      assertSpawned()
      const cookies = await cdpCookies(pageWs).catch(() => [])
      const { header, found } = selectCookies(cookies, cookieNames)
      const ok = cookieNames.length === 0 ? header.length > 0 : cookieNames.every((n) => found[n])
      if (ok) return { cookie: header, found, browser: browser.name }
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error(`登录超时：没有拿到 ${cookieNames.join(" / ")}`)
  } finally {
    cleanup()
  }
}

export const _internal = { WIN_EXES, freePort, cdpCookies, cdpSend, connectWebSocket }
