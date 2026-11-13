// tests/today-spend.test.mjs —— 国内站额度卡片的「今日消耗」窗口。
//
// 覆盖：交易流水的分页累加、只算 `_consumption` 类、本地日历日零点（不是 UTC）、
// 遇到更早记录就地停止分页、「今日消耗」窗口的 textOnly 形状、失败静默跳过。
//
// 全部离线：一律注入假 fetchImpl，不碰真实凭证、不发真请求。

import test from "node:test"
import assert from "node:assert/strict"

import { SITES } from "../src/sites.mjs"
import { fetchTodaySpend } from "../src/monkeycode/credits.mjs"
import { _internal } from "../src/monkeycode/runtime.mjs"

const site = SITES.monkeycode
const readUsage = _internal.readUsage

/** 凭据：只带网页会话（额度 / 流水都只认它）。 */
const credential = { access_token: "oma_abcdefghijklmnopqrstuvwxyz0123", session_cookie: "sess" }

// ── 假上游 ───────────────────────────────────────────────────────────

/** 一页交易流水报文（`data` 里的形状）。 */
const pageBody = (transactions, hasNextPage = false) => ({
  transactions,
  page: { has_next_page: hasNextPage, total_count: transactions.length },
})

/** 一条流水：`createdAt` 是 unix 秒，`amount` 是千分之一积分。 */
const record = (createdAt, amount, kind = "model_consumption") => ({ kind, amount, created_at: createdAt })

/**
 * 平台假上游：按 URL 分派 wallet / subscription / transaction。
 *
 * @param {object} [options]
 * @param {object[]} [options.pages] 第 1 页、第 2 页……的 `data` 形状
 * @param {Function} [options.transaction] 直接接管流水端点（用于造失败）
 * @param {object} [options.wallet] 钱包报文
 * @param {string|null} [options.plan] 订阅档位
 */
function platformFetch({ pages = [[]], transaction = null, wallet = { balance: 12_500, daily_token_balance: 9_000_000, daily_token_limit: 10_000_000 }, plan = "basic" } = {}) {
  const urls = []
  const fetchImpl = async (url) => {
    const target = String(url)
    urls.push(target)
    if (target.includes("/api/v1/users/wallet/transaction")) {
      if (typeof transaction === "function") return transaction(target)
      const page = Number(new URL(target).searchParams.get("page") ?? "1")
      const body = pages[page - 1]
      // 只准备好那么多页：多翻一页就是「本不该翻」—— 直接抛，断言会看见。
      if (body === undefined) throw new Error(`没有准备第 ${page} 页`)
      return Response.json({ code: 0, message: "success", data: body })
    }
    if (target.endsWith("/api/v1/users/wallet")) return Response.json({ code: 0, data: wallet })
    if (target.endsWith("/api/v1/users/subscription")) {
      return Response.json({ code: 0, data: plan === null ? {} : { plan } })
    }
    throw new Error(`unexpected ${target}`)
  }
  return { fetchImpl, urls }
}

/** 本地日历日零点（unix 秒）—— 与实现同一口径，但由测试自己算一遍。 */
function localMidnight(date) {
  return Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000)
}

/** 固定的「现在」：2026-11-09 15:30 本地时间。 */
const NOW = new Date(2026, 10, 9, 15, 30, 0)
const now = () => NOW
const TODAY = localMidnight(NOW)

// ── a) 只算消耗 ──────────────────────────────────────────────────────

test("fetchTodaySpend：今天两条模型消耗 + 签到 + 邀请奖励 → 只算两条，calls=2，/1000 换积分", async () => {
  const { fetchImpl } = platformFetch({
    pages: [pageBody([
      record(TODAY + 7200, 50_000, "model_consumption"),
      record(TODAY + 3600, 98_914, "model_consumption"),
      record(TODAY + 120, 5_000_000, "invitation_reward"),
      record(TODAY + 60, 100_000, "checkin"),
      record(TODAY + 30, 20_000, "signup_bonus"),
      record(TODAY + 10, 30_000, "voucher_exchange"),
    ])],
  })
  const spent = await fetchTodaySpend("sess", site, { fetchImpl, now })
  assert.equal(spent.ok, true)
  // (98914 + 50000) / 1000 —— 千分之一积分，不是积分。
  assert.equal(spent.spend.credit, 148.914)
  assert.equal(spent.spend.calls, 2)
})

test("fetchTodaySpend：vm / mcp 消耗算钱不算「次调用」", async () => {
  const { fetchImpl } = platformFetch({
    pages: [pageBody([
      record(TODAY + 300, 7_000, "vm_consumption"),
      record(TODAY + 200, 3_000, "mcp_tool_consumption"),
      record(TODAY + 100, 1_000, "model_consumption"),
    ])],
  })
  const spent = await fetchTodaySpend("sess", site, { fetchImpl, now })
  assert.deepEqual(spent, { ok: true, spend: { credit: 11, calls: 1 } })
})

// ── b) 更早的记录不算，且就地停止分页 ────────────────────────────────

test("fetchTodaySpend：昨天及更早不计入，且遇到第一条更早记录就不再翻页（只请求 1 页）", async () => {
  const { fetchImpl, urls } = platformFetch({
    // has_next_page 故意给 true：要是实现不看「更早」这个信号，就会去请求第 2 页，
    // 而第 2 页根本没准备 —— 假上游会抛，测试立刻红。
    pages: [
      pageBody([
        record(TODAY + 3600, 12_000, "model_consumption"),
        record(TODAY - 1, 999_000, "model_consumption"),
        record(TODAY - 86_400, 5_000_000, "model_consumption"),
      ], true),
    ],
  })
  const spent = await fetchTodaySpend("sess", site, { fetchImpl, now })
  assert.equal(spent.ok, true)
  assert.equal(spent.spend.credit, 12)
  assert.equal(spent.spend.calls, 1)
  assert.equal(urls.length, 1, "遇到更早的记录必须就地停止，只请求第 1 页")
})

test("fetchTodaySpend：今天完全没消耗时 credit / calls 都是 0，不是失败", async () => {
  const { fetchImpl } = platformFetch({ pages: [pageBody([record(TODAY - 60, 88_888, "model_consumption")])] })
  const spent = await fetchTodaySpend("sess", site, { fetchImpl, now })
  assert.deepEqual(spent, { ok: true, spend: { credit: 0, calls: 0 } })
})

// ── c) 跨分页 ────────────────────────────────────────────────────────

test("fetchTodaySpend：第 1 页全是今天且 has_next_page=true → 请求第 2 页并累加", async () => {
  const { fetchImpl, urls } = platformFetch({
    pages: [
      pageBody([record(TODAY + 7200, 40_000), record(TODAY + 3600, 20_000)], true),
      pageBody([record(TODAY + 60, 3_000)], false),
    ],
  })
  const spent = await fetchTodaySpend("sess", site, { fetchImpl, now })
  assert.deepEqual(spent, { ok: true, spend: { credit: 63, calls: 3 } })
  assert.equal(urls.length, 2)
  assert.match(urls[0], /page=1&page_size=50$/)
  assert.match(urls[1], /page=2&page_size=50$/)
})

test("fetchTodaySpend：has_next_page=false 就停（不去请求第 2 页）", async () => {
  const { fetchImpl, urls } = platformFetch({ pages: [pageBody([record(TODAY + 60, 1_500)], false)] })
  const spent = await fetchTodaySpend("sess", site, { fetchImpl, now })
  assert.deepEqual(spent, { ok: true, spend: { credit: 1.5, calls: 1 } })
  assert.equal(urls.length, 1)
})

test("fetchTodaySpend：maxPages 防死循环（has_next_page 恒 true 也只翻这么多页）", async () => {
  const { fetchImpl, urls } = platformFetch({
    transaction: () => Response.json({ code: 0, data: pageBody([record(TODAY + 60, 1_000)], true) }),
  })
  const spent = await fetchTodaySpend("sess", site, { fetchImpl, now, maxPages: 3 })
  assert.equal(spent.ok, true)
  assert.equal(urls.length, 3, "maxPages 是防死循环的上限")
  assert.equal(spent.spend.credit, 3)
  assert.equal(spent.spend.calls, 3)
})

// ── f) 本地日历日零点（不是 UTC 零点）────────────────────────────────

test("fetchTodaySpend：本地零点前 1 秒不算今天，零点整算今天", async () => {
  const justAfterMidnight = new Date(2026, 10, 9, 0, 0, 5)
  const spent = await fetchTodaySpend("sess", site, {
    now: () => justAfterMidnight,
    fetchImpl: platformFetch({
      pages: [pageBody([
        record(localMidnight(justAfterMidnight), 2_000),
        record(localMidnight(justAfterMidnight) - 1, 900_000),
      ])],
    }).fetchImpl,
  })
  assert.deepEqual(spent, { ok: true, spend: { credit: 2, calls: 1 } })
})

test("fetchTodaySpend：「今天」是本地零点起算，不是 UTC 零点（否则北京时间 0–8 点的消耗会被算成昨天）", async () => {
  const date = new Date(2026, 10, 9, 3, 0, 0) // 本地 03:00
  const offsetMinutes = date.getTimezoneOffset()
  if (offsetMinutes === 0) return // 本机就是 UTC 时区，这条没有区分度
  const midnight = localMidnight(date)
  // 本地 00:01 的消耗：本地口径算今天；UTC 口径（东八区=前一天 16:01）会被算成昨天。
  const spent = await fetchTodaySpend("sess", site, {
    now: () => date,
    fetchImpl: platformFetch({ pages: [pageBody([record(midnight + 60, 4_000)])] }).fetchImpl,
  })
  assert.deepEqual(spent, { ok: true, spend: { credit: 4, calls: 1 } })
})

// ── d) 失败一律 ok:false，绝不抛 ─────────────────────────────────────

test("fetchTodaySpend：无 cookie → ok:false，且一个请求都不发", async () => {
  const { fetchImpl, urls } = platformFetch({})
  for (const cookie of [undefined, "", "   "]) {
    const spent = await fetchTodaySpend(cookie, site, { fetchImpl, now })
    assert.equal(spent.ok, false)
    assert.equal(spent.error, "未配置会话（session_cookie）")
  }
  assert.deepEqual(urls, [])
})

test("fetchTodaySpend：HTTP 500 / 网络抛错 / 业务码非 0 / 缺 transactions / 缺字段 → ok:false，不抛", async () => {
  const cases = {
    ["接口 500"]: () => new Response("upstream boom", { status: 500 }),
    ["网络抛错"]: () => { throw new Error("ECONNRESET") },
    ["业务码非0"]: () => Response.json({ code: 7, message: "没权限" }),
    ["缺transactions"]: () => Response.json({ code: 0, data: { page: { has_next_page: false } } }),
    ["transactions不是数组"]: () => Response.json({ code: 0, data: { transactions: {}, page: { has_next_page: false } } }),
    ["缺created_at"]: () => Response.json({ code: 0, data: pageBody([{ kind: "model_consumption", amount: 1_000 }]) }),
    ["消耗缺amount"]: () => Response.json({ code: 0, data: pageBody([{ kind: "model_consumption", created_at: TODAY + 60 }]) }),
    ["非JSON"]: () => new Response("<html>login</html>", { status: 200 }),
  }
  for (const [name, transaction] of Object.entries(cases)) {
    const { fetchImpl } = platformFetch({ transaction })
    const spent = await fetchTodaySpend("sess", site, { fetchImpl, now })
    assert.equal(spent.ok, false, `${name} 必须 ok:false`)
    assert.equal(typeof spent.error, "string")
    assert.ok(spent.error.length > 0, `${name} 要给出可读原因`)
  }
})

// ── e) readUsage 里的窗口形状 ────────────────────────────────────────

test("readUsage：成功时在最后追加 textOnly 的「今日消耗」，没有 used / amount / limit", async () => {
  const { fetchImpl } = platformFetch({
    pages: [pageBody([record(TODAY + 3600, 98_914, "model_consumption")])],
  })
  const usage = await readUsage(site, credential, fetchImpl, { now })
  assert.equal(usage.error, undefined)
  const today = usage.windows.find((w) => w.name === "今日消耗")
  assert.ok(today, "读成功就必须有「今日消耗」")
  assert.equal(today.textOnly, true, "宿主靠这个字段判断「有意的纯文字窗口」，缺了会报 used 必填")
  assert.equal(today.used, undefined, "textOnly 窗口不能带 used")
  assert.equal(today.amount, undefined)
  assert.equal(today.limit, undefined)
  assert.equal(today.balance, undefined)
  assert.equal(today.display, "98.914 积分 / 1 次调用")
  // 位置：原有两个窗口之后。
  assert.equal(usage.windows.at(-1).name, "今日消耗")
  assert.deepEqual(usage.windows.map((w) => w.name), ["每日额度", "积分余额", "今日消耗"])
})

test("readUsage：数字格式与百智云一致（98.79 积分 / 36 次调用），整数不带多余小数位", async () => {
  // 35 条 2744 + 1 条 2750 = 98790 千分之一积分 = 98.79 积分，共 36 次调用。
  const transactions = [
    ...Array.from({ length: 35 }, (_, index) => record(TODAY + 100 + index, 2_744)),
    record(TODAY + 200, 2_750),
  ]
  const ok = await readUsage(site, credential, platformFetch({ pages: [pageBody(transactions)] }).fetchImpl, { now })
  assert.equal(ok.windows.find((w) => w.name === "今日消耗").display, "98.79 积分 / 36 次调用")

  const zero = await readUsage(site, credential, platformFetch({ pages: [pageBody([])] }).fetchImpl, { now })
  // 额度内不产生扣费流水：说清楚「没扣」，而不是「0 积分」那种看着像读数坏了的样子。
  assert.equal(zero.windows.find((w) => w.name === "今日消耗").display, "今日未扣积分（额度内）")
})

test("readUsage：流水接口失败 → 没有「今日消耗」，其它窗口照常，整张卡片不报错", async () => {
  const failures = {
    ["HTTP 500"]: () => new Response("boom", { status: 500 }),
    ["网络抛错"]: () => { throw new Error("ECONNRESET") },
    ["缺transactions"]: () => Response.json({ code: 0, data: { page: { has_next_page: false } } }),
  }
  for (const [name, transaction] of Object.entries(failures)) {
    const usage = await readUsage(site, credential, platformFetch({ transaction }).fetchImpl)
    assert.equal(usage.error, undefined, `${name} 不能让额度卡片报错`)
    assert.equal(usage.windows.some((w) => w.name === "今日消耗"), false, `${name}：不该有「今日消耗」`)
    // 其它窗口一个都不能少。
    assert.deepEqual(usage.windows.map((w) => w.name), ["每日额度", "积分余额"])
    assert.equal(usage.windows.find((w) => w.name === "积分余额").balance, 12.5)
    assert.equal(usage.plan, "MonkeyCode Basic")
  }
})

test("readUsage：没有网页会话 → 不开任何窗口（也就没有「今日消耗」）", async () => {
  const { fetchImpl, urls } = platformFetch({})
  const usage = await readUsage(site, { access_token: "oma_abcdefghijklmnopqrstuvwxyz0123" }, fetchImpl)
  assert.match(usage.error, /session_cookie|网页会话/)
  assert.equal(usage.windows.length, 0)
  assert.deepEqual(urls, [])
})
