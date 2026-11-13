// 单测不许读开发机上的真实账号缓存（可能是「探测后全不可用 ⇒ 空表」）。
process.env.MAGPIE_MONKEYCODE_CACHE_DIR = "C:\\__magpie_test_cache__"
// 受控浏览器登录：候选排序、pickCookie、等文件。真启动浏览器不在单测里跑。
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const {
  browserCandidates,
  findBrowser,
  registryQuery,
  selectCookies,
  selectPageTarget,
  systemDefaultBrowser,
  waitForFile,
} = await import("../src/browser-login.mjs")

test("Windows 候选：注册表命中优先，Chrome 在 Edge 前，国产浏览器在列", () => {
  const env = {
    LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local",
    APPDATA: "C:\\Users\\x\\AppData\\Roaming",
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
  }
  const lookup = (exe) => (exe === "360ChromeX.exe" ? "C:\\360\\360ChromeX.exe" : "")
  const list = browserCandidates({ platform: "win32", env, lookup })
  const names = list.map((b) => b.name)
  assert.equal(list[0].path, "C:\\360\\360ChromeX.exe", "注册表命中的 360 极速应排最前")
  assert.ok(names.indexOf("Chrome") < names.indexOf("Edge"), "Chrome 在 Edge 之前")
  assert.ok(names.some((n) => n.includes("QQ")), "QQ 浏览器在候选里")
  assert.ok(list.every((b) => b.path), "候选不应有空路径")
})

test("findBrowser 只返回真实存在的候选；找不到返回 null", () => {
  const env = { PROGRAMFILES: "C:\\PF", LOCALAPPDATA: "C:\\L" }
  const chrome = join("C:\\PF", "Google", "Chrome", "Application", "chrome.exe")
  const found = findBrowser({
    platform: "win32",
    env,
    lookup: () => "",
    exists: (p) => p === chrome,
    defaultBrowser: null,
  })
  assert.equal(found.name, "Chrome")
  assert.equal(findBrowser({ platform: "win32", env, lookup: () => "", exists: () => false, defaultBrowser: null }), null)
})

test("系统默认浏览器：读 UserChoice 与 open command，只接受 CDP 稳定白名单", () => {
  const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  const query = (key, value) => {
    if (key.endsWith("UserChoice") && value === "ProgId") return "MSEdgeHTM"
    if (key === "HKLM\\SOFTWARE\\Classes\\MSEdgeHTM\\shell\\open\\command") {
      return `"${edgePath}" --single-argument %1`
    }
    return ""
  }
  assert.deepEqual(systemDefaultBrowser({ platform: "win32", query }), { name: "Edge", path: edgePath })
  assert.deepEqual(findBrowser({ platform: "win32", env: {}, query, lookup: () => "", exists: (p) => p === edgePath }), {
    name: "Edge",
    path: edgePath,
  }, "findBrowser 必须自动接上 UserChoice 查询")

  const quark = (key, value) => {
    if (key.endsWith("UserChoice") && value === "ProgId") return "QuarkHTM"
    if (key.endsWith("shell\\open\\command")) return '"C:\\Quark\\Quark.exe" --single-argument %1'
    return ""
  }
  assert.equal(systemDefaultBrowser({ platform: "win32", query: quark }), null)
})

test("findBrowser：默认浏览器最前，可禁用默认优先，MAGPIE_BROWSER 是最终逃生阀", () => {
  const defaultBrowser = { name: "Edge", path: "C:\\Edge\\msedge.exe" }
  const lookup = (exe) => {
    if (exe === "chrome.exe") return "C:\\Chrome\\chrome.exe"
    if (exe === "Quark.exe") return "C:\\Quark\\Quark.exe"
    return ""
  }
  const base = { platform: "win32", env: {}, lookup, exists: () => true, defaultBrowser }
  assert.equal(findBrowser(base).path, defaultBrowser.path)
  assert.equal(findBrowser({ ...base, env: { MAGPIE_BROWSER_PREFER_DEFAULT: "0" } }).name, "Chrome")

  const override = "D:\\Custom\\browser.exe"
  assert.equal(findBrowser({ ...base, env: { MAGPIE_BROWSER: override } }).path, override)

  const candidates = browserCandidates({ platform: "win32", env: {}, lookup, defaultBrowser: null })
  assert.equal(candidates.at(-1).path, "C:\\Quark\\Quark.exe", "注册表夸克也必须排在所有硬编码候选之后")
})

test("CDP page 选择：按登录 URL 的 origin，不用内部页首位；严格模式不兜底", () => {
  const internal = { id: "internal", type: "page", url: "uccd://qwen.voice-agent/renderer/index", webSocketDebuggerUrl: "ws://internal" }
  const login = { id: "login", type: "page", url: "https://baizhi.cloud/sign-in?redirect=%2Fc", webSocketDebuggerUrl: "ws://login" }
  const worker = { id: "worker", type: "service_worker", url: "https://baizhi.cloud/worker.js", webSocketDebuggerUrl: "ws://worker" }
  assert.equal(selectPageTarget([internal, login, worker], "https://baizhi.cloud/console/").id, "login")
  assert.equal(selectPageTarget([internal], "https://baizhi.cloud/console/").id, "internal", "初始连接保留首项兜底")
  assert.equal(selectPageTarget([internal], "https://baizhi.cloud/console/", { fallback: false }), undefined)
  assert.equal(selectPageTarget([internal, { ...login, url: "about:blank" }], "about:blank").url, "about:blank")
})

test("reg 查询丢弃 stderr，避免正常未命中刷 app.log", () => {
  let seen
  const value = registryQuery("HKCU\\Test", "ProgId", {
    platform: "win32",
    exec: (file, args, options) => {
      seen = { file, args, options }
      return "\r\n    ProgId    REG_SZ    MSEdgeHTM\r\n"
    },
  })
  assert.equal(value, "MSEdgeHTM")
  assert.equal(seen.file, "reg")
  assert.deepEqual(seen.args.slice(-2), ["/v", "ProgId"])
  assert.deepEqual(seen.options.stdio, ["ignore", "pipe", "ignore"])
})

test("selectCookies 只取需要的名字，忽略空值，拼成 Cookie header", () => {
  const cookies = [
    { name: "sid", value: "abc" },
    { name: "uid", value: "42" },
    { name: "other", value: "no" },
    { name: "empty", value: "" },
  ]
  assert.deepEqual(selectCookies(cookies, ["sid", "uid", "empty"]), {
    header: "sid=abc; uid=42",
    found: { sid: "abc", uid: "42" },
  })
  assert.deepEqual(selectCookies(null, ["sid"]), { header: "", found: {} })
})

test("waitForFile：文件出现返回 true，超时返回 false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-browser-"))
  const file = join(dir, "ready")
  const pending = waitForFile(file, 500, 20)
  setTimeout(() => writeFileSync(file, "1"), 50)
  try {
    assert.equal(await pending, true)
    assert.equal(await waitForFile(join(dir, "missing"), 30, 10), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
