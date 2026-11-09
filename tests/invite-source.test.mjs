// tests/invite-source.test.mjs —— 邀请来源策略：纯记录输入，零真实 HOME / 网络 / 文件写入。

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import {
  INVITE_SOURCE_LATEST,
  INVITE_SOURCE_MANUAL,
  buildInviteSourceOptions,
  buildInviteSourcePrompt,
  deriveLatestInviteSource,
  findLatestBaizhiAccount,
  resolveInviteSource,
} from "../src/invite-source.mjs"

const bz = (identity, accountId = `acct-${identity}`) => ({ key: `baizhi#${identity}`, identity, accountId, cookie: "not-read" })
const mc = (uid, accountId) => ({ key: `monkeycode#${uid}`, uid, accountId })

function assertShape(result) {
  assert.deepEqual(
    Object.keys(result).sort(),
    ["baizhiCode", "mode", "monkeycodeCode", "reason", "sourceIdentity"],
  )
}

// ── 最新账号与两家码的安全映射 ─────────────────────────────────────────

test("最新账号按数值 identity 排序，不按字典序，也不被末尾非数值项带偏", () => {
  const baizhiAccounts = [bz("9"), bz("not-numeric"), bz("10"), bz("2")]
  const monkeycodeAccounts = [mc("mc-nine", "acct-9"), mc("mc-ten", "acct-10"), mc("mc-two", "acct-2")]
  const result = deriveLatestInviteSource({
    baizhiAccounts,
    monkeycodeAccounts,
    // 百智云码只能由调用方注入（平台 `/api/v1/user/invite-code` 的 data.invite_code）。
    baizhiCodes: { "10": "AB12CD34" },
  })

  assert.equal(findLatestBaizhiAccount(baizhiAccounts).identity, "10")
  assert.deepEqual(result, {
    sourceIdentity: "10",
    baizhiCode: "AB12CD34",
    monkeycodeCode: "mc-ten",
    mode: "latest",
    reason: "latest-numeric-identity",
  })
  assert.notEqual(result.baizhiCode, result.sourceIdentity, "邀请码不是账号 identity")
  assertShape(result)
})

test("没注入码表时 baizhiCode 是空串：绝不把 identity 当码（红条 invite_code length must be 8）", () => {
  const result = deriveLatestInviteSource({
    baizhiAccounts: [bz("10"), bz("2")],
    monkeycodeAccounts: [mc("mc-ten", "acct-10")],
  })
  assert.equal(result.sourceIdentity, "10")
  assert.equal(result.baizhiCode, "", "没有平台下发的 8 位码就不带邀请")
  assert.notEqual(result.baizhiCode, "10")
})

test("注入的码不是 8 位字母数字（identity / 超长 / 空）时一律丢弃", () => {
  for (const injected of ["10", "9007199254740993", "AB12CD3", "AB12CD34X", "", "  ", "AB12 CD3"]) {
    const result = deriveLatestInviteSource({
      baizhiAccounts: [bz("10")],
      baizhiCodes: { "10": injected },
    })
    assert.equal(result.baizhiCode, "", `非法码 ${JSON.stringify(injected)} 不该进 URL`)
  }
})

test("码表同时接受对象与 Map，且只取当前账号那一条", () => {
  const accounts = [bz("10"), bz("2")]
  const object = deriveLatestInviteSource({ baizhiAccounts: accounts, baizhiCodes: { "10": "AB12CD34", "2": "ZZ99ZZ99" } })
  assert.equal(object.baizhiCode, "AB12CD34")
  const mapped = deriveLatestInviteSource({ baizhiAccounts: accounts, baizhiCodes: new Map([["10", "AB12CD34"]]) })
  assert.equal(mapped.baizhiCode, "AB12CD34")
  const missing = deriveLatestInviteSource({ baizhiAccounts: accounts, baizhiCodes: new Map([["2", "ZZ99ZZ99"]]) })
  assert.equal(missing.baizhiCode, "", "别的账号的码不能顶上来")
})

test("超长数值 identity 用整数精度比较，超过 Number.MAX_SAFE_INTEGER 也不串序", () => {
  const smaller = "90071992547409931234567890"
  const larger = "90071992547409931234567891"
  const result = deriveLatestInviteSource({
    baizhiAccounts: [bz(larger), bz(smaller)],
    monkeycodeAccounts: [mc("mc-smaller", `acct-${smaller}`), mc("mc-larger", `acct-${larger}`)],
  })
  assert.equal(result.sourceIdentity, larger)
  assert.equal(result.monkeycodeCode, "mc-larger")
})

test("没有可比较的数值 identity 时才使用账号添加顺序的最后一条", () => {
  const result = deriveLatestInviteSource({
    baizhiAccounts: [bz("session-a"), bz("session-b"), bz("session-c")],
    monkeycodeAccounts: [mc("mc-c", "acct-session-c")],
    baizhiCodes: { "session-c": "AbC12345" },
  })
  assert.equal(result.sourceIdentity, "session-c")
  assert.equal(result.baizhiCode, "AbC12345")
  assert.notEqual(result.baizhiCode, result.sourceIdentity)
  assert.equal(result.monkeycodeCode, "mc-c")
  assert.equal(result.reason, "latest-addition-order")
})

test("readProvisionedAccounts 的 { ok, accounts } 外壳可直接注入", () => {
  const result = deriveLatestInviteSource({
    baizhiAccounts: [bz("1")],
    monkeycodeAccounts: { ok: true, accounts: [mc("mc-one", "acct-1")] },
  })
  assert.equal(result.monkeycodeCode, "mc-one")
})

test("MonkeyCode 只在非空 accountId 唯一精确匹配时给 uid", () => {
  const result = deriveLatestInviteSource({
    baizhiAccounts: [bz("1", "other"), bz("2", "exact-name")],
    monkeycodeAccounts: [mc("wrong-uid", "other"), mc("right-uid", "exact-name")],
  })
  assert.equal(result.sourceIdentity, "2")
  assert.equal(result.monkeycodeCode, "right-uid")
})

test("MonkeyCode accountId 重名时不猜：即使另一条有 uid 也返回空猴码", () => {
  const result = deriveLatestInviteSource({
    baizhiAccounts: [bz("1", "unique"), bz("2", "duplicate")],
    monkeycodeAccounts: [mc("mc-a", "duplicate"), mc("mc-b", "duplicate"), mc("mc-c", "unique")],
    baizhiCodes: { "2": "CODE0002" },
  })
  assert.equal(result.baizhiCode, "CODE0002", "猴码重名不能影响百智云码")
  assert.equal(result.monkeycodeCode, "")
})

test("空 accountId、大小写或空白差异都不算精确匹配", () => {
  for (const [sourceName, candidateName] of [
    ["", ""],
    ["CaseName", "casename"],
    ["padded", " padded "],
  ]) {
    const result = deriveLatestInviteSource({
      baizhiAccounts: [bz("7", sourceName)],
      monkeycodeAccounts: [mc("must-not-leak", candidateName)],
      baizhiCodes: { "7": "CODE0007" },
    })
    assert.equal(result.baizhiCode, "CODE0007")
    assert.equal(result.monkeycodeCode, "", `${JSON.stringify(sourceName)} 不应匹配 ${JSON.stringify(candidateName)}`)
  }
})

test("唯一 accountId 匹配但 uid 为空时猴码为空，不借用其他账号", () => {
  const result = deriveLatestInviteSource({
    baizhiAccounts: [bz("7", "matched")],
    monkeycodeAccounts: [mc("", "matched"), mc("other-uid", "other")],
    baizhiCodes: { "7": "CODE0007" },
  })
  assert.equal(result.baizhiCode, "CODE0007")
  assert.equal(result.monkeycodeCode, "")
})

// ── resolve：滚动 / 首选 / 记忆 / 回退 / 手动 / 自邀 ─────────────────────

test("preferred off 永远选最新，忽略 selectedIdentity 与 savedIdentity", () => {
  const result = resolveInviteSource({
    baizhiAccounts: [bz("1"), bz("3"), bz("2")],
    monkeycodeAccounts: [mc("mc-three", "acct-3")],
    preferredEnabled: false,
    selectedIdentity: "1",
    savedIdentity: "2",
  })
  assert.equal(result.mode, "latest")
  assert.equal(result.sourceIdentity, "3")
  assert.equal(result.monkeycodeCode, "mc-three")
})

test("preferred on 使用有效 selectedIdentity，而不是数值更新的账号", () => {
  const result = resolveInviteSource({
    baizhiAccounts: [bz("1"), bz("3"), bz("2")],
    monkeycodeAccounts: [mc("mc-two", "acct-2")],
    baizhiCodes: { "2": "CODE0002", "3": "CODE0003" },
    preferredEnabled: true,
    selectedIdentity: "2",
    savedIdentity: "1",
    targetIdentity: "999",
  })
  assert.equal(result.mode, "preferred")
  assert.equal(result.reason, "preferred-selected-identity")
  assert.equal(result.sourceIdentity, "2")
  assert.equal(result.baizhiCode, "CODE0002", "只取所选账号自己的 8 位码")
  assert.equal(result.monkeycodeCode, "mc-two")
})

test("selectedIdentity 为 nullish 时使用记住的 savedIdentity", () => {
  for (const selectedIdentity of [undefined, null]) {
    const result = resolveInviteSource({
      baizhiAccounts: [bz("1"), bz("3"), bz("2")],
      preferredEnabled: true,
      selectedIdentity,
      savedIdentity: "2",
    })
    assert.equal(result.mode, "preferred")
    assert.equal(result.reason, "preferred-saved-identity")
    assert.equal(result.sourceIdentity, "2")
  }
})

test("首选为空时回退最新；显式空串不会越过 ?? 去用 savedIdentity", () => {
  const result = resolveInviteSource({
    baizhiAccounts: [bz("1"), bz("3"), bz("2")],
    preferredEnabled: true,
    selectedIdentity: "  ",
    savedIdentity: "2",
  })
  assert.equal(result.mode, "latest")
  assert.equal(result.reason, "preferred-empty-fallback-latest")
  assert.equal(result.sourceIdentity, "3")
})

test("首选 identity 无效时回退最新，不能退而使用 savedIdentity 或其他账号", () => {
  for (const input of [
    { selectedIdentity: "missing", savedIdentity: "2", reason: "preferred-invalid-fallback-latest" },
    { selectedIdentity: undefined, savedIdentity: "missing", reason: "preferred-invalid-fallback-latest" },
  ]) {
    const result = resolveInviteSource({
      baizhiAccounts: [bz("1"), bz("3"), bz("2")],
      preferredEnabled: true,
      ...input,
    })
    assert.equal(result.mode, "latest")
    assert.equal(result.reason, input.reason)
    assert.equal(result.sourceIdentity, "3")
  }
})

test("首次无账号时 manualBaizhiCode 与 manualMonkeycodeCode 分别兜底", () => {
  const result = resolveInviteSource({
    baizhiAccounts: [],
    monkeycodeAccounts: [],
    preferredEnabled: true,
    selectedIdentity: "still-ignored",
    manualBaizhiCode: "  MANUAL01  ",
    manualMonkeycodeCode: "  manual-mc-uid  ",
  })
  assert.deepEqual(result, {
    sourceIdentity: "MANUAL01",
    baizhiCode: "MANUAL01",
    monkeycodeCode: "manual-mc-uid",
    mode: "manual",
    reason: "no-baizhi-accounts-manual-fallback",
  })
})

test("手输的不是 8 位字母数字（典型：粘了 identity）就不带，sourceIdentity 逐字保留", () => {
  const result = resolveInviteSource({
    manualBaizhiCode: "9007199254740993",
    manualMonkeycodeCode: "mc-uid",
    targetIdentity: "999",
  })
  assert.equal(result.sourceIdentity, "9007199254740993", "自邀判据仍按用户输入逐字比较")
  assert.equal(result.baizhiCode, "", "15 位 identity 不许当邀请码 —— 否则红条 invite_code length must be 8")
  assert.equal(result.monkeycodeCode, "mc-uid")
})

test("首次手动兜底两路独立：缺百智云码不清空猴码，缺猴码也不清空百智云码", () => {
  const bzOnly = resolveInviteSource({ manualBaizhiCode: "ONLYBZ01", manualMonkeycodeCode: "" })
  assert.equal(bzOnly.baizhiCode, "ONLYBZ01")
  assert.equal(bzOnly.monkeycodeCode, "")

  const mcOnly = resolveInviteSource({ manualBaizhiCode: "", manualMonkeycodeCode: "only-mc" })
  assert.equal(mcOnly.sourceIdentity, "")
  assert.equal(mcOnly.baizhiCode, "")
  assert.equal(mcOnly.monkeycodeCode, "only-mc")
})

test("有账号但 MonkeyCode 匹配不到时猴码为空，手动猴码不能越权补位", () => {
  const result = resolveInviteSource({
    baizhiAccounts: [bz("8", "no-counterpart")],
    monkeycodeAccounts: [mc("wrong-account-uid", "someone-else")],
    baizhiCodes: { "8": "CODE0008" },
    manualBaizhiCode: "manual-must-not-replace",
    manualMonkeycodeCode: "manual-must-not-fill",
  })
  assert.equal(result.sourceIdentity, "8")
  assert.equal(result.baizhiCode, "CODE0008", "猴码缺失不影响百智云码")
  assert.equal(result.monkeycodeCode, "", "不匹配时绝不拿别的 uid 或手动猴码凑")
})

test("targetIdentity 等于选中来源时跳过两家邀请，保留来源供审计", () => {
  const result = resolveInviteSource({
    baizhiAccounts: [bz("1"), bz("2")],
    monkeycodeAccounts: [mc("mc-two", "acct-2")],
    targetIdentity: "2",
  })
  assert.deepEqual(result, {
    sourceIdentity: "2",
    baizhiCode: "",
    monkeycodeCode: "",
    mode: "skip",
    reason: "self-invite",
  })
})

test("无账号手动兜底也防止 targetIdentity 使用自己的百智云码自邀", () => {
  const result = resolveInviteSource({
    manualBaizhiCode: "self-id",
    manualMonkeycodeCode: "mc-uid",
    targetIdentity: "self-id",
  })
  assert.equal(result.sourceIdentity, "self-id")
  assert.equal(result.baizhiCode, "")
  assert.equal(result.monkeycodeCode, "")
  assert.equal(result.mode, "skip")
  assert.equal(result.reason, "self-invite")
})

// ── select / 手动 prompt / placement ───────────────────────────────────

test("select 包含自动、各账号、手动项；账号 label 带 accountId 且 value=identity", () => {
  const prompt = buildInviteSourcePrompt({ baizhiAccounts: [bz("2", "shown-two"), bz("10", "shown-ten")] })
  assert.equal(prompt.type, "select")
  assert.equal(prompt.key, "inviteSource")
  assert.equal(prompt.placement, "top", "magpie auth prompt 必须置顶")
  assert.equal("top" in prompt, false, "宿主契约不是 top:true")
  assert.deepEqual(prompt.options.map((option) => option.value), [INVITE_SOURCE_LATEST, "2", "10", INVITE_SOURCE_MANUAL])
  assert.equal(prompt.options[0].label, "最新注册账号（自动）")
  assert.equal(prompt.options.at(-1).label, "手动输入邀请码")
  assert.match(prompt.options[1].label, /shown-two/)
  assert.match(prompt.options[2].label, /shown-ten/)
})

test("首选模式把 savedIdentity 对应项移到第一，identity 去重且内容不复制", () => {
  const options = buildInviteSourceOptions({
    baizhiAccounts: [bz("1", "one"), bz("2", "two"), bz("2", "duplicate-two"), bz("3", "three")],
    preferredEnabled: true,
    savedIdentity: "2",
  })
  assert.deepEqual(options.map((option) => option.value), ["2", INVITE_SOURCE_LATEST, "1", "3", INVITE_SOURCE_MANUAL])
  assert.equal(new Set(options.map((option) => option.value)).size, options.length)
  assert.equal(options.filter((option) => option.value === "2").length, 1)
  assert.match(options[0].label, /two/)
  assert.doesNotMatch(options[0].label, /duplicate-two/, "重复 identity 保留首先添加的那项")
})

test("首选 select 的 selectedIdentity 优先于 savedIdentity，无效记忆则自动项第一", () => {
  const accounts = [bz("1"), bz("2"), bz("3")]
  const selected = buildInviteSourceOptions({
    baizhiAccounts: accounts,
    preferredEnabled: true,
    selectedIdentity: "3",
    savedIdentity: "2",
  })
  assert.equal(selected[0].value, "3")
  assert.equal(selected.at(-1).value, INVITE_SOURCE_MANUAL)

  const invalid = buildInviteSourceOptions({
    baizhiAccounts: accounts,
    preferredEnabled: true,
    selectedIdentity: "missing",
    savedIdentity: "2",
  })
  assert.equal(invalid[0].value, INVITE_SOURCE_LATEST)
})

test("无可选账号时返回手动兜底 text 提示而非空 select，并同样 placement=top", () => {
  for (const baizhiAccounts of [[], [{ key: "broken", identity: "", accountId: "none" }]]) {
    const prompt = buildInviteSourcePrompt({ baizhiAccounts, key: "customInvite" })
    assert.equal(prompt.type, "text")
    assert.equal(prompt.key, "customInvite")
    assert.equal(prompt.message, "手动输入邀请码")
    assert.equal(prompt.placement, "top")
    assert.equal("options" in prompt, false)
    assert.match(prompt.placeholder, /invite_code/)
    assert.match(prompt.placeholder, /inviter_id/)
    assert.match(prompt.placeholder, /已注册账号不能补邀/)
  }
})

test("deriveLatestInviteSource 无账号时返回清晰 none，而不是伪造邀请源", () => {
  assert.deepEqual(deriveLatestInviteSource(), {
    sourceIdentity: "",
    baizhiCode: "",
    monkeycodeCode: "",
    mode: "none",
    reason: "no-baizhi-accounts",
  })
})

test("策略与 select 构造不改写调用方记录", () => {
  const baizhiAccounts = Object.freeze([Object.freeze(bz("1")), Object.freeze(bz("2"))])
  const monkeycodeAccounts = Object.freeze([Object.freeze(mc("mc-two", "acct-2"))])
  const result = resolveInviteSource({ baizhiAccounts, monkeycodeAccounts, preferredEnabled: true, savedIdentity: "1" })
  assert.equal(result.sourceIdentity, "1")
  assert.doesNotThrow(() => buildInviteSourcePrompt({ baizhiAccounts, preferredEnabled: true, savedIdentity: "2" }))
  assert.deepEqual(baizhiAccounts.map((account) => account.identity), ["1", "2"])
})

test("模块没有任何 import：不可能在顶层隐式读 HOME、真实库或发网络", () => {
  const source = readFileSync(new URL("../src/invite-source.mjs", import.meta.url), "utf8")
  assert.doesNotMatch(source, /^import\s/m)
  assert.doesNotMatch(source, /\bfetch\s*\(/)
})
