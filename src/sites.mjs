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
 * ⚠ **magpie 的模型 id 里不能出现 `/`**（2026-11-03 真机踩到）：magpie 把
 * `<a>/<b>` 读成「provider a 的模型 b」，于是 `monkeycode-basic/deepseek-flash`
 * 这类上游 id 会凭空长出 `monkeycode-basic` / `monkeycode-pro` / `monkeycode-ultra`
 * 三个不存在的供应商，卡片的模型列表整个对不上（界面提示「已登录，但 magpie
 * 无法列出它」）。所以 magpie 里用连字符压平的 id，上游真实 id 交给 `apiId`。
 */
const MODELS = [
  ["deepseek-flash", "DeepSeek Flash（按积分计费）", DEEPSEEK_CONTEXT],
  ["deepseek-v4-flash", "DeepSeek V4 Flash（按积分计费）", DEEPSEEK_CONTEXT],
  ["deepseek-v4-pro", "DeepSeek V4 Pro（按积分计费）", DEEPSEEK_CONTEXT],
  ["glm-5", "GLM-5（按积分计费）", undefined],
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
