// 账号密码登录（**纯 API，不开窗**）。
//
// ═══════════════════════════════════════════════════════════════════
// 为什么这条路必须存在
// ═══════════════════════════════════════════════════════════════════
//
// 用户明确要求过：「我不要微信扫码，我要观猹账号」。开窗让人自己点，等于把
// 「登录方式的选择权」交给一个不受我们控制的网页；而且窗口里一旦有匿名会话、
// 有 OAuth 授权确认页、有验证码，任何一步卡住用户都只能看着转圈。
//
// 桌面客户端早就没这个问题 —— 它的 `mc_password_login` 命令对应
// `POST /api/v1/users/password-login`，一次请求拿到会话。我们把同一条路搬过来。
//
// ═══════════════════════════════════════════════════════════════════
// 请求链（2026-11-04 从国际站前端 bundle 反出 + 真机验证）
// ═══════════════════════════════════════════════════════════════════
//
//   1. POST /api/v1/public/captcha/challenge   body {}            → 201 {token, challenge:{c,s,d}}
//   2. 本地解 c 道 PoW（复用签到那套 solveChallenge）
//   3. POST /api/v1/public/captcha/redeem      body {token, solutions} → 201 {token:"….….", success:true}
//   4. POST /api/v1/users/password-login       body {email, password, captcha_token}
//        成功 → Set-Cookie 里下发 `monkeycode_ai_session`
//        失败 → {"code":10606,"message":"登录失败"}（账号或密码不对）
//
// 字段名是从前端 bundle 里逐字取出来的：
//   `Ie("v1UsersPasswordLoginCreate", { email: r.trim(), password: i.trim(), captcha_token: G || "" })`
//
// ⚠ 不带 captcha_token 直接打 password-login 会得到 **403 禁止访问**（不是 400）。
//   所以「403」在这里的含义是「没带验证码」，不是「被封号」或「接口不对」。
//
// ⚠ 密码绝不出现在日志、错误消息、返回值里。这个模块只把它放进 request body。

import { solveChallenge } from "./credits.mjs"

/** 登录失败码：上游用 10606 表达「账号或密码不对」。 */
export const PASSWORDS_MISMATCH = 10606

function textOf(value) {
  return typeof value === "string" ? value.trim() : ""
}

async function postJson(url, body, { fetchImpl = fetch, timeoutMs = 30_000, cookie } = {}) {
  const headers = { "content-type": "application/json" }
  if (cookie !== undefined && cookie.length > 0) headers.cookie = cookie
  let response
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `请求 ${url} 失败：${reason}` }
  }
  const raw = await response.text()
  let json
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, error: `${url} 返回的不是 JSON（HTTP ${response.status}）：${raw.slice(0, 120)}` }
  }
  return { ok: true, status: response.status, json, headers: response.headers }
}

/**
 * 走一遍「challenge → 解 PoW → redeem」，拿 `captcha_token`。
 *
 * 上游的验证题形态变了就如实报错 —— 不要静默重试，那只会把「形态变了」伪装成
 * 「登录失败」，让人去怀疑账号密码。
 */
export async function fetchCaptchaToken(site, options = {}) {
  const base = site.platformBaseUrl
  const challenge = await postJson(`${base}/api/v1/public/captcha/challenge`, {}, options)
  if (!challenge.ok) return { ok: false, error: challenge.error }
  const payload = challenge.json ?? {}
  const token = textOf(payload.token)
  const shape = payload.challenge
  if (token.length === 0 || shape === null || typeof shape !== "object") {
    return { ok: false, error: "验证题报文里没有 token / challenge（上游形态可能已变）" }
  }
  const count = Number(shape.c)
  const saltLength = Number(shape.s)
  const targetLength = Number(shape.d)
  if (!Number.isFinite(count) || !Number.isFinite(saltLength) || !Number.isFinite(targetLength)) {
    return { ok: false, error: "验证题的 c/s/d 不是数字（上游形态可能已变）" }
  }

  let solutions
  try {
    solutions = await solveChallenge(token, { count, saltLength, targetLength })
  } catch (error) {
    return { ok: false, error: `解开验证题失败：${error instanceof Error ? error.message : String(error)}` }
  }

  const redeem = await postJson(`${base}/api/v1/public/captcha/redeem`, { token, solutions }, options)
  if (!redeem.ok) return { ok: false, error: redeem.error }
  const body = redeem.json ?? {}
  const captchaToken = textOf(body.token) || textOf(body.captcha_token) || textOf(body?.data?.captcha_token)
  if (captchaToken.length === 0) {
    return { ok: false, error: "验证题没有通过（redeem 里没有 token）—— 多半是题目过期，再试一次" }
  }
  return { ok: true, captchaToken }
}

/**
 * 用账号密码换网页会话 cookie。
 *
 * @returns {{ ok: true, cookie: string } | { ok: false, error: string }}
 *   `cookie` 是 `monkeycode_ai_session=…` 这一串，直接拿去换网关凭据即可。
 */
export async function loginWithPassword({ email, password, site, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const account = textOf(email)
  if (account.length === 0) return { ok: false, error: "没有填账号（邮箱）" }
  if (typeof password !== "string" || password.length === 0) return { ok: false, error: "没有填密码" }

  const options = { fetchImpl, timeoutMs }
  const captcha = await fetchCaptchaToken(site, options)
  if (!captcha.ok) return { ok: false, error: captcha.error }

  const result = await postJson(
    `${site.platformBaseUrl}/api/v1/users/password-login`,
    { email: account, password, captcha_token: captcha.captchaToken },
    options,
  )
  if (!result.ok) return { ok: false, error: result.error }

  const body = result.json ?? {}
  if (Number(body.code) === PASSWORDS_MISMATCH) {
    return { ok: false, error: "账号或密码不对（上游 code 10606）" }
  }
  if (Number(body.code) !== 0) {
    const message = textOf(body.message) || `HTTP ${result.status}`
    return { ok: false, error: `登录失败：${message}` }
  }

  // 会话 cookie 在 Set-Cookie 里。同一个响应可能有多条，只取我们认识的那个名字。
  const jar = typeof result.headers?.getSetCookie === "function" ? result.headers.getSetCookie() : []
  const wanted = site.sessionCookie
  let value = ""
  for (const line of jar) {
    const first = String(line).split(";")[0] ?? ""
    const index = first.indexOf("=")
    if (index <= 0) continue
    if (first.slice(0, index).trim() !== wanted) continue
    value = first.slice(index + 1).trim()
  }
  if (value.length === 0) {
    // 有些部署把会话放在 body 里（`data.token` / `data.session`）。两条都认，仍然拿不到就报错。
    const fallback = textOf(body?.data?.token) || textOf(body?.data?.session) || textOf(body.token)
    if (fallback.length === 0) {
      return { ok: false, error: "登录接口返回成功，但响应里没有会话 cookie（上游形态可能已变）" }
    }
    value = fallback
  }
  return { ok: true, cookie: `${wanted}=${value}` }
}
