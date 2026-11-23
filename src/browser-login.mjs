// src/browser-login.mjs —— 打开一个受控 Chromium 窗口，让用户正常登录，再从 CDP 取 Cookie
//
// 什么时候用：厂商没有 OAuth 回调、也没有桌面客户端可导入，但网页登录后 Cookie 就是凭据。
// 比「让用户自己 F12 复制 Cookie」可靠：用户只需要在窗口里登录一次。
//
// 设计取舍（来自 WPS 灵犀 0.4.11 的实测实现，MIT；见 NOTICE.md）：
//   · 任意 Chromium 内核浏览器都行（Chrome / Edge / 360 / QQ / Brave / Vivaldi…），
//     不止 Chrome；国产浏览器在 Windows 上很常见，漏了它们这条登录路对用户就不存在。
//   · Windows 先看系统默认浏览器（UserChoice 的 ProgId），默认不可用再退回
//     Chrome → 国产 Chromium → Edge 的顺序（Edge 策略最多、最容易被组织禁用）。
//   · 夸克 / UC 这类「能开调试端口、但会自己回收 CDP 目标」的浏览器一律殿后，
//     只有没有别的可用候选时才用（issue #7）。
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

const WIN_EXES = [
  "chrome.exe",
  "360ChromeX.exe",
  "360chrome.exe",
  "360se.exe",
  "QQBrowser.exe",
  "Brave.exe",
  "vivaldi.exe",
  "opera.exe",
  "SogouExplorer.exe",
  "2345Explorer.exe",
  "liebao.exe",
  "Maxthon.exe",
  "UCBrowser.exe",
  "Quark.exe",
  "msedge.exe",
]

/**
 * 已知 CDP 不可靠的浏览器：能开调试端口，但会把自己的内部页塞进 `/json/list`，
 * 并把插件已经连上的 page 目标回收掉（issue #7 实测：夸克约 10 秒）。
 * 排序时一律殿后 —— 只有没有别的可用候选时才用它们。
 */
export const UNRELIABLE_CDP_EXES = ["quark.exe", "ucbrowser.exe"]

/** 候选 exe 的规范显示名（注册表命中原先直接显示小写 exe 名）。 */
const WIN_EXE_NAMES = new Map([
  ["chrome.exe", "Chrome"],
  ["msedge.exe", "Edge"],
  ["chromium.exe", "Chromium"],
  ["brave.exe", "Brave"],
  ["vivaldi.exe", "Vivaldi"],
  ["opera.exe", "Opera"],
  ["360chromex.exe", "360极速浏览器X"],
  ["360chrome.exe", "360浏览器"],
  ["360se.exe", "360安全浏览器"],
  ["qqbrowser.exe", "QQ浏览器"],
  ["sogouexplorer.exe", "搜狗浏览器"],
  ["2345explorer.exe", "2345浏览器"],
  ["liebao.exe", "猎豹浏览器"],
  ["maxthon.exe", "Maxthon"],
  ["ucbrowser.exe", "UC浏览器"],
  ["quark.exe", "夸克浏览器"],
])

/**
 * ProgId 前缀 → exe。覆盖 issue #7 点名的最小集合（Edge / Chrome / Brave /
 * Firefox / 360 / QQ），另加 Opera / Vivaldi / Chromium / 搜狗等常见值。
 * 未知 ProgId 返回空串。
 */
const PROGID_RULES = [
  [/^(microsoftedge|msedge)/, "msedge.exe"],
  [/^(chrome|chromium)/, "chrome.exe"],
  [/^brave/, "brave.exe"],
  [/^firefox/, "firefox.exe"],
  [/^opera/, "opera.exe"],
  [/^vivaldi/, "vivaldi.exe"],
  [/^sogou/, "SogouExplorer.exe"],
  [/^maxthon/, "Maxthon.exe"],
  [/^liebao/, "liebao.exe"],
  [/^(qqbrowser|tencentqq)/, "QQBrowser.exe"],
  [/^uc/, "UCBrowser.exe"],
  [/^quark/, "Quark.exe"],
  [/^360.*chromex/, "360ChromeX.exe"],
  [/^360.*chrom/, "360chrome.exe"],
  [/^360/, "360se.exe"],
]

/** Firefox 不支持 CDP：默认浏览器是它时按「没有默认」处理。 */
const CDP_UNSUPPORTED_EXES = new Set(["firefox.exe"])

/** 系统默认浏览器（http）的 UserChoice 键。 */
const USER_CHOICE_KEY = "HKCU\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice"

/** Windows 注册表 App Paths 查浏览器；查不到返回空串。 */
export function registryAppPath(exe) {
  if (process.platform !== "win32") return ""
  for (const root of ["HKCU", "HKLM"]) {
    for (const tail of [
      `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
      `SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    ]) {
      try {
        const out = execFileSync("reg", ["query", `${root}\\${tail}`, "/ve"], { encoding: "utf8", timeout: 5000 })
        const line = out.split("\n").find((l) => /REG_SZ/i.test(l))
        const path = line?.split("REG_SZ")[1]?.trim()
        if (path && existsSync(path)) return path
      } catch {}
    }
  }
  return ""
}

/** 读一条 REG_SZ 注册表值；查不到返回空串（不抛）。测试可注入替代实现。 */
function registryValue(key, name) {
  if (process.platform !== "win32") return ""
  try {
    const out = execFileSync("reg", ["query", key, "/v", name], { encoding: "utf8", timeout: 5000 })
    const line = out.split(/\r?\n/).find((l) => /REG_SZ/i.test(l) && l.toLowerCase().includes(name.toLowerCase()))
    return line?.split(/REG_SZ/i)[1]?.trim() ?? ""
  } catch {
    return ""
  }
}

/**
 * ProgId → exe 名（纯函数）。例如 `MSEdgeHTM` → `msedge.exe`。
 * @param {string} progId `UrlAssociations\http\UserChoice` 的 ProgId
 * @returns {string} 未知 / 空值返回空串
 */
export function exeForProgId(progId) {
  const id = String(progId ?? "").trim().toLowerCase()
  if (id.length === 0) return ""
  for (const [pattern, exe] of PROGID_RULES) {
    if (pattern.test(id)) return exe
  }
  return ""
}

/**
 * Windows 系统默认浏览器的 exe（UserChoice 的 ProgId → exe）。
 *
 * 只返回能走 CDP 的浏览器：默认是 Firefox 时按「没有默认」处理，交回候选表，
 * 免得把一条注定读不到 cookie 的路排到最前。
 *
 * @param {{platform?:string, query?:(key:string,name:string)=>string}} [o]
 * @returns {string} 如 `msedge.exe`；没有 / 解析不出 / 不支持 CDP 时为空串
 */
export function systemDefaultBrowserExe({ platform = process.platform, query = registryValue } = {}) {
  if (platform !== "win32") return ""
  const exe = exeForProgId(query(USER_CHOICE_KEY, "ProgId"))
  if (!exe) return ""
  return CDP_UNSUPPORTED_EXES.has(exe.toLowerCase()) ? "" : exe
}

/** 路径 → 小写 exe 名（排序按 exe 而不是完整路径，注册表命中与标准路径才对得上）。 */
export function exeNameOf(path) {
  const clean = String(path ?? "").trim().replace(/^"(.*)"$/, "$1")
  const base = clean.split(/[\\/]/).pop() ?? ""
  return base.toLowerCase()
}

function displayNameForExe(exe) {
  const key = String(exe ?? "").trim().toLowerCase()
  return WIN_EXE_NAMES.get(key) ?? key.replace(/\.exe$/, "")
}

/**
 * 候选排序（纯函数，不做任何 IO）。
 *
 * 优先级：默认浏览器（存在）→ 其他可靠浏览器（存在）→ 可靠但不存在 →
 * 默认但不存在 → 已知 CDP 不可靠（存在）→ 不可靠且不存在。
 * 同档保持传入顺序；返回新数组，不改入参。
 *
 * @param {object} [o]
 * @param {{name:string, path:string}[]} [o.candidates]
 * @param {string} [o.defaultExe] 系统默认浏览器的 exe 名（如 `msedge.exe`）
 * @param {(path:string)=>boolean} [o.exists] 存在性探测（单测注入假实现）
 * @param {string[]} [o.unreliableExes] 已知 CDP 不可靠的 exe 名单
 * @returns {{name:string, path:string}[]}
 */
export function rankBrowserCandidates({
  candidates = [],
  defaultExe = "",
  exists = () => true,
  unreliableExes = UNRELIABLE_CDP_EXES,
} = {}) {
  const preferred = String(defaultExe ?? "").trim().toLowerCase()
  const unreliable = new Set((unreliableExes ?? []).map((exe) => String(exe ?? "").trim().toLowerCase()))
  const scoreOf = (candidate) => {
    const missing = exists(candidate?.path) ? 0 : 1
    const exe = exeNameOf(candidate?.path)
    // 不可靠浏览器永远殿后：就算系统默认是夸克，也不能让它进第一梯队。
    if (unreliable.has(exe)) return missing === 0 ? 4 : 5
    if (preferred && exe === preferred) return missing === 0 ? 0 : 3
    return missing === 0 ? 1 : 2
  }
  return candidates
    .map((candidate, index) => ({ candidate, index, score: scoreOf(candidate) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.candidate)
}

/**
 * 候选浏览器（按优先级）。不做存在性检查，方便测试与排序。
 * @param {{platform?:string, env?:Record<string,string>, lookup?:(exe:string)=>string, defaultExe?:string}} [o]
 * @param {string} [o.defaultExe] 系统默认浏览器 exe；命中的排最前（夸克 / UC 除外）
 * @returns {{name:string, path:string}[]}
 */
export function browserCandidates({ platform = process.platform, env = process.env, lookup = registryAppPath, defaultExe = "" } = {}) {
  const h = env.HOME || env.USERPROFILE || ""
  const local = env.LOCALAPPDATA || ""
  const roaming = env.APPDATA || ""
  const pf = env.PROGRAMFILES || ""
  const pf86 = env["PROGRAMFILES(X86)"] || env["ProgramFiles(x86)"] || ""
  const add = (list, name, path) => {
    if (path) list.push({ name, path })
  }

  if (platform === "win32") {
    const list = []
    for (const exe of WIN_EXES) {
      const fromRegistry = lookup(exe)
      if (fromRegistry) add(list, displayNameForExe(exe), fromRegistry)
    }
    add(list, "Chrome", join(pf, "Google", "Chrome", "Application", "chrome.exe"))
    add(list, "Chrome", join(pf86, "Google", "Chrome", "Application", "chrome.exe"))
    add(list, "Chrome", join(local, "Google", "Chrome", "Application", "chrome.exe"))
    add(list, "Chromium", join(local, "Chromium", "Application", "chrome.exe"))
    add(list, "Chromium", join(pf, "Chromium", "Application", "chrome.exe"))
    add(list, "360极速浏览器X", join(local, "360ChromeX", "Chrome", "Application", "360ChromeX.exe"))
    add(list, "360浏览器", join(local, "360Chrome", "Chrome", "Application", "360chrome.exe"))
    add(list, "360安全浏览器", join(roaming, "secoresdk", "360se6", "Application", "360se.exe"))
    add(list, "QQ浏览器", join(local, "Tencent", "QQBrowser", "Application", "QQBrowser.exe"))
    add(list, "Brave", join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))
    add(list, "Brave", join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))
    add(list, "Vivaldi", join(local, "Vivaldi", "Application", "vivaldi.exe"))
    add(list, "Opera", join(local, "Programs", "Opera", "opera.exe"))
    add(list, "Opera", join(roaming, "Opera Software", "Opera Stable", "opera.exe"))
    add(list, "搜狗浏览器", join(local, "SogouExplorer", "SogouExplorer.exe"))
    add(list, "2345浏览器", join(local, "2345Explorer", "2345Explorer.exe"))
    add(list, "猎豹浏览器", join(local, "liebao", "liebao.exe"))
    add(list, "Maxthon", join(roaming, "Maxthon3", "Bin", "Maxthon.exe"))
    add(list, "UC浏览器", join(local, "UCBrowser", "Application", "UCBrowser.exe"))
    add(list, "夸克浏览器", join(local, "Quark", "Quark.exe"))
    add(list, "Edge", join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"))
    add(list, "Edge", join(pf, "Microsoft", "Edge", "Application", "msedge.exe"))
    // 默认浏览器不在候选表里时（只写了 App Paths、又不在上面的标准位置）补一条。
    // 仍然交给 rank 排序：夸克就算被设为默认，也不该进第一梯队。
    const preferred = String(defaultExe ?? "").trim().toLowerCase()
    if (preferred && !list.some((b) => exeNameOf(b.path) === preferred)) {
      const fromRegistry = lookup(defaultExe)
      if (fromRegistry) add(list, displayNameForExe(defaultExe), fromRegistry)
    }
    return dedupe(rankBrowserCandidates({ candidates: list, defaultExe: preferred, exists: () => true }))
  }

  if (platform === "darwin") {
    return [
      ["Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
      ["Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
      ["Brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
      ["Vivaldi", "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi"],
      ["Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    ].map(([name, path]) => ({ name, path }))
  }

  return [
    ["Chrome", join(h, ".config/google-chrome/chrome")],
    ["Chromium", join(h, ".config/chromium/chrome")],
    ["Brave", join(h, ".config/BraveSoftware/Brave-Browser/brave")],
    ["Vivaldi", join(h, ".config/vivaldi/vivaldi")],
    ["Edge", join(h, ".config/microsoft-edge/msedge")],
  ].map(([name, path]) => ({ name, path }))
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

/**
 * 第一个真实存在的候选；没有返回 null。
 *
 * @param {object} [o]
 * @param {(key:string,name:string)=>string} [o.query] 注册表探测（单测注入，默认真读）
 * @param {string} [o.defaultExe] 强制指定默认浏览器 exe（传 "" 表示不探测默认浏览器）
 */
export function findBrowser({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  lookup = registryAppPath,
  query,
  defaultExe,
} = {}) {
  const preferred = defaultExe ?? (platform === "win32" ? systemDefaultBrowserExe({ platform, query }) : "")
  const candidates = browserCandidates({ platform, env, lookup, defaultExe: preferred })
  return rankBrowserCandidates({ candidates, defaultExe: preferred, exists }).find((b) => exists(b.path)) ?? null
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

/**
 * CDP 调试端口是否还活着（窗口是否真的是被用户关掉的判据之一）。
 *
 * 目标被浏览器自己回收时，WS 会断，但浏览器进程和调试端口都还在 ——
 * 「窗口被关掉了」的文案在这个场景下会把用户引向错误方向。
 *
 * @param {number} port `--remote-debugging-port` 的端口
 * @param {{running?:()=>boolean, fetchJson?:Function, timeoutMs?:number}} [o]
 */
export async function cdpEndpointAlive(port, { running = () => true, fetchJson = getJson, timeoutMs = 1200 } = {}) {
  if (!port || !running()) return false
  try {
    await fetchJson(`http://127.0.0.1:${port}/json/list`, timeoutMs)
    return true
  } catch {
    return false
  }
}

/**
 * 「调试目标丢了」的可读原因（纯函数）。
 *
 * - 端口还响应 ⇒ 窗口还开着，是浏览器自己回收了 CDP 目标（夸克 / UC 这类）：
 *   给能行动的文案，别再让用户以为自己关掉了窗口；
 * - 端口也不响应 ⇒ 保持原来的「窗口被关掉了」文案。
 *
 * @param {{endpointAlive?:boolean, browser?:{name?:string}}} [o]
 */
export function browserLossMessage({ endpointAlive = false, browser } = {}) {
  if (endpointAlive) {
    const who = browser?.name ? `「${browser.name}」` : "这个浏览器"
    return `${who}会自己关闭自动化窗口（调试目标被浏览器回收），请换用 Edge 或 Chrome 再试`
  }
  return "受控浏览器窗口被关掉了（或被系统拦下没能启动）"
}

function cdpSend(ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (msg.id !== id) return
      ws.removeEventListener("message", onMessage)
      if (msg.error) reject(new Error(msg.error.message || "CDP error"))
      else resolve(msg.result)
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
    try { ws.close() } catch {}
  }
}

/**
 * 受控浏览器的启动参数（纯函数，便于单测）。
 *
 * `headless` 默认 false —— 登录要用户看着窗口操作；只有「用官方页面替用户点一下」
 * 这类无交互场景才传 true（`--headless=new`，不弹窗、不抢桌面，见铁律 15）。
 *
 * @param {{port:number, profileDir:string, headless?:boolean, url?:string}} o
 * @returns {string[]}
 */
export function controlledBrowserArgs({ port, profileDir, headless = false, url = "about:blank" }) {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    ...(headless ? ["--headless=new", "--window-size=1440,900"] : []),
    url,
  ]
}

/**
 * 打开受控浏览器，等用户登录，返回需要的 Cookie。
 *
 * @param {object} o
 * @param {{name:string,path:string}} o.browser findBrowser() 的返回值
 * @param {string} o.url 登录页
 * @param {string[]} [o.cookieNames] 必须拿到的 cookie 名
 * @param {number} [o.timeoutMs] 默认 5 分钟
 * @param {boolean} [o.headless] 默认 false（登录必须有头；仅自动化场景传 true）
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{cookie:string, found:Record<string,string>, browser:string}>}
 */
export async function chromiumLogin({ browser, url, cookieNames = [], timeoutMs = 5 * 60_000, headless = false, signal }) {
  if (!browser?.path) throw new Error("没有可用的 Chromium 浏览器")
  const profile = mkdtempSync(join(tmpdir(), "magpie-login-"))
  const port = await freePort()
  const child = spawn(browser.path, controlledBrowserArgs({ port, profileDir: profile, headless, url }), {
    stdio: "ignore",
    windowsHide: headless,
  })

  const cleanup = () => {
    try { child.kill() } catch {}
    try { rmSync(profile, { recursive: true, force: true }) } catch {}
  }
  const deadline = Date.now() + timeoutMs
  try {
    let pageWs = ""
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("登录已取消")
      try {
        const pages = await getJson(`http://127.0.0.1:${port}/json/list`, 1000)
        pageWs = pages.find((p) => p.type === "page" && p.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? ""
        if (pageWs) break
      } catch {}
      await new Promise((r) => setTimeout(r, 300))
    }
    if (!pageWs) throw new Error("受控浏览器没有打开调试端口（浏览器可能吞掉了 --remote-debugging-port）")

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("登录已取消")
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

export const _internal = { WIN_EXES, freePort, cdpCookies }
