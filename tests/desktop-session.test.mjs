// tests/desktop-session.test.mjs —— 「从本机桌面客户端读登录态」的语义锁。
//
// 这条路的前提是「桌面版把 cookie 明文落盘」，所以每条断言都必须能离线跑：
// 目录用临时目录伪造，**绝不读开发机上真实的 AppData**（那里是别人的真实凭据）。

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  cookiesFromJar,
  desktopDataDirs,
  DESKTOP_APP_DIR,
  readDesktopBaizhiSession,
  readDesktopCookie,
  readDesktopMonkeyCodeSession,
} from "../src/monkeycode/desktop-session.mjs"

const NOW = Date.parse("2026-11-04T12:00:00Z")

/** 造一个临时「AppData 根」，里面放一份指定内容的客户端数据目录。 */
function sandbox(files) {
  const root = mkdtempSync(join(tmpdir(), "magpie-desktop-"))
  const appDir = join(root, DESKTOP_APP_DIR)
  mkdirSync(appDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(appDir, name), typeof content === "string" ? content : JSON.stringify(content), "utf8")
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test("目录：APPDATA / LOCALAPPDATA 各拼一份客户端目录，且去重", () => {
  const dirs = desktopDataDirs({ env: { APPDATA: "C:\\Roaming", LOCALAPPDATA: "C:\\Local" }, home: "C:\\Users\\x" })
  assert.equal(dirs[0], join("C:\\Roaming", DESKTOP_APP_DIR))
  assert.equal(dirs[1], join("C:\\Local", DESKTOP_APP_DIR))
  // 缺 APPDATA 时不产出垃圾串（"undefined/com.chaitin…"）
  const onlyHome = desktopDataDirs({ env: {}, home: "C:\\Users\\x" })
  assert.ok(onlyHome.every((d) => !d.includes("undefined")))
  // 同一个 base 传两次不会出现重复项
  const dup = desktopDataDirs({ env: { APPDATA: "C:\\Roaming" }, home: "C:\\Roaming" })
  assert.equal(new Set(dup).size, dup.length)
})

test("解析：只取点名的 cookie，未过期的才要", () => {
  const jar = [
    { name: "monkeycode_ai_session", value: "good" },
    { name: "other", value: "nope" },
  ]
  assert.equal(cookiesFromJar(JSON.stringify(jar), { names: ["monkeycode_ai_session"] }), "monkeycode_ai_session=good")
  // 没点名 = 全要
  assert.equal(cookiesFromJar(JSON.stringify(jar), {}), "monkeycode_ai_session=good; other=nope")
})

test("解析：过期的扔掉；全过期等于没登录", () => {
  const expired = [{ name: "monkeycode_ai_session", value: "old", expires: "2026-11-01T00:00:00Z" }]
  assert.equal(cookiesFromJar(JSON.stringify(expired), { names: ["monkeycode_ai_session"], now: NOW }), undefined)
  const alive = [{ name: "monkeycode_ai_session", value: "new", expires: "2026-11-10T00:00:00Z" }]
  assert.equal(cookiesFromJar(JSON.stringify(alive), { names: ["monkeycode_ai_session"], now: NOW }), "monkeycode_ai_session=new")
})

test("解析：秒级与毫秒级时间戳都按正确量级读", () => {
  const seconds = Math.floor(NOW / 1000) + 3600
  const millis = NOW + 3_600_000
  const jar = [
    { name: "a", value: "1", expires: seconds },
    { name: "b", value: "2", expires: millis },
    { name: "c", value: "3", expires: Math.floor(NOW / 1000) - 60 },
  ]
  assert.equal(cookiesFromJar(JSON.stringify(jar), { names: ["a", "b"], now: NOW }), "a=1; b=2")
  assert.equal(cookiesFromJar(JSON.stringify(jar), { names: ["c"], now: NOW }), undefined)
})

test("解析：同名的多域 cookie 取最后一条（客户端会同时存多个子域）", () => {
  const jar = [
    { name: "sl-session", value: "baizhi", domain: "baizhi.cloud" },
    { name: "sl-session", value: "ai-models", domain: "ai-models.app.baizhi.cloud" },
    { name: "baizhi_session", value: "sess", domain: "baizhi.cloud" },
  ]
  assert.equal(
    cookiesFromJar(JSON.stringify(jar), { names: ["sl-session", "baizhi_session"], now: NOW }),
    "sl-session=ai-models; baizhi_session=sess",
  )
})

test("解析：坏文件 / 空值 / 非数组一律 undefined，不抛错", () => {
  for (const bad of ["", "not json", "{}", "[]", "[{}]", JSON.stringify([{ name: "x", value: "" }])]) {
    assert.equal(cookiesFromJar(bad, { names: ["x"], now: NOW }), undefined)
  }
  // 也认 `{ cookies: [...] }` 这种包一层的形状
  assert.equal(
    cookiesFromJar(JSON.stringify({ cookies: [{ name: "x", value: "1" }] }), { names: ["x"], now: NOW }),
    "x=1",
  )
})

test("读文件：命中返回 cookie 与来源文件；没有文件返回 undefined", () => {
  const box = sandbox({ "monkeycode-cookies.json": [{ name: "monkeycode_ai_session", value: "abc", expires: "2026-11-10T00:00:00Z" }] })
  try {
    const hit = readDesktopMonkeyCodeSession({ env: { APPDATA: box.root }, now: NOW })
    assert.ok(hit !== undefined)
    assert.equal(hit.cookie, "monkeycode_ai_session=abc")
    assert.ok(hit.file.endsWith("monkeycode-cookies.json"))
    // 换了根目录就没有了 —— 证明它真的按 env 走，没有硬编码本机路径
    assert.equal(readDesktopMonkeyCodeSession({ env: { APPDATA: join(box.root, "nope") }, now: NOW }), undefined)
  } finally {
    box.cleanup()
  }
})

test("读文件：所需的 cookie 没到齐就不算命中（匿名会话陷阱）", () => {
  // 只有 sl-session、缺 baizhi_session → 百智云会话不算登录
  const box = sandbox({ "baizhi-cookies.json": [{ name: "sl-session", value: "only-device" }] })
  try {
    assert.equal(readDesktopBaizhiSession({ env: { APPDATA: box.root }, now: NOW }), undefined)
  } finally {
    box.cleanup()
  }
  const ready = sandbox({
    "baizhi-cookies.json": [
      { name: "sl-session", value: "dev" },
      { name: "baizhi_session", value: "sess" },
    ],
  })
  try {
    const hit = readDesktopBaizhiSession({ env: { APPDATA: ready.root }, now: NOW })
    assert.ok(hit !== undefined)
    assert.equal(hit.cookie, "sl-session=dev; baizhi_session=sess")
  } finally {
    ready.cleanup()
  }
})

test("读文件：LOCALAPPDATA 里有也算（内嵌 WebView 偶尔只落那儿）", () => {
  const box = sandbox({ "monkeycode-cookies.json": [{ name: "monkeycode_ai_session", value: "from-local" }] })
  try {
    const hit = readDesktopCookie({
      cookieFile: "monkeycode-cookies.json",
      cookieNames: ["monkeycode_ai_session"],
      env: { LOCALAPPDATA: box.root },
      now: NOW,
    })
    assert.equal(hit.cookie, "monkeycode_ai_session=from-local")
  } finally {
    box.cleanup()
  }
})
