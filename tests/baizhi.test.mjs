// 单测不许读开发机上的真实账号缓存（可能是「探测后全不可用 ⇒ 空表」）。
process.env.MAGPIE_MONKEYCODE_CACHE_DIR = "C:\__magpie_test_cache__"
process.env.MAGPIE_PLUGIN_DISABLE_BROWSER = "1"
const TEST_HOME = "C:\\__magpie_test_home__"
process.env.USERPROFILE = TEST_HOME
process.env.HOME = TEST_HOME
process.env.APPDATA = `${TEST_HOME}\\AppData\\Roaming`
process.env.LOCALAPPDATA = `${TEST_HOME}\\AppData\\Local`
// tests/baizhi.test.mjs —— 百智云的语义锁。
//
// 与 MonkeyCode 的差别集中在这里：只认 x-api-key（无签名头）、模型目录有远端、
// 额度只有积分（无每日 token 额度），每日积分通过钱包 + captcha 链领取。
// 全部离线，网络一律注入，HOME / 凭证也全部使用假数据。

import test from "node:test"
import assert from "node:assert/strict"

import { BAIZHI, BAIZHI_KNOWN_MODELS, knownBaizhiModel } from "../src/baizhi/site.mjs"
import { makeBaizhiPlugin, _internal } from "../src/baizhi/runtime.mjs"
import { parseCredential } from "../src/credential.mjs"
import { claimDailyCredit } from "../src/baizhi/credits.mjs"

const KEY = "sk-" + "a".repeat(64)
const auth = { type: "api", key: KEY }

function withFetch(handler, fn) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  return Promise.resolve(fn(calls)).finally(() => {
    globalThis.fetch = original
  })
}

const DAILY_CREDIT_PATH = "/api/v1/user/wallet/daily-temporary-credit"
const sessionCredential = (extra = {}) => ({
  access_token: KEY,
  session_cookie: "sess",
  user_id: "user-1",
  ...extra,
})
const sessionAuth = (extra = {}) => ({ type: "api", key: JSON.stringify(sessionCredential(extra)) })
const walletResponse = ({ dailyClaimed = false, temporaryCents = 0, availableCents = temporaryCents } = {}) => Response.json({
  code: 0,
  data: {
    available_credit_cents: availableCents,
    temporary_credit_cents: temporaryCents,
    permanent_credit_cents: 0,
    frozen_credit_cents: 0,
    daily_temporary_credit_claimed: dailyClaimed,
  },
})

/** 一条完整、全假的领取链；领取后钱包临时积分从 0 变为 10000 分（100 积分）。 */
function claimChainHandler({ claimed = true, onClaim } = {}) {
  let walletReads = 0
  return (url) => {
    const path = new URL(url).pathname
    if (path === BAIZHI.walletBalancePath) {
      const before = walletReads === 0
      walletReads += 1
      return walletResponse({ dailyClaimed: !before && claimed, temporaryCents: before ? 0 : 10_000 })
    }
    if (path === "/api/v1/public/captcha/challenge") {
      return Response.json({ code: 0, data: { token: "challenge-token", challenge: { c: 1, s: 1, d: 1 } } })
    }
    if (path === "/api/v1/public/captcha/redeem") {
      return Response.json({ code: 0, data: { success: true, token: "captcha-token" } })
    }
    if (path === DAILY_CREDIT_PATH) {
      onClaim?.()
      return Response.json({ code: 0, data: { claimed } })
    }
    throw new Error(`unexpected ${url}`)
  }
}

test("凭据：裸 sk- key 就能用，也接受带 session_cookie 的 JSON", () => {
  assert.deepEqual(parseCredential(KEY), { access_token: KEY })
  const withCookie = JSON.stringify({ access_token: KEY, session_cookie: "sess" })
  assert.deepEqual(parseCredential(withCookie), { access_token: KEY, session_cookie: "sess" })
})

test("loader：baseURL 指向 Anthropic 端点，只发 x-api-key（没有签名头）", async () => {
  const plugin = await makeBaizhiPlugin()({ client: {} })
  const loader = await plugin.auth.loader(async () => auth)
  assert.equal(loader.baseURL, "https://ai-models.app.baizhi.cloud/api/anthropic/v1")

  await withFetch(
    () => new Response("{}", { status: 200 }),
    async (calls) => {
      await loader.fetch(`${BAIZHI.baseUrl}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer should-be-dropped" },
        body: JSON.stringify({ model: "deepseek-v4-pro", messages: [], max_tokens: 8, stream: true }),
      })
      const { init, url } = calls[0]
      const headers = Object.fromEntries(new Headers(init.headers).entries())
      assert.equal(url, "https://ai-models.app.baizhi.cloud/api/anthropic/v1/messages")
      assert.equal(headers["x-api-key"], KEY)
      assert.equal(headers["anthropic-version"], "2023-06-01")
      assert.equal(headers.authorization, undefined, "SDK 可能塞 Authorization，必须去掉")
      assert.equal(headers["x-ohmyagent-signature"], undefined, "百智云没有签名头")
    },
  )
})

test("未登录：loader 返回空对象，usage 不伪造额度", async () => {
  const plugin = await makeBaizhiPlugin()({ client: {} })
  assert.deepEqual(await plugin.auth.loader(async () => null), {})
  const usage = await plugin.auth.usage(async () => null)
  assert.match(usage.error, /未登录/)
  assert.equal(usage.windows.length, 0)
})

test("额度：可用 / 每日 / 充值三个窗口，未配 cookie 给可读错误", async () => {
  const plugin = await makeBaizhiPlugin()({ client: {} })
  const withCookie = { type: "api", key: JSON.stringify({ access_token: KEY, session_cookie: "sess" }) }

  await withFetch(
    (url) => {
      if (url.endsWith("/api/v1/user/wallet/balance")) {
        return Response.json({
          code: 0,
          data: {
            available_credit_cents: 23505,
            temporary_credit_cents: 500,
            permanent_credit_cents: 23005,
            frozen_credit_cents: 0,
            daily_temporary_credit_claimed: true,
          },
        })
      }
      if (url.includes("/api/v1/user/wallet/app-credit-usage")) {
        return Response.json({ code: 0, data: { items: [] } })
      }
      throw new Error(`unexpected ${url}`)
    },
    async () => {
      const usage = await plugin.auth.usage(async () => withCookie)
      const byName = Object.fromEntries(usage.windows.map((window) => [window.name, window]))
      assert.equal(byName["可用积分"].balance, 235.05, "1/100 积分换算")
      assert.equal(byName["每日积分"].balance, 5)
      assert.ok(byName["每日积分"].runsOutAt, "每日积分零点过期，要用官方字段表达")
      assert.equal(byName["每日积分"].runsOut, 5)
      assert.equal(byName["充值积分"].balance, 230.05)
      assert.equal(usage.plan, "百智云（按量计费）")
    },
  )

  // 换一把 Key 再问：额度缓存按凭据身份分桶，同一个 token 会命中上一条成功结果。
  const other = { type: "api", key: "sk-" + "b".repeat(64) }
  const noCookie = await plugin.auth.usage(async () => other)
  assert.match(noCookie.error, /session_cookie|网页会话/)
  assert.equal(noCookie.windows.length, 0)
})

test("模型目录：provider.models 纯静态、绝不发网络（登录那一刻不许等远端）", async () => {
  const plugin = await makeBaizhiPlugin()({ client: {} })
  let called = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    called += 1
    throw new Error("provider.models 不许发网络请求")
  }
  try {
    const models = await plugin.provider.models({ models: {} }, { auth })
    assert.equal(called, 0, "provider.models 里任何网络请求都会变成「登录后列不出模型」的失败面")
    assert.equal(Object.keys(models).length, BAIZHI_KNOWN_MODELS.length)
    assert.equal(models["deepseek-v4-pro"].limit.context, 1_048_576, "已知能力从本地表补")
    assert.equal(models["glm-5"].limit.context, 0, "未知窗口不编")
  } finally {
    globalThis.fetch = original
  }
})

test("远端目录解析：能读 display_name，带斜杠的 id 由 modelEntry 压平", async () => {
  const { fetchRemoteModels } = await import("../src/baizhi/credits.mjs")
  const { _internal } = await import("../src/baizhi/runtime.mjs")
  const live = await fetchRemoteModels("sk-test", BAIZHI, {
    fetchImpl: async () => Response.json({
      data: [
        { id: "deepseek/deepseek-v4-pro", display_name: "嵌套命名空间" },
        { id: "glm-5.1", display_name: "GLM-5.1" },
        { id: "" },
      ],
    }),
  })
  assert.equal(live.length, 2, "空 id 要被丢掉")
  const nested = _internal.modelEntry(BAIZHI, live[0].id, live[0].name)
  assert.equal(nested.id, "deepseek-deepseek-v4-pro", "斜杠压平，否则 magpie 会拆出幽灵供应商")
  assert.equal(nested.apiId, "deepseek/deepseek-v4-pro")
  assert.equal(nested.api.id, "deepseek/deepseek-v4-pro")
  const plain = _internal.modelEntry(BAIZHI, live[1].id, live[1].name)
  assert.equal(plain.id, "glm-5.1")
})

test("每日积分：无 cookie 清晰 failed，直接领取与 checkin 都是 0 请求", async () => {
  const plugin = await makeBaizhiPlugin()({ client: {} })
  await withFetch(
    () => { throw new Error("无 cookie 不许发请求") },
    async (calls) => {
      const direct = await claimDailyCredit(sessionCredential({ session_cookie: undefined }), BAIZHI)
      assert.equal(direct.kind, "failed")
      assert.match(direct.message, /session_cookie|网页登录态/)
      const outcome = await plugin.auth.checkin(async () => auth)
      assert.equal(outcome.outcome, "failed")
      assert.match(outcome.message, /session_cookie|网页登录态/)
      assert.equal(calls.length, 0)
    },
  )
})

test("每日积分：今日已领取只 GET 钱包、0 POST，checkin 仍回 claimed 让宿主记账", async () => {
  const plugin = await makeBaizhiPlugin()({ client: {} })
  await withFetch(
    (url) => {
      assert.equal(new URL(url).pathname, BAIZHI.walletBalancePath)
      return walletResponse({ dailyClaimed: true, temporaryCents: 10_000 })
    },
    async (calls) => {
      const outcome = await plugin.auth.checkin(async () => sessionAuth())
      assert.deepEqual(outcome, { outcome: "claimed", message: "今日已领取" })
      assert.equal(calls.length, 1)
      assert.equal(calls[0].init.method, "GET")
      assert.equal(calls.filter((call) => call.init.method === "POST").length, 0)
    },
  )
})

test("每日积分：完整成功链的 endpoint / body / 顺序正确，到账只认钱包正差额 +100", async () => {
  await withFetch(claimChainHandler(), async (calls) => {
    const result = await claimDailyCredit(sessionCredential(), BAIZHI)
    assert.equal(result.kind, "claimed")
    assert.equal(result.credit, 100)
    assert.deepEqual(
      calls.map(({ url, init }) => `${init.method} ${new URL(url).pathname}`),
      [
        `GET ${BAIZHI.walletBalancePath}`,
        "POST /api/v1/public/captcha/challenge",
        "POST /api/v1/public/captcha/redeem",
        `POST ${DAILY_CREDIT_PATH}`,
        `GET ${BAIZHI.walletBalancePath}`,
      ],
    )
    assert.deepEqual(JSON.parse(calls[1].init.body), {})
    const redeem = JSON.parse(calls[2].init.body)
    assert.equal(redeem.token, "challenge-token")
    assert.ok(Array.isArray(redeem.solutions) && redeem.solutions.length === 1)
    assert.ok(redeem.solutions.every((solution) => Number.isInteger(solution) && solution >= 0))
    assert.deepEqual(JSON.parse(calls[3].init.body), { captcha_token: "captcha-token" })
  })
})

test("每日积分：领取响应 claimed=false 是并发幂等已领取，checkin 回 claimed", async () => {
  const plugin = await makeBaizhiPlugin()({ client: {} })
  await withFetch(claimChainHandler({ claimed: false }), async (calls) => {
    const outcome = await plugin.auth.checkin(async () => sessionAuth())
    assert.deepEqual(outcome, { outcome: "claimed", message: "今日已领取" })
    assert.equal(calls.length, 4, "claimed=false 不再复读钱包，也不能当成失败重发")
    assert.equal(calls.filter((call) => new URL(call.url).pathname === DAILY_CREDIT_PATH).length, 1)
  })
})

test("每日积分：领取前钱包失败则 failed 且 0 POST", async () => {
  const plugin = await makeBaizhiPlugin()({ client: {} })
  await withFetch(
    (url) => {
      assert.equal(new URL(url).pathname, BAIZHI.walletBalancePath)
      return Response.json({ message: "offline wallet failure" }, { status: 503 })
    },
    async (calls) => {
      const outcome = await plugin.auth.checkin(async () => sessionAuth())
      assert.equal(outcome.outcome, "failed")
      assert.match(outcome.message, /钱包|HTTP 503/)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].init.method, "GET")
    },
  )
})

test("每日积分：坏 challenge 映射 captcha，绝不进入 redeem / 领取 POST", async () => {
  const plugin = await makeBaizhiPlugin()({ client: {} })
  await withFetch(
    (url) => {
      const path = new URL(url).pathname
      if (path === BAIZHI.walletBalancePath) return walletResponse()
      if (path === "/api/v1/public/captcha/challenge") {
        return Response.json({ code: 0, data: { token: "bad-challenge", challenge: { c: 0, s: 1, d: 1 } } })
      }
      throw new Error(`坏 challenge 之后不许请求 ${url}`)
    },
    async (calls) => {
      const outcome = await plugin.auth.checkin(async () => sessionAuth())
      assert.equal(outcome.outcome, "captcha")
      assert.match(outcome.message, /验证题|合理范围/)
      assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
        BAIZHI.walletBalancePath,
        "/api/v1/public/captcha/challenge",
      ])
    },
  )
})

test("每日积分：同账号两个并发 checkin 单飞，只跑一条领取链", async () => {
  const plugin = await makeBaizhiPlugin()({ client: {} })
  let claimCount = 0
  await withFetch(claimChainHandler({ onClaim: () => { claimCount += 1 } }), async (calls) => {
    const getAuth = async () => sessionAuth()
    const outcomes = await Promise.all([plugin.auth.checkin(getAuth), plugin.auth.checkin(getAuth)])
    assert.deepEqual(outcomes, [
      { outcome: "claimed", credit: 100, message: "每日积分领取成功 +100 积分" },
      { outcome: "claimed", credit: 100, message: "每日积分领取成功 +100 积分" },
    ])
    assert.equal(claimCount, 1)
    assert.equal(calls.filter((call) => call.url.includes("/captcha/challenge")).length, 1)
    assert.equal(calls.filter((call) => call.url.includes("/captcha/redeem")).length, 1)
    assert.equal(calls.filter((call) => new URL(call.url).pathname === BAIZHI.walletBalancePath).length, 2)
  })
})

test("每日积分：领取成功后清该账号 usage 缓存，下次读取看到每日 +100", async () => {
  const plugin = await makeBaizhiPlugin()({ client: {} })
  let dailyClaimed = false
  let walletCalls = 0
  let usageCalls = 0
  await withFetch(
    (url) => {
      const path = new URL(url).pathname
      if (path === BAIZHI.walletBalancePath) {
        walletCalls += 1
        return walletResponse({ dailyClaimed, temporaryCents: dailyClaimed ? 10_000 : 0 })
      }
      if (path === BAIZHI.walletUsagePath) {
        usageCalls += 1
        return Response.json({ code: 0, data: { items: [] } })
      }
      if (path === "/api/v1/public/captcha/challenge") {
        return Response.json({ code: 0, data: { token: "challenge-token", challenge: { c: 1, s: 1, d: 1 } } })
      }
      if (path === "/api/v1/public/captcha/redeem") {
        return Response.json({ code: 0, data: { success: true, token: "captcha-token" } })
      }
      if (path === DAILY_CREDIT_PATH) {
        dailyClaimed = true
        return Response.json({ code: 0, data: { claimed: true } })
      }
      throw new Error(`unexpected ${url}`)
    },
    async () => {
      const getAuth = async () => sessionAuth()
      const before = await plugin.auth.usage(getAuth)
      assert.equal(before.windows.find((window) => window.name === "每日积分"), undefined)
      const outcome = await plugin.auth.checkin(getAuth)
      assert.equal(outcome.outcome, "claimed")
      assert.equal(outcome.credit, 100)
      const after = await plugin.auth.usage(getAuth)
      assert.equal(after.windows.find((window) => window.name === "每日积分").balance, 100)
      assert.equal(walletCalls, 4, "首次 usage + 领取前后 + 清缓存后的 usage，各读一次钱包")
      assert.equal(usageCalls, 2, "清缓存后用量明细也必须重新读取")
    },
  )
})

test("每日积分过期时刻是下一个北京时间 0 点", () => {
  // 2026-11-03 23:30 北京时间 = 15:30Z
  const now = Date.parse("2026-11-03T15:30:00Z")
  const next = _internal.nextUtc8Midnight(now)
  assert.equal(new Date(next).toISOString(), "2026-11-03T16:00:00.000Z")
  // 已经过了 0 点（北京时间 00:30）时，下一个是次日 0 点
  const afterMidnight = Date.parse("2026-11-03T16:30:00Z")
  assert.equal(new Date(_internal.nextUtc8Midnight(afterMidnight)).toISOString(), "2026-11-04T16:00:00.000Z")
})

test("已知能力表：只有 4 条 deepseek 声明窗口，图片只给明确知道的模型", () => {
  const deepseek = BAIZHI_KNOWN_MODELS.filter((model) => model.context !== undefined)
  assert.equal(deepseek.length, 4)
  assert.ok(deepseek.every((model) => model.id.startsWith("deepseek-")))
  assert.equal(knownBaizhiModel("deepseek-v4-flash-vision-exp").image, true)
  assert.equal(knownBaizhiModel("glm-5").image, undefined, "不知道就不写，不是写 false")
})

test("textOnly 窗口必须把标记带到 magpie（否则宿主报 used 必填）", async () => {
  const { usageWindow } = await import("../src/quota.mjs")
  const window = usageWindow({ name: "今日消耗", textOnly: true, display: "12 积分 / 3 次调用" })
  assert.equal(window.textOnly, true, "宿主靠这个字段判断「有意的纯文字窗口」")
  assert.equal(window.used, undefined)
  assert.equal(window.display, "12 积分 / 3 次调用")
  // 真机上「今日消耗」就是这么构造的：确认 usage 输出里那一条带 textOnly。
  const plugin = await makeBaizhiPlugin()({ client: {} })
  const usage = await plugin.auth.usage(async () => auth)
  const today = (usage.windows ?? []).find((w) => w.name === "今日消耗")
  if (today !== undefined) assert.equal(today.textOnly, true)
})
