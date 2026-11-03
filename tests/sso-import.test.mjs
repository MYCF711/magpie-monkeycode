// tests/sso-import.test.mjs —— 「百智云账号 → MonkeyCode 账号」的账号选取逻辑。
//
// 不碰网络、不起浏览器：只验「读 magpie 账号库 → 挑出还没导过的那个」这条纯逻辑。
// 真正的 SSO 流程在 tests/integration 之外靠真机验证（需要真实百智云会话）。

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { nextUnimported, readBaizhiSessions, _internal } from "../src/monkeycode/sso-import.mjs"

function storeWith(entries) {
  const dir = mkdtempSync(join(tmpdir(), "sso-test-"))
  const file = join(dir, "plugin-auth.json")
  writeFileSync(file, JSON.stringify(entries, null, 2))
  return file
}

test("只挑 baizhi 的条目，并且必须带 session_cookie", () => {
  const file = storeWith({
    baizhi: { type: "api", access: JSON.stringify({ access_token: "sk-1", session_cookie: "sl-session=a; baizhi_session=b", user_id: "u1" }) },
    "baizhi#a1b2": { type: "api", access: JSON.stringify({ access_token: "sk-2", session_cookie: "sl-session=c; baizhi_session=d" }) },
    // 没有 cookie 的（只粘了 Key）不该被当成可导入账号。
    "baizhi#c3d4": { type: "api", access: JSON.stringify({ access_token: "sk-3" }) },
    monkeycode: { type: "api", access: JSON.stringify({ access_token: "oma_x", session_cookie: "monkeycode_ai_session=z" }) },
    workbuddy: { type: "api", access: JSON.stringify({ access_token: "wb" }) },
  })
  const sessions = readBaizhiSessions(file)
  assert.equal(sessions.length, 2)
  assert.deepEqual(sessions.map((session) => session.key), ["baizhi", "baizhi#a1b2"])
  assert.equal(sessions[0].identity, "u1", "有 user_id 就用它当身份")
  assert.equal(sessions[1].identity, "sk-2", "没有 user_id 退到 access_token")
})

test("坏的 JSON / 缺字段不会让整个读取失败", () => {
  const file = storeWith({
    baizhi: { type: "api", access: "not-json" },
    "baizhi#x": { type: "api", access: JSON.stringify({ session_cookie: "c" }) },
    "baizhi#y": null,
    "baizhi#z": { type: "api", access: JSON.stringify({ access_token: "ok", session_cookie: "s=b; baizhi_session=c" }) },
  })
  const sessions = readBaizhiSessions(file)
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].key, "baizhi#z")
})

test("nextUnimported 跳过已导入的，全部导完返回 undefined", () => {
  const sessions = [{ identity: "a" }, { identity: "b" }, { identity: "c" }]
  assert.equal(nextUnimported(sessions, new Set()).identity, "a")
  assert.equal(nextUnimported(sessions, new Set(["a"])).identity, "b")
  assert.equal(nextUnimported(sessions, new Set(["a", "b"])).identity, "c")
  assert.equal(nextUnimported(sessions, new Set(["a", "b", "c"])), undefined)
})

test("账号库不存在时返回空数组而不是抛错", () => {
  assert.deepEqual(readBaizhiSessions("/definitely/not/here/plugin-auth.json"), [])
})
