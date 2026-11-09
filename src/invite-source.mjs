// src/invite-source.mjs —— 从调用方给的账号记录推导邀请来源。
//
// 边界：本文件没有 I/O、没有 HOME / 网络访问，也不写 inviteStore。账号数组、
// 首选记忆、百智云码表和手动邀请码全部由调用方注入；inviteStore.extra 的读写由 runtime 负责。
//
// 两家码不能混用，而且**两家的码不是同一种东西**：
// - 百智云 `invite_code` 是平台单独下发的 **8 位字母数字码**，来自
//   `GET /api/v1/user/invite-code` 的 `data.invite_code`（2026-11-09 实测 `AB12CD34`）——
//   **不是**账号 identity（`user.id`，15 位数字）。拿 identity 当码会拼出
//   `/sign-in?invite_code=<user.id>`，控制台当场弹红条 `invite_code length must be 8`。
//   所以本文件只认注入进来的 `baizhiCodes`（identity → 8 位码）；没注入就是空串。
// - MonkeyCode `inviter_id` = 唯一精确匹配账号的 `uid`。
// 邀请只在注册时生效，已注册不能补邀。

export const INVITE_SOURCE_LATEST = "latest"
export const INVITE_SOURCE_MANUAL = "manual"

/**
 * 百智云邀请码的公开形态：8 位字母数字（实测 `AB12CD34`）。
 *
 * 这里是**保底闸**：任何来源（注入的码表 / 用户手输 / 老调用方）的值都要过这一关，
 * 所以 baizhiCode 在结构上不可能等于 15 位 identity，也不可能超过 8 位。
 */
const BAIZHI_INVITE_CODE = /^[A-Za-z0-9]{8}$/

/** 只有 8 位字母数字才是邀请码；其余（含 identity、空、超长）一律当「没有码」。 */
function inviteCodeOf(value) {
  const code = text(value)
  return BAIZHI_INVITE_CODE.test(code) ? code : ""
}

const AUTO_LABEL = "最新注册账号（自动）"
const MANUAL_LABEL = "手动输入邀请码"

/** 同时接受 readBaizhiSessions 的数组和 readProvisionedAccounts 的 { accounts }。 */
function recordsOf(value) {
  if (Array.isArray(value)) return value
  if (value !== null && typeof value === "object" && Array.isArray(value.accounts)) return value.accounts
  return []
}

/** identity / uid / 手动码统一成可放入 URL 的字符串；对象和无效数字不当身份。 */
function text(value) {
  if (typeof value === "string") return value.trim()
  if (typeof value === "bigint") return String(value)
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return ""
}

function identityOf(account) {
  return text(account?.identity)
}

/** accountId 匹配保持逐字精确：不折行、不忽略大小写、不猜昵称。 */
function rawAccountIdOf(account) {
  return typeof account?.accountId === "string" ? account.accountId : ""
}

function usableBaizhiAccounts(value) {
  return recordsOf(value).filter((account) => identityOf(account).length > 0)
}

/**
 * 从调用方注入的码表里取某个 identity 的 8 位码。
 *
 * `baizhiCodes` 同时接受对象（`{ [identity]: code }`）与 `Map` —— runtime 用 Map、
 * 测试与 JSON 场景用对象，两种都要能用。取不到 / 形态不对一律空串。
 */
function codeFor(baizhiCodes, identity) {
  if (identity.length === 0) return ""
  if (baizhiCodes instanceof Map) return inviteCodeOf(baizhiCodes.get(identity))
  if (baizhiCodes !== null && typeof baizhiCodes === "object") {
    return inviteCodeOf(Object.prototype.hasOwnProperty.call(baizhiCodes, identity) ? baizhiCodes[identity] : "")
  }
  return ""
}

/**
 * 数值 identity 用 BigInt 取最大值；一个数值 identity 都没有时才退回添加顺序末尾。
 * 相等时保留先添加的那条，避免同一 identity 的账号来源在重复调用间跳动。
 */
function latestSelection(value) {
  const accounts = usableBaizhiAccounts(value)
  let selected
  let selectedNumber
  for (const account of accounts) {
    const identity = identityOf(account)
    if (!/^\d+$/.test(identity)) continue
    const number = BigInt(identity)
    if (selected === undefined || number > selectedNumber) {
      selected = account
      selectedNumber = number
    }
  }
  if (selected !== undefined) return { account: selected, numeric: true }
  return { account: accounts.at(-1), numeric: false }
}

/** 导出给只需要账号、不需要邀请码映射的调用方。 */
export function findLatestBaizhiAccount(baizhiAccounts = []) {
  return latestSelection(baizhiAccounts).account
}

/**
 * 本次会作为邀请源的那个账号（与 `resolveInviteSource` 的选取顺序逐条一致）：
 * preferred 命中已记住 / 已选的 identity 就用它，否则用最新账号。无账号返回 undefined。
 *
 * 单独导出是给 `src/invite-policy.mjs` 的 `ask()` 用的：它要拿这个账号去平台取
 * 8 位邀请码，而「哪个账号」的规则必须与后面 `resolve()` 选出来的那个**是同一个**，
 * 否则会去问 A 号要码、却拿 B 号当邀请源。
 */
export function pickInviteSourceAccount({
  baizhiAccounts = [],
  preferredEnabled = false,
  selectedIdentity,
  savedIdentity,
} = {}) {
  const accounts = usableBaizhiAccounts(baizhiAccounts)
  if (accounts.length === 0) return undefined
  if (preferredEnabled === true) {
    const candidate = text(selectedIdentity ?? savedIdentity)
    const preferred = candidate.length > 0
      ? accounts.find((account) => identityOf(account) === candidate)
      : undefined
    if (preferred !== undefined) return preferred
  }
  return latestSelection(baizhiAccounts).account
}

function sourceForAccount(account, monkeycodeAccounts, mode, reason, baizhiCodes) {
  const sourceIdentity = identityOf(account)
  const accountId = rawAccountIdOf(account)
  // 重名即无法确定是哪条 MonkeyCode 记录；即使其中只有一条有 uid，也不能猜。
  const matches = accountId.trim().length > 0
    ? recordsOf(monkeycodeAccounts).filter((candidate) => rawAccountIdOf(candidate) === accountId)
    : []
  const monkeycodeCode = matches.length === 1 ? text(matches[0]?.uid) : ""
  return {
    sourceIdentity,
    // 百智云码只能来自平台下发的 8 位码（identity → 码的注入表）；**绝不是 identity 本身**。
    baizhiCode: codeFor(baizhiCodes, sourceIdentity),
    monkeycodeCode,
    mode,
    reason,
  }
}

function latestSource(baizhiAccounts, monkeycodeAccounts, reason = "", baizhiCodes) {
  const latest = latestSelection(baizhiAccounts)
  if (latest.account === undefined) {
    return {
      sourceIdentity: "",
      baizhiCode: "",
      monkeycodeCode: "",
      mode: "none",
      reason: "no-baizhi-accounts",
    }
  }
  return sourceForAccount(
    latest.account,
    monkeycodeAccounts,
    "latest",
    reason || (latest.numeric ? "latest-numeric-identity" : "latest-addition-order"),
    baizhiCodes,
  )
}

/**
 * 推导最新注册账号的两家邀请码；无账号时返回 mode=none。
 *
 * `baizhiCodes` 是 identity → 8 位邀请码的映射（对象或 Map，可选）：
 * 拿不到码时 `baizhiCode` 就是空串 —— 空串会让登录 URL 保持裸地址，不弹红条。
 */
export function deriveLatestInviteSource({ baizhiAccounts = [], monkeycodeAccounts = [], baizhiCodes } = {}) {
  return latestSource(baizhiAccounts, monkeycodeAccounts, "", baizhiCodes)
}

function accountOptions(baizhiAccounts) {
  const seen = new Set()
  const options = []
  for (const account of usableBaizhiAccounts(baizhiAccounts)) {
    const identity = identityOf(account)
    if (seen.has(identity)) continue
    seen.add(identity)
    const accountId = rawAccountIdOf(account).trim()
    options.push({
      label: accountId
        ? `${accountId}（百智云 identity: ${identity}）`
        : `百智云账号（identity: ${identity}）`,
      value: identity,
    })
  }
  return options
}

function orderedOptions(accounts, { preferredEnabled, selectedIdentity, savedIdentity }) {
  const automatic = { label: AUTO_LABEL, value: INVITE_SOURCE_LATEST }
  const manual = { label: MANUAL_LABEL, value: INVITE_SOURCE_MANUAL }
  if (preferredEnabled !== true) return [automatic, ...accounts, manual]

  // 与 resolveInviteSource 完全同一个 ?? 规则：显式空值不会越过去读 savedIdentity。
  const remembered = text(selectedIdentity ?? savedIdentity)
  const preferred = accounts.find((option) => option.value === remembered)
  if (preferred === undefined) return [automatic, ...accounts, manual]
  return [preferred, automatic, ...accounts.filter((option) => option !== preferred), manual]
}

/**
 * 生成账号 select 的选项。首选模式把已记住 identity 的同一项移到首位，不复制内容。
 * value 只有账号项使用 identity；自动 / 手动使用上面导出的两个常量。
 */
export function buildInviteSourceOptions({
  baizhiAccounts = [],
  preferredEnabled = false,
  selectedIdentity,
  savedIdentity,
} = {}) {
  return orderedOptions(accountOptions(baizhiAccounts), {
    preferredEnabled,
    selectedIdentity,
    savedIdentity,
  })
}

/**
 * 构造可直接由 ask() 返回的 prompt。placement:"top" 是 magpie 0.1.3371 的宿主契约，
 * 不是 top:true。无可选账号时降级为手动输入提示，绝不返回 options 为空的 select。
 */
export function buildInviteSourcePrompt({
  baizhiAccounts = [],
  preferredEnabled = false,
  selectedIdentity,
  savedIdentity,
  key = "inviteSource",
  message = "邀请来源",
} = {}) {
  const accounts = accountOptions(baizhiAccounts)
  if (accounts.length === 0) {
    return {
      type: "text",
      key,
      message: MANUAL_LABEL,
      placeholder: "暂无可选账号，请分别手动输入百智云 invite_code 与 MonkeyCode inviter_id；已注册账号不能补邀。",
      placement: "top",
    }
  }
  return {
    type: "select",
    key,
    message,
    options: orderedOptions(accounts, { preferredEnabled, selectedIdentity, savedIdentity }),
    placement: "top",
  }
}

/**
 * 解析最终邀请策略。
 *
 * mode: latest / preferred / manual / skip（deriveLatestInviteSource 另可能返回 none）。
 * reason 是稳定的机器可读原因，便于 runtime 记录日志而不必解析展示文案。
 * 无账号时 sourceIdentity 就是用户手输的那串（逐字保留，自邀判据照旧）；
 * `baizhiCode` 则只保留 8 位字母数字形态 —— 手输的是 identity（15 位）就**不带**，
 * 免得把 `invite_code length must be 8` 的红条带到登录页上。
 * 因此 targetIdentity 与手输串相同也会跳过，避免手动码自邀。
 */
export function resolveInviteSource({
  baizhiAccounts = [],
  monkeycodeAccounts = [],
  baizhiCodes,
  preferredEnabled = false,
  selectedIdentity,
  savedIdentity,
  manualBaizhiCode = "",
  manualMonkeycodeCode = "",
  targetIdentity = "",
} = {}) {
  let result
  if (usableBaizhiAccounts(baizhiAccounts).length === 0) {
    const manual = text(manualBaizhiCode)
    result = {
      sourceIdentity: manual,
      baizhiCode: inviteCodeOf(manual),
      monkeycodeCode: text(manualMonkeycodeCode),
      mode: "manual",
      reason: "no-baizhi-accounts-manual-fallback",
    }
  } else if (preferredEnabled === true) {
    const explicit = selectedIdentity !== null && selectedIdentity !== undefined
    const candidate = text(selectedIdentity ?? savedIdentity)
    const preferred = candidate.length > 0
      ? usableBaizhiAccounts(baizhiAccounts).find((account) => identityOf(account) === candidate)
      : undefined
    if (preferred !== undefined) {
      result = sourceForAccount(
        preferred,
        monkeycodeAccounts,
        "preferred",
        explicit ? "preferred-selected-identity" : "preferred-saved-identity",
        baizhiCodes,
      )
    } else {
      result = latestSource(
        baizhiAccounts,
        monkeycodeAccounts,
        candidate.length > 0 ? "preferred-invalid-fallback-latest" : "preferred-empty-fallback-latest",
        baizhiCodes,
      )
    }
  } else {
    result = latestSource(baizhiAccounts, monkeycodeAccounts, "", baizhiCodes)
  }

  if (text(targetIdentity).length > 0 && text(targetIdentity) === result.sourceIdentity) {
    return {
      ...result,
      baizhiCode: "",
      monkeycodeCode: "",
      mode: "skip",
      reason: "self-invite",
    }
  }
  return result
}
