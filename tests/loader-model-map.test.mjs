// tests/loader-model-map.test.mjs —— 发出去的 `model` 必须是上游认得的那串
//
// 2026-11-04 真机：国际站两条模型全部 `403 Forbidden`。直连上游用同一份凭据试：
//
//   monkeycode-basic/deepseek-flash                  → 200
//   monkeycode-basic-deepseek-flash（slug）          → 403 Forbidden
//   <uuid>                                           → 403 Forbidden
//   deepseek-flash（裸名）                            → 403 Forbidden
//
// 根因在 magpie 侧：它构造上游请求时用的是 `api: { id: m.id ?? … }` —— **我们返回的
// `id`**（斜杠被压成连字符），config 里给的 `api.id` 被无视。而 magpie 的模型 id 又
// 不能带斜杠（会被当成 provider 边界，长出 `monkeycode-basic` / `monkeycode-pro` /
// `monkeycode-ultra` 三个不存在的供应商）。
//
// 所以只能在 loader.fetch 里换回来。这个测试锁的就是这一步。

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "magpie-modelmap-"))
process.env.MAGPIE_MONKEYCODE_CACHE_DIR = dir
process.env.MAGPIE_PLUGIN_DISABLE_BROWSER = "1"

writeFileSync(join(dir, "monkeycode-models-monkeycodeintl.json"), JSON.stringify({
  fetchedAt: Date.now(),
  models: [{
    id: "monkeycode-basic-deepseek-flash",
    apiId: "monkeycode-basic/deepseek-flash",
    name: "monkeycode-basic/deepseek-flash",
    displayName: "DeepSeek-Flash · 基础档",
    context: 1048576,
    output: 32000,
    image: true,
    free: false,
  }],
}), "utf8")

const { MonkeyCodeIntlAuthPlugin } = await import("../index.mjs")

const AUTH = {
  type: "api",
  key: JSON.stringify({ access_token: "oma_testtesttesttest", signing_secret: "secret-secret-secret" }),
}

/** 跑一次 loader.fetch，返回真正发出去的东西。 */
async function send(body, initExtra = {}) {
  const plugin = await MonkeyCodeIntlAuthPlugin({}, {})
  const loader = await plugin.auth.loader(async () => AUTH)
  let captured
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captured = { url, headers: init?.headers, body: init?.body }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }
  try {
    await loader.fetch(`${loader.baseURL}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...initExtra,
    })
  } finally {
    globalThis.fetch = realFetch
  }
  return captured
}

test("magpie 的模型 id 被换回平台原值（带档位前缀），不是 slug", async () => {
  const captured = await send({
    model: "monkeycode-basic-deepseek-flash",
    max_tokens: 8,
    messages: [{ role: "user", content: "hi" }],
  })
  const sent = JSON.parse(captured.body)
  assert.equal(sent.model, "monkeycode-basic/deepseek-flash")
})

test("已经是上游原值时不动它（幂等）", async () => {
  const captured = await send({
    model: "monkeycode-basic/deepseek-flash",
    max_tokens: 8,
    messages: [{ role: "user", content: "hi" }],
  })
  assert.equal(JSON.parse(captured.body).model, "monkeycode-basic/deepseek-flash")
})

test("目录里没有的 model 原样放行（不猜、不改）", async () => {
  const captured = await send({
    model: "some-unknown-model",
    max_tokens: 8,
    messages: [{ role: "user", content: "hi" }],
  })
  assert.equal(JSON.parse(captured.body).model, "some-unknown-model")
})

test("改完 model 之后补 system、并按最终 body 签名", async () => {
  const captured = await send({
    model: "monkeycode-basic-deepseek-flash",
    max_tokens: 8,
    messages: [{ role: "user", content: "hi" }],
  })
  const sent = JSON.parse(captured.body)
  assert.equal(typeof sent.system, "string")
  assert.ok(sent.system.length > 0, "没 system 的请求上游一律 403 invalid ohmyagent request")
  const headers = captured.headers instanceof Headers ? Object.fromEntries(captured.headers) : captured.headers
  const signature = headers["x-ohmyagent-signature"] ?? headers["X-OhmyAgent-Signature"]
  assert.ok(String(signature).startsWith("v1="), "签名头必须存在")
})
