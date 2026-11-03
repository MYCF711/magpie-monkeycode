// tests/baizhi.test.mjs —— 百智云的语义锁。
//
// 与 MonkeyCode 的差别集中在这里：只认 x-api-key（无签名头）、模型目录有远端、
// 额度只有积分（无每日 token 额度）、没有签到。全部离线，网络一律注入。

import test from "node:test"
import assert from "node:assert/strict"

import { BAIZHI, BAIZHI_KNOWN_MODELS, knownBaizhiModel } from "../src/baizhi/site.mjs"
import { makeBaizhiPlugin, _internal } from "../src/baizhi/runtime.mjs"
import { parseCredential } from "../src/credential.mjs"

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

test("模型目录：远端成功时用远端列表并补已知能力；失败时退回静态表", async () => {
  const plugin = await makeBaizhiPlugin()({ client: {} })

  await withFetch(
    (url) => {
      if (url === BAIZHI.modelsUrl) {
        return Response.json({
          data: [
            { id: "deepseek-v4-pro", type: "model", display_name: "DeepSeek V4 Pro" },
            { id: "brand-new-model", type: "model", display_name: "Brand New" },
          ],
        })
      }
      throw new Error(`unexpected ${url}`)
    },
    async (calls) => {
      const models = await plugin.provider.models({ models: {} }, { auth })
      assert.deepEqual(Object.keys(models).sort(), ["brand-new-model", "deepseek-v4-pro"])
      assert.equal(models["deepseek-v4-pro"].limit.context, 1_048_576, "已知能力从本地表补")
      assert.equal(models["deepseek-v4-pro"].capabilities.input.image, false)
      // 未知模型：不编窗口、不编能力，只给 text。
      assert.equal(models["brand-new-model"].limit.context, 0)
      assert.equal(models["brand-new-model"].capabilities.input.image, false)
      assert.equal(calls[0].init.headers["x-api-key"], KEY)
    },
  )

  await withFetch(
    () => new Response("boom", { status: 500 }),
    async () => {
      const models = await plugin.provider.models({ models: {} }, { auth })
      assert.equal(Object.keys(models).length, BAIZHI_KNOWN_MODELS.length, "远端失败必须退回静态表，不能返回空表")
    },
  )
})

test("没有签到：auth.checkin 不存在", async () => {
  const plugin = await makeBaizhiPlugin()({ client: {} })
  assert.equal(plugin.auth.checkin, undefined)
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

test("远端目录里带斜杠的 id 会被压平，上游 id 放 apiId（否则 magpie 拆出幽灵供应商）", async () => {
  const plugin = await makeBaizhiPlugin()({ client: {} })
  await withFetch(
    (url) => {
      if (url === BAIZHI.modelsUrl) {
        return Response.json({
          data: [
            { id: "deepseek/deepseek-v4-pro", display_name: "嵌套命名空间的模型" },
            { id: "glm-5.1", display_name: "GLM-5.1" },
          ],
        })
      }
      throw new Error(`unexpected ${url}`)
    },
    async () => {
      const models = await plugin.provider.models({ models: {} }, { auth })
      for (const key of Object.keys(models)) {
        assert.ok(!key.includes("/"), `${key} 的 id 含斜杠`)
      }
      const nested = models["deepseek-deepseek-v4-pro"]
      assert.ok(nested, "带斜杠的 id 必须被压平")
      assert.equal(nested.apiId, "deepseek/deepseek-v4-pro", "上游真实 id 由 apiId 带走")
      assert.equal(nested.api.id, "deepseek/deepseek-v4-pro", "请求体里的 model 用上游 id")
      // 干净的 id 不写 apiId。
      assert.equal(models["glm-5.1"].apiId, undefined)
    },
  )
})
