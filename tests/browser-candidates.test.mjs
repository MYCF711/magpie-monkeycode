// 浏览器候选排序的离线单测（issue #7）：
// 全部靠注入的注册表 / 存在性探测结果，不读真注册表、不启动浏览器。
import test from "node:test"
import assert from "node:assert/strict"

const {
  browserCandidates,
  findBrowser,
  rankBrowserCandidates,
  exeForProgId,
  systemDefaultBrowserExe,
  exeNameOf,
  browserLossMessage,
  cdpEndpointAlive,
} = await import("../src/browser-login.mjs")

const ENV = {
  LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local",
  APPDATA: "C:\\Users\\x\\AppData\\Roaming",
  PROGRAMFILES: "C:\\Program Files",
  "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
}
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
const QUARK = "C:\\Users\\x\\AppData\\Local\\Quark\\Quark.exe"
const UC = "C:\\Users\\x\\AppData\\Local\\UCBrowser\\Application\\UCBrowser.exe"

/** 假注册表：exe → App Paths 命中；未列出的 exe 一律查不到。 */
const winLookup = (paths) => (exe) => paths[String(exe).toLowerCase()] ?? ""

test("ProgId → exe：覆盖 issue #7 点名的默认浏览器", () => {
  assert.equal(exeForProgId("MSEdgeHTM"), "msedge.exe")
  assert.equal(exeForProgId("ChromeHTML"), "chrome.exe")
  assert.equal(exeForProgId("BraveHTML"), "brave.exe")
  assert.equal(exeForProgId("FirefoxURL-308046B0AF4A39CB"), "firefox.exe")
  assert.equal(exeForProgId("360se6URL"), "360se.exe")
  assert.equal(exeForProgId("360ChromeHTML"), "360chrome.exe")
  assert.equal(exeForProgId("QQBrowserHTML"), "QQBrowser.exe")
  assert.equal(exeForProgId(""), "")
  assert.equal(exeForProgId("SomeUnknownBrowserHTML"), "")
})

test("systemDefaultBrowserExe：读 http 的 UserChoice；Firefox 不支持 CDP 就跳过", () => {
  const calls = []
  const query = (key, name) => {
    calls.push([key, name])
    return key.includes("UrlAssociations\\http\\UserChoice") && name === "ProgId" ? "MSEdgeHTM" : ""
  }
  assert.equal(systemDefaultBrowserExe({ platform: "win32", query }), "msedge.exe")
  assert.equal(calls.length, 1, "只该查一次 UserChoice")
  assert.match(calls[0][0], /UrlAssociations\\http\\UserChoice$/, "必须读 http 协议的 UserChoice")
  assert.equal(calls[0][1], "ProgId")

  assert.equal(systemDefaultBrowserExe({ platform: "win32", query: () => "ChromeHTML" }), "chrome.exe")
  assert.equal(systemDefaultBrowserExe({ platform: "win32", query: () => "FirefoxURL" }), "", "Firefox 没有 CDP")
  assert.equal(systemDefaultBrowserExe({ platform: "win32", query: () => "" }), "")
  assert.equal(systemDefaultBrowserExe({ platform: "darwin", query: () => "ChromeHTML" }), "")
})

test("rankBrowserCandidates：默认浏览器排最前，且不能压过「真实存在」这一条", () => {
  const candidates = [
    { name: "Chrome", path: CHROME },
    { name: "Edge", path: EDGE },
    { name: "Quark", path: QUARK },
  ]
  const ranked = rankBrowserCandidates({ candidates, defaultExe: "msedge.exe", exists: () => true })
  assert.deepEqual(ranked.map((b) => b.name), ["Edge", "Chrome", "Quark"])
  assert.deepEqual(candidates.map((b) => b.name), ["Chrome", "Edge", "Quark"], "不能改入参顺序")

  // 默认浏览器没装：存在的 Chrome 必须排在它前面。
  const noEdge = rankBrowserCandidates({ candidates, defaultExe: "msedge.exe", exists: (p) => p === CHROME })
  assert.deepEqual(noEdge.map((b) => b.name), ["Chrome", "Edge", "Quark"])
})

test("rankBrowserCandidates：夸克 / UC 永远殿后，哪怕系统默认就是夸克", () => {
  const candidates = [
    { name: "Quark", path: QUARK },
    { name: "Chrome", path: CHROME },
    { name: "UC", path: UC },
  ]
  const ranked = rankBrowserCandidates({ candidates, defaultExe: "quark.exe", exists: () => true })
  assert.deepEqual(ranked.map((b) => b.name), ["Chrome", "Quark", "UC"])

  // 没有别的可用候选时，它们仍在队尾 —— 但 findBrowser 会兜底选到（下一条用例）。
  const onlyUnreliable = rankBrowserCandidates({ candidates, exists: (p) => p === QUARK || p === UC })
  assert.deepEqual(onlyUnreliable.map((b) => b.name), ["Chrome", "Quark", "UC"], "不可靠的排在所有可靠候选之后")
})

test("browserCandidates：默认浏览器排最前，夸克靠注册表命中也不进第一梯队", () => {
  const lookup = winLookup({ "chrome.exe": CHROME, "msedge.exe": EDGE, "quark.exe": QUARK })
  const list = browserCandidates({ platform: "win32", env: ENV, lookup, defaultExe: "msedge.exe" })

  assert.equal(exeNameOf(list[0].path), "msedge.exe", "系统默认浏览器应排最前")
  assert.ok(
    list.some((b) => exeNameOf(b.path) === "chrome.exe"),
    "其他可靠浏览器仍在候选里",
  )
  const tail = list.slice(-2).map((b) => exeNameOf(b.path)).sort()
  assert.deepEqual(tail, ["quark.exe", "ucbrowser.exe"], "夸克 / UC 只能殿后")
  assert.equal(list.filter((b) => b.path === QUARK).length, 1, "同一路径不能重复")
  assert.ok(list.every((b) => b.path.length > 0), "候选不应有空路径")

  // 没有默认浏览器信息（探测失败 / 非 Windows）时保持原来的顺序。
  const legacy = browserCandidates({ platform: "win32", env: ENV, lookup })
  assert.equal(exeNameOf(legacy[0].path), "chrome.exe")
  assert.deepEqual(
    legacy.slice(-2).map((b) => exeNameOf(b.path)).sort(),
    ["quark.exe", "ucbrowser.exe"],
  )
})

test("browserCandidates：默认 exe 不在候选表里时用 App Paths 补一条", () => {
  const firefox = "C:\\Program Files\\Mozilla Firefox\\firefox.exe"
  const list = browserCandidates({
    platform: "win32",
    env: ENV,
    lookup: winLookup({ "firefox.exe": firefox }),
    defaultExe: "firefox.exe",
  })
  assert.equal(list[0].path, firefox)
  assert.equal(exeNameOf(list[0].path), "firefox.exe")
})

test("findBrowser：默认是 Edge 时不再被夸克的注册表命中抢走（issue #7 的机器）", () => {
  const lookup = winLookup({ "quark.exe": QUARK, "msedge.exe": EDGE })
  const exists = (p) => p === QUARK || p === EDGE
  const found = findBrowser({
    platform: "win32",
    env: {},
    lookup,
    exists,
    query: () => "MSEdgeHTM",
  })
  assert.equal(found?.path, EDGE)
  assert.equal(found?.name, "Edge")
})

test("findBrowser：没有别的可用候选时才退回夸克；Firefox 默认不参与", () => {
  const lookup = winLookup({ "quark.exe": QUARK })
  const exists = (p) => p === QUARK

  const edgeDefault = findBrowser({ platform: "win32", env: {}, lookup, exists, query: () => "MSEdgeHTM" })
  assert.equal(edgeDefault?.path, QUARK, "只剩夸克时仍要能用（最后兜底）")

  const firefoxDefault = findBrowser({ platform: "win32", env: {}, lookup, exists, query: () => "FirefoxURL" })
  assert.equal(firefoxDefault?.path, QUARK, "Firefox 不算可用默认，应回落到普通候选")
})

test("browserLossMessage：区分「浏览器回收目标」与「窗口被关」", () => {
  const lost = browserLossMessage({ endpointAlive: true, browser: { name: "夸克浏览器" } })
  assert.match(lost, /夸克浏览器/)
  assert.match(lost, /Edge/)
  assert.match(lost, /Chrome/)
  assert.ok(!lost.includes("窗口被关掉了"), "目标被回收时不能再说窗口被关")

  const closed = "受控浏览器窗口被关掉了（或被系统拦下没能启动）"
  assert.equal(browserLossMessage({ endpointAlive: false, browser: { name: "Edge" } }), closed)
  assert.equal(browserLossMessage(), closed)
})

test("cdpEndpointAlive：进程没了直接 false；端口还响应才算目标丢失", async () => {
  let calls = 0
  const fetchJson = async () => {
    calls += 1
    return []
  }
  assert.equal(await cdpEndpointAlive(9222, { running: () => false, fetchJson }), false)
  assert.equal(calls, 0, "进程已退出就不该再探端口")
  assert.equal(await cdpEndpointAlive(0, { running: () => true, fetchJson }), false)
  assert.equal(calls, 0, "没有端口也不探")
  assert.equal(await cdpEndpointAlive(9222, { running: () => true, fetchJson }), true)
  assert.equal(calls, 1)
  assert.equal(
    await cdpEndpointAlive(9222, {
      running: () => true,
      fetchJson: async () => {
        throw new Error("ECONNREFUSED")
      },
    }),
    false,
  )
})
