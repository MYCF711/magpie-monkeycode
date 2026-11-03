// tests/baizhi-phone-login.test.mjs —— 百智云「手机号 + 验证码」纯 API 登录的语义锁。
//
// 这条路是本仓库的主线登录方式之一（用户明确要求「不要微信扫码」），所以它必须
// 能在没有浏览器的环境里被完整断言：网络一律注入。
//
// 真机证据（2026-11-04，字段名从 `baizhi.cloud/_astro/SignInForm.*.js` 反出）：
//   {phone:"10000000000", kind:"login"} → {"code":400,"message":"手机号未注册"}
//   {phone:"10000000000"}               → {"code":400,"message":"参数错误"}      ← 缺 kind
//   {phone:"10000000000", code:"123456"}→ {"code":400,"message":"phone code not found or expired"}

import test from "node:test"
import assert from "node:assert/strict"

import { loginWithPhoneCode, sendPhoneCode } from "../src/baizhi/phone-login.mjs"

const SITE = {
  loginUrl: "https://example.com/console/",
  sessionCookies: ["baizhi_session", "sl-session"],
  sessionCookie: "baizhi_session",
}

function makeFetch(handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    calls.push({ url, path: new URL(url).pathname, body })
    const { status = 200, json, setCookies = [] } = handler(new URL(url).pathname, body)
    const headers = new Headers({ "content-type": "application/json" })
    for (const line of setCookies) headers.append("set-cookie", line)
    return new Response(JSON.stringify(json), { status, headers })
  }
  return { impl, calls }
}

test("空手机号 / 空验证码：一个请求都不发", async () => {
  const { impl, calls } = makeFetch(() => ({ json: { code: 0 } }))
  assert.equal((await sendPhoneCode({ phone: "  ", site: SITE, fetchImpl: impl })).ok, false)
  assert.equal((await loginWithPhoneCode({ phone: "1", code: "", site: SITE, fetchImpl: impl })).ok, false)
  assert.equal(calls.length, 0)
})

test("发码用的就是反出来的那对字段：{phone, kind:'login'}", async () => {
  const { impl, calls } = makeFetch(() => ({ json: { code: 0 } }))
  const result = await sendPhoneCode({ phone: " 10000000000 ", site: SITE, fetchImpl: impl })
  assert.equal(result.ok, true)
  assert.equal(calls[0].path, "/api/v1/user/phone_code")
  assert.deepEqual(calls[0].body, { phone: "10000000000", kind: "login" })
})

test("手机号未注册 → 说清楚是「没注册过」，不是参数错误", async () => {
  const { impl } = makeFetch(() => ({ status: 400, json: { code: 400, message: "手机号未注册" } }))
  const result = await sendPhoneCode({ phone: "10000000000", site: SITE, fetchImpl: impl })
  assert.equal(result.ok, false)
  assert.match(result.error, /还没注册过百智云/)
})

test("验证码过期 → 让人重新收一条，不怀疑账号", async () => {
  const { impl } = makeFetch(() => ({ status: 400, json: { code: 400, message: "phone code not found or expired" } }))
  const result = await loginWithPhoneCode({ phone: "10000000000", code: "123456", site: SITE, fetchImpl: impl })
  assert.equal(result.ok, false)
  assert.match(result.error, /验证码不对或已过期/)
})

test("登录成功：Set-Cookie 里的 baizhi_session 与 sl-session 都要带出来", async () => {
  const { impl, calls } = makeFetch((path) => {
    if (path === "/api/v1/user/login/phone") {
      return {
        json: { code: 0, message: "success" },
        setCookies: [
          "baizhi_session=sess-A; Path=/; HttpOnly; Secure",
          "sl-session=dev-B; Path=/; HttpOnly; Secure",
          "unrelated=zzz; Path=/",
        ],
      }
    }
    return { json: { code: 400, message: "unexpected" } }
  })
  const result = await loginWithPhoneCode({ phone: "10000000000", code: "123456", site: SITE, fetchImpl: impl })
  assert.equal(result.ok, true)
  // 只要站点声明过的那两枚，顺序跟随 Set-Cookie
  assert.equal(result.cookie, "baizhi_session=sess-A; sl-session=dev-B")
  assert.equal(calls[0].path, "/api/v1/user/login/phone")
  assert.deepEqual(calls[0].body, { phone: "10000000000", code: "123456" })
})

test("登录成功但没有会话 → 报「上游形态可能已变」，不给假 cookie", async () => {
  const { impl } = makeFetch(() => ({ json: { code: 0 } }))
  const result = await loginWithPhoneCode({ phone: "10000000000", code: "123456", site: SITE, fetchImpl: impl })
  assert.equal(result.ok, false)
  assert.match(result.error, /没有会话 cookie/)
})

test("走的是主站 origin（loginUrl 的），不是模型网关", async () => {
  const { impl, calls } = makeFetch(() => ({ json: { code: 0 } }))
  await sendPhoneCode({ phone: "10000000000", site: { ...SITE, loginUrl: "https://console.example.org/console/" }, fetchImpl: impl })
  assert.equal(calls[0].url, "https://console.example.org/api/v1/user/phone_code")
})
