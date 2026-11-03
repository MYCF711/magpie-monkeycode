// 百智云（BaiZhiCloud）magpie 插件工厂。
//
// 与 MonkeyCode 的关系：百智云是 MonkeyCode 文档站背后的模型网关，但它是
// **独立的账号体系** —— 独立凭据、按量计费、没有每日额度与签到。所以它是
// 第三个 provider，而不是 monkeycode 的一个档位。
//
// 协议要点（来自 iJetLi/dsh-providers-hub 的 src/baizhi-*.ts，2026-11-03）：
// - 推理走 Anthropic Messages：`https://ai-models.app.baizhi.cloud/api/anthropic/v1/messages`；
// - 鉴权只有 `x-api-key: sk-…`（**没有签名头**，这是与 MonkeyCode 最大的差别）；
// - 模型目录有远端（`GET …/api/anthropic/v1/models`），所以登录后能跟随平台上下架；
// - 积分与 Key 列表在控制台，只认网页 Cookie。

import { usage as buildUsage, usageWindow } from "../quota.mjs"
import { createUsageCache } from "../usage-cache.mjs"

import { parseCredential, hasToken } from "../credential.mjs"
import { browserLogin, BROWSER_LOGIN_TIMEOUT_MS, profileDirFor } from "../session-login.mjs"
import {
  exchangeSessionForKey, fetchProfile, fetchRemoteModels, fetchUsage, fetchWallet,
} from "./credits.mjs"
import { ANTHROPIC_VERSION, BAIZHI, BAIZHI_MAX_OUTPUT_TOKENS, knownBaizhiModel } from "./site.mjs"

const SDK = "@ai-sdk/anthropic"

/** 把一条模型编译成 magpie 的形状；能力只从本地已知表补，未知就不写。 */
function modelEntry(site, id, name) {
  const known = knownBaizhiModel(id)
  const context = known?.context
  const image = known?.image === true
  return {
    id,
    name: name ?? known?.name ?? id,
    api: { id, url: site.baseUrl, npm: SDK },
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
      error: "未配置网页会话（session_cookie）—— 推理可用，但积分余额只认网页登录态。"
        + "请用「浏览器登录」添加账号，或点卡片上的「改 Key」补填 session cookie。",
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

/** 浏览器登录：开窗 → 读 cookie → 换 sk- Key（401 继续等）→ 读资料。 */
async function signInWithBrowser(site, { fetchImpl, signal } = {}) {
  const issued = { key: undefined }
  let cookie = undefined
  try {
    await browserLogin({
      url: site.loginUrl,
      // 持久 profile：登录一次之后，MonkeyCode 的「用百智云账号开通」能直接复用
      // 这份登录态（两处共用同一个 profile 目录），不用再登。
      profileDir: profileDirFor("baizhi"),
      // 控制台同时下发 sl-session（设备/风控）与 baizhi_session（登录），
      // 实测**两枚都要**：只带 baizhi_session 时 /api/v1/user/profile 会 401。
      cookieNames: [...site.sessionCookies],
      // cookie 必须精确落在 baizhi.cloud 上：同名 sl-session 还有两枚属于
      // ai-models / agent-toolkit 子域，用后缀匹配会随机拿到网关那枚。
      cookieDomains: ["baizhi.cloud"],
      timeoutMs: BROWSER_LOGIN_TIMEOUT_MS,
      signal,
      async accept(candidate) {
        let exchanged
        try {
          exchanged = await exchangeSessionForKey(candidate, site, { fetchImpl })
        } catch (error) {
          // 网络层抛错（DNS / 超时 / 证书）继续等，不是「登录坏了」。
          return false
        }
        if (!exchanged.ok) {
          // 401/403 = 还没登进去（窗口一开就有匿名 cookie），继续等；
          // 网络超时同理；「没有可用的 sk- 密钥」则是登录成功但用户还没建 Key ——
          // 必须抛，否则会一直空转到超时，用户完全不知道要去建一把。
          if (/HTTP 40[13]/.test(exchanged.error) || exchanged.error.includes("网页登录态未生效")) return false
          if (exchanged.error.includes("平台接口请求失败")) return false
          throw new Error(exchanged.error)
        }
        issued.key = exchanged.apiKey
        cookie = candidate
        return true
      },
    })
  } catch (error) {
    return { type: "failed", error: error instanceof Error ? error.message : String(error) }
  }

  const key = issued.key
  if (key === undefined) return { type: "failed", error: "登录没有完成" }
  const profile = cookie === undefined ? undefined : await fetchProfile(cookie, site, { fetchImpl })
  return {
    type: "success",
    // 百智云的 Key 是长期静态材料，没有 refresh_token —— refresh 留空。
    access: JSON.stringify({
      access_token: key,
      ...(cookie === undefined ? {} : { session_cookie: cookie }),
      ...(profile?.userId === undefined ? {} : { user_id: profile.userId }),
    }),
    expires: 0,
    accountId: profile?.name ?? "",
    uid: profile?.userId ?? "",
  }
}

/** 造百智云的插件实例。 */
export function makeBaizhiPlugin(site = BAIZHI) {
  return async (_ctx, _options) => {
    const usageCache = createUsageCache({ ttlMs: 60_000, failTtlMs: 5_000 })

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
        async models(provider, { auth } = {}) {
          const fallback = { ...staticModels(site), ...(provider.models ?? {}) }
          const credential = credentialOf(auth)
          if (credential === undefined) return fallback
          let live
          try {
            live = await fetchRemoteModels(credential.access_token, site)
          } catch {
            // 远端失败 → 退回上一次的列表（不返回空表，那会让用户的模型列表整片消失）。
            return fallback
          }
          const out = {}
          for (const model of live) out[model.id] = modelEntry(site, model.id, model.name)
          return Object.keys(out).length > 0 ? out : fallback
        },
      },

      // ── ②③④⑤ 登录 / 续期 / 请求接管 / 额度 ────────────────────────
      auth: {
        provider: site.id,
        icon: site.icon,
        maxConcurrency: 4,
        refreshLead: 5 * 60_000,

        methods: [
          {
            // ⚠ 刻意不写 authorize：magpie 的 api 方式只收一个字符串，有 authorize
            // 时 inputs 只在有 prompts 时才传（HOOKS 陷阱 2）。这里让宿主原样保存
            // `{ type:"api", key }`，由 parseCredential 解析。
            type: "api",
            label: `${site.displayName} API Key`,
            placeholder: "sk-…（也接受 {\"access_token\":\"sk-…\",\"session_cookie\":\"…\"}）",
          },
          {
            type: "oauth",
            label: `${site.displayName} 浏览器登录`,
            async authorize() {
              return {
                url: site.loginUrl,
                instructions: "在打开的窗口里登录百智云控制台；登录完成后本页会自动继续（账号下需要有可用的 sk- 密钥）。",
                method: "auto",
                opened: true,
                async callback() {
                  return signInWithBrowser(site)
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
              for (const name of ["authorization", "content-length", "host"]) headers.delete(name)
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

        // 百智云没有签到：不实现 checkin 钩子（magpie 会当成「这家没有签到」）。
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
}
