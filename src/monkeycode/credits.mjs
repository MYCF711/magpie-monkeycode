// MonkeyCode 平台接口：网页会话换网关凭据、额度、订阅、签到（含 PoW 验证题）。
//
// 平台站（`platformBaseUrl`）只认**网页登录态 Cookie**（`monkeycode_ai_session`，
// HttpOnly，用户自己在浏览器里读不到），不认网关 API Key。所以：
// - 登录时用 Cookie 换一对 `oma_…` + `signing_secret`；
// - 额度 / 积分 / 签到只能带 Cookie 查。
// 没 Cookie 时推理照常，只是查不到额度、签不了到 —— 必须优雅降级。
//
// 全部接口都套 `{ code, data, message }` 信封：只有明确给了 `code` 且不为 0
// 才判业务失败（有的端点直接回裸对象）。

import { createHash } from "node:crypto"

/** 签到验证题的求解次数上限（防上游形态变化导致死循环）。 */
const MAX_POW_ATTEMPTS_PER_QUESTION = 20_000_000

/** 一次签到的总尝试预算（所有题合计）。现网实测 c=50/s=32/d=3 约 0.2s。 */
const MAX_POW_ATTEMPTS_TOTAL = 5_000_000

/** 订阅档位只认这三个值，其余一律当「档位未知」（不猜）。 */
export const PLAN_LABELS = Object.freeze({ basic: "Basic", pro: "Pro", ultra: "Ultra" })

/** 每日额度的档位 → 计费 token 上限。 */
export const PLAN_DAILY_LIMIT = Object.freeze({ basic: 10_000_000, pro: 100_000_000, ultra: 300_000_000 })

/**
 * 把用户可能粘贴的 cookie 串归一成可以直接放进 `Cookie` 头的值。
 *
 * 接受：完整 cookie 串（`a=1; b=2`）、裸值（补上 cookie 名）、带 `cookie:` 前缀的复制品。
 */
export function normalizeCookie(raw, cookieName) {
  if (typeof raw !== "string") return undefined
  let text = raw.trim()
  if (text.length === 0) return undefined
  text = text.replace(/^cookie\s*:\s*/i, "").trim()
  if (text.length === 0) return undefined
  if (/^[A-Za-z_][A-Za-z0-9_.-]*=/.test(text)) return text
  const value = text.replace(/[\r\n]/g, "").trim()
  return value.length === 0 ? undefined : `${cookieName}=${value}`
}

/** 从凭据里取归一化后的 cookie；没有则 undefined。 */
export function cookieOf(credential, cookieName) {
  if (!credential) return undefined
  const raw = credential.session_cookie
  if (typeof raw !== "string") return undefined
  return normalizeCookie(raw, cookieName)
}

/**
 * 平台 REST 请求头。
 *
 * 带 referer / user-agent 只是「尽量与网页同形」的保守选择 —— 平台是普通
 * SPA + REST，没有证据表明它强制校验这两项；但缺失时被边缘 WAF 拦掉的概率更高，
 * 而签到是写操作，失败一次就少一天的量。
 */
export function platformHeaders(cookie, platformBaseUrl) {
  return {
    cookie,
    accept: "application/json",
    referer: `${platformBaseUrl}/`,
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      + "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  }
}

/** 把 HTTP 失败翻译成能行动的中文原因。401/403 单独成句（Cookie 过期）。 */
export function describeFailure(status, text) {
  const excerpt = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
  const suffix = excerpt.length === 0 ? "" : `：${excerpt}`
  if (status === 401 || status === 403) {
    return `网页登录态未生效（HTTP ${status}）—— 平台接口只认已登录的会话，`
      + "请确认浏览器窗口里已经完成登录"
  }
  return `平台接口返回 HTTP ${status}${suffix}`
}

/** 该失败是「会话还没生效」（401/403），而不是真的出错。 */
export function isSessionExpiredError(message) {
  return /HTTP 40[13]/.test(String(message ?? "")) || String(message ?? "").includes("网页登录态未生效")
}

/** 从 `{ code, data, message }` 信封里取 `data`。 */
export function unwrapEnvelope(data) {
  if (data === null || typeof data !== "object") {
    return { ok: false, error: "平台接口返回的报文不是对象（上游形态可能已变）" }
  }
  if (typeof data.code === "number" && data.code !== 0) {
    const message = typeof data.message === "string" && data.message.trim().length > 0
      ? data.message.trim()
      : `业务码 ${data.code}`
    return { ok: false, error: `平台接口拒绝：${message}` }
  }
  const value = data.data !== undefined ? data.data : data
  if (value === null || typeof value !== "object") {
    return { ok: false, error: "平台接口返回的 data 不是对象（上游形态可能已变）" }
  }
  return { ok: true, value }
}

/**
 * 发一个平台请求并把响应体读成 JSON。
 *
 * 「200 + HTML」是本仓记录过的假 200 形态（SPA catch-all 路由）：
 * 若把原文当成功传下去，上层会以为是报文变形，排查方向直接跑偏。
 */
export async function platformRequest(cookie, url, { method = "GET", body, timeoutMs = 10_000, fetchImpl = fetch } = {}) {
  const headers = platformHeaders(cookie, new URL(url).origin)
  if (body !== undefined) headers["content-type"] = "application/json"
  let response
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, status: 0, error: `平台接口请求失败：${reason}` }
  }
  const text = await response.text().catch(() => "")
  if (!response.ok) {
    return { ok: false, status: response.status, error: describeFailure(response.status, text) }
  }
  if (text.trim().length === 0) return { ok: true, data: undefined }
  try {
    return { ok: true, data: JSON.parse(text) }
  } catch {
    return {
      ok: false,
      status: response.status,
      error: "平台接口返回了非 JSON 响应（HTTP 200，可能是会话失效被重定向到登录页）："
        + `${text.replace(/\s+/g, " ").trim().slice(0, 120)}`,
    }
  }
}

function readNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * 用网页会话 cookie 换一对网关凭据。
 *
 * 上游：`POST /api/v1/users/ohmyagent/api-keys`（body `{}`，Cookie 认证），
 * 成功回 `{ id, api_key, signing_secret, created_at }`。
 *
 * ⚠ 返回里的 `id` 是「这把 Key 的记录 id」，**不是平台用户 id** —— 同一账号
 * 每次兑换都会变。稳定的 `user_id` 必须走 fetchProfile。
 *
 * ⚠ 兑换每次都签发新的一对（上游没有幂等键），只在登录流程里调一次。
 */
export async function exchangeSessionForKey(cookie, site, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const normalized = normalizeCookie(cookie, site.sessionCookie)
  if (normalized === undefined) return { ok: false, error: "未提供网页会话 cookie" }
  const response = await platformRequest(
    normalized,
    `${site.platformBaseUrl}/api/v1/users/ohmyagent/api-keys`,
    { method: "POST", body: {}, fetchImpl, timeoutMs },
  )
  if (!response.ok) return { ok: false, error: response.error }
  const unwrapped = unwrapEnvelope(response.data)
  if (!unwrapped.ok) return { ok: false, error: unwrapped.error }
  const readText = (value) => (typeof value === "string" ? value.trim() : "")
  const apiKey = readText(unwrapped.value.api_key)
  const signingSecret = readText(unwrapped.value.signing_secret)
  if (apiKey.length === 0 || signingSecret.length === 0) {
    return { ok: false, error: "平台未返回 api_key / signing_secret（上游形态可能已变）" }
  }
  return { ok: true, apiKey, signingSecret }
}

/**
 * 读平台用户资料：`GET /api/v1/users/status` → `data.user.{id,nickname}`。
 *
 * ⚠ 这是**稳定账号身份**的唯一来源（浏览器登录判重靠它）。失败不抛错：
 * 调用方拿到 undefined 时按「身份未知」处理，不能让一次辅助读数把登录判死。
 */
export async function fetchProfile(cookie, site, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const normalized = normalizeCookie(cookie, site.sessionCookie)
  if (normalized === undefined) return undefined
  const response = await platformRequest(
    normalized,
    `${site.platformBaseUrl}/api/v1/users/status`,
    { method: "GET", fetchImpl, timeoutMs },
  )
  if (!response.ok) return undefined
  const unwrapped = unwrapEnvelope(response.data)
  if (!unwrapped.ok) return undefined
  const user = unwrapped.value.user
  if (user === null || typeof user !== "object") return {}
  const userId = typeof user.id === "string" && user.id.trim().length > 0 ? user.id.trim() : undefined
  const nickname = typeof user.nickname === "string" && user.nickname.trim().length > 0 ? user.nickname.trim() : undefined
  return {
    ...(userId === undefined ? {} : { userId }),
    ...(nickname === undefined ? {} : { nickname }),
  }
}

/**
 * 读钱包：`GET /api/v1/users/wallet`。
 *
 * 单位是**千分之一积分**（网页前端 /1000 显示）。`balance` 缺失必须判失败，
 * 不得回落成 0 —— 0 的语义是「已用光」。
 */
export async function fetchWallet(cookie, site, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const normalized = normalizeCookie(cookie, site.sessionCookie)
  if (normalized === undefined) {
    return { ok: false, error: "未配置会话（session_cookie）—— 余额 / 额度 / 签到接口只认网页登录态，请用「浏览器登录」添加账号" }
  }
  const response = await platformRequest(
    normalized,
    `${site.platformBaseUrl}/api/v1/users/wallet`,
    { method: "GET", fetchImpl, timeoutMs },
  )
  if (!response.ok) return { ok: false, error: response.error }
  const unwrapped = unwrapEnvelope(response.data)
  if (!unwrapped.ok) return { ok: false, error: unwrapped.error }
  const raw = unwrapped.value
  const milli = readNumber(raw.balance)
  if (milli === undefined) return { ok: false, error: "钱包报文里没有 balance 字段（上游形态可能已变）" }
  const dailyTokenBalance = readNumber(raw.daily_token_balance)
  const dailyTokenLimit = readNumber(raw.daily_token_limit)
  return {
    ok: true,
    balance: Math.round(milli) / 1000,
    ...(dailyTokenBalance === undefined ? {} : { dailyTokenBalance }),
    ...(dailyTokenLimit === undefined ? {} : { dailyTokenLimit }),
  }
}

/** 读订阅档位：`GET /api/v1/users/subscription`。辅助读数，失败返回 undefined。 */
export async function fetchPlan(cookie, site, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const normalized = normalizeCookie(cookie, site.sessionCookie)
  if (normalized === undefined) return undefined
  const response = await platformRequest(
    normalized,
    `${site.platformBaseUrl}/api/v1/users/subscription`,
    { method: "GET", fetchImpl, timeoutMs },
  )
  if (!response.ok) return undefined
  const unwrapped = unwrapEnvelope(response.data)
  if (!unwrapped.ok) return undefined
  const plan = typeof unwrapped.value.plan === "string" ? unwrapped.value.plan.trim().toLowerCase() : ""
  return plan === "basic" || plan === "pro" || plan === "ultra" ? plan : undefined
}

/**
 * 读签到状态：`GET /api/v1/users/wallet/checkin` → `{ checked_in: boolean }`。
 *
 * 上游只给一个布尔，没有连续天数、没有奖励金额、没有活动期 —— 不编造。
 */
export async function fetchCheckinStatus(cookie, site, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const normalized = normalizeCookie(cookie, site.sessionCookie)
  if (normalized === undefined) return null
  const response = await platformRequest(
    normalized,
    `${site.platformBaseUrl}/api/v1/users/wallet/checkin`,
    { method: "GET", fetchImpl, timeoutMs },
  )
  if (!response.ok) return null
  const unwrapped = unwrapEnvelope(response.data)
  if (!unwrapped.ok) return null
  return { todayCheckedIn: unwrapped.value.checked_in === true }
}

// ── PoW 验证题 ────────────────────────────────────────────────────────

/** FNV-1a 32 位。 */
function fnv1a32(data) {
  let hash = 2166136261
  for (let index = 0; index < data.length; index += 1) {
    hash ^= data.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash >>> 0
}

/**
 * 由 seed 派生 `length` 位十六进制串（平台的 xorshift32 变体）。
 *
 * 每轮产出 8 位十六进制，拼够长度后截断 —— 与平台前端
 * `out.push(f"{state:08x}")` + `"".join(out)[:length]` 同义。
 * 每步都要 `>>> 0`：JS 位运算结果是有符号 32 位，不转无符号会让 toString(16) 带负号。
 */
export function prng(seed, length) {
  let state = fnv1a32(seed)
  let out = ""
  while (out.length < length) {
    state = (state ^ ((state << 13) >>> 0)) >>> 0
    state = (state ^ (state >>> 17)) >>> 0
    state = (state ^ ((state << 5) >>> 0)) >>> 0
    out += state.toString(16).padStart(8, "0")
  }
  return out.slice(0, length)
}

/**
 * 解一道题：找最小的 `n`，使 `sha256(salt + n)` 的十六进制前缀等于 `target`。
 *
 * ⚠ 比较口径是**十六进制前缀**（`digest.startsWith(target)`），不是「前
 * target.length/2 个字节」—— 上游前端那份字节比较的 fallback 对奇数 d 会少
 * 比较半个字节，照抄会被 redeem 判 `invalid solutions`。
 */
function solveOne(salt, target, budget) {
  for (let n = 0; n < MAX_POW_ATTEMPTS_PER_QUESTION; n += 1) {
    budget.remaining -= 1
    if (budget.remaining < 0) {
      throw new Error(
        `签到验证题累计求解超过 ${MAX_POW_ATTEMPTS_TOTAL} 次（target=${target}，`
        + "上游可能提高了难度）—— 已放弃本次签到，请稍后重试",
      )
    }
    const digest = createHash("sha256").update(salt + String(n)).digest("hex")
    if (digest.startsWith(target)) return n
  }
  throw new Error(
    `签到验证题求解超过 ${MAX_POW_ATTEMPTS_PER_QUESTION} 次仍未命中（target=${target}，`
    + "上游可能提高了难度）—— 已放弃本次签到，请稍后重试",
  )
}

/**
 * 解整个挑战：返回 `count` 个解（顺序与题号一致，不能排序或去重）。
 *
 * 第 `i` 题（从 0 开始）的两个派生种子：
 * - `target = prng(token + (i+1) + "d", targetLength)`
 * - `salt   = prng(token + (i+1),        saltLength)`
 */
export function solveChallenge(token, challenge, budget = { remaining: MAX_POW_ATTEMPTS_TOTAL }) {
  const solutions = []
  for (let index = 0; index < challenge.count; index += 1) {
    const ordinal = index + 1
    const target = prng(`${token}${ordinal}d`, challenge.targetLength)
    const salt = prng(`${token}${ordinal}`, challenge.saltLength)
    solutions.push(solveOne(salt, target, budget))
  }
  return solutions
}

/** 同 solveChallenge，但每解完一题让出一次事件循环（不冻结宿主）。 */
export async function solveChallengeYielding(token, challenge, budget = { remaining: MAX_POW_ATTEMPTS_TOTAL }) {
  const solutions = []
  for (let index = 0; index < challenge.count; index += 1) {
    const ordinal = index + 1
    const target = prng(`${token}${ordinal}d`, challenge.targetLength)
    const salt = prng(`${token}${ordinal}`, challenge.saltLength)
    solutions.push(solveOne(salt, target, budget))
    await new Promise((resolve) => setImmediate(resolve))
  }
  return solutions
}

/** 读挑战报文（`{ token, challenge: { c, s, d } }`）。 */
function readChallenge(data) {
  if (data === null || typeof data !== "object") {
    return { error: "签到验证题报文不是对象（上游形态可能已变）" }
  }
  const token = typeof data.token === "string" ? data.token.trim() : ""
  if (token.length === 0) return { error: "签到验证题报文里没有 token（上游形态可能已变）" }
  const challenge = data.challenge
  if (challenge === null || typeof challenge !== "object") {
    return { error: "签到验证题报文里没有 challenge（上游形态可能已变）" }
  }
  const count = readNumber(challenge.c)
  const saltLength = readNumber(challenge.s)
  const targetLength = readNumber(challenge.d)
  if (count === undefined || saltLength === undefined || targetLength === undefined) {
    return { error: "签到验证题的 c/s/d 字段缺失或不是数字（上游形态可能已变）" }
  }
  // 这些数字直接决定本地计算量：上游一旦给错（例如 c=10^9），不加闸门就是一次
  // 卡死整个宿主事件循环的长任务。
  if (count < 1 || count > 500 || saltLength < 1 || saltLength > 256 || targetLength < 1 || targetLength > 16) {
    return { error: `签到验证题参数超出合理范围（c=${count}, s=${saltLength}, d=${targetLength}）` }
  }
  return { token, challenge: { count: Math.floor(count), saltLength: Math.floor(saltLength), targetLength: Math.floor(targetLength) } }
}

/** 从 redeem 响应里取验证 token（形如 `<8hex>:<15hex>`）。 */
function readCaptchaToken(data) {
  if (data === null || typeof data !== "object") return undefined
  if (data.success === false) return undefined
  const token = typeof data.token === "string" ? data.token.trim() : ""
  return token.length === 0 ? undefined : token
}

/** 从签到响应里 best-effort 取「本次到账积分」；只认明确的奖励字段名。 */
function readRewardedCredit(data) {
  if (data === null || typeof data !== "object") return undefined
  for (const key of ["credit", "credits", "reward", "reward_credit", "amount", "points"]) {
    const value = readNumber(data[key])
    if (value !== undefined && value > 0) return value
  }
  return undefined
}

/**
 * 一键签到：challenge → 本地求解 → redeem → checkin。
 *
 * 先 GET 判 `checked_in`：已签则直接回 already-claimed，不发任何写请求。
 *
 * 奖励金额：优先读响应；响应里没有（真机就是这样）就用「签到前后余额差」；
 * 两次读余额有一次失败才回落 0，绝不编造一个「100」。
 */
export async function claimCheckin(credential, site, options = {}) {
  const cookie = cookieOf(credential, site.sessionCookie)
  if (cookie === undefined) {
    return {
      kind: "failed",
      message: "未配置会话（session_cookie）—— 签到接口只认网页登录态，请用「浏览器登录」添加账号",
    }
  }
  const base = site.platformBaseUrl
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  try {
    const status = await fetchCheckinStatus(cookie, site, { fetchImpl, timeoutMs })
    if (status !== null && status.todayCheckedIn) {
      return { kind: "already-claimed", message: "今天已经签到过了" }
    }
    const walletBefore = await fetchWallet(cookie, site, { fetchImpl, timeoutMs })

    const challengeResult = await platformRequest(
      cookie,
      `${base}/api/v1/public/captcha/challenge`,
      { method: "POST", body: {}, fetchImpl, timeoutMs },
    )
    if (!challengeResult.ok) {
      return { kind: "failed", message: `获取签到验证题失败：${challengeResult.error}` }
    }
    const challengeEnvelope = unwrapEnvelope(challengeResult.data)
    if (!challengeEnvelope.ok) {
      return { kind: "failed", message: `获取签到验证题失败：${challengeEnvelope.error}` }
    }
    const challenge = readChallenge(challengeEnvelope.value)
    // 题面形状不认识 / 参数越界 = 上游改了验证题形态。这不是「签到失败」，
    // 而是自动签到这条路当下走不通 —— 判 captcha，让用户去官方页面手动签。
    if ("error" in challenge) return { kind: "captcha", message: challenge.error }

    let solutions
    try {
      solutions = await solveChallengeYielding(challenge.token, challenge.challenge)
    } catch (error) {
      // 预算打穿同属「验证题形态变了」，不该让用户以为账号有问题。
      return { kind: "captcha", message: error instanceof Error ? error.message : String(error) }
    }

    const redeemResult = await platformRequest(
      cookie,
      `${base}/api/v1/public/captcha/redeem`,
      { method: "POST", body: { token: challenge.token, solutions }, fetchImpl, timeoutMs },
    )
    if (!redeemResult.ok) {
      return { kind: "failed", message: `提交签到验证答案失败：${redeemResult.error}` }
    }
    const redeemEnvelope = unwrapEnvelope(redeemResult.data)
    if (!redeemEnvelope.ok) {
      return { kind: "failed", message: `提交签到验证答案失败：${redeemEnvelope.error}` }
    }
    const captchaToken = readCaptchaToken(redeemEnvelope.value)
    if (captchaToken === undefined) {
      return { kind: "captcha", message: "签到验证没有通过（redeem 响应里没有 token）—— 可能是验证题已过期，请重试一次" }
    }

    const checkinResult = await platformRequest(
      cookie,
      `${base}/api/v1/users/wallet/checkin`,
      { method: "POST", body: { captcha_token: captchaToken }, fetchImpl, timeoutMs },
    )
    if (!checkinResult.ok) {
      return { kind: "failed", message: `签到失败：${checkinResult.error}` }
    }
    const checkinEnvelope = unwrapEnvelope(checkinResult.data)
    const responseCredit = checkinEnvelope.ok ? readRewardedCredit(checkinEnvelope.value) : undefined
    let measuredCredit
    if (responseCredit === undefined && walletBefore.ok) {
      const walletAfter = await fetchWallet(cookie, site, { fetchImpl, timeoutMs })
      if (walletAfter.ok) {
        const delta = walletAfter.balance - walletBefore.balance
        const normalized = Math.round(delta * 1000) / 1000
        if (normalized > 0) measuredCredit = normalized
      }
    }
    const credited = responseCredit ?? measuredCredit
    if (credited !== undefined) return { kind: "claimed", credit: credited, unit: "credit" }
    return {
      kind: "claimed",
      credit: 0,
      message: "签到成功（上游不返回积分数量，请查看刷新后的余额）",
    }
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) }
  }
}
