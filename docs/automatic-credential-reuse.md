# 自动凭证复用契约（百智云登录成功 → 国内 MonkeyCode 自动开通）

> **用户要求（2026-11-09 原话）**：百智云登录或本机导入成功后，**自动开通并写入对应的国内
> MonkeyCode 账号**，像华为云插件一样，不再要求用户第二次点击。
>
> 本文是**只读审计 + 最小可施工设计**，不实现任何代码（本任务写作用域只有本文件）。
> 所有结论分两档：**已证实**（当场跑得出的命令 / 读得到的源码行）与**未证实**（列出判据与探针）。
>
> 取证时间 2026-11-09。工作区 `D:\DeepSeek Harness\反代\monkey code\magpie-monkeycode`；
> 参考插件 `D:\DeepSeek Harness\反代\magpie-officeace`。

---

## 0. 结论摘要

| # | 问题 | 结论 |
|---|---|---|
| 1 | `auth.set` 能写吗、参数是什么 | **能**。`client.auth.set({ path: { id }, body })`，`body` **整体替换**、不合并；键是 `<provider>` 或 `<provider>#<slot>`。**已证实**（宿主源码 + 假宿主探针 13/13） |
| 2 | 两条成功路径怎么接 | 百智云的「浏览器登录」与「从本机客户端导入」**都汇到同一个 `finishSignIn()`**（`src/baizhi/runtime.mjs:179`），只在那一处挂钩子即可覆盖两条。**已证实**（`grep -n "finishSignIn(" ` 只有 179 定义 + 560/670 两处调用） |
| 3 | 启动时要不要补开 | **不要默认补开**。三条否决理由见 §4；若要做，只能"每进程一次 + 台账闸 + 只读本地判据 + 绝不进 `config`/`models` 的返回路径" |
| 4 | 防覆盖 / 防重复 / 失败隔离 / 国际站 | 键选择必须先读盘（裸键空着才用裸键，否则 `monkeycode#<sha8(uid)>`）；`uid` 为空一律不写；写是 fire-and-forget；目标 provider 是**常量** `SITES.monkeycode` |
| 5 | 邀请码会不会被绕过 | 自动路径只调 `signInWithBaizhiSession(cookie, SITES.monkeycode, { inviteCode })`，`inviteCode` 取自 `createInviteStore("monkeycode").read()` —— 与手动路径**同一个策略文件、同一个拼 URL 函数**；百智云那份 `baizhi-invite.json` 永不参与 |
| 6 | 怎么测 | 三档可测点：纯函数（键/记录体/决策）、注入式（`sso` 用假函数，不碰 CDP）、mock `client`（断言 `set` 的键与 body）。清单见 §6 |

**施工面（已落地，3 个生产文件）**

```
新增  src/monkeycode/provision.mjs      4 个纯函数 + 1 个异步入口（含写事务串行化与两层脱敏）
改    src/baizhi/runtime.mjs           吃 ctx.client、finishSignIn 挂钩子、callback 收 signal、两格邀请输入
改    src/monkeycode/sso-import.mjs     markImported 导出（台账与手动路径同源）
```

**当前状态：`client.auth.set` 已在 `src/monkeycode/provision.mjs` 落地**
（`grep -rn "auth\.set" --include=*.mjs src/ index.mjs tests/ | wc -l` → `11`，含测试），
两个插件工厂已改成吃 `ctx`（`src/baizhi/runtime.mjs` 的 `makeBaizhiPlugin()` 取 `ctx?.client`）。
回归面：`tests/provision.test.mjs` 30 条、`tests/multi-provider.test.mjs` 27 条、全量 330 条。

---

## 1. 取证：本机 magpie 宿主到底给了什么

### 1.1 取证对象可核验

宿主把它的 `plugin-host` 源码解到缓存目录，文件名就是**内容 sha256 的前 12 位**：

```
$ ls -la ~/.cache/magpie/plugin-host/
-rw-r--r-- 1 ... 145653 Nov  4 23:53 host-4a981f88f87c.js     ← 当前在跑的这一份
$ sha256sum host-4a981f88f87c.js | cut -c1-16
4a981f88f87c8b08                                              ← 与文件名一致
```

本文所有宿主行号都指 **`~/.cache/magpie/plugin-host/host-4a981f88f87c.js`**（145653 字节）。
旁证：`magpie.exe`（2026-11-04 23:52）里 grep 得到同一份源码文本；运行中的网关
`GET http://127.0.0.1:3425/api/version` → `{"version":"0.12.6"}`（只读 GET）。

> **已证实**：这份文件与本机实际运行的那一份**逐字节相同**（sha256 前缀 = 文件名；
> 与 `D:\DeepSeek Harness\反代\马威斯\investigation\magpie-isolated\cache\magpie\plugin-host\host-4a981f88f87c.js` `diff` 无差异）。
> **未证实**：`0.12.6` 是不是"稳定渠道"要跟的那个版本号（那是发布口径问题，与本文无关）。

### 1.2 `client.auth.set` 的精确契约

源码：`host-4a981f88f87c.js:1198-1225`

```js
set: async (opts) => {
  const id   = opts?.path?.id ?? opts?.id ?? opts?.providerID   // 1202：三种取值都认
  const body = opts?.body   ?? opts?.auth                        // 1203
  if (typeof id === "string" && body && typeof body === "object") {
    const key = keyFor(id)                                       // 1206：scope 感知（见下）
    const s   = scope.getStore()
    const had = s?.provider === id && s.had                       // 1208：只有"写自己 scope 的 provider"才有登出保护
    const kept = await changeAuth((all) => {
      if (had && !(key in all)) return false                      // 1211：登录期间被登出 → 保持登出
      if (JSON.stringify(all[key]) === JSON.stringify(body)) return false  // 1212：完全一样 → 不写
      all[key] = body                                             // 1213：**整体替换，不合并**
    })
    if (kept !== false) { forgetAccount(key); send({ event: "auth", provider: providerOf(key), account: key }) }
  }
  return { data: true }                                          // 1222：**静默 no-op 也是这个返回值**
}
```

**六条必须记住的语义（都已证实）**

| # | 语义 | 证据 | 施工后果 |
|---|---|---|---|
| A | `body` **整体替换**旧记录，不合并 | 1213；注释 1209-1211 | 写之前必须把凭据的**全部**字段凑齐（我们的凭据是整份 JSON 进 `access`，天然满足） |
| B | `id` 给 `<provider>#<slot>` 时就是字面键；给裸 `<provider>` 且**当前 scope 的 provider 等于它**时才改写成 scope 的账号键 | `keyFor` 1083-1087；1206 | 自动写入一律用**完整键**，不依赖 scope 推断 |
| C | 写成功会 `forgetAccount(key)`（清该账号的 loader/info 缓存）并发 `{event:"auth"}` 给 magpie | 1220；`forgetAccount` 335-339 | 宿主侧缓存立刻失效；magpie 收到事件后**怎么用**属于 Go 侧，未证实（R3） |
| D | 相同 JSON 不写、不发事件 | 1212 | 重复自动开通**不产生**副作用（假宿主探针 ③：`writes 2→2`） |
| E | **读不出账号库也照样写回**（条件里的 `Object.keys(all).length` 在 `change(all)` 之后求值） | 1029-1048（关键在 1037 那一行）；假宿主探针 ⑤a | 必须先自己读一遍账号库：**读不出来就放弃写**（否则会把用户其它账号从 `plugin-auth.json` 里挤掉，原文件只留在 `.bad-<时间戳>`） |
| F | 返回 `{data:true}` **不代表写成功**（`id` 不是字符串 / `body` 不是对象 / 坏账号库都会静默） | 1204、1222 | 写完**必须回读校验**，否则又是「提示成功、库没变」 |

> 失败面还有一层：账号库坏掉且没有 `.bak` 时 `writeAuth` 先 `keepBad()` 把坏文件另存
> （`961-975`、`925-957`），但**写回的内容只有我们这一条**（`all` 从 `{}` 起）——
> 所以 E 不是"少写一条"，是"别人的账号从文件里消失"。**已证实**（源码 + 探针 ⑤a）。

### 1.3 一个 provider 多个账号：键 / `uid` / `accountId`

| 概念 | 谁决定 | 源码 | 我们该怎么做 |
|---|---|---|---|
| 记录键 | 裸 `<provider>` = **第一个**账号；其余 `<provider>#<slot>` | `accountsOf` 1075-1080 | 新增账号用确定性后缀 `monkeycode#<sha256(uid)[0:8]>`，重复自动开通天然幂等 |
| 键的随机后缀 | magpie 自己在**登录落盘**时用 `Math.random().toString(36).slice(2,8)` | `freshKey` 1097-1106 | 我们**不**模仿随机后缀：随机 = 每次都是新账号行 |
| `accountId` | **显示名**（手机上打码 / 昵称） | `whoOf` 1120 | 写 `nickname`（`signInWithBaizhiSession` 的 `profile.nickname`） |
| `uid` | **厂商身份**，magpie 内部判重与"改过名的账号"识别都靠它 | `uidOf` 1135-1139、`renamedBy` 1145-1152 | 写 `profile.userId`（平台 `data.user.id`，不是兑换响应里的 Key 记录 id） |
| 判重 | `settle()`：`accountId` 相同（且 `uid` 不冲突）→ 或 `uid` 改名 → 或"无名字时秘密相同" | 1156-1185 | `settle` **只在登录落盘时跑**（`save` 2456-2468）；`auth.set` **不经过**它 ⇒ 去重必须我们自己来 |
| 单账号 provider | `auth.single === true` 时登录永远写第一个键 | 2339、2471 | **不许**给 monkeycode 设 `single`（那会把多账号废掉）。现状：本仓库 0 处 `auth.single`（`grep -rn "single:" src/ index.mjs` 只有 `vision-clock.mjs:250` 一个无关布尔） |

**为什么"重复"是真问题**：`access_token` / `signing_secret` / `session_cookie` 每次兑换都会变，
所以「同一账号第二次自动开通」若按内容选键就会长出新账号行；只有按 `uid`（稳定身份）选键才幂等。

### 1.4 ctx 里有什么（`client` 从哪来）

源码：`loadPlugins` 1327-1340 —— 插件函数被调用为 `await fn(input, p.options)`，`input` 形如：

```js
{ client: makeClient(), project, directory, worktree, experimental_workspace, serverUrl, $,
  magpie: { option, options, load: reportLoad, usage: reportUsage, account: keyFor } }
```

- **`authorize()` 拿不到 `client`**：宿主只给 `m.authorize(inputs, { signal })`
  （`authorize` 2488，`m.authorize(...)` 在 **2498**）。所以 `client` 必须在**插件工厂**里先取到、闭包进去 ——
  这正是现在两个工厂把 `_ctx` 丢掉要改的地方。
- `input.client` 与 `input.magpie` **同一个 `input` 对象**喂给所有插件实例
  （`input` 字面量 1328-1340，在 `one()` 外面），所以百智云实例拿到的 `client`
  也能写 monkeycode 的键 —— **跨 provider 写是宿主设计内的能力**，不是 hack。
- `input.magpie.account` 就是 `keyFor`（1339）：给插件一个"我这个 provider 的账号键是哪个"的口子。
  我们**不用**它（一律显式完整键），但它存在可作为复核。

### 1.5 三个不许越过的"阻塞点"

| 钩子 | 预算 | 源码 | 超时后果 |
|---|---|---|---|
| 插件函数（工厂返回 hooks） | `loadWait` = **20 s** | 353、1385 | 该插件被判"加载失败" |
| `config` 钩子 | `loadWait` = **20 s**，且**每轮 load 都会跑一遍** | 1405-1412 | 报 `config hook didn't finish in 20s`，provider 行按空配置出 |
| `provider.models` 钩子 | `listWait` = **20 s / 每账号** | 354、2020-2022、2304-2312 | `fellBack` / `listError` → 卡片「已登录，但 magpie 无法列出它」 |

> 这就是"**不得在 config/models 阻塞**"的准确含义：不是"慢一点没关系"，是"超时即判坏"。
> 一次 `signInWithBaizhiSession` 的耗时是 **5 s 起（起 Chromium）+ 最多 60 s（等授权回跳）
> + 30 s（换 Key）**（`src/monkeycode/sso-import.mjs:250`、`343`、`345`），远大于任何一个预算。

### 1.6 华为云包（`magpie-officeace`）真实在跑的是什么

只读核过两处（`D:\DeepSeek Harness\反代\magpie-officeace`）：

1. **反方向读盘**：`index.mjs:369` / `406` → `src/accounts.mjs:45-72` 的 `readOfficeAceAccounts()`
   —— 只读 `~/.config/magpie/plugin-auth.json` 里 **自己这个 provider**（`officeace` / `officeace#…`）的条目。
   注释写得很明确：`src/accounts.mjs:3-30`「只读，绝不写」。
2. **跨 provider 写**：`src/codearts/index.mjs:3768-3782` 的 `writeSharedRecord()`
   + 唯一调用点 `:2856`（在「Sign in with Huawei Cloud」的 `callback` 里）
   + 键选择 `recordKeyFor()` `:3745-3752`（**已占用就不写；裸键只在"已知这家一颗账号都没有"时用**）
   + 确定性后缀 `accountKeySuffix()` `:3665-3667`（`sha256(identity)[0:8]`）。

它**不**自动补开、也**不**在启动时扫库；它只在「用户点了第二张卡的登录」那一刻，
把这次登录拿到的账号写成第二家的记录。它自己的注释（`:2848-2855`）解释了为什么不敢写更多：
**华为云 refresh token 一次性**，一条凭据被两处持有会互相登出。

| 维度 | 华为云（officeace/codearts） | 我们（baizhi/monkeycode） |
|---|---|---|
| 一次性 token | 是（STS refresh 只能用一次） | **否**（`baizhi_session` 静态；SSO 产出独立长期凭据） |
| 靠什么判"这家有没有这个账号" | 内存里 `seenProviderAccounts`（由自家 `models` 钩子按账号喂） | **读 `plugin-auth.json` 的 `uid`**（我们有稳定 uid，更准） |
| 写键 | `officeace#<sha8(identity)>`（裸键只在"已知空"时用） | 同形态；但把"已知空"换成"读盘确认空" |
| 时机 | 用户点第二张卡的登录 | **百智云登录成功那一刻**（用户要求） |

**可直接照抄的三条**：① 确定性后缀键；② 键先判空再写；③ 写失败吞掉、不影响本次登录。
**不能照抄的一条**：`seenProviderAccounts` 靠自家 `models` 钩子喂 —— 那要求"先有账号才能列模型"，
在"还没有账号"的场景里是死循环；我们是 `auth.set` 的发起方，直接读盘更简单。

---

## 2. 本仓库现状（只读取证）

### 2.1 两条成功路径确实汇到一个函数

```
src/baizhi/runtime.mjs:521-567  方法①「百智云 BaiZhiCloud 从本机客户端导入」
        :558-564  callback → finishSignIn(desk.cookie, site)
src/baizhi/runtime.mjs:569-677  方法②「百智云 BaiZhiCloud 浏览器登录」
        :667-675  callback → finishSignIn(cookie, site)
src/baizhi/runtime.mjs:179-211  finishSignIn(cookie, site, { fetchImpl })
        :184 exchangeForSignIn → :191 needsKeyCreation 时开建 Key 页 → :195 failed
        :200 fetchProfile            → :201 signInSuccess({access, expires, accountId, uid})
```

`grep -n "finishSignIn(" src/baizhi/runtime.mjs` → `179`（定义）、`560`、`670`（两处调用）。
**所以"一个钩子覆盖两条路"是结构事实，不是设计选择。**

### 2.2 已经躺在仓库里、可以直接用的件

| 件 | 位置 | 为什么正好够用 |
|---|---|---|
| 用一条百智云 cookie 换 MonkeyCode 账号 | `src/monkeycode/sso-import.mjs:284-369` | 返回 `{credential:{access_token,signing_secret,session_cookie,user_id?}, nickname, userId}`；已带邀请码、已 `warmCatalog`（`:352`） |
| 邀请码 → SSO 入口 URL | `src/sites.mjs:151-159` `ssoEntryUrlWithInvite` | 只有 `site.id === "monkeycode"` 才拼 `?redirect=&inviter_id=` |
| 邀请码策略文件 | `src/invite.mjs:48-102` `createInviteStore("monkeycode")` | `~/.cache/magpie/monkeycode-invite.json`（与百智云那份**不同文件**） |
| 记录体形状 | `src/credential.mjs:79-92` `signInSuccess` | 它就是**宿主 `save()` 消费的那一份**（`refresh` + `access` + `expires` + `accountId` + `uid`） |
| 读账号库找同 uid | `src/monkeycode/runtime.mjs:52-61` `existingAccountWithUid()` | 已经把"只读、按 `provider` / `provider#` 前缀、比对 `uid`"写完 |
| 已导入状态（防重复兑换） | `src/monkeycode/sso-import.mjs:100-110` `readImported/markImported` | `~/.cache/magpie/monkeycode-imported.json`，键是**百智云**账号身份 |

### 2.3 缺口（全部已补齐）

1. ~~两个工厂都不要 `ctx`~~ ⇒ 已改成吃 `ctx`，`client.auth.set` 拿得到；
2. ~~`finishSignIn` 没有任何"第二件事"的挂点~~ ⇒ 已加 `{ provision, signal }` 挂点（两条登录路共用一个）；
3. ~~`existingAccountWithUid` 只回 `boolean`~~ ⇒ 已改成 `readProvisionedAccounts(providerId)`
   （返回**键 + 全量账号表**，坏库返回 `ok:false`；去重口径只留这一处，前缀判据不再重复一份）；
4. ~~没有"哪个百智云账号已经开通过 MonkeyCode"的台账~~ ⇒ 复用 `markImported`（`monkeycode-imported.json`，
   与手动路径同一个文件），并且只在**写入回读确认之后**登记。

---

## 3. 最小可施工设计

### 3.1 新增 `src/monkeycode/provision.mjs`

四个纯函数 + 一个异步入口（依赖全部注入，**不 import 任何浏览器模块**）：

```js
// ── 读盘：读不出来必须能被调用方看见（宿主不会替我们挡，见 §1.2-E） ──────
export function readProvisionedAccounts(providerId, file = authStorePath())
//   → { ok: true,  accounts: [{ key, accountId, uid }] }     // 文件不存在 = 空库，ok
//   → { ok: false, accounts: [] }                            // 解析失败 / 不是对象

// ── 纯函数：这道闸决定"要不要写、写到哪" ───────────────────────────────
export function decideProvision({ store, uid })
//   → { skip: "no-uid" }             // uid 空：宁可少开一个，也不制造重复账号
//   → { skip: "store-unreadable" }   // 账号库读不出来：一个字都不许写
//   → { key: "monkeycode" }          // 账号库里没有 monkeycode 记录
//   → { key: "monkeycode#a1b2c3d4" } // uid 命中 → 原位重写；裸键被占 → 确定性后缀

// ── 纯函数：记录体（= 宿主 save() 的形状，别自创字段名） ─────────────────
export function monkeycodeRecord({ credential, accountId, uid })
//   → { type: "oauth", refresh, access, expires: 0, accountId?, uid? }

// ── 唯一有副作用的入口：可以被单测用假 sso 全程替换 ──────────────────────
export async function provisionMonkeyCode({ client, cookie, inviteCode, signal, sso, log })
//   → { ok: true, key } | { ok: false, skipped?: string, error?: string }
```

`provisionMonkeyCode` 的内部顺序（**每一步失败都只是 `return {ok:false}`，不抛**）：

```js
// 模块级：const singles = new Map()   // 单飞表：cookie 指纹 → 在跑的那个 Promise
// const fingerprintOf = (cookie) => createHash("sha256").update(cookie).digest("hex").slice(0, 16)

if (typeof client?.auth?.set !== "function") return { ok: false, skipped: "no-client" }  // 单测传 {client:{}} 时不炸
if (process.env.MAGPIE_PLUGIN_DISABLE_BROWSER === "1") return { ok: false, skipped: "test-latch" }
if (singles.has(fingerprintOf(cookie))) return { ok: false, skipped: "in-flight" }       // 单飞
const signed = await sso(cookie, SITES.monkeycode, { inviteCode })                       // 复用唯一 SSO 实现
const uid = String(signed.userId ?? "")
const decision = decideProvision({ store: readProvisionedAccounts("monkeycode"), uid })
if (decision.skip) return { ok: false, skipped: decision.skip }
if (signal?.aborted) return { ok: false, skipped: "aborted" }
await client.auth.set({ path: { id: decision.key }, body: monkeycodeRecord({ credential: signed.credential, accountId: signed.nickname, uid }) })
const after = readProvisionedAccounts("monkeycode")                                       // §1.2-F：回读校验
return after.accounts.some((a) => a.key === decision.key && a.uid === uid)
  ? { ok: true, key: decision.key } : { ok: false, error: "写完没读到记录" }
```

⚠ **不许**用 `importOneBaizhiAccount()` 当自动路径：它按"下一个没导入过的"选号
（`sso-import.mjs:383-394`），会开出**另一个**百智云账号的 MonkeyCode 号
（用户刚登录的是 B，自动开的却是 A）。自动路径只认**这次登录拿到的 cookie**。

### 3.2 `src/baizhi/runtime.mjs` 的三处改动

**① 工厂吃 `ctx`，把 `client` 与两个依赖闭包进来**（`src/baizhi/runtime.mjs:453-459`）：

```diff
+import { signInWithBaizhiSession } from "../monkeycode/sso-import.mjs"
+import { provisionMonkeyCode } from "../monkeycode/provision.mjs"

 export function makeBaizhiPlugin(site = BAIZHI) {
-  return async (_ctx, _options) => {
+  return async (ctx = {}, _options) => {
+    const client = ctx?.client
     const usageCache = createUsageCache({ ttlMs: 60_000, failTtlMs: 5_000 })   // :455 不变
     const inviteStore = createInviteStore(site.id)                            // :459 不变（百智云自己的码）
+    // 国内站 SSO 的邀请码策略：与手动那条路**同一个文件**（§5.1）
+    const monkeycodeInvite = createInviteStore("monkeycode")
+    // 自动开通：依赖全部注入，测试可以用假 sso / 假 client 全替换
+    const provision = (cookie, signal) => provisionMonkeyCode({
+      client, cookie, signal,
+      inviteCode: monkeycodeInvite.read(),
+      sso: signInWithBaizhiSession,
+      log: (message) => client?.app?.log?.({ body: { level: "info", service: "baizhi", message } }),
+    })
```

> 循环依赖检查：`src/monkeycode/sso-import.mjs` 只 import `sites / browser-login /
> monkeycode/{credits,catalog} / credential`，**不 import `baizhi/runtime.mjs`**；
> 而 `baizhi/runtime.mjs` 现在就已经 import 了 `../monkeycode/desktop-session.mjs`（`:22`）。
> 所以 baizhi → monkeycode 这条边是**已存在**的，新增两条不引入环。

**② `finishSignIn` 加一个挂点**（`src/baizhi/runtime.mjs:179-211`）：

```diff
-async function finishSignIn(cookie, site, { fetchImpl } = {}) {
+async function finishSignIn(cookie, site, { fetchImpl, provision, signal } = {}) {
   ...
   const profile = await fetchProfile(cookie, site, { fetchImpl })
-  return signInSuccess({ ... })
+  const result = signInSuccess({ ... })            // :201-210 一字不动
+  // 自动开通：**不 await** —— 5~90 s，且失败不许影响百智云登录（§3.4）
+  if (typeof provision === "function" && site.id === "baizhi") void provision(cookie, signal).catch(() => {})
+  return result
 }
```

**③ 两处 callback 把宿主给的 `signal` 传下去**（`:558-564` 与 `:667-675`）：

```diff
   // ── 方法①「从本机客户端导入」:558-564
-                async callback() {
+                async callback(_code, { signal } = {}) {
                   try {
-                    return await finishSignIn(desk.cookie, site)
+                    return await finishSignIn(desk.cookie, site, { provision, signal })
                   } catch (error) { ... }

   // ── 方法②「浏览器登录」:667-675
-                async callback() {
+                async callback(_code, { signal } = {}) {
                   try {
                     const { cookie } = await flow.wait()
-                    return await finishSignIn(cookie, site)
+                    return await finishSignIn(cookie, site, { provision, signal })
                   } catch (error) { ... }
```

（宿主调用 callback 时**确实传**第二个参数：`host-4a981f88f87c.js:2533-2541`
`s.a.callback(undefined, { signal })`；OpenCode 那条路传 `undefined`，所以形参要有默认值。）

### 3.3 键选择：为什么必须是"先读盘"

| 场景 | 账号库现状 | 选键 | 理由 |
|---|---|---|---|
| 首次使用 | 无文件 | `monkeycode` | 与宿主自己的习惯一致（第一颗账号在裸键）；探针 ⑥ 验证 |
| 已有一个**别的** MonkeyCode 账号 | `monkeycode` 被占 | `monkeycode#<sha8(uid)>` | 探针 ④：写裸键会把别人的账号**整条替换** |
| 同一个账号第二次自动开通 | `monkeycode` 或 `..#h` 里的 `uid` 相同 | 命中那个键（原位重写） | 探针 ②：记录被最新凭据更新，账号行仍是 1 条 |
| 账号库读不出来 | 解析失败 | **不写** | 探针 ⑤a：宿主照样写回，会把用户其它账号挤掉 |
| `uid` 取不到 | — | **不写** | 没稳定身份就没有幂等键，写下去就是"每次登录一个新账号" |

> 与华为云的差别只在第 1 行：它用内存里的 `seenProviderAccounts` 判断"裸键空着"，
> 我们读盘 —— 因为我们**不是**那个 provider 的 `models` 钩子持有者，拿不到那份内存。

### 3.4 时序 / 并发 / 失败隔离

```
用户点「浏览器登录」或「从本机客户端导入」
  └─ callback()  ──► finishSignIn()  ──►  return signInSuccess(...)   ← magpie 立刻拿到「登录成功」
                                  └──► void provision(cookie, signal)  ← 后台
                                          ├ 单飞：同一份 cookie 只跑一次
                                          ├ 超时：AbortSignal.timeout(180_000) 传给 sso
                                          ├ signal.aborted → 不写（用户取消了这次登录）
                                          ├ 任一步失败 → log 一行 + return（**不 throw、不写半条**）
                                          └ 成功后 markImported(baizhiIdentity)      ← 见下
```

四条硬规矩：

1. **不 await**：`finishSignIn` 返回时间必须与"没有自动开通"时相同（§6 用例 T-9 用永不 resolve 的假 `provision` 锁死）。
2. **单飞**：`Map<sha256(cookie)[0:16], Promise>`，跑完即删。避免"用户连点两次登录 → 两个 Chromium"。
3. **不写半条**：只调一次 `auth.set`，body 一次性拼好；绝不先写 `monkeycode` 再改键。
4. **成功才 `markImported`**：与 `importOneBaizhiAccount`（`sso-import.mjs:399`）同一口径；
   失败不写状态，下一轮还能轮到它。**这样用户手点国内站「用百智云账号开通」时会跳过 ①，
   直接走 ②③ 的桌面 / profile 复用**（少一次 SSO 往返），且最终由宿主 `settle` 并进同一条记录（探针 ②）。

> 残留风险（写在这里，别指望别人想起）：magpie 若在 provision 跑到一半时**退出**，
> 受控 Chromium 可能变孤儿。与现在用户手点手动 SSO 的风险**同一量级**（同一份 `openPage`）；
> 若要收口，给 `provisionMonkeyCode` 加 `process.once("exit")` 里的 `child.kill()`。

---

## 4. 第 3 问：要不要为"插件启动时已有的百智云账号"自动补开

**结论：不要默认做。** 三个理由，前两个是硬约束，第三个是产品判断。

1. **没有便宜的判据**。「这个百智云账号是否已经有对应的 MonkeyCode 账号」在本地**查不出来** ——
   `plugin-auth.json` 里 monkeycode 记录带的是 **MonkeyCode 的 `uid`**，而百智云记录带的是
   **百智云的 `user_id`**，两套身份之间唯一的桥是"再走一次 SSO"。所以"补开"= 每个百智云账号
   起一次 Chromium（5~90 s），无法只靠读盘判定。
2. **可用的挂点全部有预算**（§1.5）：`config` 与插件函数各 20 s；`models` 20 s/账号。
   把补开放进这三处，等于用"卡片报『无法列出它』"换一个用户没要求的账号。
3. **会被当成静默建号**：用户只是打开了 magpie，插件就替他开户、还消耗别人的邀请关系。
   华为云插件也不这么做（§1.6：它只在用户点第二张卡时复用）。

**如果以后确实要做，唯一可接受的形态**（写在这里以免有人自己发明）：

```js
// 触发：provider.models 钩子**内**只做同步判断 + 一次性排队，绝不 await
provider: {
  id: site.id,
  async models(provider, { auth } = {}) {
    if (site.id === "monkeycode") scheduleBackfillOnce()   // 同步、零 IO、零 await
    return { ...configModels(site), ...(provider.models ?? {}) }
  },
}
```

`scheduleBackfillOnce()` 的十条约束（缺一条就别上）：

| # | 约束 | 判据 |
|---|---|---|
| 1 | **每进程一次**（模块级 `let tried = false`），不是每次 `models` 调用一次 | 连续列 10 次 provider，`client.auth.set` 调用 ≤ 1 次 |
| 2 | 只读本地文件判断（`readBaizhiSessions` + `readProvisionedAccounts` + 台账），不联网 | 用 `fetchImpl` 记录，断言 0 次出站请求 |
| 3 | **一次只补一个** | 三个待补账号 → 一轮只写 1 条 |
| 4 | 失败写台账（`{identity, at, tries}`），`tries >= 2` 不再试 | 连续两轮失败后第三轮 0 次尝试 |
| 5 | 成功写台账 `{baizhiIdentity → monkeycodeUid, key}`，回读校验 | 台账里没有的 identity 才会触发 |
| 6 | `MAGPIE_PLUGIN_DISABLE_BROWSER=1` 直接 return | 单测里 0 次 spawn |
| 7 | 总时长上限（≤ 180 s），超时就放弃并记账 | 假 sso 永不 resolve → 180 s 后 fail closed |
| 8 | 与登录路径共用同一个单飞闸 | 登录 provision 在跑时，backfill 直接跳过 |
| 9 | **绝不**在 `config` 钩子、插件函数、`loader`、`usage`、`checkin` 里触发 | `grep` 断言这些函数体里没有 `provision` / `backfill` 调用 |
| 10 | backfill 写出的记录与登录路径**逐字段同形**（走同一个 `monkeycodeRecord`） | 记录体快照断言 |

---

## 5. 硬约束逐条落点（任务第 1/2/4/5 问的合并表）

| 要求 | 实现位置 | 判据（当场能跑） | 测试 |
|---|---|---|---|
| **① 精确参数**：`{path:{id}, body}`，body 整体替换 | `provision.mjs` 的 `provisionMonkeyCode`；body 由 `monkeycodeRecord()` 生成 | mock client 记录到的调用形如 `{path:{id:"monkeycode"}, body:{type:"oauth",refresh,access,expires,accountId,uid}}` | T-1 |
| **② 两条成功路径都接线** | `finishSignIn`（`baizhi/runtime.mjs:179`），两处调用 560/670 天然覆盖 | 注入假 provision，跑两条 method 的 callback → 各 1 次调用 | T-2 |
| **③ 多账号不互相覆盖** | `decideProvision` 的键选择（§3.3） | 库里已有别的 uid 时，写出来的键 ≠ `monkeycode`，且旧记录不变 | T-4 |
| **④ 防重复** | ①`uid` 命中即原位重写；②无 `uid` 不写；③`markImported` 让手动路径不再重导 | 同一账号自动开通两次 → 账号行 1 条；`monkeycode-imported.json` 里出现该身份 | T-5、T-6 |
| **⑤ 失败不影响百智云登录** | `void provision(...).catch(()=>{})`（不 await） | 假 provision 抛错 / 永不 resolve → `finishSignIn` 返回仍 `type:"success"`，且耗时 < 50 ms | T-3、T-9 |
| **⑥ 国际站绝不触发** | provision 的目标是**常量** `SITES.monkeycode`；`site.id === "baizhi"` 守卫；`src/baizhi/**` 里 0 处 `monkeycodeintl`（已核：`grep -c` → 0） | `makePlugin(SITES.monkeycodeintl)` 的任何 callback 跑完 → mock client 的 `set` 调用 0 次 | T-7 |
| **⑦ 邀请码不被绕过** | `inviteCode = createInviteStore("monkeycode").read()`（§5.1） | 假 sso 收到的第三参数 `inviteCode` === 策略文件里的码；百智云那份码不出现 | T-8 |

### 5.1 邀请码为什么"绕不过去"（四个锁）

1. **拼 URL 只有一处**：`ssoEntryUrlWithInvite`（`src/sites.mjs:151-159`），自动路径调的是
   `signInWithBaizhiSession`（内部 `:317` 用它导航），**没有第二条拼 URL 的代码**可绕过。
2. **码只有一处产出**：`resolveInvite(raw, current)`（`src/invite.mjs:112-116`）+ 用户手填
   （国内站「用百智云账号开通」的 `ask()`，`src/monkeycode/runtime.mjs:604-620`）。
   自动路径**只读**策略文件、不新增输入口、不改 0/1/留空 的语义 —— 与手动路径读到的是同一个值。
3. **两套码不同文件**：`monkeycode-invite.json` vs `baizhi-invite.json`
   （`createInviteStore(prefix)` → `<prefix>-invite.json`，`src/invite.mjs:48-50`）。
   探针 ⑧ 实测两者互不相干。
4. **国际站恒不带码**：`sites.mjs:154` 对非 `monkeycode` 恒返回裸入口；`sites.mjs:140` 同理。

⚠ **必须写进施工说明的真实风险**：邀请关系**只在建号那一刻**生效、事后补不了
（`docs/baizhi-invite-research.md` §2/§4）。自动开通若在用户**还没填过码**时抢跑，
这个号的邀请机会就永久用掉（上级拿不到奖励，也补不回）。两个可选处置：

- **A（最小）**：照现状"有码就带、没码就不带"，并把这件事在登录成功的提示里说清楚
  （`signInSuccess(...).message` 是宿主会显示的通道）。
- **B（已采用）**：在百智云「浏览器登录」的 `ask()` 链上加**一格可选**"MonkeyCode 邀请码"，
  写到 `monkeycode` 策略文件里 —— 结构锁允许（`tests/invite-url.test.mjs:140-183` 只锁
  "不许新增 label 含邀请的**方法**""`ask({})` 必须纯本地返回"，不限制 prompt 个数）。
  代价：给百智云登录多问一格（现在 `ask()` 依次问 `invite`（百智云 `invite_code`）→
  `monkeycodeInvite`（国内站 `inviter_id`），落两个**不同**的策略文件）。
  A 仍然生效：用户没填码时就不带，不会替用户造一个码。

---

## 6. 第 6 问：测试计划（全部离线，零网络零浏览器）

新增 `tests/provision.test.mjs`，并扩 `tests/multi-provider.test.mjs`。

### 6.1 纯函数层（不碰 client、不碰文件系统以外的东西）

| 用例 | 断言 | 会抓住的错 |
|---|---|---|
| T-1 `monkeycodeRecord` 形状 | 键集合恰为 `{type,refresh,access,expires,accountId,uid}`；`refresh === access`；`expires === 0`；**无 `message`** | 自创字段（宿主整体替换，多写一个字就多一条脏数据）；漏 `refresh`（§0.7 那个"存不下"的坑） |
| T-3 `decideProvision` 五分支 | `no-uid` / `store-unreadable` / 裸键 / 后缀键 / uid 命中 | 用内容（token）当键 → 每次登录新账号 |
| T-4 后缀键确定性 | 同 uid 两次 → 同一个键；不同 uid → 不同键 | 用随机后缀（`freshKey` 那种）→ 重复账号 |
| T-5 前缀判据（拿真实 `plugin-auth.json` 形状喂进去） | 有 `baizhi`/`workbuddy` 条目时，`readProvisionedAccounts("monkeycode")` 只返回 monkeycode 的键 | 前缀判断写成 `includes`（会把 `monkeycodeintl` 也吞进来 —— **这是国际站串味的实际路径**） |

**已知毒点**（务必单独一条）：`"monkeycode"` 是 `"monkeycodeintl"` 的**前缀**。
判据必须是 `key === providerId || key.startsWith(providerId + "#")`，**不能**写成
`key.startsWith(providerId)` —— 否则 `monkeycodeintl` 的账号会被当成 monkeycode 的，
键选择会对着国际站的记录做判断。

现在这条判据**只存在于一处**（`readProvisionedAccounts`，`src/monkeycode/provision.mjs`）：
`existingAccountWithUid` 已改成调它，不再自己写一份前缀判断（重复两份迟早会漂）。

### 6.2 注入层（假 `sso`，不碰 CDP / Chromium）

```js
const calls = []
const fakeClient = { auth: { set: async (opts) => { calls.push(opts); return { data: true } } } }
const fakeSso = async (cookie, site, opts) => { ssoCalls.push({ cookie, siteId: site.id, ...opts }); return { credential: {...}, nickname: "观猹员 0001", userId: "mc-uid-1" } }
// ⚠ 变量名不叫 cookie*：privacy-scan 会把 `cookie = "<长串>"` 当成真值报出来（tests/ 里同规矩）
const SESSION_HEADER = "<百智云会话串：sl-session=…; baizhi_session=…>"
await provisionMonkeyCode({ client: fakeClient, cookie: SESSION_HEADER, inviteCode: "12345", sso: fakeSso })
```

| 用例 | 断言 |
|---|---|
| T-2 `auth.set` 调用形状 | `calls[0].path.id === "monkeycode"`；`body` 与 T-1 同形 |
| T-7 `sso` 收到的站点 | `ssoCalls[0].siteId === "monkeycode"`，且 `ssoCalls[0].inviteCode === "12345"` |
| T-8 邀请码来源 | 临时 HOME + 写 `monkeycode-invite.json` → 自动路径拿到 `MC-CODE`；同时写 `baizhi-invite.json` → 断言 `BZ-CODE` **不出现**（探针 ⑧ 已跑通） |
| T-10 单飞 | 并发两次 `provisionMonkeyCode` 同一 cookie → `ssoCalls.length === 1` |
| T-11 静默失败回读 | mock client 的 `set` 什么都不写 → 返回 `{ok:false, error:"写完没读到记录"}` | 

### 6.3 接线层（真 `makeBaizhiPlugin()` + 假 `fetchImpl` + 假 `client`）

沿用现有测试的调用形态（`tests/multi-provider.test.mjs:104`/`133`：`await factory({ client: {} })`）
—— 所以**必须容忍 `client: {}`**（新代码里 `typeof client?.auth?.set !== "function"` 直接跳过）。

| 用例 | 做法 | 断言 |
|---|---|---|
| T-2b 两条路都触发 | 取 `plugin.auth.methods` 里两个方法，分别跑 `authorize()` → `callback()`；`fetchImpl` 用现成的假百智云（列 Key → 有 Key → profile） | 每个方法各 1 次 `fakeProvision` 调用，参数是**当次**的 cookie |
| T-3 失败隔离 | `fetchImpl` 让换 Key 返回 401 | `finishSignIn` 返回 `type:"failed"`，`fakeProvision` **0 次**调用 |
| T-9 不阻塞 | 注入永不 resolve 的 `provision` | `finishSignIn` 在 50 ms 内返回且 `type:"success"` |
| T-12 signal | callback 第二参传 `{ signal: AbortSignal.abort() }` | `fakeProvision` 收到的 signal 已 abort；`provisionMonkeyCode` 不调 `auth.set` |
| T-13 `MAGPIE_PLUGIN_DISABLE_BROWSER=1` | 置门闩 | `provisionMonkeyCode` 立即返回 `skipped:"test-latch"`，0 次 `sso` 调用 |
| T-6 成功才登记已导入 | 临时 HOME；先跑成功一次、再跑失败一次 | 成功 → `monkeycode-imported.json` 出现该百智云身份；失败 → 文件**没变**（对照 `sso-import.mjs:399` 的同一口径） |

### 6.4 宿主语义层（不用真 magpie）

宿主语义（`changeAuth` 条件顺序、`keyFor`、`settle`、`auth.set` 的静默失败）由
`tests/provision.test.mjs` 用注入式假 client 覆盖（**没有**为它单开一个测试文件）：

| 用例 | 断言 | 意义 |
|---|---|---|
| 自动写 + 手动开通 = 1 条 | 先 `auth.set` 写 `monkeycode#<sha8>`，再走一遍同 uid 的开通 | "会不会变成两张卡"的答案：**不会**（探针 ② 已实测） |
| 坏账号库仍写回 | 坏 JSON 时 `readProvisionedAccounts` 返回 `ok:false`，我们**不写** | 锁住"我们自己必须挡在宿主之前"这条（探针 ⑤a） |
| 静默 no-op | 假 client 回 `{data:true}` 但文件没变 | 回读四样必须报失败（否则"看起来成功、其实没落盘"没人守） |

### 6.5 变异清单（证明测试不是空跑）

| 变异 | 应该变红的用例 |
|---|---|
| M1 `decideProvision` 恒返回裸键 `monkeycode` | T-4、④（旧账号被覆盖） |
| M2 去掉"store-unreadable → 不写" | T-3（`store-unreadable` 分支）/ ⑤b |
| M3 `inviteCode` 改读 `createInviteStore("baizhi")` | T-8 |
| M4 把 provision 改成 `await` | T-9 |
| M5 目标站点从 `SITES.monkeycode` 改成传入的 `site` | T-7 + 国际站用例 |
| M6 `key.startsWith("monkeycode")`（漏 `#`） | T-5（国际站账号混进来） |
| M7 去掉回读校验 | T-11 |

---

## 7. 风险与未证实清单

| # | 项 | 状态 | 判据 / 探针 |
|---|---|---|---|
| R1 | `client.auth.set` 在我们这个 magpie 版本上真能写进 `plugin-auth.json` | **未证实**（只证了源码在场 + 假宿主行为） | 真机探针一次：登录百智云 → `grep -c '"monkeycode"' ~/.config/magpie/plugin-auth.json`，**只读一次文件**，不打印内容 |
| R2 | magpie 收到 `{event:"auth"}` 之后会不会**重跑插件工厂**（`init`） | **未证实**（`init` 是 magpie 发来的 RPC，宿主源码看不出发几次） | 看 `~/.config/magpie/app.log`（或 `client.app.log` 的输出）里插件加载次数；若会重跑，§4 的"每进程一次"必须换成**文件台账** |
| R3 | 自动写入后 magpie 是否立刻列出这个账号的模型 | 未证实 | 真机：`curl -s http://127.0.0.1:3425/v1/models \| grep -c 'monkeycode/'` |
| R4 | 一个账号两次 SSO 会不会在平台侧产生**两把 Key**（每兑换一次签一把） | 已知风险（`src/baizhi/runtime.mjs:213-231` 就为这个做的缓存） | 真机看控制台 Key 列表条数；施工时用 `markImported` + 单飞把次数压到 1 |
| R5 | 模型目录缓存是**按 provider**（不是按账号）：`catalogPath(providerId)`（`src/monkeycode/catalog.mjs:47-50`） | **已证实**（读源码） | 多账号会互相覆盖目录 —— 与本任务无关，但自动开通会让"两个国内站账号"变常见，此处记账 |
| R6 | magpie 退出时受控 Chromium 变孤儿 | 已知风险（与现有手动 SSO 同级） | `tasklist` 里 `chrome.exe` 带 `--user-data-dir=...magpie-sso-` |
| R7 | 邀请关系在首号上被"抢跑"用掉 | **已证实**（机制层）+ 已按 §5.1 的 **B 方案**处置 | 百智云「浏览器登录」现在一次问两格可选输入（百智云码 → 国内站码），自动开通用国内站那一格；用户没填就不带 |

---

## 8. 附录：探针脚本与真实输出

脚本放在临时目录（**不入库**，避免给仓库塞一个只在这次审计里有意义的探针）：
`<TEMP>/host-contract-probe.mjs`（Git Bash 里的 `/tmp/`）。只读：把 §1.2 的宿主语义抄成假宿主，
所有 `plugin-auth.json` 都落在 `mktemp` 目录，不碰 `~/.config/magpie`。

```
$ node "$TEMP/host-contract-probe.mjs"
PASS  ① 跨 provider 自动写入：baizhi 的登录里写出 monkeycode 记录  — 键=monkeycode，库键=baizhi,monkeycode
PASS  ①b 百智云自己的记录一字未动
PASS  ①c 只发了一个 auth 事件，provider 是 monkeycode  — [{"provider":"monkeycode","account":"monkeycode"}]
PASS  ② 自动写 + 手动开通 = 仍然只有一条记录（settle 并进旧键）  — 键=monkeycode，save 返回 account=monkeycode
PASS  ②b 记录被手动那次的最新凭据更新
PASS  ③ 完全相同 body → 不落盘、不发事件（宿主自带幂等）  — writes 2→2
PASS  ④ 裸键已被占 → 用确定性后缀键，别人的账号原样保留  — 键=monkeycode,monkeycode#01c57b92
PASS  ④b 对照：直接写裸键会把别人的账号整条替换掉（所以键必须先读盘算）
PASS  ⑤a 宿主的真实行为：账号库读不出来时，写回照样发生（其它账号会从文件里消失）  — writes=1，写回后库键=monkeycode
PASS  ⑤b 设计闸：账号库读不出来 → decideProvision 直接跳过，碰都不碰宿主  — {"skip":"store-unreadable"}
PASS  ⑥ 账号库不存在 ≠ 读不出来：照写裸键  — {"key":"monkeycode"}
PASS  ⑦ uid 为空 → 不写（宁可少开一个，也不制造重复账号）  — {"skip":"no-uid"}
PASS  ⑧ 两个策略文件互不相干：自动开通只会拿到 monkeycode 的码  — mc=MC-CODE bz=BZ-CODE

13 pass / 0 fail
```

> ⑤a 与 ⑤b 是这轮审计**唯一改变设计**的发现：宿主在账号库读不出来时**仍然写回**
> （条件里 `Object.keys(all).length` 在 `change(all)` 之后求值），所以"读不出来就不写"
> 这条闸必须在我们自己代码里，不能指望宿主。

### 8.1 本仓库基线（交付时实测）

```
$ node --test                     → ℹ tests 330 · pass 330 · fail 0
$ node scripts/check.mjs          → exit 0（49 项通过）
$ node scripts/privacy-scan.mjs   → privacy-scan: PASS（0 处）
$ node --test tests/provision.test.mjs      → ℹ tests 30 · pass 30 · fail 0
$ node --test tests/multi-provider.test.mjs → ℹ tests 27 · pass 27 · fail 0
$ grep -rn "auth\.set" --include=*.mjs src/ index.mjs tests/ | wc -l   → 11（实现 + 测试）
$ grep -n "finishSignIn(" src/baizhi/runtime.mjs                       → 208 / 697 / 827
$ grep -c "monkeycodeintl" src/baizhi/runtime.mjs                      → 0
```

### 8.2 施工顺序（已按此顺序落地）

1. `src/monkeycode/provision.mjs`：4 个纯函数 + `provisionMonkeyCode`（先写 T-1/T-3/T-4/T-5 让它红）。
2. `src/monkeycode/runtime.mjs`：`existingAccountWithUid` 改为调用 `readProvisionedAccounts`
   （行为不变，只是去重口径只留一处）。
3. `src/baizhi/runtime.mjs`：吃 `ctx.client`、`finishSignIn` 挂钩子、两处 callback 收 `signal`。
4. `tests/provision.test.mjs`（30 条）+ 扩 `tests/multi-provider.test.mjs`（27 条），
   并按 §6.5 的变异清单（M1–M7）逐条验红；此后每轮修复各自另跑一批变异（见各轮报告）。
5. **只在最后**跑一次真机探针（R1），并且在结论里写清"读了几次账号库、有没有打印内容"。

### 8.3 需要同步的两处文档（已同步）

| 位置 | 现在写成什么 |
|---|---|
| `docs/internals.md` §3.1 | 「自动开通」小节：百智云登录（本机导入 / 浏览器登录）成功后来后台开通国内站账号并写回 magpie，附本文链接；手动入口改成「补开 / 恢复」 |
| `docs/internals.md` §3.6 | 持久 profile 那节按实现写清（百智云那份 profile 的 ③ 静默读 / ④ 开窗），并链到本文 |

