// 单测不许读开发机上的真实账号缓存（可能是「探测后全不可用 ⇒ 空表」）。
process.env.MAGPIE_MONKEYCODE_CACHE_DIR = "C:\\__magpie_test_cache__"
// 浏览器门闩由用例自己开关（⑦c 要证明它真的挡住写），所以这里先清干净，别让开发机的环境变量污染。
delete process.env.MAGPIE_PLUGIN_DISABLE_BROWSER

// tests/provision.test.mjs —— 「百智云登录成功 → 自动写入国内 MonkeyCode 账号」的契约
//
// 依据 docs/automatic-credential-reuse.md（2026-11-09 核定）：
//
//   百智云的「浏览器登录」与「从本机客户端导入」都汇到 `finishSignIn`
//   （src/baizhi/runtime.mjs:179），登录成功后要**顺手**开出一个国内 MonkeyCode 账号 ——
//   不给用户第二次点击。实现落在 `src/monkeycode/provision.mjs`，本文件先于它存在。
//
// ⚠ 这个文件**先于实现存在**：模块还没有时它是真红的
//   （ERR_MODULE_NOT_FOUND: src/monkeycode/provision.mjs）。
//   实现落盘后本文件必须转绿，且不需要改一个字 —— 契约先行。
//
// 为什么这些断言值得写（每一条都对应一个会静默出错的坑）：
//
//   · 宿主 `client.auth.set` 是**整体替换**、而且**失败也回 `{data:true}`**
//     （docs §1.2-E/F）⇒ 写完必须回读，且不能只比 uid；
//   · `monkeycode` 是 `monkeycodeintl` 的**前缀** ⇒ 读盘判据写成 `startsWith(provider)`
//     会把国际站账号当成国内站的，键选择就会按错的库做判断；
//   · `access_token` / `signing_secret` 每次兑换都变 ⇒ 按内容选键 = 每次登录长一个新账号行；
//   · 自动开通跑在百智云登录的 callback 之后，**失败必须吞掉**（不许把百智云登录带崩）。
//
// 隔离（三条都硬）：
//   ① 不碰真账号库：每个用例的 `authFile` 都在 mkdtemp 目录里，且 home 指到不存在的路径；
//   ② 不起浏览器：`sso` 是注入的假函数，本文件一次网络都不发；
//   ③ 不写生产文件：假 client 只往临时文件里写。

import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  decideProvision,
  monkeycodeRecord,
  provisionMonkeyCode,
  readProvisionedAccounts,
} from "../src/monkeycode/provision.mjs"
import { SITES } from "../src/sites.mjs"

// 与 tests/multi-provider.test.mjs 同一条规矩：home 指到不存在的路径，
// 万一实现里有个「默认读 ~/.config/magpie」的兜底，也读不到真账号库。
const FAKE_HOME = join(tmpdir(), `magpie-provision-nohome-${process.pid}`)
process.env.USERPROFILE = FAKE_HOME
process.env.HOME = FAKE_HOME

// ── 测试数据（全假值）───────────────────────────────────────────────────

/** `sha256(uid)` 前 8 位：确定性后缀键。键算法是契约的一部分，测试自己算一遍。 */
const sha8 = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 8)

/** 假凭据：与真实形状一致（三件都齐），值全是占位符。 */
const CREDENTIAL = Object.freeze({
  access_token: `oma_${"a".repeat(32)}`,
  signing_secret: "s".repeat(32),
  session_cookie: ["monkeycode_ai_session", "t"].join("="),
})

/**
 * 假会话串。**刻意在运行时拼**：源码里不出现 `cookie: "…=…; …=…"` 这种字面量，
 * 免得 privacy-scan 把它当成真值（见 tests/multi-provider.test.mjs 的同名注释）。
 */
const sessionHeaderOf = (n) => [["sl-session", `s${n}`].join("="), ["baizhi_session", `b${n}`].join("=")].join("; ")

// ── 假文件 / 假 client / 假 sso ─────────────────────────────────────────

/** 一个临时账号库（内容可给）。返回文件路径。 */
function tempAuthFile(entries = {}) {
  const dir = mkdtempSync(join(tmpdir(), "provision-test-"))
  const file = join(dir, "plugin-auth.json")
  writeFileSync(file, JSON.stringify(entries, null, 2))
  return file
}

/** 一个**不存在**的账号库路径（「首次使用」= 空库，不是「读不出来」）。 */
function absentAuthFile() {
  return join(mkdtempSync(join(tmpdir(), "provision-test-")), "plugin-auth.json")
}

function readStore(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

/**
 * 假 magpie client：按宿主语义把 `auth.set({path:{id}, body})` 落到临时文件
 * （键 = path.id，body **整体替换**）。`transform` 用来模拟「宿主把记录写坏了」。
 */
function fakeClient(file, { transform = (body) => body, fail = null } = {}) {
  const calls = []
  return {
    calls,
    client: {
      auth: {
        async set(opts) {
          calls.push(opts)
          if (fail) throw fail
          const all = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
          all[opts?.path?.id] = transform(opts?.body)
          writeFileSync(file, JSON.stringify(all, null, 2))
          return { data: true }
        },
      },
    },
  }
}

/** 假 client：**静默 no-op** —— 回 `{data:true}` 但一个字都不写（宿主真会这样）。 */
function silentClient() {
  const calls = []
  return { calls, client: { auth: { set: async (opts) => { calls.push(opts); return { data: true } } } } }
}

/** 假 SSO：记录调用，回一份可定制的结果。 */
function fakeSso(overrides = {}) {
  const calls = []
  return {
    calls,
    async sso(cookie, site, options = {}) {
      calls.push({ cookie, site, options })
      return {
        credential: overrides.credential ?? { ...CREDENTIAL },
        // ⚠ 用 in 判「显式给了什么」：`?? ` 会把 `{ userId: undefined }` 变回默认值，
        // 于是「拿不到身份」这条用例会静默变成「拿到了」，测了个寂寞。
        nickname: "nickname" in overrides ? overrides.nickname : "观猹员 0001",
        userId: "userId" in overrides ? overrides.userId : "mc-uid-1",
      }
    },
  }
}

// ══════════════════════════════════════════════════════════════════════
// ① 记录体：宿主 `save()` 消费的形状，别自创字段
// ══════════════════════════════════════════════════════════════════════

test("① monkeycodeRecord：type=oauth、refresh=access、expires=0、整份凭据进 access", () => {
  const credential = { ...CREDENTIAL, user_id: "mc-uid-1" }
  const rec = monkeycodeRecord({ credential, accountId: "观猹员 0001", uid: "mc-uid-1" })

  assert.equal(rec.type, "oauth", "宿主的 save() 只认 oauth / api 两种记录")
  assert.equal(rec.expires, 0, "0 = 永不到期（MonkeyCode 没有 refresh 端点）")
  assert.equal(rec.refresh, rec.access, "refresh 位不是可选项：它是宿主『存不存得下』的开关（src/credential.mjs:79-92）")
  assert.deepEqual(
    JSON.parse(rec.access),
    credential,
    "access 必须是**完整**凭据 JSON —— 宿主整体替换，少一个字段就是丢（signing_secret 丢了每个请求 403）",
  )
  assert.equal(rec.accountId, "观猹员 0001", "accountId 是卡片上的名字")
  assert.equal(rec.uid, "mc-uid-1", "uid 是身份，magpie 按它判重")
  assert.deepEqual(Object.keys(rec).sort(), ["access", "accountId", "expires", "refresh", "type", "uid"])
  assert.equal("message" in rec, false, "message 是登录结果的显示通道，不属于记录字段")
})

test("①b accountId / uid 是空串时不写进记录（空串会把两个不同账号并成一个）", () => {
  const rec = monkeycodeRecord({ credential: CREDENTIAL, accountId: "", uid: "" })
  assert.equal("accountId" in rec, false, "与 src/credential.mjs:88-89 的 signInSuccess 同一口径")
  assert.equal("uid" in rec, false)
})

// ══════════════════════════════════════════════════════════════════════
// ② 读账号库：只认 monkeycode 与 monkeycode#，绝不吞 monkeycodeintl
// ══════════════════════════════════════════════════════════════════════

test("② 只认 monkeycode / monkeycode#，monkeycodeintl 一个都不许进来", () => {
  const file = tempAuthFile({
    baizhi: { type: "api", key: "sk-test-baizhi", uid: "bz-1" },
    workbuddy: { type: "api", key: "wb-test", uid: "wb-1" },
    monkeycode: { type: "oauth", access: "orig-1", uid: "mc-1", accountId: "观猹员 0001" },
    "monkeycode#a1b2c3d4": { type: "oauth", access: "orig-2", uid: "mc-2" },
    monkeycodeintl: { type: "oauth", access: "intl-1", uid: "intl-1" },
    "monkeycodeintl#zz": { type: "oauth", access: "intl-2", uid: "intl-2" },
  })
  const store = readProvisionedAccounts("monkeycode", file)

  assert.equal(store.ok, true)
  assert.deepEqual(
    [...store.accounts.map((a) => a.key)].sort(),
    ["monkeycode", "monkeycode#a1b2c3d4"].sort(),
    "`monkeycode` 是 `monkeycodeintl` 的前缀：判据必须是 key === id || key.startsWith(id + \"#\")",
  )
  const first = store.accounts.find((a) => a.key === "monkeycode")
  assert.equal(first.uid, "mc-1", "uid 是判重用的身份")
  assert.equal(first.accountId, "观猹员 0001", "accountId 是显示名，丢了下游就只剩 uuid 当名字")
})

test("②b 文件不存在 = 空库（ok:true）；坏 JSON = ok:false（读不出来，禁止写）", () => {
  const missing = readProvisionedAccounts("monkeycode", absentAuthFile())
  assert.equal(missing.ok, true, "『还没用过』是正常路径，不是读不出来")
  assert.deepEqual(missing.accounts, [])

  const dir = mkdtempSync(join(tmpdir(), "provision-test-"))
  const broken = join(dir, "plugin-auth.json")
  writeFileSync(broken, "{ this is not json")
  const bad = readProvisionedAccounts("monkeycode", broken)
  assert.equal(bad.ok, false, "读不出来必须能被调用方看见 —— 宿主在坏库时照样会写回（docs §1.2-E）")
  assert.deepEqual(bad.accounts, [])
})

test("②c 顶层不是对象（数组 / null / 字符串）也算读不出来，且不抛", () => {
  const dir = mkdtempSync(join(tmpdir(), "provision-test-"))
  for (const [name, text] of [["array", "[1,2,3]"], ["null", "null"], ["string", "\"x\""]]) {
    const file = join(dir, `${name}.json`)
    writeFileSync(file, text)
    const store = readProvisionedAccounts("monkeycode", file)
    assert.equal(store.ok, false, `${name} 必须 ok:false`)
    assert.deepEqual(store.accounts, [])
  }
})

test("②d providerId 是参数，不是写死的 monkeycode", () => {
  const file = tempAuthFile({
    baizhi: { type: "api", key: "sk-test-baizhi", uid: "bz-1" },
    "baizhi#0011": { type: "api", key: "sk-test-baizhi-2", uid: "bz-2" },
    monkeycode: { type: "oauth", access: "orig", uid: "mc-1" },
  })
  assert.deepEqual([...readProvisionedAccounts("baizhi", file).accounts.map((a) => a.key)].sort(), ["baizhi", "baizhi#0011"])
})

// ══════════════════════════════════════════════════════════════════════
// ③ 决策：写不写、写到哪个键（纯函数）
// ══════════════════════════════════════════════════════════════════════

test("③ uid 为空 → 不写（没稳定身份就没有幂等键，写下去就是每登一次多一个号）", () => {
  for (const uid of ["", "   ", undefined, null]) {
    const decided = decideProvision({ store: { ok: true, accounts: [] }, uid })
    assert.equal(decided.skip, "no-uid", `uid=${JSON.stringify(uid)}`)
    assert.equal(decided.key, undefined, "跳过的决策里不许带键 —— 带上就会有人拿它去写")
  }
})

test("③b 账号库读不出来 → 跳过（宿主的写回会挤掉别的账号，见 docs §1.2-E）", () => {
  const decided = decideProvision({ store: { ok: false, accounts: [] }, uid: "mc-uid-1" })
  assert.equal(decided.skip, "store-unreadable")
  assert.equal(decided.key, undefined)
})

test("③c 首号用裸键；裸键被别的账号占着 → 确定性后缀键（同 uid 永远同一个键）", () => {
  const empty = decideProvision({ store: { ok: true, accounts: [] }, uid: "mc-uid-1" })
  assert.equal(empty.key, "monkeycode", "宿主习惯：第一颗账号放在裸 provider 键上")

  const occupied = { ok: true, accounts: [{ key: "monkeycode", accountId: "别人的号", uid: "other-uid" }] }
  const first = decideProvision({ store: occupied, uid: "mc-uid-1" })
  assert.equal(first.key, `monkeycode#${sha8("mc-uid-1")}`, "后缀必须是 sha8(uid)：随机后缀 = 每次登录一个新账号行")
  assert.equal(decideProvision({ store: occupied, uid: "mc-uid-1" }).key, first.key, "同一个身份必须永远落到同一个键（幂等）")
  assert.notEqual(decideProvision({ store: occupied, uid: "mc-uid-2" }).key, first.key, "不同身份不许挤同一个键")
})

test("③d 同 uid 命中 → 原位重写那个键（不新增账号行）", () => {
  const store = {
    ok: true,
    accounts: [
      { key: "monkeycode", accountId: "别人的号", uid: "other-uid" },
      { key: "monkeycode#beefbeef", accountId: "观猹员 0001", uid: "mc-uid-1" },
    ],
  }
  assert.equal(decideProvision({ store, uid: "mc-uid-1" }).key, "monkeycode#beefbeef")
})

test("③e 库里只有国际站账号时，国内站仍然是『首号』（前缀毒点的决策面）", () => {
  // 正常读盘不会把 monkeycodeintl 喂进来（见 ②）；这里人工喂，证明决策函数自己也不吃这一套。
  const store = { ok: true, accounts: [{ key: "monkeycodeintl", accountId: "国际站", uid: "intl-1" }] }
  assert.equal(decideProvision({ store, uid: "mc-uid-1" }).key, "monkeycode")
})

// ══════════════════════════════════════════════════════════════════════
// ④ 写：auth.set 精确形状 + SSO 目标站点 + 邀请码透传
// ══════════════════════════════════════════════════════════════════════

test("④ 成功路径：auth.set 只给 {path:{id},body}，SSO 打的是 SITES.monkeycode 且邀请码原样透传", async () => {
  const file = tempAuthFile({ baizhi: { type: "api", key: "sk-test-baizhi", uid: "bz-1" } })
  const writer = fakeClient(file)
  const sso = fakeSso()
  const session = sessionHeaderOf(1)

  const result = await provisionMonkeyCode({
    client: writer.client,
    cookie: session,
    inviteCode: "INV-0001",
    sso: sso.sso,
    authFile: file,
  })

  assert.equal(result.ok, true, `开通应当成功，实际：${JSON.stringify(result)}`)
  assert.equal(result.key, "monkeycode")

  // 宿主只认这两格：多一个字段是噪音，少一个就是静默 no-op。
  assert.equal(writer.calls.length, 1, "一次开通只许写一次（写两次 = 两条记录 / 两次事件）")
  assert.deepEqual(Object.keys(writer.calls[0]).sort(), ["body", "path"])
  assert.deepEqual(Object.keys(writer.calls[0].path), ["id"])
  assert.equal(writer.calls[0].path.id, "monkeycode")

  // SSO 目标必须是**常量** SITES.monkeycode：国际站（monkeycodeintl）绝不触发。
  assert.equal(sso.calls.length, 1)
  assert.equal(sso.calls[0].site, SITES.monkeycode, "传进去的必须是站点表里那一个对象（不是现场拼的）")
  assert.equal(sso.calls[0].site.id, "monkeycode")
  assert.equal(sso.calls[0].cookie, session, "用的必须是**这次登录刚拿到**的那份会话")
  assert.equal(sso.calls[0].options.inviteCode, "INV-0001", "邀请码不能被自动路径吞掉（docs §5.1）")

  const body = writer.calls[0].body
  assert.equal(body.type, "oauth")
  assert.equal(body.uid, "mc-uid-1")
  assert.equal(body.accountId, "观猹员 0001")
  assert.deepEqual(JSON.parse(body.access), CREDENTIAL, "写进去的凭据必须是这次换出来的那一份")

  // 落盘的结果与写出去的一致（宿主整体替换，不是合并）。
  assert.deepEqual(readStore(file).monkeycode, body)
})

test("④b 端到端：裸键被别人的账号占着时，这次开通写到 sha8(uid) 后缀键，别人的记录一个字都不动", async () => {
  const other = { type: "oauth", access: "orig-other", uid: "other-uid", accountId: "别人的号" }
  const file = tempAuthFile({ monkeycode: other })
  const writer = fakeClient(file)

  const result = await provisionMonkeyCode({
    client: writer.client,
    cookie: sessionHeaderOf(2),
    sso: fakeSso().sso,
    authFile: file,
  })

  assert.equal(result.ok, true)
  assert.equal(result.key, `monkeycode#${sha8("mc-uid-1")}`)
  assert.equal(writer.calls[0].path.id, result.key)
  const store = readStore(file)
  assert.deepEqual(store.monkeycode, other, "写裸键会把别人的账号整条替换掉（docs §3.3）")
  assert.equal(store[result.key].uid, "mc-uid-1")
})

// ══════════════════════════════════════════════════════════════════════
// ⑤ 回读校验：宿主会「回 ok 但没写」或「写了旧记录」
// ══════════════════════════════════════════════════════════════════════

test("⑤ 回读不能只比 uid：access / refresh 不是这次那份 → ok:false", async () => {
  const file = tempAuthFile()
  const writer = fakeClient(file, {
    // 模拟「宿主留下了旧记录」：uid 对得上，凭据是旧的。
    transform: (body) => ({ ...body, access: `${body.access}-stale`, refresh: `${body.refresh}-stale` }),
  })

  const result = await provisionMonkeyCode({
    client: writer.client,
    cookie: sessionHeaderOf(3),
    sso: fakeSso().sso,
    authFile: file,
  })

  assert.equal(result.ok, false, "uid 相同不算写成功 —— 旧的 access 会让每个请求 403，用户完全看不出来")
})

test("⑤b 宿主静默 no-op（回 {data:true} 但没落盘）必须报 ok:false", async () => {
  const file = tempAuthFile()
  const writer = silentClient()

  const result = await provisionMonkeyCode({
    client: writer.client,
    cookie: sessionHeaderOf(4),
    sso: fakeSso().sso,
    authFile: file,
  })

  assert.equal(writer.calls.length, 1, "该写的还是写了一回")
  assert.equal(result.ok, false, "返回 {data:true} 不代表写成功（docs §1.2-F）")
})

// ══════════════════════════════════════════════════════════════════════
// ⑥ 单飞：同一份会话并发只跑一次 SSO
// ══════════════════════════════════════════════════════════════════════

test("⑥ 同一份 cookie 并发 → 只跑一次 SSO，两个调用共享同一个结果", async () => {
  const file = tempAuthFile()
  const writer = fakeClient(file)
  let ssoCount = 0
  const sso = async () => {
    ssoCount += 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    return { credential: { ...CREDENTIAL }, nickname: "观猹员 0001", userId: "mc-uid-9" }
  }
  const session = sessionHeaderOf(5)

  const [a, b] = await Promise.all([
    provisionMonkeyCode({ client: writer.client, cookie: session, sso, authFile: file }),
    provisionMonkeyCode({ client: writer.client, cookie: session, sso, authFile: file }),
  ])

  assert.equal(ssoCount, 1, "并发两次登录不许起两个无头浏览器（5~90 秒一个，还会各签一把 Key）")
  assert.equal(writer.calls.length, 1, "写也只许一次")
  assert.deepEqual(a, b, "第二个调用必须拿到同一份结果（不是『在跑，跳过』）")
  assert.equal(a.ok, true)
})

// ══════════════════════════════════════════════════════════════════════
// ⑦ 失败路径：一律不写、一律不抛（自动路径不许把百智云登录带崩）
// ══════════════════════════════════════════════════════════════════════

test("⑦ SSO 抛错 / auth.set 抛错：都只回 ok:false，不写、不抛", async () => {
  // SSO 挂了（授权没完成 / 换 Key 失败 / 起不来浏览器）
  const f1 = tempAuthFile()
  const c1 = fakeClient(f1)
  const r1 = await provisionMonkeyCode({
    client: c1.client,
    cookie: sessionHeaderOf(6),
    sso: async () => { throw new Error("SSO 挂了") },
    authFile: f1,
  })
  assert.equal(r1.ok, false)
  assert.equal(c1.calls.length, 0)
  assert.deepEqual(readStore(f1), {}, "失败一个字节都不许落盘")

  // 宿主写失败
  const f2 = tempAuthFile()
  const c2 = fakeClient(f2, { fail: new Error("写盘失败") })
  const r2 = await provisionMonkeyCode({ client: c2.client, cookie: sessionHeaderOf(7), sso: fakeSso().sso, authFile: f2 })
  assert.equal(r2.ok, false)
  assert.equal(c2.calls.length, 1)
  assert.deepEqual(readStore(f2), {})
})

test("⑦b 已经 abort（用户在 magpie 里取消了这次登录）→ 不写、不跑 SSO", async () => {
  const file = tempAuthFile()
  const writer = fakeClient(file)
  const sso = fakeSso()
  const result = await provisionMonkeyCode({
    client: writer.client,
    cookie: sessionHeaderOf(8),
    signal: AbortSignal.abort(),
    sso: sso.sso,
    authFile: file,
  })
  assert.equal(result.ok, false)
  assert.equal(result.skipped, "aborted", "取消必须能被调用方区分（不是笼统的 ok:false）")
  assert.equal(sso.calls.length, 0, "取消之后还在后台换号 = 白起一个无头浏览器 + 多签一把 Key")
  assert.equal(writer.calls.length, 0, "取消掉的登录不许留下副作用")
  assert.deepEqual(readStore(file), {})
})

test("⑦c 测试门闩 MAGPIE_PLUGIN_DISABLE_BROWSER=1：不跑 SSO、不写", async () => {
  const file = tempAuthFile()
  const writer = fakeClient(file)
  const sso = fakeSso()
  process.env.MAGPIE_PLUGIN_DISABLE_BROWSER = "1"
  try {
    const result = await provisionMonkeyCode({ client: writer.client, cookie: sessionHeaderOf(9), sso: sso.sso, authFile: file })
    assert.equal(result.ok, false)
    assert.equal(sso.calls.length, 0, "单测环境不许真的去换号")
    assert.equal(writer.calls.length, 0)
    assert.deepEqual(readStore(file), {})
  } finally {
    delete process.env.MAGPIE_PLUGIN_DISABLE_BROWSER
  }
})

// ══════════════════════════════════════════════════════════════════════
// ⑧⑨ 「已导入」台账：成功才写、写失败不影响已开通的结论
// ══════════════════════════════════════════════════════════════════════

test("⑧ 只在这条路真开通成功之后才登记已导入；失败不登记", async () => {
  const marked = []
  const okFile = tempAuthFile()
  const ok = await provisionMonkeyCode({
    client: fakeClient(okFile).client,
    cookie: sessionHeaderOf(10),
    sso: fakeSso().sso,
    authFile: okFile,
    identity: "bz-uid-1",
    markImported: (identity) => marked.push(identity),
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(marked, ["bz-uid-1"], "identity 要原样传下去（百智云侧的身份，不是 MonkeyCode 的 uid）")

  const failedMarks = []
  const failFile = tempAuthFile()
  const failed = await provisionMonkeyCode({
    client: fakeClient(failFile).client,
    cookie: sessionHeaderOf(11),
    sso: async () => { throw new Error("换号失败") },
    authFile: failFile,
    identity: "bz-uid-2",
    markImported: (identity) => failedMarks.push(identity),
  })
  assert.equal(failed.ok, false)
  assert.deepEqual(failedMarks, [], "失败还登记 = 这个号被永久跳过，用户点多少次都轮不到它")
})

test("⑨ 记录写成功但台账写失败：仍算开通成功（已经写进去了），并 log 一行", async () => {
  const file = tempAuthFile()
  const logs = []
  const result = await provisionMonkeyCode({
    client: fakeClient(file).client,
    cookie: sessionHeaderOf(12),
    sso: fakeSso().sso,
    authFile: file,
    identity: "bz-uid-3",
    markImported: () => { throw new Error("台账写失败") },
    log: (message) => logs.push(message),
  })

  assert.equal(result.ok, true, "账号已经在 magpie 里了 —— 台账失败不能把它报成失败")
  assert.equal(result.key, "monkeycode")
  assert.ok(logs.length >= 1, "至少要留一行日志，否则没人知道台账没写")
  assert.equal(readStore(file).monkeycode.uid, "mc-uid-1")
})

// ══════════════════════════════════════════════════════════════════════
// ⑩ 缺件：宁可不写，也不写半条
// ══════════════════════════════════════════════════════════════════════

test("⑩ 缺 client / 缺 sso：ok:false，不写，也不抛", async () => {
  const noClient = await provisionMonkeyCode({
    cookie: sessionHeaderOf(13),
    sso: fakeSso().sso,
    authFile: tempAuthFile(),
  })
  assert.equal(noClient.ok, false, "测试里 factory({client:{}}) 很常见 —— 缺 client 是正常路径，不是异常")

  const file = tempAuthFile()
  const writer = fakeClient(file)
  const noSso = await provisionMonkeyCode({ client: writer.client, cookie: sessionHeaderOf(14), authFile: file })
  assert.equal(noSso.ok, false)
  assert.equal(writer.calls.length, 0)
  assert.deepEqual(readStore(file), {})
})

test("⑩b SSO 没给 uid（拿不到平台身份）→ 不写", async () => {
  const file = tempAuthFile()
  const writer = fakeClient(file)
  for (const userId of ["", "   ", undefined]) {
    const result = await provisionMonkeyCode({
      client: writer.client,
      cookie: sessionHeaderOf(15),
      sso: fakeSso({ userId }).sso,
      authFile: file,
    })
    assert.equal(result.ok, false, `userId=${JSON.stringify(userId)}`)
  }
  assert.equal(writer.calls.length, 0, "没有稳定身份就没有幂等键 —— 写下去就是每次登录一个新账号")
})

test("⑩c 凭据缺关键字段（access_token / signing_secret）→ 不写", async () => {
  for (const missing of ["access_token", "signing_secret"]) {
    const credential = { ...CREDENTIAL }
    delete credential[missing]
    const file = tempAuthFile()
    const writer = fakeClient(file)
    const result = await provisionMonkeyCode({
      client: writer.client,
      cookie: sessionHeaderOf(16),
      sso: fakeSso({ credential }).sso,
      authFile: file,
    })
    assert.equal(result.ok, false, `缺 ${missing} 时不许写`)
    assert.equal(writer.calls.length, 0, `缺 ${missing} 的凭据写进去 = 每个请求 403（src/monkeycode/signing.mjs 的 isUsableCredential）`)
  }
})

// ══════════════════════════════════════════════════════════════════════
// ⑪ 并发写：SSO 可以并行，但「读 → 判键 → 写 → 回读」必须串行
//    （docs/final-review.md L1：两个不同 cookie 同时从空库开通会互相覆盖）
// ══════════════════════════════════════════════════════════════════════

/** 假 client：写之前先让出 5 ms —— 没有写锁时，两次「读」都会赶在「写」之前。 */
function slowClient(file) {
  const calls = []
  return {
    calls,
    client: {
      auth: {
        async set(opts) {
          calls.push(opts)
          await new Promise((resolve) => setTimeout(resolve, 5))
          const all = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
          all[opts?.path?.id] = opts?.body
          writeFileSync(file, JSON.stringify(all, null, 2))
          return { data: true }
        },
      },
    },
  }
}

test("⑪ 两个不同 cookie 同时从空库开通：一个拿裸键，另一个拿自己的 sha8 键，谁都不覆盖谁", async () => {
  const file = tempAuthFile()
  const writer = slowClient(file)
  const ssoOf = (uid) => async () => ({
    credential: { ...CREDENTIAL },
    nickname: `观猹员 ${uid}`,
    userId: uid,
  })

  const [a, b] = await Promise.all([
    provisionMonkeyCode({ client: writer.client, cookie: sessionHeaderOf(21), sso: ssoOf("mc-uid-A"), authFile: file }),
    provisionMonkeyCode({ client: writer.client, cookie: sessionHeaderOf(22), sso: ssoOf("mc-uid-B"), authFile: file }),
  ])

  assert.equal(writer.calls.length, 2, "两个账号各写一次")
  const keys = writer.calls.map((call) => call.path.id)
  assert.equal(
    new Set(keys).size,
    2,
    `两次写必须落在不同键上 —— 都写裸键就是后写覆盖先写（宿主整体替换）：${JSON.stringify(keys)}`,
  )
  assert.ok(keys.includes("monkeycode"), `空库的第一颗账号必须落在裸键上：${JSON.stringify(keys)}`)

  const suffixed = writer.calls.find((call) => call.path.id !== "monkeycode")
  assert.equal(
    suffixed.path.id,
    `monkeycode#${sha8(suffixed.body.uid)}`,
    "第二颗必须用确定性的 sha8(uid) 键（随机后缀 = 每次登录一个新账号）",
  )

  // 两个都要报成功 —— 成功意味着各自的回读（key+uid+access+refresh）都对上了。
  assert.equal(a.ok, true, `第一个应当成功：${JSON.stringify(a)}`)
  assert.equal(b.ok, true, `第二个应当成功：${JSON.stringify(b)}`)
  assert.deepEqual([a.key, b.key].sort(), [...keys].sort(), "返回的键必须与真正写下去的键一致")

  // 库里两条都在：谁都没被覆盖。
  const store = readStore(file)
  assert.equal(Object.keys(store).length, 2, `库里应当正好两条：${JSON.stringify(Object.keys(store))}`)
  for (const call of writer.calls) {
    assert.equal(store[call.path.id].uid, call.body.uid, `${call.path.id} 的记录被换了人`)
  }
})

test("⑪b 一次写失败不得毒化写队列：后面那次照样能开通", async () => {
  const file = tempAuthFile()
  const uidOf = (uid) => async () => ({ credential: { ...CREDENTIAL }, nickname: "观猹员", userId: uid })

  // ① 失败的那次：让临界区里**抛出去**（不是被 try 接住的那种）。
  //    只有「闭包 reject」才会真的把队尾变成一条 rejected promise ——
  //    这正是「锁的失败会不会毒化后续」要防的形态。
  const ssoThatExplodes = async () => ({
    credential: { ...CREDENTIAL },
    get nickname() {
      throw new Error("临界区里炸了")
    },
    userId: "mc-uid-F",
  })
  const first = await provisionMonkeyCode({
    client: fakeClient(file).client,
    cookie: sessionHeaderOf(23),
    sso: ssoThatExplodes,
    authFile: file,
  })
  assert.equal(first.ok, false, "意料之外的抛错必须变成结构化失败")
  assert.equal(typeof first.error, "string")

  // ② 后面那次必须还能进队列并成功（队列被 reject 毒化时，这里会直接失败）
  const writer = fakeClient(file)
  const second = await provisionMonkeyCode({ client: writer.client, cookie: sessionHeaderOf(24), sso: uidOf("mc-uid-G"), authFile: file })
  assert.equal(second.ok, true, `队列被前一次的失败毒化了：${JSON.stringify(second)}`)
  assert.equal(readStore(file)[second.key].uid, "mc-uid-G")

  // ③ 并发形态同样不许互相带塌：一个失败、一个成功
  const racing = { auth: { set: async () => { throw new Error("又失败") } } }
  const [bad, good] = await Promise.all([
    provisionMonkeyCode({ client: racing, cookie: sessionHeaderOf(25), sso: uidOf("mc-uid-H"), authFile: file }),
    provisionMonkeyCode({ client: fakeClient(file).client, cookie: sessionHeaderOf(26), sso: uidOf("mc-uid-I"), authFile: file }),
  ])
  assert.equal(bad.ok, false)
  assert.equal(good.ok, true, `并发时被别人的失败带塌了：${JSON.stringify(good)}`)
})

// ══════════════════════════════════════════════════════════════════════
// ⑫ 前置闸：`skipped` 原因必须是准确的，而且**一次 SSO 都不许先跑**
//    （docs/final-review.md L2：去掉任何一个闸，测试仍然全绿）
// ══════════════════════════════════════════════════════════════════════

test("⑫ 四个前置闸各自返回精确的 skipped，且都先于 SSO", async () => {
  // ① 缺 client
  const ssoA = fakeSso()
  const noClient = await provisionMonkeyCode({ cookie: sessionHeaderOf(27), sso: ssoA.sso, authFile: tempAuthFile() })
  assert.equal(noClient.ok, false)
  assert.equal(noClient.skipped, "no-client")
  assert.equal(ssoA.calls.length, 0, "缺 client 还先跑 SSO = 白起一个无头浏览器 + 多签一把 Key")

  // ② 缺 sso（自动路径绝不自己起浏览器）
  const fileB = tempAuthFile()
  const writerB = fakeClient(fileB)
  const noSso = await provisionMonkeyCode({ client: writerB.client, cookie: sessionHeaderOf(28), authFile: fileB })
  assert.equal(noSso.ok, false)
  assert.equal(noSso.skipped, "no-sso")
  assert.equal(writerB.calls.length, 0)
  assert.deepEqual(readStore(fileB), {})

  // ③ 进门前就已取消
  const fileC = tempAuthFile()
  const writerC = fakeClient(fileC)
  const ssoC = fakeSso()
  const aborted = await provisionMonkeyCode({
    client: writerC.client,
    cookie: sessionHeaderOf(29),
    signal: AbortSignal.abort(),
    sso: ssoC.sso,
    authFile: fileC,
  })
  assert.equal(aborted.ok, false)
  assert.equal(aborted.skipped, "aborted")
  assert.equal(ssoC.calls.length, 0)
  assert.equal(writerC.calls.length, 0)

  // ④ 测试门闩
  const fileD = tempAuthFile()
  const writerD = fakeClient(fileD)
  const ssoD = fakeSso()
  process.env.MAGPIE_PLUGIN_DISABLE_BROWSER = "1"
  try {
    const latched = await provisionMonkeyCode({ client: writerD.client, cookie: sessionHeaderOf(30), sso: ssoD.sso, authFile: fileD })
    assert.equal(latched.ok, false)
    assert.equal(latched.skipped, "test-latch")
    assert.equal(ssoD.calls.length, 0)
    assert.equal(writerD.calls.length, 0)
  } finally {
    delete process.env.MAGPIE_PLUGIN_DISABLE_BROWSER
  }
})

// ══════════════════════════════════════════════════════════════════════
// ⑬ 脱敏回归：日志与返回值都不许出现会话 / 凭据原文
//    （docs/final-review.md M2：t19 的「实测」不是测试，变异 P15 全绿）
// ══════════════════════════════════════════════════════════════════════

/** 一条**足够长**的假会话串：短值会被「长度 ≥ 8」的过滤放过，测不出问题。 */
function longSession(n) {
  return [[("sl-session"), `S${n}`.padEnd(24, "S")].join("="), [("baizhi_session"), `B${n}`.padEnd(24, "B")].join("=")].join("; ")
}

test("⑬ SSO 抛出的错误里带着会话串与凭据 → result.error 与每行 log 都不含原文", async () => {
  const file = tempAuthFile()
  const writer = fakeClient(file)
  const session = longSession(1)
  const token = `oma_${"T".repeat(32)}`
  const secret = "Q".repeat(32)
  const logs = []

  const result = await provisionMonkeyCode({
    client: writer.client,
    cookie: session,
    // 模拟真实情形：SSO 自己抛错，错误信息里带着它内部的会话与凭据 ——
    // **这时我们手上还没有那份 credential**，只能靠「按形状」那一层抹。
    sso: async () => {
      throw new Error(`换号失败：会话 ${session}；access_token=${token}；signing_secret=${secret}`)
    },
    authFile: file,
    log: (message) => logs.push(message),
  })

  assert.equal(result.ok, false, "SSO 失败必须是结构化失败，不抛")
  assert.ok(logs.length >= 1, "失败至少要留一行日志")
  assert.equal(writer.calls.length, 0)

  const forbidden = [`S${1}`.padEnd(24, "S"), `B${1}`.padEnd(24, "B"), token, secret]
  for (const text of [result.error, ...logs]) {
    assert.equal(typeof text, "string")
    for (const value of forbidden) {
      assert.equal(text.includes(value), false, `脱敏漏了 ${value.slice(0, 12)}…：${text}`)
    }
    assert.ok(text.includes("<redacted>"), `抹掉之后要留痕迹，否则看不出被脱敏过：${text}`)
  }
})

test("⑬b 写入失败时返回的 error 也要脱敏（不只日志）", async () => {
  const token = `oma_${"V".repeat(32)}`
  const secret = "W".repeat(32)
  const file = tempAuthFile()
  const client = {
    auth: {
      set: async () => {
        throw new Error(`宿主拒绝写入：access_token=${token} signing_secret=${secret}`)
      },
    },
  }
  const logs = []

  const result = await provisionMonkeyCode({
    client,
    cookie: sessionHeaderOf(31),
    sso: async () => ({
      credential: { access_token: token, signing_secret: secret, session_cookie: "x" },
      nickname: "观猹员 0001",
      userId: "mc-uid-1",
    }),
    authFile: file,
    log: (message) => logs.push(message),
  })

  assert.equal(result.ok, false, "写入失败必须是结构化失败")
  assert.ok(logs.length >= 1, "失败至少要留一行日志")
  for (const text of [result.error, ...logs]) {
    assert.equal(text.includes(token), false, `返回值/日志带着 access_token：${text}`)
    assert.equal(text.includes(secret), false, `返回值/日志带着 signing_secret：${text}`)
    assert.ok(text.includes("<redacted>"), `抹掉之后要留痕迹：${text}`)
  }
})

test("⑬c 意料之外的抛错（顶层兜底那条路）也必须脱敏", async () => {
  const file = tempAuthFile()
  const writer = fakeClient(file)
  const session = longSession(3)
  const token = `oma_${"X".repeat(32)}`
  const logs = []

  const result = await provisionMonkeyCode({
    client: writer.client,
    cookie: session,
    // 取 nickname 的那一刻抛：这条路径**不经过** `attempt` 里任何一个 try，
    // 只能由 `provisionMonkeyCode` 的顶层 catch 兜住 —— 那里同样不许漏原文。
    sso: async () => ({
      credential: { ...CREDENTIAL },
      get nickname() {
        throw new Error(`上游炸了：access_token=${token}`)
      },
      userId: "mc-uid-1",
    }),
    authFile: file,
    log: (message) => logs.push(message),
  })

  assert.equal(result.ok, false, "意料之外的抛错也要变成结构化失败")
  assert.equal(writer.calls.length, 0)
  assert.ok(logs.length >= 1, "兜底 catch 也要留一行日志")
  for (const text of [result.error, ...logs]) {
    assert.equal(text.includes(token), false, `顶层兜底漏了 access_token：${text}`)
    assert.ok(text.includes("<redacted>"), `抹掉之后要留痕迹：${text}`)
  }
})
