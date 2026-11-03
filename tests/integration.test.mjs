// tests/integration.test.mjs —— 走真实 HTTP 的端到端：插件 → 本地假网关。
//
// 为什么还要这一层：单元测试里 fetch 是被注入的，签名「按我们以为的方式」算出来
// 就算过。这里起一个真 HTTP 服务器，让 loader 真的发一次请求，服务端按同样的
// 算法验签 —— 签名覆盖什么、头叫什么叫什么、body 有没有被改写，三条一次测到。

import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { createHmac } from "node:crypto"

import { makePlugin } from "../src/monkeycode/runtime.mjs"
import { SITES } from "../src/sites.mjs"

/** 起一个假网关：校验签名，记录收到的请求，回一段 Anthropic SSE。 */
async function startGateway({ secret, prompt }) {
  const seen = []
  const server = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    const headers = req.headers
    const expected = `v1=${createHmac("sha256", secret).update(prompt, "utf8").digest("hex")}`
    seen.push({ url: req.url, headers, body })

    if (headers["x-api-key"] !== "oma_test_key_000000000000000000000" || headers["x-ohmyagent-signature"] !== expected) {
      res.writeHead(403, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "invalid ohmyagent request" }))
      return
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":3}}}\n\n')
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n')
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address()
  return { server, seen, base: `http://127.0.0.1:${port}/v1` }
}

test("端到端：真实 HTTP、签名对得上、响应原样交回", async () => {
  const secret = "0123456789abcdef0123456789abcdef0123456789abcdef"
  const prompt = "你是一个测试助手"
  const site = { ...SITES.monkeycode, gatewayBaseUrl: "http://127.0.0.1:0/v1" }
  const { server, seen, base } = await startGateway({ secret, prompt })
  try {
    const plugin = await makePlugin({ ...site, gatewayBaseUrl: base })({ client: {} })
    const auth = {
      type: "api",
      key: JSON.stringify({ access_token: "oma_test_key_000000000000000000000", signing_secret: secret }),
    }
    const loader = await plugin.auth.loader(async () => auth)
    const body = JSON.stringify({
      model: "deepseek-flash",
      system: prompt,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 16,
      stream: true,
    })
    const response = await loader.fetch(`${base}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sdk-would-set-this" },
      body,
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)
    // 流必须原样交回（插件不许读干流）。
    const text = await response.text()
    assert.match(text, /message_stop/)

    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, "/v1/messages")
    assert.equal(seen[0].body, body, "body 必须原样转发")
    assert.equal(seen[0].headers["x-api-key"], "oma_test_key_000000000000000000000")
    assert.equal(seen[0].headers["anthropic-version"], "2023-06-01")
    assert.ok(seen[0].headers["x-ohmyagent-signature"].startsWith("v1="))
  } finally {
    server.close()
  }
})

test("端到端：签名用错密钥时服务端 403，插件不吞响应", async () => {
  const site = SITES.monkeycode
  const { server, base } = await startGateway({ secret: "the-real-secret-0123456789abcdef", prompt: "x" })
  try {
    const plugin = await makePlugin({ ...site, gatewayBaseUrl: base })({ client: {} })
    const auth = {
      type: "api",
      key: JSON.stringify({ access_token: "oma_test_key_000000000000000000000", signing_secret: "a-wrong-secret-0123456789abcdef0123456" }),
    }
    const loader = await plugin.auth.loader(async () => auth)
    const response = await loader.fetch(`${base}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ system: "x", messages: [], max_tokens: 4, stream: true }),
    })
    // 原样交回：403 让 magpie 自己判，插件不在这里改状态码。
    assert.equal(response.status, 403)
    const text = await response.text()
    assert.match(text, /invalid ohmyagent request/)
  } finally {
    server.close()
  }
})

test("百智云端到端：真实 HTTP、只认 x-api-key、目录能拉到", async () => {
  const { createServer } = await import("node:http")
  const { once } = await import("node:events")
  const { makeBaizhiPlugin } = await import("../src/baizhi/runtime.mjs")

  const KEY = "sk-" + "c".repeat(64)
  const seen = []
  const server = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    seen.push({ url: req.url, headers: req.headers, body })
    if (req.headers["x-api-key"] !== KEY) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "invalid api key" }))
      return
    }
    if (req.url === "/api/anthropic/v1/models") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: [{ id: "deepseek-v4-pro", display_name: "DeepSeek V4 Pro" }] }))
      return
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address()
  const origin = `http://127.0.0.1:${port}`
  try {
    const { BAIZHI: BAIZHI_FOR_TEST } = await import("../src/baizhi/site.mjs")
    const plugin = await makeBaizhiPlugin({
      ...(await import("../src/baizhi/site.mjs")).BAIZHI,
      baseUrl: `${origin}/api/anthropic/v1`,
      modelsUrl: `${origin}/api/anthropic/v1/models`,
    })({ client: {} })
    const auth = { type: "api", key: KEY }

    // provider.models 是纯静态的：不该打远端目录。
    const models = await plugin.provider.models({ models: {} }, { auth })
    assert.ok(Object.keys(models).length > 10, "登录后拿到的是内置表")
    // 远端目录由 credits 的 fetchRemoteModels 单独负责（含 x-api-key）。
    const { fetchRemoteModels } = await import("../src/baizhi/credits.mjs")
    const live = await fetchRemoteModels(KEY, { ...BAIZHI_FOR_TEST, modelsUrl: `${origin}/api/anthropic/v1/models` })
    assert.deepEqual(live.map((m) => m.id), ["deepseek-v4-pro"])

    const loader = await plugin.auth.loader(async () => auth)
    const body = JSON.stringify({ model: "deepseek-v4-pro", messages: [], max_tokens: 8, stream: true })
    const response = await loader.fetch(`${origin}/api/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "wrong" },
      body,
    })
    assert.equal(response.status, 200, "loader 必须用凭据里的 key 覆盖调用方给的")
    const message = seen.find((entry) => entry.url === "/api/anthropic/v1/messages")
    assert.equal(message.headers["x-api-key"], KEY)
    assert.equal(message.headers["x-ohmyagent-signature"], undefined)
    assert.equal(message.body, body)
  } finally {
    server.close()
  }
})
