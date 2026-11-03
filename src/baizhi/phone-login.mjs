// 百智云的**手机号 + 短信验证码**登录（纯 API，不开窗）。
//
// ═══════════════════════════════════════════════════════════════════
// 为什么这条是主线
// ═══════════════════════════════════════════════════════════════════
//
// 用户的原话：「观猹账号接受验证码后直接就进 baizhi 的界面，能看到积分、能创建 key」。
// 也就是说这条路**本来就在跑**，只是它发生在浏览器里、而且我们把「读窗口里的
// cookie」当成唯一入口，于是一旦窗口/读取环节出问题，整条登录就没法用。
//
// 实际是两个 HTTP 请求（2026-11-04 从 `baizhi.cloud/_astro/SignInForm.*.js` 反出，
// 并用真机响应逐字验证）：
//
//   1. POST /api/v1/user/phone_code     { phone, kind: "login" }   → 发短信
//   2. POST /api/v1/user/login/phone    { phone, code }            → Set-Cookie: baizhi_session …
//
// 验证记录（用未注册号打，报错就是字段对了的证据）：
//   {phone:"10000000000", kind:"login"} → {"code":400,"message":"手机号未注册"}   ← 字段正确
//   {phone:"10000000000"}               → {"code":400,"message":"参数错误"}       ← 缺 kind
//   {phone:"10000000000", code:"123456"}→ {"code":400,"message":"phone code not found or expired"}
//
// 前端里那几个对象字面量就是证据：
//   `{phone:"", code:""}` · `{phone:i, kind:"login"}` · `{...i, captcha_token:h}`
//
// ⚠ 发码是**有副作用**的（真的会发一条短信）。所以只允许在用户明确点了
//   「手机号验证码登录」之后调用一次，不要拿它做探测或重试。

/** 主站 origin。`sessionCookies` 与 `/api/v1/user/*` 都挂在 `baizhi.cloud` 上。 */
function originOf(site) {
  try {
    return new URL(site.loginUrl).origin
  } catch {
    return "https://baizhi.cloud"
  }
}

/** 发验证码。 */
export async function sendPhoneCode({ phone, site, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const number = typeof phone === "string" ? phone.trim() : ""
  if (number.length === 0) return { ok: false, error: "没有填手机号" }
  let response
  try {
    response = await fetchImpl(`${originOf(site)}/api/v1/user/phone_code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: number, kind: "login" }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { ok: false, error: `发送验证码失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const raw = await response.text()
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return { ok: false, error: `发送验证码失败：响应不是 JSON（HTTP ${response.status}）` }
  }
  if (Number(body.code) !== 0) {
    const message = typeof body.message === "string" ? body.message : `HTTP ${response.status}`
    // 「手机号未注册」是最常见的误操作：用户拿没注册过的号来登录。要说清。
    return { ok: false, error: message.includes("未注册") ? `这个手机号还没注册过百智云（${message}）` : `发送验证码失败：${message}` }
  }
  return { ok: true }
}

/**
 * 用手机号 + 验证码换 `baizhi_session`。
 *
 * @returns {{ ok: true, cookie: string } | { ok: false, error: string }}
 */
export async function loginWithPhoneCode({ phone, code, site, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const number = typeof phone === "string" ? phone.trim() : ""
  const token = typeof code === "string" ? code.trim() : ""
  if (number.length === 0) return { ok: false, error: "没有填手机号" }
  if (token.length === 0) return { ok: false, error: "没有填验证码" }

  let response
  try {
    response = await fetchImpl(`${originOf(site)}/api/v1/user/login/phone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: number, code: token }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { ok: false, error: `登录失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const raw = await response.text()
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return { ok: false, error: `登录失败：响应不是 JSON（HTTP ${response.status}）` }
  }
  if (Number(body.code) !== 0) {
    const message = typeof body.message === "string" ? body.message : `HTTP ${response.status}`
    if (/expired|not found/i.test(message)) return { ok: false, error: "验证码不对或已过期，重新点一次再收一条" }
    return { ok: false, error: `登录失败：${message}` }
  }

  // 会话在 Set-Cookie 里。可能同时下发 sl-session（风控）与 baizhi_session（登录），
  // 两个都要带回去 —— 换 Key 时少一个会被判「网页登录态未生效」。
  const lines = typeof response.headers?.getSetCookie === "function" ? response.headers.getSetCookie() : []
  const picked = new Map()
  for (const line of lines) {
    const first = String(line).split(";")[0] ?? ""
    const index = first.indexOf("=")
    if (index <= 0) continue
    const name = first.slice(0, index).trim()
    const value = first.slice(index + 1).trim()
    if (value.length === 0) continue
    if (!site.sessionCookies.includes(name)) continue
    picked.set(name, value)
  }
  if (!picked.has(site.sessionCookie)) {
    const fallback = typeof body?.data?.token === "string" ? body.data.token.trim() : ""
    if (fallback.length === 0) {
      return { ok: false, error: "登录接口返回成功，但响应里没有会话 cookie（上游形态可能已变）" }
    }
    picked.set(site.sessionCookie, fallback)
  }
  return { ok: true, cookie: [...picked].map(([name, value]) => `${name}=${value}`).join("; ") }
}
