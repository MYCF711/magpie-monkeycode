# 独立复审报告 R2 · 修复验收与最终门禁结论（0.2.42）

> 审核人：`final-reviewer`（独立验收专员，非实现者；**本报告不审自己的实现** —— 我没有写过任何
> `src/**` 或 `tests/**`）
> 复审对象：`docs/final-review.md`（R1）里 H1 / M1-M6 / L1-L7 的**全部修复**，范围 t24-t28 的 diff。
> 审核日期：2026-11-09
> 本报告是唯一写入路径（`docs/final-review-r2.md`）；`src/**`、`tests/**`、`package.json`、`README.md`、
> `CHANGELOG.md`、`docs/automatic-credential-reuse.md` 全程只读。
> 未提交、未打 tag、未推送、未安装、未重启、未读写任何真实凭证。

---

## 0. 最终结论

**verdict: pass。blocker = 0，high = 0。**

R1 的 1 个 high + 6 个 medium **全部真修**，且每一条都有**能真红的回归测试**（我自建 18 条变异，
17 条红、1 条绿 —— 绿的那条是「负缓存 5 秒 TTL 没有测试」，new low，不阻塞）。四道门禁全绿：

| 门禁 | 结果 |
|---|---|
| `MAGPIE_PLUGIN_DISABLE_BROWSER=1 node --test` | **330 / 330 / 0**，EXIT=0 |
| `node scripts/check.mjs` | **通过 49 · 警告 0 · 失败 0**，EXIT=0 |
| `node scripts/privacy-scan.mjs` | **PASS（0 处）**，EXIT=0 |
| `npm pack --dry-run` | 118 files / 551.4 kB（**含 6 份 `docs/`**），EXIT=0 |
| `git diff --check` | EXIT=0（stderr 有 1 条 CRLF 提示，见 L-3） |
| `node scripts/check-maintenance.mjs` | 通过 4 · 警告 1 · **失败 1**（0.2.42 无 tag，**纯发布态**，本次禁做） |

**⚠ 一处必须更正的 R1 错误**：R1 的 **M1 是误报**（见 §5）。我把 `src/baizhi/credits.mjs` 的
`fetchProfile`（返回 `{name,userId}`）和 `src/monkeycode/credits.mjs` 的 `fetchProfile`（返回
`{userId,nickname}`）看串了 —— `sso-import.mjs` import 的是后者，`profile?.nickname` 本来就有值。
t25 发现了这件事并按「两个都认」加固，行为正确，但**R1 那句「accountId 恒为空」是错的**，此处撤回。

| 严重度 | 条数 | 说明 |
|---|---|---|
| blocker | **0** | — |
| high | **0** | H1 已修，且有 2 条测试在变异下真红 |
| medium | **0** | M1-M6 全部关闭（M1 另见 §5 的更正） |
| low（新增） | 3 | 负缓存 TTL 无测试、`AGREE_PROTOCOL_JS` 死导出、catalog 测试文件 CRLF |
| low（既有债） | 3 | 测试夹具路径、`spawn` 无 `error` 监听、发布态 tag |

---

## 1. 我这次怎么审的（不复述报告，全部自己跑）

1. **读全 diff**：`git diff` + 逐文件读 `src/monkeycode/provision.mjs`(351)、`src/monkeycode/sso-import.mjs`(461)、
   `src/baizhi/runtime.mjs`(920)、`src/monkeycode/runtime.mjs`(942)、`tests/provision.test.mjs`(829)、
   `tests/multi-provider.test.mjs`(929)、`tests/sso-import.test.mjs`、`tests/catalog.test.mjs`(408)。
2. **跑门禁**：上面那张表，逐条本机执行。
3. **自建变异**：把整仓复制到 `%TEMP%\mut2\`，逐条把**修复本身**改回坏形态，跑目标测试文件，
   要求**必须真红**（§2 表）。仓库零改动（`git diff --check` 无输出可证）。
4. **行为探针**：H1 的「轮询放大」不靠读代码下结论，直接数上游请求（§3）。
5. **文档交叉核对**：R1 报的 5 处过期表述逐条 grep；`npm pack` 的文件清单逐条看。

---

## 2. 逐条复核（R1 的每一条 → 修复 → 我的独立证据）

### 2.1 H1 — `accept()` 轮询放大（R1 唯一 high）

**修复落点**：`src/baizhi/runtime.mjs:303-321`（`negativeExchange` / `NEGATIVE_TTL_MS = 5_000` /
`readNegative`）、`:326-334`（`performExchange` 非 ok 一律入负缓存）、`:347-355`（`exchangeOf` 读序
= 定论 → 负缓存 → 真兑换）、`:371-376`（`exchangeForSignIn` **入口** `negativeExchange.delete(key)`）。

**行为探针（我自己数的请求）**：

```
匿名会话 6 次 accept（模拟 6 秒轮询）→ GET=1 POST=0（改动前是 6 / 0）

needsKeyCreation 形态 3 次 accept →
  GET /api/console/api-keys → POST /api/console/api-keys → GET /api/console/api-keys
  | POST 次数: 1（改动前是 3）
```

**变异**（改回坏形态，必须红）：

| 变异 | 结果 | 红在哪 |
|---|---|---|
| H1-a 去掉负缓存读取（`const throttled = undefined`） | 🔴 RED | `✖ 轮询负缓存：匿名会话连续 3 次 accept 只打 1 次上游`、`✖ needsKeyCreation 反复 accept 不会每秒 POST 建一把 Key` |
| H1-b 让收尾（finishSignIn）也读负缓存 | 🔴 RED | `✖ 建 Key 后的重试必须能恢复`、`✖ finishSignIn 不读轮询负缓存` |
| H1-c/d 负缓存永不过期（两种等价写法） | 🟢 **漏网** | 见 L-1 |

**结论**：H1 关闭。**反面（不能过度）也锁住了** —— 收尾一旦读负缓存，两条 recovery 用例立刻红，
这正是 t15 那个「建好 Key 也恢复不了」的形态。

### 2.2 M1 — 账号显示名

**修复落点**：`src/monkeycode/sso-import.mjs:307-312` `nicknameOf(profile)`（`name` 优先、回退
`nickname`、trim、空白不编造），`:402` 用它。

| 变异 | 结果 | 红在哪 |
|---|---|---|
| M1 `nickname: undefined` | 🔴 RED | `✖ signInWithBaizhiSession 必须走 nicknameOf` |
| M1b `nicknameOf` 只认 `nickname` 字段 | 🔴 RED | `✖ 显示名：只有 name（上游实测形状）时也不能丢` |

**结论**：关闭（**但 R1 的前提本身是错的，见 §5**）。修法比 R1 的字面建议更稳：
只写 `profile?.name` 反而会让真实路径塌成 undefined。

### 2.3 M2 — 返回值 / 日志脱敏

**修复落点**：`src/monkeycode/provision.mjs:190-199` 的 `scrubber` 两层（① 已知值 ② 按形状
`SECRET_FIELD` + `BARE_SECRET`），顶层兜底 catch `:342-348` 也走同一个 scrubber 并留一行日志。

| 变异 | 结果 | 红在哪 |
|---|---|---|
| M2 返回值改回裸 `message` | 🔴 RED | `✖ ⑬ SSO 抛出的错误里带着会话串与凭据` |
| M2b 去掉「按形状」那层（`return text`） | 🔴 RED | `✖ ⑬ …`、`✖ ⑬c 意料之外的抛错（顶层兜底）也必须脱敏` |

**结论**：关闭。**R1 的「t19 只有实测没有测试」现在有 3 条**（⑬ / ⑬b / ⑬c），三种失败路径全覆盖。

### 2.4 M3 — 「读到 cookie ≠ 登录成功」的**接线**

**修复落点**：`src/baizhi/runtime.mjs:445`（`startBaizhiBrowserLogin(..., { start = startBrowserLogin })`
注入接缝）+ `:459` `accept: (cookie) => acceptBrowserCookie(cookie, site)`；
`src/monkeycode/runtime.mjs:707` `accept: verify`。

| 变异 | 结果 | 红在哪 |
|---|---|---|
| M3 百智云侧 `accept: async () => true`（= 0.2.42 修掉的那个真机 bug） | 🔴 RED | `✖ 接线：startBaizhiBrowserLogin 真的把 accept 接到 acceptBrowserCookie` |
| M3b 国内站侧 `accept: async () => true` | 🔴 RED | `✖ 国内站 SSO 的窗口 accept 必须接 verify` |

**结论**：关闭。两侧都是**行为**断言（匿名 → false、真会话 → true），不是纯源码 grep。

### 2.5 M4 — `openPage` 失败路径的孤儿进程

**修复落点**：`src/monkeycode/sso-import.mjs:236-298` —— `port → profile → spawn → 调试端口 →
WebSocket → CDP` 全在 `try` 里，`catch` 里 `ws?.close()` → `close()`（杀 child + 删临时 profile）→ `throw`。

| 变异 | 结果 | 红在哪 |
|---|---|---|
| M4 `catch` 里只 `throw error`（不收尸） | 🔴 RED | `✖ openPage：WebSocket 连不上时必须收尸`、`✖ openPage 的结构锁` |

**结论**：关闭。动态用例真的断言「`%TEMP%` 里没有新增 `magpie-sso-*`」。

### 2.6 M5 — 文档过期表述

| R1 报的位置 | 现状（我 grep 的） |
|---|---|
| `:445`「需要拍板，本文不默认采用」 | 已改为「**B（已采用）**」并写明 `ask()` 依次问 `invite` → `monkeycodeInvite` |
| `:535` R7「需要拍板」 | 已同步 |
| `:503` 引用 `tests/host-record-contract.test.mjs`（不存在） | 改为「由 `tests/provision.test.mjs` 的注入式假 client 覆盖（没有为它单开文件）」 |
| `:571`「tests 280」 | 改为 **330/330**（我实测 330，一致） |
| `:585`「7 个变异」 | 改为「按 M1–M7 逐条验红」，不再写总数 |
| `:583`「existingAccountWithUid 改为调用 readProvisionedAccounts」（未做） | 已做（`src/monkeycode/runtime.mjs:56-59`），且提法改成「去重口径只留一处」 |

`grep -rn "需要拍板|待拍板|host-record-contract|未完成|待契约" docs/auto*.md README.md docs/internals.md`
→ **0 命中**。

**结论**：关闭。

### 2.7 M6 — 旧缓存 `displayName` 重算

| 变异 | 结果 | 红在哪 |
|---|---|---|
| M6 `readCatalog` 直接 `return model`（不重算） | 🔴 RED | `✖ readCatalog ⑤：旧缓存…读出即重算`、`✖ readCatalog + filterByTier…` |

**结论**：关闭。新用例还顺带锁了「**只读不改文件**」（缓存文件逐字未变）与「`providerId` 不串站」。

### 2.8 L1 — TOCTOU（读盘 → 写之间没有互斥）

**修复落点**：`src/monkeycode/provision.mjs:212-228` 模块级 `writeQueue` + `withWriteLock`；
预检读保留（快速失败不占锁），临界区里重读 → 判键 → 写 → 回读 → 台账；队尾 `mine.then(noop, noop)`
防毒化。

| 变异 | 结果 | 红在哪 |
|---|---|---|
| L1 去掉 `withWriteLock` | 🔴 RED（12 条红） | `✖ ⑪ 两个不同 cookie 同时从空库开通…`（以及 ④/⑤/⑥/⑦/⑧/⑨/⑪b/⑬b/⑬c 的连带失败） |

**结论**：关闭。⑪ 断言的是「两次写落在**不同**键、两条都在库里、两个都 ok:true、返回键 == 真写下的键」，
不是「跑过就算」。

### 2.9 L2 — 前置闸的 `skipped` 必须精确

| 变异 | 结果 | 红在哪 |
|---|---|---|
| L2 `skipped: "no-client"` 改成 `"no-client-x"` | 🔴 RED | `✖ ⑫ 四个前置闸各自返回精确的 skipped，且都先于 SSO` |
| L2b **删掉** `no-client` 闸 | 🔴 RED | 同上 |
| L2c **删掉** `no-sso` 闸 | 🔴 RED | 同上 |

**结论**：关闭。R1 那三个「只断言 ok:false」的漏网全部补上，而且顺带锁了「闸在 SSO 之前」。

### 2.10 L3 — 国内站 `accept` 接线 / 邀请码落盘

| 变异 | 结果 | 红在哪 |
|---|---|---|
| M3b（= L3 前半） | 🔴 RED | `✖ 国内站 SSO 的窗口 accept 必须接 verify` |
| R4 删掉 `inviteStore.write(inviteCode, …)` | 🔴 RED | `✖ 国内站 authorize 把邀请码落到 monkeycode-invite.json` |

> ⚠ 我第一次跑 R4 时指错了目标文件（`multi-provider.test.mjs` 而不是 `sso-import.test.mjs`），
> 得到假绿；换对文件后真红。**这条记在我头上，不是实现的问题。**

### 2.11 L4 — 毒点判据只留一处

**修复落点**：`src/monkeycode/runtime.mjs:56-59` 改调 `readProvisionedAccounts(providerId)`
（坏库 → `false`），并删掉 `node:fs` / `node:os` / `node:path` 三条 import。

| 变异 | 结果 | 红在哪 |
|---|---|---|
| L4 前缀判据写成 `startsWith(providerId)`（漏 `#`） | 🔴 RED | `✖ 判重：坏库=false，monkeycodeintl 不算国内站` |

**结论**：关闭。

### 2.12 L5 — README 的 `docs/*.md` 链接不在 npm 包里

`package.json` 的 `files` 加了 `"docs"`；`npm pack --dry-run | grep -c "docs/"` → **6**；
6 份文档全部存在。**结论**：关闭。

### 2.13 L6 / L7

- **L7（env 未文档化）**：README `:139-140` 新增「两个环境变量」表，语义与
  `src/monkeycode/catalog.mjs:47`、`:141-142` 逐字一致。**关闭**。
- **L6（测试夹具 `C:\__magpie_test_cache__` 实为驱动器相对路径）**：**仍在**
  （`grep -rn -F 'C:\__magpie_test_cache__' tests/` → 24 处 / 4+ 个文件）。转成既有债，见 L-5。

---

## 3. 四道门禁的完整真实输出

```
$ MAGPIE_PLUGIN_DISABLE_BROWSER=1 node --test
ℹ tests 330
ℹ suites 0
ℹ pass 330
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4927.2277
EXIT=0
```

```
$ node scripts/check.mjs
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
npm notice package size: 551.4 kB
npm notice unpacked size: 1.5 MB
npm notice shasum: a7fbea7b9f1d0431fb01845389e3c7d49e6cd97c
npm notice total files: 118
EXIT=0
（其中 docs/ 命中 6 条）
```

```
$ git diff --check
（stdout 无输出）
warning: in the working copy of 'tests/catalog.test.mjs', CRLF will be replaced by LF the next time Git touches it
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

> ⚠ **这条 `失败 1` 是发布态要求，不是代码缺陷**；但它的存在意味着**现在仍然不能写「已发布」**。

---

## 4. 我自建的变异矩阵（19 次执行 / 18 条有效变异 / 17 红 / 1 绿）

全部在 `%TEMP%\mut2\base` 的**整仓副本**上做，仓库零改动。

| # | 变异（把修复改回坏形态） | 契约 | 结果 |
|---|---|---|---|
| 1 | H1-a 去掉负缓存读取 | 轮询不重复 GET | 🔴 2 条红 |
| 2 | H1-b 收尾读负缓存 | 重试可恢复 | 🔴 2 条红 |
| 3 | H1-c/d 负缓存永不过期（2 种写法） | TTL 5 秒 | 🟢 **漏网（L-1）** |
| 4 | L1 去掉写锁 | 跨 cookie 并发不覆盖 | 🔴 12 条红 |
| 5 | M1 `nickname: undefined` | 登录带显示名 | 🔴 1 条红 |
| 6 | M1b `nicknameOf` 只认 nickname | 只有 name 也不丢 | 🔴 1 条红 |
| 7 | M3 百智云侧 `accept` 恒 true | 匿名 ≠ 登录完成（百智云） | 🔴 1 条红 |
| 8 | M3b 国内站侧 `accept` 恒 true | 匿名 ≠ 登录完成（国内站） | 🔴 1 条红 |
| 9 | M2 返回值不脱敏 | SSO 抛错的返回值脱敏 | 🔴 1 条红 |
| 10 | M2b 去掉「按形状」层 | 脱敏第二层 | 🔴 2 条红 |
| 11 | L2 `skipped` 取值写错 | 前置闸精确 | 🔴 1 条红 |
| 12 | L2b 删掉 `no-client` 闸 | 缺 client 不跑 SSO | 🔴 1 条红 |
| 13 | L2c 删掉 `no-sso` 闸 | 缺 sso 不跑 SSO | 🔴 1 条红 |
| 14 | M4 `catch` 不收尸 | 失败不留孤儿 | 🔴 2 条红 |
| 15 | R4 邀请码不落盘 | 邀请码写策略文件 | 🔴 1 条红 |
| 16 | M6 旧缓存 `displayName` 不重算 | 读时重算 | 🔴 2 条红 |
| 17 | L4 前缀判据漏 `#` | `monkeycodeintl` 不串味 | 🔴 1 条红 |

**怎么读这张表**：R1 的 22 红 / 9 绿里，**9 条漏网现在只剩 1 条**（负缓存 TTL），其余 8 条全部补上了
能真红的测试。剩下 1 条是「设计常量的取值没有测试」级别，不是行为缺陷（见 L-1）。

---

## 5. 对 R1 的更正（诚实记录）

**R1 的 M1 是误报。** 我当时读的是 `src/baizhi/credits.mjs:149` 的 `fetchProfile`（返回 `{name, userId}`），
但 `src/monkeycode/sso-import.mjs:41` import 的是 `./credits.mjs`，也就是
`src/monkeycode/credits.mjs` 的 `fetchProfile` —— 它返回 `{userId, nickname}`，并且已经把上游的
`name` / `display_name` / `username` 归一进 `nickname`（`:106-114` 的注释写明「上游实际下发的字段是 `name`」）。

所以：
- **R1 那句「`accountId` 恒为空、卡片显示供应商名」不成立**，撤回。
- t25 的修法（`nicknameOf` 两个都认）**行为正确、更稳**，但它不是「修一个真 bug」，
  而是给一个本来就对的路径加保险 + 加测试。这一点必须写清楚，否则后来的人会以为真出过这个故障。

R1 的其余结论我复核后**全部成立**。

---

## 6. 仍未验的真机事项（**不许**当成通过）

| # | 项 | 为什么本机验不了 | 怎么验 |
|---|---|---|---|
| U1 | 真机 `client.auth.set({path:{id},body})` 真的把记录写进 `~/.config/magpie/plugin-auth.json` | 需要真 magpie 宿主 + 真账号；本机 `Programs/magpie` 只有 `magpie.exe`，**宿主 `host.js` 源码不可读**，R1 §2.1 引用的 `host.js:1037/1120/2456` 我**无法独立复核** | 真机探针：登录百智云 → `grep -c '"monkeycode"' ~/.config/magpie/plugin-auth.json`，**只读一次、不打印内容** |
| U2 | magpie 收到 `{event:"auth"}` 后会不会重跑插件工厂 | 同上（客户端 RPC 不在源码里） | 看 `app.log` 里插件加载次数；若会重跑，`provision.mjs` 的模块级 `writeQueue` / `inFlight` 会随新模块实例失效（**H1 的修复在重跑语义下仍然成立，因为它无状态**；但单飞会退化） |
| U3 | 上游 `POST /api/console/api-keys` 的真实行为（最终一致性窗口、字段名） | 会写真实账号 | 真机只读探测 |
| U4 | **负缓存 5 秒 TTL 在真机上的观感**：登录页的 cookie 是否会在登录瞬间**换值** | 需要真人扫码 | 换值 ⇒ 立即命中，无延迟；不换值 ⇒ 最坏多等 5 秒。两种都可接受，但**没有实测** |
| U5 | 五种百智云登录方式（微信 / 支付宝 / 抖音 / GitHub / 观猹 + 账号密码）真机都能登完并换出 Key | 需要真人 | 逐种点一次，看 `finishSignIn` 是否 `type:"success"` 且 uid 是**这一次**的 |
| U6 | 邀请码在**真实上游**上确实被消费（`inviter_id` 生效） | 会消耗真实邀请关系 | 用测试号开一次，看上级是否到账 |
| U7 | 安装 / 打包后的真实行为 | 本任务禁安装、禁发布 | 发布门 2：`release.mjs --yes` 后再走 CHECKLIST B 表五条 |
| U8 | 国际站真机登录与模型列表 | 没有国际站账号 | 登录一次，`/v1/models` 里应有 `monkeycodeintl` |

---

## 7. 剩余的 low（记录即可，不阻塞）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| L-1 | `src/baizhi/runtime.mjs:302` `NEGATIVE_TTL_MS = 5_000` | **负缓存 TTL 没有测试**：把 `readNegative` 的过期判断改成 `if (false)`、或把 TTL 改成 `Infinity`，两条等价变异**都不红**。后果：若将来把 TTL 写成永久，匿名 cookie 串若在登录瞬间不换值，`accept` 会一直读到过期的 `false`，用户登完也等不到（240 秒超时） | 让 `readNegative(key, now)` 的 `now` 可注入（`_internal.readNegative`）或 `t.mock.timers`，加一条「6 秒后过期 → 重新请求」 |
| L-2 | `src/baizhi/runtime.mjs:493` `export const AGREE_PROTOCOL_JS` | **死导出**：全仓没有任何 `import`（`grep` 只有定义 + 测试里的「禁止接线」锁）。它是一段「自动点第 4 个图标（观猹）/ 自动勾协议」的脚本 —— 正是产品明确禁止的行为，留着就是给未来误接 | 删掉，或保留但把「这是陷阱、绝不接线」写进 JSDoc 首行 |
| L-3 | `tests/catalog.test.mjs` | 工作副本是 **CRLF**（408 行），索引里是 LF ⇒ `git diff --check` 每次都往 stderr 打一条 CRLF 警告。`EXIT=0`，无功能影响 | 提交前 `git add --renormalize` 或统一 LF（仓内 27 个文件是 CRLF，属于既有混用） |
| L-4 | `src/monkeycode/sso-import.mjs:250` | `spawn(...)` 之后**没有挂 `'error'` 监听**：若浏览器路径存在但不可执行（EACCES / AppContainer），Node 会抛 `ERR_UNHANDLED_ERROR`（未捕获异常），而不是走 `catch` 收尸。`findBrowser()` 用 `existsSync` 只保证「存在」 | `child.on("error", …)` 转成 reject（**既有问题**，本次未动） |
| L-5 | `tests/*.test.mjs`（4+ 文件） | `process.env.MAGPIE_MONKEYCODE_CACHE_DIR = "C:\__magpie_test_cache__"` —— 未转义反斜杠，实际值是 **`C:__magpie_test_cache__`**（驱动器相对路径）。目前没有落盘（目录不存在），但这条夹具写的不是它看起来的路径 | 改成 `join(tmpdir(), …)`（**既有问题**） |
| L-6 | 发布态 | `check-maintenance.mjs` 失败 1：0.2.42 无 tag | 由发布负责人 `git tag v0.2.42 && git push origin v0.2.42`；**在此之前不能宣称已发布** |

---

## 8. 给 captain 的门禁判词

**可以合。** 代码与文档我逐行看过、跑过、变异过：

- **登录面**：`monkeycode` 1 条（百智云 SSO）/ `monkeycodeintl` 4 条 / `baizhi` 2 条；百智云浏览器登录两格可选邀请码
  （两个不同策略文件）；五种登录方式只写在 instructions，自动点脚本已删。
- **自动开通**：`finishSignIn` 里 fire-and-forget（微任务包一层，同步抛错也不砸登录）、失败不改百智云结果、
  目标站点是常量 `SITES.monkeycode`、同 cookie 单飞 + 跨 cookie 写锁；
  写前读盘（坏库 / uid 空不写）→ 确定性键 → `auth.set` → 回读四样 → 台账。
- **测试**：330 条全绿，且 17 条关键变异真红 —— 不是空跑。
- **剩下的是真机与发布**：U1-U8 我一条都没验，**不能写「已真机」**；`check-maintenance` 仍失败 1，
  **不能写「已发布」**。

**建议的下一步**（按顺序）：① 修 L-1（10 行以内，补 TTL 测试）→ ② 真机探针 U1/U2 → ③
`git tag v0.2.42` + push → ④ 走 CHECKLIST B 表五条 → ⑤ 才允许改 CHANGELOG 的「已发布」口径。

---

## 9. 一句话

**R1 的 1 个 high + 6 个 medium 全部真修，17 条变异证明测试不是空跑，四道门禁全绿 —— blocker 0、high 0，
可以合。** 唯一遗留的「负缓存 5 秒 TTL 没有测试」是新 low，加上 5 条既有债和 8 项真机未验，一条都没被我说成通过。

---

# R2.1 · 补验：负缓存 TTL 过期（关闭 L-1）

> 追加于 2026-11-09。**R2 正文（§0-§9）一字未改**，其中的数字是 t29 时点的真实值；
> 本节记录 t30 补测之后的**当前**真实值。审核人仍为 `final-reviewer`，仍未修改任何实现/测试/断言。

## R2.1.1 L-1 是什么、补了什么

R2 §7 的 L-1：t24 的轮询负缓存把「1 请求/秒」降到「5 秒最多 1 次」，但**过期那一侧没人守** ——
把 `NEGATIVE_TTL_MS` 写成 `Infinity`、或删掉 `now - hit.at >= NEGATIVE_TTL_MS` 那个分支，
R2 时点的全量测试**全绿**。这正是「实现对、但没人守着」的形态：将来谁改成永久缓存，
`accept()` 会一直读到过期的 `false`，用户登完之后窗口停在「还没登完」，直到 240 秒超时。

t30 只改 `tests/multi-provider.test.mjs`（+1 条用例，生产文件 0 行改动），
用钉死 `Date.now` 的方式把三个时间点摆出来：**t=0 → t=+4999ms → t=+5001ms**。

## R2.1.2 这条测试断言了什么（我逐行读过）

| 时点 | 断言 | 守的是哪条 |
|---|---|---|
| t=0 | `accept === false`，**GET = 1** | 第一次轮询真的打上游（否则负缓存无从谈起） |
| t=+4999ms | `accept === false`，**GET 仍 = 1** | 5 秒内不重复打上游 —— 负缓存没生效就是 H1（1 请求/秒）复现 |
| t=+5001ms（会话已切有效） | `accept === true`，**GET = 2** | 过期后必须重新请求**且能接受真会话** —— TTL=Infinity 会让用户等到 240 秒超时 |
| 再 accept | `accept === true`，**GET 仍 = 2** | 换出 sk- 之后进**定论**缓存（负缓存只影响「没换出 Key」） |

`finally { Date.now = realNow }` 恢复时钟，不污染同进程其它用例。**它没有放松任何既有断言**，
是纯增量。

## R2.1.3 变异（临时副本，仓库零改动）

`%TEMP%\mut3\base` 整仓拷贝 → 逐条把「过期」改回坏形态 → 只跑 `tests/multi-provider.test.mjs`：

```
[match=1] A TTL 改成 Number.POSITIVE_INFINITY
   -> RED :: ℹ tests 28 / ℹ pass 27 / ℹ fail 1
      ✖ 轮询负缓存 TTL：5 秒内不重复打上游，过期后必须重新请求并能接受真会话（L-1）
      AssertionError [ERR_ASSERTION]: 过期后已经登完的会话必须被接受 —— 永远读旧负缓存会让用户等到 240 秒超时

[match=1] B 删掉「过期就作废」那个分支
   -> RED :: ℹ tests 28 / ℹ pass 27 / ℹ fail 1
      ✖ 轮询负缓存 TTL：5 秒内不重复打上游，过期后必须重新请求并能接受真会话（L-1）
      AssertionError [ERR_ASSERTION]: 过期后已经登完的会话必须被接受 —— 永远读旧负缓存会让用户等到 240 秒超时
```

**两条都真红，且红在同一条契约上**（不是「随便红了一个」）。R2 §4 的 18 条变异里唯一的漏网
（H1-c / H1-d）现在被这条用例补上 ⇒ **变异矩阵变成 19 条有效变异 / 19 红 / 0 绿**。

仓库侧改动为零：变异只在 `%TEMP%` 副本里做，目的文件复原后 `git status` 与 R2 时点一致。

## R2.1.4 补验时点重跑的四道门禁（**当前真实值**）

```
$ MAGPIE_PLUGIN_DISABLE_BROWSER=1 node --test
ℹ tests 331
ℹ suites 0
ℹ pass 331
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2020.2749
EXIT=0
```

```
$ MAGPIE_PLUGIN_DISABLE_BROWSER=1 node --test tests/multi-provider.test.mjs
ℹ tests 28
ℹ pass 28
ℹ fail 0
ℹ duration_ms 185.1233
EXIT=0
```

```
$ node scripts/check.mjs
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
npm notice filename: magpie-monkeycode-0.2.42.tgz
npm notice total files: 119
EXIT=0
（其中 docs/ 命中 7 条）
```

> ⚠ 这里**只记文件数，不记 shasum**：本节就在这个 tarball 里，任何一次改动本节的编辑都会让
> 哈希（以及体积的最后一位）跟着变 —— 写死一个哈希等于写一个下一分钟就过期的值。
> 实测口径：追加本节**之前** `package size: 561.4 kB`，本节自身约占 **2.3 kB**；
> **文件数两次都是 119**（`docs/` 7 条），因为 `docs` 早已在 `package.json` 的 `files` 里。

```
$ git diff --check
（stdout 无输出）
warning: in the working copy of 'tests/catalog.test.mjs', CRLF will be replaced by LF the next time Git touches it
EXIT=0
```

**数字口径**（不改 R2 正文，只在这里对齐）：

| 项 | R2（t29 时点） | R2.1（补验时点） |
|---|---|---|
| 全量测试 | 330 / 330 / 0 | **331 / 331 / 0** |
| `tests/multi-provider.test.mjs` | 27 / 27 | **28 / 28** |
| `npm pack` 文件数 / 体积 | 118 files / 551.4 kB | **119 files**（= 551.4 kB + 6 份 docs + 本节；体积随本节编辑漂移，只记文件数） |
| 包内 `docs/` 条目 | 6 | **7**（新增 `docs/final-review-r2.md` 自身） |
| 自建变异（红/绿） | 17 红 / 1 绿 | **19 红 / 0 绿** |

## R2.1.5 结论（与 R2 一致，不放宽）

- **blocker = 0，high = 0。**（本轮没有任何新发现能升到这个级别）
- **medium = 0。**
- **L-1 关闭**：TTL 过期那一侧现在有测试，两条等价变异都真红。
- 剩余 low 仍是 R2 §7 的 **L-2**（`AGREE_PROTOCOL_JS` 死导出，自动点观猹脚本，建议删）、
  **L-3**（`tests/catalog.test.mjs` 工作副本 CRLF，`git diff --check` 只打 stderr 警告、EXIT=0），
  以及既有债（测试夹具 `C:\__magpie_test_cache__` 实为驱动器相对路径、`spawn` 无 `error` 监听、发布态 tag）。
- **未验事项一条都没变，也不许说成通过**：
  U1 真机 `client.auth.set` 落盘、U2 magpie 是否会重跑插件工厂、U3 上游建 Key 的最终一致性、
  U4 负缓存 5 秒 TTL 的真机观感（登录瞬间 cookie 是否换值）、U5 五种百智云登录方式、
  U6 邀请关系真实消费、U7 安装 / 打 tag / 发布、U8 国际站真机。
- `node scripts/check-maintenance.mjs` 仍 **通过 4 · 警告 1 · 失败 1**（0.2.42 无 tag）——
  **在 `git tag v0.2.42 && git push origin v0.2.42` 之前，任何地方都不许写「已发布」。**

## R2.1.6 一句话

**L-1 补验通过：TTL 两条等价变异都真红，全量 331/331、check 49 通过、privacy 0 处、
pack 119 files（`docs/` 7 条）、`git diff --check` EXIT=0 —— blocker 0、high 0 不变，可以合；
真机与发布仍未验，一条都没被说成通过。**

---

# R2.2 · 补验：低风险收尾（t32 死脚本 / t33 启动器 error）—— 附 **1 个门禁 blocker**

> 追加于 2026-11-09。**R2 / R2.1 正文一字未改**（1-512 行原样），本节只记 t32 / t33 的补验结果。
> 审核人仍为 `final-reviewer`，仍未修改任何实现/测试。

## R2.2.1 t32 —— 自动点登录方式的死脚本（关 L-2）

**核验 1：生产 `.mjs` 零残留**

```
$ grep -rn "AGREE_PROTOCOL_JS|ways\[3\]\.click|watcha" --include="*.mjs" src/ index.mjs scripts/ | wc -l
0
```

**核验 2：五种官方登录方式仍对用户可见**（`src/baizhi/runtime.mjs:765-769`）

```
· 上方大二维码 = 微信扫码
· 下方四个小图标 = 支付宝 / 抖音 / GitHub / 观猹
```

五种全在说明里；`onPoll` 恒不传（自动点不可能被接线）。

**核验 3：残留只出现在测试的「反向断言」里**（`tests/multi-provider.test.mjs:161/176/177`），
这是**故意**的 —— 两条 `doesNotMatch` 就是防复活的锁。

**变异（%TEMP% 副本，把死脚本写回生产源码）**：

```
[match=1] t32-M1 把「自动点第 4 个图标」死脚本写回生产源码
   -> RED :: ℹ tests 28 / ℹ pass 27 / ℹ fail 1
      ✖ 五种官方方式都要可用：说明里列全，且绝不替用户点某一种
```

**L-2 关闭。**

## R2.2.2 t33 —— 启动器 `error` 事件（ENOENT / EACCES）

**代码核验**（`src/monkeycode/sso-import.mjs:244-258` `spawnFailure`、`:288-290` `child.on("error")`、
`:296` 循环内提前 `throw`、`:304` 循环后兜底、`:325-331` catch 收尸）：

- `spawnFailure` 把系统错拼成 `受控浏览器启动失败（<code>）：<message>`，保留 `code` 与 `cause`；
- `spawn` 之后**必须** `child.on("error", …)` —— 没有监听器时 ENOENT 是 uncaught exception（掀掉插件进程）；
- 轮询循环**每轮先判 `spawnError` 再睡** ⇒ 快速失败而不是空等 60 秒；
- 失败进同一 `catch`：`ws?.close()` → `close()`（kill child + `rmSync` 临时 profile）→ 原样 `throw`。

**变异（4 条，全部真红）**：

```
[match=1] t33-M1 去掉 child.on("error") 监听器
   -> RED :: ℹ tests 15 / ℹ pass 13 / ℹ fail 2
      ✖ openPage：启动器 ENOENT 必须快速 reject（不空等 60 秒）且不留临时 profile (400.9ms)
      ✖ openPage 的 error 监听是结构锁：spawn 之后必须 on("error")，循环里提前 throw

[match=1] t33-M2 去掉轮询循环里的提前 throw（空等 60 秒）
   -> RED :: ℹ tests 15 / ℹ pass 13 / ℹ fail 2
      ✖ openPage：启动器 ENOENT 必须快速 reject（**60364.9ms** —— 就是「空等满 60 秒」的实测）
      ✖ openPage 的 error 监听是结构锁

[match=1] t33-M3 丢掉系统错误码 failure.code = code
   -> RED :: ℹ tests 15 / ℹ pass 13 / ℹ fail 2
```

M2 的 60 秒耗时本身就是证据：没有「循环内提前 throw」，用户要等到 60 秒超时才看到一句
「没有打开调试端口」，真实原因（没装 / 没权限）全丢。

## R2.2.3 🔴 **新发现 blocker B1 —— 门 1 红了（t33 引入）**

**现象**（我在补验时跑的，**t33 的报告没有跑这一条**）：

```
$ node scripts/check.mjs
  ✗ 错误出口都带 status + code，且 code 在 ERROR-CODES 词表内
      sso-import.mjs:245 R2 错误帧里的 code "unknown" 不在词表里
      → ERROR-CODES.md §4（R1-R9）· §6 有最小实现模板

  通过 48 · 警告 0 · 失败 1
$ echo $?
1
```

**根因（我复现了匹配过程，确认是误判）**：

```js
// src/monkeycode/sso-import.mjs:245
const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : "unknown"
```

`scripts/check-error-codes.mjs:172` 的 R2 正则是 `/\bcode\s*:\s*["'`]([a-z0-9_]+)["'`]/g`。
它把三元表达式里的 **`error.code : "unknown"` 当成对象字面量 `code: "unknown"`**：

```
line 245: "code : \"unknown\""  ← 上下文: const code = ... ? error.code : "unknown"
```

这个 `code` 是**系统错误码**（`ENOENT` / `EACCES`），故意不在 magpie 的 `ERROR-CODES` 词表里
（它不走 chat 通道，是抛给 `signInWithBaizhiSession` 调用方的内部错）。

**为什么仍然是 blocker**：仓库的**门 1**（`AGENTS.md`「代码交付」）要求
`node scripts/check.mjs` 退出码 = 0。现在是 1 —— 无论误判与否，**这道门是红的，不能交付**。
而且 t29 / t31 都实测过 49/0/0，**是 t33 把它打红的**（回归），不是既有债。

**修法（二选一，我倾向 ①）**：

1. **生产侧一行**（不动门禁）：把兜底值提出来，避免 `xxx.code : "…"` 这个形状 ——
   ```js
   const fallback = "unknown"
   const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : fallback
   ```
   或 `const raw = typeof error?.code === "string" ? error.code.trim() : ""` + `raw.length > 0 ? raw : "unknown"`。
   改完 `check.mjs` 应回到 49/0/0，且 t33 的 4 条变异仍然真红（`failure.code = code` 一行不用动）。
2. **门禁侧**（需要谨慎）：R2 正则要求前面是 `{` 或 `,`（只认对象字面量的键），
   并给 `check-error-codes` 加一条「三元里的 `x.code` 不算」的回归用例 —— **改门禁必须带测试**，
   否则就是「为了变绿而放松断言」，我**不建议**在收尾阶段做。

**给 captain**：B1 修完（推荐方案 1）需要再跑一次 `check.mjs` 确认 49/0/0；在那之前**不要合并**。

## R2.2.4 补验时点重跑的门禁（**当前真实值**）

```
$ MAGPIE_PLUGIN_DISABLE_BROWSER=1 node --test
ℹ tests 333
ℹ suites 0
ℹ pass 333
ℹ fail 0
ℹ duration_ms 4485.5502
EXIT=0
```

```
$ node scripts/check.mjs
  通过 48 · 警告 0 · 失败 1      ← 🔴 见 B1
EXIT=1
```

```
$ node scripts/privacy-scan.mjs
privacy-scan: PASS（0 处）
EXIT=0
```

```
$ npm pack --dry-run
npm notice filename: magpie-monkeycode-0.2.42.tgz
npm notice package size: 564.5 kB
npm notice total files: 119
EXIT=0
（其中 docs/ 命中 7 条）
```

```
$ git diff --check
（stdout 无输出）
warning: in the working copy of 'tests/catalog.test.mjs', CRLF will be replaced by LF the next time Git touches it
EXIT=0
```

**数字口径**（R2.1 → R2.2）：

| 项 | R2.1（t31 时点） | R2.2（补验时点） |
|---|---|---|
| 全量测试 | 331 / 331 / 0 | **333 / 333 / 0**（t33 新增 2 条） |
| `check.mjs` | 通过 49 · 失败 0 | **通过 48 · 失败 1**（🔴 B1） |
| `npm pack` 文件数 | 119 files | **119 files**（`docs/` 7 条；体积随本节编辑漂移，仍只记文件数） |
| 自建变异（红/绿） | 19 红 / 0 绿 | **23 红 / 0 绿**（+t32-M1、t33-M1/M2/M3） |

## R2.2.5 结论

| 严重度 | 条数 | 说明 |
|---|---|---|
| blocker | **1** | **B1：`check.mjs` 退出 1（门 1 红，t33 引入的 R2 误判）** |
| high | 0 | — |
| medium | 0 | — |
| low | 3 | L-3（catalog 测试 CRLF）、L-4（`docs/internals.md:227` 仍写「AGREE_PROTOCOL_JS 留在源码里但没有接线」—— 已整段删除，**文档过期**，由 t32 上报，不在我的写作用域）、L-5（测试夹具 `C:\__magpie_test_cache__` 实为驱动器相对路径） |

- **L-1（负缓存 TTL）关闭**（R2.1 已验，19 红 / 0 绿）。
- **L-2（`AGREE_PROTOCOL_JS` 死导出）关闭**（本节 t32-M1 真红）。
- t33 的「`spawn` 无 `error` 监听」风险**关闭**（4 条变异全真红，含 60 秒空等的实测）。
- 但 **门 1 红了 ⇒ 这次交付不能算通过**。verdict 见 §R2.2.6。

## R2.2.6 仍未验（一条都没说成通过）

U1 真机 `client.auth.set` 落盘、U2 magpie 是否会重跑插件工厂、U3 上游建 Key 的最终一致性、
U4 负缓存 5 秒 TTL 的真机观感、U5 五种百智云登录方式真机、U6 邀请关系真实消费、
U7 安装 / 打 tag / 发布、U8 国际站真机。
`check-maintenance.mjs` 仍是 **通过 4 · 警告 1 · 失败 1**（0.2.42 无 tag）——
**在 `git tag v0.2.42 && git push` 之前，任何地方都不许写「已发布」。**

## R2.2.7 一句话

**t32 / t33 的实现本身是对的（23 条变异全真红、L-1/L-2 关闭），但 t33 顺手把仓库门 1 打红了
（`check.mjs` 48/0/1，R2 正则把 `? error.code : "unknown"` 误判成对象字面量）。**
修法是一行（把兜底值提成变量），修完重跑 `check.mjs` 回到 49/0/0 才算收尾完成 ——
**在那之前不能合并**；真机与发布仍未验。

---

# R2.3 · 补验：B1 门禁修复（最终封闭）

> 追加于 2026-11-09。**R2 / R2.1 / R2.2 正文一字未改**（1-709 行原样），本节只记 B1 的修复复验。
> 审核人仍为 `final-reviewer`，仍未修改任何实现/测试/检查脚本。

## R2.3.1 修复落点（我逐行读过的当前代码）

`src/monkeycode/sso-import.mjs:244-247`：

```js
function spawnFailure(error) {
  const fallback = "unknown"
  const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : fallback
  const detail = error instanceof Error ? error.message : String(error)
  ...
}
```

兜底值被提成变量后，源码里**不再出现 `xxx.code : "…"` 这个形状**，`scripts/check-error-codes.mjs:172`
的 R2 正则也就匹配不到它。`failure.code = code`（`:249`）一行未动 —— 系统错误码仍原样带给上层。

## R2.3.2 门禁复验（B1 已关闭）

```
$ node scripts/check.mjs
  通过 49 · 警告 0 · 失败 0
EXIT=0
```

```
$ MAGPIE_PLUGIN_DISABLE_BROWSER=1 node --test tests/sso-import.test.mjs
ℹ tests 15
ℹ suites 0
ℹ pass 15
ℹ fail 0
ℹ duration_ms 3100.8214
EXIT=0
```

```
$ MAGPIE_PLUGIN_DISABLE_BROWSER=1 node --test
ℹ tests 333
ℹ suites 0
ℹ pass 333
ℹ fail 0
ℹ duration_ms 5111.7065
EXIT=0
```

```
$ node scripts/privacy-scan.mjs
privacy-scan: PASS（0 处）
EXIT=0
```

```
$ npm pack --dry-run
npm notice filename: magpie-monkeycode-0.2.42.tgz
npm notice package size: 568.6 kB
npm notice total files: 119
EXIT=0
（其中 docs/ 命中 7 条）
```

```
$ git diff --check
（stdout 无输出）
warning: in the working copy of 'tests/catalog.test.mjs', CRLF will be replaced by LF the next time Git touches it
EXIT=0
```

```
$ node scripts/check-maintenance.mjs
  通过 4 · 警告 1 · 失败 1
（唯一失败：当前版本 0.2.42 有 tag（v0.2.42）—— 纯发布态）
```

## R2.3.3 B1 判定的反证（证明「红的是门禁正则，不是行为」）

在 `%TEMP%\mut5` 的整仓副本里，把修复**改回** R2.2 时那个形态：

```
-  const fallback = "unknown"
-  const code = ... ? error.code : fallback
+  const code = ... ? error.code : "unknown"
```

```
$ cd %TEMP%\mut5\work && node scripts/check.mjs
  ✗ 错误出口都带 status + code，且 code 在 ERROR-CODES 词表内
      sso-import.mjs:245 R2 错误帧里的 code "unknown" 不在词表里
  通过 48 · 警告 0 · 失败 1
MUT_EXIT=1

$ cd %TEMP%\mut5\work && MAGPIE_PLUGIN_DISABLE_BROWSER=1 node --test tests/sso-import.test.mjs
ℹ tests 15 / ℹ pass 15 / ℹ fail 0
```

**两条合起来就是结论**：

| 形态 | `check.mjs` | 行为测试（spawn 相关 15 条） |
|---|---|---|
| 当前（兜底值提成变量） | **49 / 0 / 0** | 15 / 15 绿 |
| 改回三元内联 `? error.code : "unknown"` | **48 / 0 / 1（红）** | **15 / 15 绿（完全一样）** |

⇒ 两种写法的**运行时行为完全相同**（系统错误码照样带出去），差别只在门禁正则的**误读**。
所以 R2.2 的 B1 判定成立（「门 1 红、不能交付」），而修复是**零行为变更**的一行改写；
现在门禁回到 49/0/0。副本已删，仓库零改动。

## R2.3.4 L-4 重读（R2.2 的旧读数作废）

R2.2 记的 L-4 是「`docs/internals.md:227` 仍写『AGREE_PROTOCOL_JS 留在源码里但没有接线』」。
**我重新读了当前文件**（`docs/internals.md:225-236`），已经改过：

```
- 五种官方方式都要可用：微信扫码 / 支付宝 / 抖音 / GitHub / 观猹（外加账号密码）。
  登录页那排图标的第 4 个是观猹，所以插件绝不替用户点。自动点图标的
  AGREE_PROTOCOL_JS 已整段删除；tests/multi-provider.test.mjs 用 doesNotMatch 锁住生产代码里
  不出现 onPoll、自动脚本和 ways[3].click，防止以后误接。
  ...
  - 所有非 ok 结果还会进 5 秒轮询负缓存，只供 accept 抑制重复请求；finishSignIn 绝不读取，
    并在收尾时使它失效，因此建 Key 后的主动重试仍能恢复。
```

叙述与代码一致（删除 + `doesNotMatch` 防复活 + 5 秒负缓存 + 收尾作废），**L-4 关闭**。
R2.2 那条读数属于**时点快照**，不篡改，以此条为准。

## R2.3.5 最终结论

| 严重度 | 条数 | 说明 |
|---|---|---|
| **blocker** | **0** | B1 已修，`check.mjs` 回到 **49 / 0 / 0** |
| **high** | **0** | — |
| **medium** | **0** | — |
| low（既有债） | 3 | L-3 `tests/catalog.test.mjs` 工作副本 CRLF（`git diff --check` 只打 stderr 警告、EXIT=0）；L-5 测试夹具 `C:\__magpie_test_cache__` 实为驱动器相对路径；发布态 tag（见下） |

**已关闭**：R1 的 H1 / M1-M6 / L1-L5，R2 的 L-1 / L-2 / L-4，t33 的 spawn error 风险，以及 **R2.2 的 B1**。
**累计变异矩阵：23 条有效变异 / 23 红 / 0 绿**（R2.3 的 B1 反证是第 24 次执行，用于证明「门的红不是行为的红」）。

### 仍未验（一条都没说成通过）

U1 真机 `client.auth.set` 落盘 · U2 magpie 收到 `{event:"auth"}` 后是否会重跑插件工厂 ·
U3 上游 `POST /api/console/api-keys` 的最终一致性 · U4 负缓存 5 秒 TTL 的真机观感（登录瞬间 cookie 是否换值）·
U5 五种百智云登录方式真机 · U6 邀请关系真实消费 · U7 安装 / 打 tag / 发布 · U8 国际站真机。

`node scripts/check-maintenance.mjs` 仍是 **通过 4 · 警告 1 · 失败 1**（0.2.42 无 tag）——
**在 `git tag v0.2.42 && git push origin v0.2.42` 之前，任何地方都不许写「已发布」。**

## R2.3.6 一句话

**B1 修复复验通过：`check.mjs` 49/0/0、spawn 15/15、全量 333/333/0、privacy PASS、pack 119 files、
`git diff --check` EXIT=0；反证也成立（改回三元内联 → 门禁红、行为测试仍全绿）。
最终 blocker = 0、high = 0、medium = 0，L-4 关闭 —— 代码与文档这一轮可以合；
真机与发布仍未验，一条都没被说成通过。**

---

# R2.2 结项补记（attempt 2）· B1 关闭后的复跑

> 追加于 2026-11-09。**R2 / R2.1 / R2.2 / R2.3 正文一字未改**（1-866 行原样），本节只记 t34 第二次执行的复跑。
> 为什么需要这一节：t34 attempt 1 的结论是 **failed（B1：门 1 红）**；B1 已由 t35 修复并在 R2.3 复验。
> 本次（attempt 2）在**当前代码状态**上把 t34 的验收项全部重跑一遍，给出最终判定。

## A. t32 —— 生产 mjs 零残留 + 五种登录说明仍在（当前状态）

```
$ grep -rn "AGREE_PROTOCOL_JS|ways\[3\]\.click|watcha" --include="*.mjs" src/ index.mjs scripts/ | wc -l
0
```

```
src/baizhi/runtime.mjs:766  // 脚本会强点第 4 个图标（观猹），等于把另外四种从用户手里拿走。
src/baizhi/runtime.mjs:767  + "\n· 上方大二维码 = 微信扫码"
src/baizhi/runtime.mjs:768  + "\n· 下方四个小图标 = 支付宝 / 抖音 / GitHub / 观猹"
```

五种官方方式（微信 / 支付宝 / 抖音 / GitHub / 观猹）**全在说明里**，自动点脚本**只在注释里被禁止**。
**L-2 关闭。**

## B. t33 —— 启动器 error 事件（当前状态）

`src/monkeycode/sso-import.mjs:244-258` `spawnFailure`（`code` + `cause` 保留）、`:288-290` `child.on("error")`、
`:296` 循环内提前 `throw`、`:304` 循环后兜底、`:325-331` catch（`ws?.close()` → `close()` 杀 child + `rmSync` profile → throw）。

**变异（%TEMP%\mut6 整仓副本，当前代码状态下重跑，4/4 真红）**：

```
[match=1] t32-M1 把「自动点第 4 个图标」死脚本写回生产源码
   -> RED :: ℹ tests 28 / ℹ pass 27 / ℹ fail 1
      ✖ 五种官方方式都要可用：说明里列全，且绝不替用户点某一种 (5.3ms)

[match=1] t33-M1 去掉 child.on("error") 监听器
   -> RED :: ℹ tests 15 / ℹ pass 13 / ℹ fail 2
      ✖ openPage：启动器 ENOENT 必须快速 reject（不空等 60 秒）且不留临时 profile (162.0ms)
      ✖ openPage 的 error 监听是结构锁 (1.3ms)

[match=1] t33-M2 去掉轮询循环里的提前 throw（空等 60 秒）
   -> RED :: ℹ tests 15 / ℹ pass 13 / ℹ fail 2
      ✖ openPage：启动器 ENOENT 必须快速 reject（**60861.6ms** —— 就是「空等满 60 秒」的实测）
      ✖ openPage 的 error 监听是结构锁 (0.8ms)

[match=1] t33-M3 丢掉系统错误码 failure.code = code
   -> RED :: ℹ tests 15 / ℹ pass 13 / ℹ fail 2
```

M2 的 60.8 秒耗时就是判据：没有「循环内提前 throw」时，用户要等满 60 秒才看到一句
「没有打开调试端口」，真实原因（没装 / 没权限）全丢。副本已删，仓库零改动。

## C. 本次重跑的门禁（当前真实值）

```
$ node scripts/check.mjs
  通过 49 · 警告 0 · 失败 0
CHECK_EXIT=0
```

```
$ MAGPIE_PLUGIN_DISABLE_BROWSER=1 node --test tests/sso-import.test.mjs
ℹ tests 15 / ℹ pass 15 / ℹ fail 0
```

```
$ MAGPIE_PLUGIN_DISABLE_BROWSER=1 node --test
ℹ tests 333 / ℹ pass 333 / ℹ fail 0
FULL_EXIT=0
```

```
$ node scripts/privacy-scan.mjs
privacy-scan: PASS（0 处）
PRIVACY_EXIT=0
```

```
$ npm pack --dry-run
npm notice version: 0.2.42
npm notice filename: magpie-monkeycode-0.2.42.tgz
npm notice package size: 569.5 kB
npm notice total files: 119
EXIT=0
（其中 docs/ 命中 7 条）
```

```
$ git diff --check
（stdout 无输出）
warning: in the working copy of 'tests/catalog.test.mjs', CRLF will be replaced by LF the next time Git touches it
DIFFCHECK=0
```

## D. 判定

| 严重度 | 条数 | 说明 |
|---|---|---|
| **blocker** | **0** | R2.2 的 B1 已由 R2.3 关闭；本次 `check.mjs` 实测 **49 / 0 / 0，EXIT=0** |
| **high** | **0** | — |
| **medium** | **0** | — |
| low（既有债） | 3 | ① `tests/catalog.test.mjs` 工作副本 CRLF（只打 stderr 警告、EXIT=0）② 测试夹具 `C:\__magpie_test_cache__` 实为驱动器相对路径 ③ 发布态 tag（见下） |

- **L-1 关闭**（R2.1：TTL 两条等价变异真红）。
- **L-2 关闭**（本节 A：生产 mjs 0 残留，五种方式说明仍在；t32-M1 真红）。
- **L-4 关闭**（R2.3：`docs/internals.md:225-236` 已改为「整段删除 + doesNotMatch 防复活 + 5 秒负缓存」）。
- t34 的验收项（t32 零残留 / t33 ENOENT 快速 reject + error 监听 + profile 清理 / 变异真红 / 五道门禁重跑）
  **在当前状态下全部满足** ⇒ t34 **verdict = pass**。

### 仍未验（一条都没说成通过）

U1 真机 `client.auth.set` 落盘 · U2 magpie 收到 `{event:"auth"}` 后是否会重跑插件工厂 ·
U3 上游 `POST /api/console/api-keys` 的最终一致性 · U4 负缓存 5 秒 TTL 的真机观感 ·
U5 五种百智云登录方式真机 · U6 邀请关系真实消费 · U7 安装 / 打 tag / 发布 · U8 国际站真机。

`node scripts/check-maintenance.mjs` 仍是 **通过 4 · 警告 1 · 失败 1**（0.2.42 无 tag）——
**在 `git tag v0.2.42 && git push origin v0.2.42` 之前，任何地方都不许写「已发布」。**

## E. 安全核查（本轮写操作清点）

我这一轮（t34 attempt 2）**只追加了 `docs/final-review-r2.md` 的本节**。
`git status` 里另外三条与安全核查相关的变化 **不是我做的**：
`M UPDATING.md`、`D add-dup-check.mjs`、`D baizhi-icon.svg` —— 我只读过它们的存在性，从未写入、移动或删除；
4 条变异全部在 `%TEMP%\mut6` 的仓外副本里做，做完即删（仓库 `src/**`、`tests/**`、`scripts/**` 零改动）。
