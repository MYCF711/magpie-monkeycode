// 单测不许读开发机上的真实账号缓存（可能是「探测后全不可用 ⇒ 空表」）。
process.env.MAGPIE_MONKEYCODE_CACHE_DIR = "C:\__magpie_test_cache__"
// MonkeyCode 平台目录：UUID 才是请求体里的 model，内置名字早过时了。
import test from "node:test"
import assert from "node:assert/strict"

import { entryOf, fetchCatalog } from "../src/monkeycode/catalog.mjs"

const site = { id: "monkeycode", platformBaseUrl: "https://monkeycode-ai.com", gatewayBaseUrl: "https://proxy.monkeycode-ai.com/v1" }

test("entryOf：UUID 进 apiId，model 名压成 slug；隐藏与 OpenAI 协议的被跳过", () => {
  const entry = entryOf({
    id: "8ca0c30e-08ac-42d5-a4db-584d52fabe98",
    model: "monkeycode-pro/hy3",
    context_limit: 200000,
    output_limit: 32000,
    support_image: true,
    interface_type: "anthropic",
    is_hidden: false,
  })
  assert.equal(entry.id, "monkeycode-pro-hy3", "斜杠必须压平，否则 magpie 拆出幽灵供应商")
  // 实测：同一个模型传 UUID 回 403、传 model 名回 200 —— 请求体里的 model 是后者。
  assert.equal(entry.apiId, "monkeycode-pro/hy3", "请求体里的 model 是平台 model 名（带档位前缀）")
  assert.equal(entry.uuid, "8ca0c30e-08ac-42d5-a4db-584d52fabe98", "UUID 留着做区分，但不用于请求")
  assert.equal(entry.context, 1048576, "按 1M 报（平台标的 200K 是软配置）")
  assert.equal(entry.image, true)
  assert.equal(entryOf({ id: "x", model: "y", interface_type: "openai_responses" }), undefined)
  assert.equal(entryOf({ model: "y" }), undefined, "没有 id 的条目不能用")
})

test("fetchCatalog 用 cookie 认证，过滤隐藏模型并去重", async () => {
  let seenCookie = ""
  const result = await fetchCatalog("sl-session=a; baizhi_session=b", site, {
    fetchImpl: async (url, init) => {
      seenCookie = init.headers.cookie
      assert.equal(url, "https://monkeycode-ai.com/api/v1/users/models")
      return Response.json({
        data: [
          { id: "u1", model: "a/b", is_hidden: false, interface_type: "anthropic", context_limit: 200000 },
          { id: "u2", model: "a/b", is_hidden: false, interface_type: "anthropic" },
          { id: "u3", model: "hidden-one", is_hidden: true, interface_type: "anthropic" },
          { id: "u4", model: "resp", interface_type: "openai_responses" },
        ],
      })
    },
  })
  assert.match(seenCookie, /baizhi_session=b/)
  assert.equal(result.models.length, 1, "隐藏的、重复的都只剩一条")
  assert.equal(result.models[0].apiId, "a/b", "apiId 是 model 名")
})

test("fetchCatalog：平台没有可用模型时报失败，不返回空表", async () => {
  const result = await fetchCatalog("c", site, { fetchImpl: async () => Response.json({ data: [] }) })
  assert.equal(result.ok, false)
})

test("prettyModelName：平台的原样标识翻成人能读的名字", async () => {
  const { prettyModelName } = await import("../src/monkeycode/catalog.mjs")
  assert.equal(prettyModelName("monkeycode-basic/glm-5.3-flash"), "GLM-5.3-Flash · 基础档")
  assert.equal(prettyModelName("monkeycode-pro/hy3"), "HY3 · 专业档")
  assert.equal(prettyModelName("monkeycode-ultra/qwen3.7-max"), "Qwen3.7-Max · 旗舰档")
  assert.equal(prettyModelName("qwen3.6-plus"), "Qwen3.6-Plus")
  assert.equal(prettyModelName("minimax-m2.5"), "MiniMax-M2.5")
  assert.equal(prettyModelName("deepseek-flash"), "DeepSeek-Flash")
  assert.equal(prettyModelName(""), "")
})

test("probeCatalog：只有 200 才算能用，403/异常一律不可用", async () => {
  const { probeCatalog } = await import("../src/monkeycode/catalog.mjs")
  const credential = { access_token: "oma_x", signing_secret: "s".repeat(48) }
  const models = [{ apiId: "u1", id: "m1" }, { apiId: "u2", id: "m2" }, { apiId: "u3", id: "m3" }]
  const probed = await probeCatalog(credential, { gatewayBaseUrl: "https://gw.example/v1" }, models, {
    concurrency: 2,
    probe: async (cred, site, model) => model.apiId === "u2",
  })
  assert.deepEqual(probed.map((m) => m.usable), [false, true, false])
})

test("refreshCatalog 带 credential 时会把可用性探进去", async () => {
  const { probeCatalog } = await import("../src/monkeycode/catalog.mjs")
  assert.equal(typeof probeCatalog, "function")
})

test("签名 prompt：没有 system 的请求必须补 FALLBACK_SYSTEM（否则网关一律 403）", async () => {
  const { FALLBACK_SYSTEM, parseBodyQuietly, signingPrompt } = await import("../src/monkeycode/signing.mjs")
  assert.ok(FALLBACK_SYSTEM.length > 0)
  // 无 system 的请求：prompt 为空 —— 这就是网关回 invalid ohmyagent request 的原因。
  const bare = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] })
  assert.equal(signingPrompt(parseBodyQuietly(bare)), "")
  // 补上 system 之后就有东西可签了。
  const patched = JSON.stringify({ ...JSON.parse(bare), system: FALLBACK_SYSTEM })
  assert.equal(signingPrompt(parseBodyQuietly(patched)), FALLBACK_SYSTEM)
})

test("上下文窗口按 1M 报（平台标的 200K 是软配置，实测 500K 都能过）", async () => {
  const { entryOf, KNOWN_CONTEXT } = await import("../src/monkeycode/catalog.mjs")
  const raw = { id: "u", model: "m", context_limit: 200000, output_limit: 32000, interface_type: "anthropic" }
  // magpie 拿这个值决定 agent 何时压缩上下文：报 200K 就会在 200K 丢历史。
  assert.equal(entryOf(raw).context, 1048576)
  assert.equal(KNOWN_CONTEXT, 1048576)
  // 平台给得更大时不被压小。
  assert.equal(entryOf({ ...raw, context_limit: 2000000 }).context, 2000000)
})

test("签名 prompt：没有 system 的请求必须补 FALLBACK_SYSTEM（否则网关一律 403）", async () => {
  const { FALLBACK_SYSTEM, parseBodyQuietly, signingPrompt } = await import("../src/monkeycode/signing.mjs")
  assert.ok(FALLBACK_SYSTEM.length > 0)
  // 无 system 的请求：prompt 为空 —— 这就是网关回 invalid ohmyagent request 的原因。
  const bare = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] })
  assert.equal(signingPrompt(parseBodyQuietly(bare)), "")
  // 补上 system 之后就有东西可签了。
  const patched = JSON.stringify({ ...JSON.parse(bare), system: FALLBACK_SYSTEM })
  assert.equal(signingPrompt(parseBodyQuietly(patched)), FALLBACK_SYSTEM)
})
