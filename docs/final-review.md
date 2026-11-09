# 独立验收报告 · 登录面收敛 / 双邀请 / 自动开通（0.2.42）

> **后续结论已更新**：R2 独立复审为 **verdict: pass，blocker=0，high=0**，并正式撤回本报告 M1 的误报。本文仅保留为首轮审查历史，不要把其中 H1/M1-M6 当成当前未修项。最终结论与证据见 [final-review-r2.md](./final-review-r2.md)。

> 审核人：`final-reviewer`（独立验收专员，非实现者）
> 审核对象：工作区未提交改动（`git status` 12 改 8 增）+ 新增 `src/monkeycode/provision.mjs`、`tests/provision.test.mjs`、`tests/invite-url.test.mjs`、4 份 `docs/`。
> 审核日期：2026-11-09
> 本报告是唯一写入路径；`src/**`、`tests/**`、`package.json`、`README.md`、`CHANGELOG.md` 全程只读。
> 未提交、未打 tag、未推送、未安装、未 `npm publish`、未重启、未读写任何真实凭证。

---

## 0. 结论

**verdict: pass（可以进入交付流程），但有 1 个 high 建议在合并前修掉。**

- 8 项验收点全部**做出来了**，且四道门禁全绿（309/309、49 通过、privacy PASS、pack 正常）。
- 我用 31 条**自己写的变异**证明测试不是空跑：22 条真红、**9 条漏网**（§5）。漏网的 9 条里
  1 条是安全相关的（返回值脱敏无回归测试）、1 条正是 0.2.42 声称修复的「窗口一开就算登好」那个 bug 的接线、
  1 条是用户可见的旧缓存文案重算。它们都不是「功能没做」，而是**没有测试守着**，属于「下次谁改回去没人知道」。
- 唯一 high 是**新引入的真实行为回归风险**：百智云登录窗口在用户还没登完时，`accept()` 每秒对上游发一次
  `GET /api/console/api-keys`；在「上游建 Key 成功但报文里没有可用 `api_key`」的形态下，会**每秒 POST 建一把新 Key**
  （§4-H1，可复现）。
- 未验（本次不可能验）：真机 `client.auth.set` 落盘、magpie 宿主源码逐行、安装 / 打 tag / 发布。
  这三项是 t16 的「未证实」清单 R1-R3 的延续，本报告**不把它们升格为已验证**。

| 严重度 | 条数 | 是否阻塞交付 |
|---|---|---|
| blocker | 0 | — |
| high | 1 | 建议合并前修（H1） |
| medium | 6 | 可带债交付，但应有跟踪项 |
| low | 7 | 记录即可 |

---

## 1. 审了什么 / 怎么审的

### 1.1 审核内容（按任务书的 8 条）

| # | 验收点 | 结论 | 证据 |
|---|---|---|---|
| 1 | 三家登录方法 1/4/2；五种登录方式不自动点；国际版隔离 | ✅ | §3.1 公开实例化输出；`grep -c LOGIN_AUTOPILOT` = 0（已删除自动点脚本） |
| 2 | 百智云两条成功路径都触发自动 provision 且不 await、失败隔离、当次 cookie 不串、identity 一致 | ✅ | `src/baizhi/runtime.mjs:257-260`；identity 口径三处一致（§2.2） |
| 3 | provision 坏库 / uid 空 / 缺凭据不写；`monkeycodeintl` 前缀不吞；同 uid 更新；多账号不覆盖；回读比 access+refresh；单飞；成功才台账 | ✅ | 11 条变异全部真红（P1-P11）；`src/monkeycode/provision.mjs:112,130-141,173-178,276-293` |
| 4 | 双邀请字段各自 store 与 URL；仅首次注册；无新按钮 | ✅ | `src/baizhi/runtime.mjs:49-63,678-710`；`src/sites.mjs:116-160`；变异 B5/B8/B10 真红 |
| 5 | 匿名 cookie 与建 Key 重试 | ⚠️ | `needsKeyCreation` 的「取走即删」正确（B9 真红），**但轮询侧无负缓存 → H1** |
| 6 | 模型去重 / 名称 / 旧缓存 / env 边界 | ✅（有 1 个 medium 测试缺口） | §3.3 实测；变异 C2 真红、C1 漏网（M6） |
| 7 | 文档无未完成占位、版本 0.2.42 一致、无隐私 | ⚠️ | 版本一致、privacy 0 处；**但 `docs/automatic-credential-reuse.md` 有 5 处过期表述（M5）** |
| 8 | 进程 / 浏览器孤儿风险；测试是否假绿 | ⚠️ | 变异 22 红 9 绿（§5）；**`openPage` 的 WebSocket 失败路径漏 `close()`（M4）** |

### 1.2 我没做什么（防「审核 = 复述测试」）

- 没有引用 t16-t22 的报告当结论：所有 ✅ 都是我自己跑出来的（命令与输出见 §3）。
- 没有读真实凭证、没有连真实上游、没有起真实 Chromium；`MAGPIE_PLUGIN_DISABLE_BROWSER=1` 全程生效。
- 变异测试在 `%TEMP%\mut\*` 的**整仓副本**里做，仓库文件一个字节没动（`git diff --check` 无输出可证）。

---

## 2. 关键契约的独立复核

### 2.1 `auth.set` 的写安全链（读盘 → 选键 → 写 → 回读 → 台账）

逐行读 `src/monkeycode/provision.mjs`：

- **读盘闸**（`:98-122`）：`existsSync` 假 → `{ok:true, accounts:[]}`；`JSON.parse` 抛 / 顶层非对象 → `{ok:false}`。
  `ok:false` 在 `decideProvision` 里变成 `skip:"store-unreadable"`（`:135`），**一个字都不写**。
  这条是必需的：宿主在坏库时照样会写回，写回的内容只有这一次那一条（会把用户其它账号挤掉）。
- **前缀判据**（`:112`）：`key === providerId || key.startsWith(\`${providerId}#\`)`。改成 `startsWith(providerId)`
  立刻被 `②` 抓住（我复现了，见 §5 P1）。
- **键选择**（`:130-141`）：uid 空 → `no-uid`；同 uid → 原位那个键；裸键空 → 裸键；裸键被占 → `monkeycode#sha8(uid)`。
  后缀是 `sha256` 截断（`keySuffixOf`，`:61`），确定性 ⇒ 幂等，不是 `freshKey` 那种随机后缀。
- **写入形状**（`:153-165`）：`{type:"oauth", refresh: access, access, expires: 0, accountId?, uid?}`，
  `refresh === access` 是「宿主存不存得下」的开关（`src/credential.mjs:54-72` 的注释同源）。
- **回读四样**（`:173-178`）：`key/uid/access/refresh` 全比。只比 uid 的写法被 `⑤`/`⑤b` 抓住（P8 真红）。
- **单飞**（`:275-293`）：`sha256(cookie)[0:16]` 为键，第二个调用 `return running`；`finally` 里
  `if (inFlight.get(fingerprint) === task)` 才删 —— 不会把后来者的闸删掉。P6 真红。
- **台账**（`:236-243`）：只在回读通过**且** identity 非空后调；台账抛错只 `log` 一行，不推翻已确认的写入（P11 真红）。

**结论：写安全链是本次改动里质量最高的部分。** 11 条契约变异 11 条真红。

### 2.2 `identity` 三处口径一致（我逐个核过）

| 位置 | 取值 | 说明 |
|---|---|---|
| 自动开通写入台账 | `profile?.userId ?? exchanged.apiKey`（`src/baizhi/runtime.mjs:258`） | 百智云 profile 的 `userId` |
| 落盘凭据里的身份 | `...(profile?.userId === undefined ? {} : { user_id: profile.userId })`（`:234`） | 同上 |
| 手动路径读出来的身份 | `credential.user_id ?? credential.access_token ?? key`（`src/monkeycode/sso-import.mjs:93`） | 同上 |

两条分支都自洽：有 profile ⇒ 三处都是 `"12345"`；profile 取不到 ⇒ 凭据里没有 `user_id`，
三处都退化成 `access_token`（同一个 sk- 串）。**不会出现「自动开通登记过的号，手动路径又导一遍」。**

### 2.3 国际站隔离

- `src/baizhi/runtime.mjs` 里 `monkeycodeintl` 命中 **0** 次（`grep -c`）。
- provision 的目标是**常量** `SITES.monkeycode`（`provision.mjs:51`），调用方无法传站点进来。
- `src/monkeycode/runtime.mjs` 的两处 `site.id === "monkeycode"` 三元把国内站的四个入口关掉、把国际站的
  百智云 SSO 关掉。变异 R1（把四条旧路放回国内站）/ R2（给国际站挂 SSO）**都真红**。

---

## 3. 真实命令输出（我在本机跑的，逐字贴）

### 3.1 四道门禁

```
$ MAGPIE_PLUGIN_DISABLE_BROWSER=1 node --test
ℹ tests 309
ℹ suites 0
ℹ pass 309
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1659.3712
EXIT=0
```

```
$ node scripts/check.mjs
  ...
  通过 49 · 警告 0 · 失败 0
EXIT=0
```

```
$ node scripts/privacy-scan.mjs
privacy-scan: PASS（0 处）
EXIT=0
```

```
$ npm pack --dry-run
npm notice name: magpie-monkeycode
npm notice version: 0.2.42
npm notice filename: magpie-monkeycode-0.2.42.tgz
npm notice package size: 447.4 kB
npm notice unpacked size: 1.2 MB
npm notice shasum: b54a6f00efa651913a0bc08d028c89212403b6a1
npm notice total files: 112
EXIT=0
```

```
$ git diff --check
（无输出）
EXIT=0
```

```
$ node scripts/check-maintenance.mjs
  ✓ 是 git 仓库
  ✓ 至少打过一次 tag
  ✗ 当前版本 0.2.42 有 tag（v0.2.42）
      版本号改了但没打 tag ⇒ 用户看 Release 是空的；npm 有、git 源没有
  ✓ 自上次 tag 以来改了代码 ⇒ 版本号也跟着变了
  ✓ CHANGELOG 有 0.2.42 这一节
  ! 没有跳过版本（中间每个版本都打了 tag）
      这几个版本只 commit 没打 tag：v0.2.41
  通过 4 · 警告 1 · 失败 1
```

> 维护检查的 `失败 1` 是**纯发布态**要求（`git tag v0.2.42` + push），本任务禁做，`t22` 已如实报过。
> 它不是代码缺陷，但**「已发布」这句话现在不能写**。

### 3.2 登录面（公开实例化，零凭证、`MAGPIE_PLUGIN_DISABLE_BROWSER=1`）

```js
for (const [name, factory] of [["monkeycode", MonkeyCodeAuthPlugin],
                               ["monkeycodeintl", MonkeyCodeIntlAuthPlugin],
                               ["baizhi", BaizhiAuthPlugin]]) {
  const plugin = await factory({ client: { auth: { set: async () => ({ data: true }) } } })
  ...
}
```

```
== monkeycode (monkeycode) methods=1
  1. [oauth] MonkeyCode 猴子编程 用百智云账号开通  (ask)  prompts=["invite"]
== monkeycodeintl (monkeycodeintl) methods=4
  1. [api] MonkeyCode 国际版 API Key
  2. [oauth] MonkeyCode 国际版 账号密码登录  (ask)  prompts=["email","password"]
  3. [oauth] MonkeyCode 国际版 从本机客户端导入
  4. [oauth] MonkeyCode 国际版 浏览器登录
== baizhi (baizhi) methods=2
  1. [oauth] 百智云 BaiZhiCloud 从本机客户端导入
  2. [oauth] 百智云 BaiZhiCloud 浏览器登录  (ask)  prompts=["invite","monkeycodeInvite"]
```

1 / 4 / 2 与任务书一致；两格邀请码是**同一个方法的两个 prompt**，不是新按钮。
五种百智云登录方式（微信 / 支付宝 / 抖音 / GitHub / 观猹 + 账号密码）现在只写在 `instructions` 里
（`src/baizhi/runtime.mjs:760-773`），源码里 `LOGIN_AUTOPILOT_JS` 已删除（`grep` 0 命中）。

### 3.3 模型名（同一个工厂、`MAGPIE_MONKEYCODE_CACHE_DIR` 指向临时目录）

```
== monkeycode: 4 models
  deepseek-flash      | DeepSeek-Flash · 积分 | ctx=1048576
  deepseek-v4-flash   | DeepSeek-V4-Flash · 积分 | ctx=1048576
  deepseek-v4-pro     | DeepSeek-V4-Pro · 积分 | ctx=1048576
  glm-5               | GLM-5 · 积分 | ctx=0
== monkeycodeintl: 4 models（同上）
== baizhi: 15 models
  deepseek-v4-pro | DeepSeek V4 Pro | ctx=1048576
  ...
```

旧缓存文案重算 + 积分孪生去重（我喂了一份**旧的** `displayName: "GLM-5 · 基础档"` 缓存）：

```
readCatalog displayName: [
  'monkeycode-basic/glm-5 -> GLM-5 · 每日额度',
  'monkeycode-pro/glm-5 -> GLM-5 · 每日额度',
  'glm-5 -> GLM-5 · 积分',
  'qwen3.6-plus -> Qwen3.6-Plus · 积分'
]
filterByTier(basic): [ 'monkeycode-basic/glm-5', 'qwen3.6-plus' ]
filterByTier(pro)  : [ 'monkeycode-pro/glm-5', 'qwen3.6-plus' ]
filterByTier(undef): [4 条全在 —— 档位未知不去重，代码如此且文档如此 ]
basic + 只有 ultra 孪生: [ 'glm-5' ]   ← 没把唯一可用的那条删掉
```

`MAGPIE_MONKEYCODE_SHOW_CREDIT_TWINS=1` 的逃生阀在代码里（`catalog.mjs:345-346`）且 README/internals 都写了。

---

## 4. 缺陷清单

### 🔴 blocker

无。

### 🟠 high

#### H1 · `accept()` 没有负缓存：登录窗口开着时每秒打一次上游，`needsKeyCreation` 形态下每秒 POST 建一把 Key

**位置**：`src/baizhi/runtime.mjs:314-325`（`exchangeOf`）、`:297-303`（`performExchange`）、
`:366-374`（`acceptBrowserCookie`）、`:409`（接线）；轮询在 `src/session-login.mjs:322`（`BROWSER_LOGIN_POLL_MS = 1_000`）。

**问题**：`exchangeOf` 只缓存 `result.ok === true` 的结果。`acceptBrowserCookie` 在
`browserLogin` 的循环里**每秒**被调一次（`session-login.mjs:259`），而窗口刚打开时拿到的是**匿名会话**：

```
$ node -e '连续 5 次 acceptBrowserCookie(同一份匿名 cookie, 假 fetch 计数)'
poll 1 -> false requests so far: 1
poll 2 -> false requests so far: 2
poll 3 -> false requests so far: 3
poll 4 -> false requests so far: 4
poll 5 -> false requests so far: 5
```

即：**1 请求/秒**，最长 240 秒（`BROWSER_LOGIN_TIMEOUT_MS`）→ 最多 ~240 次
`GET https://baizhi.cloud/api/console/api-keys`。改动前 `accept()` 恒 `true`，这条路**一次请求都没有**。

更严重的是 `needsKeyCreation` 分支（`exchangeSessionForKey` 在「列表空 → POST 建 Key → 报文里没有可用
`api_key`」时返回的中间态）。`exchangeOf` 不读 `pendingExchange`（这是对的，见 `:326-330` 的注释），
于是**每次轮询都会重跑一遍 `performExchange`**：

```
$ node -e '3 次 acceptBrowserCookie，假平台：GET 空列表 + POST 200 但 data 里没有 api_key'
出站请求：[
  'GET /api/console/api-keys',  'POST /api/console/api-keys',
  'GET /api/console/api-keys',  'GET /api/console/api-keys',
  'POST /api/console/api-keys', 'GET /api/console/api-keys'
]
POST 建 Key 次数： 3
```

**3 次轮询 = 3 次建 Key 尝试。** 只要上游「建成功了但列表还没同步」（最终一致性很常见）或
「建成功了但字段名不是 `api_key`」，用户登录的那一分钟里就会在**自己账号下静默签出几十把 `magpie` Key**。
代码自己在 `:203-206` 与 `:326-330` 把这件事列为必须避免的后果，而负缓存只做了一半。

**为什么算 high**：不是「测试没写」，是**实现有洞**。后果直接落在用户账号上（多把可用的网关 Key），
而且发生在后台、没有窗口、没有报错。

**修复建议**（小改动，不动 `finishSignIn` 的「重试必须重新请求」语义）：

1. 在 `exchangeOf` 里给**非 ok** 的结果加一个短 TTL 的负缓存（例如 `REJECT_TTL_MS = 5_000`），
   key 仍用 `${site.id}\n${cookie}`，只被 `acceptBrowserCookie` 读（**不要**让 `exchangeForSignIn` 读它，
   否则 `needsKeyCreation` 会退化成永久缓存，用户建好 Key 也恢复不了 —— 那正是 0.2.41 修复的 t8 缺陷）。
2. 或者更简单：`performExchange` 返回前先看 `pendingExchange` / 负缓存里有没有 60 秒内的同键记录，有就直接
   返回**同一份**结果（并发与串行轮询都合并）。
3. 兜底再考虑给 `browserLogin` 的 `accept` 加一个「最小重试间隔」（例如 3 秒），这样即使 TTL 写错也不会打成 1Hz。
4. 回归测试写在 `tests/multi-provider.test.mjs`：连续 3 次 `acceptBrowserCookie(同一 cookie)`，
   假 fetch 的调用计数必须 ≤ 1（对应我上面的探针）。

### 🟡 medium

#### M1 · 自动开通写出的记录 `accountId` 恒为空：`signed.nickname` 这个字段根本不存在

**位置**：`src/monkeycode/sso-import.mjs:372`（`nickname: profile?.nickname`）、
`src/monkeycode/provision.mjs:220`（`accountId: signed?.nickname ?? ""`）、`src/monkeycode/runtime.mjs:104`。

```
$ node -e 'fetchProfile(假平台返回 {code:0,data:{id:12345,name:"观猹员 0001"}})'
fetchProfile 返回的键: [ 'name', 'userId' ] | nickname = undefined
=> signInWithBaizhiSession 的 nickname 恒为 undefined
```

`fetchProfile`（`src/baizhi/credits.mjs:149-169`）返回 `{ name, userId }`，**没有 `nickname`**
（AGENTS.md 0.4 与 credits.mjs 的注释都写明「是 `name` 不是 `nickname`」）。于是：

- 自动开通写进 `plugin-auth.json` 的记录**没有 `accountId`** ⇒ magpie 卡片显示供应商名（`MonkeyCode 猴子编程`），
  而不是「观猹员 NNNN」。同一次登录手动开出来的号也一样（既有缺陷），但自动路径是新代码，且
  `provision.mjs:115` 的注释与文档都声称这里是「显示名」。
- 单测抓不到：`tests/provision.test.mjs:130,381` 的假 sso 自己塞了 `nickname: "观猹员 0001"`，
  于是契约层是绿的、真实链路是空的 —— 典型的「假绿」。

**修复**：`sso-import.mjs:372` 改 `nickname: profile?.name`（一行）。顺手在 `tests/sso-import.test.mjs`
加一条「假 profile 只有 `name` 时，`signInWithBaizhiSession` 的 `nickname` 非空」的断言。

#### M2 · 返回值脱敏没有回归测试（t19 的「实测」不是测试）

**位置**：`src/monkeycode/provision.mjs:203`（`return { ok:false, error: scrub(message) }`）、`:226`、`:231`。

我把它改成 `return { ok:false, error: message }`（**裸的、不脱敏**）后：

```
[GREEN] P15-error 不脱敏 :: 返回值脱敏 :: ℹ tests 309 / ℹ pass 309 / ℹ fail 0
```

整仓 `grep -rn "redacted" tests/` → **0 命中**。也就是说「调用方把 `result.error` 写进日志」这条
路径上的脱敏**没有任何测试**，谁改回去都不会红。这是 t19 报告里明确声称过的一条（「返回值里的 error 也脱敏」），
现在只有一次性人工实测。

**修复**：在 `tests/provision.test.mjs` 加一条：让假 sso 抛出的 error 里**包含**会话串 / `access_token`，
断言 `result.error` 与 `log` 的每一行都**不含原文**且含 `<redacted>`。

#### M3 · 百智云「读到 cookie ≠ 登录成功」的接线没有测试（0.2.42 修的那个 bug 可静默回退）

**位置**：`src/baizhi/runtime.mjs:409`（`accept: (cookie) => acceptBrowserCookie(cookie, site),`）。

变异成 `accept: async () => true,`（= 改动前的形态，也就是 CHANGELOG 里说的「窗口一开就当登好」那个真机 bug）：

```
[GREEN] B7-accept 恒 true（匿名 cookie 也算登录完成） :: ℹ tests 309 / ℹ pass 309 / ℹ fail 0
```

`acceptBrowserCookie` 本身有测试（`tests/multi-provider.test.mjs` ⑥，会红），但**没有人锁住
`startBaizhiBrowserLogin` 真的用了它**。同理 R3（`src/monkeycode/runtime.mjs:707` 的
`accept: verify` 改成 `async () => true`）也是绿的 —— 国内站那一侧的「匿名 cookie 不算登录完成」也没有接线测试。

**修复**：把 `startBaizhiBrowserLogin` 的 `accept` 从闭包里暴露成可测函数（或让它在
`MAGPIE_PLUGIN_DISABLE_BROWSER=1` 下把 `accept` 挂到返回值上），然后加两条：
「匿名会话 → `accept` 返回 false」「真会话 → true」。国内站那侧同理。

#### M4 · `openPage` 的 WebSocket 失败路径漏 `close()`：孤儿无头 Chromium + 残留临时 profile

**位置**：`src/monkeycode/sso-import.mjs:238-276`。

```js
const child = spawn(browser.path, [...])        // 已经起了进程、已经建了 mkdtemp 目录
...
const ws = new WebSocket(pageWs)
await new Promise((resolve, reject) => {        // ← 这里 reject 就直接抛出去了
  ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连不上")), { once: true })
})
```

`spawn` 之后、`return { ws, close }` 之前的任何 throw 都**不会**走到 `close()`：
`--headless=new` 的 Chromium 会留在后台（没人读它的管道），`%TEMP%\magpie-sso-*` 目录也不会被删。
`signInWithBaizhiSession:389-393` 的 `finally { ws.close(); close() }` 只覆盖它拿回 `ws` 之后的情况。

这是**既有代码**（本次 diff 只改了导航 URL 与签名），但本次改动让它在**无人值守**的路径上跑
（每次百智云登录后台自动跑一次），失败还被 `.catch(() => {})` 吞掉 —— 用户永远不会知道有一个
无头浏览器卡在那里。AGENTS.md 铁律 11 点名的正是这一类孤儿。

**修复**：把 `spawn` 之后的整段包进 `try { ... } catch (error) { close(); throw error }`，
或把 `close` 提前到 `spawn` 之后立刻定义并用 `try/finally` 覆盖整个函数体。

#### M5 · `docs/automatic-credential-reuse.md` 有 5 处过期表述（文档说「未完成」，代码已完成）

| 行 | 现在写的 | 实际 |
|---|---|---|
| `:445` | 「**需要拍板**，本文不默认采用」（B 方案：百智云登录多问一格可选码） | **已采用**（`src/baizhi/runtime.mjs:49-50,511-540` 两格） |
| `:535` | 「§5.1 的 A/B 两个处置**需要拍板**」 | 同上，已拍板并落地 |
| `:503` | `tests/host-record-contract.test.mjs`：把 §1.2 的语义抄进测试 | **该文件不存在**（`ls tests/ | grep host-record` → 空） |
| `:571` | `$ node --test → ℹ tests 280 · pass 280` | 现为 **309** |
| `:585` | 「再过 §6.5 的 **7 个**变异」 | t17 自己列了 8 条，我另加 31 条（§5） |

另外 `:583` 的施工步骤写「`existingAccountWithUid` 改为调用 `readProvisionedAccounts`（去重口径只留一处）」，
**没有做**：`src/monkeycode/runtime.mjs:52-61` 仍是自己 `readFileSync` + 自己写一遍
`key === providerId || key.startsWith(...)`（见 L4）。

**这是「文档里出现未完成态」的典型**：一份**已定稿**的契约文档，正文还在用将来时描述已经发生的事，
后来的人无法判断「B 到底批没批」。**修复**：把这 5 处改成完成时（或加一行「§5.1-B 已于 0.2.42 采用」），
把 `host-record-contract.test.mjs` 那句改成「未单独建文件，宿主语义锁由 `tests/provision.test.mjs` 的
⑤b/⑦b/⑨ 覆盖」（或真的补上那个文件）。

#### M6 · 旧缓存 `displayName` 重算没有测试（CHANGELOG 里的用户可见承诺）

**位置**：`src/monkeycode/catalog.mjs:233-238`。

变异成「直接把缓存里的 `displayName` 返回」（= 改动前的行为）：

```
[GREEN] C1-旧缓存里的 displayName 不重算 :: 旧缓存标签重算 :: ℹ tests 309 / ℹ pass 309 / ℹ fail 0
```

`tests/catalog.test.mjs:71-73` 只锁了 `entryOf()`（写缓存那条路），**没有**锁 `readCatalog()` 的读时重算。
而 CHANGELOG 明确向用户承诺「旧缓存里的『基础档 / 专业档 / 旗舰档』读出来会自动按当前口径重算，不用重拉目录」。
我手工验证过它**确实работает**（§3.3），但**没有测试守着**。

**修复**：`tests/catalog.test.mjs` 加一条：`writeFileSync` 一份 `displayName: "GLM-5 · 基础档"` 的缓存 →
`readCatalog()` 返回的 `displayName === "GLM-5 · 每日额度"`。

### 🟢 low

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| L1 | `src/monkeycode/provision.mjs:215-222` | **TOCTOU 窗口**：`readProvisionedAccounts()` 与 `client.auth.set()` 之间没有互斥。同一进程里两个**不同 cookie**（两个百智云账号）并发开通时，两边都读到「裸键空着」，后写的那次会覆盖先写的（单飞只按 cookie 去重，管不到这种情况） | 加一个**模块级串行队列**（所有 provision 排一条队），或在 `decideProvision` 之后、`auth.set` 之前重读一次并核对裸键是否仍空 |
| L2 | `src/monkeycode/provision.mjs:268-272` | 三个前置闸（`no-client` / `no-sso` / `aborted`）**只断言了 `ok:false`，没断言 `skipped` 原因**。去掉任何一个，测试仍然全绿（P12/P13/P14） | 测试改成 `assert.equal(result.skipped, "no-client")` 等；否则「少传 client 时会先跑完一次完整 SSO 才失败」这件事没人守 |
| L3 | `src/monkeycode/runtime.mjs:707`、`:603-615` | R3（国内站 `accept: verify` 改恒 true）、R4（`inviteStore.write(inviteCode)` 删掉）都**没有测试**（我跑出来是绿的） | 同 M3；R4 用临时 `USERPROFILE` 断言策略文件被写 |
| L4 | `src/monkeycode/runtime.mjs:52-61` vs `src/monkeycode/provision.mjs:111-112` | 前缀判据（毒点）**重复两处**，且文档 §8.2-2 声称已合并到一处 | 让 `existingAccountWithUid` 调 `readProvisionedAccounts`，或把判据抽成 `sso-import.mjs` 的一个导出 |
| L5 | `README.md:232-235` + `package.json` 的 `files` | README 链接了 4 份 `docs/*.md`，但 `npm pack` 的 112 个文件里 **`docs/` 一个都没有**（`npm pack --dry-run \| grep -c "docs/"` → 0）。npm 安装的用户点这 4 个链接全是 404（git 源安装不受影响） | `files` 加 `"docs"`，或把链接换成 GitHub 绝对 URL |
| L6 | `tests/*.test.mjs:2`（8 个文件） | `process.env.MAGPIE_MONKEYCODE_CACHE_DIR = "C:\__magpie_test_cache__"` —— 未转义反斜杠，实际值是 **`C:__magpie_test_cache__`**（驱动器相对路径）。目前没造成落盘（目录不存在），但这条夹具写的不是它看起来的路径 | 改成 `join(tmpdir(), "__magpie_test_cache__")` 或双反斜杠（**既有问题**，不是本次 diff 引入） |
| L7 | `src/monkeycode/catalog.mjs:141,43-47` | `MAGPIE_MONKEYCODE_CONTEXT_FLOOR` 与 `MAGPIE_MONKEYCODE_CACHE_DIR` 两个环境变量**没有任何文档**（`grep` README/docs → 0）。前者会改变所有模型的上下文窗口声明 | 在 README 的「模型」小节各加一行（**既有问题**） |

---

## 5. 我独立做的变异测试（证明「不是空跑」）

在 `%TEMP%\mut\base`（整仓副本）上逐条改源码、跑**全量** `node --test --test-timeout=20000`，
再复原。31 条里 **22 红 / 9 绿**：

| 变异 | 应该红的契约 | 结果 |
|---|---|---|
| P1 前缀判据 `startsWith(providerId)` | 读盘只认 `monkeycode` / `monkeycode#` | 🔴 `✖ ②` |
| P2 永远写裸键 | 多账号不覆盖 | 🔴 `✖ ③c` `✖ ④b` |
| P3 写完不回读 | 回读校验 | 🔴 `✖ ⑤` `✖ ⑤b` |
| P4 去掉 uid 闸 | uid 空不写 | 🔴 `✖ ③` `✖ ⑩b` |
| P5 去掉坏库闸 | 坏库不写 | 🔴 `✖ ③b` |
| P6 去掉单飞 | 单飞 | 🔴 `✖ ⑥` |
| P7 `refresh` 不等于 `access` | 记录形状 | 🔴 `✖ ①` |
| P8 回读只比 uid | 回读比 access+refresh | 🔴 `✖ ⑤` |
| P9 去掉测试门闩 | 测试门闩 | 🔴 `✖ ⑦c` |
| P10 去掉凭据完整性闸 | 缺凭据不写 | 🔴 `✖ ⑩c` |
| P11 不写台账 | 成功才台账 | 🔴 `✖ ⑧` `✖ ⑨` |
| **P12 去掉 `no-client` 闸** | 缺 client 不写 | 🟢 **漏网**（L2） |
| **P13 去掉 `no-sso` 闸** | 缺 sso 不写 | 🟢 **漏网**（L2） |
| **P14 去掉 `aborted` 闸** | 取消不留副作用 | 🟢 **漏网**（L2） |
| **P15 `result.error` 不脱敏** | 返回值脱敏 | 🟢 **漏网**（M2） |
| B1 `void provision(...)`（不包微任务） | 失败隔离 | 🔴 `✖ 自动开通是 fire-and-forget` |
| B2 完全不触发 provision | 两条成功路径都触发 | 🔴 `✖ 自动开通：finishSignIn 成功时…` |
| B3 改成 `await provision(...)` | 不 await | 🔴 `✖ fire-and-forget`（20s 超时） |
| B4 `identity = ""` | identity 一致 | 🔴 `✖ 自动开通：finishSignIn 成功时…` |
| B5 自动开通不带 inviteCode | 带国内站邀请码 | 🔴 `✖ 自动开通接线：两条成功路径…` |
| **B6 去掉 `site.id === "baizhi"` 守卫** | 百智云守卫 | 🟢 **漏网**（死代码：`finishSignIn` 只有百智云用） |
| **B7 `accept` 恒 true** | 匿名 cookie 不算登录完成 | 🟢 **漏网**（M3） |
| B8 两格邀请码写同一个 store | 双邀请各自 store | 🔴 `✖ 两格可选邀请码…` |
| B9 `finishSignIn` 每次重新兑换 | 同一次登录只兑换一次 | 🔴 `✖ 重试只该列一次 Key…` |
| B10 只问一格邀请码 | 双邀请两格 | 🔴 `✖ 两格可选邀请码…` |
| R1 国内站恢复四条旧登录路 | 国内站只留一条 | 🔴 `✖ 登录面…` |
| R2 国际站也挂百智云 SSO | 国际版保持独立 | 🔴 `✖ 登录面…` |
| **R3 国内站 `accept` 恒 true** | 匿名 cookie 不算登录完成 | 🟢 **漏网**（M3） |
| **R4 邀请码不落盘** | 邀请码各自策略文件 | 🟢 **漏网**（L3） |
| **C1 旧缓存 displayName 不重算** | 旧缓存标签重算 | 🟢 **漏网**（M6） |
| C2 不做积分孪生去重 | 模型去重 | 🔴 `✖ ②` `✖ ③` |

**怎么读这张表**：

- 写入安全（P1-P11）**一条都没漏**，这是本次改动最硬的部分，t17 的「8 个变异全红」我复现并扩到 11 条。
- 接线层（B/R）漏 4 条：**漏的都是「接线」而不是「逻辑」** —— 函数本身有测试，但「谁调它」没有。
- 漏网的 9 条里，M2（脱敏）与 M3（0.2.42 声称修复的那个 bug 的接线）我建议**合并前补上**，其余可以带债。

---

## 6. 未验清单（这些结论**不能**从本报告读出来）

| # | 项 | 为什么没验 | 谁来验 / 怎么验 |
|---|---|---|---|
| U1 | 真机上 `client.auth.set({path:{id},body})` 真的把记录写进 `~/.config/magpie/plugin-auth.json` | 需要真 magpie 宿主 + 真账号；本机 magpie 是编译后的 `magpie.exe`，宿主 `host.js` 源码不可读（`Programs/magpie` 下只有二进制）。t16 引用的 `host.js:1037/1120/1135/2456` 我**无法独立复核** | 真机探针（t16 的 R1）：登录百智云 → `grep -c '"monkeycode"' ~/.config/magpie/plugin-auth.json`，只读一次、不打印内容 |
| U2 | magpie 收到 `{event:"auth"}` 后会不会重跑插件工厂 | 同上（客户端 RPC 不在源码里） | 看 `app.log` 里插件加载次数；若会重跑，provision 的模块级单飞表会失效（每次重跑都是新模块实例） |
| U3 | 百智云控制台 `POST /api/console/api-keys` 在「列表为空」时的真实行为（建 Key 的字段名、最终一致性窗口） | 会写真实账号，任务禁做 | 真机只读探测（H1 的严重度取决于它） |
| U4 | 五种百智云登录方式（微信 / 支付宝 / 抖音 / GitHub / 观猹）真机都能登完并换出 Key | 需要真人扫码 | 真机逐种点一次，看 `finishSignIn` 是否 `type:"success"` 且 `uid` 是**这一次**的账号 |
| U5 | 邀请码在**真实上游**上确实被消费（`inviter_id` 生效） | 会消耗真实邀请关系 | 用一个测试号开一次，看上级是否到账 |
| U6 | 安装 / 打包后的真实行为（`npm pack` 只预演了文件清单） | 本任务禁安装、禁发布 | 发布门 2：`release.mjs --yes` 后再走 CHECKLIST B 表五条 |
| U7 | `check-maintenance.mjs` 的 `失败 1`（当前版本无 tag） | 需要 `git tag` + `git push`，本任务禁做 | 发布负责人 |
| U8 | 国际站的模型目录 / 登录链 | 本次改动对国际站是「一行没动」+ 一条 `site.id` 三元；但**没有**真机国际站账号 | 真机国际站登录一次，看 `/v1/models` 里有 `monkeycodeintl` |

---

## 7. 复核建议（给 captain 的下一步）

1. **合并前**：修 H1（负缓存 + 回归测试）、M1（`nickname` → `name`，一行）、M2（脱敏回归测试）。
   三条加起来 < 30 行，但 M1/H1 都是**用户账号上可见**的。
2. **合并前**：把 M5 的 5 处文档改成完成时 —— 一份「已定稿」的契约文档里留着「需要拍板」，
   下一个读它的人会以为 B 方案没批。
3. **可以带债**：M3 / M4 / M6、L1-L7 记进 CHANGELOG 的「已知未做」或单独开 issue；M4 建议顺手修（`try/finally` 两行）。
4. **发布前必须做**：U1 / U2 的真机探针（t16 的 R1/R2），然后才允许在 CHANGELOG 里写「已真机验证」。
   当前 `check-maintenance.mjs` 是 `失败 1`，**现在不能说「已发布」**。
5. 我没有修改任何源码 / 测试 / 断言，也没有放松任何一条（本报告是唯一写入）。

---

## 8. 一句话总结

**登录面收敛、双邀请、自动开通三条主线都真的做出来了，写安全链（读盘 → 选键 → 写 → 回读 → 台账）经 11 条变异
全部真红，是本仓库少见的扎实实现。** 剩下的是一个**新引入的轮询放大**（H1：1 请求/秒，`needsKeyCreation`
形态下 1 次建 Key/秒）和两个**「声称修了但没测试守着」**（M2 脱敏、M3 匿名 cookie 接线），
再加上 5 处文档过期。修完这三类，这次交付就可以进发布门 2。
