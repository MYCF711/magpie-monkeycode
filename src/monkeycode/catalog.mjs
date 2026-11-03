// MonkeyCode 的模型目录：平台下发的 45 条实时清单 + 本地缓存。
//
// ## 为什么不能只靠内置表
//
// 2026-11-04 实测 `GET /api/v1/users/models`（cookie 认证）返回 45 条，每条长这样：
//
//   { id: "<uuid>", provider: "BaiZhiCloud", model: "monkeycode-pro/hy3",
//     access_level: "pro", context_limit: 200000, output_limit: 32000,
//     support_image: false, thinking_enabled: true, interface_type: "anthropic",
//     is_hidden: true/false, is_free: false }
//
// 三个关键事实：
// 1. **请求体里的 `model` 必须是这个 UUID**，不是 `deepseek-v4-pro` 这种名字 ——
//    用名字打网关会回「模型不存在或无权访问」（502）。
// 2. 上下文是 **200000**，不是我们早先记的 1M。
// 3. `is_hidden: true` 的有 20 条（内部/未上架），不该显示给用户。
//
// ## 为什么目录不能现拉
//
// magpie 在**登录刚完成**的那一刻调 `provider.models`，对这次调用有时间上限；
// 在里面做网络请求会变成「已登录但 magpie 无法列出它」（2026-11-04 真机事故）。
// 所以：**拉取在后台做，钩子只读缓存**。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * 已知的真实窗口下限：实测 500K token 的请求照样 200，DeepSeek v4 系列是 1M。
 * 平台标的 200K 只是配置值，照它报会让 agent 提前丢上下文。
 */
export const KNOWN_CONTEXT = 1_048_576

/** 缓存多久算过期（毫秒）。 */
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000

/**
 * 缓存文件位置（按 provider 分开：国内站与国际站的目录不同）。
 *
 * `MAGPIE_MONKEYCODE_CACHE_DIR` 只给单测用 —— 否则测试会读到开发机上真实的
 * 账号缓存（那里面可能是「探测后全不可用 ⇒ 空表」），断言就随机器状态飘。
 */
export function catalogPath(providerId) {
  const dir = process.env.MAGPIE_MONKEYCODE_CACHE_DIR ?? join(homedir(), ".cache", "magpie")
  return join(dir, `monkeycode-models-${providerId}.json`)
}

/** 模型品牌的美化写法（平台给的是 `glm-5.3-flash` 这种小写串）。 */
const BRANDS = Object.freeze({
  glm: "GLM",
  qwen: "Qwen",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  minimax: "MiniMax",
  hy: "HY",
  gpt: "GPT",
  claude: "Claude",
})

/** 档位前缀 → 中文标签。没前缀的表示「不走订阅额度」，就不加后缀。 */
const TIERS = Object.freeze({
  "monkeycode-basic": "基础档",
  "monkeycode-pro": "专业档",
  "monkeycode-ultra": "旗舰档",
})

/**
 * 把平台的原样标识翻成人能读的名字。
 *
 * 平台给的是 `<档位>/<模型>`：`monkeycode-basic/glm-5.3-flash`、`qwen3.6-plus`…
 * 同一个模型会在不同档位各出现一条（`deepseek-flash` 有三条：无前缀 / basic / pro），
 * 因为它们是**不同的额度池**，不是同一个东西点三遍。
 *
 * @param {string} raw 平台给的 model 字段
 * @returns {string} 例如 `GLM-5.3-Flash · 基础档`
 */
export function prettyModelName(raw) {
  const text = String(raw ?? "").trim()
  if (text.length === 0) return ""
  const slash = text.indexOf("/")
  const prefix = slash > 0 ? text.slice(0, slash) : undefined
  const base = slash > 0 ? text.slice(slash + 1) : text
  // 品牌段大写、其余段首字母大写（数字段原样）。
  const parts = base.split("-").filter((part) => part.length > 0)
  // 第一段可能是「品牌+版本」连写：`qwen3.6`、`hy3`、`glm`。拆出字母前缀再映射。
  const head = parts.length > 0 ? parts[0] : base
  const matched = head.match(/^([A-Za-z]+)(.*)$/)
  const headBrand = matched
    ? (BRANDS[matched[1].toLowerCase()] ?? (matched[1].charAt(0).toUpperCase() + matched[1].slice(1))) + (matched[2] ?? "")
    : head
  const rest = parts.slice(1).map((part) => (/^[0-9]/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
  const pretty = [headBrand, ...rest].join("-")
  const tier = prefix === undefined ? undefined : TIERS[prefix]
  return tier === undefined ? pretty : `${pretty} · ${tier}`
}

/** magpie 侧的模型 id：只留 slug 字符（斜杠会被读成 provider 边界）。 */
function slugOf(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * 把平台返回的一条模型编译成缓存条目。
 * @returns {{ id: string, apiId: string, name: string, context: number, output: number, image: boolean, free: boolean } | undefined}
 */
export function entryOf(raw) {
  if (raw === null || typeof raw !== "object") return undefined
  const uuid = typeof raw.id === "string" ? raw.id.trim() : ""
  const upstream = typeof raw.model === "string" ? raw.model.trim() : ""
  if (uuid.length === 0 || upstream.length === 0) return undefined
  // 只收 Anthropic 协议的那些：OpenAI Responses 那一批走不了这个端点。
  if (typeof raw.interface_type === "string" && raw.interface_type !== "anthropic") return undefined
  const id = slugOf(upstream) || slugOf(uuid)
  if (id.length === 0) return undefined
  const platformContext = Number.isFinite(Number(raw.context_limit)) ? Number(raw.context_limit) : 0
  // 平台的 context_limit 是**软配置**，不是硬限制：2026-11-04 实测
  // `monkeycode/deepseek-flash` 标的 200000，实际 240K、500K token 的请求都是 200。
  //
  // 既然平台老实不到底，这里**直接按 1M 报**（DeepSeek v4 系列的真实窗口）：
  // magpie 用这个值决定 agent 什么时候压缩上下文，报小了它会在 200K 就开始丢历史，
  // 而模型明明还能吃 —— 用户看到的就是「请求超出其 200K 上下文，已跳过」。
  // 想更保守可以设 MAGPIE_MONKEYCODE_CONTEXT_FLOOR（只抬不压）。
  const floor = Number(process.env.MAGPIE_MONKEYCODE_CONTEXT_FLOOR ?? "")
  const known = Number.isFinite(floor) && floor > 0 ? Math.max(floor, KNOWN_CONTEXT) : KNOWN_CONTEXT
  const context = Math.max(platformContext, known)
  const output = Number.isFinite(Number(raw.output_limit)) ? Number(raw.output_limit) : 0
  return {
    id,
    // ⚠⚠ 请求体里的 `model` 必须是**平台 model 字段的原值**（带档位前缀），
    // 不是这个 UUID。2026-11-04 实测：同一个模型传 UUID 回 403 Forbidden、
    // 传 `monkeycode-basic/glm-5.3-flash` 回 200（还带 SSE 正文）。
    // 早先把它当 UUID 用，导致 21 个模型「全部不可用」的假结论。
    apiId: upstream,
    uuid,
    // 缓存里存平台的原始串；显示名由 prettyModelName 在读取时算（改文案不用重新拉目录）。
    name: upstream,
    displayName: prettyModelName(upstream),
    context,
    output,
    image: raw.support_image === true,
    free: raw.is_free === true,
  }
}

/**
 * 拉平台目录。失败返回 `{ ok: false }`，由调用方决定是否保留旧缓存。
 */
export async function fetchCatalog(cookie, site, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  if (typeof cookie !== "string" || cookie.trim().length === 0) return { ok: false, error: "没有网页会话" }
  let response
  try {
    response = await fetchImpl(`${site.platformBaseUrl}/api/v1/users/models`, {
      method: "GET",
      headers: {
        cookie: cookie.trim(),
        accept: "application/json",
        referer: `${site.platformBaseUrl}/`,
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          + "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!response.ok) return { ok: false, error: `平台目录返回 HTTP ${response.status}` }
  let payload
  try {
    payload = await response.json()
  } catch {
    return { ok: false, error: "平台目录不是 JSON" }
  }
  const body = payload?.data ?? payload
  const list = Array.isArray(body) ? body : (Array.isArray(body?.models) ? body.models : [])
  const models = []
  const seen = new Set()
  for (const raw of list) {
    // 隐藏的不是给用户选的（内部/未上架）。
    if (raw?.is_hidden === true) continue
    const entry = entryOf(raw)
    if (entry === undefined) continue
    // 同名去重：同一 model 可能按 access_level 有多条，取第一条（平台按权重排过）。
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    models.push(entry)
  }
  if (models.length === 0) return { ok: false, error: "平台目录里没有可用的 Anthropic 模型" }
  return { ok: true, models }
}

/** 写缓存。 */
export function writeCatalog(providerId, models) {
  const file = catalogPath(providerId)
  try {
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ fetchedAt: Date.now(), models }, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}

/** 读缓存；没有或损坏返回 undefined。 */
export function readCatalog(providerId) {
  try {
    const parsed = JSON.parse(readFileSync(catalogPath(providerId), "utf8"))
    if (!Array.isArray(parsed?.models) || parsed.models.length === 0) return undefined
    return { fetchedAt: Number(parsed.fetchedAt) || 0, models: parsed.models }
  } catch {
    return undefined
  }
}

/**
 * 缓存是否过期。
 *
 * 除了时间，还看**探测过没有**：老缓存（0.2.13 之前写的）没有 `usable` 字段，
 * 直接拿来用会把「点哪个都 403」的模型全列出来 —— 那种缓存视为过期，重探一次。
 */
export function isStale(catalog, now = Date.now()) {
  if (catalog === undefined) return true
  if (!catalog.models.every((model) => typeof model.usable === "boolean")) return true
  return now - catalog.fetchedAt > CATALOG_TTL_MS
}


// ── 可用性探测：平台目录列的是「上架了什么」，不是「你这个号能用什么」──
//
// 2026-11-04 实测：通过百智云 SSO 新建的账号，目录里 21 条**全部 403 Forbidden**
// （账号 `teams: []`、没有任何订阅）。把 21 条原样列给用户 = 点哪个都失败。
// 所以拉完目录后用网关自己探一遍，只留真的能出字的那些。

/**
 * 探一条：发一个 1 token 的最小请求，看网关认不认。
 *
 * @returns {Promise<boolean>} 只有真的 200 才算能用（403/404/超时一律不算）
 */
export async function probeModel(credential, site, model, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  if (typeof credential?.access_token !== "string" || credential.access_token.length === 0) return false
  if (typeof credential?.signing_secret !== "string" || credential.signing_secret.length === 0) return false
  const { createHmac } = await import("node:crypto")
  const prompt = "ping"
  const signature = "v1=" + createHmac("sha256", credential.signing_secret).update(prompt, "utf8").digest("hex")
  const body = JSON.stringify({
    model: model.apiId,
    system: prompt,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1,
    stream: true,
  })
  try {
    const response = await fetchImpl(`${site.gatewayBaseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "anthropic-version": "2023-06-01",
        "x-api-key": credential.access_token,
        "X-OhMyAgent-Signature": signature,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    // 读掉响应体，避免连接泄漏；内容我们不关心。
    await response.text().catch(() => "")
    return response.status === 200
  } catch {
    return false
  }
}

/**
 * 批量探测（并发 4）。每个模型多打一次 1 token 的请求，代价可接受。
 *
 * @returns {Promise<Array<object>>} 每条加上 `usable: boolean`
 */
export async function probeCatalog(credential, site, models, { concurrency = 4, probe = probeModel } = {}) {
  const out = []
  for (let i = 0; i < models.length; i += concurrency) {
    const batch = models.slice(i, i + concurrency)
    const results = await Promise.all(batch.map(async (model) => ({
      ...model,
      usable: await probe(credential, site, model).catch(() => false),
    })))
    out.push(...results)
  }
  return out
}

/**
 * 拉一次并落盘（后台用）。永不抛错 —— 目录刷新失败不该打断任何用户操作。
 */
export async function refreshCatalog(cookie, site, options = {}) {
  const result = await fetchCatalog(cookie, site, options)
  if (!result.ok) return false
  // 有网关凭据就顺手探一遍可用性：目录说的是「上架了什么」，
  // 这里才回答「你这个号能用什么」。
  const models = options.credential === undefined
    ? result.models
    : await probeCatalog(options.credential, site, result.models, options)
  return writeCatalog(site.id, models)
}
