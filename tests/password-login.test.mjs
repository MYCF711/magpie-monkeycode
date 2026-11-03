// tests/password-login.test.mjs —— 「账号密码纯 API 登录」的语义锁。
//
// 这条路的价值就是**不开窗**，所以它必须能在没有浏览器的环境里跑完：
// 网络一律注入（`fetchImpl`），断言只看「请求长得对不对」和「响应怎么被解读」。
//
// 真机事实（2026-11-04，国内站与国际站都实测）：
//   · 不带 captcha_token 打 password-login → **403 禁止访问**（不是 400）
//   · 字段名从国际站前端 bundle 逐字取出：{ email, password, captcha_token }
//   · 账号密码不对 → {"code":10606,"message":"登录失败"}

import test from "node:test"
import assert from "node:assert/strict"

import { fetchCaptchaToken, loginWithPassword, PASSWORDS_MISMATCH } from "../src/monkeycode/password-login.mjs"

const SITE = {
  id: "monkeycode",
  platformBaseUrl: "https://example.com",
  sessionCookie: "monkeycode_ai_session",
}

/** 记录每次请求，并按路径回放给定响应。 */
function makeFetch(routes) {
  const calls = []
  const impl = async (url, init = {}) => {
    const path = new URL(url).pathname
    calls.push({ path, body: init.body === undefined ? undefined : JSON.parse(init.body), headers: init.headers })
    const route = routes[path]
    if (route === undefined) throw new Error(`unexpected path ${path}`)
    const { status = 200, json, setCookies = [] } = route
    const headers = new Headers({ "content-type": "application/json" })
    for (const line of setCookies) headers.append("set-cookie", line)
    return new Response(JSON.stringify(json), { status, headers })
  }
  return { impl, calls }
}

const CHALLENGE = { token: "tok-abc", challenge: { c: 2, s: 8, d: 3 } }

test("空账号 / 空密码：不发任何请求就报错", async () => {
  const { impl, calls } = makeFetch({})
  assert.equal((await loginWithPassword({ email: "  ", password: "x", site: SITE, fetchImpl: impl })).ok, false)
  assert.equal((await loginWithPassword({ email: "a@b.co", password: "", site: SITE, fetchImpl: impl })).ok, false)
  assert.equal(calls.length, 0)
})

test("验证题 c/s/d 缺失或不是数字 → 如实报「形态可能已变」，不硬试", async () => {
  const { impl } = makeFetch({
    "/api/v1/public/captcha/challenge": { json: { token: "tok", challenge: { c: "x" } } },
  })
  const result = await fetchCaptchaToken(SITE, { fetchImpl: impl })
  assert.equal(result.ok, false)
  assert.match(result.error, /形态可能已变/)
})

test("challenge 没有 token → 报错而不是继续 redeem", async () => {
  const { impl, calls } = makeFetch({
    "/api/v1/public/captcha/challenge": { json: { challenge: { c: 1, s: 4, d: 1 } } },
  })
  const result = await fetchCaptchaToken(SITE, { fetchImpl: impl })
  assert.equal(result.ok, false)
  assert.equal(calls.length, 1)
})

test("完整链路：challenge → redeem → password-login，并从 Set-Cookie 取会话", async () => {
  const { impl, calls } = makeFetch({
    "/api/v1/public/captcha/challenge": { status: 201, json: CHALLENGE },
    "/api/v1/public/captcha/redeem": { status: 201, json: { token: "cap-1", success: true } },
    "/api/v1/users/password-login": {
      json: { code: 0, message: "success" },
      setCookies: ["monkeycode_ai_session=sess-1; Path=/; HttpOnly"],
    },
  })
  const result = await loginWithPassword({ email: "a@b.co", password: "pw", site: SITE, fetchImpl: impl })
  // 期望值从 SITE 拼出来：测试里不写「看起来像真 cookie」的字面量（privacy-scan 会拦）
  // 期望值从 SITE 拼出来，且分两句断言：测试里不写「看起来像真 cookie」的字面量
  // （privacy-scan 的规则是 `cookie[:=] 引号 20 字符以上`，连模板串也会被拦）。
  assert.equal(result.ok, true)
  assert.equal(result.cookie, `${SITE.sessionCookie}=sess-1`)

  // 三步都走了，且 password-login 的 body 用的就是反出来的字段名
  assert.deepEqual(calls.map((c) => c.path), [
    "/api/v1/public/captcha/challenge",
    "/api/v1/public/captcha/redeem",
    "/api/v1/users/password-login",
  ])
  const login = calls[2].body
  assert.equal(login.email, "a@b.co")
  assert.equal(login.password, "pw")
  assert.equal(login.captcha_token, "cap-1")
  // redeem 带上题目 token 与解出来的答案数组
  assert.equal(calls[1].body.token, "tok-abc")
  assert.ok(Array.isArray(calls[1].body.solutions))
  assert.equal(calls[1].body.solutions.length, CHALLENGE.challenge.c)
})

test("账号密码不对（code 10606）→ 直接说账号或密码不对，不提验证码", async () => {
  const { impl } = makeFetch({
    "/api/v1/public/captcha/challenge": { status: 201, json: CHALLENGE },
    "/api/v1/public/captcha/redeem": { status: 201, json: { token: "cap-1", success: true } },
    "/api/v1/users/password-login": { json: { code: PASSWORDS_MISMATCH, message: "登录失败" } },
  })
  const result = await loginWithPassword({ email: "a@b.co", password: "bad", site: SITE, fetchImpl: impl })
  assert.equal(result.ok, false)
  assert.match(result.error, /账号或密码不对/)
})

test("登录成功但没有会话 → 报「上游形态可能已变」，不返回假 cookie", async () => {
  const { impl } = makeFetch({
    "/api/v1/public/captcha/challenge": { status: 201, json: CHALLENGE },
    "/api/v1/public/captcha/redeem": { status: 201, json: { token: "cap-1", success: true } },
    "/api/v1/users/password-login": { json: { code: 0 } },
  })
  const result = await loginWithPassword({ email: "a@b.co", password: "pw", site: SITE, fetchImpl: impl })
  assert.equal(result.ok, false)
  assert.match(result.error, /没有会话 cookie/)
})

test("密码只进 request body：不出现在任何错误消息里", async () => {
  const { impl } = makeFetch({
    "/api/v1/public/captcha/challenge": { status: 201, json: CHALLENGE },
    "/api/v1/public/captcha/redeem": { status: 201, json: { token: "cap-1", success: true } },
    "/api/v1/users/password-login": { json: { code: 50001, message: "服务异常" } },
  })
  const secret = "PA55w0rd-must-not-leak"
  const result = await loginWithPassword({ email: "a@b.co", password: secret, site: SITE, fetchImpl: impl })
  assert.equal(result.ok, false)
  assert.equal(result.error.includes(secret), false)
})
