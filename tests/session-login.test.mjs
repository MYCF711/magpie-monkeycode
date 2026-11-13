// 浏览器会话登录的 CDP 生命周期回归；全部使用假 WebSocket，不启动真实浏览器。
process.env.MAGPIE_MONKEYCODE_CACHE_DIR = "C:\\__magpie_test_cache__"

import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { existsSync, rmSync } from "node:fs"

import {
  _internal,
  browserLogin,
  openControlledBrowser,
  readCookiesSilently,
  startBrowserLogin,
} from "../src/session-login.mjs"
import { _internal as chromiumInternal } from "../src/browser-login.mjs"

const { assertBrowserConnected, cdpSend, connectWebSocket, diagnosePageTargets, loginCookies } = _internal

class FakeWebSocket {
  constructor() {
    this.readyState = 1
    this.sent = []
    this.closeCalls = 0
    this.listeners = new Map()
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(listener)
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }

  send(raw) {
    this.sent.push(JSON.parse(raw))
  }

  close() {
    this.closeCalls += 1
    this.readyState = 3
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size ?? 0
  }
}

function assertListenersCleared(ws) {
  for (const type of ["open", "message", "close", "error"]) assert.equal(ws.listenerCount(type), 0, `${type} 监听器必须清理`)
}

test("公开登录入口与 CDP 内部接口保持连通", () => {
  for (const fn of [browserLogin, openControlledBrowser, readCookiesSilently, startBrowserLogin]) {
    assert.equal(typeof fn, "function")
  }
  assert.equal(typeof chromiumInternal.cdpSend, "function")
})

test("WebSocket 握手：open 返回原 socket，并清理定时器与监听器", async () => {
  for (const connect of [connectWebSocket, chromiumInternal.connectWebSocket]) {
    const ws = new FakeWebSocket()
    const pending = connect("ws://fake", { create: () => ws })
    ws.emit("open")
    assert.equal(await pending, ws)
    assert.equal(ws.closeCalls, 0)
    assertListenersCleared(ws)
  }
})

test("WebSocket 握手：close-only 会拒绝、关闭 socket 并清理监听器", async () => {
  for (const connect of [connectWebSocket, chromiumInternal.connectWebSocket]) {
    const ws = new FakeWebSocket()
    const pending = connect("ws://fake", { create: () => ws })
    const assertion = assert.rejects(pending, /握手期间关闭/)
    ws.emit("close")
    await assertion
    assert.equal(ws.closeCalls, 1)
    assertListenersCleared(ws)
  }
})

test("WebSocket 握手：无事件超时与构造器同步抛错都会 settle", async () => {
  for (const connect of [connectWebSocket, chromiumInternal.connectWebSocket]) {
    const ws = new FakeWebSocket()
    await assert.rejects(connect("ws://fake", { create: () => ws, timeoutMs: 5 }), /握手超时/)
    assert.equal(ws.closeCalls, 1)
    assertListenersCleared(ws)
    await assert.rejects(connect("ws://bad", {
      create: () => {
        throw new Error("bad websocket url")
      },
    }), /bad websocket url/)
  }
})

test("openControlledBrowser：握手 close-only 后 kill 子进程并删除临时 profile", async () => {
  const originalFetch = globalThis.fetch
  const originalWebSocket = globalThis.WebSocket
  const child = new EventEmitter()
  child.killed = false
  child.kill = () => {
    child.killed = true
  }
  let profile = ""
  class CloseOnlyWebSocket extends FakeWebSocket {
    constructor() {
      super()
      setImmediate(() => this.emit("close"))
    }
  }
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [{ id: "login", type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://fake" }],
    })
    globalThis.WebSocket = CloseOnlyWebSocket
    await assert.rejects(openControlledBrowser({
      browser: { name: "Fake", path: "fake-browser" },
      spawnImpl: (path, args) => {
        profile = args.find((arg) => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length)
        return child
      },
    }), /握手期间关闭/)
    assert.equal(child.killed, true)
    assert.ok(profile.includes("magpie-session-login-"))
    assert.equal(existsSync(profile), false, "临时 profile 必须在握手失败后删除")
  } finally {
    globalThis.fetch = originalFetch
    globalThis.WebSocket = originalWebSocket
    if (profile) rmSync(profile, { recursive: true, force: true })
  }
})

test("cdpSend：正常响应 settle，并清理 message/close/error 监听器", async () => {
  for (const send of [cdpSend, chromiumInternal.cdpSend]) {
    const ws = new FakeWebSocket()
    const pending = send(ws, 7, "Network.getAllCookies")
    ws.emit("message", { data: JSON.stringify({ id: 7, result: { cookies: [] } }) })
    assert.deepEqual(await pending, { cookies: [] })
    assert.deepEqual(ws.sent, [{ id: 7, method: "Network.getAllCookies", params: {} }])
    assertListenersCleared(ws)
  }
})

test("cdpSend：目标关闭或 WebSocket 错误会拒绝，不再永久等待", async () => {
  for (const send of [cdpSend, chromiumInternal.cdpSend]) {
    const closed = new FakeWebSocket()
    const onClosed = send(closed, 1, "Network.enable")
    const closedAssertion = assert.rejects(onClosed, /CDP WebSocket 已关闭/)
    closed.emit("close")
    await closedAssertion
    assertListenersCleared(closed)

    const failed = new FakeWebSocket()
    const onFailed = send(failed, 2, "Network.getAllCookies")
    const failedAssertion = assert.rejects(onFailed, /CDP WebSocket 错误/)
    failed.emit("error", new Error("boom"))
    await failedAssertion
    assertListenersCleared(failed)
  }
})

test("cdpSend：命令超时也会拒绝并清理，允许外层进入下一轮断开诊断", async () => {
  for (const send of [cdpSend, chromiumInternal.cdpSend]) {
    const ws = new FakeWebSocket()
    await assert.rejects(send(ws, 2, "Network.getAllCookies", {}, 5), /CDP 命令超时/)
    assertListenersCleared(ws)
  }
})

test("断开目标诊断：同 id 跨域仍在；同源新 id 替代仍算 target-gone", () => {
  const url = "https://baizhi.cloud/console/"
  const oldTarget = { id: "old", type: "page", url: "https://idp.example.com/sign-in", webSocketDebuggerUrl: "ws://old" }
  const replacement = { id: "new", type: "page", url: "https://baizhi.cloud/sign-in", webSocketDebuggerUrl: "ws://new" }
  const internal = { id: "internal", type: "page", url: "uccd://qwen.voice-agent/renderer/index", webSocketDebuggerUrl: "ws://internal" }

  assert.equal(diagnosePageTargets([oldTarget], url, "old"), "detached", "同一 target 跨域导航不等于消失")
  assert.equal(diagnosePageTargets([replacement], url, "old"), "target-gone", "原 id 消失后不能用同源新页掩盖")
  assert.equal(diagnosePageTargets([replacement], url, ""), "detached", "老 CDP 没有 target id 时才按 origin 兜底")
  assert.equal(diagnosePageTargets([internal], url, ""), "target-gone")
})

test("共享断开检查：OPEN 不查目标；其余原因映射为不同且不过度断言的错误", async () => {
  let diagnosed = false
  await assertBrowserConnected({
    ws: { readyState: 1 },
    diagnoseDisconnect: async () => {
      diagnosed = true
      return "target-gone"
    },
  })
  assert.equal(diagnosed, false)

  const cases = [
    ["target-gone", /登录页面目标消失/],
    ["detached", /登录页面仍在/],
    ["browser-closed", /浏览器进程已退出/],
    ["browser-unreachable", /调试端口不可达/],
  ]
  for (const [reason, pattern] of cases) {
    await assert.rejects(assertBrowserConnected({
      ws: { readyState: 3 },
      diagnoseDisconnect: async () => reason,
    }), pattern)
  }
})

test("cookie 读取失败时即使 WS 仍 OPEN，也能识别 target-gone；目标仍在才继续轮询", async () => {
  const goneWs = new FakeWebSocket()
  goneWs.send = () => goneWs.emit("close")
  await assert.rejects(loginCookies({
    ws: goneWs,
    diagnoseDisconnect: async () => "target-gone",
  }), /登录页面目标消失/)

  const aliveWs = new FakeWebSocket()
  aliveWs.send = () => aliveWs.emit("close")
  const cookies = await loginCookies({
    ws: aliveWs,
    diagnoseDisconnect: async () => "detached",
  })
  assert.deepEqual(cookies, [], "目标仍在且 WS OPEN 时允许瞬时命令失败后继续")
})
