// tests/invite-policy.test.mjs —— 邀请策略运行时：零网络、零真实 HOME、全部 reader/store 注入。
//
// 百智云那 8 位邀请码由 `readAccountInviteCode` 注入（runtime 里接 `fetchInviteCode`）；
// 本文件只给它一个内存替身，因此不会有任何真实请求。

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
  inviteCodes = { "1": "CODE0001", "2": "CODE0002" },
  codeError,
} = {}) {
  const preferred = memoryStore(saved)
  const baizhi = memoryStore("saved-bz")
  const monkeycode = memoryStore("saved-mc")
  const optionCalls = []
  const codeCalls = []
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
    // 平台接口的替身：按 identity 回 8 位码；不在表里就「拿不到」。
    readAccountInviteCode: async (account) => {
      codeCalls.push(account?.identity)
      if (codeError) throw codeError
      return inviteCodes[account?.identity] ?? ""
    },
    manual: {
      baizhi: { key: "invite", message: "百智云邀请码" },
      monkeycode: { key: dualManual ? "monkeycodeInvite" : "invite", message: "MonkeyCode 邀请码" },
    },
  })
  return { policy, preferred, baizhi, monkeycode, optionCalls, codeCalls, setEnabled(value) { current = value } }
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
    baizhiCodes: { "1": "CODE0001", "10": "CODE0010" },
    preferredEnabled: false,
  })
  assert.equal(result.sourceIdentity, "10", "主来源仍是最新百智云账号")
  assert.equal(result.baizhiCode, "CODE0010", "只带最新账号自己那 8 位码")
  assert.notEqual(result.baizhiCode, result.sourceIdentity, "邀请码绝不能被 identity 顶替")
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
      baizhiCodes: { "1": "CODE0001", "10": "CODE0010" },
      preferredEnabled: true,
      selectedIdentity,
    })
    assert.equal(result.sourceIdentity, "10")
    assert.equal(result.baizhiCode, "CODE0010")
    assert.notEqual(result.baizhiCode, "10")
    assert.equal(result.monkeycodeCode, "", `selected=${selectedIdentity} 不得借用 acct-1 的猴码`)
  }

  const preferredOne = resolveInvitePolicy({
    baizhiAccounts: accounts,
    monkeycodeAccounts,
    baizhiCodes: { "1": "CODE0001", "10": "CODE0010" },
    preferredEnabled: true,
    selectedIdentity: "1",
  })
  assert.equal(preferredOne.monkeycodeCode, "mc-one")
  assert.equal(preferredOne.baizhiCode, "CODE0001", "换账号就换码，不许串")
})

test("自邀按主 source identity 跳过：off 的猴码回退也不得重新补入", () => {
  const result = resolveInvitePolicy({
    baizhiAccounts: [bz("1"), bz("10", "latest-no-mc")],
    monkeycodeAccounts: [mc("mc-one", "acct-1")],
    baizhiCodes: { "10": "CODE0010" },
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

test("off 有账号时 ask/prompts 都不出现 select 或文本，authorize({}) 仍能独立生效", async () => {
  const fixture = policyFixture({ enabled: false })
  assert.equal(await fixture.policy.ask({}), null)
  assert.deepEqual(fixture.policy.prompts(), [])
  // ask 现问平台要最新账号（identity 2）的 8 位码；拿不到也照旧返回 null。
  assert.deepEqual(fixture.codeCalls, ["2"])
  const result = fixture.policy.prepare({})()
  assert.equal(result.baizhiCode, "CODE0002")
  assert.notEqual(result.baizhiCode, "2", "identity 不是邀请码")
  assert.equal(result.monkeycodeCode, "mc-two")
  assert.deepEqual(fixture.baizhi.writes, [], "自动账号模式不得写手动百智云码")
  assert.deepEqual(fixture.monkeycode.writes, [], "自动账号模式不得写手动猴码")
  assert.deepEqual(fixture.optionCalls, Array(3).fill(["baizhi", INVITE_PREFERRED_KEY]), "ask / prompts / authorize 每次都现读")
})

test("on 给顶部 select，账号按 identity 去重；具体账号 / latest 后不再问文本", async () => {
  const fixture = policyFixture({
    enabled: true,
    accounts: [bz("1", "one"), bz("2", "two"), bz("2", "duplicate-two")],
    saved: "2",
  })
  const select = await fixture.policy.ask({})
  assert.equal(select.type, "select")
  assert.equal(select.key, "inviteSource")
  assert.equal(select.placement, "top")
  assert.deepEqual(select.options.map((option) => option.value), ["2", INVITE_SOURCE_LATEST, "1", INVITE_SOURCE_MANUAL])
  assert.equal(select.options[0].label.includes("duplicate-two"), false)

  // 宿主的真实顺序：ask(累积 inputs) 一直问到 null，然后 authorize 用**同一份** inputs →
  // prepare 复用最后一次 ask 缓存到的码。所以下面按这个顺序断言（换账号就换码）。
  assert.equal(await fixture.policy.ask({ inviteSource: INVITE_SOURCE_LATEST }), null)
  assert.equal(await fixture.policy.ask({ inviteSource: "1" }), null)
  const resolve = fixture.policy.prepare({ inviteSource: "1" })
  assert.deepEqual(fixture.preferred.writes, ["1"], "authorize 必须记住首选选择")
  assert.equal(resolve().sourceIdentity, "1")
  assert.equal(resolve().baizhiCode, "CODE0001", "所选账号的 8 位码")
  assert.deepEqual(fixture.codeCalls, ["2", "2", "1"], "每次 ask 只问本次邀请源那个账号")
  assert.equal((await fixture.policy.ask({})).options[0].value, "1", "下一次 select 把记住账号放在首位")
})

test("manual 分支仍依次问原有两格，placement top，两码独立解析与落盘", async () => {
  const fixture = policyFixture({ enabled: true })
  const first = await fixture.policy.ask({ inviteSource: INVITE_SOURCE_MANUAL })
  assert.equal(first.type, "text")
  assert.equal(first.key, "invite")
  assert.equal(first.placement, "top")
  const second = await fixture.policy.ask({ inviteSource: INVITE_SOURCE_MANUAL, invite: "NEWBZ001" })
  assert.equal(second.type, "text")
  assert.equal(second.key, "monkeycodeInvite")
  assert.equal(second.placement, "top")
  assert.equal(await fixture.policy.ask({ inviteSource: INVITE_SOURCE_MANUAL, invite: "NEWBZ001", monkeycodeInvite: "new-mc" }), null)
  assert.deepEqual(fixture.codeCalls, [], "manual 分支不许去平台上取码")

  const resolve = fixture.policy.prepare({
    inviteSource: INVITE_SOURCE_MANUAL,
    invite: "NEWBZ001",
    monkeycodeInvite: "new-mc",
  })
  assert.deepEqual(fixture.baizhi.writes, ["NEWBZ001"])
  assert.deepEqual(fixture.monkeycode.writes, ["new-mc"])
  const result = resolve()
  assert.equal(result.mode, "manual")
  assert.equal(result.baizhiCode, "NEWBZ001")
  assert.equal(result.monkeycodeCode, "new-mc")
  assert.deepEqual(fixture.preferred.writes, [INVITE_SOURCE_MANUAL])

  const remembered = fixture.policy.prepare({})()
  assert.equal(remembered.mode, "manual", "记住 manual 后，空 inputs 也不能退回 latest")
  assert.equal(remembered.baizhiCode, "NEWBZ001")
  assert.equal(remembered.monkeycodeCode, "new-mc")
})

test("manual 输入必须是 8 位字母数字：非法长度被丢弃且不落盘，合法 8 位保留", async () => {
  const fixture = policyFixture({ enabled: true })
  // ① 15 位 identity（真机那次红条的来源）：不带、且不写进策略文件。
  const bad = fixture.policy.prepare({ inviteSource: INVITE_SOURCE_MANUAL, invite: "9007199254740993", monkeycodeInvite: "mc-x" })()
  assert.equal(bad.mode, "manual")
  assert.equal(bad.baizhiCode, "", "非法码不许带进 /sign-in?invite_code=")
  assert.equal(bad.monkeycodeCode, "mc-x", "百智云码非法不影响猴码")
  assert.deepEqual(fixture.baizhi.writes, [], "非法码不许落盘（否则下次登录继续弹红条）")

  // ② 长度不对的其它形态同样丢弃。
  for (const invalid of ["AB12CD3", "AB12CD341", "fta-glyd"]) {
    const result = fixture.policy.prepare({ inviteSource: INVITE_SOURCE_MANUAL, invite: invalid })()
    assert.equal(result.baizhiCode, "", `${invalid} 不是 8 位字母数字`)
  }
  assert.deepEqual(fixture.baizhi.writes, [])

  // ③ 合法 8 位保留并落盘。
  const good = fixture.policy.prepare({ inviteSource: INVITE_SOURCE_MANUAL, invite: "AB12CD34" })()
  assert.equal(good.baizhiCode, "AB12CD34")
  assert.deepEqual(fixture.baizhi.writes, ["AB12CD34"])

  // ④ 保底：自动分支的 baizhiCode 也不等于账号 identity、也不超过 8 位。
  await fixture.policy.ask({})
  for (const identity of ["1", "2"]) {
    const auto = fixture.policy.prepare({ inviteSource: identity })()
    assert.equal(auto.sourceIdentity, identity)
    assert.notEqual(auto.baizhiCode, identity)
    assert.ok(auto.baizhiCode.length <= 8)
  }
})

test("平台取码失败 / 抛错 / 非 8 位时静默为空，登录流程照旧", async () => {
  for (const options of [{ inviteCodes: {} }, { codeError: new Error("网络炸了") }, { inviteCodes: { "2": "9007199254740993" } }]) {
    const fixture = policyFixture(options)
    assert.equal(await fixture.policy.ask({}), null, "拿不到码也照旧不问")
    const result = fixture.policy.prepare({})()
    assert.equal(result.baizhiCode, "", "拿不到合法码就不带 invite_code（不报红条）")
    assert.equal(result.mode, "latest")
    assert.equal(result.monkeycodeCode, "mc-two")
  }
})

test("无账号时 off 也有手动兜底：百智云两格、国内站一格，缺一路不清空另一路", async () => {
  const dual = policyFixture({ enabled: false, accounts: [] })
  assert.equal((await dual.policy.ask({})).key, "invite")
  assert.equal((await dual.policy.ask({ invite: "" })).key, "monkeycodeInvite")
  assert.deepEqual(dual.codeCalls, [], "无账号就没有账号可取码")
  const dualResult = dual.policy.prepare({ invite: "ONLYBZ01", monkeycodeInvite: "0" })()
  assert.equal(dualResult.baizhiCode, "ONLYBZ01")
  assert.equal(dualResult.monkeycodeCode, "saved-mc", "0 沿用既有猴码，不被百智云新码覆盖")

  const single = policyFixture({ enabled: false, accounts: [], dualManual: false })
  const prompt = await single.policy.ask({})
  assert.equal(prompt.key, "invite")
  assert.equal(prompt.placement, "top")
  assert.equal(await single.policy.ask({ invite: "only-mc" }), null)
  const singleResult = single.policy.prepare({ invite: "only-mc" })()
  assert.equal(singleResult.baizhiCode, "")
  assert.equal(singleResult.monkeycodeCode, "only-mc")
  assert.deepEqual(single.baizhi.writes, [], "国内站不得触碰百智云手动码")
})

test("prepare 的 targetIdentity 自邀跳过与 provision 使用同一 resolver 快照", async () => {
  const fixture = policyFixture({ enabled: false })
  await fixture.policy.ask({})
  const resolve = fixture.policy.prepare({})
  assert.equal(resolve().monkeycodeCode, "mc-two")
  assert.equal(resolve().baizhiCode, "CODE0002")
  const skipped = resolve("2")
  assert.equal(skipped.mode, "skip")
  assert.equal(skipped.sourceIdentity, "2")
  assert.equal(skipped.baizhiCode, "")
  assert.equal(skipped.monkeycodeCode, "")
})

test("码缓存只活在本次 ask → prepare 之间：上一次的码不许漏到下一次 authorize", async () => {
  const codes = { "2": "CODE0002" }
  const fixture = policyFixture({ enabled: false, inviteCodes: codes })
  await fixture.policy.ask({})
  assert.equal(fixture.policy.prepare({})().baizhiCode, "CODE0002")

  // 平台这次拿不到码：新一次 ask 必须重新取，旧值不许漏过来（否则会拿旧码去邀人）。
  codes["2"] = ""
  await fixture.policy.ask({})
  assert.equal(fixture.policy.prepare({})().baizhiCode, "")
})
