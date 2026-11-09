// 单测不许读开发机上的真实账号缓存（可能是「探测后全不可用 ⇒ 空表」）。
process.env.MAGPIE_MONKEYCODE_CACHE_DIR = "C:\__magpie_test_cache__"
// 单测不许真的拉起浏览器；下面的「可选 invite 输入」结构锁也不许因此降级成 skip。
process.env.MAGPIE_PLUGIN_DISABLE_BROWSER = "1"
// 账号库 / 邀请策略全都指到不存在的临时 HOME：下面第 ⑥ 组会实例化真工厂并调 ask()，
// 必须保证它读不到、也碰不到开发机上的真实 plugin-auth.json。
const TEST_HOME = "C:\\__magpie_test_invite_url_home__"
process.env.USERPROFILE = TEST_HOME
process.env.HOME = TEST_HOME
// tests/invite-url.test.mjs —— 邀请码拼进 URL 的契约（纯函数，零网络、零浏览器）
//
// 依据 docs/baizhi-invite-research.md §7.2（2026-11-09 匿名只读探明，两端公开 bundle + 匿名 302）：
//
//   · MonkeyCode 国内站：邀请码 = 邀请人 `user.id`；
//     登录入口的形态是 `GET /api/v1/users/login?redirect=&inviter_id=<code>`（前端模板逐字如此）
//     —— 参数名写错不会有任何报错（服务端照旧 302），所以只能靠这个文件锁。
//   · 百智云：邀请码 = `GET /api/v1/user/invite-code` 的 `data.invite_code`；
//     邀请链接落在 **`/sign-in`**，参数名 **`invite_code`**；
//     规范域名只有 `baizhi.cloud`（`app.baizhi.cloud` 是 SSR 兜底，本机 DNS 解析不到）。
//   · 国际站：同一份前端 bundle，但邀请链接硬编码 `.com` 域名，且**没有**百智云 SSO
//     ⇒ 按「国际版保持独立」：绝不带邀请参数。
//
// ⚠ 这个文件**先于实现存在**：`src/sites.mjs` 还没有这两个导出时，它是真红的
//   （ERR_MODULE_NOT_FOUND / does not provide an export named …）。
//   实现落盘后本文件必须转绿，且不需要改一个字 —— 这就是「契约先行」的意思。
//
// 刻意不测的东西：
//   · `0` / `1` / 空 的三个数字语义 —— 那是 `src/invite.mjs:resolveInvite` 的活，
//     本文件里的函数拿到的应是**已经解析好的码**；
//   · 任何 `authorize()` 调用 —— 那会拉起浏览器（真机才验）。

import test from "node:test"
import assert from "node:assert/strict"

import { SITES, loginUrlWithInvite, ssoEntryUrlWithInvite } from "../src/sites.mjs"
import { BAIZHI } from "../src/baizhi/site.mjs"
import { makePlugin } from "../src/monkeycode/runtime.mjs"
import { makeBaizhiPlugin } from "../src/baizhi/runtime.mjs"

/** URL 里的 query 断言用：把字符串解析成 URL，纯字符串比较留给原样断言。 */
function asUrl(raw) {
  return new URL(raw)
}

// ── ① 空码：一字不改 ────────────────────────────────────────────────────

test("空码 = 原 URL 一字不改（留空就沿用站点默认登录页）", () => {
  for (const empty of ["", "   ", "\t\n", undefined, null]) {
    assert.equal(loginUrlWithInvite(SITES.monkeycode, empty), SITES.monkeycode.loginUrl, `码=${JSON.stringify(empty)}`)
    assert.equal(loginUrlWithInvite(SITES.monkeycodeintl, empty), SITES.monkeycodeintl.loginUrl)
    assert.equal(loginUrlWithInvite(BAIZHI, empty), BAIZHI.loginUrl)
  }
})

test("空码的 SSO 入口 = 原来那个裸登录接口，不能留一个空 inviter_id", () => {
  // 留一个 `?inviter_id=` 在功能上等价（实测 302 形状一致），但「空码不改 URL」更好排障：
  // 日志里出现 inviter_id= 就一定是用户真的填了码。
  assert.equal(ssoEntryUrlWithInvite(SITES.monkeycode, ""), "https://monkeycode-ai.com/api/v1/users/login")
  assert.equal(ssoEntryUrlWithInvite(SITES.monkeycode, "   "), "https://monkeycode-ai.com/api/v1/users/login")
})

// ── ② 国内站的 SSO 入口：inviter_id + redirect 为空 ──────────────────────

test("国内站 SSO：参数名必须是 inviter_id（写错时服务端照旧 302，只能靠断言锁）", () => {
  const u = asUrl(ssoEntryUrlWithInvite(SITES.monkeycode, "12345"))
  assert.equal(u.origin, "https://monkeycode-ai.com")
  assert.equal(u.pathname, "/api/v1/users/login")
  assert.equal(u.searchParams.get("inviter_id"), "12345")
  // 前端模板逐字是 `?redirect=&inviter_id=`：redirect 在、但为空。
  assert.equal(u.searchParams.get("redirect"), "", "redirect 必须存在且为空（前端模板就是这条）")
  // 百智云那套参数名不许串到 MonkeyCode 上（两套体系互不相干）。
  assert.equal(u.searchParams.get("invite_code"), null)
  assert.equal(u.searchParams.get("ic"), null)
})

test("国内站 SSO：码走 query，不能拼进 path 或 fragment", () => {
  const u = asUrl(ssoEntryUrlWithInvite(SITES.monkeycode, "88888"))
  assert.equal(u.hash, "")
  assert.ok(!u.pathname.includes("88888"), "码只在 query 里")
})

// ── ③ 百智云：落 /sign-in，参数 invite_code，域名只能是 baizhi.cloud ─────

test("百智云：落 /sign-in 且参数名是 invite_code（不是 inviter_id、不是 ic）", () => {
  const u = asUrl(loginUrlWithInvite(BAIZHI, "ABC-123"))
  assert.equal(u.pathname, "/sign-in")
  assert.equal(u.searchParams.get("invite_code"), "ABC-123")
  assert.equal(u.searchParams.get("inviter_id"), null, "inviter_id 是 MonkeyCode 的参数名")
  assert.equal(u.searchParams.get("ic"), null)
})

test("百智云：域名只能是 baizhi.cloud —— 绝不用 app.baizhi.cloud", () => {
  for (const code of ["", "ABC-123"]) {
    const raw = loginUrlWithInvite(BAIZHI, code)
    assert.equal(asUrl(raw).hostname, "baizhi.cloud", `码=${JSON.stringify(code)}`)
    assert.ok(!raw.includes("app.baizhi.cloud"), "app.baizhi.cloud 是 SSR 兜底域名（本机 DNS 解析不到）")
  }
})

test("百智云：8 位邀请码逐字落进 /sign-in?invite_code=（e · 真机那次的码）", () => {
  // 实测：`GET /api/v1/user/invite-code` → data.invite_code = "AB12CD34"（8 位大写字母数字）。
  assert.equal(loginUrlWithInvite(BAIZHI, "AB12CD34"), "https://baizhi.cloud/sign-in?invite_code=AB12CD34")
  const u = asUrl(loginUrlWithInvite(BAIZHI, "AB12CD34"))
  assert.equal(u.searchParams.get("invite_code"), "AB12CD34")
  assert.equal(u.pathname, "/sign-in")
  // 空码必须保持裸 URL：不许出现 `invite_code=` 这种空值参数。
  for (const empty of ["", "   ", undefined, null]) {
    const raw = loginUrlWithInvite(BAIZHI, empty)
    assert.equal(raw, BAIZHI.loginUrl, `空码 ${JSON.stringify(empty)} 必须一字不改`)
    assert.equal(asUrl(raw).searchParams.has("invite_code"), false)
  }
})

test("百智云：不能再落到 /console/（那个入口不读 invite_code）", () => {
  const u = asUrl(loginUrlWithInvite(BAIZHI, "ABC-123"))
  assert.notEqual(u.pathname, "/console/", "带码时必须走 /sign-in；/console/ 的登录框不认 invite_code")
  assert.notEqual(u.pathname, "/console")
})

// ── ④ 国际站：绝不带邀请 ────────────────────────────────────────────────

test("国际站：带码也绝不带邀请参数（保持独立）", () => {
  const codes = ["12345", "ABC-123", "a&b=c"]
  for (const code of codes) {
    const browserUrl = loginUrlWithInvite(SITES.monkeycodeintl, code)
    const ssoUrl = ssoEntryUrlWithInvite(SITES.monkeycodeintl, code)
    for (const [kind, raw] of [["浏览器入口", browserUrl], ["SSO 入口", ssoUrl]]) {
      assert.ok(!/inviter_id|invite_code|[?&]ic=/.test(raw), `${kind} 不该带邀请参数：${raw}`)
      assert.ok(!raw.includes("baizhi.cloud"), `${kind} 不该把国际站导去百智云：${raw}`)
    }
  }
  // 单独再钉一次「默认登录页没被改」
  assert.equal(loginUrlWithInvite(SITES.monkeycodeintl, "12345"), "https://monkeycode-ai.net/login")
})

// ── ⑤ 编码：特殊字符不能拼出第二个 query 参数 ───────────────────────────

test("特殊字符必须被编码：不能靠字符串拼接过关", () => {
  const nasty = "a&b=c#d e?f"
  const bz = asUrl(loginUrlWithInvite(BAIZHI, nasty))
  assert.equal(bz.searchParams.get("invite_code"), nasty)
  assert.equal(bz.searchParams.get("b"), null, "`&b=c` 不许被当成新参数")
  assert.equal(bz.hash, "", "`#d` 不许被当成 fragment")

  const ss = asUrl(ssoEntryUrlWithInvite(SITES.monkeycode, nasty))
  assert.equal(ss.searchParams.get("inviter_id"), nasty)
  const keys = [...ss.searchParams.keys()].sort()
  assert.deepEqual(keys, ["inviter_id", "redirect"], "query 上只允许这两个键")
})

// ── ⑥ 结构锁：邀请是「可选输入」，不是多出来的一个登录按钮 ──────────────
//
// 不启动浏览器：只实例化插件、读 auth.methods（authorize 一律不调）。
// 两个目标方法：
//   · MonkeyCode 国内站「用百智云账号开通」（SSO，团队目标：国内站统一走它）
//   · 百智云「浏览器登录」+「从本机客户端导入」（团队目标：只保留这两个）
// 断言它们**还在**，且**没有任何一个 label 是「邀请」**——邀请只能挂在这两个方法上。

test("MonkeyCode 国内站：SSO 方法还在，且没有新增「邀请」按钮", async () => {
  const plugin = await makePlugin(SITES.monkeycode)({ client: {} }, {})
  const methods = plugin.auth.methods
  assert.ok(Array.isArray(methods) && methods.length > 0, "auth.methods 不能空")
  for (const method of methods) assert.equal(typeof method.label, "string")

  assert.ok(
    methods.some((method) => /用百智云账号开通/.test(method.label)),
    "国内站的百智云 SSO 方法必须还在（邀请码要挂在这个方法上）",
  )
  for (const method of methods) {
    assert.ok(!/邀请/.test(method.label), `邀请是可选输入，不许变成独立按钮：${method.label}`)
  }
})

test("百智云：本机导入 + 浏览器登录还在，且没有新增「邀请」按钮", async () => {
  const plugin = await makeBaizhiPlugin()({ client: {} }, {})
  const methods = plugin.auth.methods
  assert.ok(Array.isArray(methods) && methods.length > 0, "auth.methods 不能空")

  for (const keep of [/从本机客户端导入/, /浏览器登录/]) {
    assert.ok(methods.some((method) => keep.test(method.label)), `百智云必须保留 ${keep}`)
  }
  for (const method of methods) {
    assert.ok(!/邀请/.test(method.label), `邀请是可选输入，不许变成独立按钮：${method.label}`)
  }
})

test("若某方法实现了 ask()，它必须能在不启动浏览器时纯本地返回", async () => {
  // 两种接法都合法：① 用 src/invite.mjs 的 makeInviteMethod（有 ask）；② 给既有方法加一个
  // 可选输入（没有 ask）。这里只锁「有 ask 的话，问一次不会拉起浏览器、也不会要网络」——
  // 真正「填了码之后 URL 会不会带上」由上面 ①–⑤ 的纯函数断言 + 实现任务的集成断言覆盖。
  for (const factory of [
    () => makePlugin(SITES.monkeycode)({ client: {} }, {}),
    () => makeBaizhiPlugin()({ client: {} }, {}),
  ]) {
    const plugin = await factory()
    for (const method of plugin.auth.methods) {
      if (typeof method.ask !== "function") continue
      const prompt = await method.ask({})
      assert.ok(prompt === null || (prompt && typeof prompt === "object"), "ask() 要么返回下一个问题，要么返回 null")
      if (prompt && prompt.type === "text") assert.equal(typeof prompt.key, "string")
    }
  }
})
