// src/system-open.mjs —— 用**系统默认浏览器**打开一个地址。
//
// 用途：插件自己的受控窗口打不开、或者用户需要去某个网页做一步操作（例如建一把
// API Key）时，把地址直接给他打开 —— magpie 的错误面板里链接不可点，只把 URL
// 写成文字等于让用户手抄。
//
// ⚠ 只开 http(s)；其余协议一律拒绝（防止被上游报文骗着去执行 `file://` 之类）。

import { spawn } from "node:child_process"

/** 这个 URL 能不能交给系统浏览器。 */
export function isSafeHttpUrl(url) {
  if (typeof url !== "string" || url.length === 0) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" || parsed.protocol === "http:"
  } catch {
    return false
  }
}

/**
 * 用系统默认浏览器打开 URL。返回是否成功**发起**（不保证浏览器真的显示）。
 *
 * @param {string} url
 * @param {{ spawnImpl?: typeof spawn }} [options]
 */
export function openInSystemBrowser(url, { spawnImpl = spawn } = {}) {
  if (!isSafeHttpUrl(url)) return false
  try {
    if (process.platform === "win32") {
      // `start` 是 cmd 内置命令；第一个空参数是窗口标题占位，没有它 URL 会被当标题。
      spawnImpl("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref()
      return true
    }
    const command = process.platform === "darwin" ? "open" : "xdg-open"
    spawnImpl(command, [url], { detached: true, stdio: "ignore" }).unref()
    return true
  } catch {
    return false
  }
}

export const _internal = { isSafeHttpUrl }
