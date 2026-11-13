// MonkeyCode（国内站 / 国际站）magpie 插件工厂。
//
// 一个包、两个供应商：
//   monkeycode      → 国内站
//   monkeycodeintl  → 国际站（同程序的两套部署，账号池不互通）
// 两站是同一程序的两套部署，协议同构、账号池不互通。共享实现全在这里，
// 站点差异只在 src/sites.mjs。
//
// 协议要点（来自 iJetLi/dsh-providers-hub 的 monkeycode-*.ts，2026-11-03）：
// - 推理走 Anthropic Messages：`<gatewayBaseUrl>/messages`；
// - 鉴权是 `x-api-key: oma_…` + `X-OhMyAgent-Signature`（HMAC-SHA256(prompt)）；
// - 凭据是长期静态材料，没有 refresh 端点；
// - 额度 / 积分 / 签到只认网页 Cookie（HttpOnly），没 Cookie 时推理照常、面板降级。

import { usage as buildUsage, usageWindow } from "../quota.mjs"
import { createUsageCache } from "../usage-cache.mjs"

import { SITES } from "../sites.mjs"
// 出站 UA 的唯一来源（所有打上游的请求共用这一条），见 src/platform-http.mjs 的注释。
import { UA } from "../platform-http.mjs"
import { browserLogin, BROWSER_LOGIN_TIMEOUT_MS } from "./browser-login.mjs"
import { profileDirFor, readCookiesSilently, startBrowserLogin } from "../session-login.mjs"
// 邀请策略：国内站与百智云共用；国际站不创建、也不读取这个策略。
import { createInviteStore } from "../invite.mjs"
import { createInvitePolicy, INVITE_PREFERRED_OPTION } from "../invite-policy.mjs"

// 国内站统一走百智云 SSO —— 「复用已登录的百智云」只有这三个入口：
// 账号库里还有没有没导入过的号 / 导入一个 / 拿一条会话去换 MonkeyCode 账号。
import { hasUnimportedBaizhiSession, importOneBaizhiAccount, readBaizhiSessions, signInWithBaizhiSession } from "./sso-import.mjs"
import { readDesktopBaizhiSession, readDesktopMonkeyCodeSession } from "./desktop-session.mjs"
// 账号库读盘只有一份实现（前缀判据 / 坏库 → ok:false 都在里面），见 provision.mjs。
import { readProvisionedAccounts } from "./provision.mjs"
import { loginWithPassword } from "./password-login.mjs"
import { filterByTier, KNOWN_CONTEXT, isStale, prettyModelName, readCatalog, refreshCatalog, warmCatalog } from "./catalog.mjs"
// 百智云的两件，只用于回答「窗口里读到的那枚 cookie 算不算登录完成」：
// BAIZHI 给出控制台的 profile 端点与 cookie 名，fetchProfile 是那个只读查询本身。
// 它们不碰百智云的推理链路，也不参与国际站的任何判断（国际站不认百智云 SSO）。
import { BAIZHI } from "../baizhi/site.mjs"
import { fetchProfile as fetchBaizhiProfile } from "../baizhi/credits.mjs"

/**
 * magpie 里是不是已经有这个 uid 的账号了。
 *
 * ⚠ 只读：插件对 magpie 的目录**只有读的份**，多账号的唯一载体是 authorize 的
 * 返回值，插件不碰这些文件。
 *
 * 为什么要看这个：点「添加另一个账号」但复用到了同一个身份时，magpie 会按 uid
 * 去重 —— 界面提示「已添加」，而列表里还是那一个。不把这件事说出来，用户会
 * 一直以为插件坏了（2026-11-04 真机）。
 *
 * 前缀判据与「坏库怎么算」都在 `provision.mjs` 的 `readProvisionedAccounts` 里
 * 定一次（`key === providerId || key.startsWith(providerId + "#")`、坏库 ok:false）。
 * 这里**不再自己解析一遍**：两份判据分开写，迟早有一份先漂移。
 *   · 坏库 / 读不出来 → false（当作「没有这个账号」：只是少一句提示，不能因此报错）
 *   · `monkeycodeintl` 的条目一个都不算（`monkeycode` 是它的前缀，所以判据必须带 `#`）
 */
function existingAccountWithUid(providerId, uid) {
  if (typeof uid !== "string" || uid.length === 0) return false
  const store = readProvisionedAccounts(providerId)
  if (!store.ok) return false
  return store.accounts.some((account) => account.uid === uid)
}

/** 「同一个授权身份只能对应一个 MonkeyCode 账号」的统一说法（复用到旧身份时 magpie 按 uid 去重）。 */
const DUPLICATE_MESSAGE = "这个百智云账号已经开通过 MonkeyCode（同一账号，凭据已更新）。"
  + "要加新号，请换一个百智云账号，或用「添加另一个账号」。"

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 「还没登录态，接下来该点哪」。
 *
 * 国内站已经**没有** API Key / 账号密码 / 本机导入 / 浏览器登录了，再让用户去
 * 「改 Key / 粘贴 JSON」就是指向一个不存在的按钮（国际站四个都还在，照旧说）。
 */
function reloginHint(site) {
  return site.id === "monkeycode"
    ? "请点「用百智云账号开通」—— 它复用你在「百智云 BaiZhiCloud」卡片里登录过的账号（国内站只保留这一条登录路）。"
    : "请用「浏览器登录」添加账号，或点卡片上的「改 Key」补填完整 JSON（access_token + signing_secret）。"
}

/**
 * 拿到一条百智云会话之后的最后一步：换 MonkeyCode 账号（该账号首次登录时由平台自动建号）。
 *
 * 邀请码只体现在这**一次**导航的 URL 上（`?redirect=&inviter_id=<code>`）——
 * 也就是只在「建号那一刻」生效；已经开通过的号带上它也没副作用（服务端照旧 302）。
 */
async function finishWithBaizhiCookie(cookie, site, inviteCode) {
  const signed = await signInWithBaizhiSession(cookie, site, { inviteCode })
  return signInSuccess({
    access: JSON.stringify(signed.credential),
    expires: 0,
    accountId: signed.nickname ?? "",
    uid: signed.userId ?? "",
    // 同一个授权身份只能对应一个 MonkeyCode 账号 —— 复用到旧身份时 magpie 会按 uid
    // 去重。说清楚，别让「提示成功但列表没变」变成谜。
    ...(existingAccountWithUid(site.id, signed.userId ?? "") ? { message: DUPLICATE_MESSAGE } : {}),
  })
}

/**
 * 「窗口里读到的那枚 cookie 算不算登录完成」。
 *
 * 窗口一打开平台就下发**匿名**会话，读到 cookie 远早于「用户登完」；判据只能问平台：
 * `GET /api/v1/user/profile` 匿名回 401（→ undefined），真会话才回名字。
 * 网络失败同样按「还没登完」处理（继续等），不能让一次抖动把登录判死。
 *
 * 同一份 cookie 只问一次：轮询每秒一次，重复问不会更快知道结果，只会多打上游。
 */
function createBaizhiCookieVerifier() {
  const seen = new Map()
  return async function verified(candidate) {
    if (seen.has(candidate)) return seen.get(candidate)
    let ok = false
    try {
      ok = (await fetchBaizhiProfile(candidate, BAIZHI)) !== undefined
    } catch {
      ok = false
    }
    seen.set(candidate, ok)
    return ok
  }
}

/** 百智云控制台：用户在窗口里登录 / 换号的地方（与 MonkeyCode 自己的登录页无关）。 */
const BAIZHI_CONSOLE_URL = "https://baizhi.cloud/console/"
/** 控制台会话由两枚 cookie 组成（sl-session 是设备/风控），两枚到齐才算登录完成。 */
const BAIZHI_COOKIE_NAMES = ["sl-session", "baizhi_session"]
const BAIZHI_COOKIE_DOMAINS = ["baizhi.cloud"]

// ⚠ 这里刻意**没有**「自动勾协议 / 自动点确认授权」的脚本。
//
// 两种接法都被否掉：① 替用户点登录页那排图标 —— 第 4 个是观猹，点下去等于把另外
// 四种方式（微信 / 支付宝 / 抖音 / GitHub）从用户手里拿走（AGENTS.md 0.4）；
// ② 每隔一秒点一次「确认授权」—— 国内站改造后只剩百智云 SSO 一条入口，
// 那一步由 `signInWithBaizhiSession` 用 CDP 在后台完成，再叠一层只会和它抢。
// 见 docs/login-unification-audit.md §3.4-b/c。

import {
  claimCheckin, cookieOf, exchangeSessionForKey, fetchPlan, fetchProfile, fetchTodaySpend, fetchWallet,
  PLAN_LABELS, resolveTier,
} from "./credits.mjs"
import { FALLBACK_SYSTEM, gatewayHeaders, isUsableCredential, parseBodyQuietly, parseCredential, signInSuccess, signingPrompt } from "./signing.mjs"

const SDK = "@ai-sdk/anthropic"
const MAX_OUTPUT = 64_000

/**
 * 模型目录：**优先用平台下发的缓存**，没有才用内置快照。
 *
 * 缓存由登录后的后台刷新写入（见 auth.usage 与 signInWithSso）—— 这里只读文件，
 * 绝不发网络请求：magpie 会在登录刚完成时调这个函数，任何网络开销都会变成
 * 「已登录但无法列出它」。
 */
function configModels(site) {
  const cached = readCatalog(site.id)
  if (cached !== undefined && cached.models.length > 0) {
    const out = {}
    // 平台目录给的就是「这个账号能调什么」（按权限 / 订阅过滤过的）。
    // 落盘时按订阅档位收窄过，这里再按同一条规则筛一遍（幂等）：老缓存没存 tier
    // 就原样列出，不会因为某次刷新没带档位而把 pro / ultra 放回来。
    const visible = cached.tier === undefined ? cached.models : filterByTier(cached.models, cached.tier)
    for (const model of visible) {
      out[model.id] = {
        id: model.id,
        // 显示名在读取时算：老缓存里没有 displayName 也能立刻变好看，不用重拉目录。
        name: model.displayName ?? prettyModelName(model.name),
        apiId: model.apiId,
        api: { id: model.apiId, url: site.gatewayBaseUrl, npm: SDK },
        status: "active",
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        // 老缓存里可能还存着平台的 200000 —— 读取时按已知真实窗口兜底。
        limit: { context: Math.max(model.context || 0, KNOWN_CONTEXT), output: model.output || MAX_OUTPUT },
        modalities: { input: model.image ? ["text", "image"] : ["text"], output: ["text"] },
        capabilities: {
          temperature: true,
          reasoning: false,
          toolcall: true,
          attachment: model.image === true,
          input: { text: true, image: model.image === true, audio: false, video: false, pdf: false },
          output: { text: true, image: false, audio: false, video: false, pdf: false },
          interleaved: false,
        },
        release_date: "",
        variants: {},
        ...(model.free ? { free: true } : {}),
      }
    }
    return out
  }
  return builtinModels(site)
}

/** 内置快照（平台目录拉不到时的兜底；名字与窗口都来自旧快照，可能过期）。 */
function builtinModels(site) {
  const out = {}
  for (const [id, name, context, apiId] of site.models) {
    out[id] = {
      id,
      name,
      // 上游 id 与 magpie 的 id 不同时用 apiId 带上（发请求时用它）。
      ...(apiId === undefined ? {} : { apiId }),
      api: { id: apiId ?? id, url: site.gatewayBaseUrl, npm: SDK },
      status: "active",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      // context 为 0 = 厂商没有下发窗口，不编造（agent 据此决定何时压缩）。
      limit: { context: context ?? 0, output: MAX_OUTPUT },
      // config 钩子的静态模型走 modalities；provider.models 路径的字段是 capabilities。
      modalities: { input: ["text"], output: ["text"] },
      capabilities: {
        temperature: true,
        // MonkeyCode 没有下发「每个模型支持哪些思考档位」的元数据 ——
        // 凭空编一张表就是假能力，所以不声明 reasoning 档位。
        reasoning: false,
        toolcall: true,
        attachment: false,
        // 五个模态键必须显式写布尔：省略 ≠ text，会被 models.dev 裸 id 投票误判。
        input: { text: true, image: false, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: "",
      variants: {},
    }
  }
  return out
}

/**
 * 登录成功后把「这个账号能用哪些模型」落盘：先推出订阅档位，再按档位收窄目录。
 *
 * 档位拿不到就不收窄（`filterByTier` 原样返回）；整条链路失败也不阻塞登录 ——
 * 最差退回内置快照。
 */
async function warmSignInCatalog(cookie, site, fetchImpl) {
  const tier = await resolveTier(cookie, site, { fetchImpl }).catch(() => undefined)
  return warmCatalog(cookie, site, { fetchImpl, tier }).catch(() => {})
}

/** 把凭据的 JSON 字符串解析成凭据对象；不可用时返回 undefined。 */
function credentialOf(auth) {
  if (!auth) return undefined
  const raw = auth.type === "api" ? auth.key : auth.access
  const credential = parseCredential(raw)
  return isUsableCredential(credential) ? credential : undefined
}

/** 读一次额度与订阅，拼成 magpie 的 usage 形状。 */
async function readUsage(site, credential, fetchImpl) {
  const cookie = cookieOf(credential, site.sessionCookie)
  if (cookie === undefined) {
    return {
      error: "未配置网页会话（session_cookie）—— 推理可用，但额度 / 积分 / 签到只认网页登录态。"
        + reloginHint(site),
      windows: [],
    }
  }
  const wallet = await fetchWallet(cookie, site, { fetchImpl })
  if (!wallet.ok) return { error: wallet.error, windows: [] }
  // 订阅档位与「今日消耗」互不依赖 —— 一起发，别让额度卡片为两条辅助读数付两倍延迟。
  // 两者都不会抛；今日消耗再兜一层 ok:false，失败就当没有这条窗口。
  const [plan, todaySpend] = await Promise.all([
    fetchPlan(cookie, site, { fetchImpl }),
    fetchTodaySpend(cookie, site, { fetchImpl }).catch(() => ({ ok: false })),
  ])

  const windows = []
  // 每日额度：数量型窗口。span = 一天（上游不下发重置时刻，编一个 resetsAt 就是编造）。
  // 只有上限与剩余都有才画（缺剩余时把 0 当剩余会让用户以为今天已用光）。
  // ⚠ 上限为 0 也不能画：按积分计费的账号（`enable_credit_consumption: true`）钱包里
  //   `daily_token_limit` / `daily_token_balance` 恒为 0，画出来会被 `usageWindow` 判
  //   `limit > 0` 不成立而抛 QuotaShapeError —— 整张额度卡片变成「暂时无法获取额度」
  //   （2026-11-13 真机：6 个 basic 账号全部 0/0）。没有每日额度就是没有这条窗口。
  if (wallet.dailyTokenLimit !== undefined && wallet.dailyTokenLimit > 0 && wallet.dailyTokenBalance !== undefined) {
    windows.push(usageWindow({
      name: "每日额度",
      amount: Math.max(0, wallet.dailyTokenLimit - wallet.dailyTokenBalance),
      limit: wallet.dailyTokenLimit,
      unit: "计费 token",
      span: 86_400,
    }))
  }
  // 积分是钱包型：只给余额，没有上限（上游不给总额，给分母就是假占比）。
  // 真机见过负余额（-8.191）—— 负数不能直接当进度条读，改成 0 + 明文字。
  const negative = wallet.balance < 0
  windows.push(usageWindow({
    name: "积分余额",
    balance: negative ? 0 : wallet.balance,
    unit: "积分",
    ...(negative ? { display: `${wallet.balance} 积分（已透支）` } : {}),
  }))
  // 今日消耗：今天扣了多少积分、多少次调用（与百智云同名窗口同一格式）。
  // textOnly：这是「今天花了多少」，不是额度 —— 给不出占比，也不该参与路由排序。
  // 只有读成功才画（0 也照画：「今天还没花」本身就是有用的信息）；失败静默跳过，
  // 绝不让一条附加读数把整张额度卡片变成错误。
  if (todaySpend.ok) {
    const { credit, calls } = todaySpend.spend
    // 额度内不产生扣费流水：如实说「未扣积分」，而不是「0.000 积分」那种看着像坏了的样子。
    const used = credit > 0 || calls > 0
    windows.push(usageWindow({
      name: "今日消耗",
      textOnly: true,
      display: used ? `${credit} 积分 / ${calls} 次调用` : "今日未扣积分（额度内）",
    }))
  }

  return buildUsage({
    ...(plan === undefined ? {} : { plan: `MonkeyCode ${PLAN_LABELS[plan]}` }),
    windows,
  })
}

/**
 * 浏览器登录的完整流程：开窗 → 读 cookie → 换 Key（401 继续等）→ 读资料。
 * 返回 magpie 的登录结果对象。
 */
async function signInWithBrowser(site, { fetchImpl, signal } = {}) {
  const issued = { credential: undefined }
  try {
    if (process.env.MAGPIE_PLUGIN_DISABLE_BROWSER === "1") {
      return { type: "failed", error: "受控浏览器未启动（测试环境）" }
    }
    // 只认**本站**的 cookie。两站用的是同一个 cookie 名（`monkeycode_ai_session`），
    // 不过滤域就会把另一站的会话当成自己的 —— 实测拿国内站的 cookie 打国际站的
    // `/api/v1/users/models` 一律 **401**（AGENTS 0.6）。
    // 这也是「国际版已登录、但列不出来」的最短路径根因之一。
    const host = new URL(site.platformBaseUrl).hostname
    const { cookie } = await browserLogin({
      url: site.loginUrl ?? `${site.platformBaseUrl}/`,
      cookieName: site.sessionCookie,
      cookieDomains: [host],
      // ⚠ **一次性 profile**（刻意不传 profileDir）：复用持久 profile 时，
      // 窗口一开就带着上一个号的登录态，读到的还是旧身份 —— magpie 按 uid
      // 去重后列表不变，用户看到的是「提示已添加，账号还是那一个」。
      // 加第二个号 = 再点一次这里 = 一个干净窗口，自己挑登录方式。
      timeoutMs: BROWSER_LOGIN_TIMEOUT_MS,
      signal,
      async accept(candidate) {
        let result
        try {
          result = await exchangeSessionForKey(candidate, site, { fetchImpl })
        } catch (error) {
          // 网络层抛错（DNS / 超时 / 证书）不是「凭据坏了」：国际站实测单次
          // 请求要 11s 以上，偶发超时很正常。继续等窗口里的下一次轮询。
          return false
        }
        if (!result.ok) {
          // 401/403 = 用户还没登进去（窗口一打开就有匿名会话），继续等。
          // 网络超时同理（国际站慢）—— 只有「确实通了的接口拒绝了报文形态」才抛。
          if (/HTTP 40[13]/.test(result.error) || result.error.includes("网页登录态未生效")) return false
          if (result.error.includes("平台接口请求失败")) return false
          throw new Error(`MonkeyCode：已读到网页登录态，但换取网关凭据失败（${result.error}）`)
        }
        issued.credential = {
          access_token: result.apiKey,
          signing_secret: result.signingSecret,
          session_cookie: candidate,
        }
        return true
      },
    })
  } catch (error) {
    return { type: "failed", error: error instanceof Error ? error.message : String(error) }
  }

  const credential = issued.credential
  if (credential === undefined) return { type: "failed", error: "登录没有完成" }

  const cookie = credential.session_cookie
  const profile = await fetchProfile(cookie, site, { fetchImpl })
  const nickname = profile?.nickname
  // 登录成功的**这一刻**就把「这个账号能调什么」落盘：magpie 紧接着会调
  // `provider.models`，而那里只读缓存（钩子里发网络请求就会变成「已登录但
  // 无法列出它」）。失败不阻塞登录 —— 拉不到就退回内置快照。
  await warmSignInCatalog(cookie, site, fetchImpl)
  return signInSuccess({
    // MonkeyCode 的凭据是「一次性签发的静态材料」，没有 refresh_token ——
    // 整份 JSON 进 access；refresh 由 signInSuccess 填同一份（那一格是
    // magpie 的「存不存得下」开关，见 src/credential.mjs）。
    access: JSON.stringify({ ...credential, ...(profile?.userId === undefined ? {} : { user_id: profile.userId }) }),
    expires: 0,
    accountId: nickname ?? "",
    uid: profile?.userId ?? "",
  })
}

/**
 * 造一个站点的插件工厂。
 * @param {typeof SITES[keyof typeof SITES]} site
 */
export function makePlugin(site) {
  return async (ctx = {}, _options = {}) => {
    // 额度卡片会被频繁刷新：成功 60 秒、失败 5 秒，同 key 并发合并。
    const usageCache = createUsageCache({ ttlMs: 60_000, failTtlMs: 5_000 })
    // 只有国内站创建邀请策略；国际站既不声明开关，也不读账号库或邀请文件。
    const invitePolicy = site.id === "monkeycode"
      ? createInvitePolicy({
        ctx,
        provider: site.id,
        dualManual: false,
        preferredStore: createInviteStore("baizhi-invite-source"),
        monkeycodeInviteStore: createInviteStore("monkeycode"),
        readBaizhiAccounts: readBaizhiSessions,
        readMonkeycodeAccounts: () => readProvisionedAccounts("monkeycode"),
        manual: {
          monkeycode: { key: "invite", message: "邀请码（可选，只影响首次开通）" },
        },
      })
      : undefined

    return {
      // ── ① 声明 provider ────────────────────────────────────────────
      config: async (config) => {
        config.provider ??= {}
        config.provider[site.id] ??= {}
        const provider = config.provider[site.id]
        provider.name ??= site.displayName
        provider.npm ??= SDK
        provider.api ??= site.gatewayBaseUrl
        provider.models = configModels(site)
      },

      // ── ⑧ 每请求加头 ───────────────────────────────────────────────
      "chat.headers": async (input, output) => {
        const id = input?.model?.providerID ?? input?.provider?.info?.id
        if (id !== site.id || !input?.sessionID) return
        output.headers["x-monkeycode-session"] = String(input.sessionID).slice(0, 128)
      },

      // ── ⑦ 每账号的模型目录 ─────────────────────────────────────────
      provider: {
        id: site.id,
        async models(provider) {
          // 网关没有远端目录（GET /v1/models 实测 405），这个静态表就是全量事实。
          return configModels(site)
        },
      },

      // ── ②③④⑤⑥ 登录 / 续期 / 请求接管 / 额度 / 签到 ────────────────
      auth: {
        provider: site.id,
        icon: site.icon,
        maxConcurrency: 4,
        refreshLead: 5 * 60_000,
        ...(site.id === "monkeycode" ? { options: [{ ...INVITE_PREFERRED_OPTION }] } : {}),

        methods: [
          // 国内站（monkeycode）只剩**一条**登录路 —— 「用百智云账号开通」（见下面的 SSO 方法）。
          // 用户要求「国内 MonkeyCode 统一通过百智云 SSO 复用凭证」，所以 API Key / 账号密码 /
          // 本机导入 / 浏览器登录在国内站全部下线；国际站不认百智云 SSO，四个原样保留。
          ...(site.id === "monkeycode" ? [] : [
          {
            // ⚠ 刻意**不写 authorize**：magpie 的 api 方式只收一个字符串，
            // 有 authorize 时 inputs 只在有 prompts 时才传（见 HOOKS 陷阱 2），
            // 而 MonkeyCode 要两个字段。所以让 magpie 原样保存 { type:"api", key }，
            // 由 loader / usage 里的 parseCredential 解析（JSON / key:secret 都认）。
            type: "api",
            label: `${site.displayName} API Key`,
            placeholder: '{"access_token":"oma_…","signing_secret":"…"}',
          },
          {
            type: "oauth",
            label: `${site.displayName} 账号密码登录`,
            /**
             * **纯 API 登录，不开窗口** —— 满足「我不要微信扫码，我要观猹账号」。
             *
             * 链路见 `password-login.mjs`：captcha 挑战 → 本地解 PoW → redeem →
             * `POST /api/v1/users/password-login {email,password,captcha_token}` → Set-Cookie。
             * 桌面客户端的 `mc_password_login` 走的就是这一条。
             *
             * 两个站都实测过：假账号会如实回「账号或密码不对（上游 code 10606）」，
             * 说明验证码与字段全对，剩下只取决于账号密码本身。
             */
            get prompts() {
              return [
                { type: "text", key: "email", message: "登录邮箱", placeholder: "you@example.com" },
                { type: "text", key: "password", message: "密码", placeholder: "只用于这一次登录，不写日志" },
              ]
            },
            async ask(inputs) {
              const filled = (key) => inputs !== null && typeof inputs === "object" && Object.prototype.hasOwnProperty.call(inputs, key)
              if (!filled("email")) return this.prompts[0]
              if (!filled("password")) return this.prompts[1]
              return null
            },
            async authorize(inputs) {
              const email = typeof inputs?.email === "string" ? inputs.email.trim() : ""
              const password = typeof inputs?.password === "string" ? inputs.password : ""
              // 立刻返回（铁律 2）：网络请求全在 callback。
              return {
                url: site.loginUrl ?? `${site.platformBaseUrl}/`,
                // 真的不开窗：opened:true 只是别让 magpie 去拉起系统浏览器。
                opened: true,
                method: "auto",
                instructions: "正在用账号密码登录（纯接口，不会开窗口）。",
                async callback() {
                  if (email.length === 0 || password.length === 0) {
                    return { type: "failed", error: "账号或密码没填" }
                  }
                  try {
                    const session = await loginWithPassword({ email, password, site })
                    if (!session.ok) return { type: "failed", error: session.error }
                    const issued = await exchangeSessionForKey(session.cookie, site)
                    if (!issued.ok) {
                      return { type: "failed", error: `登录成功，但换取网关凭据失败（${issued.error}）` }
                    }
                    await warmSignInCatalog(session.cookie, site)
                    const profile = await fetchProfile(session.cookie, site)
                    return signInSuccess({
                      access: JSON.stringify({
                        access_token: issued.apiKey,
                        signing_secret: issued.signingSecret,
                        session_cookie: session.cookie,
                        ...(profile?.userId === undefined ? {} : { user_id: profile.userId }),
                      }),
                      expires: 0,
                      accountId: profile?.nickname ?? "",
                      uid: profile?.userId ?? "",
                    })
                  } catch (error) {
                    return { type: "failed", error: error instanceof Error ? error.message : String(error) }
                  }
                },
              }
            },
          },
          // 「从本机客户端导入」两站都提供 —— 但**必须按域取 cookie**：桌面客户端的
          // `mc_base_url` 是二选一的一个值，`.com` 与 `.net` 的会话装在同一个
          // `monkeycode-cookies.json` 里。不比对域就会拿错站（上游一律 401，
          // 界面只能猜「桌面版登录过期」，真因却是拿错了站）。
          {
            type: "oauth",
            label: `${site.displayName} 从本机客户端导入`,
            /**
             * 读**本机 MonkeyCode 桌面客户端**已登录的会话，直接换一对网关凭据。
             *
             * 为什么这是最省事的一条：桌面版登录完会把 `monkeycode_ai_session`
             * 明文写进 `%APPDATA%\com.chaitin.baizhi.monkeycode\monkeycode-cookies.json`
             * （见 `desktop-session.mjs`）。插件本地读文件即可，不开窗、不扫码、
             * 不用再输一次密码 —— 用户装过桌面版就等于插件已登录。
             *
             * `authorize()` 里只做**本地读文件**（毫秒级），换 Key 与读资料全在
             * `callback()`：铁律 2 要求 authorize 立刻返回，网络请求不能放这儿。
             */
            async authorize() {
              // 只认**本站**的域：桌面客户端的 `mc_base_url` 是二选一的一个值，
              // `monkeycode-cookies.json` 里装的可能是另一站的会话。
              const host = new URL(site.platformBaseUrl).hostname
              const desk = readDesktopMonkeyCodeSession({ cookieDomains: [host] })
              if (desk === undefined) {
                // 「没读到我这一站」有两种情况，界面必须分开说 —— 否则用户
                // 明明登着桌面版，却被告知「没登录过」，只能反复重登。
                const anySite = readDesktopMonkeyCodeSession()
                const help = anySite === undefined
                  ? "没读到本机 MonkeyCode 桌面客户端的登录态。"
                    + "先用桌面版登录一次（登录成功后它会把会话写到本机），再回来点这个；"
                    + "也可以改用「浏览器登录」或「API Key」。"
                  : "本机桌面客户端登录的是**另一个站点**（国内站 / 国际站二选一），"
                    + `不是 ${site.displayName}。请在桌面版里把服务器切到 ${site.displayName} 并登录一次，`
                    + "或者直接用「浏览器登录」。"
                return {
                  url: site.loginUrl ?? `${site.platformBaseUrl}/`,
                  opened: false,
                  method: "auto",
                  instructions: help,
                  async callback() {
                    return { type: "failed", error: help }
                  },
                }
              }
              return {
                url: site.loginUrl ?? `${site.platformBaseUrl}/`,
                // 真的不需要任何窗口：opened:true 只是告诉 magpie「别再开系统浏览器」。
                opened: true,
                method: "auto",
                instructions: "正在用本机 MonkeyCode 客户端的登录态开通（不会弹任何窗口）。",
                async callback() {
                  try {
                    const issued = await exchangeSessionForKey(desk.cookie, site)
                    if (!issued.ok) {
                      return {
                        type: "failed",
                        error: `读到桌面客户端会话，但换取网关凭据失败（${issued.error}）。`
                          + "桌面版里的登录可能已经过期 —— 重新打开桌面版登录一次即可。",
                      }
                    }
                    await warmSignInCatalog(desk.cookie, site)
                    const profile = await fetchProfile(desk.cookie, site)
                    return signInSuccess({
                      access: JSON.stringify({
                        access_token: issued.apiKey,
                        signing_secret: issued.signingSecret,
                        session_cookie: desk.cookie,
                        ...(profile?.userId === undefined ? {} : { user_id: profile.userId }),
                      }),
                      expires: 0,
                      accountId: profile?.nickname ?? "",
                      uid: profile?.userId ?? "",
                    })
                  } catch (error) {
                    return { type: "failed", error: error instanceof Error ? error.message : String(error) }
                  }
                },
              }
            },
          },
          ]),
          // ⚠ 这个入口**只给国内站**：国际站不认百智云 SSO（2026-11-04 实测）。
          // 国际站的 `GET /api/v1/users/login` 302 到**它自己的** `/oauth/authorize`
          // （`client_id=` 是空的，不经过 baizhi.cloud）；把百智云会话注入窗口再走一遍，
          // 最终只落到国际站首页，**不会**签发 `monkeycode_ai_session`。
          // 留在国际站上只会让用户对着一个必然超时的入口等 240 秒。
          ...(site.id === "monkeycode" ? [
          {
            type: "oauth",
            label: `${site.displayName} 用百智云账号开通`,
            /**
             * 用已登录的百智云账号开通 MonkeyCode（OAuth SSO，首次登录由平台自动建号）。
             *
             * 「复用」的优先级（见 docs/login-unification-audit.md §3.2）：
             *   ① magpie 账号库里还有没导入过的百智云账号 → 零窗口，一次导入一个
             *   ② 本机桌面客户端里的百智云会话             → 零窗口
             *   ③ 持久 profile 里静默读到的百智云会话       → 零窗口
             *   ④ 一个都没有才开窗，让用户在百智云控制台登一次（登录态留在持久 profile，下次静默命中）
             *
             * 前三步都不重登：用户登过一次百智云，两个 MonkeyCode 站点都该能进。
             * 窗口只在第 ④ 步出现；`accept` 会真的问一次平台 —— 读到 cookie ≠ 登录成功
             * （窗口一打开就有匿名会话）。
             */
            get prompts() {
              return invitePolicy.prompts()
            },
            /** off + 有账号不问；on 先选来源；manual / 无账号才问原有邀请码文本。 */
            async ask(inputs = {}) {
              return invitePolicy.ask(inputs)
            },
            async authorize(inputs = {}) {
              // URL / SSO 只使用 resolver 的 monkeycodeCode；手动码与首选选择在本地写回。
              const inviteResolver = invitePolicy.prepare(inputs)
              const inviteCode = inviteResolver().monkeycodeCode

              // ⚠ 单测门闩：账号策略以上只读隔离账号库 / cache；这里起不读桌面登录态、
              // 不读持久浏览器 profile，更不许拉起 Chromium。给一个可测的失败 flow，不抛错。
              if (process.env.MAGPIE_PLUGIN_DISABLE_BROWSER === "1") {
                return {
                  url: BAIZHI_CONSOLE_URL,
                  opened: false,
                  method: "auto",
                  instructions: "测试环境（MAGPIE_PLUGIN_DISABLE_BROWSER=1）：不读本机登录态、不开窗口。",
                  async callback() {
                    return { type: "failed", error: "受控浏览器未启动（测试环境）" }
                  },
                }
              }

              // ① magpie 账号库里还有没导入过的百智云账号 → 完全无窗，一次只导一个。
              if (hasUnimportedBaizhiSession()) {
                return {
                  url: BAIZHI_CONSOLE_URL,
                  opened: true,
                  method: "auto",
                  instructions: "正在用 magpie 里已登录的百智云账号开通 MonkeyCode（不会弹窗口）。"
                    + "一次开通一个账号；还有别的百智云账号，就再点一次这个入口。",
                  async callback() {
                    const imported = await importOneBaizhiAccount(site, { inviteCode })
                    if (!imported.ok) {
                      return {
                        type: "failed",
                        error: `用百智云账号开通失败：${imported.error}`
                          + "（反复失败的话，先在「百智云 BaiZhiCloud」卡片上用浏览器登录一次，把登录态刷新）",
                      }
                    }
                    // 一次只开通一个账号是**故意**的：一次 SSO 要 5~90 秒，串起来会让
                    // 登录面板看起来像卡死。所以把「还剩几个」说清楚，让用户知道再点几次。
                    const remaining = Number.isFinite(imported.remaining) ? imported.remaining : 0
                    const progress = remaining > 0
                      ? `还有 ${remaining} 个百智云账号没开通 —— 再点一次这个入口。`
                      : "所有百智云账号都开通完了。"
                    return signInSuccess({
                      access: imported.access,
                      expires: 0,
                      accountId: imported.accountId,
                      uid: imported.uid,
                      ...(existingAccountWithUid(site.id, imported.uid) ? { message: DUPLICATE_MESSAGE } : { message: progress }),
                    })
                  },
                }
              }

              // ② 本机桌面客户端里已有百智云会话 → 无窗（不开浏览器、不用再登一次）。
              const desktop = readDesktopBaizhiSession()
              if (desktop !== undefined) {
                return {
                  url: BAIZHI_CONSOLE_URL,
                  opened: true,
                  method: "auto",
                  instructions: "正在用本机桌面客户端里的百智云登录态开通 MonkeyCode（不会弹窗口）。",
                  async callback() {
                    try {
                      return await finishWithBaizhiCookie(desktop.cookie, site, inviteCode)
                    } catch (error) {
                      return { type: "failed", error: `用百智云账号开通失败：${describeError(error)}` }
                    }
                  },
                }
              }

              // ③ 持久 profile 里静默读一次；④ 没有才开窗。
              //
              // 后台起飞 + 立刻 opened:true 的组合在 magpie 宿主里会翻车：spawn 失败时
              // 既没窗口、又因为 opened:true 而没人去开系统浏览器（2026-11-04 真机卡死）。
              // 所以这里最多等 12 秒先把「登录态 / 窗口」的结论拿到手，再决定 opened。
              const verify = createBaizhiCookieVerifier()
              let flowError = ""
              let ready
              try {
                ready = await Promise.race([
                  (async () => {
                    // ③ 持久 profile：登过一次就一直有效，静默读到就直接用（不弹窗、不等用户）。
                    const silent = await readCookiesSilently({
                      cookieNames: BAIZHI_COOKIE_NAMES,
                      cookieDomains: BAIZHI_COOKIE_DOMAINS,
                      profileDir: profileDirFor("baizhi"),
                    })
                    if (silent !== undefined) return { mode: "silent", cookie: silent }
                    // ④ 最后才开窗（持久 profile：这次登完，下次静默命中）。
                    const flow = await startBrowserLogin({
                      url: BAIZHI_CONSOLE_URL,
                      cookieNames: BAIZHI_COOKIE_NAMES,
                      cookieDomains: BAIZHI_COOKIE_DOMAINS,
                      profileDir: profileDirFor("baizhi"),
                      timeoutMs: BROWSER_LOGIN_TIMEOUT_MS,
                      accept: verify,
                    })
                    return { mode: "window", flow }
                  })(),
                  new Promise((_, reject) => setTimeout(() => reject(new Error("登录窗口启动超时（12 秒）")), 12_000)),
                ])
              } catch (error) {
                flowError = describeError(error)
                ready = undefined
              }
              const bail = ready === undefined
              return {
                url: BAIZHI_CONSOLE_URL,
                // 起不来就让 magpie 去开系统浏览器 —— 用户至少能把地址打开。
                opened: !bail,
                instructions: bail
                  ? `受控浏览器没能启动（${flowError || "未知原因"}）。已在你的浏览器打开 ${BAIZHI_CONSOLE_URL} —— `
                    + "登录完成后回到这里点「重试」；或者改用本机 MonkeyCode 桌面版（或在「百智云 BaiZhiCloud」卡片上登录一次），"
                    + "插件下次就能直接复用那份登录态，连窗口都不用开。"
                  : "在打开的窗口里登录你的百智云账号（微信 / 支付宝 / 抖音 / GitHub / 观猹 都行，插件不会替你点）。"
                    + "登录完成后本页会自动开通 MonkeyCode；登录态会留在本机，下次直接复用。",
                method: "auto",
                async callback() {
                  if (bail) {
                    return { type: "failed", error: `用百智云账号开通失败：${flowError || "受控浏览器没有启动"}` }
                  }
                  let baizhiCookie
                  try {
                    baizhiCookie = ready.mode === "silent" ? ready.cookie : (await ready.flow.wait()).cookie
                  } catch (error) {
                    return { type: "failed", error: `用百智云账号开通失败：${describeError(error)}` }
                  }
                  try {
                    return await finishWithBaizhiCookie(baizhiCookie, site, inviteCode)
                  } catch (error) {
                    return { type: "failed", error: `用百智云账号开通失败：${describeError(error)}` }
                  }
                },
              }
            },
          },
          ] : []),
          // 国际站原样保留「浏览器登录」（国内站已下线 —— 国内只剩百智云 SSO 一条路）。
          ...(site.id === "monkeycode" ? [] : [
          {
            type: "oauth",
            label: `${site.displayName} 浏览器登录`,
            /**
             * 立刻返回：真正等登录的是 callback()。
             * 窗口由插件自己打开（opened: true），magpie 不用再开一个。
             */
            async authorize() {
              return {
                url: site.loginUrl ?? `${site.platformBaseUrl}/`,
                instructions: "在打开的窗口里登录 MonkeyCode。窗口里有两个入口："
                  + "\n· 没有 MonkeyCode 账号 → 点「快速注册」（手机号/邮箱，不经过百智云，猴子自带日额度）"
                  + "\n· 已有百智云账号 → 点「百智云登录 - 推荐」（一份身份两处通用）"
                  + "\n登录完成后本页会自动继续。",
                method: "auto",
                opened: true,
                async callback() {
                  return signInWithBrowser(site)
                },
              }
            },
          },
          ]),
        ],

        /**
         * 续期：MonkeyCode 的凭据是长期静态材料，上游没有 refresh 端点。
         * 返回 undefined（不是「续期成功」的假象），也不会发起任何网络请求。
         */
        async refresh() {
          return undefined
        },

        // ── ④ 请求接管 ───────────────────────────────────────────────
        async loader(getAuth) {
          const auth = await getAuth()
          if (!credentialOf(auth)) {
            // Key 存在但缺 signing_secret：这是「贴了半个凭据」，必须给可读原因 ——
            // 否则用户看到的是每个请求 403 invalid ohmyagent request，无从下手。
            const raw = auth?.type === "api" ? auth.key : auth?.access
            if (typeof raw === "string" && raw.trim().length > 0) {
              throw new Error(
                `${site.displayName}: 凭据缺少 signing_secret（网关签名密钥），每个请求都会被 403。`
                + `请重新登录：${reloginHint(site)}`,
              )
            }
            return {}
          }
          return {
            // Anthropic 协议：magpie 会向 <baseURL>/messages 发请求。
            baseURL: site.gatewayBaseUrl,
            // 不交给 SDK 填鉴权头 —— 网关要的是 x-api-key + 签名头，两者都由下面的
            // fetch 在**拿到最终 body 之后**自己算。
            apiKey: "",
            async fetch(input, init) {
              const stored = await getAuth()
              const credential = credentialOf(stored)
              if (credential === undefined) throw new Error(`${site.displayName} 未登录或 Key 不完整`)

              const request = input instanceof Request ? input : null
              const url = typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.toString()
                  : request?.url ?? ""

              const headers = new Headers(init?.headers ?? request?.headers ?? {})
              // 这几个必须由我们决定：SDK 会塞 x-api-key / authorization，
              // content-length 在重写 body 后必然过期。
              // `user-agent` 同样必须由我们决定：宿主给插件的是 `magpie/<version>`，
              // 原样透传 = 上游网关按 `<产品名>/<版本>` 识别成第三方客户端 ⇒ 403 TM.00000001。
              for (const name of ["authorization", "x-api-key", "content-length", "host", "user-agent"]) headers.delete(name)
              headers.set("user-agent", UA)

              let body = init?.body
              // ⚠ 用 clone() 读文本，绝不能直接消费原 body 流。
              if (body === undefined && request) body = await request.clone().text()
              let text = typeof body === "string" ? body : undefined

              // ── 把 magpie 的模型 id 换回上游认得的那串 ──────────────────
              //
              // magpie 发过来的 `model` 是**它自己的模型 id**（我们返回的 `id`，
              // 斜杠被压成连字符，例如 `monkeycode-basic-deepseek-flash`）——
              // 它不会用我们在 config 里给的 `api.id`：
              //   magpie: `api: { id: m.id ?? was?.api.id ?? key }`（m 是 config 的条目）
              // 而上游只认**平台原值**（带档位前缀的 `monkeycode-basic/deepseek-flash`）：
              //   2026-11-04 实测 —— 原值 200，slug 回 `403 Forbidden`，
              //   UUID 回 `403 Forbidden`，裸名 `deepseek-flash` 也 403。
              //
              // 所以这一层必须换回来。映射来源就是目录缓存（`id → apiId`）。
              // 换完**再**补 system、**再**算签名：签名覆盖的是 prompt（system），
              // 与 model 无关，但顺序上仍以「最终要发出去的 body」为准最稳。
              if (text !== undefined) {
                const catalog = readCatalog(site.id)
                if (catalog !== undefined && catalog.models.length > 0) {
                  const byId = new Map(catalog.models.map((model) => [model.id, model.apiId]))
                  try {
                    const parsed = JSON.parse(text)
                    const key = typeof parsed.model === "string" ? parsed.model : ""
                    const mapped = byId.get(key)
                    if (mapped !== undefined && mapped !== key && mapped.length > 0) {
                      parsed.model = mapped
                      text = JSON.stringify(parsed)
                      body = text
                    }
                  } catch {}
                }
              }

              // 网关要求被签名的 prompt 非空：没有 system 的请求它会一律回
              // `403 invalid ohmyagent request`（2026-11-04 实测：不带 system 的
              // 探测 403、带 system 的同样请求 200）。用户直接对话时 magpie 经常
              // 不发 system —— 这里补一句最小的并据它签名，否则整条链路走不通。
              if (text !== undefined && signingPrompt(parseBodyQuietly(text)).length === 0) {
                try {
                  const parsed = JSON.parse(text)
                  parsed.system = FALLBACK_SYSTEM
                  text = JSON.stringify(parsed)
                  body = text
                } catch {}
              }

              const extra = gatewayHeaders(credential, { body: text })
              for (const [name, value] of Object.entries(extra)) headers.set(name, value)

              const response = await fetch(url, {
                method: init?.method ?? request?.method ?? "POST",
                headers,
                body,
                signal: init?.signal ?? request?.signal ?? AbortSignal.timeout(300_000),
              })

              // 登录被拒：401 原样交回，magpie 会标记并要求重新登录；
              // 模型不存在：404 原样交回，magpie 只搁置这个模型。
              return response
            },
          }
        },

        // ── ⑤ 额度 ───────────────────────────────────────────────────
        async usage(getAuth) {
          const auth = await getAuth()
          const credential = credentialOf(auth)
          if (credential === undefined) return { error: "未登录", windows: [] }
          // 目录过期就后台刷一次（不 await：额度卡片的响应不能被目录拖慢）。
          // **不带凭据、不探测** —— 平台清单本身就是「这个账号能调什么」，
          // 再拿 max_tokens:1 的探测筛一遍只会误杀能用的模型（见 catalog.mjs）。
          if (isStale(readCatalog(site.id)) && credential.session_cookie !== undefined) {
            // 沿用同一套口径：先推档位，再按档位收窄，否则刷新一次又变回「四类混列」。
            resolveTier(credential.session_cookie, site)
              .then((tier) => refreshCatalog(credential.session_cookie, site, { tier }))
              .catch(() => {})
          }
          const key = credential.user_id ?? credential.access_token
          try {
            return await usageCache.read(`${site.id}\n${key}`, () => readUsage(site, credential))
          } catch (error) {
            return { error: String(error?.message ?? error), windows: [] }
          }
        },

        // ── ⑥ 签到 ───────────────────────────────────────────────────
        async checkin(getAuth) {
          const auth = await getAuth()
          const credential = credentialOf(auth)
          if (credential === undefined) return { outcome: "failed", message: "未登录" }
          if (cookieOf(credential, site.sessionCookie) === undefined) {
            return {
              outcome: "ineligible",
              message: `签到只认网页登录态：${reloginHint(site)}`,
            }
          }
          const result = await claimCheckin(credential, site)
          if (result.kind === "already-claimed") return { outcome: "done", message: result.message ?? "今天已经签到过了" }
          // 验证题形态变了（题面不认识 / 参数越界 / 预算打穿）→ captcha：
          // 让用户去官方页面手动签，而不是反复重试一个解不开的题。
          if (result.kind === "captcha") return { outcome: "captcha", message: result.message ?? "厂商要求验证码，请到官方页面手动签到" }
          if (result.kind === "claimed") {
            return {
              outcome: "claimed",
              ...(result.credit ? { credit: result.credit } : {}),
              message: result.message ?? (result.credit ? `签到成功 +${result.credit} 积分` : "签到成功"),
            }
          }
          return { outcome: "failed", message: result.message ?? "签到失败" }
        },
      },
    }
  }
}

export const _internal = { makePlugin, configModels, credentialOf, readUsage, signInWithBrowser, existingAccountWithUid }
