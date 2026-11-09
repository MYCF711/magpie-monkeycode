// 百智云（BaiZhiCloud）magpie 插件工厂。
//
// 与 MonkeyCode 的关系：百智云是 MonkeyCode 文档站背后的模型网关，但它是
// **独立的账号体系** —— 独立凭据、按量计费，每日积分走控制台钱包领取。所以它是
// 第三个 provider，而不是 monkeycode 的一个档位。
//
// 协议要点（来自 iJetLi/dsh-providers-hub 的 src/baizhi-*.ts，2026-11-03）：
// - 推理走 Anthropic Messages：`https://ai-models.app.baizhi.cloud/api/anthropic/v1/messages`；
// - 鉴权只有 `x-api-key: sk-…`（**没有签名头**，这是与 MonkeyCode 最大的差别）；
// - 模型目录有远端（`GET …/api/anthropic/v1/models`），所以登录后能跟随平台上下架；
// - 积分与 Key 列表在控制台，只认网页 Cookie。

import { usage as buildUsage, usageWindow } from "../quota.mjs"
import { createUsageCache } from "../usage-cache.mjs"
import { createRefreshLock } from "../refresh-lock.mjs"

import { parseCredential, hasToken, signInSuccess } from "../credential.mjs"
// 出站 UA 的唯一来源（所有打上游的请求共用这一条），见 src/platform-http.mjs 的注释。
import { UA } from "../platform-http.mjs"
import { findBrowser } from "../browser-login.mjs"
import { openInSystemBrowser } from "../system-open.mjs"
import { BROWSER_LOGIN_TIMEOUT_MS, openControlledBrowser, profileDirFor, startBrowserLogin } from "../session-login.mjs"
import { readDesktopBaizhiSession } from "../monkeycode/desktop-session.mjs"
// 自动开通：百智云登录成功 → 顺手写出国内 MonkeyCode 账号（像华为云插件那样一份身份两处通用）。
// 目标站点是常量 `SITES.monkeycode`（在 provision.mjs 里），国际站**永不在**自动路径上。
// 循环依赖检查：provision / sso-import 都**不** import 本文件（baizhi → monkeycode 这条边
// 早已存在：`desktop-session.mjs`），新增两条不引入环。
import { provisionMonkeyCode, readProvisionedAccounts } from "../monkeycode/provision.mjs"
import { readBaizhiSessions, signInWithBaizhiSession } from "../monkeycode/sso-import.mjs"
import { createInviteStore } from "../invite.mjs"
import { createInvitePolicy, INVITE_PREFERRED_OPTION } from "../invite-policy.mjs"
import { loginUrlWithInvite } from "../sites.mjs"
import {
  claimDailyCredit, exchangeSessionForKey, fetchProfile, fetchUsage, fetchWallet,
} from "./credits.mjs"
import { ANTHROPIC_VERSION, BAIZHI, BAIZHI_MAX_OUTPUT_TOKENS, knownBaizhiModel } from "./site.mjs"

const SDK = "@ai-sdk/anthropic"

// ── 浏览器登录里那格**可选**输入：邀请码 ──────────────────────────────
//
// 为什么它是「同一个登录方式上的一格输入」而不是第四条登录方式：百智云的邀请
// 只在**建号那一刻**生效（码作为 query 交给
// `GET /api/v1/user/oauth/login?platform=…&invite_code=…`），事后补不了 ——
// 所以它必须出现在登录 URL 上；而 magpie 的 `prompts` 是静态数组，天生串不起
// 「先填码、再接着登录」。只有 `ask()` 能（HOOKS 四·陷阱 5）。
//
// 文案必须写清两件事（用户明确要求）：
//   ① **仅首次注册生效** —— 邀请关系只在建号时建立，老账号填了也没有奖励；
//   ② **留空 / 0 / 1 = 沿用** —— 三个数字语义在 `src/invite.mjs:resolveInvite`。
const INVITE_KEY = "invite"
const INVITE_MESSAGE = "邀请码（可选 · 只在首次注册时生效；留空 / 0 / 1 = 沿用当前码）"

// ── 同一排的第二格：**国内站 MonkeyCode 的**邀请码 ────────────────────
//
// 为什么在百智云这边问它：百智云登录成功后会自动开通国内站账号（见 finishSignIn 的
// provision 挂点），而 MonkeyCode 的邀请关系**只在建号那一刻**生效 —— 自动开通抢跑
// 就等于把上级的奖励永久用掉（docs/automatic-credential-reuse.md §5.1 的真实风险）。
// 所以必须让用户在**登录那一刻**就能把码交出来。
//
// ⚠ 两套码**不同文件**：这一格写 `monkeycode-invite.json`（与国内站「用百智云账号
// 开通」那条路同一个策略值），上面那格写 `baizhi-invite.json`。混用会让手动路径
// 读到错的码（探针 ⑧ 实测两者互不相干）。
const MC_INVITE_KEY = "monkeycodeInvite"
const MC_INVITE_MESSAGE = "MonkeyCode 邀请码（可选 · 只在首次开通国内站账号时生效；留空 / 0 / 1 = 沿用当前码）"

/**
 * magpie 侧的模型 id 安全化。
 *
 * magpie 把 `<a>/<b>` 读成「provider a 的模型 b」—— 远端目录里只要有一个 id 带
 * 斜杠，网关里就会凭空长出几个不存在的供应商，卡片提示「已登录，但 magpie 无法
 * 列出它」（2026-11-04 真机就是这个现象）。上游真实 id 交给 `apiId`。
 */
function safeModelId(raw) {
  const id = String(raw ?? "").trim()
  if (id.length === 0) return ""
  return id.replace(/[/\\]/g, "-")
}

/** 把一条模型编译成 magpie 的形状；能力只从本地已知表补，未知就不写。 */
function modelEntry(site, rawId, name) {
  const apiId = String(rawId ?? "").trim()
  const id = safeModelId(apiId)
  const known = knownBaizhiModel(apiId)
  const context = known?.context
  const image = known?.image === true
  return {
    id,
    // 上游 id 与 magpie 的 id 不同时用 apiId 带上（发请求时用它）。
    ...(apiId === id ? {} : { apiId }),
    name: name ?? known?.name ?? id,
    api: { id: apiId, url: site.baseUrl, npm: SDK },
    status: "active",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    // context 为 0 = 厂商没有下发窗口，不编造（agent 据此决定何时压缩）。
    limit: { context: context ?? 0, output: BAIZHI_MAX_OUTPUT_TOKENS },
    modalities: { input: image ? ["text", "image"] : ["text"], output: ["text"] },
    capabilities: {
      temperature: true,
      // 百智云没有下发「每个模型支持哪些思考档位」的元数据 —— 编一张表就是假能力。
      reasoning: false,
      toolcall: true,
      attachment: image,
      // 五个模态键必须显式写布尔：省略 ≠ text，会被 models.dev 裸 id 投票误判。
      input: { text: true, image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

/** 静态目录（未登录 / 远端失败时的兜底）。 */
function staticModels(site) {
  const out = {}
  for (const model of site.models) out[model.id] = modelEntry(site, model.id, model.name)
  return out
}

/** 凭据 → 可用的 token；不可用返回 undefined。 */
function credentialOf(auth) {
  if (!auth) return undefined
  const raw = auth.type === "api" ? auth.key : auth.access
  const credential = parseCredential(raw)
  return hasToken(credential) ? credential : undefined
}

/** 下一个北京时间 0 点（毫秒）。每日积分按这个时刻过期 —— 上游只给「零点」这种说法。 */
function nextUtc8Midnight(now = Date.now()) {
  const offset = 8 * 3_600_000
  const local = now + offset
  return (Math.floor(local / 86_400_000) + 1) * 86_400_000 - offset
}

/** 读一次积分并拼成 magpie 的 usage 形状。 */
async function readUsage(site, credential, fetchImpl) {
  const cookie = credential.session_cookie
  if (typeof cookie !== "string" || cookie.trim().length === 0) {
    return {
      // ⚠ 不指向已经下线的方式：百智云只剩「从本机客户端导入」与「浏览器登录」两条路
      //   （2026-11-09 用户要求），点「改 Key」补 session cookie 那个入口不存在了。
      error: "未配置网页会话（session_cookie）—— 推理可用，但积分余额只认网页登录态。"
        + "请用「浏览器登录」重新登录一次（或在装了 MonkeyCode 桌面客户端的机器上用"
        + "「从本机客户端导入」）—— 这两条都会把会话一起存下来。",
      windows: [],
    }
  }
  const wallet = await fetchWallet(cookie, site, { fetchImpl })
  if (!wallet.ok) return { error: wallet.error, windows: [] }
  const usage = await fetchUsage(cookie, site, { fetchImpl }).catch(() => ({ ok: false }))

  const windows = []
  // 主行：可用积分（temporary + permanent − frozen，上游已经算好）。
  windows.push(usageWindow({ name: "可用积分", balance: wallet.wallet.available, unit: "积分" }))
  // 每日积分：零点过期 —— 用官方字段 runsOutAt + runsOut 表达，不拼进 display。
  if (wallet.wallet.temporary > 0) {
    windows.push(usageWindow({
      name: "每日积分",
      balance: wallet.wallet.temporary,
      unit: "积分",
      runsOutAt: new Date(nextUtc8Midnight()).toISOString(),
      runsOut: wallet.wallet.temporary,
    }))
  }
  if (wallet.wallet.permanent > 0) {
    windows.push(usageWindow({ name: "充值积分", balance: wallet.wallet.permanent, unit: "积分" }))
  }
  if (usage.ok && usage.usage.todayCredit > 0) {
    windows.push(usageWindow({
      name: "今日消耗",
      textOnly: true,
      display: `${usage.usage.todayCredit} 积分 / ${usage.usage.todayCalls} 次调用`,
    }))
  }
  return buildUsage({ plan: "百智云（按量计费）", windows })
}

// ── 登录：百智云控制台会话 → sk- API Key ─────────────────────────────
//
// 控制台同时下发两枚 cookie，**两枚都要**：只带 baizhi_session 时
// /api/v1/user/profile 会 401。且必须精确落在 baizhi.cloud 上 —— 同名
// sl-session 还有两枚属于 ai-models / agent-toolkit 子域。
const CONSOLE_COOKIES = Object.freeze(["sl-session", "baizhi_session"])
const CONSOLE_DOMAINS = Object.freeze(["baizhi.cloud"])

/**
 * cookie 到手之后的收尾：换 sk- Key + 读资料，拼成 magpie 的登录结果。
 *
 * @param {string} cookie 百智云会话串
 * @param {object} site 站点适配器（`BAIZHI`）
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] 测试注入用
 * @param {(cookie: string, extra: { signal?: AbortSignal, identity?: string, inviteCode?: string }) => Promise<unknown>} [options.provision]
 *   **自动开通**国内站的钩子（由工厂注入）。**不 await**：见下方注释。
 * @param {AbortSignal} [options.signal] magpie 取消这次登录时给的那个
 * @param {(targetIdentity?: string) => { monkeycodeCode: string }} [options.inviteResolver]
 *   本次 authorize 的策略快照；这里才知道 targetIdentity，自邀时必须给空猴码。
 */
async function finishSignIn(cookie, site, { fetchImpl, provision, signal, inviteResolver } = {}) {
  // ⚠ 走**缓存**：accept() 为了判「登完了没有」已经兑换过一次了。再兑换一次不只是
  //   多发一个请求 —— `exchangeSessionForKey` 在账号下半把 sk- 都没有时会**新建一把**，
  //   每重试一次就多签一把 Key。`needsKeyCreation` 这种中间态只复用这一次（取走即删），
  //   下一次「重试」会重新请求上游 —— 否则用户建好 Key 也恢复不了。
  const exchanged = await exchangeForSignIn(cookie, site, { fetchImpl })
  if (!exchanged.ok) {
    // 账号下一把 sk- 都没有：**把建 Key 的页面直接打开**。
    // magpie 的错误面板里链接不可点，只写 URL 等于让用户手抄。
    //
    // 优先用受控浏览器（持久 profile 里就是刚登进去的登录态，打开就是已登录的
    // 建 Key 页）；它起不来再退回系统默认浏览器。
    if (exchanged.needsKeyCreation === true && typeof exchanged.keysUrl === "string") {
      await openKeyPage(exchanged.keysUrl)
    }
    return {
      type: "failed",
      error: `百智云：已读到网页登录态，但换取 sk- 密钥失败（${exchanged.error}）。`
        + "登录态是好的，请点一次「重试」；连续失败就重开一次「浏览器登录」。",
    }
  }
  const profile = await fetchProfile(cookie, site, { fetchImpl })
  const result = signInSuccess({
    access: JSON.stringify({
      access_token: exchanged.apiKey,
      session_cookie: cookie,
      ...(profile?.userId === undefined ? {} : { user_id: profile.userId }),
    }),
    expires: 0,
    accountId: profile?.name ?? "",
    uid: profile?.userId ?? "",
  })
  // ── 自动开通国内站账号（fire-and-forget）───────────────────────────
  //
  // 三条硬约束，任何一条被破坏都会伤到用户（docs/automatic-credential-reuse.md §3.4）：
  //   ① **不 await**：一次 SSO 要 5~90 秒（起一次无头 Chromium）。等它 = 登录面板
  //      一直转圈，用户以为插件挂了。
  //   ② **失败不许改变百智云的结果**：自动开通是"顺手做的事"，它挂了也只是少一张
  //      MonkeyCode 卡，百智云的登录必须照旧成功（`.catch(() => {})` 兜住，避免
  //      unhandled rejection 把宿主带崩）。
  //   ③ **只在百智云这条路上**：`site.id` 守卫 + provision 目标站点是常量
  //      `SITES.monkeycode` —— 国际站永远不会被自动写。
  //
  // `identity` 必须是**百智云账号身份**（与 `readBaizhiSessions` 的口径一致，即 profile
  // 的 userId）：它是幂等键，取不到就退回 sk- 密钥（provision 那边对空 uid 一律不写）。
  //
  // ⚠ 用 `Promise.resolve().then(...)` 而不是直接 `void provision(...)`：provision
  //   **同步抛错**时（例如它内部第一行就 throw），直接调用会把 finishSignIn 变成
  //   rejected —— 自动开通的锅会砸到百智云登录上。包一层微任务，同步 throw 也进 catch。
  if (typeof provision === "function" && site.id === "baizhi") {
    const identity = profile?.userId ?? exchanged.apiKey
    void Promise.resolve().then(() => {
      // 自动 provision 是第一个能确知 targetIdentity 的邀请挂点：resolver 返回
      // mode=skip 时 monkeycodeCode 为空，绝不拿其它账号的码补回来。
      const inviteCode = typeof inviteResolver === "function"
        ? inviteResolver(identity).monkeycodeCode
        : ""
      return provision(cookie, { signal, identity, inviteCode })
    }).catch(() => {})
  }
  return result
}

// ── 兑换结果缓存：**同一份 cookie 只兑换一次** ────────────────────────
//
// 两个理由，各对应一次真机/成本事故：
//   ① 「读到 cookie ≠ 登录成功」：受控窗口一打开就有匿名 cookie（两枚都在，只是
//      没登录）。accept() 恒返回 true 会把「刚打开窗口」当成登录完成 → 换 Key
//      失败 → 用户白登一次（2026-11-04 真机，docs/login-unification-audit.md §3.4-a）。
//      所以 accept 必须**真的试一次**兑换。
//   ② 既然试过了，就不能再兑一次：`exchangeSessionForKey` 在账号下没有 sk- 时会
//      POST 新建一把，登录轮询每秒一次 —— 不缓存会在几分钟里签出一堆 Key。
//
// ⚠ 只有 `ok`（真的换出了 sk-）是**定论**，可以永久缓存。
// `needsKeyCreation` 是「这一次没换到 Key」的**中间态**：用户会去控制台点一次
// 「新建」，然后回来「重试」—— 那一下必须重新请求上游。把它当定论缓存会让用户
// **永远恢复不了**（建好 Key 也还是读到旧的 needsKeyCreation，只能重启进程；
// 2026-11-09 实现级复核发现的 t8 缺陷，回归见 tests/multi-provider.test.mjs）。
//
// 但同一次登录里 accept() 已经兑换过，finishSignIn 不能再来一次（多兑一次就多
// 签一把 Key）—— 所以中间态走**一次性交接**：accept 存、finishSignIn 取走即删，
// accept 自己**不读**它（读了就退化成永久缓存）。
//
// ⚠ 还有第三个缓存：**轮询负缓存**（2026-11-09 独立审核 H1 引入的真实回归）。
// `acceptBrowserCookie` 在 `browserLogin` 的循环里**每秒**被调一次
// （`src/session-login.mjs:322` 的 `BROWSER_LOGIN_POLL_MS = 1_000`），而窗口刚打开时
// 拿到的是**匿名会话**：
//
//   · 匿名（401）→ 每秒 1 次 `GET …/api/console/api-keys`，最长 240 秒 = ~240 次；
//   · `needsKeyCreation` → 每秒重跑一遍「列 Key → POST 建 Key → 再列」。
//     POST 是真建 Key：上游「建成功但列表还没同步」（最终一致性）时，用户登录的那
//     一分钟里会在**自己账号下静默签出几十把 `magpie` Key**。
//
// 所以非 ok 的结果进**短命**负缓存（5 秒 / 轮询 1 秒 ⇒ 5 次轮询最多 1 次上游）。
// ⚠ 它**只给 accept 轮询用**：`exchangeForSignIn`（登录收尾）绝不读它 ——
//   收尾是「用户主动重试」的语义，读了就回到 t15 修的那个「建好 Key 也恢复不了」。
const EXCHANGE_CACHE_LIMIT = 16
/** 定论（`ok: true`），键 = `<provider id>\n<cookie>`（不同账号的 cookie 不同）。 */
const exchangeCache = new Map()
/** 一次性交接（`needsKeyCreation`）：只给**同一次登录**的 finishSignIn 用，取走即删。 */
const pendingExchange = new Map()
/** 轮询负缓存（非 ok）：`{ result, at }`，只给 accept 用，5 秒过期。 */
const negativeExchange = new Map()
/** 负缓存寿命：轮询间隔 1 秒的 5 倍（够挡住「窗口刚开」的匿名会话，又不至于让用户等）。 */
const NEGATIVE_TTL_MS = 5_000

/** 写入并维持上限（Map 保序：删了再塞就排到队尾，超限先淘汰最旧的）。 */
function remember(map, key, value) {
  map.delete(key)
  map.set(key, value)
  while (map.size > EXCHANGE_CACHE_LIMIT) map.delete(map.keys().next().value)
}

/** 读负缓存：过期的当场删掉（否则会一直占着 LRU 名额）。 */
function readNegative(key, now = Date.now()) {
  const hit = negativeExchange.get(key)
  if (hit === undefined) return undefined
  if (now - hit.at >= NEGATIVE_TTL_MS) {
    negativeExchange.delete(key)
    return undefined
  }
  return hit.result
}

/** 真去兑换一次，并按结果分流到「定论」「一次性交接」与「轮询负缓存」。 */
function performExchange(cookie, site, { fetchImpl } = {}) {
  const key = `${site.id}\n${cookie}`
  return exchangeSessionForKey(cookie, site, { fetchImpl }).then((result) => {
    if (result?.ok === true) remember(exchangeCache, key, result)
    // 中间态：留给同一次登录的 finishSignIn，别让它再 POST 一把 Key；**下次重试会重新请求**。
    else if (result?.needsKeyCreation === true) remember(pendingExchange, key, result)
    // 非 ok 一律进轮询负缓存（含 needsKeyCreation）：否则每秒重打一次上游。
    if (result?.ok !== true) remember(negativeExchange, key, { result, at: Date.now() })
    return result
  })
}

/**
 * 兑换一次（**accept 用**）：定论缓存 → 轮询负缓存 → 真的去兑换。
 *
 * ⚠ 负缓存只在这里读（accept 每秒被调一次），**绝不在 `exchangeForSignIn` 里读**。
 *
 * @param {string} cookie 会话串
 * @param {object} site 站点适配器
 * @param {{ fetchImpl?: typeof fetch }} [options] 测试注入用；默认全局 fetch
 */
function exchangeOf(cookie, site, { fetchImpl } = {}) {
  const key = `${site.id}\n${cookie}`
  const settled = exchangeCache.get(key)
  if (settled !== undefined) {
    remember(exchangeCache, key, settled) // 命中即刷 LRU 顺序
    return Promise.resolve(settled)
  }
  // 5 秒内的第二次轮询直接复用上一次的「还没好」，不再打上游。
  const throttled = readNegative(key)
  if (throttled !== undefined) return Promise.resolve(throttled)
  return performExchange(cookie, site, { fetchImpl })
}

/**
 * 兑换一次（**finishSignIn 用**）：先复用 accept 刚拿到的一次性结果，取走即删；
 * 没有（或已被取走）就正常请求上游。
 *
 * ⚠ **不读**轮询负缓存（H1 的反面）：收尾是用户主动重试的语义，读了就永远恢复不了。
 * 反过来还要把它**清掉** —— 收尾之后的下一次 accept 必须重新请求上游。
 *
 * @param {string} cookie 会话串
 * @param {object} site 站点适配器
 * @param {{ fetchImpl?: typeof fetch }} [options] 测试注入用；默认全局 fetch
 */
function exchangeForSignIn(cookie, site, { fetchImpl } = {}) {
  const key = `${site.id}\n${cookie}`
  // 从「轮询」切到「收尾」：负缓存立刻作废，否则用户建好 Key 回来重试会读到旧的
  // needsKeyCreation（t15 的 recovery 用例就是这么红的）。
  negativeExchange.delete(key)
  const settled = exchangeCache.get(key)
  if (settled !== undefined) {
    remember(exchangeCache, key, settled)
    return Promise.resolve(settled)
  }
  const pending = pendingExchange.get(key)
  if (pending !== undefined) {
    // 取走即删：下一次「重试」必须重新请求上游，否则建好 Key 也恢复不了。
    pendingExchange.delete(key)
    return Promise.resolve(pending)
  }
  return performExchange(cookie, site, { fetchImpl })
}

/**
 * 候选 cookie 算不算「登录完成」。
 *
 * 判据（照抄 `src/monkeycode/runtime.mjs` 的 issued 写法）：
 *   · 换出 `sk-` Key        → true（登录完成，结果进定论缓存，finishSignIn 直接取）
 *   · 已登录但一把 Key 都没有 → true（needsKeyCreation：finishSignIn 会打开建 Key 页）
 *   · 401 / 403             → false（窗口里的匿名会话，用户还没登完，继续等）
 *   · 网络失败 / 非 JSON 200 → false（DNS / 超时 / 被重定向到登录页，继续等）
 *
 * ⚠ 这里**不许**用「cookie 到齐了」当判据 —— 那正是要修的 bug。
 * ⚠ `needsKeyCreation` 的结果**不进**定论缓存（只做一次性交接）：用户建完 Key 回来
 *   「重试」时必须重新请求上游，否则永远停在「需要建 Key」上。
 * ⚠ 非 ok 的结果进**5 秒轮询负缓存**（`exchangeOf` 里读）：这个方法在受控窗口里
 *   每秒被调一次，没有负缓存就是每秒一次上游请求 / 每秒 POST 建一把 Key（H1）。
 *   `MAGPIE_PLUGIN_DISABLE_BROWSER=1` 下没有轮询，这条只影响真机。
 *
 * @param {string} cookie 候选会话串（`sl-session=…; baizhi_session=…`）
 * @param {object} site 站点适配器（`src/baizhi/site.mjs` 的 `BAIZHI`）
 * @param {{ fetchImpl?: typeof fetch }} [options] 测试注入用；默认全局 fetch
 * @returns {Promise<boolean>}
 */
export async function acceptBrowserCookie(cookie, site, { fetchImpl } = {}) {
  if (typeof cookie !== "string" || cookie.trim().length === 0) return false
  let result
  try {
    result = await exchangeOf(cookie, site, { fetchImpl })
  } catch {
    // 网络层抛错不是「凭据坏了」，继续等窗口里的下一次轮询。
    return false
  }
  return result?.ok === true || result?.needsKeyCreation === true
}

/**
 * 在 `authorize()` 里就把窗口支起来。
 *
 * ⚠ 不能等到 `callback()` 才启动：magpie 的登录面板在 authorize 返回后就进入
 * 等待态，而启动浏览器要查注册表、要等进程起来。等 callback 才启动的话，用户
 * 会先看到一块「正在开始登录…」而屏幕上一个窗口都没有（2026-11-04 真机报障）。
 *
 * 启动失败时**抛错**，由调用方把 `opened` 置 false —— magpie 会替你打开系统
 * 浏览器，用户至少能登进去。
 *
 * @param {object} site 站点适配器
 * @param {object} [options]
 * @param {string} [options.url] 登录地址（带邀请码时是 `loginUrlWithInvite` 的结果）
 * @param {AbortSignal} [options.signal]
 * @param {object} [options.browser] `findBrowser()` 的结果
 * @param {boolean} [options.reuseProfile] 复用持久 profile（建 Key 页用；登录不用）
 * @param {Function} [options.start] **测试接缝**：默认 `startBrowserLogin`。
 *   单测不能用真浏览器（会起 Chromium），又必须证明这里的 `accept` 真的接到了
 *   `acceptBrowserCookie` —— 注入一个假的 `start` 拿回 options，就能对
 *   `accept(匿名) === false` / `accept(真会话) === true` 做**行为**断言
 *   （变异成 `accept: async () => true` 必须真红，见 docs/final-review.md M3）。
 */
async function startBaizhiBrowserLogin(site, { signal, browser, reuseProfile = false, url, start = startBrowserLogin } = {}) {
  return await start({
    url: url ?? site.loginUrl,
    ...(browser === undefined ? {} : { browser }),
    // **一次性 profile**（默认）：加第二个号就是再点一次「浏览器登录」，
    // 窗口里不会带着上一个号的登录态（复用会读到旧 cookie，magpie 按 uid 去重，
    // 用户看到「提示已添加、列表没变」）。
    ...(reuseProfile ? { profileDir: profileDirFor("baizhi") } : {}),
    cookieNames: [...CONSOLE_COOKIES],
    cookieDomains: [...CONSOLE_DOMAINS],
    timeoutMs: BROWSER_LOGIN_TIMEOUT_MS,
    signal,
    // 两枚到齐只是**候选**：必须真的换出 Key 才算登录完成（匿名 cookie 会被拒绝，
    // 继续等窗口里的下一次轮询）。判据与缓存都在 acceptBrowserCookie 里。
    accept: (cookie) => acceptBrowserCookie(cookie, site),
  })
}

/**
 * 打开「建 API Key」页面，等用户点一次「新建」。
 *
 * 用**受控浏览器 + 同一个持久 profile**：那里就是刚登录的百智云控制台，
 * 打开即是已登录状态，用户只需要点一下「新建」。窗口故意不关 —— 用户建完
 * 自己关掉，回来点 magpie 的「重试」即可（重试会重新读一次 key 列表）。
 */
async function openKeyPage(keysUrl) {
  if (process.env.MAGPIE_PLUGIN_DISABLE_BROWSER === "1") return
  const browser = findBrowser()
  if (!browser?.path) {
    // 连浏览器都没有：交给系统默认浏览器，至少地址是能点的。
    openInSystemBrowser(keysUrl)
    return
  }
  try {
    await openControlledBrowser({ url: keysUrl, profileDir: profileDirFor("baizhi"), browser })
    // 不 close：留给用户操作。
  } catch {
    openInSystemBrowser(keysUrl)
  }
}

/**
 * 受控窗口起不来时的说明：只能让用户自己在浏览器里登完，回来重试。
 *
 * ⚠ 不许再指向已经下线的入口（2026-11-09 用户要求百智云只保留「从本机客户端导入」
 * 与「浏览器登录」）：早先这里写的是「改用 API Key 方式粘贴一行 JSON」，那个方式
 * 现在不存在了，照抄等于让用户在一个空面板里找按钮。
 *
 * @param {object} site 站点适配器
 * @param {string} reason 起不来的原因（显示给用户）
 * @param {string} [url] 要用户手动打开的地址（带邀请码时是 `loginUrlWithInvite` 的结果）
 */
function manualCookieHint(site, reason, url = site.loginUrl) {
  return `受控浏览器窗口没能启动（${reason}）。`
    + `请手动打开 ${url} 登录百智云。`
    + "插件读不到系统浏览器的 Cookie，所以登录完请回来点一次「重试」——"
    + "用受控窗口再走一遍就能拿到会话；"
    + "装了 MonkeyCode 桌面客户端的机器也可以直接改用「从本机客户端导入」。"
}

/**
 * 造百智云的插件实例。
 *
 * @param {object} [site] 站点适配器（默认 `BAIZHI`；测试会传假的）
 * @returns {(ctx?: object, options?: object) => Promise<object>} magpie 的插件工厂
 */
export function makeBaizhiPlugin(site = BAIZHI) {
  // ⚠ 两个形参都要有默认值：magpie 与单测都按 `factory({ client: {} })` 调，但
  //   `ctx` 历史上是被丢掉的（`_ctx`）。自动开通要用 `ctx.client` 的 `auth.set`，
  //   所以这里必须真的收下来；缺 `client` 时 provision 自己会 `skipped:"no-client"`
  //   （单测就靠这条：0 次写、不抛）。
  return async (ctx = {}, options = {}) => {
    const client = ctx?.client
    const usageCache = createUsageCache({ ttlMs: 60_000, failTtlMs: 5_000 })
    // 同一实例、同一账号的并发领取只跑一条 PoW + POST 链；不回放，后续调用重新读幂等状态。
    const checkinLock = createRefreshLock({ replayMs: 0 })
    // 邀请码策略（`~/.cache/magpie/baizhi-invite.json`）。**按插件实例**建，
    // 不用模块级单例：`createInviteStore` 在创建时就定下文件路径，多账号/多实例
    // 共用一个对象在测试里会串（而且它本来就只读写磁盘，没有内存状态）。
    const inviteStore = createInviteStore(site.id)
    // 国内站 SSO 的邀请码策略：与「用百智云账号开通」那条手动路**同一个文件**
    // （`monkeycode-invite.json`）。百智云那份 `baizhi-invite.json` 永不参与自动开通。
    const monkeycodeInvite = createInviteStore("monkeycode")
    // 两站共享首选 identity；文件由 createInviteStore 命名为 baizhi-invite-source-invite.json。
    const preferredInviteSource = createInviteStore("baizhi-invite-source")
    const invitePolicy = createInvitePolicy({
      ctx,
      provider: site.id,
      dualManual: true,
      preferredStore: preferredInviteSource,
      baizhiInviteStore: inviteStore,
      monkeycodeInviteStore: monkeycodeInvite,
      readBaizhiAccounts: readBaizhiSessions,
      readMonkeycodeAccounts: () => readProvisionedAccounts("monkeycode"),
      manual: {
        baizhi: { key: INVITE_KEY, message: INVITE_MESSAGE },
        monkeycode: { key: MC_INVITE_KEY, message: MC_INVITE_MESSAGE },
      },
    })
    /**
     * 自动开通：百智云登录成功 → 写出国内 MonkeyCode 账号。
     *
     * 默认实现走 `provisionMonkeyCode`：inviteCode 只能来自本次 authorize 的
     * resolver（含 targetIdentity 自邀跳过），不再绕回手动 store 另选一份。
     */
    const provision = options.provision ?? ((cookie, { signal, identity, inviteCode = "" } = {}) => provisionMonkeyCode({
      client,
      cookie,
      signal,
      identity,
      inviteCode,
      sso: signInWithBaizhiSession,
      // 一行脱敏说明；宿主没给 app.log 就算了（不为了日志把登录搞挂）。
      log: (message) => client?.app?.log?.({ body: { level: "info", service: "baizhi", message } }),
    }))

    return {
      // ── ① 声明 provider ────────────────────────────────────────────
      config: async (config) => {
        config.provider ??= {}
        config.provider[site.id] ??= {}
        const provider = config.provider[site.id]
        provider.name ??= site.displayName
        provider.npm ??= SDK
        provider.api ??= site.baseUrl
        provider.models = { ...staticModels(site), ...(provider.models ?? {}) }
      },

      // ── ⑧ 每请求加头 ───────────────────────────────────────────────
      "chat.headers": async (input, output) => {
        const id = input?.model?.providerID ?? input?.provider?.info?.id
        if (id !== site.id || !input?.sessionID) return
        output.headers["x-baizhi-session"] = String(input.sessionID).slice(0, 128)
      },

      // ── ⑦ 每账号的模型目录 ─────────────────────────────────────────
      provider: {
        id: site.id,
        /**
         * 模型目录：**纯静态、不发网络**。
         *
         * ⚠ 这里刻意不调远端目录（2026-11-04 真机事故）：magpie 在**登录刚完成**
         * 的那一刻就会调用这个钩子，而它对这次调用有时间上限。只要这里做一次网络
         * 请求，就多一个「远端慢/挂住 → 插件被判定列不出模型 → 卡片报『已登录，但
         * magpie 无法列出它』」的失败面。守护对象的正确性优先于目录新鲜度。
         *
         * `src/baizhi/credits.mjs` 的 `fetchRemoteModels` 留着：将来若要做「后台刷新
         * 缓存、下次启动用缓存」，它仍然可用 —— 但**不能**放进这条同步路径。
         */
        async models(provider) {
          const base = provider ?? {}
          return { ...staticModels(site), ...(base.models ?? {}) }
        },
      },

      // ── ②③④⑤ 登录 / 续期 / 请求接管 / 额度 ────────────────────────
      auth: {
        provider: site.id,
        icon: site.icon,
        maxConcurrency: 4,
        refreshLead: 5 * 60_000,
        options: [{ ...INVITE_PREFERRED_OPTION }],

        /**
         * 百智云只保留**两条**登录路（2026-11-09 用户要求）：
         *   ① 从本机客户端导入 —— 桌面客户端里已经登录过的会话，零交互换 `sk-` 密钥；
         *   ② 浏览器登录       —— 一次性干净窗口，五种官方方式由**用户自己挑**。
         *
         * 下线的两条**入口**（不是下线的能力）：
         *   · API Key（`type: "api"`）—— 用户要求「百智云只保留本机导入与浏览器登录」；
         *   · 手机号 + 短信验证码 —— 同上。`src/baizhi/phone-login.mjs` 的实现留着
         *     （`tests/baizhi-phone-login.test.mjs` 直接引那个模块），只是不再有面板入口。
         *
         * ⚠ 老账号已经落盘的 `{ type: "api", key }` 凭据**照旧能用**：`credentialOf()`
         *   与 `loader` 一个字都没动 —— 删入口只影响「新登录」，不影响已经在用的号。
         */
        methods: [
          {
            type: "oauth",
            label: `${site.displayName} 从本机客户端导入`,
            /**
             * 读本机 **MonkeyCode 桌面客户端**里存着的百智云会话，直接换 `sk-` 密钥。
             *
             * 桌面客户端是 Tauri + WebView2，登录完把 cookie 明文写成 JSON：
             * `%APPDATA%\\com.chaitin.baizhi.monkeycode\\baizhi-cookies.json`
             * （`sl-session` ×3 个域 + `baizhi_session` + `bz_phone_code_session`）。
             *
             * 一个观猹账号在桌面端登录一次，**同时**拿到 MonkeyCode 与百智云两套凭据 ——
             * 所以这个方法和 MonkeyCode 那个同名方法共用同一份桌面数据，只是换的凭据不同。
             */
            async authorize(inputs = {}) {
              const desk = readDesktopBaizhiSession()
              if (desk === undefined) {
                // 文案不指向已经下线的方式（API Key 入口没了）：只留「先登录桌面版」
                // 与「改用浏览器登录」这两条真的还在的路。
                const help = "没读到本机 MonkeyCode 桌面客户端的百智云登录态。"
                  + "先用桌面版登录一次（登录成功后它会把会话写到本机），再回来点这个；"
                  + "也可以改用「浏览器登录」。"
                return {
                  url: site.loginUrl,
                  opened: false,
                  method: "auto",
                  instructions: help,
                  async callback() {
                    return { type: "failed", error: "本机没有 MonkeyCode 桌面客户端的百智云登录态" }
                  },
                }
              }
              // 本机导入不重登百智云，但后续自动 provision 仍必须使用同一份邀请策略。
              const inviteResolver = invitePolicy.prepare(inputs)
              return {
                url: site.loginUrl,
                // 不弹任何窗口；opened:true 只是告诉 magpie 别再开系统浏览器。
                opened: true,
                method: "auto",
                instructions: "正在用本机 MonkeyCode 客户端里的百智云登录态开通（不会弹任何窗口）。",
                // 宿主调 callback 时**确实传**第二个参数（`{ signal }`，见
                // docs/automatic-credential-reuse.md §1.1 的 host:2533-2541）；另一条
                // 路传 `undefined`，所以形参必须有默认值。
                async callback(_code, { signal } = {}) {
                  try {
                    return await finishSignIn(desk.cookie, site, { provision, signal, inviteResolver })
                  } catch (error) {
                    return { type: "failed", error: error instanceof Error ? error.message : String(error) }
                  }
                },
              }
            },
          },
          {
            type: "oauth",
            label: `${site.displayName} 浏览器登录`,
            /**
             * 可选输入：**两个邀请码**（同一个登录方式上的两格输入，不是新按钮）。
             *
             *   ① `invite`            —— 百智云自己的 `invite_code`（`/sign-in?invite_code=`）；
             *   ② `monkeycodeInvite`  —— 国内站 MonkeyCode 的 `inviter_id`，给下面
             *      `finishSignIn` 的**自动开通**用（百智云登录成功就顺手开一个国内站账号）。
             *
             * 两家的邀请都只在**建号那一刻**生效（码作为 query 交给 OAuth 启动请求），
             * 事后补不了；而 magpie 的 `prompts` 是静态数组，串不起「先填码、再登录」——
             * 只有 `ask()` 能（HOOKS 四·陷阱 5）。
             *
             * 语义（用户明确要求，逐字写进文案）：
             *   · 仅**首次注册 / 首次开通**生效 —— 老账号填了也不建立邀请关系；
             *   · 留空 / `0` / `1` = **沿用**当前码（`src/invite.mjs:resolveInvite`）。
             *
             * URL 由 `src/sites.mjs:loginUrlWithInvite()` 拼（纯函数、已被
             * `tests/invite-url.test.mjs` 锁死：`/sign-in?invite_code=`，空码一字不改）。
             * ⚠ 两格写**两个不同的策略文件**（`baizhi-invite.json` / `monkeycode-invite.json`）：
             *   混用会让国内站手动路径读到错的码。
             */
            get prompts() {
              return invitePolicy.prompts()
            },
            async ask(inputs = {}) {
              // off + 有账号：不问；on：先选来源；manual / 无账号才问两格手动码。
              return invitePolicy.ask(inputs)
            },
            async authorize(inputs = {}) {
              // resolver 同时决定浏览器 URL 与后续自动 provision；两家手动码独立落盘。
              const inviteResolver = invitePolicy.prepare(inputs)
              const resolved = inviteResolver()
              const code = resolved.baizhiCode
              const mcCode = resolved.monkeycodeCode
              const loginUrl = loginUrlWithInvite(site, code)

              // ① 同步探测有没有浏览器可用（findBrowser 只查路径，不启动进程）。
              //    测试环境用 MAGPIE_PLUGIN_DISABLE_BROWSER=1 门闩关掉真启动。
              const browser = process.env.MAGPIE_PLUGIN_DISABLE_BROWSER === "1" ? undefined : findBrowser()
              if (!browser?.path) {
                const error = manualCookieHint(site, "这台机器上没有找到 Chrome / Edge / 国产 Chromium", loginUrl)
                return {
                  url: loginUrl,
                  // 插件开不了，交给 magpie 开系统浏览器。
                  opened: false,
                  method: "auto",
                  instructions: error,
                  async callback() {
                    return { type: "failed", error }
                  },
                }
              }
              // ② **先真的把窗口起来，再决定 opened**。
              //
              // 早先是「后台起飞 + 立刻 opened: true」，但 magpie 的宿主环境里
              // spawn 不一定会成功（2026-11-04 真机：窗口没弹、面板卡在「正在开始
              // 登录…」、又因为没有 opened:false 而没人去开系统浏览器）。
              // 现在最多等 8 秒：起来了就 opened:true 自己等；起不来就 opened:false，
              // 让 magpie 去开系统浏览器，并且把手动步骤写进说明。
              let flow
              let startupError = ""
              try {
                flow = await Promise.race([
                  startBaizhiBrowserLogin(site, { browser, url: loginUrl }),
                  new Promise((_, reject) => setTimeout(() => reject(new Error("浏览器启动超时（8 秒）")), 8_000)),
                ])
              } catch (error) {
                startupError = error instanceof Error ? error.message : String(error)
                flow = undefined
              }
              if (flow === undefined) {
                // 起不来：**这时候一定要让 magpie 去开系统浏览器**，
                // 否则用户既没窗口、也没入口（真机卡死就是这一步缺了）。
                const error = manualCookieHint(site, startupError || "受控浏览器没能启动", loginUrl)
                return {
                  url: loginUrl,
                  opened: false,
                  method: "auto",
                  instructions: error,
                  async callback() {
                    return { type: "failed", error }
                  },
                }
              }
              return {
                url: loginUrl,
                opened: true,
                method: "auto",
                // 五种官方方式都列出来：登录方式是**用户的自由**，插件不替他挑
                // （AGENTS.md 0.4）。那句「不会替你点」不是客套 —— 早先的自动点
                // 脚本会强点第 4 个图标（观猹），等于把另外四种从用户手里拿走。
                instructions: "在打开的窗口里登录百智云 —— 入口都在，**自己挑**："
                  + "\n· 上方大二维码 = 微信扫码"
                  + "\n· 下方四个小图标 = 支付宝 / 抖音 / GitHub / 观猹"
                  + "\n插件不会替你点任何登录方式，只负责在你登完之后读 cookie、取 sk- 密钥。"
                  + (code.length > 0
                    ? `\n· 邀请码 ${code} 已拼进登录地址（仅首次注册生效）。`
                    : "\n· 没填邀请码：这次不带邀请（邀请只在首次注册时生效，事后补不了）。")
                  + (mcCode.length > 0
                    ? `\n· MonkeyCode 邀请码 ${mcCode} 会用于自动开通国内站账号（仅首次开通生效）。`
                    : "\n· 没填 MonkeyCode 邀请码：自动开通国内站账号时不带邀请（仅首次开通生效，事后补不了）。"),
                async callback(_code, { signal } = {}) {
                  try {
                    const { cookie } = await flow.wait()
                    return await finishSignIn(cookie, site, { provision, signal, inviteResolver })
                  } catch (error) {
                    return { type: "failed", error: error instanceof Error ? error.message : String(error) }
                  }
                },
              }
            },
          },
        ],

        /** 续期：静态 Key，上游没有 refresh 端点。返回 undefined，不发任何请求。 */
        async refresh() {
          return undefined
        },

        // ── ④ 请求接管 ───────────────────────────────────────────────
        async loader(getAuth) {
          const auth = await getAuth()
          if (credentialOf(auth) === undefined) return {}
          return {
            baseURL: site.baseUrl,
            // 不交给 SDK 填鉴权头：这里的 fetch 自己决定所有头，避免出现
            // Authorization 与 x-api-key 同时存在这种只有网关会介意的情况。
            apiKey: "",
            async fetch(input, init) {
              const stored = await getAuth()
              const credential = credentialOf(stored)
              if (credential === undefined) throw new Error(`${site.displayName} 未登录`)

              const request = input instanceof Request ? input : null
              const url = typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.toString()
                  : request?.url ?? ""

              const headers = new Headers(init?.headers ?? request?.headers ?? {})
              // user-agent 也必须由我们决定，否则宿主那条 `magpie/<version>` 会原样
              // 透到 baizhi 网关 ⇒ 网关按 `<产品名>/<版本>` 判成第三方客户端 ⇒ 403。
              for (const name of ["authorization", "content-length", "host", "user-agent"]) headers.delete(name)
              headers.set("user-agent", UA)
              headers.set("x-api-key", credential.access_token)
              headers.set("anthropic-version", ANTHROPIC_VERSION)
              if (!headers.has("content-type")) headers.set("content-type", "application/json")

              let body = init?.body
              // ⚠ 用 clone() 读文本，绝不能直接消费原 body 流。
              if (body === undefined && request) body = await request.clone().text()

              return fetch(url, {
                method: init?.method ?? request?.method ?? "POST",
                headers,
                body,
                signal: init?.signal ?? request?.signal ?? AbortSignal.timeout(300_000),
              })
            },
          }
        },

        // ── ⑤ 额度 ───────────────────────────────────────────────────
        async usage(getAuth) {
          const auth = await getAuth()
          const credential = credentialOf(auth)
          if (credential === undefined) return { error: "未登录", windows: [] }
          const key = credential.user_id ?? credential.access_token
          try {
            return await usageCache.read(`${site.id}\n${key}`, () => readUsage(site, credential))
          } catch (error) {
            return { error: String(error?.message ?? error), windows: [] }
          }
        },

        // ── ⑥ 每日积分（宿主按账号、按北京日自动调用 checkin）─────────
        async checkin(getAuth) {
          let credential
          try {
            credential = credentialOf(await getAuth())
          } catch (error) {
            return { outcome: "failed", message: `读取登录态失败：${error instanceof Error ? error.message : String(error)}` }
          }
          if (credential === undefined) return { outcome: "failed", message: "未登录" }
          const identity = credential.user_id ?? credential.access_token
          const key = `${site.id}\n${identity}`
          try {
            return await checkinLock.run(key, async () => {
              const result = await claimDailyCredit(credential, site)
              // 宿主只在 claimed 时记录领取时间；已领取也必须回 claimed，否则卡片会一直黄灯。
              if (result.kind === "already-claimed") return { outcome: "claimed", message: "今日已领取" }
              if (result.kind === "captcha") {
                return { outcome: "captcha", message: result.message ?? "厂商要求验证码，请到百智云控制台手动领取" }
              }
              if (result.kind === "claimed") {
                usageCache.clear(key)
                const credit = typeof result.credit === "number" && Number.isFinite(result.credit) && result.credit > 0
                  ? result.credit
                  : undefined
                return {
                  outcome: "claimed",
                  ...(credit === undefined ? {} : { credit }),
                  message: result.message ?? (credit === undefined ? "每日积分领取成功" : `每日积分领取成功 +${credit} 积分`),
                }
              }
              return { outcome: "failed", message: result.message ?? "每日积分领取失败" }
            })
          } catch (error) {
            // 领取是辅助能力：任何异常都只显示 failed，不能影响推理与额度钩子。
            return { outcome: "failed", message: error instanceof Error ? error.message : String(error) }
          }
        },
      },
    }
  }
}

export const _internal = {
  makeBaizhiPlugin,
  staticModels,
  modelEntry,
  readUsage,
  nextUtc8Midnight,
  credentialOf,
  // 「读到 cookie ≠ 登录成功」的判据（accept 与 finishSignIn 共用同一份兑换结果）。
  acceptBrowserCookie,
  // 登录收尾：测试要证明「accept 兑换过之后，finishSignIn 不再 POST 建一把新 Key」。
  // （生产代码只经 auth.methods[].callback → finishSignIn，没有别的调用点。）
  finishSignIn,
  // 受控窗口的**接线**：测试注入假的 `start` 拿回 options，锁住 `accept` 真的接到
  // `acceptBrowserCookie`（变异成恒 true 必须真红，见 docs/final-review.md M3）。
  startBaizhiBrowserLogin,
}
