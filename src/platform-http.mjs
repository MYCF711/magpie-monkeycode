// 平台 REST 请求的通用件：cookie 归一、请求头、发包、信封解包、失败翻译。
//
// MonkeyCode 与百智云共用这一套（两家的平台接口都是「普通 SPA + REST + cookie」）：
// - cookie 只认网页登录态，`x-api-key` 打过去一律 401；
// - 成功响应套 `{ code, data, message }` 信封（有的端点直接回裸对象）；
// - 401/403 的语义是「用户还没登进去」，不是「会话失效」。
//
// 站点差异（域名、cookie 名）由调用方传进来，这里不认任何厂商常量。

/**
 * 把用户可能粘贴的 cookie 串归一成可以直接放进 `Cookie` 头的值。
 *
 * 接受：完整 cookie 串（`a=1; b=2`）、裸值（补上 fallback 名）、带 `cookie:` 前缀的复制品。
 * @param {string} raw
 * @param {string[]} names 该平台认的 cookie 名（用于判断「是不是完整串」）
 * @param {string} fallbackName 裸值补的名字
 */
export function normalizeCookie(raw, names, fallbackName) {
  if (typeof raw !== "string") return undefined
  let text = raw.trim()
  if (text.length === 0) return undefined
  text = text.replace(/^cookie\s*:\s*/i, "").trim()
  if (text.length === 0) return undefined
  // 已含 `name=` 形式 ⇒ 视为完整 cookie 串。
  if (/^[A-Za-z_][A-Za-z0-9_.-]*=/.test(text)) return text
  const value = text.replace(/[\r\n]/g, "").trim()
  if (value.length === 0) return undefined
  // 认多个名字时，裸值只补第一个（两个平台都用主 cookie 名）。
  void names
  return `${fallbackName}=${value}`
}

/** 从凭据里取归一化后的 cookie；没有则 undefined。 */
export function cookieOf(credential, names, fallbackName) {
  if (!credential) return undefined
  const raw = credential.session_cookie
  if (typeof raw !== "string") return undefined
  return normalizeCookie(raw, names, fallbackName)
}

/**
 * 出站 User-Agent —— **全仓库唯一的那一条**，所有打上游的请求都引用它。
 *
 * 上游网关（monkeycode-ai.com / monkeycode-ai.net / baizhi.cloud 以及 ohmyagent
 * 网关）按 `<产品名>/<版本>` 的形态识别「第三方客户端」，命中就回
 * `403 TM.00000001 网络繁忙，请稍后重试`。所以：
 *
 *   ① 禁止出现 `magpie/…`、`magpie-plugin/…`、`magpie-monkeycode/…` 这类我们自己的名字；
 *   ② 禁止让宿主的 UA 透传（magpie 给插件的固定 UA 就是 `magpie/<version>`）；
 *   ③ 禁止 `node` / `Bun/…` / `undici` 这类运行时默认 UA。
 *
 * 取值：这两家平台的官方客户端是**网页控制台**（Tauri/WebView2 壳里跑的也是同一个
 * SPA），仓库里 `src/monkeycode/catalog.mjs` 与 `platformHeaders()` 早先各自内联过
 * 这条「与网页同形」的完整 Chrome UA —— 现在收敛到这里一份，别再造第二个版本号。
 */
export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

/**
 * 平台 REST 请求头。
 *
 * 带 referer / user-agent 只是「尽量与网页同形」的保守选择 —— 平台是普通
 * SPA + REST，没有证据表明它强制校验这两项；但缺失时被边缘 WAF 拦掉的概率更高。
 * 现在它更是**硬要求**：缺失 ⇒ 透传 `magpie/<version>` ⇒ 网关 403。
 */
export function platformHeaders(cookie, platformBaseUrl) {
  return {
    cookie,
    accept: "application/json",
    referer: `${platformBaseUrl}/`,
    "user-agent": UA,
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
export function isSessionPendingError(message) {
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
 * 「200 + HTML」是记录过的假 200 形态（SPA catch-all 路由）：若把原文当成功
 * 传下去，上层会以为是报文变形，排查方向直接跑偏。
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

/** 把 number | string 收敛成有限数字；其余一律 undefined（表示「读不到」）。 */
export function readNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** 从对象里读一个数字字段。 */
export function readNumberField(record, key) {
  if (record === null || typeof record !== "object") return undefined
  return readNumber(record[key])
}

/** 从对象里读一个布尔字段。 */
export function readBoolField(record, key) {
  if (record === null || typeof record !== "object") return undefined
  const value = record[key]
  return typeof value === "boolean" ? value : undefined
}

/** 从对象里读一个数组字段；不是数组时返回空数组。 */
export function readArrayField(record, key) {
  if (record === null || typeof record !== "object") return []
  const value = record[key]
  return Array.isArray(value) ? value : []
}
