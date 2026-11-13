// tests/multi-provider.test.mjs —— 单包三供应商：**登录面收敛**（目标态）+ 互不串味
//
// ═══════════════════════════════════════════════════════════════════
// 这个文件锁什么（目标态，见 docs/login-unification-audit.md）
// ═══════════════════════════════════════════════════════════════════
//
//   ① monkeycode（国内站）：登录面**恰好 1 个** OAuth —— 「用百智云账号开通」。
//      国内站自己的 API Key / 账号密码 / 本机导入 / 浏览器登录全部下线：
//      统一通过百智云 SSO 复用凭证。
//   ② baizhi：登录面**恰好 2 个** OAuth —— 顺序「从本机客户端导入」→「浏览器登录」。
//      API Key 与手机号验证码入口下线（老账号的**凭据解析**仍保留，见 src/credential.mjs）。
//   ③ monkeycodeintl（国际版）：**原样 4 个** —— API Key / 账号密码 / 本机导入 / 浏览器，
//      且**任何**百智云入口都不许出现（国际站不认百智云 SSO，见 AGENTS.md 0.6/0.7）。
//   ④ 契约不变：每个 OAuth 的 `authorize()` 必须立刻返回（<1000ms）、给 https 地址，
//      没开窗时必须给出手动地址说明。
//   ⑤ 域隔离：两站 cookie **同名**（`monkeycode_ai_session`），所以只能靠域区分；
//      `.com` 的会话不许被 `.net` 读到，反之亦然。
//   ⑥ 目标态新增的两个可测接口（红→绿的开关，签名与 docs §4 一致）：
//      · `src/baizhi/runtime.mjs` 的 `_internal.acceptBrowserCookie(cookie, site, { fetchImpl })`
//        → boolean：**读到 cookie ≠ 登录成功**；换不到 Key 必须返回 false（继续等）。
//      · `src/monkeycode/sso-import.mjs` 的 `resolveBaizhiCookie(sources)`
//        → 按 ①magpie 账号库 ②桌面客户端 ③持久 profile ④开窗 顺序取第一条可用会话。
//
// ⚠ 本文件是**目标态测试**：在改造落地前它会红，且必须红在"旧实现没收敛/没有这个接口"上，
//   不许为了迁就旧实现把断言放松。跑法：
//
//     node --test tests/multi-provider.test.mjs
//
// ═══════════════════════════════════════════════════════════════════
// 隔离：不启动浏览器、不读真实凭证
// ═══════════════════════════════════════════════════════════════════
//
// 下面这段在 import 之前执行（ESM 的 import 会被提升，但本仓库所有读 env 的地方都在
// **函数调用时**才读 —— 见 src/monkeycode/catalog.mjs:47、src/monkeycode/desktop-session.mjs:40。
// 所以位置不影响结果；将来若有模块在 import 时读 env，这里要改成动态 import）。
//
//   · MAGPIE_PLUGIN_DISABLE_BROWSER=1 → 所有登录分支都不许真的拉起 Chromium；
//   · 把 home / APPDATA / LOCALAPPDATA 指到一个**不存在**的临时路径 →
//     `~/.config/magpie/plugin-auth.json`、`%APPDATA%\com.chaitin.baizhi.monkeycode\*.json`
//     全都读不到，测试因此拿不到、也碰不到开发机上的真实登录态。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

const FAKE_HOME = join(tmpdir(), `magpie-test-nohome-${process.pid}`)
process.env.MAGPIE_MONKEYCODE_CACHE_DIR = "C:\\__magpie_test_cache__"
process.env.MAGPIE_PLUGIN_DISABLE_BROWSER = "1"
process.env.USERPROFILE = FAKE_HOME
process.env.HOME = FAKE_HOME
process.env.APPDATA = join(FAKE_HOME, "AppData", "Roaming")
process.env.LOCALAPPDATA = join(FAKE_HOME, "AppData", "Local")

import test from "node:test"
import assert from "node:assert/strict"

import * as entry from "../index.mjs"
import { SITES } from "../src/sites.mjs"
import { _internal } from "../src/monkeycode/runtime.mjs"
import { cookiesFromJar, desktopDataDirs, domainMatches } from "../src/monkeycode/desktop-session.mjs"
import { _internal as sessionInternal } from "../src/session-login.mjs"

/** 三家工厂，按「国内站 / 国际版 / 百智云」的固定顺序。 */
const FACTORIES = [
  ["monkeycode", entry.MonkeyCodeAuthPlugin],
  ["monkeycodeintl", entry.MonkeyCodeIntlAuthPlugin],
  ["baizhi", entry.BaizhiAuthPlugin],
]

const labels = (plugin) => plugin.auth.methods.map((method) => method.label)
const types = (plugin) => plugin.auth.methods.map((method) => method.type)
const oauth = (plugin) => plugin.auth.methods.filter((method) => method.type === "oauth")

/** 一次 authorize 的耗时（毫秒）+ 返回的 flow。不跑 callback：那里才会真的等用户/开窗。 */
async function timeAuthorize(method) {
  const started = Date.now()
  const flow = await method.authorize()
  return { ms: Date.now() - started, flow }
}

// ═══════════════════════════════════════════════════════════════════
// 隔离门闩（先证"测试环境本身是干净的"，再谈断言）
// ═══════════════════════════════════════════════════════════════════

test("隔离：不启动浏览器，且 home / AppData 指向不存在的路径（不读真实凭证）", () => {
  assert.equal(process.env.MAGPIE_PLUGIN_DISABLE_BROWSER, "1", "浏览器门闩必须是开着的")
  assert.equal(process.env.MAGPIE_MONKEYCODE_CACHE_DIR, "C:\\__magpie_test_cache__")
  assert.equal(existsSync(FAKE_HOME), false, `HOME 被指到了一个真实存在的目录：${FAKE_HOME}`)
  assert.equal(homedir(), FAKE_HOME, `homedir() 没有被隔离（仍是 ${homedir()}）—— 会读到真实 plugin-auth.json`)
  // 桌面客户端的候选目录必须全部落在隔离区里，否则本文件会在读真机上真实的 cookie 文件。
  const dirs = desktopDataDirs()
  assert.ok(dirs.length > 0)
  for (const dir of dirs) {
    assert.ok(dir.startsWith(FAKE_HOME), `桌面客户端目录没被隔离：${dir}`)
  }
})

// ═══════════════════════════════════════════════════════════════════
// ① 国内站：登录面收敛为唯一一个「用百智云账号开通」
// ═══════════════════════════════════════════════════════════════════

test("国内站登录面恰好 1 个 OAuth：「用百智云账号开通」", async () => {
  const cn = await entry.MonkeyCodeAuthPlugin({ client: {} })
  assert.deepEqual(
    types(cn),
    ["oauth"],
    `国内站必须只剩 1 个 OAuth —— 用户要求「国内 MonkeyCode 登录统一通过百智云 SSO 复用凭证」。`
      + `现状：${JSON.stringify(labels(cn))}。`
      + "要下线：API Key（type:api）、账号密码登录、从本机客户端导入、浏览器登录（见 docs/login-unification-audit.md §3.2）",
  )
  assert.match(cn.auth.methods[0].label, /用百智云账号开通/, `唯一的入口必须是用百智云账号开通，实际：${cn.auth.methods[0].label}`)
  assert.equal(typeof cn.auth.methods[0].authorize, "function")
})

test("国内站的百智云入口只开在百智云控制台（不是 MonkeyCode 自己的登录页）", async () => {
  const cn = await entry.MonkeyCodeAuthPlugin({ client: {} })
  const sso = cn.auth.methods.find((method) => method.label.includes("用百智云账号开通"))
  assert.ok(sso, `国内站缺 SSO 入口：${JSON.stringify(labels(cn))}`)
  const { flow } = await timeAuthorize(sso)
  assert.match(
    String(flow.url),
    /^https:\/\/baizhi\.cloud\//,
    `SSO 入口要开在百智云控制台（用户在那里登录/换号），实际：${flow.url}`,
  )
})

// ═══════════════════════════════════════════════════════════════════
// ② 百智云：登录面收敛为「本机导入」→「浏览器登录」（顺序固定）
// ═══════════════════════════════════════════════════════════════════

test("百智云登录面恰好 2 个 OAuth，顺序为本机导入 → 浏览器登录", async () => {
  const bz = await entry.BaizhiAuthPlugin({ client: {} })
  assert.deepEqual(
    types(bz),
    ["oauth", "oauth"],
    "百智云只保留「从本机客户端导入」与「浏览器登录」—— API Key 与手机号验证码入口下线"
      + `（老账号的凭据解析仍在 src/credential.mjs）。现状：${JSON.stringify(labels(bz))}`,
  )
  assert.match(bz.auth.methods[0].label, /从本机客户端导入/, `第 1 个必须是本机导入，实际：${bz.auth.methods[0].label}`)
  assert.match(bz.auth.methods[1].label, /浏览器登录$/, `第 2 个必须是浏览器登录，实际：${bz.auth.methods[1].label}`)
})

test("五种官方方式都要可用：说明里列全，且绝不替用户点某一种", async () => {
  // 「可用」= 插件不替用户选登录方式。两件可判的事：
  //   ① 窗口说明里必须把五种官方方式都写出来（用户要知道自己能挑）；
  //   ② 不许有「自动点第 N 个图标」的自动化 —— 那排图标的第 4 个是观猹，
  //      点下去等于把另外四种从用户手里拿走。
  const source = await readFile(new URL("../src/baizhi/runtime.mjs", import.meta.url), "utf8")
  for (const way of ["微信", "支付宝", "抖音", "GitHub", "观猹"]) {
    assert.ok(
      source.includes(way),
      `百智云浏览器登录的说明里缺少「${way}」—— 五种官方方式必须都对用户可见（AGENTS.md 0.4）`,
    )
  }
  // 死脚本已**整段删除**（docs/final-review-r2.md L-2）：它「自动点第 4 个图标（观猹）
  // + 自动勾协议」，正是产品明确禁止的行为，留着一个没有引用的导出就是给未来误接的诱因。
  // 这两条锁住「不许复活 / 不许回来」—— 谁把脚本写回源码，这里当场红。
  assert.doesNotMatch(
    source,
    /AGREE_PROTOCOL_JS|ways\[3\]\.click/,
    "百智云 runtime 里不许再有「自动点第 4 个图标（观猹）/ 自动勾协议」的死脚本："
      + "五种登录方式是用户的自由，插件只负责登完之后读 cookie（docs/final-review-r2.md L-2）",
  )
  // 「不许替用户点」的判据是**没有接线**：两个自动点图标的脚本都必须是死代码。
  // 只要有一个被接进轮询（`onPoll`），那排图标就会被插件抢先点掉。
  assert.doesNotMatch(
    source,
    /onPoll/,
    "百智云浏览器登录不许传 onPoll：那排图标的第 4 个是观猹，任何「每秒替用户点一下」的脚本都会"
      + "把它抢点掉，等于把微信/支付宝/抖音/GitHub 四种方式废掉（docs/login-unification-audit.md §3.4-b）",
  )
  const cnSource = await readFile(new URL("../src/monkeycode/runtime.mjs", import.meta.url), "utf8")
  assert.doesNotMatch(
    cnSource,
    /AGREE_PROTOCOL_JS|LOGIN_AUTOPILOT_JS/,
    "两个「自动点登录方式/确认授权」脚本要删干净（AGREE_PROTOCOL_JS 是死 import、LOGIN_AUTOPILOT_JS 是死常量）："
      + "国内站改造后只有 SSO 一个入口，确认授权那一步由 signInWithBaizhiSession 用 CDP 完成，"
      + "不需要也不允许再叠一层（docs/login-unification-audit.md §3.4-b/c）",
  )

  // 捕获逻辑与登录方式无关：只要两枚控制台 cookie 到齐，就说明"登录完成"（谁登的都一样）。
  const bz = await entry.BaizhiAuthPlugin({ client: {} })
  const browser = bz.auth.methods.find((method) => method.label.endsWith("浏览器登录"))
  assert.ok(browser, `百智云缺浏览器登录入口：${JSON.stringify(labels(bz))}`)
  const { flow } = await timeAuthorize(browser)
  assert.equal(typeof flow.callback, "function", "浏览器登录必须把真正的等待放在 callback() 里")
})

// ═══════════════════════════════════════════════════════════════════
// ③ 国际版：原样 4 个，且没有任何百智云入口
// ═══════════════════════════════════════════════════════════════════

test("国际版原样 4 个：API Key / 账号密码 / 本机导入 / 浏览器，且无百智云入口", async () => {
  const intl = await entry.MonkeyCodeIntlAuthPlugin({ client: {} })
  assert.deepEqual(
    types(intl),
    ["api", "oauth", "oauth", "oauth"],
    `国际版必须原样保留 API Key + 3 个 OAuth。现状：${JSON.stringify(labels(intl))}`,
  )
  assert.match(intl.auth.methods[1].label, /账号密码登录/)
  assert.match(intl.auth.methods[2].label, /从本机客户端导入/)
  assert.match(intl.auth.methods[3].label, /浏览器登录$/)

  // 国际站不认百智云 SSO：`GET /api/v1/users/login` 302 到它**自己的** /oauth/authorize
  // （client_id 为空，不经过 baizhi.cloud），注入百智云会话只落到首页、不签发 session。
  // 留着这个入口 = 让用户对着一个必然超时的流程等 240 秒。
  for (const merged of [labels(intl).join(" "), intl.auth.methods.map((m) => m.placeholder ?? "").join(" ")]) {
    assert.doesNotMatch(merged, /百智云/, "国际版不许出现任何百智云入口")
  }
})

test("邀请首选开关只给国内站与百智云：同 key、默认关、placement top，国际站没有", async () => {
  const cn = await entry.MonkeyCodeAuthPlugin({ client: {} })
  const intl = await entry.MonkeyCodeIntlAuthPlugin({ client: {} })
  const bz = await entry.BaizhiAuthPlugin({ client: {} })
  for (const [name, plugin] of [["monkeycode", cn], ["baizhi", bz]]) {
    assert.equal(plugin.auth.options.length, 1, `${name} 只新增一个邀请开关`)
    const option = plugin.auth.options[0]
    assert.equal(option.key, "invite_preferred")
    assert.equal(option.label, "首选账号作为邀请源")
    assert.equal(option.default, false)
    assert.equal(option.placement, "top")
    assert.equal("top" in option, false, "宿主字段是 placement:'top'，不是 top:true")
  }
  assert.equal(intl.auth.options, undefined, "国际站不得声明 invite_preferred")
  assert.deepEqual(types(cn), ["oauth"])
  assert.deepEqual(types(intl), ["api", "oauth", "oauth", "oauth"])
  assert.deepEqual(types(bz), ["oauth", "oauth"])
})

// ═══════════════════════════════════════════════════════════════════
// ④ 契约：authorize 立刻返回、给 https 地址、没开窗必须给手动说明
// ═══════════════════════════════════════════════════════════════════

test("每个 OAuth 的 authorize 都立刻返回，给 https 地址或手动说明（三家）", async () => {
  assert.equal(process.env.MAGPIE_PLUGIN_DISABLE_BROWSER, "1", "这条测试只在浏览器门闩开着时成立")
  for (const [name, factory] of FACTORIES) {
    const plugin = await factory({ client: {} })
    const oauthMethods = oauth(plugin)
    assert.ok(oauthMethods.length > 0, `${name}：至少要有一个 OAuth 登录方式`)
    for (const method of oauthMethods) {
      const { ms, flow } = await timeAuthorize(method)
      // authorize() 不许在返回前等用户登录（那会和 magpie 死锁：它要拿到 url 才去开浏览器）。
      assert.ok(ms < 1000, `${name} / ${method.label}：authorize 必须立刻返回，实际 ${ms}ms`)
      assert.equal(typeof flow?.callback, "function", `${name} / ${method.label}：缺 callback()`)
      assert.equal(typeof flow.url, "string", `${name} / ${method.label}：必须给 url`)
      assert.ok(flow.url.startsWith("https://"), `${name} / ${method.label}：url 必须是 https，实际 ${flow.url}`)
      // 没开窗就必须给手动地址说明 —— 否则用户对着空面板干等。
      if (flow.opened !== true) {
        assert.ok(
          String(flow.instructions ?? "").length > 0,
          `${name} / ${method.label}：没开窗（opened!==true）就必须给出手动地址说明`,
        )
      }
    }
  }
})

// ═══════════════════════════════════════════════════════════════════
// ⑤ 域隔离：.com / .net 同名 cookie 不串
// ═══════════════════════════════════════════════════════════════════

test("域隔离：两站 cookie 同名，所以只能按域取（桌面客户端那一侧）", () => {
  // 这条断言本身就是"为什么必须测域"：cookie 名一模一样，靠名字分不开。
  assert.equal(SITES.monkeycode.sessionCookie, SITES.monkeycodeintl.sessionCookie)
  assert.notEqual(SITES.monkeycode.platformBaseUrl, SITES.monkeycodeintl.platformBaseUrl)

  const jar = JSON.stringify([
    { name: "monkeycode_ai_session", value: "CN-SESSION", domain: ".monkeycode-ai.com", expires: Date.now() + 86_400_000 },
    { name: "monkeycode_ai_session", value: "INTL-SESSION", domain: ".monkeycode-ai.net", expires: Date.now() + 86_400_000 },
  ])
  const names = ["monkeycode_ai_session"]
  assert.equal(cookiesFromJar(jar, { names, domains: ["monkeycode-ai.com"] }), "monkeycode_ai_session=CN-SESSION")
  assert.equal(cookiesFromJar(jar, { names, domains: ["monkeycode-ai.net"] }), "monkeycode_ai_session=INTL-SESSION")

  // 只有国内站的会话时，国际站必须**读不到**（否则就是把国内 cookie 拿去打 .net ⇒ 上游 401）。
  const onlyCn = JSON.stringify([
    { name: "monkeycode_ai_session", value: "CN-SESSION", domain: ".monkeycode-ai.com", expires: Date.now() + 86_400_000 },
  ])
  assert.equal(cookiesFromJar(onlyCn, { names, domains: ["monkeycode-ai.net"] }), undefined)

  // 反例的域判据：跨站 false、本站子域 true、老格式（没有 domain）放行。
  assert.equal(domainMatches(".monkeycode-ai.com", "monkeycode-ai.net"), false)
  assert.equal(domainMatches(".monkeycode-ai.net", "monkeycode-ai.net"), true)
  assert.equal(domainMatches("www.monkeycode-ai.net", "monkeycode-ai.net"), true)
  assert.equal(domainMatches(undefined, "monkeycode-ai.net"), true)
})

test("域隔离：受控浏览器那一侧也不许串（CDP 读到的 cookie 按域筛）", () => {
  const cookies = [
    { name: "monkeycode_ai_session", value: "CN-SESSION", domain: ".monkeycode-ai.com" },
    { name: "monkeycode_ai_session", value: "INTL-SESSION", domain: ".monkeycode-ai.net" },
  ]
  const names = ["monkeycode_ai_session"]
  assert.equal(
    sessionInternal.sessionCookieOf(cookies, names, ["monkeycode-ai.net"]),
    "monkeycode_ai_session=INTL-SESSION",
  )
  assert.equal(
    sessionInternal.sessionCookieOf(cookies, names, ["monkeycode-ai.com"]),
    "monkeycode_ai_session=CN-SESSION",
  )
  // 只有国内站的会话 → 国际站窗口里必须读不到（读到它就会去换 Key，然后 401）。
  assert.equal(
    sessionInternal.sessionCookieOf([cookies[0]], names, ["monkeycode-ai.net"]),
    undefined,
  )
})

// ═══════════════════════════════════════════════════════════════════
// ⑥ 目标态新增接口（今天红；实现后绿 —— 契约见文件头与 docs §4）
// ═══════════════════════════════════════════════════════════════════

test("匿名 cookie 不得被百智云的浏览器登录接受（读到 cookie ≠ 登录成功）", async () => {
  const runtime = await import("../src/baizhi/runtime.mjs")
  const accept = runtime._internal?.acceptBrowserCookie
  assert.equal(
    typeof accept,
    "function",
    "缺少 src/baizhi/runtime.mjs 的 _internal.acceptBrowserCookie(cookie, site, { fetchImpl }) → boolean。"
      + "现在的 accept() 恒返回 true（baizhi/runtime.mjs:198-200），窗口一打开就有匿名 cookie，"
      + "于是「刚打开窗口」就被当成登录完成 → 换 Key 失败 → 用户白登一次。"
      + "目标：accept 里真的试一次换 Key，失败返回 false 继续等（照抄 monkeycode 的 issued 写法，"
      + "src/monkeycode/runtime.mjs:251-273）。见 docs/login-unification-audit.md §3.4-a",
  )

  const site = (await import("../src/baizhi/site.mjs")).BAIZHI
  // 匿名会话：平台回 401 —— 必须判「还没登完」，不是「登完了但失败了」。
  const anonymous = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ code: 401, message: "unauthenticated" }),
  })
  assert.equal(
    await accept("sl-session=anon; baizhi_session=anon", site, { fetchImpl: anonymous }),
    false,
    "匿名 cookie 被接受了 —— 它换不到 Key，必须继续等用户在窗口里登完",
  )

  // 真会话：能换出 sk- 才算登录完成；且**同一份 cookie 只兑换一次**（每次兑换都签发新 Key）。
  let calls = 0
  const signedIn = async () => {
    calls += 1
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: { items: [{ api_key: `sk-${"a".repeat(32)}`, status: "active" }] } }),
    }
  }
  assert.equal(await accept("sl-session=real; baizhi_session=real", site, { fetchImpl: signedIn }), true)
  assert.equal(await accept("sl-session=real; baizhi_session=real", site, { fetchImpl: signedIn }), true)
  assert.equal(calls, 1, `同一份 cookie 被兑换了 ${calls} 次 —— 应该缓存第一次的结果，别重复签发 Key`)
})

// ── 回归：**建完 Key 之后必须能恢复** ────────────────────────────────
//
// t8 的 `exchangeOf` 把 `needsKeyCreation` 也当成「定论」缓存了。真实流程是：
//
//   窗口里登录完成 → accept 兑换 → 账号下一把 sk- 都没有（自动建也失败）
//   → `{ needsKeyCreation: true, keysUrl }` 被**永久**缓存
//   → finishSignIn 打开建 Key 页、报「需要建 Key」
//   → 用户去控制台点「新建」（Key 有了）
//   → 回来「重试」→ 缓存命中**旧的 needsKeyCreation** → 再报一次「需要建 Key」
//   ⇒ 永远恢复不了（只能重启进程）。
//
// 所以：`ok`（真换出 sk-）才是定论，可以永久缓存；`needsKeyCreation` 是**中间态**，
// 下一次「重试」必须重新请求上游。但同一次登录里 accept 已经兑换过，
// finishSignIn 不能再来一次（`exchangeSessionForKey` 在没 Key 时会 POST 新建，
// 多兑一次就多签一把）—— 中间态只做**一次性交接**，取走即删。
test("建 Key 后的重试必须能恢复：needsKeyCreation 不得跨重试永久缓存", async () => {
  const runtime = await import("../src/baizhi/runtime.mjs")
  const accept = runtime._internal?.acceptBrowserCookie
  assert.equal(typeof accept, "function", "缺少 _internal.acceptBrowserCookie（见上一条用例）")
  const finishSignIn = runtime._internal?.finishSignIn
  assert.equal(typeof finishSignIn, "function", "缺少 _internal.finishSignIn（登录收尾，这条用例要证明它不再重复签 Key）")

  const site = (await import("../src/baizhi/site.mjs")).BAIZHI
  // 会话串必须唯一：缓存键就是它，用别的用例用过的值会命中别人的结果。
  // （变量名刻意不叫 cookie*：privacy-scan 会把 `cookie = "长串"` 当成真值脱敏。）
  const session = "sl-session=pending-key; baizhi_session=pending-key"

  /** 每次出站请求的「方法 + 路径」，用来证明重试真的重新打了上游。 */
  const calls = []
  /** 账号下有没有 sk-：第一次 false（自动建 Key 也失败），用户建好后 true。 */
  let hasKey = false
  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method ?? "GET").toUpperCase()
    calls.push(`${method} ${new URL(url).pathname}`)
    if (method === "POST") {
      // 自动建 Key 失败（上游常见：风控 / 并发 / 额度）—— 报文里没有 api_key。
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: {} }) }
    }
    const items = hasKey ? [{ api_key: `sk-${"c".repeat(64)}`, status: "active" }] : []
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { items } }) }
  }

  // ① 账号下一把 Key 都没有 → 兑换走到 needsKeyCreation，accept 仍算「登录完成」
  //    （finishSignIn 会去打开建 Key 页）。这一次兑换 = 列 Key → 自动建 → 再列一次。
  assert.equal(
    await accept(session, site, { fetchImpl }),
    true,
    "已登录但没 Key 时 accept 要放行，交给 finishSignIn 打开建 Key 页",
  )
  const afterFirst = calls.length
  assert.deepEqual(
    calls,
    ["GET /api/console/api-keys", "POST /api/console/api-keys", "GET /api/console/api-keys"],
    `第一次兑换应「列 Key → 自动建 → 再列一次」，实际：${JSON.stringify(calls)}`,
  )

  // ①b 同一次登录的收尾：**复用 accept 那次兑换**，不许再 POST 一把 Key（每次兑换都会
  //     签发新 Key，多兑一次就多一把）。它只是把「需要建 Key」报给用户。
  const failed = await finishSignIn(session, site, { fetchImpl })
  assert.equal(failed.type, "failed", "已经换不到 Key 时，登录收尾必须是 failed")
  assert.match(String(failed.error), /sk- 密钥失败/, `错误文案要说清是换 Key 失败，实际：${failed.error}`)
  assert.deepEqual(
    calls,
    ["GET /api/console/api-keys", "POST /api/console/api-keys", "GET /api/console/api-keys"],
    `登录收尾又打了一次上游（${JSON.stringify(calls.slice(afterFirst))}）—— accept 已经兑换过，不能再签一把 Key`,
  )

  // ② 用户去控制台点了「新建」，现在账号下有 Key 了 —— 这一次「重试」**必须重新请求**。
  hasKey = true
  assert.equal(await accept(session, site, { fetchImpl }), true)
  assert.ok(
    calls.length > afterFirst,
    `重试时一次请求都没发（${calls.length} == ${afterFirst}）—— needsKeyCreation 被当成定论缓存了：`
      + "用户建好 Key 之后仍然读到旧结果，永远恢复不了",
  )
  assert.deepEqual(
    calls.slice(afterFirst),
    ["GET /api/console/api-keys"],
    "重试只该列一次 Key（已经有 Key 了，不该再 POST 建一把）",
  )

  // ③ 成功结果照旧是定论：同一份 cookie 不再兑换第二次（否则每轮询都签一把新 Key）。
  const beforeThird = calls.length
  assert.equal(await accept(session, site, { fetchImpl }), true)
  assert.equal(
    calls.length,
    beforeThird,
    `成功结果必须继续缓存，实际又发了 ${calls.length - beforeThird} 次请求`,
  )
})

// ═══════════════════════════════════════════════════════════════════
// ⑦ 自动开通接线：百智云登录成功 → 顺手写出国内 MonkeyCode 账号
// ═══════════════════════════════════════════════════════════════════
//
// 依据 docs/automatic-credential-reuse.md §3.2 / §5。这里只锁**接线**：
//   · 两条成功路径都把「当次 cookie + 宿主 signal + 百智云身份」交给 provision；
//   · provision 是 fire-and-forget（不 await、失败不改百智云的结果）；
//   · 换 Key 失败时一次都不调；
//   · 两格可选邀请码（百智云 / 国内站）各自独立、`ask()` 纯本地、不新增按钮。
//
// 「真的去写账号库」的语义在 tests/provision.test.mjs；本段全程零网络零浏览器：
// provision 一律是注入的假函数，百智云平台用假 fetch。

/** 假百智云平台：列 Key（有可用 sk-）+ 控制台资料。 */
function baizhiPlatform({ apiKey = `sk-${"e".repeat(64)}`, userId = 12345, name = "观猹员 0001" } = {}) {
  return async (url) => {
    const path = new URL(url).pathname
    if (path === "/api/console/api-keys") {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: { items: [{ api_key: apiKey, status: "active" }] } }),
      }
    }
    if (path === "/api/v1/user/profile") {
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { id: userId, name } }) }
    }
    throw new Error(`假平台没准备这个端点：${path}`)
  }
}

test("自动开通：finishSignIn 成功时把当次 cookie / signal / 身份交给 provision", async () => {
  const finishSignIn = (await import("../src/baizhi/runtime.mjs"))._internal.finishSignIn
  const site = (await import("../src/baizhi/site.mjs")).BAIZHI
  // 会话串必须唯一：兑换结果按 cookie 缓存，用别的用例的值会命中别人的结果。
  const session = "sl-session=auto-happy; baizhi_session=auto-happy"

  const calls = []
  const controller = new AbortController()
  const result = await finishSignIn(session, site, {
    fetchImpl: baizhiPlatform(),
    provision: async (cookie, extra) => { calls.push({ cookie, ...extra }) },
    signal: controller.signal,
  })
  assert.equal(result.type, "success", "百智云登录本身必须成功")
  assert.equal(result.uid, "12345", "accountId / uid 口径不变（profile.id 会被转成字符串）")

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 1, `provision 应被调 1 次，实际 ${calls.length} 次`)
  assert.equal(calls[0].cookie, session, "拿到的必须是**当次**这条会话（不是缓存里别人的）")
  assert.equal(calls[0].signal, controller.signal, "宿主的 signal 要原样传下去 —— 取消时 provision 才能停下")
  assert.equal(
    calls[0].identity,
    "12345",
    "identity 必须是百智云账号身份（与 readBaizhiSessions 的 credential.user_id 同口径，否则每次登录一个新账号）",
  )
})

test("自动 provision 使用 resolver 猴码：off 可回退最近已链接账号，自邀必须为空", async () => {
  await withInviteHome(inviteAccountRecords(), async () => {
    const { _internal: runtime } = await import("../src/baizhi/runtime.mjs")
    const { createInvitePolicy } = await import("../src/invite-policy.mjs")
    const { createInviteStore } = await import("../src/invite.mjs")
    const { readBaizhiSessions } = await import("../src/monkeycode/sso-import.mjs")
    const { readProvisionedAccounts } = await import("../src/monkeycode/provision.mjs")
    const site = (await import("../src/baizhi/site.mjs")).BAIZHI
    const policy = createInvitePolicy({
      ctx: {},
      provider: "baizhi",
      dualManual: true,
      preferredStore: createInviteStore("baizhi-invite-source"),
      baizhiInviteStore: createInviteStore("baizhi"),
      monkeycodeInviteStore: createInviteStore("monkeycode"),
      readBaizhiAccounts: readBaizhiSessions,
      readMonkeycodeAccounts: () => readProvisionedAccounts("monkeycode"),
    })
    const inviteResolver = policy.prepare({})
    const calls = []
    const provision = async (_cookie, extra) => { calls.push(extra) }

    const normal = await runtime.finishSignIn("sl-session=invite-normal; baizhi_session=invite-normal", site, {
      fetchImpl: baizhiPlatform({ userId: 12345 }),
      provision,
      inviteResolver,
    })
    assert.equal(normal.type, "success")
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls[0].identity, "12345")
    assert.equal(calls[0].inviteCode, "mc-two", "最新 10 无猴账号，off 回退到最近已链接的 2")

    const self = await runtime.finishSignIn("sl-session=invite-self; baizhi_session=invite-self", site, {
      fetchImpl: baizhiPlatform({ userId: 10 }),
      provision,
      inviteResolver,
    })
    assert.equal(self.type, "success")
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls[1].identity, "10")
    assert.equal(calls[1].inviteCode, "", "targetIdentity=主来源 10，自邀时猴码必须为空")
  })
})

test("自动开通是 fire-and-forget：永不 resolve / 同步抛错都不影响百智云登录", async () => {
  const finishSignIn = (await import("../src/baizhi/runtime.mjs"))._internal.finishSignIn
  const site = (await import("../src/baizhi/site.mjs")).BAIZHI

  // ① 永不 resolve：一次自动开通要 5~90 秒（起一次无头 Chromium），等它就是登录面板转圈。
  const started = Date.now()
  const hanging = await finishSignIn("sl-session=auto-hang; baizhi_session=auto-hang", site, {
    fetchImpl: baizhiPlatform(),
    provision: () => new Promise(() => {}),
  })
  const elapsed = Date.now() - started
  assert.equal(hanging.type, "success", "provision 挂着也不能把登录卡住")
  assert.ok(elapsed < 50, `finishSignIn 必须立刻返回（实际 ${elapsed}ms）`)

  // ② 同步抛错：自动开通是"顺手做的事"，它炸了也只是少一张 MonkeyCode 卡。
  //    直接 `void provision(...)`（不加 `Promise.resolve().then`）的话，这里的同步 throw
  //    会把 finishSignIn 变成 rejected —— 那就等于百智云登录失败。
  const throwing = await finishSignIn("sl-session=auto-throw; baizhi_session=auto-throw", site, {
    fetchImpl: baizhiPlatform(),
    provision: () => { throw new Error("provision 炸了") },
  })
  assert.equal(throwing.type, "success", "provision 同步抛错也不许把百智云登录带崩")
  // 让被吞掉的 reject 有机会冒出来（若没 catch 住，本进程会在这里报 unhandled rejection）。
  await new Promise((resolve) => setImmediate(resolve))
})

test("自动开通只在成功之后：换 Key 失败时一次都不调 provision", async () => {
  const finishSignIn = (await import("../src/baizhi/runtime.mjs"))._internal.finishSignIn
  const site = (await import("../src/baizhi/site.mjs")).BAIZHI
  const calls = []
  // 匿名会话：平台 401（窗口刚打开时就是这个形态）。
  const unauthorized = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ code: 401, message: "unauthenticated" }),
  })
  const result = await finishSignIn("sl-session=auto-401; baizhi_session=auto-401", site, {
    fetchImpl: unauthorized,
    provision: (cookie) => { calls.push(cookie) },
  })
  assert.equal(result.type, "failed", "换不到 Key 时登录必须是 failed")
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, [], "登录没成功就不许去开通 —— 否则白跑一次 SSO，还可能写出个假账号")
})

function inviteAccountRecords() {
  // 每个账号用自己的会话串：假平台按 cookie 回**不同的** 8 位码，
  // 这样才能证明「换账号就换码」，也才能证明码不是 identity。
  const bz = (identity, accountId) => ({
    accountId,
    access: JSON.stringify({ session_cookie: `test-${identity}`, user_id: identity }),
  })
  const mc = (uid, accountId) => ({ uid, accountId, access: "", refresh: "" })
  return {
    baizhi: bz("1", "acct-1"),
    "baizhi#two-a": bz("2", "two"),
    // 同一 identity 的第二条只用来锁 select 去重，映射仍保留首先添加的 two。
    "baizhi#two-b": bz("2", "duplicate-two"),
    "baizhi#ten": bz("10", "latest-no-mc"),
    monkeycode: mc("mc-one", "acct-1"),
    "monkeycode#two": mc("mc-two", "two"),
  }
}

/**
 * 假平台：只认邀请码端点 `GET /api/v1/user/invite-code`，按 cookie 回不同的 8 位码。
 *
 * 真机实测的形态是 `{"code":0,"message":"success","data":{"invite_code":"AB12CD34"}}`；
 * 百智云邀请码是**平台单独下发的 8 位字母数字码**，不是账号 identity（15 位 user.id）。
 * 任何别的端点 / 别的请求一律抛错 —— 邀请策略不该打别的地方。
 */
function inviteCodePlatform(byCookie = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const href = String(url)
    calls.push(href)
    if (new URL(href).pathname !== "/api/v1/user/invite-code") throw new Error(`不该请求 ${href}`)
    const cookie = String(init?.headers?.cookie ?? "")
    return Response.json({ code: 0, message: "success", data: { invite_code: byCookie[cookie] ?? "" } })
  }
  return { fetchImpl, calls }
}

/** 本文件里三个假账号各自的 8 位码（与 `inviteAccountRecords` 的会话串一一对应）。 */
const INVITE_CODES = {
  "baizhi_session=test-1": "CODE0001",
  "baizhi_session=test-2": "CODE0002",
  "baizhi_session=test-10": "CODE0010",
}

/** 在临时 HOME 写一份假账号库；所有账号策略测试都不得读开发机真实记录。 */
async function withInviteHome(records, fn) {
  const home = mkdtempSync(join(tmpdir(), "magpie-invite-policy-"))
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  try {
    process.env.HOME = home
    process.env.USERPROFILE = home
    const config = join(home, ".config", "magpie")
    mkdirSync(config, { recursive: true })
    writeFileSync(join(config, "plugin-auth.json"), JSON.stringify(records, null, 2))
    return await fn(home)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
}

test("off 自动最新且不问；on 两站都给顶部 select、去重并共享记住的首选", async () => {
  await withInviteHome(inviteAccountRecords(), async () => {
    const { makeBaizhiPlugin } = await import("../src/baizhi/runtime.mjs")
    const { makePlugin } = await import("../src/monkeycode/runtime.mjs")
    let enabled = false
    const optionCalls = []
    const ctx = {
      client: {},
      magpie: {
        option(provider, key) {
          optionCalls.push([provider, key])
          return enabled
        },
      },
    }
    const bz = await makeBaizhiPlugin()(ctx, { provision: async () => ({ ok: true }) })
    const cn = await makePlugin(SITES.monkeycode)(ctx, {})
    const browser = bz.auth.methods.find((method) => /浏览器登录$/.test(method.label))
    const sso = cn.auth.methods[0]

    // 邀请码由平台单独下发（8 位字母数字）：URL 上必须是**它**，绝不是账号 identity。
    // 从第一次 ask 起就得拦住真网络 —— 本文件全程只许打假平台的邀请码端点。
    const platform = inviteCodePlatform(INVITE_CODES)
    const originalFetch = globalThis.fetch
    globalThis.fetch = platform.fetchImpl
    try {
      assert.equal(await browser.ask({}), null, "off 有账号不能默认弹邀请问题")
      assert.equal(await sso.ask({}), null)
      assert.deepEqual(browser.prompts, [])
      assert.deepEqual(sso.prompts, [])

      // CLI / old host 直接 authorize({}) 也必须选最新账号并拼对 URL；码来自上一次 ask 的缓存。
      const automatic = await browser.authorize({})
      const automaticCode = new URL(automatic.url).searchParams.get("invite_code")
      assert.equal(automaticCode, "CODE0010", "最新账号（identity 10）自己的 8 位码")
      assert.notEqual(automaticCode, "10", "identity 绝不能被当成 invite_code —— 那会弹 invite_code length must be 8 红条")
      assert.equal(automatic.opened, false, "测试门闩仍在，不能开真实浏览器")
      const automaticCn = await sso.authorize({})
      assert.equal(automaticCn.url, "https://baizhi.cloud/console/")

      enabled = true
      const select = await browser.ask({})
      assert.equal(select.type, "select")
      assert.equal(select.key, "inviteSource")
      assert.equal(select.placement, "top")
      assert.deepEqual(select.options.map((option) => option.value), ["latest", "1", "2", "10", "manual"])
      assert.equal(select.options.filter((option) => option.value === "2").length, 1, "identity 必须去重")

      // 宿主顺序：选定账号后再问一次（null），authorize 用同一份 inputs ⇒ 带的是 **2 号**自己的码。
      assert.equal(await browser.ask({ inviteSource: "2" }), null)
      const preferred = await browser.authorize({ inviteSource: "2" })
      const preferredCode = new URL(preferred.url).searchParams.get("invite_code")
      assert.equal(preferredCode, "CODE0002", "换账号就换码")
      assert.notEqual(preferredCode, "2")
      const cnSelect = await sso.ask({})
      assert.equal(cnSelect.options[0].value, "2", "国内站要读到百智云刚记住的首选")
      assert.equal(cnSelect.placement, "top")
      assert.ok(optionCalls.some(([provider, key]) => provider === "baizhi" && key === "invite_preferred"))
      assert.ok(optionCalls.some(([provider, key]) => provider === "monkeycode" && key === "invite_preferred"))
      assert.ok(platform.calls.every((href) => new URL(href).pathname === "/api/v1/user/invite-code"))
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

test("on 选 manual 后才依次问原有两格：placement top、字段独立、无新增按钮", async () => {
  await withInviteHome(inviteAccountRecords(), async (home) => {
    const { makeBaizhiPlugin } = await import("../src/baizhi/runtime.mjs")
    const plugin = await makeBaizhiPlugin()({
      client: {},
      magpie: { option: () => true },
    }, { provision: async () => ({ ok: true }) })
    const methods = plugin.auth.methods
    for (const method of methods) {
      assert.ok(!/邀请/.test(method.label), `邀请是可选输入，不许变成独立按钮：${method.label}`)
    }
    const browser = methods.find((method) => /浏览器登录$/.test(method.label))
    // 选来源那一步会去平台取 8 位码（本文件用假平台，不联网）。
    const platform = inviteCodePlatform(INVITE_CODES)
    const originalFetch = globalThis.fetch
    let manualCalls = 0
    try {
      globalThis.fetch = platform.fetchImpl
      assert.equal((await browser.ask({})).type, "select")
      assert.equal(platform.calls.length, 1, "选来源时只取一次码")

      // manual 分支必须**纯本地**：用户在 manual 里填的就是最终码，不需要再问平台。
      globalThis.fetch = () => {
        manualCalls += 1
        throw new Error("manual 分支不许发网络请求")
      }

      const first = await browser.ask({ inviteSource: "manual" })
      assert.equal(first.type, "text")
      assert.equal(first.key, "invite")
      assert.equal(first.placement, "top")

      const second = await browser.ask({ inviteSource: "manual", invite: "" })
      assert.equal(second.type, "text")
      assert.equal(second.key, "monkeycodeInvite")
      assert.equal(second.placement, "top")
      assert.match(second.message, /MonkeyCode/)
      assert.match(second.message, /首次/)
      assert.match(second.message, /留空|0|1/)
      assert.equal((await browser.ask({ inviteSource: "manual", monkeycodeInvite: "x" })).key, "invite")
      assert.equal(await browser.ask({ inviteSource: "manual", invite: "", monkeycodeInvite: "" }), null)

      const flow = await browser.authorize({
        inviteSource: "manual",
        // 百智云那格必须是 8 位字母数字（平台下发的形态）；猴码不受这个长度约束。
        invite: "BZXCODE1",
        monkeycodeInvite: "MC-y",
      })
      assert.equal(new URL(flow.url).searchParams.get("invite_code"), "BZXCODE1")
      const policy = (name) => JSON.parse(readFileSync(join(home, ".cache", "magpie", name), "utf8"))
      assert.equal(policy("baizhi-invite.json").code, "BZXCODE1")
      assert.equal(policy("monkeycode-invite.json").code, "MC-y")
      assert.equal(policy("baizhi-invite-source-invite.json").code, "manual", "首选选择也要写回")
      assert.equal(manualCalls, 0, "manual 分支一次网络都不许发")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

test("自动开通接线：两条成功路径都传 provision + 宿主 signal，默认实现只走国内站", async () => {
  const source = await readFile(new URL("../src/baizhi/runtime.mjs", import.meta.url), "utf8")

  // ① 两条成功路径（本机导入 / 浏览器登录）都要把 provision 与 signal 传进 finishSignIn。
  //    这两处拿不到真会话（一个要桌面客户端、一个要浏览器），只能锁源码形态。
  const wired = source.match(/finishSignIn\([^)]*cookie, site, \{ provision, signal, inviteResolver \}\)/g) ?? []
  assert.equal(wired.length, 2, `两条成功路径都要接线，实际 ${wired.length} 处：${JSON.stringify(wired)}`)

  // ② 宿主的 callback 第二参是 `{ signal }`；OpenCode 那条传 undefined ⇒ 必须有默认值。
  const callbacks = source.match(/async callback\(_code, \{ signal \} = \{\}\)/g) ?? []
  assert.equal(callbacks.length, 2, `两条路径的 callback 都要收 { signal }，实际 ${callbacks.length} 处`)

  // ③ 工厂必须收 ctx / options：client 从 ctx 来，options.provision 是离线测试的唯一入口。
  assert.match(source, /return async \(ctx = \{\}, options = \{\}\) =>/, "工厂必须收 ctx / options")
  assert.match(source, /options\.provision \?\?/, "options.provision 必须能整个替换默认实现")
  assert.doesNotMatch(source, /await provision\(/, "provision 绝对不许 await（5~90 秒会卡住登录面板）")

  // ④ 默认实现：猴码只能来自本次 resolver（含自邀跳过），不能绕回手动 store 另选。
  assert.match(source, /createInviteStore\("monkeycode"\)/, "国内站手动策略文件仍必须显式建")
  assert.match(source, /inviteResolver\(identity\)\.monkeycodeCode/, "自动开通要用 targetIdentity 对应的 resolver 猴码")
  assert.match(source, /inviteCode,\n\s+sso: signInWithBaizhiSession/, "resolver 猴码与 SSO 一起注入 provision")
  assert.doesNotMatch(source, /inviteCode: monkeycodeInvite\.read\(\)/, "自动开通不许绕过 resolver 直接读手动码")
  assert.match(source, /sso: signInWithBaizhiSession/, "SSO 由 sso-import 注入（provision 自己不起浏览器）")

  // ⑤ 国际站绝不在自动路径上（目标站点是 provision.mjs 里的常量）。
  assert.doesNotMatch(source, /monkeycodeintl/, "国际站永不被自动写：本文件不许出现 monkeycodeintl")
})

// ═══════════════════════════════════════════════════════════════════
// ⑧ 轮询放大（H1）+ 接线（M3）+ 邀请码落盘（R4）
// ═══════════════════════════════════════════════════════════════════
//
// 依据 docs/final-review.md 的 H1 / M3 与 t20 的 R4：
//   · H1：`acceptBrowserCookie` 在受控窗口里**每秒**被调一次（`BROWSER_LOGIN_POLL_MS=1000`），
//     没有负缓存就是「1 请求/秒」，`needsKeyCreation` 形态下还会**每秒 POST 建一把 Key**
//     （用户账号下静默签出几十把 magpie Key）。修法：非 ok 结果进 5 秒负缓存，
//     但**只给 accept 用** —— `finishSignIn` 绝不读（读了就回到 t15 的「建好 Key 也恢复不了」）。
//   · M3：`acceptBrowserCookie` 自己有测试，但没人锁住 `startBaizhiBrowserLogin` 真的用了它
//     （变异成 `accept: async () => true` 是绿的）。
//   · R4：`authorize` 把两格邀请码写进**各自**的策略文件这件事没有测试。

test("轮询负缓存：匿名会话连续 3 次 accept 只打 1 次上游（H1）", async () => {
  const { _internal } = await import("../src/baizhi/runtime.mjs")
  const site = (await import("../src/baizhi/site.mjs")).BAIZHI
  // 会话串必须唯一：缓存键就是它，用别的用例用过的值会命中别人的结果。
  const session = "sl-session=poll-anon; baizhi_session=poll-anon"

  let gets = 0
  const anonymous = async () => {
    gets += 1
    return { ok: false, status: 401, text: async () => JSON.stringify({ code: 401, message: "unauthenticated" }) }
  }

  // 受控窗口每秒轮询一次（最长 240 秒）。没有负缓存 = 每秒一次 GET。
  for (let i = 0; i < 3; i += 1) {
    assert.equal(
      await _internal.acceptBrowserCookie(session, site, { fetchImpl: anonymous }),
      false,
      `第 ${i + 1} 次轮询：匿名会话不算登录完成`,
    )
  }
  assert.equal(gets, 1, `3 次轮询打了 ${gets} 次上游 —— 5 秒负缓存内应该只打 1 次（H1：1 请求/秒）`)
})

test("轮询负缓存：needsKeyCreation 反复 accept 不会每秒 POST 建一把 Key（H1）", async () => {
  const { _internal } = await import("../src/baizhi/runtime.mjs")
  const site = (await import("../src/baizhi/site.mjs")).BAIZHI
  const session = "sl-session=poll-keyless; baizhi_session=poll-keyless"

  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method ?? "GET").toUpperCase()
    calls.push(`${method} ${new URL(url).pathname}`)
    if (method === "POST") {
      // 「建 Key 成功了，但报文里没有可用的 api_key」—— 最终一致性下很常见。
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: {} }) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { items: [] } }) }
  }
  const posts = () => calls.filter((line) => line.startsWith("POST")).length

  for (let i = 0; i < 3; i += 1) {
    assert.equal(
      await _internal.acceptBrowserCookie(session, site, { fetchImpl }),
      true,
      `第 ${i + 1} 次：已登录但没 Key 也算「登录完成」（交给 finishSignIn 打开建 Key 页）`,
    )
  }
  assert.equal(posts(), 1, `3 次轮询 POST 了 ${posts()} 次 —— 每次都会在用户账号下签出一把 magpie Key（H1）`)
  assert.deepEqual(
    calls,
    ["GET /api/console/api-keys", "POST /api/console/api-keys", "GET /api/console/api-keys"],
    `第一次兑换应是「列 Key → 自动建 → 再列」，后两次轮询一次请求都不该发；实际：${JSON.stringify(calls)}`,
  )
})

// ── 负缓存 TTL 过期（docs/final-review-r2.md 的 L-1）──────────────────
//
// t24 的负缓存把「1 请求/秒」降到「5 秒最多 1 次」，但**过期那一侧没人守**：
// TTL 写成 `Infinity`、或把 `now - at >= TTL` 的判断删掉，原有测试全绿 ——
// 而那两种写法会让用户登完之后**永远等不到下一次真请求**（窗口一直停在「还没登完」，
// 直到 240 秒超时）。这里用可控的 `Date.now` 把三个时间点钉死：0 → +4999ms → +5001ms。
//
// 为什么改全局 `Date.now` 而不改生产文件：生产代码是在**调用时**读 `Date.now()`
// （`performExchange` 的 `at` 与 `readNegative` 的默认参数），换掉全局即可，零侵入；
// 单测没有别的时钟注入点，而任务书要求「不改生产文件」。
test("轮询负缓存 TTL：5 秒内不重复打上游，过期后必须重新请求并能接受真会话（L-1）", async () => {
  const { _internal } = await import("../src/baizhi/runtime.mjs")
  const site = (await import("../src/baizhi/site.mjs")).BAIZHI
  // 会话串必须唯一：缓存键就是它，用别的用例用过的值会命中别人的结果。
  const session = "sl-session=ttl-probe; baizhi_session=ttl-probe"

  const realNow = Date.now
  let clock = realNow()
  let gets = 0
  /** 用户登完之前一律 401 —— 这就是受控窗口刚打开时的匿名会话。 */
  let signedIn = false
  const fetchImpl = async () => {
    gets += 1
    if (!signedIn) {
      return { ok: false, status: 401, text: async () => JSON.stringify({ code: 401, message: "unauthenticated" }) }
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: { items: [{ api_key: `sk-${"b".repeat(64)}`, status: "active" }] } }),
    }
  }

  try {
    // 只在这段断言期间钉死时钟；finally 一定还原，避免污染同进程里其它用例的计时。
    Date.now = () => clock

    // ① t=0：第一次轮询真的打一次上游，结果进负缓存。
    assert.equal(await _internal.acceptBrowserCookie(session, site, { fetchImpl }), false)
    assert.equal(gets, 1, "第 1 次轮询应该打 1 次上游")

    // ② t=+4999ms（TTL 内）：命中负缓存，一次请求都不该发。
    clock += 4_999
    assert.equal(await _internal.acceptBrowserCookie(session, site, { fetchImpl }), false)
    assert.equal(gets, 1, "5 秒内的轮询不该再打上游 —— 负缓存没生效的话 H1（1 请求/秒）会回来")

    // ③ t=+5001ms（过期）：必须重新请求。TTL 写成 Infinity / 删掉过期判断，这里会停在 1。
    //    顺手证明「过期之后已经登完的会话」能被接受并成功 —— 否则用户卡在「还没登完」。
    clock += 2
    signedIn = true
    assert.equal(
      await _internal.acceptBrowserCookie(session, site, { fetchImpl }),
      true,
      "过期后已经登完的会话必须被接受 —— 永远读旧负缓存会让用户等到 240 秒超时",
    )
    assert.equal(gets, 2, "TTL 过期后必须重新请求上游（TTL=Infinity 或删掉过期判断都会停在第 1 次）")

    // ④ 换出 sk- 之后进**定论**缓存：同一份会话不再兑换（5 秒负缓存只影响「没换出 Key」）。
    assert.equal(await _internal.acceptBrowserCookie(session, site, { fetchImpl }), true)
    assert.equal(gets, 2, "成功结果必须落定论缓存，不再打上游")
  } finally {
    Date.now = realNow
  }
})

test("finishSignIn 不读轮询负缓存：轮询过匿名会话之后，收尾仍必须重新请求并成功", async () => {
  const { _internal } = await import("../src/baizhi/runtime.mjs")
  const site = (await import("../src/baizhi/site.mjs")).BAIZHI
  const session = "sl-session=poll-recover; baizhi_session=poll-recover"

  /** 轮询阶段是匿名（401）；用户登完之后才是真会话。 */
  let signedIn = false
  const calls = []
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname
    calls.push(path)
    if (!signedIn) {
      return { ok: false, status: 401, text: async () => JSON.stringify({ code: 401, message: "unauthenticated" }) }
    }
    if (path === "/api/console/api-keys") {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: { items: [{ api_key: `sk-${"f".repeat(64)}`, status: "active" }] } }),
      }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { id: 54321, name: "观猹员 0002" } }) }
  }

  // ① 轮询拿到匿名 401 —— 结果进负缓存。
  assert.equal(await _internal.acceptBrowserCookie(session, site, { fetchImpl }), false)
  const afterPoll = calls.length

  // ② 用户在这之后才登完。收尾（= 用户主动重试的语义）**不能**读那份负缓存，
  //    否则永远停在「还没登完 / 需要建 Key」上 —— 那正是 t15 修的那个 bug。
  signedIn = true
  const result = await _internal.finishSignIn(session, site, { fetchImpl })
  assert.equal(result.type, "success", "收尾必须重新请求上游并成功（负缓存只给 accept 轮询用）")
  assert.ok(calls.length > afterPoll, "收尾一次请求都没发 —— 它读到了轮询负缓存")
  assert.equal(result.uid, "54321", "收尾的账号身份不变")
})

test("接线：startBaizhiBrowserLogin 真的把 accept 接到 acceptBrowserCookie（M3）", async () => {
  const { _internal } = await import("../src/baizhi/runtime.mjs")
  const site = (await import("../src/baizhi/site.mjs")).BAIZHI
  const start = _internal.startBaizhiBrowserLogin
  assert.equal(typeof start, "function", "缺少 _internal.startBaizhiBrowserLogin（接线测试的接缝）")

  // 注入假的 start（真 start 会 spawn Chromium），把交给 session-login 的 options 拿回来。
  let captured
  const fakeStart = async (options) => {
    captured = options
    return { wait: async () => ({ cookie: "unused" }), close() {} }
  }
  await start(site, { browser: { path: "fake" }, start: fakeStart })
  assert.equal(typeof captured?.accept, "function", "startBrowserLogin 必须收到 accept 回调")
  assert.equal(captured.cookieNames.join(","), "sl-session,baizhi_session", "两枚控制台 cookie 都要")

  // accept 闭包用的是默认的全局 fetch —— 换成假平台（零网络）。
  const originalFetch = globalThis.fetch
  try {
    let signedIn = false
    globalThis.fetch = async () => (signedIn
      ? {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: { items: [{ api_key: `sk-${"a".repeat(64)}`, status: "active" }] } }),
      }
      : { ok: false, status: 401, text: async () => JSON.stringify({ code: 401, message: "unauthenticated" }) })

    // 匿名 cookie 不算登录完成。变异成 `accept: async () => true`（0.2.42 修掉的那个
    // 真机 bug 的形态）这里必须红。
    assert.equal(
      await captured.accept("sl-session=wire-anon; baizhi_session=wire-anon"),
      false,
      "匿名 cookie 被接成「登录完成」—— 0.2.42 修的那个 bug 又回来了（M3）",
    )
    // 反向也要防：不能恒 false（那会让登录永远等不到超时）。
    signedIn = true
    assert.equal(
      await captured.accept("sl-session=wire-real; baizhi_session=wire-real"),
      true,
      "真会话（能换出 sk-）必须算登录完成",
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("邀请码落盘：浏览器登录 authorize 把两格分别写进各自的策略文件（R4 防回退）", async () => {
  const { makeBaizhiPlugin } = await import("../src/baizhi/runtime.mjs")
  const home = mkdtempSync(join(tmpdir(), "magpie-invite-store-"))
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  try {
    // `createInviteStore()` 在**创建时**就算好文件路径，所以必须先把 HOME 指过去再建工厂。
    process.env.HOME = home
    process.env.USERPROFILE = home

    const plugin = await makeBaizhiPlugin()({ client: {} })
    const browser = plugin.auth.methods.find((method) => /浏览器登录$/.test(method.label))
    // 门闩开着（MAGPIE_PLUGIN_DISABLE_BROWSER=1）→ 不开窗；但两格邀请码先解析 + 落盘。
    const flow = await browser.authorize({ invite: "BZXCODE1", monkeycodeInvite: "MC-y" })
    assert.equal(flow.opened, false, "测试环境不许开窗")
    assert.equal(new URL(flow.url).searchParams.get("invite_code"), "BZXCODE1")

    const policy = (name) => JSON.parse(readFileSync(join(home, ".cache", "magpie", name), "utf8"))
    assert.equal(policy("baizhi-invite.json").code, "BZXCODE1", "百智云那格必须写 baizhi-invite.json")
    assert.equal(policy("monkeycode-invite.json").code, "MC-y", "国内站那格必须写 monkeycode-invite.json")
    // 两套码不同文件：混用会让国内站手动路径读到错的码（§5.1 第 3 条锁）。
    assert.notEqual(
      policy("baizhi-invite.json").code,
      policy("monkeycode-invite.json").code,
      "两格邀请码写进了同一个文件 —— 两套体系会被串在一起",
    )

    // identity 形态（15 位 user.id）不是邀请码：不落盘、不带进 URL（真机红条根因）。
    const identity = "9007199254740993"
    const rejected = await browser.authorize({ invite: identity })
    assert.equal(new URL(rejected.url).searchParams.get("invite_code"), null, "identity 不许被当成 invite_code")
    assert.equal(policy("baizhi-invite.json").code, "BZXCODE1", "非法输入不许覆盖已保存的合法码")
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
})

test("复用顺序：magpie 账号库 → 桌面客户端 → 持久 profile → 开窗", async () => {
  const sso = await import("../src/monkeycode/sso-import.mjs")
  const resolve = sso.resolveBaizhiCookie
  assert.equal(
    typeof resolve,
    "function",
    "缺少 src/monkeycode/sso-import.mjs 的 resolveBaizhiCookie(sources) → cookie。"
      + "国内站统一走百智云之后，SSO 必须**先复用**已登录的百智云会话，而不是每次都让用户开窗："
      + "① readBaizhiSessions()（~/.config/magpie/plugin-auth.json，只读）"
      + "② readDesktopBaizhiSession()（本机桌面客户端 baizhi-cookies.json）"
      + "③ readCookiesSilently(profileDirFor(\"baizhi\")) ④ 最后才开窗。"
      + "见 docs/login-unification-audit.md §3.2",
  )

  const COOKIES = {
    "auth-store": "sl-session=store; baizhi_session=store",
    desktop: "sl-session=desktop; baizhi_session=desktop",
    profile: "sl-session=profile; baizhi_session=profile",
    window: "sl-session=window; baizhi_session=window",
  }
  const cookieOf = (value) => (typeof value === "string" ? value : value?.cookie)

  // 造一组按名字记账的替身来源；`available` 决定哪些来源「有会话」。
  const sourcesFor = (available) => {
    const calls = []
    const sources = ["auth-store", "desktop", "profile", "window"].map((name) => ({
      name,
      async read() {
        calls.push(name)
        return available.includes(name) ? COOKIES[name] : undefined
      },
    }))
    return { calls, sources }
  }

  // 全都有 → 必须停在第一个（账号库），后面三个一次都不许碰。
  {
    const { calls, sources } = sourcesFor(["auth-store", "desktop", "profile", "window"])
    assert.equal(cookieOf(await resolve(sources)), COOKIES["auth-store"])
    assert.deepEqual(calls, ["auth-store"], `有账号库来源时不该继续读后面的：${JSON.stringify(calls)}`)
  }
  // 账号库空 → 用桌面客户端，profile 与窗口都不碰。
  {
    const { calls, sources } = sourcesFor(["desktop", "profile", "window"])
    assert.equal(cookieOf(await resolve(sources)), COOKIES.desktop)
    assert.deepEqual(calls, ["auth-store", "desktop"])
  }
  // 账号库 + 桌面都空 → 用持久 profile（静默，不弹窗）。
  {
    const { calls, sources } = sourcesFor(["profile", "window"])
    assert.equal(cookieOf(await resolve(sources)), COOKIES.profile)
    assert.deepEqual(calls, ["auth-store", "desktop", "profile"])
  }
  // 三个复用来源全空 → 这时才允许开窗，且只开一次。
  {
    const { calls, sources } = sourcesFor(["window"])
    assert.equal(cookieOf(await resolve(sources)), COOKIES.window)
    assert.deepEqual(calls, ["auth-store", "desktop", "profile", "window"], "顺序必须固定为 账号库 → 桌面 → profile → 开窗")
  }
  // 一个来源都没有 → 返回假值（调用方据此给出「用桌面版登录一次」之类的说明）。
  {
    const { sources } = sourcesFor([])
    const got = await resolve(sources)
    assert.ok(got === undefined || got === null || cookieOf(got) === undefined, `全空时应返回空值，实际：${JSON.stringify(got)}`)
  }
})

// ═══════════════════════════════════════════════════════════════════
// 保留的既有契约（改造不得破坏）
// ═══════════════════════════════════════════════════════════════════

test("入口只导出三个插件工厂和测试对象", () => {
  const functions = Object.entries(entry)
    .filter(([, value]) => typeof value === "function")
    .map(([key]) => key)
    .sort()
  assert.deepEqual(functions, ["BaizhiAuthPlugin", "MonkeyCodeAuthPlugin", "MonkeyCodeIntlAuthPlugin"])
  assert.equal(typeof entry._internal, "object")
  assert.deepEqual([...entry._internal.providers], ["monkeycode", "monkeycodeintl", "baizhi"])
})

test("三个插件各自只注册自己的 provider", async () => {
  const cn = await entry.MonkeyCodeAuthPlugin({ client: {} })
  const intl = await entry.MonkeyCodeIntlAuthPlugin({ client: {} })
  const bz = await entry.BaizhiAuthPlugin({ client: {} })
  assert.equal(cn.auth.provider, "monkeycode")
  assert.equal(intl.auth.provider, "monkeycodeintl")
  assert.equal(bz.auth.provider, "baizhi")
  // MonkeyCode 两站是同一产品，共用一张图标；百智云是另一家，图标必须不同。
  assert.equal(cn.auth.icon, intl.auth.icon)
  assert.notEqual(cn.auth.icon, bz.auth.icon)
  assert.match(cn.auth.icon, /^data:image\/svg\+xml;base64,/)

  const cfg = { provider: {} }
  await cn.config(cfg)
  await intl.config(cfg)
  await bz.config(cfg)
  assert.deepEqual(Object.keys(cfg.provider).sort(), ["baizhi", "monkeycode", "monkeycodeintl"])
  assert.equal(cfg.provider.monkeycode.api, "https://proxy.monkeycode-ai.com/v1")
  assert.equal(cfg.provider.monkeycodeintl.api, "https://proxy.monkeycode-ai.net/v1")
  assert.equal(cfg.provider.baizhi.api, "https://ai-models.app.baizhi.cloud/api/anthropic/v1")
  // 模型数取决于「平台目录缓存有没有落盘」：内置快照 4 条是兜底，
  // 登录后拉到的是**这个账号的**真实目录（平台按权限给，国际站实测 4 条）优先。
  // 这里只要求非空、且不写死具体数字。
  assert.ok(Object.keys(cfg.provider.monkeycode.models).length >= 4)
  // 兜底**不许带档位前缀**：basic / pro / ultra 三档各一条会让账号看到自己调不了的
  // 模型（用户原话：「basic 额度 pro 额度 ultra 额度还有积分计费，怎么这么多」）。
  for (const id of Object.keys(cfg.provider.monkeycode.models)) {
    assert.equal(
      /^monkeycode-(basic|pro|ultra)-/.test(id),
      false,
      `内置快照不该列档位条目：${id}`,
    )
  }
  assert.equal(Object.keys(cfg.provider.baizhi.models).length, 15)
})

test("模型 id 里不许有斜杠：magpie 会把 <a>/<b> 读成「provider a 的模型 b」", async () => {
  const cfg = { provider: {} }
  for (const [, factory] of FACTORIES) {
    await (await factory({ client: {} })).config(cfg)
  }
  for (const [providerId, provider] of Object.entries(cfg.provider)) {
    for (const [modelId, model] of Object.entries(provider.models)) {
      assert.ok(!modelId.includes("/"), `${providerId}/${modelId} 的 id 含斜杠，会被 magpie 拆成幽灵 provider`)
      assert.equal(model.id, modelId, `${providerId}/${modelId}: id 字段要与键一致`)
      // 带 apiId 的模型：api.id 必须指回上游真实 id（MonkeyCode 是设备 UUID，
      // 百智云的远端目录是带斜杠的命名空间）。判据只看「指回去了」。
      if (model.apiId !== undefined) {
        assert.ok(model.apiId.length > 0, `${providerId}/${modelId}: apiId 不能为空`)
        assert.equal(model.api.id, model.apiId)
      }
    }
  }
})

test("两区共享协议，差异只留在站点适配器", async () => {
  assert.equal(typeof _internal.makePlugin, "function")
  assert.equal(typeof _internal.configModels, "function")
  assert.equal(SITES.monkeycode.platformBaseUrl, "https://monkeycode-ai.com")
  assert.equal(SITES.monkeycodeintl.platformBaseUrl, "https://monkeycode-ai.net")
  assert.equal(SITES.monkeycode.sessionCookie, SITES.monkeycodeintl.sessionCookie)
  // 共享 runtime 里不许按域名写分支（站点差异只能在 sites.mjs）。
  const runtime = await readFile(new URL("../src/monkeycode/runtime.mjs", import.meta.url), "utf8")
  assert.doesNotMatch(runtime, /monkeycode-ai\.(com|net)/)
})

test("chat.headers 只标记自己的 provider", async () => {
  const cn = await entry.MonkeyCodeAuthPlugin({ client: {} })
  const intl = await entry.MonkeyCodeIntlAuthPlugin({ client: {} })
  const bz = await entry.BaizhiAuthPlugin({ client: {} })
  const mine = { headers: {} }
  await cn["chat.headers"]({ model: { providerID: "monkeycode" }, sessionID: "s1" }, mine)
  assert.equal(mine.headers["x-monkeycode-session"], "s1")
  const other = { headers: {} }
  await intl["chat.headers"]({ model: { providerID: "monkeycode" }, sessionID: "s1" }, other)
  assert.deepEqual(other.headers, {})
  const third = { headers: {} }
  await bz["chat.headers"]({ model: { providerID: "baizhi" }, sessionID: "s2" }, third)
  assert.equal(third.headers["x-baizhi-session"], "s2")
})

// ═══════════════════════════════════════════════════════════════════
// ⑨ 目录升级：当前目录是权威整体，宿主旧 provider.models 不得合并回来
// ═══════════════════════════════════════════════════════════════════

const MONKEYCODE_FACTORIES = [
  ["monkeycode", entry.MonkeyCodeAuthPlugin],
  ["monkeycodeintl", entry.MonkeyCodeIntlAuthPlugin],
]

const UPGRADE_NAMES = {
  "monkeycode-basic-glm-5-3-flash": "GLM-5.3-Flash · 免费",
  "monkeycode-basic-deepseek-flash": "DeepSeek-Flash · 免费",
  "qwen3-6-plus": "Qwen3.6-Plus · 积分",
}

const BUILTIN_NAMES = {
  "deepseek-flash": "DeepSeek-Flash · 积分",
  "deepseek-v4-flash": "DeepSeek-V4-Flash · 积分",
  "deepseek-v4-pro": "DeepSeek-V4-Pro · 积分",
  "glm-5": "GLM-5 · 积分",
}

/** 旧宿主持久化的 13 条，再加一条当前目录里从未有过的 stale。 */
function legacyProviderModels() {
  const currentIds = Object.keys(UPGRADE_NAMES)
  const models = {}
  for (let index = 0; index < 13; index += 1) {
    const id = currentIds[index] ?? `legacy-${index}`
    models[id] = { id, name: `Legacy-${index} · 基础档`, status: "active" }
  }
  models["stale-extra"] = { id: "stale-extra", name: "Stale · 基础档", status: "active" }
  assert.equal(Object.keys(models).length, 14, "夹具必须是旧 13 条 + 额外 stale 1 条")
  return models
}

/** 5 条旧缓存：pro 被档位过滤、积分孪生被去重，最终只剩 3 条；displayName 全是旧文案。 */
function legacyCatalogModels() {
  return [
    {
      id: "monkeycode-basic-glm-5-3-flash",
      apiId: "monkeycode-basic/glm-5.3-flash",
      name: "monkeycode-basic/glm-5.3-flash",
      displayName: "GLM-5.3-Flash · 基础档",
      context: 200000,
      output: 32000,
      image: false,
      free: false,
    },
    {
      id: "monkeycode-pro-hy3",
      apiId: "monkeycode-pro/hy3",
      name: "monkeycode-pro/hy3",
      displayName: "HY3 · 专业档",
      context: 200000,
      output: 32000,
      image: false,
      free: false,
    },
    {
      id: "deepseek-flash",
      apiId: "deepseek-flash",
      name: "deepseek-flash",
      displayName: "DeepSeek-Flash · 旧积分名",
      context: 200000,
      output: 32000,
      image: false,
      free: false,
    },
    {
      id: "monkeycode-basic-deepseek-flash",
      apiId: "monkeycode-basic/deepseek-flash",
      name: "monkeycode-basic/deepseek-flash",
      displayName: "DeepSeek-Flash · 基础档",
      context: 200000,
      output: 32000,
      image: false,
      free: false,
    },
    {
      id: "qwen3-6-plus",
      apiId: "qwen3.6-plus",
      name: "qwen3.6-plus",
      displayName: "Qwen3.6-Plus · 旧积分名",
      context: 200000,
      output: 32000,
      image: false,
      free: false,
    },
  ]
}

/** 在临时目录隔离 catalog；恢复全部改动过的 env，HOME 始终保持本文件的假 HOME。 */
async function withCatalogFixture(siteId, models, fn) {
  const dir = mkdtempSync(join(tmpdir(), `magpie-${siteId}-upgrade-`))
  const previousCache = process.env.MAGPIE_MONKEYCODE_CACHE_DIR
  const previousTwinOptOut = process.env.MAGPIE_MONKEYCODE_SHOW_CREDIT_TWINS
  try {
    assert.equal(process.env.HOME, FAKE_HOME, "测试不得切到真实 HOME")
    assert.equal(process.env.USERPROFILE, FAKE_HOME, "测试不得切到真实 USERPROFILE")
    process.env.MAGPIE_MONKEYCODE_CACHE_DIR = dir
    delete process.env.MAGPIE_MONKEYCODE_SHOW_CREDIT_TWINS
    if (models !== undefined) {
      writeFileSync(
        join(dir, `monkeycode-models-${siteId}.json`),
        `${JSON.stringify({ fetchedAt: 1, tier: "basic", models }, null, 2)}\n`,
      )
    }
    await fn()
  } finally {
    if (previousCache === undefined) delete process.env.MAGPIE_MONKEYCODE_CACHE_DIR
    else process.env.MAGPIE_MONKEYCODE_CACHE_DIR = previousCache
    if (previousTwinOptOut === undefined) delete process.env.MAGPIE_MONKEYCODE_SHOW_CREDIT_TWINS
    else process.env.MAGPIE_MONKEYCODE_SHOW_CREDIT_TWINS = previousTwinOptOut
    rmSync(dir, { recursive: true, force: true })
    assert.equal(process.env.MAGPIE_MONKEYCODE_CACHE_DIR, previousCache, "必须恢复 catalog cache env")
    assert.equal(process.env.MAGPIE_MONKEYCODE_SHOW_CREDIT_TWINS, previousTwinOptOut, "必须恢复积分孪生逃生阀")
    assert.equal(process.env.HOME, FAKE_HOME, "HOME 不得被目录测试改动")
    assert.equal(process.env.USERPROFILE, FAKE_HOME, "USERPROFILE 不得被目录测试改动")
  }
}

/** 两个钩子各自收到一份旧宿主表，避免 config 清掉旧表后让 provider.models 空跑。 */
async function assertAuthoritativeReplacement(factory, siteId, expectedNames) {
  const plugin = await factory({ client: {} })
  const config = { provider: { [siteId]: { models: legacyProviderModels() } } }
  await plugin.config(config)
  const fromProviderHook = await plugin.provider.models({ models: legacyProviderModels() })
  const actual = { config: config.provider[siteId].models, "provider.models": fromProviderHook }
  const expectedIds = Object.keys(expectedNames)

  assert.deepEqual(
    Object.fromEntries(Object.entries(actual).map(([hook, models]) => [hook, Object.keys(models)])),
    { config: expectedIds, "provider.models": expectedIds },
    `${siteId}：两处都必须只剩当前目录；旧 13 条与 stale-extra 不得复活`,
  )
  for (const [hook, models] of Object.entries(actual)) {
    for (const [id, name] of Object.entries(expectedNames)) {
      assert.equal(models[id].id, id, `${siteId} ${hook}/${id}：id 必须与键一致`)
      assert.equal(models[id].name, name, `${siteId} ${hook}/${id}：旧 displayName 必须重算`)
    }
  }
  assert.deepEqual(fromProviderHook, config.provider[siteId].models, `${siteId}：两个钩子必须返回同一份权威目录`)
}

for (const [siteId, factory] of MONKEYCODE_FACTORIES) {
  test(`目录升级 ${siteId}：缓存 5→3，config 与 provider.models 都整体替换旧 13+stale`, async () => {
    await withCatalogFixture(siteId, legacyCatalogModels(), async () => {
      await assertAuthoritativeReplacement(factory, siteId, UPGRADE_NAMES)
    })
  })

  test(`目录升级 ${siteId}：无缓存时 builtin 4 条也整体替换旧宿主表`, async () => {
    await withCatalogFixture(siteId, undefined, async () => {
      await assertAuthoritativeReplacement(factory, siteId, BUILTIN_NAMES)
    })
  })
}
