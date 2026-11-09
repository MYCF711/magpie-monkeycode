// tests/invite-policy.test.mjs —— 邀请策略运行时：零网络、零真实 HOME、全部 reader/store 注入。

import test from "node:test"
import assert from "node:assert/strict"

import {
  INVITE_PREFERRED_KEY,
  INVITE_PREFERRED_OPTION,
  INVITE_SOURCE_LATEST,
  INVITE_SOURCE_MANUAL,
  createInvitePolicy,
  readInvitePreferred,
  resolveInvitePolicy,
} from "../src/invite-policy.mjs"

const bz = (identity, accountId = `acct-${identity}`) => ({ key: `baizhi#${identity}`, identity, accountId })
const mc = (uid, accountId) => ({ key: `monkeycode#${uid}`, uid, accountId })

function memoryStore(initial = "") {
  let code = initial
  const writes = []
  return {
    writes,
    read: () => code,
    write(value) {
      code = value
      writes.push(value)
    },
  }
}

function policyFixture({
  enabled = false,
  accounts = [bz("1"), bz("2")],
  monkeycodeAccounts = [mc("mc-one", "acct-1"), mc("mc-two", "acct-2")],
  saved = "",
  dualManual = true,
} = {}) {
  const preferred = memoryStore(saved)
  const baizhi = memoryStore("saved-bz")
  const monkeycode = memoryStore("saved-mc")
  const optionCalls = []
  let current = enabled
  const ctx = {
    magpie: {
      option(provider, key) {
        optionCalls.push([provider, key])
        return current
      },
    },
  }
  const policy = createInvitePolicy({
    ctx,
    provider: "baizhi",
    dualManual,
    preferredStore: preferred,
    baizhiInviteStore: baizhi,
    monkeycodeInviteStore: monkeycode,
    readBaizhiAccounts: () => accounts,
    readMonkeycodeAccounts: () => monkeycodeAccounts,
    manual: {
      baizhi: { key: "invite", message: "百智云邀请码" },
      monkeycode: { key: dualManual ? "monkeycodeInvite" : "invite", message: "MonkeyCode 邀请码" },
    },
  })
  return { policy, preferred, baizhi, monkeycode, optionCalls, setEnabled(value) { current = value } }
}

test("开关声明严格是 invite_preferred / 默认 false / placement top", () => {
  assert.deepEqual({ ...INVITE_PREFERRED_OPTION }, {
    key: "invite_preferred",
    label: "首选账号作为邀请源",
    description: "关闭：自动使用最新注册账号滚动邀请；开启：登录时选择最新账号、指定账号或手动邀请码，并记住选择。",
    default: false,
    placement: "top",
  })
  assert.equal("top" in INVITE_PREFERRED_OPTION, false)
})

test("ctx.magpie.option 每次现读、参数逐字正确；异常与老宿主都按 off", () => {
  let enabled = false
  const calls = []
  const ctx = {
    magpie: {
      option(provider, key) {
        calls.push([provider, key])
        return enabled
      },
    },
  }
  assert.equal(readInvitePreferred(ctx, "baizhi"), false)
  enabled = true
  assert.equal(readInvitePreferred(ctx, "baizhi"), true, "第二次必须读到新值，不能缓存")
  assert.deepEqual(calls, [["baizhi", INVITE_PREFERRED_KEY], ["baizhi", INVITE_PREFERRED_KEY]])
  assert.equal(readInvitePreferred({ magpie: { option() { throw new Error("old host") } } }, "monkeycode"), false)
  assert.equal(readInvitePreferred({}, "monkeycode"), false)
  assert.equal(readInvitePreferred(undefined, "monkeycode"), false)
})

test("off 自动最新：最新无猴对应时，只用最近一个唯一精确 accountId 映射补猴码", () => {
  const result = resolveInvitePolicy({
    baizhiAccounts: [bz("1"), bz("2", "duplicate"), bz("10", "latest-no-mc")],
    monkeycodeAccounts: [
      mc("mc-one", "acct-1"),
      mc("ambiguous-a", "duplicate"),
      mc("ambiguous-b", "duplicate"),
      mc("must-not-use", "latest-no-mc-copy"),
    ],
    preferredEnabled: false,
  })
  assert.equal(result.sourceIdentity, "10", "主来源仍是最新百智云账号")
  assert.equal(result.baizhiCode, "10")
  assert.equal(result.monkeycodeCode, "mc-one", "重名账号不能猜，继续向前找唯一精确映射")
  assert.equal(result.mode, "latest")
})

test("preferred on 严格使用所选账号：映射不到就空；选 latest 也不许 off 回退", () => {
  const accounts = [bz("1"), bz("10", "latest-no-mc")]
  const monkeycodeAccounts = [mc("mc-one", "acct-1")]
  for (const selectedIdentity of ["10", INVITE_SOURCE_LATEST]) {
    const result = resolveInvitePolicy({
      baizhiAccounts: accounts,
      monkeycodeAccounts,
      preferredEnabled: true,
      selectedIdentity,
    })
    assert.equal(result.sourceIdentity, "10")
    assert.equal(result.baizhiCode, "10")
    assert.equal(result.monkeycodeCode, "", `selected=${selectedIdentity} 不得借用 acct-1 的猴码`)
  }

  const preferredOne = resolveInvitePolicy({
    baizhiAccounts: accounts,
    monkeycodeAccounts,
    preferredEnabled: true,
    selectedIdentity: "1",
  })
  assert.equal(preferredOne.monkeycodeCode, "mc-one")
})

test("自邀按主 source identity 跳过：off 的猴码回退也不得重新补入", () => {
  const result = resolveInvitePolicy({
    baizhiAccounts: [bz("1"), bz("10", "latest-no-mc")],
    monkeycodeAccounts: [mc("mc-one", "acct-1")],
    preferredEnabled: false,
    targetIdentity: "10",
  })
  assert.deepEqual(result, {
    sourceIdentity: "10",
    baizhiCode: "",
    monkeycodeCode: "",
    mode: "skip",
    reason: "self-invite",
  })
})

test("off 有账号时 ask/prompts 都不出现 select 或文本，authorize({}) 仍能独立生效", () => {
  const fixture = policyFixture({ enabled: false })
  assert.equal(fixture.policy.ask({}), null)
  assert.deepEqual(fixture.policy.prompts(), [])
  const result = fixture.policy.prepare({})()
  assert.equal(result.baizhiCode, "2")
  assert.equal(result.monkeycodeCode, "mc-two")
  assert.deepEqual(fixture.baizhi.writes, [], "自动账号模式不得写手动百智云码")
  assert.deepEqual(fixture.monkeycode.writes, [], "自动账号模式不得写手动猴码")
  assert.deepEqual(fixture.optionCalls, Array(3).fill(["baizhi", INVITE_PREFERRED_KEY]), "ask / prompts / authorize 每次都现读")
})

test("on 给顶部 select，账号按 identity 去重；具体账号 / latest 后不再问文本", () => {
  const fixture = policyFixture({
    enabled: true,
    accounts: [bz("1", "one"), bz("2", "two"), bz("2", "duplicate-two")],
    saved: "2",
  })
  const select = fixture.policy.ask({})
  assert.equal(select.type, "select")
  assert.equal(select.key, "inviteSource")
  assert.equal(select.placement, "top")
  assert.deepEqual(select.options.map((option) => option.value), ["2", INVITE_SOURCE_LATEST, "1", INVITE_SOURCE_MANUAL])
  assert.equal(select.options[0].label.includes("duplicate-two"), false)

  assert.equal(fixture.policy.ask({ inviteSource: "1" }), null)
  assert.equal(fixture.policy.ask({ inviteSource: INVITE_SOURCE_LATEST }), null)
  const resolve = fixture.policy.prepare({ inviteSource: "1" })
  assert.deepEqual(fixture.preferred.writes, ["1"], "authorize 必须记住首选选择")
  assert.equal(resolve().sourceIdentity, "1")
  assert.equal(fixture.policy.ask({}).options[0].value, "1", "下一次 select 把记住账号放在首位")
})

test("manual 分支仍依次问原有两格，placement top，两码独立解析与落盘", () => {
  const fixture = policyFixture({ enabled: true })
  const first = fixture.policy.ask({ inviteSource: INVITE_SOURCE_MANUAL })
  assert.equal(first.type, "text")
  assert.equal(first.key, "invite")
  assert.equal(first.placement, "top")
  const second = fixture.policy.ask({ inviteSource: INVITE_SOURCE_MANUAL, invite: "new-bz" })
  assert.equal(second.type, "text")
  assert.equal(second.key, "monkeycodeInvite")
  assert.equal(second.placement, "top")
  assert.equal(fixture.policy.ask({ inviteSource: INVITE_SOURCE_MANUAL, invite: "new-bz", monkeycodeInvite: "new-mc" }), null)

  const resolve = fixture.policy.prepare({
    inviteSource: INVITE_SOURCE_MANUAL,
    invite: "new-bz",
    monkeycodeInvite: "new-mc",
  })
  assert.deepEqual(fixture.baizhi.writes, ["new-bz"])
  assert.deepEqual(fixture.monkeycode.writes, ["new-mc"])
  const result = resolve()
  assert.equal(result.mode, "manual")
  assert.equal(result.baizhiCode, "new-bz")
  assert.equal(result.monkeycodeCode, "new-mc")
  assert.deepEqual(fixture.preferred.writes, [INVITE_SOURCE_MANUAL])

  const remembered = fixture.policy.prepare({})()
  assert.equal(remembered.mode, "manual", "记住 manual 后，空 inputs 也不能退回 latest")
  assert.equal(remembered.baizhiCode, "new-bz")
  assert.equal(remembered.monkeycodeCode, "new-mc")
})

test("无账号时 off 也有手动兜底：百智云两格、国内站一格，缺一路不清空另一路", () => {
  const dual = policyFixture({ enabled: false, accounts: [] })
  assert.equal(dual.policy.ask({}).key, "invite")
  assert.equal(dual.policy.ask({ invite: "" }).key, "monkeycodeInvite")
  const dualResult = dual.policy.prepare({ invite: "only-bz", monkeycodeInvite: "0" })()
  assert.equal(dualResult.baizhiCode, "only-bz")
  assert.equal(dualResult.monkeycodeCode, "saved-mc", "0 沿用既有猴码，不被百智云新码覆盖")

  const single = policyFixture({ enabled: false, accounts: [], dualManual: false })
  const prompt = single.policy.ask({})
  assert.equal(prompt.key, "invite")
  assert.equal(prompt.placement, "top")
  assert.equal(single.policy.ask({ invite: "only-mc" }), null)
  const singleResult = single.policy.prepare({ invite: "only-mc" })()
  assert.equal(singleResult.baizhiCode, "")
  assert.equal(singleResult.monkeycodeCode, "only-mc")
  assert.deepEqual(single.baizhi.writes, [], "国内站不得触碰百智云手动码")
})

test("prepare 的 targetIdentity 自邀跳过与 provision 使用同一 resolver 快照", () => {
  const fixture = policyFixture({ enabled: false })
  const resolve = fixture.policy.prepare({})
  assert.equal(resolve().monkeycodeCode, "mc-two")
  const skipped = resolve("2")
  assert.equal(skipped.mode, "skip")
  assert.equal(skipped.sourceIdentity, "2")
  assert.equal(skipped.baizhiCode, "")
  assert.equal(skipped.monkeycodeCode, "")
})
