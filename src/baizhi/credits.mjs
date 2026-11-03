// 百智云平台接口：控制台钱包 / 用量 / 资料、大模型商店换 Key、远端模型目录。
//
// 两套凭据各管一段（实测，见 src/baizhi/site.mjs 的注释）：
// - 控制台 cookie（`baizhi_session` / `sl-session`）→ 余额、用量、资料、Key 列表；
// - 推理 Key（`sk-…`）→ 模型网关与模型目录。
// 没有 cookie 时推理照常，只是查不到积分 —— 必须优雅降级，不能把账号判死。

import {
  cookieOf, platformRequest, readArrayField, readBoolField, readNumber, readNumberField, unwrapEnvelope,
} from "../platform-http.mjs"

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
  const result = await platformRequest(
    normalized,
    `${site.consoleBaseUrl}${site.consoleApiKeysPath}`,
    { method: "GET", fetchImpl, timeoutMs },
  )
  if (!result.ok) return { ok: false, error: result.error }
  const unwrapped = unwrapEnvelope(result.data)
  if (!unwrapped.ok) return { ok: false, error: unwrapped.error }
  for (const item of readArrayField(unwrapped.value, "items")) {
    const key = typeof item.api_key === "string" ? item.api_key.trim() : ""
    const status = typeof item.status === "string" ? item.status : "active"
    if (status !== "active") continue
    if (/^sk-[A-Za-z0-9_-]{16,}$/.test(key)) return { ok: true, apiKey: key }
  }
  return {
    ok: false,
    error: "这个大模型商店账号下还没有可用的 sk- 密钥 —— 请打开 "
      + "https://ai-models.app.baizhi.cloud/console/keys 新建一把，或改用「手动填写 API Key」",
  }
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
