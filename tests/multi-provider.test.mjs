// tests/multi-provider.test.mjs —— 单包双区：两个供应商互不串味。
//
// 锁四件事：
//   ① 入口只导出两个插件工厂 + 测试对象
//   ② 两个插件各自只注册自己的 provider、共用同一张图标
//   ③ 站点差异只在 src/sites.mjs（共享 runtime 里不许按域名写分支）
//   ④ chat.headers 只标记自己的 provider

import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import * as entry from "../index.mjs"
import { SITES } from "../src/sites.mjs"
import { _internal } from "../src/monkeycode/runtime.mjs"

test("入口只导出两个插件工厂和测试对象", () => {
  const functions = Object.entries(entry)
    .filter(([, value]) => typeof value === "function")
    .map(([key]) => key)
    .sort()
  assert.deepEqual(functions, ["MonkeyCodeAuthPlugin", "MonkeyCodeIntlAuthPlugin"])
  assert.equal(typeof entry._internal, "object")
  assert.deepEqual(entry._internal.providers, ["monkeycode", "monkeycodeintl"])
})

test("两个插件各自只注册自己的 provider，并共用 MonkeyCode 图标", async () => {
  const cn = await entry.MonkeyCodeAuthPlugin({ client: {} })
  const intl = await entry.MonkeyCodeIntlAuthPlugin({ client: {} })
  assert.equal(cn.auth.provider, "monkeycode")
  assert.equal(intl.auth.provider, "monkeycodeintl")
  assert.notEqual(cn.auth, intl.auth)
  assert.equal(cn.auth.icon, intl.auth.icon)
  assert.match(cn.auth.icon, /^data:image\/svg\+xml;base64,/)

  const cfg = { provider: {} }
  await cn.config(cfg)
  await intl.config(cfg)
  assert.deepEqual(Object.keys(cfg.provider).sort(), ["monkeycode", "monkeycodeintl"])
  assert.equal(cfg.provider.monkeycode.api, "https://proxy.monkeycode-ai.com/v1")
  assert.equal(cfg.provider.monkeycodeintl.api, "https://proxy.monkeycode-ai.net/v1")
  assert.equal(Object.keys(cfg.provider.monkeycode.models).length, 9)
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
  const mine = { headers: {} }
  await cn["chat.headers"]({ model: { providerID: "monkeycode" }, sessionID: "s1" }, mine)
  assert.equal(mine.headers["x-monkeycode-session"], "s1")
  const other = { headers: {} }
  await intl["chat.headers"]({ model: { providerID: "monkeycode" }, sessionID: "s1" }, other)
  assert.deepEqual(other.headers, {})
})

test("两站都声明了浏览器登录与 API Key 两条入口，且 authorize 立刻返回", async () => {
  for (const factory of [entry.MonkeyCodeAuthPlugin, entry.MonkeyCodeIntlAuthPlugin]) {
    const plugin = await factory({ client: {} })
    const types = plugin.auth.methods.map((method) => method.type).sort()
    assert.deepEqual(types, ["api", "oauth"])
    const oauth = plugin.auth.methods.find((method) => method.type === "oauth")
    // authorize() 不许在返回前等用户登录（那会和 magpie 死锁）。
    const started = Date.now()
    const flow = await oauth.authorize()
    assert.ok(Date.now() - started < 1000, "authorize 必须立刻返回")
    assert.equal(typeof flow.callback, "function")
    assert.equal(flow.opened, true, "窗口由插件自己打开，别让 magpie 再开一个")
    assert.ok(flow.url.startsWith("https://monkeycode-ai."))
  }
})
