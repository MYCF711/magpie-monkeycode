// 单测不许读开发机上的真实账号缓存（可能是「探测后全不可用 ⇒ 空表」）。
process.env.MAGPIE_MONKEYCODE_CACHE_DIR = "C:\__magpie_test_cache__"
// tests/monkeycode.test.mjs —— 协议语义锁（形状对、语义错的那几处）
//
// 覆盖：网关签名、prompt 提取优先级、凭据解析、cookie 归一、PoW 验证题、
// 错误分类、额度窗口映射、loader 的请求改写（签名必须基于最终 body）。
//
// 全部离线：需要网络的地方一律注入 fetchImpl。

import test from "node:test"
import assert from "node:assert/strict"
import { createHash, createHmac } from "node:crypto"

import { SITES } from "../src/sites.mjs"
import {
  classifyFailure, gatewayHeaders, gatewaySignature, parseCredential, signingPrompt,
} from "../src/monkeycode/signing.mjs"
import {
  normalizeCookie, prng, solveChallenge, unwrapEnvelope,
} from "../src/monkeycode/credits.mjs"
import { makePlugin } from "../src/monkeycode/runtime.mjs"

const site = SITES.monkeycode
const credential = { access_token: "oma_abcdefghijklmnopqrstuvwxyz0123", signing_secret: "s".repeat(48) }

// ── 签名 ─────────────────────────────────────────────────────────────

test("签名：v1=<hex HMAC-SHA256(secret, prompt)>", () => {
  const expected = `v1=${createHmac("sha256", "secret").update("hello", "utf8").digest("hex")}`
  assert.equal(gatewaySignature("secret", "hello"), expected)
  // 空 prompt 也照常签名（空串的 HMAC 是合法值）。
  assert.match(gatewaySignature("secret", ""), /^v1=[0-9a-f]{64}$/)
})

test("prompt 提取顺序：system → instructions → messages.system → input.developer", () => {
  assert.equal(signingPrompt({ system: "S", instructions: ["I"] }), "S")
  assert.equal(signingPrompt({ system: [{ type: "text", text: "S1" }, { text: "S2" }] }), "S1")
  assert.equal(signingPrompt({ instructions: ["A", { type: "text", text: "B" }] }), "A\nB")
  assert.equal(signingPrompt({ messages: [{ role: "system", content: "M" }, { role: "user", content: "U" }] }), "M")
  assert.equal(signingPrompt({ input: [{ role: "developer", content: [{ type: "input_text", text: "D" }] }] }), "D")
  // 全落空 → 空串（签名仍算）。
  assert.equal(signingPrompt({ messages: [{ role: "user", content: "U" }] }), "")
})

test("请求头：x-api-key + anthropic-version + 基于 body 的签名", () => {
  const body = JSON.stringify({ system: "prompt text", messages: [], max_tokens: 8 })
  const headers = gatewayHeaders(credential, { body })
  assert.equal(headers["x-api-key"], credential.access_token)
  assert.equal(headers["anthropic-version"], "2023-06-01")
  assert.equal(headers["X-OhMyAgent-Signature"], gatewaySignature(credential.signing_secret, "prompt text"))
  // body 变了，签名必须跟着变（缓存签名是这套协议最贵的错）。
  const other = gatewayHeaders(credential, { body: JSON.stringify({ system: "另一段", messages: [] }) })
  assert.notEqual(headers["X-OhMyAgent-Signature"], other["X-OhMyAgent-Signature"])
})

test("缺 signing_secret 时不发签名头（由调用方给可读错误，而不是抛）", () => {
  const headers = gatewayHeaders({ access_token: "oma_x" }, { body: "{}" })
  assert.equal(headers["X-OhMyAgent-Signature"], undefined)
})

// ── 凭据 ─────────────────────────────────────────────────────────────

test("凭据解析：JSON / key:secret / 裸 token 三种输入", () => {
  const key = "oma_abcdefghijklmnopqrstuvwxyz012345"
  const secret = "0123456789abcdef0123456789abcdef0123456789abcdef"
  assert.deepEqual(
    parseCredential(JSON.stringify({ access_token: key, signing_secret: secret })),
    { access_token: key, signing_secret: secret },
  )
  assert.deepEqual(parseCredential(`${key}:${secret}`), { access_token: key, signing_secret: secret })
  assert.deepEqual(parseCredential(`${key} ${secret}`), { access_token: key, signing_secret: secret })
  assert.deepEqual(parseCredential(key), { access_token: key })
  assert.equal(parseCredential(""), undefined)
  assert.equal(parseCredential("{}"), undefined)
  assert.equal(parseCredential("不是 JSON"), undefined)
})

test("凭据解析不校验前缀（上游将来可能换前缀）", () => {
  const key = "anyproviderkey-0123456789abcdef0123"
  const secret = "0123456789abcdef0123456789abcdef0123456789abcdef"
  assert.deepEqual(parseCredential(`${key}:${secret}`), { access_token: key, signing_secret: secret })
})

// ── cookie ───────────────────────────────────────────────────────────

test("cookie 归一：完整串原样、裸值补名、剥掉 cookie: 前缀", () => {
  assert.equal(normalizeCookie("a=1; b=2", site.sessionCookie), "a=1; b=2")
  assert.equal(normalizeCookie("abc123", site.sessionCookie), `${site.sessionCookie}=abc123`)
  assert.equal(normalizeCookie("Cookie: abc123", site.sessionCookie), `${site.sessionCookie}=abc123`)
  assert.equal(normalizeCookie("   ", site.sessionCookie), undefined)
})

// ── PoW ──────────────────────────────────────────────────────────────

test("prng 与前端 xorshift32 变体逐位一致（回归向量）", () => {
  assert.equal(prng("abc", 8), "0bb9adb8")
  assert.equal(prng("token123d", 3), "dbe")
})

test("solveChallenge 的解能被 sha256 前缀验证", () => {
  const token = "tok"
  const challenge = { count: 2, saltLength: 32, targetLength: 2 }
  const solutions = solveChallenge(token, challenge)
  assert.equal(solutions.length, 2)
  for (let index = 0; index < solutions.length; index += 1) {
    const ordinal = index + 1
    const target = prng(`${token}${ordinal}d`, challenge.targetLength)
    const salt = prng(`${token}${ordinal}`, challenge.saltLength)
    const digest = createHash("sha256").update(salt + String(solutions[index])).digest("hex")
    assert.ok(digest.startsWith(target), `第 ${ordinal} 题`)
  }
})

// ── 信封 ─────────────────────────────────────────────────────────────

test("信封解包：code 非 0 是业务失败，缺 code 的原样放行", () => {
  assert.deepEqual(unwrapEnvelope({ code: 0, data: { balance: 1 } }).value, { balance: 1 })
  assert.equal(unwrapEnvelope({ code: 7, message: "没权限" }).ok, false)
  // 有的端点直接回裸对象（没有 code 字段），不能判失败。
  assert.deepEqual(unwrapEnvelope({ balance: 2 }).value, { balance: 2 })
  assert.equal(unwrapEnvelope("x").ok, false)
})

// ── 错误分类 ─────────────────────────────────────────────────────────

test("失败分类：402/429/401-403 按状态码，5xx 在文案之后", () => {
  assert.equal(classifyFailure("", 402), "quota")
  assert.equal(classifyFailure("", 429), "rate")
  assert.equal(classifyFailure('{"error":"invalid ohmyagent request"}', 403), "auth")
  // 状态码被改写成 500 但正文仍是额度文案 → 认文案。
  assert.equal(classifyFailure("积分已耗尽，调用失败", 500), "quota")
  assert.equal(classifyFailure("upstream boom", 502), "server")
  assert.equal(classifyFailure("bad request", 400), "other")
})

// ── 额度映射 ─────────────────────────────────────────────────────────

test("额度：钱包型只给余额，数量型给 amount/limit，未配 cookie 给可读错误", async () => {
  const plugin = await makePlugin(site)({ client: {} })
  const auth = { type: "api", key: JSON.stringify({ ...credential, session_cookie: "sess", user_id: "u1" }) }

  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const text = String(url)
    if (text.endsWith("/api/v1/users/wallet")) {
      return Response.json({ code: 0, data: { balance: 12500, daily_token_balance: 9_000_000, daily_token_limit: 10_000_000 } })
    }
    if (text.endsWith("/api/v1/users/subscription")) {
      return Response.json({ code: 0, data: { plan: "basic" } })
    }
    throw new Error(`unexpected ${text}`)
  }
  try {
    const usage = await plugin.auth.usage(async () => auth)
    assert.equal(usage.plan, "MonkeyCode Basic")
    const daily = usage.windows.find((w) => w.name === "每日额度")
    assert.equal(daily.used, 10) // (10M - 9M) / 10M
    const credit = usage.windows.find((w) => w.name === "积分余额")
    assert.ok(credit, "钱包型窗口必须在")
  } finally {
    globalThis.fetch = original
  }

  const noCookie = await plugin.auth.usage(async () => ({ type: "api", key: JSON.stringify(credential) }))
  assert.match(noCookie.error, /session_cookie|网页会话/)
  assert.equal(noCookie.windows.length, 0)
})

test("额度：平台取消基础用户日额度（daily_token_limit = 0）不抛错，退化成文本窗口", async () => {
  const plugin = await makePlugin(site)({ client: {} })
  const auth = { type: "api", key: JSON.stringify({ ...credential, session_cookie: "sess", user_id: "u0" }) }

  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const text = String(url)
    if (text.endsWith("/api/v1/users/wallet")) {
      // 2026-11-11 起基础用户不再有每日赠送额度：两个字段都下发 0（实测形态）。
      return Response.json({ code: 0, data: { balance: 37949, daily_token_balance: 0, daily_token_limit: 0 } })
    }
    if (text.endsWith("/api/v1/users/subscription")) {
      return Response.json({ code: 0, data: { plan: "basic" } })
    }
    throw new Error(`unexpected ${text}`)
  }
  try {
    const usage = await plugin.auth.usage(async () => auth)
    // 判据：limit=0 不能把整张卡片变成错误态（原先抛 QuotaShapeError，连积分那条也一起没了）。
    assert.equal(usage.error, undefined)
    assert.equal(usage.plan, "MonkeyCode Basic")

    const daily = usage.windows.find((w) => w.name === "每日额度")
    assert.ok(daily, "额度那条要在 —— 悄悄抹掉用户会以为插件坏了")
    assert.equal(daily.textOnly, true, "limit=0 时不能建数量型窗口（usageWindow 硬要求 limit > 0）")
    assert.equal(daily.limit, undefined)
    assert.match(daily.display, /基础用户/)

    const credit = usage.windows.find((w) => w.name === "积分余额")
    assert.equal(credit.balance, 37.949, "积分余额照常给（钱包单位是千分之一积分）")

    // 至少一条可路由窗口：钱包型的积分窗口参与路由，这个号不能在智能路由里消失。
    assert.ok(
      usage.windows.some((w) => w.aside !== true && (w.used !== undefined || w.balance !== undefined)),
      "必须留一条可路由窗口",
    )
  } finally {
    globalThis.fetch = original
  }
})

// ── loader ───────────────────────────────────────────────────────────

test("loader：签名基于最终 body，且不把 SDK 的 x-api-key 带出去", async () => {
  const plugin = await makePlugin(site)({ client: {} })
  const auth = { type: "api", key: JSON.stringify(credential) }
  const loader = await plugin.auth.loader(async () => auth)
  assert.equal(loader.baseURL, "https://proxy.monkeycode-ai.com/v1")

  const body = JSON.stringify({ model: "deepseek-flash", system: "系统提示", messages: [], max_tokens: 16, stream: true })
  const seen = {}
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.url = String(url)
    seen.headers = Object.fromEntries(new Headers(init.headers).entries())
    seen.body = init.body
    return new Response("{}", { status: 200 })
  }
  try {
    await loader.fetch(`${site.gatewayBaseUrl}/messages`, {
      method: "POST",
      headers: { "x-api-key": "sdk-placeholder", "content-type": "application/json" },
      body,
    })
  } finally {
    globalThis.fetch = original
  }
  assert.equal(seen.url, "https://proxy.monkeycode-ai.com/v1/messages")
  assert.equal(seen.headers["x-api-key"], credential.access_token)
  assert.equal(seen.headers["x-ohmyagent-signature"], gatewaySignature(credential.signing_secret, "系统提示"))
  assert.equal(seen.headers["content-length"], undefined, "重写 body 后不能带旧 content-length")
  assert.equal(seen.body, body)
})
