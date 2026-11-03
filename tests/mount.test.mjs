// 单测不许读开发机上的真实账号缓存（可能是「探测后全不可用 ⇒ 空表」）。
process.env.MAGPIE_MONKEYCODE_CACHE_DIR = "C:\__magpie_test_cache__"
// tests/mount.test.mjs —— 单包多 Provider 的挂载契约
//
// magpie 会把入口里的每个函数导出都当成插件工厂，因此这里锁四件事：
//   ① 入口恰好导出三个 *Plugin 函数
//   ② 两个函数返回完整九钩，provider id 与各自的站点一致
//   ③ 未登录时 config.models 仍非空（否则卡片显示 "0 models"）
//   ④ loader 未登录返回空对象，usage 不伪造额度
//
// 全部离线；不需要 magpie 进程、不需要凭据。

import test from "node:test"
import assert from "node:assert/strict"

import * as entry from "../index.mjs"
import { _internal } from "../index.mjs"

const EXPECTED = {
  monkeycode: entry.MonkeyCodeAuthPlugin,
  monkeycodeintl: entry.MonkeyCodeIntlAuthPlugin,
  baizhi: entry.BaizhiAuthPlugin,
}

/** 有签到的供应商（百智云没有）。 */
const CHECKIN = new Set(["monkeycode", "monkeycodeintl"])

test("入口恰好导出三个插件函数", () => {
  const functions = Object.entries(entry)
    .filter(([, value]) => typeof value === "function")
    .map(([key]) => key)
    .sort()
  assert.deepEqual(functions, ["BaizhiAuthPlugin", "MonkeyCodeAuthPlugin", "MonkeyCodeIntlAuthPlugin"])
  assert.deepEqual([..._internal.providers], ["monkeycode", "monkeycodeintl", "baizhi"])
})

for (const [id, factory] of Object.entries(EXPECTED)) {
  test(`${id}: 九钩齐全且只注册自己`, async () => {
    const plugin = await factory({ client: {} })
    assert.equal(typeof plugin.config, "function")
    assert.equal(plugin.auth.provider, id)
    assert.equal(plugin.provider.id, id)
    assert.equal(typeof plugin.auth.refresh, "function")
    assert.equal(typeof plugin.auth.loader, "function")
    assert.equal(typeof plugin.auth.usage, "function")
    if (CHECKIN.has(id)) assert.equal(typeof plugin.auth.checkin, "function")
    else assert.equal(plugin.auth.checkin, undefined, `${id} 没有签到，不该实现 checkin`)
    assert.equal(typeof plugin.provider.models, "function")
    assert.equal(typeof plugin["chat.headers"], "function")
    assert.ok(Array.isArray(plugin.auth.methods) && plugin.auth.methods.length >= 1)
    // api 方式刻意不写 authorize（magpie 原样保存 {type:"api",key}，见 HOOKS 陷阱 2）；
    // 需要 authorize 的是 oauth 那条。
    const oauth = plugin.auth.methods.find((method) => method.type === "oauth")
    assert.equal(typeof oauth.authorize, "function")
    assert.ok(plugin.auth.icon.startsWith("data:image/"))
    assert.ok(Number.isInteger(plugin.auth.maxConcurrency) && plugin.auth.maxConcurrency >= 1)
  })

  test(`${id}: 未登录也有静态模型，且五个模态键都是布尔`, async () => {
    const plugin = await factory({ client: {} })
    const cfg = {}
    await plugin.config(cfg)
    const models = cfg.provider?.[id]?.models
    assert.ok(models && Object.keys(models).length > 0, "config.models 不能为空")
    assert.deepEqual(Object.keys(cfg.provider), [id])
    for (const [modelId, model] of Object.entries(models)) {
      assert.ok(model.modalities.input.includes("text"), `${modelId}.modalities.input`)
      for (const key of ["text", "image", "audio", "video", "pdf"]) {
        assert.equal(typeof model.capabilities.input[key], "boolean", `${modelId}.${key}`)
      }
      assert.equal(model.api.npm, "@ai-sdk/anthropic", `${modelId} 走 Anthropic Messages`)
      assert.match(model.api.url, /^https:\/\//, `${modelId}.api.url`)
    }
  })

  test(`${id}: loader 未登录返回空对象`, async () => {
    const plugin = await factory({ client: {} })
    assert.deepEqual(await plugin.auth.loader(async () => null), {})
  })

  test(`${id}: usage 未登录不伪造 0`, async () => {
    const plugin = await factory({ client: {} })
    const usage = await plugin.auth.usage(async () => null)
    assert.equal(typeof usage.error, "string")
    assert.ok(usage.windows === undefined || usage.windows.length === 0, "未登录绝不能伪造额度窗口")
  })

  test(`${id}: refresh 不发网络、不返回假成功`, async () => {
    const plugin = await factory({ client: {} })
    const original = globalThis.fetch
    let called = false
    globalThis.fetch = async () => { called = true; throw new Error("不该发请求") }
    try {
      assert.equal(await plugin.auth.refresh({ access: "{}" }), undefined)
      assert.equal(called, false)
    } finally {
      globalThis.fetch = original
    }
  })
}
