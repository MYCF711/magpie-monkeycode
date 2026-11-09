// MonkeyCode 双区站点适配表。
//
// 这里只放两区确实不同的值：provider id、网关地址、平台地址、显示名、模型快照与图标。
// 共享协议实现一律在 monkeycode/ 中，不得在这里复制请求逻辑，也不得在共享逻辑里
// 按 host 写分支。
//
// 依据（2026-11-03 读取 iJetLi/dsh-providers-hub 的 src/monkeycode-product.ts）：
// - 国内站 monkeycode-ai.com、国际站 monkeycode-ai.net 是同一程序的两套部署；
// - 推理网关分别是 proxy.monkeycode-ai.com / proxy.monkeycode-ai.net，路径 /v1/messages；
// - 平台接口（额度 / 签到）在 platformBaseUrl 下，只认网页 Cookie，不认 API Key；
// - 两个站的账号池不互通（国内 cookie 打国际站回 401）。

import { MONKEYCODE_ICON } from "./monkeycode-icon.mjs"

// 网关内置目录 —— 也是唯一的目录来源（GET /v1/models 实测 405，没有远端列表）。
//
// 命名规律：
// - 带 monkeycode-basic/ pro/ ultra/ 前缀 ⇒ 走每日额度，前缀即订阅档位；
//   basic 账号请求 pro/ultra 前缀 ⇒ 403。
// - 不带前缀 ⇒ 直接扣积分。
//
// contextWindow 的声明策略照抄上游：只有 deepseek 系有实测证据（服务端 400
// 原文 "maximum context length is 1048576 tokens"），glm-5 没有证据 ——
// 未知就省略，省略比谎报更安全（窗口会被 agent 拿去算压缩阈值）。
const DEEPSEEK_CONTEXT = 1_048_576

/**
 * [magpie 的 id, 显示名, 上下文窗口（undefined = 不声明）, 上游 id（与 id 不同时才写）]
 *
 * ⚠ 这里只是**兜底快照**。真正该列的是「这个账号当前能调什么」，来源是登录后
 * `GET /api/v1/users/models` 的返回值（平台按账号权限 / 订阅给清单，2026-11-04
 * 国际站实测只回 4 条，而不是全站的 45 条）。快照只在「还没登录 / 目录一次都
 * 没拉到」时顶上，所以**刻意不带档位前缀**：
 *
 * - 带 `monkeycode-basic/` `monkeycode-pro/` `monkeycode-ultra/` 的是**同一个模型
 *   在不同额度池**里的各一条；把三档全写进兜底，basic 账号会看到一堆自己调不了的
 *   ultra 条目（2026-11-04 用户反馈：「basic 额度 pro 额度 ultra 额度还有积分计费，
 *   怎么这么多，直接捕获账号当前可用的模型就行了」）；
 * - 不带前缀的直接扣积分，是任何账号都能走的兜底口径。
 *
 * 显示名的口径是「<上游模型名> · <计费方式>」：无前缀一律 `· 积分`，带档位前缀一律
 * `· 每日额度`（判据见 docs/monkeycode-model-billing.md §4）。**同一个模型在两处的名字
 * 只许差这个后缀** —— 用户要能一眼看出「哪条走每日额度、哪条扣积分」，改前缀不改名字。
 *
 * ⚠ **magpie 的模型 id 里不能出现 `/`**（2026-11-03 真机踩到）：magpie 把
 * `<a>/<b>` 读成「provider a 的模型 b」，于是 `monkeycode-basic/deepseek-flash`
 * 这类上游 id 会凭空长出 `monkeycode-basic` / `monkeycode-pro` / `monkeycode-ultra`
 * 三个不存在的供应商，卡片的模型列表整个对不上（界面提示「已登录，但 magpie
 * 无法列出它」）。所以 magpie 里用连字符压平的 id，上游真实 id 交给 `apiId`。
 */
const MODELS = [
  ["deepseek-flash", "DeepSeek-Flash · 积分", DEEPSEEK_CONTEXT],
  ["deepseek-v4-flash", "DeepSeek-V4-Flash · 积分", DEEPSEEK_CONTEXT],
  ["deepseek-v4-pro", "DeepSeek-V4-Pro · 积分", DEEPSEEK_CONTEXT],
  ["glm-5", "GLM-5 · 积分", undefined],
]

/** 单次输出上限（Anthropic max_tokens 的默认值，上游实测可到 100000）。 */
export const DEFAULT_MAX_TOKENS = 64_000

export const SITES = Object.freeze({
  monkeycode: Object.freeze({
    id: "monkeycode",
    name: "MonkeyCode",
    displayName: "MonkeyCode 猴子编程",
    /** 推理网关 base（含 /v1，不含 /messages）。 */
    gatewayBaseUrl: "https://proxy.monkeycode-ai.com/v1",
    /** 平台站 base —— 额度 / 签到 / 换 Key 都在这边。 */
    platformBaseUrl: "https://monkeycode-ai.com",
    /**
     * 登录页。登录方式里默认就是「百智云登录 - 推荐」（两家是同一账号体系）。
     * 直接开首页会让人在窗口里自己找登录按钮 —— 开登录页少一步。
     */
    loginUrl: "https://monkeycode-ai.com/login",
    /** 网页会话 cookie 名（HttpOnly，只能从浏览器读）。 */
    sessionCookie: "monkeycode_ai_session",
    icon: MONKEYCODE_ICON,
    models: MODELS,
  }),
  monkeycodeintl: Object.freeze({
    id: "monkeycodeintl",
    name: "MonkeyCode",
    displayName: "MonkeyCode 国际版",
    gatewayBaseUrl: "https://proxy.monkeycode-ai.net/v1",
    platformBaseUrl: "https://monkeycode-ai.net",
    loginUrl: "https://monkeycode-ai.net/login",
    sessionCookie: "monkeycode_ai_session",
    icon: MONKEYCODE_ICON,
    models: MODELS,
  }),
})

/** provider id 列表（顺序即注册顺序）。 */
export const PROVIDER_IDS = Object.freeze(Object.keys(SITES))

// ── 邀请码拼进 URL ────────────────────────────────────────────────────────
//
// 为什么只有这两个函数：两家的邀请机制**只有入口 URL 这一处**（详见
// docs/baizhi-invite-research.md，2026-11-09 匿名只读探明两端公开 bundle + 匿名 302）：
//
//   · MonkeyCode 国内站：邀请码就是邀请人的 `user.id`。
//     链接 `<首页>/?ic=<code>` 只被**首页**读取（前端 `Y7e` 组件 `useSearchParams` →
//     `localStorage["ic"]`），`/login` 只从 localStorage 取值 —— 所以直接开
//     `/login?ic=` 是静默无效的，种草必须落在首页。
//     登录入口再把 localStorage 里的值拼成
//     `GET /api/v1/users/login?redirect=&inviter_id=<code>`（前端 4 处模板逐字如此）。
//   · 百智云：邀请码来自 `GET /api/v1/user/invite-code` 的 `data.invite_code`；
//     邀请链接是 `https://baizhi.cloud/sign-in?invite_code=<code>`，
//     `/sign-in` 自己会把码转进 OAuth 启动请求（`/api/v1/user/oauth/login?…&invite_code=`）。
//     ⚠ 规范域名只有 `baizhi.cloud`；`app.baizhi.cloud` 只是 SSR 兜底（本机 DNS 解析不到）。
//   · 国际站：同一份前端 bundle，但邀请链接硬编码 `.com` 域名，且它**没有**百智云 SSO
//     （`GET /api/v1/users/login` 302 到自己的 `/oauth/authorize`，`client_id=` 为空）——
//     按「国际版保持独立」，带码也一律原样。
//
// 三条语义（与 src/invite.mjs 的分工）：
//   ① `0` / `1` / 空 的「沿用当前码」由 `resolveInvite()` 处理，**到这里已经是最终码**；
//   ② 空码 ⇒ 返回 `site.loginUrl` 一字不改（日志里出现 `inviter_id=` 就一定是用户真填了）；
//   ③ 码必须 `encodeURIComponent`，否则 `a&b=c` 会拼出第二个 query 参数（静默改语义）。

/** 统一取码：非字符串、null、空白都当空码。 */
function inviteCodeOf(code) {
  return String(code ?? "").trim()
}

/**
 * 「浏览器入口」的 URL：用户在窗口里登录时开哪个地址。
 *
 * @param {typeof SITES[keyof typeof SITES] | { id: string, loginUrl: string, platformBaseUrl: string }} site
 * @param {string} [code] 已解析好的邀请码（空 = 不带）
 * @returns {string}
 */
export function loginUrlWithInvite(site, code) {
  const c = inviteCodeOf(code)
  if (!c) return site.loginUrl
  // 国内站：必须落**首页**（`/login` 不读 `?ic=`）。
  if (site.id === "monkeycode") return `${site.platformBaseUrl}/?ic=${encodeURIComponent(c)}`
  // 百智云：`/sign-in` 才读 `invite_code`（`/console/` 的登录框不读）。
  if (site.id === "baizhi") return `${site.platformBaseUrl}/sign-in?invite_code=${encodeURIComponent(c)}`
  // 国际站（及任何未知站点）：保持独立，不带邀请。
  return site.loginUrl
}

/**
 * 「SSO 入口」的 URL：直接命中登录接口，不加载 SPA 壳（`src/monkeycode/sso-import.mjs`
 * 在受控浏览器里导航的就是这条）。
 *
 * @param {typeof SITES[keyof typeof SITES] | { id: string, platformBaseUrl: string }} site
 * @param {string} [code] 已解析好的邀请码（空 = 不带）
 * @returns {string}
 */
export function ssoEntryUrlWithInvite(site, code) {
  const entry = `${site.platformBaseUrl}/api/v1/users/login`
  // 只有国内站认这条路（国际站的 client_id 是空的，见文件头）。
  if (site.id !== "monkeycode") return entry
  const c = inviteCodeOf(code)
  if (!c) return entry
  // `redirect` 是前端模板里那个恒为空的参数：留着它，形态与真实前端逐字一致。
  return `${entry}?redirect=&inviter_id=${encodeURIComponent(c)}`
}
