// tests/baizhi-invite-code.test.mjs —— 百智云自己的邀请码：`GET /api/v1/user/invite-code`。
//
// 真机 bug（2026-11-09）：点「添加账号」→ 浏览器落在 https://baizhi.cloud/console/ 并弹红条
// `invite_code length must be 8`。根因是把账号 identity（`user.id`，15 位数字）当成了
// `invite_code` 拼进 `/sign-in`。实际邀请码是平台**单独下发**的 8 位字母数字码：
//
//   GET https://baizhi.cloud/api/v1/user/invite-code   （只读，cookie 认证）
//   → 200 {"code":0,"message":"success","data":{"invite_code":"AB12CD34"}}
//
// 本文件全部用注入的假 fetch：不联网、不读真实账号库、不读真实凭证（cookie 全是假的）。

import test from "node:test"
import assert from "node:assert/strict"

import { fetchInviteCode } from "../src/baizhi/credits.mjs"
import { BAIZHI } from "../src/baizhi/site.mjs"

// 假会话：两枚 cookie 都要（只带一枚会 401），值全是编的。
const COOKIE = ["sl-session=fake-sl", "baizhi_session=fake-session"].join("; ")
const ENDPOINT = "https://baizhi.cloud/api/v1/user/invite-code"

/** 假平台：记录每次请求，按 handler 回包。 */
function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  return { impl, calls }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
})

test("成功解析 data.invite_code（8 位字母数字）", async () => {
  const { impl, calls } = fakeFetch(() => json({ code: 0, message: "success", data: { invite_code: "AB12CD34" } }))
  const result = await fetchInviteCode(COOKIE, BAIZHI, { fetchImpl: impl })

  assert.deepEqual(result, { ok: true, code: "AB12CD34" })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, ENDPOINT, "端点必须是 /api/v1/user/invite-code")
  assert.equal(calls[0].init.method, "GET")
  // cookie 归一后原样带上去（两枚都要，只带一枚会 401 —— 见 credits.mjs 头注释）。
  assert.equal(calls[0].init.headers.cookie, COOKIE)
  // UA 必须是官方网页那条（缺了就是 `magpie/<version>` ⇒ 403 TM.00000001）。
  assert.match(calls[0].init.headers["user-agent"], /Mozilla\/5\.0/)
})

test("非 8 位 / 缺字段 / 空串都返回 ok:false（不带邀请，不报红条）", async () => {
  const payloads = [
    // identity（15 位 user.id）—— 真机那次红条的来源。
    { code: 0, data: { invite_code: "9007199254740993" } },
    { code: 0, data: { invite_code: "AB12CD3" } },
    { code: 0, data: { invite_code: "AB12CD34X" } },
    { code: 0, data: { invite_code: "" } },
    { code: 0, data: { invite_code: "AB12 CD3" } },
    { code: 0, data: { invite_code: 12345678 } },
    { code: 0, data: {} },
    { code: 0, data: { invite_code: null } },
  ]
  for (const payload of payloads) {
    const { impl } = fakeFetch(() => json(payload))
    const result = await fetchInviteCode(COOKIE, BAIZHI, { fetchImpl: impl })
    assert.equal(result.ok, false, `${JSON.stringify(payload)} 不该被当成邀请码`)
    assert.equal(typeof result.error, "string")
    assert.match(result.error, /8 位字母数字|形态可能已变/)
  }
})

test("上游业务码非 0 / 401 / 非 JSON 200 都返回 ok:false", async () => {
  const envelope = fakeFetch(() => json({ code: 40300, message: "forbidden", data: null }))
  const r1 = await fetchInviteCode(COOKIE, BAIZHI, { fetchImpl: envelope.impl })
  assert.equal(r1.ok, false)
  assert.match(r1.error, /平台接口拒绝/)

  const unauthorized = fakeFetch(() => json({ code: 401, message: "unauthenticated" }, 401))
  const r2 = await fetchInviteCode(COOKIE, BAIZHI, { fetchImpl: unauthorized.impl })
  assert.equal(r2.ok, false)
  assert.match(r2.error, /HTTP 401/)

  const html = fakeFetch(() => new Response("<html>login</html>", { status: 200 }))
  const r3 = await fetchInviteCode(COOKIE, BAIZHI, { fetchImpl: html.impl })
  assert.equal(r3.ok, false)
  assert.match(r3.error, /非 JSON/)
})

test("没有 cookie / 网络抛错都不抛异常，只回 ok:false", async () => {
  for (const cookie of ["", "   ", undefined, null]) {
    const { impl, calls } = fakeFetch(() => json({ code: 0, data: { invite_code: "AB12CD34" } }))
    const result = await fetchInviteCode(cookie, BAIZHI, { fetchImpl: impl })
    assert.deepEqual(result, { ok: false, error: "未配置会话（session_cookie）" })
    assert.equal(calls.length, 0, "没有会话就不该打上游")
  }

  const boom = fakeFetch(() => { throw new Error("ECONNRESET") })
  const failed = await fetchInviteCode(COOKIE, BAIZHI, { fetchImpl: boom.impl })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /ECONNRESET/)
})

test("裸 cookie 值按 sessionCookie 名字补齐（与其它平台接口同一套归一）", async () => {
  const { impl, calls } = fakeFetch(() => json({ code: 0, data: { invite_code: "AB12CD34" } }))
  await fetchInviteCode("bare-value", BAIZHI, { fetchImpl: impl })
  assert.equal(calls[0].init.headers.cookie, "baizhi_session=bare-value")
})
