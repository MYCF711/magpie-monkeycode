// 百智云平台接口：控制台钱包 / 用量 / 资料、大模型商店换 Key、远端模型目录。
//
// 两套凭据各管一段（实测，见 src/baizhi/site.mjs 的注释）：
// - 控制台 cookie（`baizhi_session` / `sl-session`）→ 余额、用量、资料、Key 列表；
// - 推理 Key（`sk-…`）→ 模型网关与模型目录。
// 没有 cookie 时推理照常，只是查不到积分 —— 必须优雅降级，不能把账号判死。

import {
  cookieOf, platformRequest, readArrayField, readBoolField, readNumber, readNumberField, unwrapEnvelope,
  UA,
} from "../platform-http.mjs"
import { solveChallengeYielding } from "../monkeycode/credits.mjs"

/** 钱包读数（已从「分」换算成积分）。 */
export async function fetchWallet(cookie, site, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const normalized = cookieOf({ session_cookie: cookie }, site.sessionCookies, site.sessionCookie)
  if (normalized === undefined) {
    return {
      ok: false,
      error: "未配置会话（session_cookie）—— 积分余额只认网页登录态；"
        + "只填 API Key 的账号能发消息但查不到积分",
    }
  }
  const result = await platformRequest(normalized, `${site.platformBaseUrl}${site.walletBalancePath}`, { method: "GET", fetchImpl, timeoutMs })
  if (!result.ok) return { ok: false, error: result.error }
  const unwrapped = unwrapEnvelope(result.data)
  if (!unwrapped.ok) return { ok: false, error: unwrapped.error }
  const record = unwrapped.value
  const availableCents = readNumberField(record, "available_credit_cents")
  if (availableCents === undefined) {
    return { ok: false, error: "上游未下发积分余额（响应里没有 available_credit_cents）" }
  }
  // 单位是 1/100 积分 ⇒ 除 100 才是面板上的「235.05」。
  const toCredit = (cents) => (cents === undefined ? 0 : cents / 100)
  return {
    ok: true,
    wallet: {
      available: toCredit(availableCents),
      temporary: toCredit(readNumberField(record, "temporary_credit_cents")),
      permanent: toCredit(readNumberField(record, "permanent_credit_cents")),
      frozen: toCredit(readNumberField(record, "frozen_credit_cents")),
      dailyClaimed: readBoolField(record, "daily_temporary_credit_claimed") === true,
      ...(readNumberField(record, "user_id") === undefined ? {} : { userId: readNumberField(record, "user_id") }),
    },
  }
}

/** 读每日积分验证题（`{ token, challenge: { c, s, d } }`）。 */
function readChallenge(data) {
  if (data === null || typeof data !== "object") {
    return { error: "每日积分验证题报文不是对象（上游形态可能已变）" }
  }
  const token = typeof data.token === "string" ? data.token.trim() : ""
  if (token.length === 0) return { error: "每日积分验证题报文里没有 token（上游形态可能已变）" }
  const challenge = data.challenge
  if (challenge === null || typeof challenge !== "object") {
    return { error: "每日积分验证题报文里没有 challenge（上游形态可能已变）" }
  }
  const count = readNumber(challenge.c)
  const saltLength = readNumber(challenge.s)
  const targetLength = readNumber(challenge.d)
  if (count === undefined || saltLength === undefined || targetLength === undefined) {
    return { error: "每日积分验证题的 c/s/d 字段缺失或不是数字（上游形态可能已变）" }
  }
  // 与 MonkeyCode 同一套 PoW；限制计算量，避免异常题面冻结宿主。
  if (count < 1 || count > 500 || saltLength < 1 || saltLength > 256 || targetLength < 1 || targetLength > 16) {
    return { error: `每日积分验证题参数超出合理范围（c=${count}, s=${saltLength}, d=${targetLength}）` }
  }
  return { token, challenge: { count: Math.floor(count), saltLength: Math.floor(saltLength), targetLength: Math.floor(targetLength) } }
}

/** 从 redeem 响应里取 captcha token。 */
function readCaptchaToken(data) {
  if (data === null || typeof data !== "object" || data.success === false) return undefined
  const token = typeof data.token === "string" ? data.token.trim() : ""
  return token.length === 0 ? undefined : token
}

/**
 * 领取每日积分：钱包幂等状态 → challenge → 本地 PoW → redeem → daily-temporary-credit。
 *
 * 已领取 / 领取前钱包失败时绝不发 POST。`claimed:false` 是并发下另一会话已领取的
 * 幂等结果，不是失败。实际到账只认领取前后 `temporary_credit_cents` 的正差额；
 * 上游报文没有金额、复读钱包失败或没有正差额时，只报告通用成功，不硬编码 100。
 */
export async function claimDailyCredit(credential, site, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const cookie = cookieOf(credential, site.sessionCookies, site.sessionCookie)
  if (cookie === undefined) {
    return {
      kind: "failed",
      message: "未配置会话（session_cookie）—— 每日积分只认网页登录态，请用「浏览器登录」添加账号",
    }
  }
  const base = site.platformBaseUrl
  try {
    const walletBefore = await fetchWallet(cookie, site, { fetchImpl, timeoutMs })
    if (!walletBefore.ok) return { kind: "failed", message: `领取前读取钱包失败：${walletBefore.error}` }
    if (walletBefore.wallet.dailyClaimed) {
      return { kind: "already-claimed", message: "今日已领取" }
    }

    const challengeResult = await platformRequest(
      cookie,
      `${base}/api/v1/public/captcha/challenge`,
      { method: "POST", body: {}, fetchImpl, timeoutMs },
    )
    if (!challengeResult.ok) return { kind: "failed", message: `获取每日积分验证题失败：${challengeResult.error}` }
    const challengeEnvelope = unwrapEnvelope(challengeResult.data)
    if (!challengeEnvelope.ok) return { kind: "failed", message: `获取每日积分验证题失败：${challengeEnvelope.error}` }
    const challenge = readChallenge(challengeEnvelope.value)
    if ("error" in challenge) return { kind: "captcha", message: challenge.error }

    let solutions
    try {
      solutions = await solveChallengeYielding(challenge.token, challenge.challenge)
    } catch (error) {
      return { kind: "captcha", message: error instanceof Error ? error.message : String(error) }
    }

    const redeemResult = await platformRequest(
      cookie,
      `${base}/api/v1/public/captcha/redeem`,
      { method: "POST", body: { token: challenge.token, solutions }, fetchImpl, timeoutMs },
    )
    if (!redeemResult.ok) return { kind: "failed", message: `提交每日积分验证答案失败：${redeemResult.error}` }
    const redeemEnvelope = unwrapEnvelope(redeemResult.data)
    if (!redeemEnvelope.ok) return { kind: "failed", message: `提交每日积分验证答案失败：${redeemEnvelope.error}` }
    const captchaToken = readCaptchaToken(redeemEnvelope.value)
    if (captchaToken === undefined) {
      return { kind: "captcha", message: "每日积分验证没有通过（redeem 响应里没有 token），请重试一次" }
    }

    const claimResult = await platformRequest(
      cookie,
      `${base}/api/v1/user/wallet/daily-temporary-credit`,
      { method: "POST", body: { captcha_token: captchaToken }, fetchImpl, timeoutMs },
    )
    if (!claimResult.ok) return { kind: "failed", message: `领取每日积分失败：${claimResult.error}` }
    const claimEnvelope = unwrapEnvelope(claimResult.data)
    if (!claimEnvelope.ok) return { kind: "failed", message: `领取每日积分失败：${claimEnvelope.error}` }
    const claimed = readBoolField(claimEnvelope.value, "claimed")
    if (claimed === false) return { kind: "already-claimed", message: "今日已领取" }
    if (claimed !== true) {
      return { kind: "failed", message: "领取每日积分的响应里没有明确的 claimed 布尔值（上游形态可能已变）" }
    }

    const walletAfter = await fetchWallet(cookie, site, { fetchImpl, timeoutMs })
    if (walletAfter.ok) {
      const delta = walletAfter.wallet.temporary - walletBefore.wallet.temporary
      const credit = Math.round(delta * 100) / 100
      if (credit > 0) return { kind: "claimed", credit, unit: "credit" }
    }
    return {
      kind: "claimed",
      credit: 0,
      message: "每日积分领取成功（未能确认本次到账数额，请查看刷新后的余额）",
    }
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 用量明细：`GET /api/v1/user/wallet/app-credit-usage?period=week|month|year`。
 *
 * `period` 是**本地日历日**（实测 `2026-11-02` 与控制台「今日消耗」一致），
 * 所以「今天」也按本地时区算 —— 用 UTC 会把北京时间 00:00–08:00 的消耗算成昨天。
 */
export async function fetchUsage(cookie, site, { period = "month", fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const normalized = cookieOf({ session_cookie: cookie }, site.sessionCookies, site.sessionCookie)
  if (normalized === undefined) return { ok: false, error: "未配置会话（session_cookie）" }
  const result = await platformRequest(
    normalized,
    `${site.platformBaseUrl}${site.walletUsagePath}?period=${period}`,
    { method: "GET", fetchImpl, timeoutMs },
  )
  if (!result.ok) return { ok: false, error: result.error }
  const unwrapped = unwrapEnvelope(result.data)
  if (!unwrapped.ok) return { ok: false, error: unwrapped.error }
  const items = readArrayField(unwrapped.value, "items").map((item) => ({
    period: typeof item.period === "string" ? item.period : "",
    callCount: readNumberField(item, "call_count") ?? 0,
    credit: readNumberField(item, "credit") ?? 0,
  }))
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  const sum = (list, key) => list.reduce((total, item) => total + item[key], 0)
  const todayItems = items.filter((item) => item.period === today)
  return {
    ok: true,
    usage: {
      todayCredit: sum(todayItems, "credit"),
      todayCalls: sum(todayItems, "callCount"),
      monthCredit: sum(items, "credit"),
      monthCalls: sum(items, "callCount"),
    },
  }
}

/**
 * 用控制台网页登录态换 `sk-` API Key（浏览器登录的最后一环）。
 *
 * 打的是**大模型商店**的 console 接口：
 * `GET https://ai-models.app.baizhi.cloud/api/console/api-keys`（cookie 认证），
 * 响应 `{ items: [{ id, name, api_key: "sk-…", status }] }`。
 *
 * ⚠ 字段是 `api_key`（下划线），不是控制台的 `key`；控制台那条路径只发 `bzy_`，
 * 拿它打网关恒 401。一个账号可以有多把 Key：取第一把 `status === "active"` 的。
 */
export async function exchangeSessionForKey(cookie, site, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const normalized = cookieOf({ session_cookie: cookie }, site.sessionCookies, site.sessionCookie)
  if (normalized === undefined) return { ok: false, error: "网页登录态为空" }

  /** 列出账号下所有 key，挑第一把可用的 `sk-`。 */
  const pickActive = async () => {
    const listed = await platformRequest(
      normalized,
      `${site.consoleBaseUrl}${site.consoleApiKeysPath}`,
      { method: "GET", fetchImpl, timeoutMs },
    )
    if (!listed.ok) return { ok: false, error: listed.error, fatal: true }
    const unwrapped = unwrapEnvelope(listed.data)
    if (!unwrapped.ok) return { ok: false, error: unwrapped.error, fatal: true }
    for (const item of readArrayField(unwrapped.value, "items")) {
      const key = typeof item.api_key === "string" ? item.api_key.trim() : ""
      const status = typeof item.status === "string" ? item.status : "active"
      if (status !== "active") continue
      if (/^sk-[A-Za-z0-9_-]{16,}$/.test(key)) return { ok: true, apiKey: key }
    }
    return { ok: false, error: "empty" }
  }

  const existing = await pickActive()
  if (existing.ok) return existing
  if (existing.fatal) return { ok: false, error: existing.error }

  // 账号下一把 sk- 都没有 —— 直接替用户建一把。
  // 上游的注释说「用户只要登进去，插件就能自动建号」，靠的就是这一步；
  // 让别人先去控制台点「新建」再回来，是这条链上唯一需要人动手的地方。
  const created = await platformRequest(
    normalized,
    `${site.consoleBaseUrl}${site.consoleApiKeysPath}`,
    { method: "POST", body: { name: "magpie" }, fetchImpl, timeoutMs },
  )
  if (created.ok) {
    const unwrapped = unwrapEnvelope(created.data)
    const record = unwrapped.ok ? unwrapped.value : undefined
    const createdKey = typeof record?.api_key === "string" ? record.api_key.trim() : ""
    if (/^sk-[A-Za-z0-9_-]{16,}$/.test(createdKey)) return { ok: true, apiKey: createdKey, created: true }
    // 建成功但报文里没直接给 api_key：再列一次（有的接口只回 id）。
    const again = await pickActive()
    if (again.ok) return { ok: true, apiKey: again.apiKey, created: true }
  }

  return {
    ok: false,
    needsKeyCreation: true,
    keysUrl: `${site.consoleBaseUrl}/console/keys`,
    error: "这个大模型商店账号下还没有可用的 sk- 密钥，插件自动新建也没成功 —— "
      + `请打开 ${site.consoleBaseUrl}/console/keys 点一次「新建」，然后回来「重试」`,
  }
}

/**
 * 自己的百智云邀请码：`GET {platformBaseUrl}/api/v1/user/invite-code`
 * → `{ code: 0, message: "success", data: { invite_code: "AB12CD34" } }`（2026-11-09 实测）。
 *
 * ⚠ 邀请码是平台**单独下发**的 8 位字母数字码，**不是**账号 identity（`user.id`，15 位数字）。
 * 拿 identity 拼 `/sign-in?invite_code=<user.id>` 会让控制台当场弹红条
 * `invite_code length must be 8` —— 那正是本函数要根除的形态。
 *
 * 失败一律返回 `ok:false`（拿不到码就不带邀请，登录照常继续，见 invite-policy.mjs）。
 */
export async function fetchInviteCode(cookie, site, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const normalized = cookieOf({ session_cookie: cookie }, site.sessionCookies, site.sessionCookie)
  if (normalized === undefined) return { ok: false, error: "未配置会话（session_cookie）" }
  const result = await platformRequest(
    normalized,
    `${site.platformBaseUrl}/api/v1/user/invite-code`,
    { method: "GET", fetchImpl, timeoutMs },
  )
  if (!result.ok) return { ok: false, error: result.error }
  const unwrapped = unwrapEnvelope(result.data)
  if (!unwrapped.ok) return { ok: false, error: unwrapped.error }
  const raw = unwrapped.value.invite_code
  const code = typeof raw === "string" ? raw.trim() : ""
  // 形态不对（空 / 缺字段 / 上游改成别的编码）就不带：宁可没有邀请，也不能让红条挡住登录。
  if (!/^[A-Za-z0-9]{8}$/.test(code)) {
    return { ok: false, error: "上游邀请码不是 8 位字母数字（形态可能已变）" }
  }
  return { ok: true, code }
}

/** 控制台用户资料：`GET /api/v1/user/profile` → `{ id, name }`。 */
export async function fetchProfile(cookie, site, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const normalized = cookieOf({ session_cookie: cookie }, site.sessionCookies, site.sessionCookie)
  if (normalized === undefined) return undefined
  const result = await platformRequest(
    normalized,
    `${site.platformBaseUrl}${site.profilePath}`,
    { method: "GET", fetchImpl, timeoutMs },
  )
  if (!result.ok) return undefined
  const unwrapped = unwrapEnvelope(result.data)
  if (!unwrapped.ok) return undefined
  const name = typeof unwrapped.value.name === "string" && unwrapped.value.name.trim().length > 0
    ? unwrapped.value.name.trim()
    : undefined
  const id = readNumberField(unwrapped.value, "id")
  return {
    ...(name === undefined ? {} : { name }),
    ...(id === undefined ? {} : { userId: String(id) }),
  }
}

/**
 * 拉远端模型目录：`GET https://ai-models.app.baizhi.cloud/api/anthropic/v1/models`。
 *
 * 响应 `{ data: [{ id, type, display_name, created_at }] }` —— 没有任何能力字段，
 * 能力只从本地已知表补；未知就不写。失败抛错，由调用方回退静态表。
 */
export async function fetchRemoteModels(apiKey, site, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const response = await fetchImpl(site.modelsUrl, {
    method: "GET",
    headers: {
      accept: "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": apiKey,
      // 不显式给 UA 就是透传宿主的 `magpie/<version>` ⇒ 网关 403 TM.00000001
      "user-agent": UA,
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`百智云：模型目录请求失败（HTTP ${response.status}）${detail === "" ? "" : `：${detail.slice(0, 200)}`}`)
  }
  const payload = await response.json()
  const list = Array.isArray(payload?.data) ? payload.data : []
  const out = []
  for (const item of list) {
    if (item === null || typeof item !== "object") continue
    const id = typeof item.id === "string" ? item.id.trim() : ""
    if (id.length === 0) continue
    out.push({
      id,
      name: typeof item.display_name === "string" && item.display_name.trim().length > 0
        ? item.display_name.trim()
        : id,
    })
  }
  if (out.length === 0) throw new Error("百智云：模型目录为空")
  return out
}
