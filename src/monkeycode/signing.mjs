// MonkeyCode 网关协议原语：凭据形状、签名、请求头、错误分类。
//
// 本文件不发请求、不碰存储，只做纯函数 —— 便于单测直接驱动。
//
// ## 鉴权：只有一种（OhMyAgent 网关）
//
// 除 `x-api-key: oma_…` 外，**必须**额外带
// `X-OhMyAgent-Signature: v1=<hex HMAC-SHA256(signing_secret, prompt)>`。
// 缺签名或签名错 ⇒ `403 {"error":"invalid ohmyagent request"}`。
//
// ⚠ 签名覆盖的是 **prompt 文本**，不是整个请求体。这意味着改了 payload 就必须
// 重算签名 —— 所以本模块不缓存签名，而是让调用方在**序列化完成之后**把 body 传进来。
// 早期版本在构造 payload 之前就做 headers，body 一改签名即失效、报 403
// 且文案只有一句 `invalid ohmyagent request`，极难定位。
//
// 签名算法是公开的（上游 `backend/biz/llmproxy/ohmyagent_prompt.go`）：
// `"v1=" + hex(HMAC-SHA256(signing_secret, prompt))`，十六进制小写。

import { createHmac } from "node:crypto"

/** 从内容块里取文本（string 直接返回；对象取其 `text` 字段）。 */
function textOfBlock(block) {
  if (typeof block === "string") return block
  if (typeof block !== "object" || block === null) return undefined
  const text = block.text
  return typeof text === "string" ? text : undefined
}

/** 从 Anthropic 的 `content`（string | 块数组）里取**第一块**文本。 */
function firstTextOfContent(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    const text = textOfBlock(block)
    if (text !== undefined) return text
  }
  return undefined
}

/**
 * 取签名用的 `prompt`。
 *
 * 取值顺序（服务端按同样的优先级取，顺序不能变）：
 * 1. 顶层 `system`（string，或 `[{text}]` 取第一块 text）；
 * 2. 顶层 `instructions` 数组，多块按 `\n` join；
 * 3. `messages` 里首个 `role === "system"` 的消息内容；
 * 4. `input` 里首个 `role === "developer" | "system"` 的消息内容。
 *
 * 全部落空时返回空串（签名仍会照常计算 —— 空串的 HMAC 是合法值）。
 */
export function signingPrompt(payload) {
  if (typeof payload !== "object" || payload === null) return ""
  const body = payload

  const system = body.system
  if (typeof system === "string" && system.length > 0) return system
  if (Array.isArray(system)) {
    const text = firstTextOfContent(system)
    if (text !== undefined) return text
  }

  const instructions = body.instructions
  if (Array.isArray(instructions)) {
    const parts = instructions
      .map((block) => firstTextOfContent(block) ?? textOfBlock(block) ?? "")
      .filter((part) => part.length > 0)
    if (parts.length > 0) return parts.join("\n")
  }

  const messages = body.messages
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (typeof message !== "object" || message === null) continue
      if (message.role !== "system") continue
      const text = firstTextOfContent(message.content)
      if (text !== undefined) return text
    }
  }

  const input = body.input
  if (Array.isArray(input)) {
    for (const message of input) {
      if (typeof message !== "object" || message === null) continue
      if (message.role !== "developer" && message.role !== "system") continue
      const text = firstTextOfContent(message.content)
      if (text !== undefined) return text
    }
  }

  return ""
}

/** 网关签名：`v1=<hex HMAC-SHA256(signing_secret, prompt)>`。 */
export function gatewaySignature(signingSecret, prompt) {
  const digest = createHmac("sha256", signingSecret).update(prompt, "utf8").digest("hex")
  return `v1=${digest}`
}

/** 安静地解析已序列化的 body；失败返回 undefined（调用方退化成空 prompt 签名）。 */
function parseBodyQuietly(body) {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

/**
 * 构造网关请求头。
 *
 * ⚠ 必须基于**最终**序列化 body 计算签名，调用顺序是
 * `序列化 → 传 body 进来 → 发请求`。
 */
export function gatewayHeaders(credential, { accept = "text/event-stream", body, anthropicVersion = "2023-06-01" } = {}) {
  const headers = {
    "content-type": "application/json",
    accept,
    "anthropic-version": anthropicVersion,
    "x-api-key": credential.access_token,
  }
  const secret = credential.signing_secret
  if (typeof secret !== "string" || secret.length === 0) return headers
  const prompt = body === undefined ? "" : signingPrompt(parseBodyQuietly(body))
  headers["X-OhMyAgent-Signature"] = gatewaySignature(secret, prompt)
  return headers
}

/**
 * 失败分类：只影响「要不要换号 / 要不要写冷却」，不影响抛给用户的错误码。
 *
 * - `quota`：402 或文案含「积分已耗尽」；
 * - `rate`：429；
 * - `auth`：401 / 403（含网关签名错与 basic 账号访问 pro 前缀）；
 * - `server`：5xx（正文里没有额度/限流字样）；
 * - `other`：其余（4xx 参数错、网络错）。
 */
export function classifyFailure(errorText, status) {
  if (status === 402) return "quota"
  if (status === 429) return "rate"
  if (status === 401 || status === 403) return "auth"
  const text = String(errorText ?? "").toLowerCase()
  if (text.includes("积分已耗尽") || text.includes("额度已耗尽")) return "quota"
  if (text.includes("insufficient") || text.includes("quota")) return "quota"
  if (text.includes("rate limit") || text.includes("too many requests")) return "rate"
  if (status >= 500) return "server"
  return "other"
}

/** 是否值得换一个账号重试（`other` 换号也没用）。 */
export function shouldRotate(failureClass) {
  return failureClass === "quota" || failureClass === "rate" || failureClass === "auth" || failureClass === "server"
}

/**
 * 解析凭据。
 *
 * magpie 的 `{ type: "api" }` 登录只保存一个字符串 key，而 MonkeyCode 需要
 * 两个独立字段（`access_token` + `signing_secret`）。三种输入都接受：
 * - 完整 JSON：`{"access_token":"oma_…","signing_secret":"…"}`（可带 session_cookie / nickname / user_id）
 * - 冒号/空白分隔：`oma_…:signing_secret`、`oma_… signing_secret`
 * - 裸 token：`oma_…`（此时没有 signing_secret，网关会 403 —— 登录时就拦下，不假装可用）
 *
 * ⚠ 刻意**不校验前缀**：上游将来可能加新前缀，把 `oma_` 写死会让新 Key 直接被判
 * 「凭据不完整」（opencode 的 IKPLRU 教训）。
 */
export function parseCredential(raw) {
  if (typeof raw !== "string") return undefined
  const text = raw.trim()
  if (text.length === 0) return undefined
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed !== "object" || parsed === null) return undefined
      if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) return undefined
      return parsed
    } catch {
      return undefined
    }
  }
  // `oma_…:<secret>` 或 `oma_… <secret>`：平台「OhMyAgent」页面把两个值分开显示，
  // 用户会很自然地把它们拼在一行里。
  const TOKEN = /^[A-Za-z0-9_.\-/+=]{16,}$/
  const pair = text.match(/^([^\s:]+)[\s:]+([^\s:]+)$/)
  if (pair && TOKEN.test(pair[1]) && TOKEN.test(pair[2])) {
    return { access_token: pair[1], signing_secret: pair[2] }
  }
  // 裸 token 只接受「像 token 的值」：含空格/中文的输入不是 token，判无效而不是硬塞。
  return TOKEN.test(text) ? { access_token: text } : undefined
}

/** 凭据是否可用（两个字段都要有）。 */
export function isUsableCredential(credential) {
  return Boolean(
    credential
    && typeof credential.access_token === "string" && credential.access_token.length > 0
    && typeof credential.signing_secret === "string" && credential.signing_secret.length > 0,
  )
}

/** 面板展示用的打码 key（`前4…后4`）；形状不合法返回空串。 */
export function maskKey(apiKey) {
  if (typeof apiKey !== "string" || apiKey.length < 12) return ""
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`
}
