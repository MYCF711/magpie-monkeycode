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

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { SITES } from "../sites.mjs"
import { browserLogin, BROWSER_LOGIN_TIMEOUT_MS } from "./browser-login.mjs"
import { profileDirFor, readCookiesSilently, startBrowserLogin } from "../session-login.mjs"

import { signInWithBaizhiSession } from "./sso-import.mjs"
import { readDesktopMonkeyCodeSession } from "./desktop-session.mjs"
import { KNOWN_CONTEXT, isStale, prettyModelName, readCatalog, refreshCatalog } from "./catalog.mjs"
import { AGREE_PROTOCOL_JS } from "../baizhi/runtime.mjs"

/**
 * magpie 里是不是已经有这个 uid 的账号了。
 *
 * ⚠ 只读：插件对 magpie 的目录**只有读的份**，多账号的唯一载体是 authorize 的
 * 返回值，插件不碰这些文件。
 *
 * 为什么要看这个：点「添加另一个账号」但复用到了同一个身份时，magpie 会按 uid
 * 去重 —— 界面提示「已添加」，而列表里还是那一个。不把这件事说出来，用户会
 * 一直以为插件坏了（2026-11-04 真机）。
 */
function existingAccountWithUid(providerId, uid) {
  if (typeof uid !== "string" || uid.length === 0) return false
  try {
    const store = JSON.parse(readFileSync(join(homedir(), ".config", "magpie", "plugin-auth.json"), "utf8"))
    return Object.entries(store ?? {}).some(([key, record]) =>
      (key === providerId || key.startsWith(`${providerId}#`)) && record?.uid === uid)
  } catch {
    return false
  }
}

/**
 * 登录期间每秒执行一次：勾掉用户协议 + 点「确认授权」。
 *
 * MonkeyCode 的「快速注册」其实就是百智云的微信扫码登录（点下去会跳到
 * baizhi.cloud/sign-in?redirect=/oauth/authorize&client_id=monkeycode-ai）。
 * 所以用户在窗口里扫码之后，还会落到一张 **OAuth 授权确认页**（「确认授权 / 取消」）
 * —— 不点它，会话永远建立不起来，插件等 cookie 等到超时，用户看到的就是
 * 「观猹账号登录拿不到 cookie 和 api key」（2026-11-04 真机）。
 */
const LOGIN_AUTOPILOT_JS = `(() => {
  const boxes = [...document.querySelectorAll('input[type=checkbox]')].filter((el) => !el.checked);
  for (const box of boxes) box.click();
  const btn = [...document.querySelectorAll('button,a,[role=button]')]
    .find((el) => /确认授权|同意授权|允许授权/.test(((el.textContent || '') + '').trim()));
  if (btn) {
    btn.click();
    return 'authorized';
  }
  return 'ok';
})()`

import {
  claimCheckin, cookieOf, exchangeSessionForKey, fetchPlan, fetchProfile, fetchWallet, PLAN_LABELS,
} from "./credits.mjs"
import { FALLBACK_SYSTEM, gatewayHeaders, isUsableCredential, parseBodyQuietly, parseCredential, signingPrompt } from "./signing.mjs"

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
    // 只列**这个账号真的能用**的：探测过的条目带 usable，未探测（老缓存）视为可用。
    const visible = cached.models.filter((model) => model.usable !== false)
    if (visible.length === 0) {
      // 探测过但一条都不行 —— 别列 21 个点哪个都 403 的假选项。
      return {}
    }
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
              const desk = readDesktopMonkeyCodeSession()
              if (desk === undefined) {
                const help = "没读到本机 MonkeyCode 桌面客户端的登录态。"
                  + "先用桌面版登录一次（登录成功后它会把会话写到本机），再回来点这个；"
                  + "也可以改用「浏览器登录」或「API Key」。"
                return {
                  url: site.loginUrl ?? `${site.platformBaseUrl}/`,
                  opened: false,
                  method: "auto",
                  instructions: help,
                  async callback() {
                    return { type: "failed", error: "本机没有 MonkeyCode 桌面客户端的登录态" }
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
                    const profile = await fetchProfile(desk.cookie, site)
                    return {
                      type: "success",
                      access: JSON.stringify({
                        access_token: issued.apiKey,
                        signing_secret: issued.signingSecret,
                        session_cookie: desk.cookie,
                        ...(profile?.userId === undefined ? {} : { user_id: profile.userId }),
                      }),
                      expires: 0,
                      accountId: profile?.nickname ?? "",
                      uid: profile?.userId ?? "",
                    }
                  } catch (error) {
                    return { type: "failed", error: error instanceof Error ? error.message : String(error) }
                  }
                },
              }
            },
          },
          {
            type: "oauth",
            label: `${site.displayName} 用百智云账号开通`,
            /**
             * 用百智云的账号体系直接开通 MonkeyCode（OAuth SSO，首次登录自动建号）。
             *
             * 窗口开的是**百智云控制台**：用户在里面登录/切换账号，插件读到
             * `sl-session` + `baizhi_session` 之后，在后台无头浏览器里完成
             * `monkeycode → baizhi.cloud/oauth/authorize → callback` 这一步。
             *
             * 一个账号点一次；想再开一个号，在窗口里换号再点。
             */
            async authorize() {
              // 百智云的 cookie 名与域：控制台同时下发 sl-session（设备/风控）
              // 与 baizhi_session（登录），两枚都要；且必须精确落在 baizhi.cloud 上
              // （同名 sl-session 还有两枚属于 ai-models / agent-toolkit 子域）。
              const names = ["sl-session", "baizhi_session"]
              const domains = ["baizhi.cloud"]
              const profileDir = profileDirFor("baizhi")
              // 立刻返回、后台起飞：等到 callback 才启动的话，用户会先对着
              // 一块「正在开始登录…」而屏幕上一个窗口都没有。
              // ⚠ 先真的把「登录态/窗口」拿到手，再决定 opened。
              //
              // 后台起飞 + 立刻 opened:true 的组合在 magpie 宿主里会翻车：spawn 失败时
              // 既没窗口、又因为 opened:true 而没人去开系统浏览器（2026-11-04 真机卡死）。
              // 这里最多等 12 秒（静默读 1-2 秒 + 窗口启动 1-2 秒）：
              //   · 静默命中 profile → 不需要窗口，opened:true 但什么都不会弹
              //   · 窗口起来了     → opened:true
              //   · 起不来         → opened:false，交给 magpie 开系统浏览器
              let flowError = ""
              let ready
              try {
                ready = await Promise.race([
                  (async () => {
                    // 单测门闩：不许真的拉起浏览器。
                    if (process.env.MAGPIE_PLUGIN_DISABLE_BROWSER === "1") {
                      throw new Error("受控浏览器未启动（测试环境）")
                    }
                    // ① 先静默：profile 里已有登录态就直接用（不弹窗、不等用户）。
                    //    这就是「一个百智云账号，两站都能进」的那一步。
                    const silent = await readCookiesSilently({ cookieNames: names, cookieDomains: domains, profileDir })
                    if (silent !== undefined) return { mode: "silent", cookie: silent }
                    // ② 没有才让人登一次（持久 profile：这次登完，下次静默命中）。
                    const flow = await startBrowserLogin({
                      url: "https://baizhi.cloud/console/",
                      cookieNames: names,
                      cookieDomains: domains,
                      profileDir,
                      timeoutMs: BROWSER_LOGIN_TIMEOUT_MS,
                      async accept() {
                        return true
                      },
                    })
                    return { mode: "window", flow }
                  })(),
                  new Promise((_, reject) => setTimeout(() => reject(new Error("登录窗口启动超时（12 秒）")), 12_000)),
                ])
              } catch (error) {
                flowError = error instanceof Error ? error.message : String(error)
                ready = undefined
              }
              const bail = ready === undefined
              return {
                url: "https://baizhi.cloud/console/",
                // 起不来就让 magpie 去开系统浏览器 —— 用户至少能把地址打开。
                opened: !bail,
                instructions: bail
                  ? `受控浏览器没能启动（${flowError || "未知原因"}）。已在你的默认浏览器打开 ${site.platformBaseUrl}，`
                    + "登录后回到这里点「重试」；或者改用「API Key」方式粘贴一行 JSON："
                    + '{"session_cookie":"sl-session=…; baizhi_session=…"}'
                  : "在打开的窗口里登录你的百智云账号（登录方式自己挑，插件不会替你点）。"
                    + "登录完成后本页会自动开通 MonkeyCode。",
                method: "auto",
                async callback() {
                  if (bail) {
                    return { type: "failed", error: `用百智云账号开通失败：${flowError || "受控浏览器没有启动"}` }
                  }
                  let baizhiCookie
                  try {
                    baizhiCookie = ready.mode === "silent" ? ready.cookie : (await ready.flow.wait()).cookie
                  } catch (error) {
                    return { type: "failed", error: error instanceof Error ? error.message : String(error) }
                  }
                  try {
                    const signed = await signInWithBaizhiSession(baizhiCookie, site)
                    const duplicated = existingAccountWithUid(site.id, signed.userId ?? "")
                    return {
                      type: "success",
                      access: JSON.stringify(signed.credential),
                      expires: 0,
                      accountId: signed.nickname ?? "",
                      uid: signed.userId ?? "",
                      // 同一个授权身份只能对应一个 MonkeyCode 账号 —— 复用到旧身份时
                      // magpie 会按 uid 去重。说清楚，别让「提示成功但列表没变」变成谜。
                      ...(duplicated
                        ? { message: "这个百智云账号已经开通过 MonkeyCode（同一账号，凭据已更新）。要加新号，请换一个百智云账号登录，或用「添加另一个账号」。" }
                        : {}),
                    }
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
              let text = typeof body === "string" ? body : undefined

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
          // 平台目录里一条能用的都没有 —— 这个号在平台侧就是空的（sub 没开/没进团队）。
          // 卡片上直说原因，比让用户去猜「为什么模型列表是空的」强。
          const catalog = readCatalog(site.id)
          if (catalog !== undefined && catalog.models.length > 0 && catalog.models.every((model) => model.usable === false)) {
            return {
              error: `MonkeyCode 平台显示这个账号没有任何可用模型（${catalog.models.length} 条全部 403）`
                + " —— 去平台开通额度 / 加入团队后再点重试",
              windows: [],
            }
          }
          // 目录过期就后台刷一次（不 await：额度卡片的响应不能被目录拖慢）。
          if (isStale(readCatalog(site.id)) && credential.session_cookie !== undefined) {
            // 带上网关凭据：刷新时顺带探测「这个号到底能用哪些模型」。
            refreshCatalog(credential.session_cookie, site, { credential }).catch(() => {})
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
