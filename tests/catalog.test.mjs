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
  assert.equal(entry.apiId, "8ca0c30e-08ac-42d5-a4db-584d52fabe98", "请求体里的 model 是 UUID")
  assert.equal(entry.context, 200000)
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
  assert.deepEqual(result.models.map((m) => m.apiId), ["u1"], "隐藏的去重后只剩一条")
})

test("fetchCatalog：平台没有可用模型时报失败，不返回空表", async () => {
  const result = await fetchCatalog("c", site, { fetchImpl: async () => Response.json({ data: [] }) })
  assert.equal(result.ok, false)
})
