// 单测不许读开发机上的真实账号缓存（可能是「探测后全不可用 ⇒ 空表」）。
process.env.MAGPIE_MONKEYCODE_CACHE_DIR = "C:\__magpie_test_cache__"
// tests/sso-import.test.mjs —— 「百智云账号 → MonkeyCode 账号」的账号选取逻辑 +
// 三条会**静默退化**的行为（docs/final-review.md 的 M1 / M3国内侧 / M4 / L4）：
//
//   · 显示名：上游 status 回 `name`，只认 `nickname` 时卡片会退回供应商名（不报错）；
//   · openPage 失败路径：无头 Chromium + 临时 profile 是我们起的，漏收尸就是孤儿进程；
//   · 国内站窗口的 accept：恒 true 会把「窗口一开就有匿名 cookie」当成登录完成；
//   · 判重复用 provision 的读法：坏库=false、`monkeycodeintl` 不算国内站。
//
// 不碰网络、不起真浏览器：openPage 那条用 node 自身冒充浏览器（spawn 出去立刻退出），
// 再加一个连不上的假 WebSocket —— 全程零真实凭证。

import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { nextUnimported, readBaizhiSessions, _internal } from "../src/monkeycode/sso-import.mjs"

const SRC_DIR = fileURLToPath(new URL("../src/monkeycode/", import.meta.url))
const SSO_FILE = join(SRC_DIR, "sso-import.mjs")
const RUNTIME_FILE = join(SRC_DIR, "runtime.mjs")

/** 临时 HOME 里跑一段代码，跑完把环境变量原样还回去（绝不读开发机上的真实登录态）。 */
async function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "sso-home-"))
  const saved = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    MAGPIE_PLUGIN_DISABLE_BROWSER: process.env.MAGPIE_PLUGIN_DISABLE_BROWSER,
  }
  process.env.USERPROFILE = home
  process.env.HOME = home
  try {
    return await fn(home)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function storeWith(entries) {
  const dir = mkdtempSync(join(tmpdir(), "sso-test-"))
  const file = join(dir, "plugin-auth.json")
  writeFileSync(file, JSON.stringify(entries, null, 2))
  return file
}

test("只挑 baizhi 的条目，并且必须带 session_cookie", () => {
  const file = storeWith({
    baizhi: { type: "api", access: JSON.stringify({ access_token: "sk-1", session_cookie: "sl-session=a; baizhi_session=b", user_id: "u1" }) },
    "baizhi#a1b2": { type: "api", access: JSON.stringify({ access_token: "sk-2", session_cookie: "sl-session=c; baizhi_session=d" }) },
    // 没有 cookie 的（只粘了 Key）不该被当成可导入账号。
    "baizhi#c3d4": { type: "api", access: JSON.stringify({ access_token: "sk-3" }) },
    monkeycode: { type: "api", access: JSON.stringify({ access_token: "oma_x", session_cookie: "monkeycode_ai_session=z" }) },
    workbuddy: { type: "api", access: JSON.stringify({ access_token: "wb" }) },
  })
  const sessions = readBaizhiSessions(file)
  assert.equal(sessions.length, 2)
  assert.deepEqual(sessions.map((session) => session.key), ["baizhi", "baizhi#a1b2"])
  assert.equal(sessions[0].identity, "u1", "有 user_id 就用它当身份")
  assert.equal(sessions[1].identity, "sk-2", "没有 user_id 退到 access_token")
})

test("坏的 JSON / 缺字段不会让整个读取失败", () => {
  const file = storeWith({
    baizhi: { type: "api", access: "not-json" },
    "baizhi#x": { type: "api", access: JSON.stringify({ session_cookie: "c" }) },
    "baizhi#y": null,
    "baizhi#z": { type: "api", access: JSON.stringify({ access_token: "ok", session_cookie: "s=b; baizhi_session=c" }) },
  })
  const sessions = readBaizhiSessions(file)
  // 只有 session_cookie 的账号也算（手抄 cookie 进来的就是这种），
  // 坏 JSON / null / 空对象才被跳过。
  assert.equal(sessions.length, 2)
  assert.deepEqual(sessions.map((session) => session.key).sort(), ["baizhi#x", "baizhi#z"])
})

test("nextUnimported 跳过已导入的，全部导完返回 undefined", () => {
  const sessions = [{ identity: "a" }, { identity: "b" }, { identity: "c" }]
  assert.equal(nextUnimported(sessions, new Set()).identity, "a")
  assert.equal(nextUnimported(sessions, new Set(["a"])).identity, "b")
  assert.equal(nextUnimported(sessions, new Set(["a", "b"])).identity, "c")
  assert.equal(nextUnimported(sessions, new Set(["a", "b", "c"])), undefined)
})

test("账号库不存在时返回空数组而不是抛错", () => {
  assert.deepEqual(readBaizhiSessions("/definitely/not/here/plugin-auth.json"), [])
})

test("持久 profile 目录在 ~/.cache/magpie 下，不同用途互不干扰", async () => {
  const { profileDirFor } = await import("../src/session-login.mjs")
  const baizhi = profileDirFor("baizhi")
  const cn = profileDirFor("monkeycode")
  const intl = profileDirFor("monkeycodeintl")
  assert.ok(baizhi.includes(".cache") && baizhi.includes("magpie"), baizhi)
  assert.ok(baizhi.endsWith("profile"), baizhi)
  assert.notEqual(baizhi, cn)
  assert.notEqual(cn, intl)
  // 百智云那条必须与站点无关 —— 两站共用同一个百智云登录态。
  assert.equal(profileDirFor("baizhi"), baizhi)
})


// ═══════════════════════════════════════════════════════════════════
// M1：显示名不能丢（上游只给 `name`）
// ═══════════════════════════════════════════════════════════════════
//
// 为什么值得写：`GET /api/v1/users/status` 上游回的是 `user.name`（2026-11-04 实测
// `{ id, name: "观猹员 0632" }`），而 `credits.mjs` 的 fetchProfile 把它归一成
// `nickname`。代码只认一个时**不会报错**，只是卡片上的账号名变成供应商名 ——
// 这种退化只有断言能拦住。

test("显示名：只有 name（上游实测形状）时也不能丢", () => {
  const { nicknameOf } = _internal
  assert.equal(typeof nicknameOf, "function")
  assert.equal(nicknameOf({ name: "观猹员 0707" }), "观猹员 0707", "上游 status 只有 name")
  assert.equal(nicknameOf({ nickname: "观猹员 0708" }), "观猹员 0708", "credits.mjs 归一后的形状")
  assert.equal(nicknameOf({ name: "观猹员 0709", nickname: "旧的" }), "观猹员 0709", "两个都有时以上游 name 为准")
  assert.equal(nicknameOf({ name: " 观猹员 0710 " }), "观猹员 0710", "去首尾空白")
  assert.equal(nicknameOf({ name: "   ", nickname: "  " }), undefined, "空白不算名字")
  assert.equal(nicknameOf({ userId: "u1" }), undefined, "取不到就不给名字，不拿 id 顶")
  assert.equal(nicknameOf(undefined), undefined)
  assert.equal(nicknameOf(null), undefined)
})

test("signInWithBaizhiSession 必须走 nicknameOf（改回只认 profile.nickname 直接红）", () => {
  const source = readFileSync(SSO_FILE, "utf8")
  assert.match(source, /nickname:\s*nicknameOf\(profile\)/, "会话结果里的显示名要经 nicknameOf")
  assert.doesNotMatch(source, /nickname:\s*profile\?\.nickname/, "不许只认 nickname（上游给的是 name）")
})

// ═══════════════════════════════════════════════════════════════════
// M4：openPage 的失败路径必须收尸（杀 child + 删临时 profile）
// ═══════════════════════════════════════════════════════════════════
//
// 为什么值得写：无头 Chromium 与 `magpie-sso-*` 临时目录都是插件起的。只有成功路径
// 的 finally 收尸时，WebSocket 连不上就留下一个孤儿进程 + 一份带登录态的 profile。

/** 机器上现存的 SSO 临时 profile（只在前后差集里有意义）。 */
function ssoProfiles() {
  try {
    return readdirSync(tmpdir()).filter((name) => name.startsWith("magpie-sso-"))
  } catch {
    return []
  }
}

test("openPage：WebSocket 连不上时必须收尸（杀 child + 删临时 profile）", async () => {
  const { openPage } = _internal
  assert.equal(typeof openPage, "function", "openPage 要能从 _internal 拿到（测试接缝）")

  const before = new Set(ssoProfiles())
  const realWebSocket = globalThis.WebSocket
  const realFetch = globalThis.fetch
  // 假调试端口：立刻回一个页面 ws；假 WebSocket：构造就抛错（= 连不上）。
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/fake" }]
    },
  })
  globalThis.WebSocket = class {
    constructor() {
      throw new Error("ws boom")
    }
  }
  try {
    await assert.rejects(
      () => openPage("about:blank", { browser: { path: process.execPath } }),
      /ws boom/,
      "失败必须原样抛出（不能吞成「登录超时」那种无从下手的错误）",
    )
  } finally {
    globalThis.WebSocket = realWebSocket
    globalThis.fetch = realFetch
  }
  const leaked = ssoProfiles().filter((name) => !before.has(name))
  assert.deepEqual(leaked, [], `失败路径漏了临时 profile：${leaked.join(", ")}`)
})

test("openPage 的结构锁：端口超时与 WebSocket 失败都在同一个 try 里，catch 必须 close()", () => {
  const source = readFileSync(SSO_FILE, "utf8")
  const start = source.indexOf("async function openPage")
  assert.ok(start > 0, "找不到 openPage")
  const body = source.slice(start, source.indexOf("\nexport async function signInWithBaizhiSession", start))
  assert.match(body, /try \{/, "spawn 之后的动作要在 try 里")
  assert.match(
    body,
    /if \(pageWs\.length === 0\) throw new Error\("受控浏览器没有打开调试端口"\)/,
    "端口超时分支只 throw，收尸交给 catch（一处收尸，不会漏也不会收两次）",
  )
  assert.match(body, /catch \(error\) \{[\s\S]*close\(\)[\s\S]*throw error/, "catch 必须先 close() 再把错抛出去")
})

// ═══════════════════════════════════════════════════════════════════
// M3（国内侧）：窗口 accept 必须接 verify，不许恒 true
// ═══════════════════════════════════════════════════════════════════

test("国内站 SSO 的窗口 accept 必须接 verify（改恒 true 必须红）", () => {
  const source = readFileSync(RUNTIME_FILE, "utf8")
  assert.match(source, /accept:\s*verify\b/, "窗口的 accept 要绑到真会话校验上（读到 cookie ≠ 登录成功）")
  assert.match(source, /fetchBaizhiProfile\(candidate, BAIZHI\)/, "verify 要真的问一次百智云 profile 接口")
  for (const constantTrue of [
    /accept:\s*async\s*\(\)\s*=>\s*true/,
    /accept:\s*\(\)\s*=>\s*true/,
    /async accept\(\)\s*\{\s*return true/,
  ]) {
    assert.doesNotMatch(source, constantTrue, "accept 恒 true 会把匿名 cookie 当成登录完成（2026-11-04 真机白登一次）")
  }
})

// ═══════════════════════════════════════════════════════════════════
// L4：判重复用 provision 的账号库读法（前缀判据只有一份）
// ═══════════════════════════════════════════════════════════════════

test("runtime 不再自己解析账号库：fs/homedir/path 与前缀判据都清掉", () => {
  const source = readFileSync(RUNTIME_FILE, "utf8")
  assert.match(source, /import \{ readProvisionedAccounts \} from "\.\/provision\.mjs"/, "复用 provision 的读法")
  assert.doesNotMatch(source, /from "node:fs"/, "不再自己 readFileSync")
  assert.doesNotMatch(source, /from "node:os"/, "不再自己取 homedir")
  assert.doesNotMatch(source, /from "node:path"/, "不再自己拼路径")
  assert.doesNotMatch(source, /startsWith\(`\$\{providerId\}#`\)/, "前缀判据只在 provision.mjs 里写一次")
})

test("判重：坏库=false，monkeycodeintl 不算国内站（临时 HOME）", async () => {
  await withTempHome(async (home) => {
    const { _internal: runtimeInternal } = await import("../src/monkeycode/runtime.mjs")
    const { existingAccountWithUid } = runtimeInternal
    assert.equal(typeof existingAccountWithUid, "function")

    const dir = join(home, ".config", "magpie")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "plugin-auth.json")

    writeFileSync(file, JSON.stringify({
      monkeycode: { uid: "u1" },
      "monkeycode#abc": { uid: "u2" },
      // 毒点：`monkeycode` 是 `monkeycodeintl` 的前缀 —— 判据必须是 key === id 或 id + "#"
      monkeycodeintl: { uid: "intl-1" },
      "monkeycodeintl#x": { uid: "intl-2" },
    }))
    assert.equal(existingAccountWithUid("monkeycode", "u1"), true, "裸键")
    assert.equal(existingAccountWithUid("monkeycode", "u2"), true, "# 号键")
    assert.equal(existingAccountWithUid("monkeycode", "intl-1"), false, "国际站的号不算国内站")
    assert.equal(existingAccountWithUid("monkeycode", "intl-2"), false, "国际站的 # 键也不算")
    assert.equal(existingAccountWithUid("monkeycode", ""), false, "空 uid 一律 false")
    assert.equal(existingAccountWithUid("monkeycode", undefined), false)

    // 坏库 / 顶层非对象 → false（只是少一句「已经开通过」的提示，不能因此报错）
    writeFileSync(file, "{ 这不是 JSON")
    assert.equal(existingAccountWithUid("monkeycode", "u1"), false, "坏 JSON")
    writeFileSync(file, "[]")
    assert.equal(existingAccountWithUid("monkeycode", "u1"), false, "顶层数组")
    rmSync(file)
    assert.equal(existingAccountWithUid("monkeycode", "u1"), false, "账号库不存在")
  })
})

// ═══════════════════════════════════════════════════════════════════
// 邀请码：国内站 authorize 真的把码落到 monkeycode-invite.json
// ═══════════════════════════════════════════════════════════════════
//
// 为什么值得写：独立变异测试发现「邀请码落盘」这条没有测试。只用一个**临时 HOME +
// 浏览器门闩**：authorize 立刻返回失败 flow，不读账号库、不开窗、不联网，
// 但「解析 + 落盘」这一段照常执行。

test("国内站 authorize 把邀请码落到 monkeycode-invite.json（临时 HOME，不开窗）", async () => {
  await withTempHome(async (home) => {
    process.env.MAGPIE_PLUGIN_DISABLE_BROWSER = "1"
    const { makePlugin } = await import("../src/monkeycode/runtime.mjs")
    const { SITES } = await import("../src/sites.mjs")

    const plugin = await makePlugin(SITES.monkeycode)({ client: {} })
    const sso = plugin.auth.methods[0]
    assert.match(sso.label, /用百智云账号开通/)

    const flow = await sso.authorize({ invite: "4321" })
    assert.equal(flow.opened, false, "测试门闩下不许开窗")
    assert.equal(typeof flow.callback, "function")

    const policyFile = join(home, ".cache", "magpie", "monkeycode-invite.json")
    assert.ok(existsSync(policyFile), `邀请码没有落盘：${policyFile}`)
    const policy = JSON.parse(readFileSync(policyFile, "utf8"))
    assert.equal(policy.code, "4321", "填的码要原样存下来（下次留空 / 0 / 1 沿用）")
    assert.equal(policy.source, "chosen")
    assert.equal(
      existsSync(join(home, ".cache", "magpie", "baizhi-invite.json")),
      false,
      "百智云那份策略文件不许被国内站写",
    )

    // 再走一次、留空 → 沿用已保存的码（不是把它清掉）。
    const again = await sso.authorize({ invite: "" })
    assert.equal(again.opened, false)
    assert.equal(JSON.parse(readFileSync(policyFile, "utf8")).code, "4321")
  })
})

// ═══════════════════════════════════════════════════════════════════
// 启动器失败：ENOENT / EACCES 不许变成 uncaught exception，也不许空等 60 秒
// ═══════════════════════════════════════════════════════════════════
//
// 为什么值得写：`spawn()` 对「浏览器路径不存在 / 没有执行权限」**不会同步抛**，
// 它是异步发 `error` 事件。没有监听器 = uncaught exception（整个插件进程被掀掉）；
// 只有轮询 = 空等满 60 秒才报「没有打开调试端口」，真实原因（ENOENT）全丢。
// 这条用**不存在的浏览器路径**跑真 spawn，证明三件事：快速 reject、错误码带出来、
// 失败路径把临时 profile 收干净。

test("openPage：启动器 ENOENT 必须快速 reject（不空等 60 秒）且不留临时 profile", async () => {
  const { openPage } = _internal
  const before = new Set(ssoProfiles())
  const started = Date.now()
  await assert.rejects(
    () => openPage("about:blank", { browser: { path: join(tmpdir(), "definitely-not-a-browser", "chrome.exe") } }),
    (error) => {
      assert.equal(error.code, "ENOENT", "系统错误码要原样带出来（上层才能区分没装 / 没权限）")
      assert.match(error.message, /受控浏览器启动失败（ENOENT）/)
      return true
    },
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed < 5_000, `必须快速失败（实测 ${elapsed}ms —— 空等 60 秒说明 error 监听没接上）`)
  const leaked = ssoProfiles().filter((name) => !before.has(name))
  assert.deepEqual(leaked, [], `失败路径漏了临时 profile：${leaked.join(", ")}`)
})

test("openPage 的 error 监听是结构锁：spawn 之后必须 on(\"error\")，循环里提前 throw", () => {
  const source = readFileSync(SSO_FILE, "utf8")
  const start = source.indexOf("function spawnFailure")
  assert.ok(start > 0, "找不到 spawnFailure（结构化 reject 的拼装点）")
  const body = source.slice(start, source.indexOf("export async function signInWithBaizhiSession", start))
  assert.match(body, /child\.on\("error"/, "没有监听器时 ENOENT 会变成 uncaught exception")
  assert.match(
    body,
    /if \(spawnError !== undefined\) throw spawnError\n\s+await new Promise/,
    "循环里要先判启动错误、再等下一次轮询（否则空等 60 秒）",
  )
  assert.match(body, /failure\.code = code/, "结构化 reject：保留系统错误码")
})
