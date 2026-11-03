// 百智云（BaiZhiCloud）产品配置与内置兜底模型表。
//
// 纯数据 + 纯常量，无副作用：不读环境变量、不发网络请求、不写日志。
//
// 只记录**实测过**的事实（来自 iJetLi/dsh-providers-hub 的 src/baizhi-*.ts，2026-11-03）：
// - 推理端点是 Anthropic 兼容的 `https://ai-models.app.baizhi.cloud/api/anthropic/v1/messages`，
//   头 `x-api-key` + `anthropic-version: 2023-06-01`，返回标准 Anthropic SSE；
// - 模型目录有远端：`GET …/api/anthropic/v1/models` → `{ data: [{ id, type, display_name, created_at }] }`；
// - 凭据是**长期静态 Key**（`sk-` + 64 位，共 67 字符），没有 refresh 端点、没有过期时间；
// - 与 MonkeyCode 平台完全独立：独立账号、独立凭据、按量计费、**无每日额度 / 无签到**；
// - 积分余额与 API Key 列表都在**控制台**（`baizhi.cloud`），只认网页 Cookie，`x-api-key` 打过去 401；
// - 推理 Key 来自大模型商店的 console 接口（`ai-models.app.baizhi.cloud/api/console/api-keys`）。
//
// ⚠ 两个容易搞混的「两套」：
// 1. 控制台 `baizhi.cloud/api/v1/user/api-keys` 只发 `bzy_` 前缀（15 位），
//    拿它打模型网关恒 401 —— 真正能用的推理 Key 是 console 接口的 `sk-…`；
// 2. 控制台 cookie（`baizhi_session` + `sl-session`）只够查余额和读 Key 列表，
//    **不是**推理凭据。

import { BAIZHI_ICON } from "../baizhi-icon.mjs"

/** 账号级上下文硬上限（服务端 400 原文 `maximum context length is 1048576 tokens`）。 */
export const BAIZHI_MAX_CONTEXT = 1_048_576

/** 单次输出上限（上游 `max_tokens=100000` 实测可成功）。 */
export const BAIZHI_MAX_OUTPUT_TOKENS = 100_000

/** Anthropic 协议版本头。 */
export const ANTHROPIC_VERSION = "2023-06-01"

/**
 * 已知模型能力表。
 *
 * 远端目录只给 `id` / `display_name` / `created_at`，没有任何能力字段 ——
 * 能力只从这张本地表补：窗口只在**有实测证据的 4 条 deepseek** 上声明
 * （1,048,576 是服务端 400 原文），图片只在**明确知道能看图**的模型上写 true。
 * 未知就省略，省略比谎报安全（窗口会被 agent 拿去算压缩阈值）。
 *
 * @type {ReadonlyArray<{ id: string, name: string, context?: number, image?: boolean }>}
 */
export const BAIZHI_KNOWN_MODELS = Object.freeze([
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", context: BAIZHI_MAX_CONTEXT },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", context: BAIZHI_MAX_CONTEXT },
  { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision (exp)", context: BAIZHI_MAX_CONTEXT, image: true },
  { id: "deepseek-flash", name: "DeepSeek Flash", context: BAIZHI_MAX_CONTEXT },
  { id: "minimax-m2.7", name: "MiniMax M2.7", image: true },
  { id: "minimax-m2.5", name: "MiniMax M2.5" },
  { id: "glm-5.1", name: "GLM-5.1", image: true },
  { id: "glm-5", name: "GLM-5" },
  { id: "glm-4.7", name: "GLM-4.7" },
  { id: "kimi-k2.6", name: "Kimi K2.6", image: true },
  { id: "kimi-k2.5", name: "Kimi K2.5" },
  { id: "qwen3.6-plus", name: "Qwen3.6 Plus" },
  { id: "qwen3.5-plus", name: "Qwen3.5 Plus", image: true },
  { id: "qwen3.5-flash", name: "Qwen3.5 Flash" },
  { id: "qwen-flash", name: "Qwen Flash" },
])

/** 已知能力（按模型 id 查）；未知 id 返回 undefined —— 不要返回空对象假装知道。 */
export function knownBaizhiModel(modelId) {
  if (typeof modelId !== "string") return undefined
  const id = modelId.trim()
  if (id.length === 0) return undefined
  return BAIZHI_KNOWN_MODELS.find((model) => model.id === id)
}

export const BAIZHI = Object.freeze({
  id: "baizhi",
  name: "BaiZhiCloud",
  displayName: "百智云 BaiZhiCloud",
  /** Anthropic Messages base（不含 `/messages`）。 */
  baseUrl: "https://ai-models.app.baizhi.cloud/api/anthropic/v1",
  /** 远端模型目录。 */
  modelsUrl: "https://ai-models.app.baizhi.cloud/api/anthropic/v1/models",
  /** 大模型商店（推理 Key 的真正来源）。 */
  consoleBaseUrl: "https://ai-models.app.baizhi.cloud",
  consoleApiKeysPath: "/api/console/api-keys",
  /** 控制台（余额、资料、用量）。 */
  platformBaseUrl: "https://baizhi.cloud",
  /**
   * 登录页在**主站**，不是大模型商店。
   *
   * ⚠ 两个都不能开：
   * - `ai-models.app.baizhi.cloud/console/keys`：那个 SPA 拿不到平台登录态时会
   *   `location.replace("/")` 再渲染失败页，**它没有登录入口**；
   * - `baizhi.cloud/console/login`：路由不存在，直接 404。
   * 上游用的是 `baizhi.cloud/console`（301 到 `/console/`，SPA 壳，未登录时前端给登录框）。
   */
  loginUrl: "https://baizhi.cloud/console/",
  walletBalancePath: "/api/v1/user/wallet/balance",
  walletUsagePath: "/api/v1/user/wallet/app-credit-usage",
  profilePath: "/api/v1/user/profile",
  /** 控制台认的 cookie 名（主名在前）。 */
  sessionCookies: Object.freeze(["baizhi_session", "sl-session"]),
  sessionCookie: "baizhi_session",
  icon: BAIZHI_ICON,
  models: BAIZHI_KNOWN_MODELS,
})
