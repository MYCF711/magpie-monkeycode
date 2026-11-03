// 单测不许读开发机上的真实账号缓存（可能是「探测后全不可用 ⇒ 空表」）。
process.env.MAGPIE_MONKEYCODE_CACHE_DIR = "C:\__magpie_test_cache__"
// tests/system-open.test.mjs —— 只有 http(s) 才交给系统浏览器
import test from "node:test"
import assert from "node:assert/strict"

import { isSafeHttpUrl, openInSystemBrowser } from "../src/system-open.mjs"

test("只认 http(s) 协议", () => {
  assert.equal(isSafeHttpUrl("https://ai-models.app.baizhi.cloud/console/keys"), true)
  assert.equal(isSafeHttpUrl("http://example.com"), true)
  assert.equal(isSafeHttpUrl("file:///C:/Windows/System32/calc.exe"), false)
  assert.equal(isSafeHttpUrl("javascript:alert(1)"), false)
  assert.equal(isSafeHttpUrl(""), false)
  assert.equal(isSafeHttpUrl(undefined), false)
})

test("openInSystemBrowser 用 start 打开（Windows）并 detach", () => {
  const calls = []
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options })
    return { unref() {} }
  }
  const ok = openInSystemBrowser("https://example.com/x", { spawnImpl: fakeSpawn })
  assert.equal(ok, true)
  assert.equal(calls.length, 1)
  if (process.platform === "win32") {
    assert.equal(calls[0].command, "cmd")
    assert.deepEqual(calls[0].args.slice(0, 3), ["/c", "start", ""])
    assert.equal(calls[0].options.detached, true)
  }
})

test("非法协议一律不发起", () => {
  let called = false
  const fakeSpawn = () => { called = true; return { unref() {} } }
  assert.equal(openInSystemBrowser("file:///etc/passwd", { spawnImpl: fakeSpawn }), false)
  assert.equal(called, false)
})
