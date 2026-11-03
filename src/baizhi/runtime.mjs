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
import { findBrowser } from "../browser-login.mjs"
import { openInSystemBrowser } from "../system-open.mjs"
import { BROWSER_LOGIN_TIMEOUT_MS, openControlledBrowser, profileDirFor, startBrowserLogin } from "../session-login.mjs"
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

// ── 登录：百智云控制台会话 → sk- API Key ─────────────────────────────
//
// 控制台同时下发两枚 cookie，**两枚都要**：只带 baizhi_session 时
// /api/v1/user/profile 会 401。且必须精确落在 baizhi.cloud 上 —— 同名
// sl-session 还有两枚属于 ai-models / agent-toolkit 子域。
const CONSOLE_COOKIES = Object.freeze(["sl-session", "baizhi_session"])
const CONSOLE_DOMAINS = Object.freeze(["baizhi.cloud"])

/** cookie 到手之后的收尾：换 sk- Key + 读资料，拼成 magpie 的登录结果。 */
async function finishSignIn(cookie, site, { fetchImpl } = {}) {
  const exchanged = await exchangeSessionForKey(cookie, site, { fetchImpl })
  if (!exchanged.ok) {
    // 账号下一把 sk- 都没有：**把建 Key 的页面直接打开**。
    // magpie 的错误面板里链接不可点，只写 URL 等于让用户手抄。
    //
    // 优先用受控浏览器（持久 profile 里就是刚登进去的登录态，打开就是已登录的
    // 建 Key 页）；它起不来再退回系统默认浏览器。
    if (exchanged.needsKeyCreation === true && typeof exchanged.keysUrl === "string") {
      await openKeyPage(exchanged.keysUrl)
    }
    return { type: "failed", error: `百智云：已读到网页登录态，但换取 API Key 失败（${exchanged.error}）` }
  }
  const profile = await fetchProfile(cookie, site, { fetchImpl })
  return {
    type: "success",
    access: JSON.stringify({
      access_token: exchanged.apiKey,
      session_cookie: cookie,
      ...(profile?.userId === undefined ? {} : { user_id: profile.userId }),
    }),
    expires: 0,
    accountId: profile?.name ?? "",
    uid: profile?.userId ?? "",
  }
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
 */
async function startBaizhiBrowserLogin(site, { signal, browser } = {}) {
  return await startBrowserLogin({
    url: site.loginUrl,
    ...(browser === undefined ? {} : { browser }),
    // 持久 profile：登录一次之后，MonkeyCode 的「用百智云账号开通」能直接复用
    // 这份登录态（两处共用同一个 profile 目录），不用再登。
    profileDir: profileDirFor("baizhi"),
    cookieNames: [...CONSOLE_COOKIES],
    cookieDomains: [...CONSOLE_DOMAINS],
    timeoutMs: BROWSER_LOGIN_TIMEOUT_MS,
    signal,
    // 两枚到齐就算「读到登录态」；能不能换出 Key 由 finishSignIn 判。
    async accept() {
      return true
    },
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

/** 手动粘贴的兜底说明：受控窗口起不来时，用户还能自己把 cookie 交进来。 */
function manualCookieHint(site, reason) {
  return `受控浏览器窗口没能启动（${reason}）。`
    + `请手动打开 ${site.loginUrl} 登录，然后改用「API Key」方式粘贴一行 JSON：`
    + '{"session_cookie":"sl-session=…; baizhi_session=…"}'
    + "（登录后在浏览器 F12 → Application → Cookies → baizhi.cloud 里能看到这两枚）。"
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
              // ① 同步探测有没有浏览器可用（findBrowser 只查路径，不启动进程）。
              //    测试环境用 MAGPIE_PLUGIN_DISABLE_BROWSER=1 门闩关掉真启动。
              const browser = process.env.MAGPIE_PLUGIN_DISABLE_BROWSER === "1" ? undefined : findBrowser()
              if (!browser?.path) {
                const error = manualCookieHint(site, "这台机器上没有找到 Chrome / Edge / 国产 Chromium")
                return {
                  url: site.loginUrl,
                  // 插件开不了，交给 magpie 开系统浏览器。
                  opened: false,
                  method: "auto",
                  instructions: error,
                  async callback() {
                    return { type: "failed", error }
                  },
                }
              }
              // ② 后台把窗口支起来：authorize 立刻返回（面板马上有响应），
              //    窗口在 1-2 秒内出现。等到 callback 才启动的话，用户会先对着
              //    一块「正在开始登录…」而屏幕上一个窗口都没有（真机报障）。
              let startupError = ""
              const pending = startBaizhiBrowserLogin(site, { browser }).catch((error) => {
                startupError = error instanceof Error ? error.message : String(error)
                return undefined
              })
              return {
                url: site.loginUrl,
                opened: true,
                method: "auto",
                instructions: "在打开的窗口里登录百智云控制台；登录完成后本页会自动继续（账号下需要有可用的 sk- 密钥）。",
                async callback() {
                  const flow = await pending
                  if (flow === undefined) {
                    return { type: "failed", error: manualCookieHint(site, startupError || "窗口没能启动") }
                  }
                  try {
                    const { cookie } = await flow.wait()
                    return await finishSignIn(cookie, site)
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
