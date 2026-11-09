// src/invite-policy.mjs —— 两个 provider 共用的邀请策略运行时接线。
//
// invite-source.mjs 仍是纯 resolver；本文件只补三件运行时事项：
//   ① 每次操作现读 ctx.magpie.option，异常 / 老宿主一律按 off；
//   ② ask() 的 select → manual 分支、首选选择与两家手动码的本地持久化；
//   ③ 仅 off 时，最新百智云账号没有 MonkeyCode 对应账号，猴码向前找最近一个
//     有唯一精确 accountId 映射的账号；主 source identity 仍然是最新账号。
//
// 所有文件读取都通过注入的 reader / store 完成。本文件不发起网络请求，也不起浏览器。

import { inviteHint, resolveInvite } from "./invite.mjs"
import {
  INVITE_SOURCE_LATEST,
  INVITE_SOURCE_MANUAL,
  buildInviteSourcePrompt,
  findLatestBaizhiAccount,
  resolveInviteSource,
} from "./invite-source.mjs"

export const INVITE_PREFERRED_KEY = "invite_preferred"
export const INVITE_SOURCE_KEY = "inviteSource"

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
  manual = {},
} = {}) {
  const baizhiSpec = manual.baizhi ?? { key: "invite", message: "邀请码（可选）" }
  const monkeycodeSpec = manual.monkeycode ?? { key: "invite", message: "邀请码（可选）" }

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

  /** ask() 的下一问；关闭且有账号时直接 null，无账号才走 manual 兜底。 */
  function ask(inputs = {}) {
    const current = state(inputs)
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

  function prompts() {
    const first = ask({})
    return first === null ? [] : [first]
  }

  function readManualCode(inputs, spec, store) {
    const current = store?.read() ?? ""
    const code = resolveInvite(asked(inputs, spec.key) ? text(inputs[spec.key]) : "", current)
    if (code) store?.write(code, { source: "chosen" })
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
      if (dualManual) manualBaizhiCode = readManualCode(inputs, baizhiSpec, baizhiInviteStore)
      manualMonkeycodeCode = readManualCode(inputs, monkeycodeSpec, monkeycodeInviteStore)
    }

    return function resolve(targetIdentity = "") {
      return resolveInvitePolicy({
        baizhiAccounts: current.baizhiAccounts,
        monkeycodeAccounts: current.monkeycodeAccounts,
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
