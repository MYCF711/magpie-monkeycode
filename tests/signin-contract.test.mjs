// 单测不许读开发机上的真实账号缓存（可能是「探测后全不可用 ⇒ 空表」）。
process.env.MAGPIE_MONKEYCODE_CACHE_DIR = "C:\\__magpie_test_cache__"
// tests/signin-contract.test.mjs —— oauth 登录结果必须存得下
//
// 锁的是 2026-11-04 真机踩到的那条：**卡片说「已登录」，列表里却没有它。**
//
// magpie 的插件宿主（`host.js` 的 `save()`）只认两条出口：
//
//   if ("refresh" in result) setAuth(key, { type: "oauth", refresh, access, expires, ...extra })
//   else if ("key" in result || apiKey) setAuth(key, { type: "api", key, metadata })
//
// 我们的 success 一直只给 `access`（没有 `refresh`，也没有 `key`）—— 两条都不命中，
// 宿主**既不保存也不报错**：`saved` 照常回 ok，magpie 显示「已登录」，而账号没落盘。
// 紧接着的 `providers?wait=1` 里当然找不到这个 account，界面就打出
// 「{user} 已登录，但 magpie 无法列出它，请反馈此问题」。
//
// 所以这里锁两件事：
//   ① `signInSuccess()` 一定带上 `refresh`（与 access 同值）与 type
//   ② **生产代码里不许再出现裸的 `type: "success"`** —— 一律走 signInSuccess，
//      否则下一次新增登录方式会原样复制这个静默失败

import test from "node:test"
import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { signInSuccess } from "../src/credential.mjs"

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src")

test("signInSuccess 带上 refresh（等于 access），且 type 是 success", () => {
  const result = signInSuccess({
    access: '{"access_token":"oma_testtoken","signing_secret":"secret"}',
    accountId: "观猹员 0001",
    uid: "01a0edd5-0000-4000-8000-000000000000",
  })
  assert.equal(result.type, "success")
  assert.equal(result.access, result.refresh)
  assert.equal(result.expires, 0)
  assert.equal(result.accountId, "观猹员 0001")
  assert.equal(result.uid, "01a0edd5-0000-4000-8000-000000000000")
})

test("refresh 位必须真的在对象上（in 检测，不看值）", () => {
  // magpie 用的是 `"refresh" in result`：属性存在即命中，值为 undefined 也算。
  const result = signInSuccess({ access: "sk-test" })
  assert.ok("refresh" in result)
  // 空账号名 / 空 uid 不写进结果：宿主用 whoOf() 判重，空串会把两个不同账号并成一个。
  assert.equal("accountId" in result, false)
  assert.equal("uid" in result, false)
})

test("message 只在有内容时才出现", () => {
  assert.equal("message" in signInSuccess({ access: "sk-test", message: "" }), false)
  assert.equal(signInSuccess({ access: "sk-test", message: "已更新" }).message, "已更新")
})

test("生产代码里没有裸的 type: \"success\"（signInSuccess 之外）", async () => {
  const files = []
  async function walk(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, item.name)
      if (item.isDirectory()) await walk(path)
      else if (item.name.endsWith(".mjs")) files.push(path)
    }
  }
  await walk(SRC)
  assert.ok(files.length > 10, "src 下的模块没找全")

  const offenders = []
  for (const file of files) {
    const text = await readFile(file, "utf8")
    // credential.mjs 是 signInSuccess 的老家，它必须写这个字面量。
    const lines = text.split("\n")
    lines.forEach((line, index) => {
      const trimmed = line.trim()
      // 注释里举例不算：account-name.mjs 的文档注释就写着这个形状。
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return
      if (line.includes('type: "success"') && !file.endsWith("credential.mjs")) {
        offenders.push(`${file.slice(SRC.length + 1)}:${index + 1}`)
      }
    })
  }
  assert.deepEqual(offenders, [], "这些地方直接返回了 success，magpie 不会保存它们；请改用 signInSuccess()")
})

test("所有导出 entry 的插件都是工厂（signInSuccess 没破坏入口）", async () => {
  const entry = await import("../index.mjs")
  for (const name of ["MonkeyCodeAuthPlugin", "MonkeyCodeIntlAuthPlugin", "BaizhiAuthPlugin"]) {
    assert.equal(typeof entry[name], "function")
  }
})
