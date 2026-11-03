// tests/credential.test.mjs —— 凭据解析（一个 key 里塞两个字段的那类厂商）
//
// 锁三件事：三种输入形态、**不校验前缀**、以及「只有 session_cookie 也放行」。

import test from "node:test"
import assert from "node:assert/strict"

import { hasSigningSecret, hasToken, maskKey, parseCredential } from "../src/credential.mjs"

const KEY = "oma_abcdefghijklmnopqrstuvwxyz012345"
const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef"

test("parseCredential：JSON / key:secret / 裸 token 三种输入", () => {
  assert.deepEqual(parseCredential(JSON.stringify({ access_token: KEY, signing_secret: SECRET })), { access_token: KEY, signing_secret: SECRET })
  assert.deepEqual(parseCredential(`${KEY}:${SECRET}`), { access_token: KEY, signing_secret: SECRET })
  assert.deepEqual(parseCredential(`${KEY} ${SECRET}`), { access_token: KEY, signing_secret: SECRET })
  assert.deepEqual(parseCredential(KEY), { access_token: KEY })
  assert.equal(parseCredential(""), undefined)
  assert.equal(parseCredential("{}"), undefined)
  assert.equal(parseCredential("不是 token"), undefined, "含中文/空格的输入不是 token")
})

test("parseCredential 不校验前缀（厂商换前缀不该把新 Key 判死）", () => {
  const key = "anyproviderkey-0123456789abcdef0123"
  assert.deepEqual(parseCredential(`${key}:${SECRET}`), { access_token: key, signing_secret: SECRET })
})

test("parseCredential：只有 session_cookie 也放行（额度能力靠它，不是靠 key）", () => {
  const only = JSON.stringify({ session_cookie: "sl-session=a; baizhi_session=b" })
  assert.deepEqual(parseCredential(only), { session_cookie: "sl-session=a; baizhi_session=b" })
  // 但两个字段都空还是判无效。
  assert.equal(parseCredential(JSON.stringify({ access_token: "" })), undefined)
  assert.equal(parseCredential("{}"), undefined)
  // hasToken 仍然是否决线：只有 cookie 的账号发不了消息。
  assert.equal(hasToken(parseCredential(only)), false)
})

test("hasToken / hasSigningSecret / maskKey", () => {
  assert.equal(hasToken({ access_token: "x" }), true)
  assert.equal(hasToken({}), false)
  assert.equal(hasSigningSecret({ signing_secret: "y" }), true)
  assert.equal(hasSigningSecret({ access_token: "x" }), false)
  assert.equal(maskKey("sk-0123456789abcdef"), "sk-0…cdef")
  assert.equal(maskKey("short"), "")
})
