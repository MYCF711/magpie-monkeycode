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

/** 缓存多久算过期（毫秒）。 */
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000

/** 缓存文件位置（按 provider 分开：国内站与国际站的目录不同）。 */
export function catalogPath(providerId) {
  return join(homedir(), ".cache", "magpie", `monkeycode-models-${providerId}.json`)
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
  const context = Number.isFinite(Number(raw.context_limit)) ? Number(raw.context_limit) : 0
  const output = Number.isFinite(Number(raw.output_limit)) ? Number(raw.output_limit) : 0
  return {
    id,
    apiId: uuid,
    name: upstream,
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

/** 缓存是否过期。 */
export function isStale(catalog, now = Date.now()) {
  return catalog === undefined || now - catalog.fetchedAt > CATALOG_TTL_MS
}

/**
 * 拉一次并落盘（后台用）。永不抛错 —— 目录刷新失败不该打断任何用户操作。
 */
export async function refreshCatalog(cookie, site, options = {}) {
  const result = await fetchCatalog(cookie, site, options)
  if (!result.ok) return false
  return writeCatalog(site.id, result.models)
}
