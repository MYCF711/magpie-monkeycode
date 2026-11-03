// 从**本机 MonkeyCode 桌面客户端**里取登录态。
//
// ## 为什么这条路比开浏览器稳
//
// 桌面版（`com.chaitin.baizhi.monkeycode`）登录完会把两枚 cookie 明文落盘在
// `%APPDATA%\com.chaitin.baizhi.monkeycode\`：
//
//   · `monkeycode-cookies.json` → `monkeycode_ai_session`（MonkeyCode 平台会话）
//   · `baizhi-cookies.json`     → `sl-session` + `baizhi_session`（百智云会话）
//
// 都是**明文 JSON 数组**，不是 Chromium 的 v10/v20 加密格式 —— 所以不需要 DPAPI，
// 也不需要起浏览器、不需要用户再登一次。用户装过桌面版 = 插件直接可用。
//
// ## 边界（写在代码里，别指望调用方记得）
//
// · 文件不存在 / 解析失败 / cookie 过期：一律返回 `undefined`，**不抛错** ——
//   「没装桌面版」是正常路径，不是异常。
// · 只读，不写、不删、不改动客户端目录里的任何东西。
// · 读的是**明文凭据**，所以这里不打印内容、不落日志，只回传值给调用方。

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** 桌面客户端的目录名（Tauri/Electron 都用 reverse-DNS 作 AppData 子目录）。 */
export const DESKTOP_APP_DIR = "com.chaitin.baizhi.monkeycode"

/** cookie 文件名（客户端自己命名的，两套站各一份）。 */
export const DESKTOP_COOKIE_FILES = {
  monkeycode: "monkeycode-cookies.json",
  baizhi: "baizhi-cookies.json",
}

/**
 * 桌面客户端的候选数据目录。
 *
 * Windows 上 `%APPDATA%`（Roaming）是主落点；`%LOCALAPPDATA%` 里那套
 * （`EBWebView`）是内嵌 WebView 的缓存，cookie 偶尔只在那里落一份，所以一并试。
 */
export function desktopDataDirs({ env = process.env, home = homedir() } = {}) {
  const dirs = []
  const push = (base) => {
    if (typeof base === "string" && base.length > 0) dirs.push(join(base, DESKTOP_APP_DIR))
  }
  push(env.APPDATA)
  push(env.LOCALAPPDATA)
  // ⚠ **不许只信环境变量**。magpie 是 GUI 宿主进程，实测在某些启动方式下
  // `APPDATA` 没被带进子进程的环境 —— 于是明明装过客户端、登录态就在那儿，
  // 插件却报「本机没有登录态」（2026-11-04 真机）。按 homedir 重新拼一遍兜底。
  push(join(home, "AppData", "Roaming"))
  push(join(home, "AppData", "Local"))
  // 非 Windows：同一套结构放在 ~/.config 或 ~/Library/Application Support。
  push(join(home, ".config"))
  push(join(home, "Library", "Application Support"))
  return [...new Set(dirs)]
}

/** 一条 cookie 是否已过期（`expires` 可能是 ISO 串、秒/毫秒时间戳或缺省=会话期）。 */
function expiredAt(entry, now = Date.now()) {
  const raw = entry?.expires
  if (raw === undefined || raw === null || raw === "") return false
  let ms = Number.NaN
  if (typeof raw === "number") {
    // 上游秒级时间戳与毫秒级都可能出现，按量级区分（10 位=秒，13 位=毫秒）。
    ms = raw > 1e12 ? raw : raw * 1000
  } else if (typeof raw === "string") {
    const asNumber = Number(raw)
    if (Number.isFinite(asNumber) && raw.trim() !== "") ms = asNumber > 1e12 ? asNumber : asNumber * 1000
    else ms = Date.parse(raw)
  }
  if (!Number.isFinite(ms)) return false
  return ms <= now
}

/**
 * 一条 cookie 的域是否属于本站。
 *
 * 桌面客户端的 cookie 文件是**按当前 `mc_base_url` 写的一份**（客户端设置里
 * 国内站 / 国际站二选一），所以同一个 `monkeycode-cookies.json` 里装的可能是
 * `.com` 也可能是 `.net` 的会话。不比对域就会把一站的会话拿去打另一站 ——
 * 上游一律回 401，界面只能猜「桌面版登录过期了」，而真因是**拿错了站**。
 *
 * 规则：去前导点后完全相同，或是它的子域（`www.monkeycode-ai.net`）。
 * 没写 `domain` 的老格式放行（不做无根据的排除）。
 */
export function domainMatches(domain, host) {
  if (typeof domain !== "string" || domain.trim().length === 0) return true
  if (typeof host !== "string" || host.trim().length === 0) return true
  const d = domain.trim().replace(/^\./, "").toLowerCase()
  const h = host.trim().toLowerCase()
  return d === h || d.endsWith(`.${h}`)
}

/**
 * 解析客户端 cookie 文件，返回 `name=value; name2=value2`。
 *
 * 只保留调用方点名的 cookie 名与站点；同名的取**最后一条未过期**的
 * （客户端会同时存多个域的 `sl-session`，前面的可能是别的子域）。
 */
export function cookiesFromJar(text, { names, domains, now = Date.now() } = {}) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cookies) ? parsed.cookies : []
  const wanted = Array.isArray(names) && names.length > 0 ? names : []
  const hosts = Array.isArray(domains) && domains.length > 0 ? domains : []
  const picked = new Map()
  for (const entry of list) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : ""
    const value = typeof entry?.value === "string" ? entry.value : ""
    if (name.length === 0 || value.length === 0) continue
    if (wanted.length > 0 && !wanted.includes(name)) continue
    if (hosts.length > 0 && !hosts.some((host) => domainMatches(entry?.domain, host))) continue
    if (expiredAt(entry, now)) continue
    picked.set(name, value)
  }
  if (picked.size === 0) return undefined
  // 点名了就必须**全部到齐**：只有 `sl-session` 而缺 `baizhi_session` 是「还没登完」
  // （客户端先落风控 cookie，登录成功才补会话 cookie）。半套凭据发上去只会 401，
  // 让调用方以为「桌面版登录过期了」，实际是人还没登完。
  if (wanted.length > 0 && !wanted.every((name) => picked.has(name))) return undefined
  return [...picked].map(([name, value]) => `${name}=${value}`).join("; ")
}

/**
 * 从本机桌面客户端读一份会话 cookie。
 *
 * @param {object} options
 * @param {string} options.cookieFile 文件名，见 `DESKTOP_COOKIE_FILES`
 * @param {string[]} options.cookieNames 需要的 cookie 名（全部到齐才算命中）
 * @param {string[]} [options.cookieDomains] 只认这些域（本站 host）；不传则不限
 * @param {string} [options.appDir] 覆盖目录名
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {{ cookie: string, file: string } | undefined}
 */
export function readDesktopCookie({ cookieFile, cookieNames, cookieDomains, appDir = DESKTOP_APP_DIR, env = process.env, home, now = Date.now() } = {}) {
  if (typeof cookieFile !== "string" || cookieFile.length === 0) return undefined
  const names = Array.isArray(cookieNames) ? cookieNames : []
  // `home` 必须能一路传到底：单测要用它把「按 homedir 兜底」关掉（否则测试会读到
  // 开发机上真实的 AppData 登录态，断言全变成「看这台机器装没装客户端」）。
  const bases = desktopDataDirs(home === undefined ? { env } : { env, home })
  for (const dir of bases) {
    const file = join(dir, cookieFile)
    let text
    try {
      if (!existsSync(file)) continue
      text = readFileSync(file, "utf8")
    } catch {
      continue
    }
    const cookie = cookiesFromJar(text, { names, domains: cookieDomains, now })
    if (cookie === undefined) continue
    return { cookie, file }
  }
  return undefined
}

/**
 * 读 MonkeyCode 平台会话（`monkeycode_ai_session`）。
 *
 * 这是「用户装过桌面版并登录过」的唯一判据 —— 后续用它换网关凭据。
 *
 * `cookieDomains` 传本站 host（调用方从 `site.platformBaseUrl` 取）：桌面客户端
 * 的 `mc_base_url` 是**一个**值，`.com` 与 `.net` 的会话装在同一个文件里，
 * 不比对域就会拿错站的 cookie。
 */
export function readDesktopMonkeyCodeSession(options = {}) {
  return readDesktopCookie({ cookieFile: DESKTOP_COOKIE_FILES.monkeycode, cookieNames: ["monkeycode_ai_session"], ...options })
}

/** 读百智云会话（`sl-session` + `baizhi_session`，两枚到齐才算）。 */
export function readDesktopBaizhiSession(options = {}) {
  return readDesktopCookie({ cookieFile: DESKTOP_COOKIE_FILES.baizhi, cookieNames: ["sl-session", "baizhi_session"], ...options })
}
