// tests/baizhi-daily-claim-browser.test.mjs —— 无头浏览器领取每日积分的语义锁。
//
// 全部离线：CDP 用假 send，浏览器用假 handle，钱包用假 readWallet。
// 锁的是四件会静默出错的事：
//   ① 成功路径必须关浏览器 + 删一次性 profile（finally）；
//   ② 抛错路径同样清理（不许留进程 / 目录）；
//   ③ 只发 CDP 真实输入（Input.*），绝不 dispatchEvent 造假事件；
//   ④ 页面没有按钮 / 超时给 failed，而不是抛给宿主。

import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BAIZHI } from "../src/baizhi/site.mjs"
import {
  CAPTCHA_MESSAGE,
  CLAIM_COOKIE_DOMAIN,
  DAILY_CLAIM_CONSOLE_URL,
  NO_BUTTON_MESSAGE,
  claimDailyCreditInBrowser,
  cookiePairs,
} from "../src/baizhi/daily-claim-browser.mjs"

/** 假浏览器句柄：记录 close / ws.close 是否被调用。 */
function fakeHandle(profileDir) {
  const state = { closed: false, wsClosed: false }
  return {
    ws: { close() { state.wsClosed = true } },
    profileDir,
    persistent: false,
    running: () => false,
    close() { state.closed = true },
    state,
  }
}

/** 假 CDP：按方法名回答，顺便把调用序列记下来。 */
function fakeCdp({ pick, captcha, failOn } = {}) {
  const calls = []
  const send = async (ws, id, method, params = {}) => {
    calls.push({ id, method, params })
    if (failOn === method) throw new Error(`${method} boom`)
    if (method === "Runtime.evaluate") {
      const expression = String(params.expression ?? "")
      if (expression.includes("document.readyState")) return { result: { value: "complete" } }
      if (expression.includes("location.href")) return { result: { value: "https://baizhi.cloud/console" } }
      if (expression.includes("button,[role=button]")) {
        return { result: { value: pick ?? { found: false, candidates: [] } } }
      }
      if (expression.includes("data:image")) {
        return { result: { value: captcha ?? { body: "", dialogs: [], bigImages: 0 } } }
      }
      return { result: { value: null } }
    }
    if (method === "Network.setCookie") return { success: true }
    if (method === "Page.navigate") return { frameId: "frame-1" }
    return {}
  }
  return { send, calls }
}

/** 假钱包：按顺序回读数，最后一次循环复用。 */
function fakeWallet(readings) {
  let index = 0
  return async () => {
    const reading = readings[Math.min(index, readings.length - 1)]
    index += 1
    return reading
  }
}

const foundButton = {
  found: true,
  tag: "button",
  role: "",
  text: "领取每日积分",
  rect: { x: 600, y: 400, width: 120, height: 40 },
  candidates: [{ tag: "button", text: "领取每日积分", clickable: true, disabled: false }],
}

function credential() {
  return { access_token: "sk-test", session_cookie: "baizhi_session=abc; sl-session=def" }
}

/** 自动前进的时钟：让「超时」类分支在测试里立刻走完，而不是真等 20 秒。 */
function tickingClock(step = 5) {
  let value = 0
  return () => (value += step)
}

test("cookiePairs：拆 name=value，跳过空值 / 畸形段", () => {
  assert.deepEqual(cookiePairs("a=1; b=2"), [{ name: "a", value: "1" }, { name: "b", value: "2" }])
  assert.deepEqual(cookiePairs("a=; ; noequals; c=x=y"), [{ name: "c", value: "x=y" }])
  assert.deepEqual(cookiePairs(undefined), [])
})

test("成功路径：无头启动 → 注入 cookie → 真实鼠标点击 → 钱包确认 → finally 关窗 + 删 profile", async () => {
  const profileDir = mkdtempSync(join(tmpdir(), "magpie-claim-test-"))
  writeFileSync(join(profileDir, "marker"), "1")
  const handle = fakeHandle(profileDir)
  const opened = []
  const cdp = fakeCdp({ pick: foundButton })
  const readWallet = fakeWallet([
    { ok: true, wallet: { temporary: 0, dailyClaimed: false } },
    { ok: true, wallet: { temporary: 100, dailyClaimed: true } },
  ])

  const result = await claimDailyCreditInBrowser({
    credential: credential(),
    site: BAIZHI,
    browser: { name: "Edge", path: "C:\\Edge\\msedge.exe" },
    openBrowser: async (options) => {
      opened.push(options)
      return handle
    },
    send: cdp.send,
    readWallet,
    sleep: async () => {},
    now: tickingClock(),
  })

  assert.deepEqual({ kind: result.kind, credit: result.credit }, { kind: "claimed", credit: 100 })

  // ① 无头 + 一次性 profile（不传 profileDir）
  assert.equal(opened.length, 1)
  assert.equal(opened[0].headless, true, "必须无头（--headless=new），用户桌面上不许出现窗口")
  assert.equal(opened[0].profileDir, undefined, "不许用持久 profile")
  assert.equal(opened[0].browser.path, "C:\\Edge\\msedge.exe")

  // ② cookie 逐个注入到 .baizhi.cloud
  const cookieCalls = cdp.calls.filter((call) => call.method === "Network.setCookie")
  assert.deepEqual(
    cookieCalls.map((call) => [call.params.name, call.params.value, call.params.domain]),
    [
      ["baizhi_session", "abc", CLAIM_COOKIE_DOMAIN],
      ["sl-session", "def", CLAIM_COOKIE_DOMAIN],
    ],
  )
  assert.ok(
    cdp.calls.some((call) => call.method === "Page.navigate" && call.params.url === DAILY_CLAIM_CONSOLE_URL),
  )

  // ③ 只发真实鼠标输入：moved ×3 → pressed → released → moved
  const inputCalls = cdp.calls.filter((call) => call.method === "Input.dispatchMouseEvent")
  assert.deepEqual(
    inputCalls.map((call) => call.params.type),
    ["mouseMoved", "mouseMoved", "mouseMoved", "mousePressed", "mouseReleased", "mouseMoved"],
  )
  const pressed = inputCalls.find((call) => call.params.type === "mousePressed").params
  assert.equal(pressed.button, "left")
  assert.equal(pressed.clickCount, 1)
  const released = inputCalls.find((call) => call.params.type === "mouseReleased").params
  assert.equal(released.button, "left")
  assert.equal(released.clickCount, 1)
  const rect = foundButton.rect
  assert.equal(pressed.x, Math.round(rect.x + rect.width / 2), "点击落在按钮中心")
  assert.equal(pressed.y, Math.round(rect.y + rect.height / 2), "点击落在按钮中心")

  // ④ 绝不通过 Runtime.evaluate 造 isTrusted=false 的假事件
  const evaluateScripts = cdp.calls
    .filter((call) => call.method === "Runtime.evaluate")
    .map((call) => String(call.params.expression))
  assert.ok(evaluateScripts.length > 0)
  assert.ok(evaluateScripts.every((script) => !/dispatchEvent|MouseEvent|PointerEvent|click\(\)/.test(script)))

  // ⑤ finally：关浏览器 + 删一次性 profile
  assert.equal(handle.state.closed, true, "必须关浏览器")
  assert.equal(handle.state.wsClosed, true, "CDP WebSocket 也要关")
  assert.equal(existsSync(profileDir), false, "一次性 user-data-dir 必须删掉")
  assert.ok(cdp.calls.some((call) => call.method === "Browser.close"), "先尝试优雅关闭")
})

test("抛错路径：CDP 中途炸了照样 failed + finally 清理干净", async () => {
  const profileDir = mkdtempSync(join(tmpdir(), "magpie-claim-throw-"))
  const handle = fakeHandle(profileDir)
  const cdp = fakeCdp({ pick: foundButton, failOn: "Page.navigate" })
  const readWallet = fakeWallet([{ ok: true, wallet: { temporary: 0, dailyClaimed: false } }])

  const result = await claimDailyCreditInBrowser({
    credential: credential(),
    site: BAIZHI,
    browser: { name: "Edge", path: "C:\\Edge\\msedge.exe" },
    openBrowser: async () => handle,
    send: cdp.send,
    readWallet,
    sleep: async () => {},
    now: tickingClock(),
  })

  assert.equal(result.kind, "failed", "异常必须收成 failed，不许抛给宿主")
  assert.match(result.message, /受控浏览器领取失败/)
  assert.equal(handle.state.closed, true)
  assert.equal(existsSync(profileDir), false)
})

test("找不到按钮：给 failed + 候选元素，不抛；profile 仍然删掉", async () => {
  const profileDir = mkdtempSync(join(tmpdir(), "magpie-claim-nobtn-"))
  const handle = fakeHandle(profileDir)
  const cdp = fakeCdp({
    pick: { found: false, candidates: [{ tag: "button", text: "登录", clickable: true, disabled: false }] },
  })
  const result = await claimDailyCreditInBrowser({
    credential: credential(),
    site: BAIZHI,
    browser: { name: "Edge", path: "C:\\Edge\\msedge.exe" },
    openBrowser: async () => handle,
    send: cdp.send,
    readWallet: fakeWallet([{ ok: true, wallet: { temporary: 0, dailyClaimed: false } }]),
    sleep: async () => {},
    now: tickingClock(),
  })

  assert.equal(result.kind, "failed")
  assert.equal(result.message, NO_BUTTON_MESSAGE)
  assert.deepEqual(result.candidates.map((item) => item.text), ["登录"], "把探测到的候选带回去便于排查")
  assert.equal(handle.state.closed, true)
  assert.equal(existsSync(profileDir), false)
})

test("点了但钱包始终不动：超时给 failed，不是抛错", async () => {
  const profileDir = mkdtempSync(join(tmpdir(), "magpie-claim-timeout-"))
  const handle = fakeHandle(profileDir)
  const cdp = fakeCdp({ pick: foundButton })
  const result = await claimDailyCreditInBrowser({
    credential: credential(),
    site: BAIZHI,
    browser: { name: "Edge", path: "C:\\Edge\\msedge.exe" },
    openBrowser: async () => handle,
    send: cdp.send,
    readWallet: fakeWallet([{ ok: true, wallet: { temporary: 0, dailyClaimed: false } }]),
    sleep: async () => {},
    now: tickingClock(),
    timeoutMs: 60_000,
  })

  assert.equal(result.kind, "failed")
  assert.match(result.message, /钱包没有变化/)
  assert.equal(existsSync(profileDir), false)
})

test("页面弹图片验证码：给 captcha 而不是 failed", async () => {
  const profileDir = mkdtempSync(join(tmpdir(), "magpie-claim-captcha-"))
  const handle = fakeHandle(profileDir)
  const cdp = fakeCdp({
    pick: foundButton,
    captcha: { body: "请完成验证", dialogs: ["验证后领取积分"], bigImages: 1 },
  })
  const result = await claimDailyCreditInBrowser({
    credential: credential(),
    site: BAIZHI,
    browser: { name: "Edge", path: "C:\\Edge\\msedge.exe" },
    openBrowser: async () => handle,
    send: cdp.send,
    readWallet: fakeWallet([{ ok: true, wallet: { temporary: 0, dailyClaimed: false } }]),
    sleep: async () => {},
    now: tickingClock(),
  })

  assert.deepEqual(result, { kind: "captcha", message: CAPTCHA_MESSAGE })
  assert.equal(existsSync(profileDir), false)
})

test("今日已领取 / 没有 cookie：根本不开浏览器", async () => {
  let opened = 0
  const already = await claimDailyCreditInBrowser({
    credential: credential(),
    site: BAIZHI,
    browser: { name: "Edge", path: "C:\\Edge\\msedge.exe" },
    openBrowser: async () => {
      opened += 1
      return fakeHandle("")
    },
    readWallet: fakeWallet([{ ok: true, wallet: { temporary: 100, dailyClaimed: true } }]),
    sleep: async () => {},
    now: tickingClock(),
  })
  assert.deepEqual(already, { kind: "already-claimed", message: "今日已领取" })

  const noCookie = await claimDailyCreditInBrowser({
    credential: { access_token: "sk-test" },
    site: BAIZHI,
    openBrowser: async () => {
      opened += 1
      return fakeHandle("")
    },
    readWallet: fakeWallet([{ ok: true, wallet: { temporary: 0, dailyClaimed: false } }]),
    sleep: async () => {},
    now: tickingClock(),
  })
  assert.equal(noCookie.kind, "failed")
  assert.match(noCookie.message, /session_cookie|网页登录态/)
  assert.equal(opened, 0, "这两种情况都不该启动浏览器")
})
