// src/invite-policy.mjs —— 两个 provider 共用的邀请策略运行时接线。
//
// invite-source.mjs 仍是纯 resolver；本文件只补四件运行时事项：
//   ① 每次操作现读 ctx.magpie.option，异常 / 老宿主一律按 off；
//   ② ask() 的 select → manual 分支、首选选择与两家手动码的本地持久化；
//   ③ 仅 off 时，最新百智云账号没有 MonkeyCode 对应账号，猴码向前找最近一个
//     有唯一精确 accountId 映射的账号；主 source identity 仍然是最新账号；
//   ④ 百智云邀请码**不再拿账号 identity 顶替**：ask() 现问平台要 8 位码
//     （注入的 readAccountInviteCode），缓存在本次 prepare 的作用域里。
//
// 所有文件读取都通过注入的 reader / store 完成。本文件不自己发起网络请求，也不起浏览器。
// 百智云那 8 位码由 runtime 注入的 `readAccountInviteCode` 取回（本文件只负责缓存与透传）。

import { inviteHint, resolveInvite } from "./invite.mjs"
import {
  INVITE_SOURCE_LATEST,
  INVITE_SOURCE_MANUAL,
  buildInviteSourcePrompt,
  findLatestBaizhiAccount,
  pickInviteSourceAccount,
  resolveInviteSource,
} from "./invite-source.mjs"

export const INVITE_PREFERRED_KEY = "invite_preferred"
export const INVITE_SOURCE_KEY = "inviteSource"

/**
 * 百智云邀请码的公开形态：8 位字母数字（`GET /api/v1/user/invite-code` 的 `data.invite_code`）。
 *
 * 手输那一格也必须过这一关：用户很可能把账号 identity（15 位 `user.id`）粘进来，
 * 带上去就是控制台那条 `invite_code length must be 8` 红条。不合法 ⇒ **不带**（空串），
 * 让人先登进去比让红条挡住登录重要。
 */
const BAIZHI_INVITE_CODE = /^[A-Za-z0-9]{8}$/

/** 只有 8 位字母数字才算邀请码；其余（含 identity、空、超长）一律空串。 */
function inviteCodeOf(value) {
  const code = text(value)
  return BAIZHI_INVITE_CODE.test(code) ? code : ""
}

/** magpie auth.options 的布尔开关声明；国际站不要引用这项。 */
export const INVITE_PREFERRED_OPTION = Object.freeze({
  key: INVITE_PREFERRED_KEY,
  label: "首选账号作为邀请源",
  description: "关闭：自动使用最新注册账号滚动邀请；开启：登录时选择最新账号、指定账号或手动邀请码，并记住选择。",
  default: false,
  placement: "top",
})

function text(value) {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value === "bigint") return String(value)
  return ""
}

function asked(inputs, key) {
  return inputs !== null && typeof inputs === "object"
    && Object.prototype.hasOwnProperty.call(inputs, key)
}

function recordsOf(value) {
  if (Array.isArray(value)) return value
  if (value !== null && typeof value === "object" && Array.isArray(value.accounts)) return value.accounts
  return []
}

/** 实时读取开关；不缓存，缺失 API、返回非 true 或抛错都按 off。 */
export function readInvitePreferred(ctx, provider) {
  try {
    return ctx?.magpie?.option?.(provider, INVITE_PREFERRED_KEY) === true
  } catch {
    return false
  }
}

/**
 * 在既有 resolver 上补运行时两条边界，不改变 src/invite-source.mjs 的既有 API。
 *
 * - preferred on 且显式选 manual：两家手动码分别兜底，不能退而使用最新账号；
 * - 仅 preferred off 的 latest：主账号缺猴码时向前找最近一个可安全映射的猴账号。
 *
 * `baizhiCodes`（identity → 8 位码）原样透传给 resolver：它只由本次 prepare 的缓存填。
 */
export function resolveInvitePolicy(input = {}) {
  const manualSelected = input.preferredEnabled === true
    && text(input.selectedIdentity ?? input.savedIdentity) === INVITE_SOURCE_MANUAL
  const result = resolveInviteSource({
    ...input,
    // 手动是明确分支，不是「无效 identity → latest」。无账号时本来就已是这个形状。
    baizhiAccounts: manualSelected ? [] : input.baizhiAccounts,
  })

  if (manualSelected) {
    return result.mode === "skip"
      ? result
      : { ...result, mode: "manual", reason: "selected-manual-invite" }
  }

  // preferred on（包括用户选 latest）绝不借用别的账号；自邀 skip 也不能再补回猴码。
  if (input.preferredEnabled === true || result.mode !== "latest" || result.monkeycodeCode) return result

  const remaining = [...recordsOf(input.baizhiAccounts)]
  while (remaining.length > 0) {
    const latest = findLatestBaizhiAccount(remaining)
    if (latest === undefined) break
    // 单账号 resolver 复用同一套数值排序 / 精确 accountId / 重名拒绝规则。
    const linked = resolveInviteSource({
      baizhiAccounts: [latest],
      monkeycodeAccounts: input.monkeycodeAccounts,
      preferredEnabled: false,
    })
    if (linked.monkeycodeCode) {
      // 只替换猴码：sourceIdentity / baizhiCode / mode / reason 仍属于最新主账号。
      return { ...result, monkeycodeCode: linked.monkeycodeCode }
    }
    remaining.splice(remaining.indexOf(latest), 1)
  }
  return result
}

function readAccounts(read) {
  try {
    return read()
  } catch {
    return []
  }
}

function manualPrompt(spec, store) {
  return {
    type: "text",
    key: spec.key,
    message: spec.message,
    placeholder: inviteHint(store?.read() ?? ""),
    placement: "top",
  }
}

/**
 * 创建一个 provider 的本地邀请交互。readers / stores 全部由 runtime 注入，测试可用内存替身。
 *
 * dualManual=true（百智云浏览器）：manual 下依次问 invite + monkeycodeInvite；
 * dualManual=false（国内站 SSO）：manual 下只问 invite，它对应 monkeycodeInviteStore。
 *
 * `readAccountInviteCode(account) => Promise<string>` 是百智云那 8 位邀请码的唯一来源
 * （runtime 注入 `fetchInviteCode`；拿不到 / 失败一律返回空串）。默认 `() => ""`，
 * 所以不注入它的老调用方（国内站）行为完全不变：永远不带百智云码。
 *
 * prepare(inputs) 会写回有效的首选选择与手动码，并返回 resolve(targetIdentity)。
 * resolve 在这次 authorize 内复用同一份策略快照，保证 URL 与 provision 不各选各的；
 * 下一次 ask / authorize 会重新读取开关与账号，不在工厂级缓存。
 */
export function createInvitePolicy({
  ctx = {},
  provider,
  dualManual = false,
  preferredStore,
  baizhiInviteStore,
  monkeycodeInviteStore,
  readBaizhiAccounts = () => [],
  readMonkeycodeAccounts = () => [],
  readAccountInviteCode = () => "",
  manual = {},
} = {}) {
  const baizhiSpec = manual.baizhi ?? { key: "invite", message: "邀请码（可选）" }
  const monkeycodeSpec = manual.monkeycode ?? { key: "invite", message: "邀请码（可选）" }

  /**
   * 本次「ask → prepare」这一段里缓存到的 8 位码（identity → code）。
   *
   * 每次 ask 重新开一份：`prepare()` 是同步的，不能自己发网络，所以码必须在
   * ask 时取好；而 `baizhiCodes` 只放**这一次**缓存到的值 —— 旧值绝不能漏到
   * 另一次 authorize 上（那会拿 A 号的码去邀 B 号）。
   */
  let capturedCodes = new Map()

  function state(inputs = {}) {
    const preferredEnabled = readInvitePreferred(ctx, provider)
    const baizhiAccounts = recordsOf(readAccounts(readBaizhiAccounts))
    const monkeycodeAccounts = readAccounts(readMonkeycodeAccounts)
    const savedIdentity = text(preferredStore?.read())
    const selectedIdentity = asked(inputs, INVITE_SOURCE_KEY)
      ? text(inputs[INVITE_SOURCE_KEY])
      : undefined
    const selection = text(selectedIdentity ?? savedIdentity)
    const sourcePrompt = buildInviteSourcePrompt({
      baizhiAccounts,
      preferredEnabled,
      selectedIdentity,
      savedIdentity,
      key: INVITE_SOURCE_KEY,
    })
    const hasAccounts = sourcePrompt.type === "select"
    const manualMode = !hasAccounts || (preferredEnabled && selection === INVITE_SOURCE_MANUAL)
    return {
      preferredEnabled,
      baizhiAccounts,
      monkeycodeAccounts,
      savedIdentity,
      selectedIdentity,
      selection,
      sourcePrompt,
      hasAccounts,
      manualMode,
    }
  }

  /**
   * 取本次邀请源账号的 8 位码并缓存。**永不抛错**：邀请码是可选加成，
   * 取不到就是空串（登录照常，URL 保持裸地址）。
   */
  async function captureInviteCode(current) {
    capturedCodes = new Map()
    if (current.manualMode || !current.hasAccounts) return
    const account = pickInviteSourceAccount({
      baizhiAccounts: current.baizhiAccounts,
      preferredEnabled: current.preferredEnabled,
      selectedIdentity: current.selectedIdentity,
      savedIdentity: current.savedIdentity,
    })
    if (account === undefined) return
    const identity = text(account?.identity)
    if (identity.length === 0) return
    let code = ""
    try {
      code = inviteCodeOf(await readAccountInviteCode(account))
    } catch {
      code = ""
    }
    if (code.length > 0) capturedCodes.set(identity, code)
  }

  /** ask() 的下一问（同步）；关闭且有账号时直接 null，无账号才走 manual 兜底。 */
  function nextPrompt(inputs, current) {
    if (current.preferredEnabled && current.hasAccounts && !asked(inputs, INVITE_SOURCE_KEY)) {
      return current.sourcePrompt
    }
    if (!current.manualMode) return null

    if (dualManual) {
      if (!asked(inputs, baizhiSpec.key)) return manualPrompt(baizhiSpec, baizhiInviteStore)
      if (!asked(inputs, monkeycodeSpec.key)) return manualPrompt(monkeycodeSpec, monkeycodeInviteStore)
      return null
    }
    if (!asked(inputs, monkeycodeSpec.key)) return manualPrompt(monkeycodeSpec, monkeycodeInviteStore)
    return null
  }

  /**
   * 下一个问题（async：先取邀请码，再照原样决定问什么）。
   *
   * 取码只在「非 manual 且有选中账号」时发生 —— 拿不到码也继续原有流程
   * （有账号且 off → null；preferred → select），绝不因为邀请码挡住登录。
   */
  async function ask(inputs = {}) {
    const current = state(inputs)
    await captureInviteCode(current)
    return nextPrompt(inputs, current)
  }

  /** 面板列表用的静态第一问：读取不能 await（getter），也不该只是为了显示就去打上游。 */
  function prompts() {
    const first = nextPrompt({}, state({}))
    return first === null ? [] : [first]
  }

  function readManualCode(inputs, spec, store) {
    const current = store?.read() ?? ""
    return resolveInvite(asked(inputs, spec.key) ? text(inputs[spec.key]) : "", current)
  }

  /** 手动猴码：原样（`0`/`1`/空 = 沿用），有效就落盘。 */
  function readManualMonkeycodeCode(inputs) {
    const code = readManualCode(inputs, monkeycodeSpec, monkeycodeInviteStore)
    if (code) monkeycodeInviteStore?.write(code, { source: "chosen" })
    return code
  }

  /**
   * 手动百智云码：必须先过 8 位字母数字。
   *
   * 不合法（典型：用户把账号 identity 粘进来）就**不带**且**不落盘** —— 落盘只会让
   * 下一次登录继续读到坏码、继续弹 `invite_code length must be 8` 红条。
   */
  function readManualBaizhiCode(inputs) {
    const code = inviteCodeOf(readManualCode(inputs, baizhiSpec, baizhiInviteStore))
    if (code) baizhiInviteStore?.write(code, { source: "chosen" })
    return code
  }

  function prepare(inputs = {}) {
    const current = state(inputs)

    if (current.preferredEnabled && current.hasAccounts && asked(inputs, INVITE_SOURCE_KEY)) {
      const choice = text(inputs[INVITE_SOURCE_KEY])
      const valid = current.sourcePrompt.options.some((option) => option.value === choice)
      if (valid) preferredStore?.write(choice, { source: "chosen" })
    }

    let manualBaizhiCode = ""
    let manualMonkeycodeCode = ""
    if (current.manualMode) {
      if (dualManual) manualBaizhiCode = readManualBaizhiCode(inputs)
      manualMonkeycodeCode = readManualMonkeycodeCode(inputs)
    }

    // 只放这次 ask 缓存到的值：另一条账号的旧码不许漏进来。
    const baizhiCodes = new Map(capturedCodes)

    return function resolve(targetIdentity = "") {
      return resolveInvitePolicy({
        baizhiAccounts: current.baizhiAccounts,
        monkeycodeAccounts: current.monkeycodeAccounts,
        baizhiCodes,
        preferredEnabled: current.preferredEnabled,
        selectedIdentity: current.selectedIdentity,
        savedIdentity: current.savedIdentity,
        manualBaizhiCode,
        manualMonkeycodeCode,
        targetIdentity,
      })
    }
  }

  return { ask, prompts, prepare }
}

export { INVITE_SOURCE_LATEST, INVITE_SOURCE_MANUAL }
