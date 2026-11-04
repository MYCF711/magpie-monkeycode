// tests/ua.test.mjs —— 出站 UA：一个仓库一条常量，别处不许另写、也不许透传宿主的
//
// 2026-11-04 真机：上游网关按 `<产品名>/<版本>` 形态识别第三方客户端，命中就回
//   403 {"error_code":"TM.00000001","error_msg":"网络繁忙，请稍后重试"}
// magpie 给插件的固定 UA 是 `magpie/<version>`；插件不显式覆盖就原样透传 ⇒ 必中。
// 以前 src/api.mjs 还写着 `magpie-plugin/0.0.0` —— 同样是这个形态。
//
// 全部离线：fetch 全是桩，不碰网络。

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

import { UA } from "../src/platform-http.mjs"
import { headersFor } from "../src/api.mjs"
import { fetchRemoteModels } from "../src/baizhi/credits.mjs"

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\\/g, "/")

/** src/ 下所有 .mjs 的 { 相对路径: 源码 } */
function srcFiles(dir = join(ROOT, "src"), out = new Map()) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) srcFiles(full, out)
    else if (name.endsWith(".mjs")) out.set(full.slice(ROOT.length).replace(/\\/g, "/"), readFileSync(full, "utf8"))
  }
  return out
}

test("UA 是合法的完整 Chrome UA（不是被截断的 Mozilla 前缀）", () => {
  assert.match(UA, /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/)
})

test("src/ 里只有一个 UA 常量：别处不许再内联 Mozilla/…", () => {
  const files = srcFiles()
  const offenders = []
  for (const [file, text] of files) {
    if (file === "src/platform-http.mjs") continue
    for (const line of text.split("\n")) {
      // 注释里提到旧 UA 允许（而且正要留住那段教训），只拦真会发出去的字符串字面量
      if (/"Mozilla\/5\.0[^"]*"/.test(line)) offenders.push(`${file}: ${line.trim()}`)
    }
  }
  assert.deepEqual(offenders, [], `这些地方又内联了一条 UA：\n${offenders.join("\n")}`)
})

test("src/ 里不再出现 <我们自己的产品名>/<版本> 形态的 UA", () => {
  const files = srcFiles()
  const offenders = []
  const BANNED = /"user-agent"\s*:\s*["'`](magpie[^"'`]*|[^"'`]*magpie-plugin[^"'`]*)["'`]|headers\.set\(\s*["']user-agent["']\s*,\s*["'`]/
  for (const [file, text] of files) {
    text.split("\n").forEach((line, i) => {
      if (BANNED.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], `出站 UA 必须引用 UA 常量，不许写字面量：\n${offenders.join("\n")}`)
})

test("headersFor()（上游 API 层）带的是这条 UA", () => {
  const h = headersFor({ token: "t" })
  assert.equal(h["user-agent"], UA)
  assert.equal(h.authorization, "Bearer t")
})

test("百智云远端模型目录带这条 UA", async () => {
  let sent
  globalThis.fetch = async (url, init) => {
    sent = { url: String(url), headers: init?.headers }
    return new Response(JSON.stringify({ data: [{ id: "m1", display_name: "M1" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  try {
    await fetchRemoteModels("sk-test", { modelsUrl: "https://ai-models.app.baizhi.cloud/api/anthropic/v1/models" })
  } finally {
    delete globalThis.fetch
  }
  assert.equal(sent.headers["user-agent"], UA)
})

test("loader.fetch 覆盖宿主的 UA（magpie/<version> 不许透传）", async () => {
  const dir = join(ROOT, "tests", ".ua-tmp")
  process.env.MAGPIE_MONKEYCODE_CACHE_DIR = dir
  const { MonkeyCodeIntlAuthPlugin, BaizhiAuthPlugin } = await import("../index.mjs")
  const AUTH = {
    type: "api",
    key: JSON.stringify({ access_token: "oma_testtesttesttest", signing_secret: "secret-secret-secret" }),
  }
  const BAIZHI_AUTH = { type: "api", key: JSON.stringify({ access_token: "sk-testtesttest" }) }

  for (const [label, factory, auth] of [
    ["monkeycodeintl", MonkeyCodeIntlAuthPlugin, AUTH],
    ["baizhi", BaizhiAuthPlugin, BAIZHI_AUTH],
  ]) {
    const plugin = await factory({}, {})
    const loader = await plugin.auth.loader(async () => auth)
    if (typeof loader?.fetch !== "function") assert.fail(`${label}: 有效凭据下 loader 必须接管`) // 不许静默跳过
    let sent
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      sent = { url: String(url), headers: new Headers(init?.headers) }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    }
    try {
      await loader.fetch(`${loader.baseURL || "https://gateway.example"}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // 宿主真实会发的那条 —— 必须被丢掉
          "user-agent": "magpie/0.1.2901",
        },
        body: JSON.stringify({ model: "m", messages: [] }),
      })
    } finally {
      globalThis.fetch = realFetch
    }
    assert.equal(sent.headers.get("user-agent"), UA, `${label}: 宿主的 UA 透传出去了`)
  }
})
