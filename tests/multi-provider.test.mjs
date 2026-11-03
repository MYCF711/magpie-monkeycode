// 单测不许读开发机上的真实账号缓存（可能是「探测后全不可用 ⇒ 空表」）。
process.env.MAGPIE_MONKEYCODE_CACHE_DIR = "C:\__magpie_test_cache__"
// tests/multi-provider.test.mjs —— 单包多区：三个供应商互不串味。
//
// 锁四件事：
//   ① 入口只导出两个插件工厂 + 测试对象
//   ② 两个插件各自只注册自己的 provider、共用同一张图标
//   ③ 站点差异只在 src/sites.mjs（共享 runtime 里不许按域名写分支）
//   ④ chat.headers 只标记自己的 provider

import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

// 单测不许真的拉起浏览器：这个门闩让「浏览器登录」走降级分支。
process.env.MAGPIE_PLUGIN_DISABLE_BROWSER = "1"

import * as entry from "../index.mjs"
import { SITES } from "../src/sites.mjs"
import { _internal } from "../src/monkeycode/runtime.mjs"

test("入口只导出三个插件工厂和测试对象", () => {
  const functions = Object.entries(entry)
    .filter(([, value]) => typeof value === "function")
    .map(([key]) => key)
    .sort()
  assert.deepEqual(functions, ["BaizhiAuthPlugin", "MonkeyCodeAuthPlugin", "MonkeyCodeIntlAuthPlugin"])
  assert.equal(typeof entry._internal, "object")
  assert.deepEqual([...entry._internal.providers], ["monkeycode", "monkeycodeintl", "baizhi"])
})

test("三个插件各自只注册自己的 provider", async () => {
  const cn = await entry.MonkeyCodeAuthPlugin({ client: {} })
  const intl = await entry.MonkeyCodeIntlAuthPlugin({ client: {} })
  const bz = await entry.BaizhiAuthPlugin({ client: {} })
  assert.equal(cn.auth.provider, "monkeycode")
  assert.equal(intl.auth.provider, "monkeycodeintl")
  assert.equal(bz.auth.provider, "baizhi")
  // MonkeyCode 两站是同一产品，共用一张图标；百智云是另一家，图标必须不同。
  assert.equal(cn.auth.icon, intl.auth.icon)
  assert.notEqual(cn.auth.icon, bz.auth.icon)
  assert.match(cn.auth.icon, /^data:image\/svg\+xml;base64,/)

  const cfg = { provider: {} }
  await cn.config(cfg)
  await intl.config(cfg)
  await bz.config(cfg)
  assert.deepEqual(Object.keys(cfg.provider).sort(), ["baizhi", "monkeycode", "monkeycodeintl"])
  assert.equal(cfg.provider.monkeycode.api, "https://proxy.monkeycode-ai.com/v1")
  assert.equal(cfg.provider.monkeycodeintl.api, "https://proxy.monkeycode-ai.net/v1")
  assert.equal(cfg.provider.baizhi.api, "https://ai-models.app.baizhi.cloud/api/anthropic/v1")
  // 模型数取决于「平台目录缓存有没有落盘」：内置快照 9 条是兜底，
  // 登录后拉到的真实目录（21 条）优先。这里只要求非空、且不写死数字。
  assert.ok(Object.keys(cfg.provider.monkeycode.models).length >= 9)
  assert.equal(Object.keys(cfg.provider.baizhi.models).length, 15)
})

test("模型 id 里不许有斜杠：magpie 会把 <a>/<b> 读成「provider a 的模型 b」", async () => {
  const cfg = { provider: {} }
  for (const factory of [entry.MonkeyCodeAuthPlugin, entry.MonkeyCodeIntlAuthPlugin, entry.BaizhiAuthPlugin]) {
    await (await factory({ client: {} })).config(cfg)
  }
  for (const [providerId, provider] of Object.entries(cfg.provider)) {
    for (const [modelId, model] of Object.entries(provider.models)) {
      assert.ok(!modelId.includes("/"), `${providerId}/${modelId} 的 id 含斜杠，会被 magpie 拆成幽灵 provider`)
      assert.equal(model.id, modelId, `${providerId}/${modelId}: id 字段要与键一致`)
      // 带 apiId 的模型：api.id 必须指回上游真实 id（MonkeyCode 是设备 UUID，
      // 百智云的远端目录是带斜杠的命名空间）。判据只看「指回去了」。
      if (model.apiId !== undefined) {
        assert.ok(model.apiId.length > 0, `${providerId}/${modelId}: apiId 不能为空`)
        assert.equal(model.api.id, model.apiId)
      }
    }
  }
})

test("两区共享协议，差异只留在站点适配器", async () => {
  assert.equal(typeof _internal.makePlugin, "function")
  assert.equal(typeof _internal.configModels, "function")
  assert.equal(SITES.monkeycode.platformBaseUrl, "https://monkeycode-ai.com")
  assert.equal(SITES.monkeycodeintl.platformBaseUrl, "https://monkeycode-ai.net")
  assert.equal(SITES.monkeycode.sessionCookie, SITES.monkeycodeintl.sessionCookie)
  // 共享 runtime 里不许按域名写分支（站点差异只能在 sites.mjs）。
  const runtime = await readFile(new URL("../src/monkeycode/runtime.mjs", import.meta.url), "utf8")
  assert.doesNotMatch(runtime, /monkeycode-ai\.(com|net)/)
})

test("chat.headers 只标记自己的 provider", async () => {
  const cn = await entry.MonkeyCodeAuthPlugin({ client: {} })
  const intl = await entry.MonkeyCodeIntlAuthPlugin({ client: {} })
  const bz = await entry.BaizhiAuthPlugin({ client: {} })
  const mine = { headers: {} }
  await cn["chat.headers"]({ model: { providerID: "monkeycode" }, sessionID: "s1" }, mine)
  assert.equal(mine.headers["x-monkeycode-session"], "s1")
  const other = { headers: {} }
  await intl["chat.headers"]({ model: { providerID: "monkeycode" }, sessionID: "s1" }, other)
  assert.deepEqual(other.headers, {})
  const third = { headers: {} }
  await bz["chat.headers"]({ model: { providerID: "baizhi" }, sessionID: "s2" }, third)
  assert.equal(third.headers["x-baizhi-session"], "s2")
})

test("三家都同时提供 API Key 与至少一种 oauth，且每个 authorize 都立刻返回", async () => {
  for (const factory of [entry.MonkeyCodeAuthPlugin, entry.MonkeyCodeIntlAuthPlugin, entry.BaizhiAuthPlugin]) {
    const plugin = await factory({ client: {} })
    const types = plugin.auth.methods.map((method) => method.type)
    assert.ok(types.includes("api"), "每家都要能直接粘 Key")
    assert.ok(types.includes("oauth"), "每家都要有浏览器登录")
    for (const method of plugin.auth.methods) {
      if (method.type !== "oauth") continue
      // authorize() 不许在返回前等用户登录（那会和 magpie 死锁）。
      const started = Date.now()
      const flow = await method.authorize()
      assert.ok(Date.now() - started < 1000, `${method.label}: authorize 必须立刻返回`)
      assert.equal(typeof flow.callback, "function")
      // 没有可用浏览器（测试门闩关掉了探测）时，插件必须让 magpie 去开系统浏览器
      // —— 否则用户就是对着空面板干等，连个手动地址都拿不到。
      if (flow.opened === true) assert.equal(flow.opened, true)
      else assert.ok(String(flow.instructions).length > 0, `${method.label}: 没开窗口就必须给出手动地址`)
      assert.ok(flow.url.startsWith("https://"))
    }
  }
})

test("MonkeyCode 提供「用百智云账号开通」入口（SSO，不是另存一个百智云账号）", async () => {
  for (const factory of [entry.MonkeyCodeAuthPlugin, entry.MonkeyCodeIntlAuthPlugin]) {
    const plugin = await factory({ client: {} })
    const labels = plugin.auth.methods.map((method) => method.label)
    assert.ok(labels.some((label) => label.includes("百智云账号开通")), "缺 SSO 入口")
    const sso = plugin.auth.methods.find((method) => method.label.includes("用百智云账号开通"))
    const flow = await sso.authorize()
    // 窗口开在百智云控制台：用户在里面登录/换号。
    assert.equal(flow.url, "https://baizhi.cloud/console/")
  }
})
