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
import { browserLogin, BROWSER_LOGIN_TIMEOUT_MS } from "./browser-login.mjs"
import {
  claimCheckin, cookieOf, exchangeSessionForKey, fetchPlan, fetchProfile, fetchWallet, PLAN_LABELS,
} from "./credits.mjs"
import { gatewayHeaders, isUsableCredential, parseCredential } from "./signing.mjs"

const SDK = "@ai-sdk/anthropic"
const MAX_OUTPUT = 64_000

/** 把站点模型表编译成 magpie 的 config.models 形状。 */
function configModels(site) {
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
        + "请用「浏览器登录」添加账号，或点卡片上的「改 Key」补填 session cookie。",
      windows: [],
    }
  }
  const wallet = await fetchWallet(cookie, site, { fetchImpl })
  if (!wallet.ok) return { error: wallet.error, windows: [] }
  const plan = await fetchPlan(cookie, site, { fetchImpl })

  const windows = []
  // 每日额度：数量型窗口。span = 一天（上游不下发重置时刻，编一个 resetsAt 就是编造）。
  // 只有上限与剩余都有才画（缺剩余时把 0 当剩余会让用户以为今天已用光）。
  if (wallet.dailyTokenLimit !== undefined && wallet.dailyTokenBalance !== undefined) {
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
    const { cookie } = await browserLogin({
      url: site.loginUrl ?? `${site.platformBaseUrl}/`,
      cookieName: site.sessionCookie,
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
  return {
    type: "success",
    // MonkeyCode 的凭据是「一次性签发的静态材料」，没有 refresh_token ——
    // access 存整份 JSON，refresh 留空（auth.refresh 会直接返回 undefined）。
    access: JSON.stringify({ ...credential, ...(profile?.userId === undefined ? {} : { user_id: profile.userId }) }),
    expires: 0,
    accountId: nickname ?? "",
    uid: profile?.userId ?? "",
  }
}

/**
 * 造一个站点的插件工厂。
 * @param {typeof SITES[keyof typeof SITES]} site
 */
export function makePlugin(site) {
  return async (_ctx, _options) => {
    // 额度卡片会被频繁刷新：成功 60 秒、失败 5 秒，同 key 并发合并。
    const usageCache = createUsageCache({ ttlMs: 60_000, failTtlMs: 5_000 })

    return {
      // ── ① 声明 provider ────────────────────────────────────────────
      config: async (config) => {
        config.provider ??= {}
        config.provider[site.id] ??= {}
        const provider = config.provider[site.id]
        provider.name ??= site.displayName
        provider.npm ??= SDK
        provider.api ??= site.gatewayBaseUrl
        provider.models = { ...configModels(site), ...(provider.models ?? {}) }
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
          return { ...configModels(site), ...(provider.models ?? {}) }
        },
      },

      // ── ②③④⑤⑥ 登录 / 续期 / 请求接管 / 额度 / 签到 ────────────────
      auth: {
        provider: site.id,
        icon: site.icon,
        maxConcurrency: 4,
        refreshLead: 5 * 60_000,

        methods: [
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
            label: `${site.displayName} 浏览器登录`,
            /**
             * 立刻返回：真正等登录的是 callback()。
             * 窗口由插件自己打开（opened: true），magpie 不用再开一个。
             */
            async authorize() {
              return {
                url: site.loginUrl ?? `${site.platformBaseUrl}/`,
                instructions: "在打开的窗口里登录 MonkeyCode（可以用「百智云登录」）；登录完成后本页会自动继续。",
                method: "auto",
                opened: true,
                async callback() {
                  return signInWithBrowser(site)
                },
              }
            },
          },
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
                + "请重新登录，或粘贴完整 JSON：{\"access_token\":\"oma_…\",\"signing_secret\":\"…\"}",
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
              for (const name of ["authorization", "x-api-key", "content-length", "host"]) headers.delete(name)

              let body = init?.body
              // ⚠ 用 clone() 读文本，绝不能直接消费原 body 流。
              if (body === undefined && request) body = await request.clone().text()
              const text = typeof body === "string" ? body : undefined

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
              message: "签到只认网页登录态：请用「浏览器登录」添加账号，或补填 session cookie",
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

export const _internal = { makePlugin, configModels, credentialOf, readUsage, signInWithBrowser }
