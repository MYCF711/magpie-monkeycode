// 百智云每日积分：用「无头受控浏览器」跑官方控制台，替用户点一下领取（issue #13 的 B 方案）。
//
// 为什么不再伪造 `interaction`：实测被上游静默降级 —— 无论快照多像，都回
// `claimed:false, captcha_required:true` + 一张点选图片。官方页面自己的 JS 才会算出
// 服务端认的那份行为快照，所以这里只做三件事：
//
//   ① 把该账号的会话 cookie 注入受控浏览器（`Network.setCookie`）；
//   ② 打开 https://baizhi.cloud/console，用 **CDP 真实鼠标输入**（`Input.dispatchMouseEvent`）
//      点「领取 / 每日积分」按钮，页面自己发请求；
//   ③ 用 HTTP 回读钱包，确认 `daily_temporary_credit_claimed` 或 temporary 余额真的变了。
//
// ## 三条硬约束（会静默出错的那种）
//
// 1. **必须无头**：`--headless=new`，用户桌面上不许出现任何窗口（铁律 15）；
// 2. **用完必须清干净**：一次性 user-data-dir + 子进程，成功 / 异常 / 超时三条路径
//    都走同一个 `finally`（关浏览器 → 等退出 → 兜底 kill → 删 profile）；
// 3. **不伪造事件**：只用 `Input.dispatchMouseEvent`，绝不 `Runtime.evaluate` 里
//    `dispatchEvent` —— 那种事件 `isTrusted:false`，风控一眼看穿，还会把「点过了」
//    记成成功。`Runtime.evaluate` 在这里只用来**读**页面（readyState / 元素位置 / 文案）。

import { existsSync, rmSync } from "node:fs"

import { findBrowser } from "../browser-login.mjs"
import { cdpSend, openControlledBrowser } from "../session-login.mjs"
import { fetchWallet } from "./credits.mjs"

/** 官方控制台；每日积分入口在控制台首页的卡片里。 */
export const DAILY_CLAIM_CONSOLE_URL = "https://baizhi.cloud/console"

/** 会话 cookie 挂到这个域（控制台是 `baizhi.cloud/console`，带点的域覆盖子域）。 */
export const CLAIM_COOKIE_DOMAIN = ".baizhi.cloud"

/** 页面上出现这些文案 + 大图 ⇒ 判定为上游要图片验证码（点选验证码的标题是「验证后领取积分」）。 */
export const CAPTCHA_TEXT_RX = /验证后领取积分|图片验证码|滑块验证|拖动验证|安全验证/

/** 要求验证码时的报告文案：与 HTTP 路径保持一致，宿主会显示成「需要用户处理」。 */
export const CAPTCHA_MESSAGE = "上游要求图片验证码，请到 https://baizhi.cloud/console 手动领取每日积分"

/** 找不到按钮时的报告文案。 */
export const NO_BUTTON_MESSAGE = "官方控制台里没找到「领取每日积分」按钮（可能未登录、今日已领或页面已改版）"

/** 读页面状态（只读，不产生任何输入事件）。 */
export const READY_SCRIPT = "document.readyState"
export const LOCATION_SCRIPT = "location.href"

/**
 * 找「领取」按钮并把它滚进视口中心。
 *
 * 选择器不是猜的：先按文案圈定（`每日积分` > `每日领取` > 其它 `领取`），再优先真正的
 * `button` / `[role=button]` / `a`，最后取面积最小的那个（避免点到包住整张卡片的外层 div）。
 * 返回 `{found, tag, role, text, rect, candidates}`；`rect` 是滚动后的视口坐标。
 */
export const PICK_CLAIM_SCRIPT = `(() => {
  // 实测（2026-11-24 控制台顶栏）：按钮文案是「每日领积分 +100」—— 不是「领取」，
  // 所以正则必须同时覆盖「领取」和「领积分」，否则永远找不到按钮。
  const RX = /领取|领积分/;
  const score = (text) => (/每日积分|每日领积分/.test(text) ? 0 : /每日领取|领取每日|领积分/.test(text) ? 1 : 2);
  const all = [];
  const seen = new Set();
  for (const el of document.querySelectorAll("button,[role=button],a,span,div")) {
    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    if (!text || text.length > 40 || !RX.test(text)) continue;
    if (seen.has(el)) continue;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
    const role = el.getAttribute("role") || "";
    const clickable = el.tagName === "BUTTON" || el.tagName === "A" || role === "button";
    all.push({
      el,
      tag: el.tagName.toLowerCase(),
      role,
      text: text.slice(0, 40),
      clickable,
      score: score(text),
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
      area: rect.width * rect.height,
    });
  }
  const candidates = all.map((c) => ({
    tag: c.tag,
    text: c.text,
    clickable: c.clickable,
    disabled: c.disabled,
  })).slice(0, 10);
  const enabled = all.filter((c) => !c.disabled);
  const clickable = enabled.filter((c) => c.clickable);
  const pool = clickable.length > 0 ? clickable : enabled;
  if (pool.length === 0) return { found: false, candidates };
  pool.sort((a, b) => (a.score - b.score) || (a.area - b.area));
  const pick = pool[0];
  pick.el.scrollIntoView({ block: "center", inline: "center" });
  const rect = pick.el.getBoundingClientRect();
  return {
    found: true,
    tag: pick.tag,
    role: pick.role,
    text: pick.text,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    candidates,
  };
})()`

/**
 * 读页面上「是不是要验证码」的特征：对话框文案 + 大尺寸 data:image / canvas。
 *
 * 只看特征，不点、不填、不触发任何事件。
 */
export const CAPTCHA_SCRIPT = `(() => {
  const body = (document.body && document.body.innerText || "").slice(0, 6000);
  const dialogs = [...document.querySelectorAll('[role=dialog],[class*=captcha i],[id*=captcha i],[class*=modal i]')]
    .map((el) => (el.innerText || "").slice(0, 400))
    .filter(Boolean)
    .slice(0, 5);
  let bigImages = 0;
  for (const el of document.querySelectorAll("img[src^='data:image'], canvas")) {
    const rect = el.getBoundingClientRect();
    if (rect.width >= 120 && rect.height >= 60) bigImages += 1;
  }
  return { body: body.slice(0, 800), dialogs, bigImages };
})()`

/** 把 `a=1; b=2` 拆成 cookie 对；空值 / 畸形段直接跳过。 */
export function cookiePairs(raw) {
  if (typeof raw !== "string") return []
  const pairs = []
  for (const part of raw.split(";")) {
    const text = part.trim()
    if (text.length === 0) continue
    const index = text.indexOf("=")
    if (index <= 0) continue
    const name = text.slice(0, index).trim()
    const value = text.slice(index + 1).trim()
    if (name.length === 0 || value.length === 0) continue
    pairs.push({ name, value })
  }
  return pairs
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function defaultReadWallet({ cookie, site, fetchImpl, timeoutMs }) {
  return fetchWallet(cookie, site, { fetchImpl, timeoutMs })
}

/** 读一次页面表达式；任何 CDP 错误都吞掉（导航期间执行上下文会短暂失效）。 */
async function readPage(send, ws, nextId, expression) {
  const result = await send(ws, nextId(), "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }).catch(() => undefined)
  return result?.result?.value
}

/**
 * 清理：关浏览器 → 等退出 → 兜底 kill → 删一次性 profile。
 *
 * 三条路径（成功 / 抛错 / 超时）都在 `finally` 里走这一个函数，所以调用方不可能忘。
 */
export async function cleanupControlledBrowser(handle, { send = cdpSend, nextId, sleep = defaultSleep, now = Date.now } = {}) {
  if (!handle) return
  const nextIdOf = typeof nextId === "function" ? nextId : (() => 9_000_000)
  // ① 优雅关闭：Browser.close 会让浏览器自己收掉渲染 / GPU 子进程。
  await Promise.race([
    Promise.resolve(send(handle.ws, nextIdOf(), "Browser.close", {})).catch(() => {}),
    sleep(2_000),
  ])
  // ② 等它真的退出；还活着就兜底 kill（openControlledBrowser 的 close 会 kill）。
  const until = now() + 5_000
  while (now() < until && typeof handle.running === "function" && handle.running()) {
    await sleep(200)
  }
  try {
    handle.ws?.close?.()
  } catch {}
  try {
    handle.close?.()
  } catch {}
  // ③ 一次性 user-data-dir 必须删干净：浏览器退出后句柄才释放，Windows 上 close 里那次
  //    rm 常常撞上文件占用 —— 实测会留下 `magpie-session-login-*` 目录，所以必须重试。
  //    持久 profile 是用户的登录态，一律不碰。
  if (handle.persistent !== true && typeof handle.profileDir === "string" && handle.profileDir.length > 0) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (!existsSync(handle.profileDir)) break
      try {
        rmSync(handle.profileDir, { recursive: true, force: true })
      } catch {}
      if (!existsSync(handle.profileDir)) break
      await sleep(250)
    }
  }
}

/**
 * 用真实浏览器跑官方控制台领取每日积分。
 *
 * @param {object} options
 * @param {{session_cookie?: string}} options.credential 账号凭据（只要会话 cookie）
 * @param {object} options.site 站点配置（`sessionCookies` / `sessionCookie`）
 * @param {number} [options.timeoutMs] 整体上限，默认 90 秒
 * @param {Function} [options.fetchImpl] 回读钱包用的 fetch（测试注入）
 * @param {{name:string,path:string}} [options.browser] findBrowser() 的结果（测试注入）
 * @param {Function} [options.openBrowser] 默认 openControlledBrowser
 * @param {Function} [options.send] 默认 cdpSend
 * @param {Function} [options.readWallet] 默认 HTTP fetchWallet
 * @param {Function} [options.sleep]
 * @param {Function} [options.now]
 * @param {string} [options.consoleUrl]
 * @returns {Promise<{kind:"claimed"|"already-claimed"|"captcha"|"failed", credit?:number, message?:string, candidates?:object[]}>}
 */
export async function claimDailyCreditInBrowser({
  credential,
  site,
  timeoutMs = 90_000,
  fetchImpl = fetch,
  browser,
  openBrowser = openControlledBrowser,
  send = cdpSend,
  readWallet = defaultReadWallet,
  sleep = defaultSleep,
  now = Date.now,
  consoleUrl = DAILY_CLAIM_CONSOLE_URL,
} = {}) {
  const pairs = cookiePairs(credential?.session_cookie)
  if (pairs.length === 0) {
    return {
      kind: "failed",
      message: "未配置会话（session_cookie）—— 每日积分只认网页登录态，请用「浏览器登录」添加账号",
    }
  }
  const cookie = pairs.map((pair) => `${pair.name}=${pair.value}`).join("; ")
  const deadline = now() + timeoutMs
  const remaining = (cap) => Math.max(0, Math.min(cap, deadline - now()))

  // 先确认「今天是不是还没领」：已领取就不开浏览器（省一次启动 + 一次点击）。
  const walletBefore = await Promise.resolve(
    readWallet({ cookie, site, fetchImpl, timeoutMs: Math.max(1_000, remaining(10_000)) }),
  ).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  if (!walletBefore?.ok) {
    return { kind: "failed", message: `领取前读取钱包失败：${walletBefore?.error ?? "未知错误"}` }
  }
  if (walletBefore.wallet.dailyClaimed) return { kind: "already-claimed", message: "今日已领取" }

  const executable = browser ?? findBrowser()
  if (!executable?.path) {
    return { kind: "failed", message: "没有可用的 Chromium 浏览器（Chrome / Edge / 国产 Chromium 都行）" }
  }

  let handle
  let sequence = 100
  const nextId = () => {
    sequence += 1
    return sequence
  }

  try {
    handle = await openBrowser({ headless: true, browser: executable, url: "about:blank" })
    await send(handle.ws, nextId(), "Network.enable")
    let cookieRejected = 0
    for (const pair of pairs) {
      const applied = await send(handle.ws, nextId(), "Network.setCookie", {
        name: pair.name,
        value: pair.value,
        domain: CLAIM_COOKIE_DOMAIN,
        path: "/",
        secure: true,
      }).catch(() => undefined)
      if (applied && applied.success === false) cookieRejected += 1
    }
    if (cookieRejected === pairs.length) {
      return { kind: "failed", message: "无法把会话 cookie 写进受控浏览器（浏览器拒绝了 Network.setCookie）" }
    }

    await send(handle.ws, nextId(), "Page.enable")
    // 无头 Chrome 的 UA 里带 `HeadlessChrome` —— 官方页面的风控（bundle 里的 botd）
    // 一看到就判无头并直接回 captcha_required。换成本机同版本的普通 Chrome UA（只改 UA 文本，
    // 不碰任何事件），这是无头自动化的标准前置，不是伪造点击。
    const rawUserAgent = await readPage(send, handle.ws, nextId, "navigator.userAgent")
    if (typeof rawUserAgent === "string" && rawUserAgent.includes("HeadlessChrome")) {
      await send(handle.ws, nextId(), "Network.setUserAgentOverride", {
        userAgent: rawUserAgent.replace(/HeadlessChrome/g, "Chrome"),
      }).catch(() => {})
    }
    await send(handle.ws, nextId(), "Page.navigate", { url: consoleUrl })

    // ── 等文档就绪 ───────────────────────────────────────────────
    let ready = false
    while (now() < deadline && !ready) {
      ready = (await readPage(send, handle.ws, nextId, READY_SCRIPT)) === "complete"
      if (!ready) await sleep(250)
    }
    if (!ready) {
      return { kind: "failed", message: "官方控制台没有在超时内加载完成（网络或登录态异常）" }
    }

    // ── 等「领取」按钮出现；顺便识别「被踢回登录页」 ─────────────────
    let picked
    const buttonDeadline = now() + remaining(25_000)
    while (now() < buttonDeadline) {
      const href = await readPage(send, handle.ws, nextId, LOCATION_SCRIPT)
      if (typeof href === "string" && /\/sign-in|\/login|passport/i.test(href)) {
        return {
          kind: "failed",
          message: "会话被控制台判为无效（页面跳到了登录页），请重新「浏览器登录」该账号",
        }
      }
      picked = await readPage(send, handle.ws, nextId, PICK_CLAIM_SCRIPT)
      if (picked?.found === true) break
      await sleep(400)
    }
    if (picked?.found !== true) {
      return { kind: "failed", message: NO_BUTTON_MESSAGE, candidates: picked?.candidates ?? [] }
    }
    const rect = picked.rect ?? {}
    if (!(rect.width > 0 && rect.height > 0)) {
      return { kind: "failed", message: `找到了「${picked.text || "领取"}」但它的尺寸为 0（页面还没渲染完）` }
    }
    const centerX = Math.round(rect.x + rect.width / 2)
    const centerY = Math.round(rect.y + rect.height / 2)

    // ── 真实鼠标：移动到按钮 → 按下 → 松开 → 再补一条移动轨迹 ────────
    // ⚠ 只用 Input.*，不构造任何 JS 事件（isTrusted 会暴露）。
    await send(handle.ws, nextId(), "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: centerX - 60, y: centerY - 32, button: "none", buttons: 0,
    })
    await sleep(80)
    await send(handle.ws, nextId(), "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: centerX - 12, y: centerY - 5, button: "none", buttons: 0,
    })
    await sleep(60)
    await send(handle.ws, nextId(), "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: centerX, y: centerY, button: "none", buttons: 0,
    })
    await sleep(40)
    await send(handle.ws, nextId(), "Input.dispatchMouseEvent", {
      type: "mousePressed", x: centerX, y: centerY, button: "left", buttons: 1, clickCount: 1,
    })
    await sleep(70)
    await send(handle.ws, nextId(), "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: centerX, y: centerY, button: "left", buttons: 0, clickCount: 1,
    })
    await sleep(120)
    await send(handle.ws, nextId(), "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: centerX + 14, y: centerY + 8, button: "none", buttons: 0,
    })

    // ── 回读钱包确认到账（最多 ~20 秒），期间识别验证码 ──────────────
    const confirmDeadline = now() + Math.max(2_000, remaining(20_000))
    while (now() < confirmDeadline) {
      const wallet = await Promise.resolve(
        readWallet({ cookie, site, fetchImpl, timeoutMs: Math.max(1_000, remaining(10_000)) }),
      ).catch(() => undefined)
      if (wallet?.ok) {
        const delta = wallet.wallet.temporary - walletBefore.wallet.temporary
        if (wallet.wallet.dailyClaimed || delta > 0) {
          const credit = Math.round(delta * 100) / 100
          return { kind: "claimed", credit: credit > 0 ? credit : 0, unit: "credit" }
        }
      }
      const captcha = await readPage(send, handle.ws, nextId, CAPTCHA_SCRIPT)
      if (captcha && (
        (Array.isArray(captcha.dialogs) && captcha.dialogs.some((text) => CAPTCHA_TEXT_RX.test(text)))
        || (Number(captcha.bigImages) >= 1 && /验证/.test(String(captcha.body ?? "")))
      )) {
        return { kind: "captcha", message: CAPTCHA_MESSAGE }
      }
      await sleep(600)
    }
    return {
      kind: "failed",
      message: "点了「领取每日积分」但钱包没有变化（上游可能拦下了这次点击），请稍后重试或到控制台手动领取",
    }
  } catch (error) {
    return {
      kind: "failed",
      message: `受控浏览器领取失败：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    // 成功 / 抛错 / 超时都从这里出去：关浏览器、等退出、删一次性 profile。
    await cleanupControlledBrowser(handle, { send, nextId, sleep, now })
  }
}