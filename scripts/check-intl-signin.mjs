#!/usr/bin/env node
// AGENTS 0.7 的判据，做成一条命令。
//
// 「国际版网页登录必须能成功，且列出模型」由两条独立的事实组成，缺一不可：
//
//   ① 登录**存下来了**：`~/.config/magpie/plugin-auth.json` 里有 `monkeycodeintl`
//      的记录，且带 uid（magpie 按 uid 建 account；没有 account 的 provider
//      就是那句「已登录，但 magpie 无法列出它」）
//   ② magpie 真的把它摆上了货架：本机网关 `GET /v1/models` 里有 `monkeycodeintl/…`
//
// 只读，不发写请求，不改任何配置。可选地拿一份 cookie 去验国际站的会话
// （`--cookie 'monkeycode_ai_session=…'`），这是判据里那条 curl 的等价物。
//
// 用法：
//   node scripts/check-intl-signin.mjs
//   node scripts/check-intl-signin.mjs --cookie 'monkeycode_ai_session=…'
//   node scripts/check-intl-signin.mjs --gateway http://127.0.0.1:3425
//
// 退出码：0 = 两条判据都成立；2 = 有判据不成立（打印是哪一条）。

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const PROVIDER = "monkeycodeintl"
const PLATFORM = "https://monkeycode-ai.net"

function argsOf(argv) {
  const out = { cookie: undefined, gateway: "http://127.0.0.1:3425" }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--cookie") out.cookie = argv[(i += 1)]
    else if (argv[i] === "--gateway") out.gateway = argv[(i += 1)] ?? out.gateway
  }
  return out
}

/** magpie 的账号库（只读）。缺文件 / 坏 JSON 都当「没有」。 */
function readAuth() {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".config", "magpie", "plugin-auth.json"), "utf8"))
  } catch {
    return {}
  }
}

/** 一个 provider 的所有账号 key（第一个存 provider id，其余 `id#<slot>`）。 */
function keysOf(auth, provider) {
  return Object.keys(auth ?? {}).filter((key) => key === provider || key.startsWith(`${provider}#`))
}

const args = argsOf(process.argv.slice(2))
const auth = readAuth()
const keys = keysOf(auth, PROVIDER)
const record = keys.length > 0 ? auth[keys[0]] : undefined
const uid = typeof record?.uid === "string" ? record.uid : ""
const accountId = typeof record?.accountId === "string" ? record.accountId : ""

console.log(`判据 ① 登录有没有落盘 · ${PROVIDER}`)
if (keys.length === 0) {
  console.log("  ✗ plugin-auth.json 里没有这个 provider 的记录")
  console.log("    ⇒ 网页登录没存下来（或者根本没登）。这正是「已登录但 magpie 无法列出它」的形态。")
} else {
  console.log(`  ✓ 记录在：type=${record?.type ?? "?"} accountId=${accountId || "(空)"} uid=${uid || "(空)"}`)
  if (record?.type !== "oauth") {
    console.log(`  ! 这条是 ${record?.type} 方式存的；网页登录应当存成 oauth（带 refresh）。`)
  }
  if (uid.length === 0) {
    console.log("  ✗ uid 是空的：magpie 按 uid 建 account，空 uid 的账号可能不被列出")
  }
}

// ② 网关里有没有它的模型。magpie 的 id 是 `<provider>/<model>`。
let listed = []
try {
  const response = await fetch(`${args.gateway}/v1/models`, { signal: AbortSignal.timeout(10_000) })
  const payload = await response.json()
  listed = (payload?.data ?? [])
    .map((model) => String(model?.id ?? ""))
    .filter((id) => id.startsWith(`${PROVIDER}/`))
} catch (error) {
  console.log(`判据 ② 网关列没列出模型 · 连不上 ${args.gateway}（${error?.message ?? error}）`)
  process.exitCode = 2
}

if (process.exitCode !== 2) {
  console.log(`判据 ② magpie 会不会列出它 · ${PROVIDER}`)
  if (listed.length === 0) {
    console.log(`  ✗ ${args.gateway}/v1/models 里没有 ${PROVIDER}/… 的模型`)
  } else {
    console.log(`  ✓ 列出 ${listed.length} 个，例如 ${listed.slice(0, 3).join("、")}`)
  }
}

// 可选：拿一份会话 cookie 验平台侧认证（判据里那条 curl 的等价物）。
if (args.cookie !== undefined) {
  console.log("附加 国际站的会话 cookie 能不能过认证")
  const cookie = String(args.cookie).trim().replace(/^cookie\s*:\s*/i, "")
  try {
    const response = await fetch(`${PLATFORM}/api/v1/users/status`, {
      headers: { cookie, accept: "application/json", referer: `${PLATFORM}/` },
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    if (response.ok) {
      let name = ""
      try {
        const parsed = JSON.parse(text)
        name = parsed?.data?.user?.name ?? parsed?.data?.user?.nickname ?? ""
      } catch {}
      console.log(`  ✓ HTTP ${response.status}${name ? ` · ${name}` : ""}`)
    } else {
      console.log(`  ✗ HTTP ${response.status} · ${text.slice(0, 120)}`)
      process.exitCode = 2
    }
  } catch (error) {
    console.log(`  ✗ 请求失败：${error?.message ?? error}`)
    process.exitCode = 2
  }
}

if (keys.length === 0 || listed.length === 0) process.exitCode = 2
