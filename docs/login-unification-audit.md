# 登录统一改造审计（百智云 → 国内 MonkeyCode SSO；国际版独立）

> 审计者：`auth-auditor`（团队 `monkeycode-login-invite-20261109`，任务 t1）
> 时间：2026-11-09 · 仓库 HEAD `3ae1a4c`、`package.json` 版本 0.2.41
> 性质：**只读审计**。除本文件外未改动任何路径；未提交、未安装、未重启、未读写真实凭证。
> 判据来源只有两种：**本机实跑的输出**，或**源码里能点到的行**。凡是没跑过的东西都标「未验证」，不当事实写。

---

## 0. 结论摘要

### 0.1 用户要求 → 目标态

| provider | 现在 | 目标 | 依据 |
|---|---|---|---|
| `baizhi`（百智云） | 4 个登录方式：API Key / 手机号验证码 / 从本机客户端导入 / 浏览器登录 | **只留 2 个**：从本机客户端导入、浏览器登录 | 用户："百智云仅保留本机客户端导入和浏览器登录" |
| `monkeycode`（国内站） | 5 个：API Key / 账号密码 / 从本机客户端导入 / **用百智云账号开通** / 浏览器登录 | **只留 1 个**：用百智云账号开通（改造成"复用百智云登录态"） | 用户："国内 MonkeyCode 登录统一通过百智云 SSO 复用凭证" |
| `monkeycodeintl`（国际版） | 4 个：API Key / 账号密码 / 从本机客户端导入 / 浏览器登录 | **一个不动**，且**不得**复用国内/百智云 cookie | 用户："国际版保持独立" |

### 0.2 五条关键结论（每条都有本机输出或代码行支撑）

1. **"统一走百智云"在代码上已经有一条完整链路，只差"复用"这一步。**
   `signInWithBaizhiSession()` 能拿一条百智云会话零交互换出 MonkeyCode 账号
   （`src/monkeycode/sso-import.mjs:212`），但今天它唯一的生产调用点拿的是**用户在窗口里刚登的**
   cookie（`src/monkeycode/runtime.mjs:585`）。"从 magpie 已登录的百智云账号取 cookie"的函数
   `readBaizhiSessions()` 已经写好（`sso-import.mjs:71`）却**没有任何生产代码引用它**
   （只有 `tests/sso-import.test.mjs`）。

2. **"复用凭证"缺的是三个来源的接线，不是新协议。** 现成可用的复用来源有三个，
   都已被验证或已被测试覆盖：magpie 账号库（`readBaizhiSessions`）、本机桌面客户端
   （`readDesktopBaizhiSession`，`src/monkeycode/desktop-session.mjs:175`）、
   持久 profile 静默读（`readCookiesSilently` + `profileDirFor("baizhi")`，`runtime.mjs:546`）。
   今天只接了第三个。

3. **"五种官方方式都要可用"有一个真实卡点，而且是一个 bug 级别的卡点。**
   百智云浏览器登录的 `accept()` 恒返回 `true`（`src/baizhi/runtime.mjs:197-200`），
   于是"窗口里有匿名 cookie"这一刻就会被当成登录完成并直接去换 Key，换不到就报失败 ——
   正是 `src/session-login.mjs` 文件头（第 7-13 行）点名禁止的写法。同一仓库里
   MonkeyCode 那条路写对了（`runtime.mjs:251-273` 用 `issued` 缓存 + 失败继续等）。

4. **两条"自动点登录方式"的死代码必须继续不接线。**
   `AGREE_PROTOCOL_JS`（`src/baizhi/runtime.mjs:234-273`）第 3 步会**主动点第 4 个图标（观猹）**；
   `LOGIN_AUTOPILOT_JS`（`src/monkeycode/runtime.mjs:64-74`）会点"确认授权"。两者当前都没被用到
   （`AGREE_PROTOCOL_JS` 只在 `runtime.mjs:32` 被 import，从未使用；`LOGIN_AUTOPILOT_JS`
   只有定义）。一旦为了"别让用户多点一下"把前者接进 `onPoll`，微信 / 支付宝 / 抖音 / GitHub
   四种方式会被劫持到观猹 —— 与"五种方式都要可用"直接冲突。

5. **华为云那个包（`magpie-officeace`）真正在跑的"共享凭证"是"反方向读盘 + 不重登"，
   不是"一次登录写两家记录"。** 它的 `authorize()` 一进去就先从 `~/.config/magpie/plugin-auth.json`
   （只读）挑一份已保存凭据直接复用（`index.mjs:369`、`406`，读盘实现 `src/accounts.mjs:45-72`）；
   跨 provider **写**记录的 `client.auth.set` 存在（`src/codearts/index.mjs:3768-3782`），但当前
   唯一调用点写的是**自己这张卡**（`2856` 行），并且注释（`2852-2855`）明确解释了为什么不再互写：
   华为云的 refresh token 是一次性的，两条记录共用一枚会互相踢下线。
   **我们的情况恰好相反**：`baizhi_session` 是长期静态 cookie，SSO 换来的是**另一套**独立凭据，
   所以"共享"在我们这里是安全的 —— 但要照抄的是它"先复用、后登窗"的顺序，不是它的互写。

---

## 1. 本次实际跑过的东西（真实输出）

### 1.1 基线：测试全绿、合规检查全绿

```bash
$ node --test
ℹ tests 252
ℹ pass 252
ℹ fail 0
ℹ duration_ms 12753.2555

$ node scripts/check.mjs
  通过 49 · 警告 0 · 失败 0      [exit=0]
```

### 1.2 三家 provider 的真实登录方式表（用于第 2、5 节，不是读文档抄的）

```bash
$ MAGPIE_PLUGIN_DISABLE_BROWSER=1 node -e '...'   # 见附录 A 的完整脚本
=== monkeycode (auth.provider=monkeycode) ===
  [0] type=api    label="MonkeyCode 猴子编程 API Key"          authorize=undefined ask=undefined
  [1] type=oauth  label="MonkeyCode 猴子编程 账号密码登录"      authorize=function  ask=function  prompts=email,password
  [2] type=oauth  label="MonkeyCode 猴子编程 从本机客户端导入"   authorize=function  ask=undefined
  [3] type=oauth  label="MonkeyCode 猴子编程 用百智云账号开通"   authorize=function  ask=undefined
  [4] type=oauth  label="MonkeyCode 猴子编程 浏览器登录"        authorize=function  ask=undefined
=== monkeycodeintl (auth.provider=monkeycodeintl) ===
  [0] type=api    label="MonkeyCode 国际版 API Key"
  [1] type=oauth  label="MonkeyCode 国际版 账号密码登录"        prompts=email,password
  [2] type=oauth  label="MonkeyCode 国际版 从本机客户端导入"
  [3] type=oauth  label="MonkeyCode 国际版 浏览器登录"
=== baizhi (auth.provider=baizhi) ===
  [0] type=api    label="百智云 BaiZhiCloud API Key"
  [1] type=oauth  label="百智云 BaiZhiCloud 手机号验证码登录"    prompts=phone,code
  [2] type=oauth  label="百智云 BaiZhiCloud 从本机客户端导入"
  [3] type=oauth  label="百智云 BaiZhiCloud 浏览器登录"
=== sites ===
monkeycode     https://monkeycode-ai.com cookie=monkeycode_ai_session loginUrl=https://monkeycode-ai.com/login
monkeycodeintl https://monkeycode-ai.net  cookie=monkeycode_ai_session loginUrl=https://monkeycode-ai.net/login
```

⚠ 注意最后一行：**两站 cookie 同名**（`monkeycode_ai_session`），所以"国际版不能错误复用国内 cookie"
只能靠**域**区分，不能靠 cookie 名。域隔离现状见 9.4。

### 1.3 "目标态喂给现有断言"→ 真红（不是口头说会红）

```bash
$ MAGPIE_PLUGIN_DISABLE_BROWSER=1 node --input-type=module -e '...'   # 附录 B
目标态 baizhi: [ '百智云 BaiZhiCloud 从本机客户端导入', '百智云 BaiZhiCloud 浏览器登录' ]
目标态 国内站: [ 'MonkeyCode 猴子编程 用百智云账号开通' ]
baizhi:    现有断言真红 -> 每家都要能直接粘 Key
monkeycode: 现有断言真红 -> 每家都要能直接粘 Key
```

即：`tests/multi-provider.test.mjs:113-118` 的 `types.includes("api")` 与目标态**互斥**。
这条不是"改造时要顺手改的断言"，是**必须先改的验收口**（第 9.2 节给了替代断言）。

### 1.4 生产可达模块 vs 死代码（决定"哪些能删、哪些删不得"）

```bash
$ node -e '...'   # 从 index.mjs 递归走 import，附录 C
可达: index.mjs src/baizhi-icon.mjs src/baizhi/credits.mjs src/baizhi/phone-login.mjs
      src/baizhi/runtime.mjs src/baizhi/site.mjs src/browser-login.mjs src/credential.mjs
      src/monkeycode-icon.mjs src/monkeycode/browser-login.mjs src/monkeycode/catalog.mjs
      src/monkeycode/credits.mjs src/monkeycode/desktop-session.mjs
      src/monkeycode/password-login.mjs src/monkeycode/runtime.mjs src/monkeycode/signing.mjs
      src/monkeycode/sso-import.mjs src/platform-http.mjs src/quota.mjs src/session-login.mjs
      src/sites.mjs src/system-open.mjs src/usage-cache.mjs
仅测试/未接线: src/account-name.mjs src/api.mjs src/chat.mjs src/context.mjs src/desktop-import.mjs
      src/invite.mjs src/local-browser.mjs src/model-context.mjs src/models.mjs src/oauth-pkce.mjs
      src/openai-sse.mjs src/refresh-lock.mjs src/request-rewrite.mjs src/rotation-captcha.mjs
      src/store.mjs src/tempmail-client.mjs src/tool-schema.mjs src/vision-clock.mjs
```

三条与本次改造直接相关的推论：

- `src/baizhi/phone-login.mjs` **现在是可达的**（`src/baizhi/runtime.mjs:23` import）——
  移除"手机号验证码登录"后它变成死代码，但 `tests/baizhi-phone-login.test.mjs` 还在测它
  （删文件会连带红，见 9.2 的"不改测试"选项）。
- `src/monkeycode/password-login.mjs` 是**国际版唯一的纯 API 登录路**（`runtime.mjs:394`
  与 `:355-419` 共用同一方法体），**不得删**。
- 建议做"邀请码"那件事时注意：`src/invite.mjs`（`createInviteStore` / `makeInviteMethod`）
  已经写好但**完全没接线**（0 处生产引用）。它依赖 `ask()` 串"填码 → 主登录"，
  与本次改造后的"国内站只有 1 个入口"是能合的，但不在本审计范围。

---

## 2. 现状：三家 provider 的登录面（逐方法定位）

### 2.1 `monkeycode`（国内站）· `src/monkeycode/runtime.mjs:344-633`

| # | 方式 | 实现 | 关键调用 |
|---|---|---|---|
| 0 | API Key (`type:"api"`) | `344-353` | 刻意不写 `authorize`（magpie api 方式只收一个字符串） |
| 1 | 账号密码登录 | `354-419` | `loginWithPassword()`（`password-login.mjs:113`）→ captcha → `POST /api/v1/users/password-login` |
| 2 | 从本机客户端导入 | `424-499` | `readDesktopMonkeyCodeSession({cookieDomains:[host]})`（`desktop-session.mjs:170`）+ `exchangeSessionForKey`（`credits.mjs:65`） |
| 3 | 用百智云账号开通（**仅国内站**） | `505-610`，守卫 `site.id === "monkeycode"` | `readCookiesSilently`（`session-login.mjs:198`）→ `startBrowserLogin`（`282`）→ `signInWithBaizhiSession`（`sso-import.mjs:212`） |
| 4 | 浏览器登录 | `611-632` | `signInWithBrowser()`（`230-298`）→ `browserLogin`（`session-login.mjs:230`）→ `exchangeSessionForKey` 反复试 |

`signInWithBrowser` 是**生产路径上唯一**写对了"读到 cookie ≠ 登录成功"的地方
（另一个同类实现 `browser-login.mjs:222-266` 的 `chromiumLogin` 只看 cookie 到没到齐，
且 0 处生产引用）：
`251-273` 的 `accept()` 会真的去换 Key，401/403/网络失败一律 `return false` 继续等，
换到的凭据缓存在 `issued`。

### 2.2 `monkeycodeintl`（国际版）· 同一工厂，少一个方法

- 工厂是同一个：`makePlugin(site)`（`runtime.mjs:304`），差异只在 `src/sites.mjs:57-87`。
- SSO 入口用 `...(site.id === "monkeycode" ? [...] : [])` 排除（`runtime.mjs:505`、`:610`）。
- 域过滤：`const host = new URL(site.platformBaseUrl).hostname` → `cookieDomains: [host]`
  （`runtime.mjs:240-244`），国际站因此拿不到 `.com` 的会话。

### 2.3 `baizhi`（百智云）· `src/baizhi/runtime.mjs:334-514`

| # | 方式 | 实现 | 关键调用 |
|---|---|---|---|
| 0 | API Key | `335-342` | 同 monkeycode：`type:"api"`，无 `authorize` |
| 1 | 手机号验证码登录 | `343-396` | `sendPhoneCode`（`phone-login.mjs:38`）在 `ask()` 里发码、`loginWithPhoneCode`（`72`）换 `baizhi_session` + `sl-session` |
| 2 | 从本机客户端导入 | `397-441` | `readDesktopBaizhiSession()`（`desktop-session.mjs:175`，两枚 cookie 到齐才算）→ `finishSignIn`（`149`） |
| 3 | 浏览器登录 | `442-512` | `startBaizhiBrowserLogin`（`185-202`）→ `finishSignIn` |

`finishSignIn`（`149-173`）是百智云唯一的收尾：`exchangeSessionForKey`（`src/baizhi/credits.mjs:94`）
拿 `sk-`，失败且 `needsKeyCreation` 时用持久 profile 打开建 Key 页（`openKeyPage`，`211-225`）。

---

## 3. 目标态与逐项改造映射

### 3.1 百智云：只留 2 个（本机导入 + 浏览器登录）

**保留（不改逻辑）**

- `从本机客户端导入`（`runtime.mjs:397-441`）：读 `%APPDATA%\com.chaitin.baizhi.monkeycode\baizhi-cookies.json`
  的 `sl-session` + `baizhi_session`，`finishSignIn` 换 `sk-`。零窗口、零网络前置。
- `浏览器登录`（`runtime.mjs:442-512`）：受控窗口 + CDP 读 cookie。**必须修一处**（见 3.4-a）。

**移除**

- `API Key`（`335-342`）—— 移除的是**登录入口**；读取路径必须保留：
  `credentialOf`（`86-91`）走 `parseCredential`（`src/credential.mjs:26-52`）仍认
  `{"access_token":"sk-…"}`、`sk-…`、`sk-…:…` 三种手写形状，**老账号不会因为移除入口而失效**。
- `手机号验证码登录`（`343-396`）+ `import { loginWithPhoneCode, sendPhoneCode } from "./phone-login.mjs"`
  （`23`）。`phone-login.mjs` 本身建议**保留文件、只断引用**（理由见 9.2：删文件会连带
  `tests/baizhi-phone-login.test.mjs` 变红，那是另一件事）。

### 3.2 国内 MonkeyCode：只留 1 个（复用百智云登录态后 SSO）

**保留并改造**：`用百智云账号开通`（`runtime.mjs:505-610`）。
建议**保留 label 原文**（"用百智云账号开通"）—— `tests/multi-provider.test.mjs:137` 按这个
字符串查找入口，改名会连带改测试；用户认知也在这句话上。

改造点（按 authorize 内部顺序，全部落在"先复用、后开窗"）：

| 步 | 现在 | 改成 | 依据 |
|---|---|---|---|
| ① | 直接 `readCookiesSilently(profileDirFor("baizhi"))` | **先**读 magpie 账号库 `readBaizhiSessions()`（`sso-import.mjs:71`）→ 命中即用 | 与华为云包 `index.mjs:406` 同款顺序（先复用已保存凭据） |
| ② | — | **再**读本机桌面客户端 `readDesktopBaizhiSession()`（`desktop-session.mjs:175`） | 与百智云卡片"从本机客户端导入"共用同一份数据；用户登过桌面版就不用再登 |
| ③ | 静默读持久 profile（`546`） | **再**读持久 profile（保持） | 已实现，且"一个百智云账号两站都能进"就靠它（`docs/internals.md:172-192`） |
| ④ | 开窗 `baizhi.cloud/console/`（`549-558`），12 秒超时（`561`） | 保持，但把说明改成"复用不到才需要登录" | 现状已区分 `bail` 分支（`567-577`） |
| ⑤ | `signInWithBaizhiSession(cookie, site)`（`590`） | 不变 | 已含：注入两枚 cookie → `GET /api/v1/users/login` → 302 → 点"确认授权"（`sso-import.mjs:251-260`）→ 等 `monkeycode_ai_session` → 换 Key |
| ⑥ | 重复账号提示（`591-601`） | 不变 | magpie 按 uid 去重，必须说清 |

**移除（国内站）**

- `API Key`（`344-353`）
- `账号密码登录`（`354-419`）—— 但 `password-login.mjs` 保留给国际站
- `从本机客户端导入`（`424-499`）
- `浏览器登录`（`611-632`）—— `signInWithBrowser()` 保留给国际站

**可选（需拍板，不是默认）**：百智云登录成功后**顺带**把国内站记录写进 magpie（`client.auth.set`）。
好处：用户只在百智云点一次，国内站卡片自动出现。依据是华为云包的 `writeSharedRecord`
（`src/codearts/index.mjs:3768-3782`）与宿主能力 `client.auth.set`（`OFFICIAL-SOURCES.md:77`
的官方锚点映射；本仓库 `HOOKS.md:454` 提到它的语义差异）。**本机从未验证过本仓库能调到它**
（全仓库 0 处调用），见风险 R7。

### 3.3 国际版：一个不动，三道保险必须都在

1. SSO 入口靠 `site.id === "monkeycode"` 排除（`runtime.mjs:505`）—— `tests/multi-provider.test.mjs:148-152`
   已锁住"国际站不该有百智云 SSO 入口"。
2. cookie 按域取（`runtime.mjs:240-244`）—— 实跑证据见 9.4。
3. 桌面导入按域判（`desktop-session.mjs:86-92` + `runtime.mjs:441-453`）—— 拿错站时给的是
   "桌面客户端登录的是另一个站点"，不是 401。

改造时**新增的共享动作**（3.2 的可选项、或任何"复用百智云 cookie"的新代码）必须带一条硬约束：
**`exchangeSessionForKey` / `signInWithBaizhiSession` 的 `site` 只能是
`SITES.monkeycode`，永远不能是 `SITES.monkeycodeintl`**。国际站不认百智云 SSO
（依据：`AGENTS.md:150-152`、`docs/internals.md:147-156` 记录的 2026-11-04 实测 302 链，
本次未复验）。

### 3.4 五种官方方式都要可用：三个卡点 + 两个禁令

`AGENTS.md:88-101`（规格 0.4）把"五种"钉成验收标准：微信扫码 / 支付宝 / 抖音 / GitHub / 观猹
（外加账号密码）。当前实现离"都可用"有四处距离：

- **3.4-a（真 bug，必修）accept 恒真。**
  `startBaizhiBrowserLogin` 的 `accept() { return true }`（`baizhi/runtime.mjs:197-200`）让
  `flow.wait()` 一旦看到两枚 cookie 名就返回；随后 `finishSignIn` 换 Key 失败 →
  用户看到"已读到网页登录态，但换取 API Key 失败"（`160`），窗口被收掉，白登一次。
  五种方式**任何一种**只要在"窗口刚打开、cookie 还是匿名"那一刻被读到，就会中这个招。
  修法直接照抄 monkeycode：`accept(candidate)` 里试 `exchangeSessionForKey`，成功就把结果
  缓存下来（`runtime.mjs:251-273` 的 `issued` 写法），失败 `return false` 继续等。
- **3.4-b（禁令）不要接 `AGREE_PROTOCOL_JS`。**
  `baizhi/runtime.mjs:255-258` 的注释写明那排四个图标依序是 **支付宝 / 抖音 / GitHub / 观猹**，
  而 `:259-266` 的代码会 `ways[3].click()` —— 即强制走观猹。接进 `onPoll` 就等于把
  另外四种方式从用户手里拿走。当前它**未被使用**（只有 `monkeycode/runtime.mjs:32` 的
  死 import），改造时顺手删掉这个 import 即可，别"顺手用起来"。
- **3.4-c（禁令）`LOGIN_AUTOPILOT_JS`（`monkeycode/runtime.mjs:64-74`）同理。**
  它会点"确认授权"。对国内站改造后的 SSO 链路，这一步**已经在** `signInWithBaizhiSession`
  里用 CDP 做了（`sso-import.mjs:251-260`），不要再叠一份在窗口轮询上；
  `signInWithBrowser` 也没接它（`runtime.mjs:241-274` 没传 `onPoll`）。
- **3.4-d（风险）域精确匹配 vs 五种方式的回调落点。**
  `sessionCookieOf`（`session-login.mjs:92-108`）对域的判据是**去前导点后完全相等**。
  `CONSOLE_DOMAINS = ["baizhi.cloud"]`（`baizhi/runtime.mjs:146`）。若某种方式把
  `baizhi_session` 落在某个子域（例如 `ai-models.app.baizhi.cloud`），会被这条规则丢掉，
  表现为"登完了但一直读到没登录"。同一子域下还有**另一枚同名 `sl-session`**（`ai-models` /
  `agent-toolkit`），所以这里**不能**简单放宽成后缀匹配 —— 正确做法是保留精确匹配，
  并把失败提示写清（不建议在本次改造里动它）。

---

## 4. 需改文件 / 函数清单（可直接施工）

| 文件 | 函数 / 位置 | 动作 | 为什么 |
|---|---|---|---|
| `src/baizhi/runtime.mjs` | `methods[0]`（`335-342`，API Key） | **删** | 用户："仅保留本机导入 + 浏览器登录" |
| 〃 | `methods[1]`（`343-396`，手机号验证码） | **删** | 同上；纯 API 入口不再提供 |
| 〃 | `import ... from "./phone-login.mjs"`（`23`） | **删 import，保留文件** | 删文件会连带 `tests/baizhi-phone-login.test.mjs` 红 |
| 〃 | `startBaizhiBrowserLogin.accept`（`197-200`） | **改**：试换 Key，失败继续等，结果缓存 | 3.4-a，五方式可用的前提 |
| 〃 | `finishSignIn`（`149-173`） | **改签名**：接受已缓存的兑换结果，避免重复兑换 | 兑换每次签发新 Key（`src/monkeycode/credits.mjs:63`），不能一登录两次兑换 |
| 〃 | `AGREE_PROTOCOL_JS`（`234-273`） | **保留定义、绝不接线**（或整体删除） | 3.4-b |
| `src/monkeycode/runtime.mjs` | `methods[0..2]`、`methods[4]`（`344-499`、`611-632`） | **删 4 个** | 用户："国内统一走百智云" |
| 〃 | `methods[3]`（`505-610`，SSO） | **改**：authorize 内按 ①账号库 ②桌面 ③profile ④开窗 复用；callback 不变 | 3.2 |
| 〃 | 新增 `resolveBaizhiCookie()`（建议放 `sso-import.mjs`，与 `readBaizhiSessions` 同处） | **新增** | 复用逻辑只写一份，百智云侧将来也能用 |
| 〃 | `import { AGREE_PROTOCOL_JS }`（`32`）、`LOGIN_AUTOPILOT_JS`（`64-74`） | **删**（死代码） | 3.4-b/c |
| 〃 | `makePlugin(site)`（`304`）/ 工厂签名 `(_ctx, _options)`（`305`） | **改**：接 `{ client }`（仅当采用 3.2 可选项） | `client.auth.set` 需要 ctx；`_ctx` 现在被丢弃 |
| 〃 | `signInWithBrowser`（`230-298`）、`configModels`、`loader`、`usage`、`checkin` | **不动** | 国际站仍在用（`615-632` 改成只服务国际站） |
| `src/monkeycode/sso-import.mjs` | `signInWithBaizhiSession`（`212-294`） | **不动** | 已含注入/302/确认页/等会话/换 Key/落目录 |
| 〃 | `readBaizhiSessions`（`71-95`） | **接线**（今天 0 处生产引用） | 复用来源 ① |
| 〃 | `importOneBaizhiAccount`（`301-333`），配 `statePath()`（`48-50`） | **决定去留**：若走"每次点一次导一个"，它就是现成的；否则删 | 与"用户在窗口里选号"语义冲突，见 R5 |
| 〃 | `readImported` / `markImported` / `nextUnimported`（`97-115`） | 随上一条一起决定 | 同上 |
| `src/monkeycode/desktop-session.mjs` | `readDesktopBaizhiSession`（`175-177`） | **接线** | 复用来源 ② |
| `src/session-login.mjs` | `readCookiesSilently`（`198`）、`startBrowserLogin`（`282`）、`profileDirFor`（`127`） | **不动** | 复用来源 ③，已成熟 |
| `src/baizhi/credits.mjs` | `exchangeSessionForKey`（`94-146`） | **不动**（可能新增"返回已存在的 Key 而非总新建"） | 现在没有 `sk-` 时**自动新建一把**（`124-137`），每次登录都建会累积 |
| `src/monkeycode/credits.mjs` | `exchangeSessionForKey`（`65-83`）、`fetchProfile`（`91-116`） | **不动** | 身份只用 `data.user.id`（注释 `88-89`） |
| `index.mjs` | `MonkeyCodeAuthPlugin` / `BaizhiAuthPlugin` 导出（`20-22`） | **不用改** | `ctx` 由 magpie 传给工厂，工厂签名改即可 |
| `tests/multi-provider.test.mjs` | `113-133` | **必须改**（见 9.2） | 与目标态互斥（1.3 已真红） |
| `tests/multi-provider.test.mjs` | `135-158` | **不动** | 国际站保留清单，目标态仍成立 |
| `docs/internals.md` | `133-192` | **必须同步改** | 见第 10 节两处"文档说了但代码没有" |
| `README.md` | `16`（"三种接入方式"）、`58-62` | **同步改** | 用户可见说明 |

---

## 5. 保留 / 移除的方法清单（逐条 + 后果）

### 5.1 保留（9 个）

| provider | 方法 | 保留理由 |
|---|---|---|
| baizhi | 从本机客户端导入（`397`） | 用户明确保留；零窗口 |
| baizhi | 浏览器登录（`442`） | 用户明确保留；五方式唯一载体 |
| monkeycode | 用百智云账号开通（`505`） | 国内站唯一入口（改造后） |
| monkeycodeintl | API Key（`344`，同工厂） | 国际版独立，不动 |
| monkeycodeintl | 账号密码登录（`354`） | 国际版有 Google/GitHub/密码三种，密码这条是纯 API 的 |
| monkeycodeintl | 从本机客户端导入（`424`） | 国际版桌面 cookie 自己的域 |
| monkeycodeintl | 浏览器登录（`611`） | 国际站自己的登录页 |
| 内部 | `signInWithBrowser`、`loginWithPassword`、`readDesktopMonkeyCodeSession`、`exchangeSessionForKey` | 国际站仍在调用链上 |

### 5.2 移除（6 个）

| provider | 方法 | 移除后的真实后果 | 缓解 |
|---|---|---|---|
| baizhi | API Key | 用户失去"手工粘一行 JSON"的兜底；受控浏览器起不来时 `manualCookieHint`（`276-281`）指向的入口消失 | 二选一：① 接受（用户明确要求）；② 保留但改名"高级：手工粘贴凭据（故障兜底）"，作为例外写进 CHECKLIST |
| baizhi | 手机号验证码登录 | 没有微信/支付宝/抖音/GitHub/观猹任何账号、只有手机号的用户，只能走浏览器登录（一样能用，只是要窗口） | 浏览器登录的说明里点明"手机号验证码在窗口里也能用" |
| monkeycode | API Key | 同上（国内站不再能手填 Key） | 同上 |
| monkeycode | 账号密码登录 | 没有百智云账号、只有 MonkeyCode 邮箱密码的用户无路可走 | 需产品确认（R3） |
| monkeycode | 从本机客户端导入 | 桌面客户端只登了 MonkeyCode（没登百智云）时，`baizhi-cookies.json` 可能不存在 | 依赖 3.2 的 ②（桌面 baizhi 会话）；不存在就退化到开窗 |
| monkeycode | 浏览器登录 | 窗口里"快速注册"（不经百智云，猴子自带日额度）这条路消失 | 需产品确认（R3） |

---

## 6. 现有可复用能力（别重写，直接用）

| 能力 | 位置 | 现状 | 本次怎么用 |
|---|---|---|---|
| 用百智云会话换 MonkeyCode 账号（OAuth SSO，含确认页点击） | `src/monkeycode/sso-import.mjs:212-294` | 可用 | 唯一入口的核心 |
| 读 magpie 账号库里的百智云会话 | `sso-import.mjs:71-95` | **写好了但没接线** | 复用来源 ① |
| 读本机桌面客户端的百智云会话（两枚到齐才算） | `src/monkeycode/desktop-session.mjs:175-177` | 百智云卡片在用 | 复用来源 ② |
| 静默读持久 profile（无头，读完就关） | `src/session-login.mjs:198-215` | SSO 入口在用（`runtime.mjs:546`） | 复用来源 ③ |
| 受控浏览器"先启动后等待" | `src/session-login.mjs:282-330` | 两处在用 | 开窗兜底 |
| 一次性 profile 浏览器登录 + CDP 轮询 | `src/session-login.mjs:230-266` | 国际站 + 百智云在用 | 不动 |
| 凭据形状与"存得下"开关（`refresh` 位） | `src/credential.mjs:79-92` | 关键契约 | 所有登录结果必须走 `signInSuccess` |
| 凭据解析（JSON / `k:s` / 裸 token，且**只有 `session_cookie` 也放行**） | `src/credential.mjs:26-52` | 实跑确认（附录 D） | 老 `type:"api"` 账号不至于因移除入口而失效 |
| 域名匹配（去前导点后精确/子域） | `desktop-session.mjs:86-92` | 测试覆盖 | 国际版隔离 |
| 华为云式"先复用已保存凭据再开窗" | `magpie-officeace/index.mjs:352-421` | 在生产包的 `authorize()` 里 | 3.2 的顺序照抄它 |

---

## 7. 华为云 magpie 插件的双供应商共享凭证（本机只读实测）

### 7.1 定位（本机）

| 项 | 值 |
|---|---|
| 仓库 | `D:/DeepSeek Harness/反代/magpie-officeace`（与本仓库同级） |
| 包名 / 显示名 | `magpie-officeace` 0.2.6；`package.json.magpie.name = "华为云 HUAWEI"` |
| 两个 provider | `officeace`（根 `index.mjs:277`）+ `codearts`（`src/codearts/index.mjs:2493`，`PROVIDER = "codearts"` 在第 54 行） |
| 登录协议 | 华为云 OAuth（PKCE + DPoP）→ STS；文档链见 `docs/internals.md:44-56` |

### 7.2 它真实在跑的三条"共享"姿势

**姿势 A · 反方向读盘 + 不重登（在用，最值得照抄）**

`OfficeAceAuthPlugin` 的 `authorize()` 一进去就先找"已经存下来的凭据"，顺序是：

1. 本机 OfficeAce 客户端已登录 → 用它的 `account_id` 去匹配 magpie 里的记录（`index.mjs:368-399`）；
2. 内存里最新的凭据（`latestMaasPending()`，`index.mjs:405`）；
3. **磁盘** `~/.config/magpie/plugin-auth.json` —— `readOfficeAceAccounts({file})`（`index.mjs:406`，
   实现 `src/accounts.mjs:45-72`，**只读、不加锁、不写**）。

三步都没有可用凭据才走华为云 OAuth（`index.mjs:421` 之后）。这条姿势解决的问题写在
`src/accounts.mjs:5-14`：「点重新登录却跳去登录页，没有复用凭证」。

**姿势 B · 跨 provider 写记录（能力在，当前不使用）**

- 能力：`client.auth.set({ path: { id: key }, body })`（`src/codearts/index.mjs:3768-3782`）。
- 键位分配 `recordKeyFor`（`3745-3750`）：目标 provider 还**没有任何账号**时用 provider id 本身；
  否则用 `${provider}#${sha256(identity).slice(0,8)}`；**该 provider 已有这个账号则返回 null**
  （绝不重复写、绝不写到别人可能坐着的键上）。
- 两种记录形状：`officeAceRecordBody`（`3121`）/ `codeArtsRecordBody`（`3134`），
  由 `target === OFFICEACE_PROVIDER` 分支选（`3773-3775`）。
- **但**当前唯一调用点写的是自己这张卡：`writeSharedRecord(client, PROVIDER, withMaas, fetcher)`
  （`2856`，`PROVIDER = "codearts"`）；写 `officeace` 记录的 `persistOfficeAceRecord`（`3886-3901`）
  **在本仓库内没有调用点**。原因写在 `2852-2855` 的注释里：华为云 refresh token 一次性，
  两条记录共用一枚会互相踢下线，所以两张卡各自登录、各自持 token。

**姿势 C · 宿主不提供跨 provider 读（硬约束）**

`3633-3651` 的段落式注释写得很清楚：magpie 的每个 provider 钩子**只看得见自己的账号**，
唯一的跨 provider 动作是"在登录/续期里 `auth.set` 写另一家的记录"。所以"共享"要么靠
**读盘**（姿势 A，magpie 目录只读），要么靠**写盘**（姿势 B）。没有第三条路。

**姿势 D · 共享的续期串行化（对我们无意义，但要知道它存在）**

`renewSharedCredential`（`3793-3819`）按"refresh chain"（OAuth client + token lineage）去重，
保证同一枚一次性 token 只被花一次。

### 7.3 对本仓库的取舍

| 华为云的做法 | 我们是否照抄 | 理由 |
|---|---|---|
| 先复用已保存凭据，再开窗（姿势 A） | **照抄** | 直接对应"复用凭证"；`readBaizhiSessions` 已经写好了读盘那一半 |
| `client.auth.set` 跨 provider 写（姿势 B） | **可选，需拍板 + 真机探针** | 我们的一次性 token 问题不存在（`baizhi_session` 静态、SSO 产出独立凭据），但本仓库 0 处调用过它（R7） |
| 键位规则 `provider#<sha8>` | **照抄**（若采用姿势 B） | 与 magpie 现有 `baizhi#xxxxxx` 形态一致（`plugin-auth.json` 的键格式在 `sso-import.mjs:76` 有同样的 `startswith("baizhi#")` 判断） |
| 两条记录共用 refresh token | **不适用** | 我们没有共享的一次性 token；MonkeyCode 侧 `refresh` 恒 `undefined`（`runtime.mjs:639-641`） |
| 持久 profile 共享"登录动作" | **已在用** | `profileDirFor("baizhi")`（`session-login.mjs:127`）被 SSO 入口使用 |

⚠ 一处**本机实测的偏差**，写在这里避免下一代误信文档：`docs/internals.md:172-192` 说华为云包靠
"每个账号一个持久浏览器目录"共享登录动作；而该包的**代码**里共享靠的是姿势 A（读
`plugin-auth.json`）+ OfficeAce 客户端本地会话探测（`probeClientLogin`，`index.mjs:361-367`），
不是浏览器 profile 复用。写文档时以代码为准。

---

## 8. 风险清单

| # | 风险 | 触发条件 | 后果 | 缓解 |
|---|---|---|---|---|
| R1 | 匿名 cookie 被当成登录完成 | 百智云浏览器登录的 `accept()` 恒真（`197-200`） | 五种方式任一种都可能"登完了却报失败" | 3.4-a 必修；修完用 9.5 的断言锁住 |
| R2 | 移除 API Key 后没有手工兜底 | 受控浏览器起不来（策略/无 Chromium） | 用户只能看 `manualCookieHint` 指着一个不存在的入口 | 拍板二选一（5.2） |
| R3 | 移除国内站"账号密码 / 浏览器登录"后，存量无百智云账号的用户无路可走 | 老用户只有 MonkeyCode 邮箱密码，或靠"快速注册"建号 | 直接失去使用能力（不是体验问题） | 需产品确认；建议至少保留一条"落回国内站自己的登录页"的说明性入口，或分版本删除 |
| R4 | 桌面 baizhi 会话可能不存在 | 桌面客户端只登过 MonkeyCode、没登过百智云 | `从本机客户端导入` + SSO 来源 ② 双双落空，退化开窗 | 提示文案要说清"桌面版里登一次百智云"；不要报"登录过期" |
| R5 | "已导入"状态与选号语义冲突 | `importOneBaizhiAccount` 被接线（`sso-import.mjs:301`）+ `markImported`（`102-107`） | 用户点了 A 号，插件却导入了 B 号（因为 A 已在 `~/.cache/magpie/monkeycode-imported.json` 里） | 若要接线，改为"显式选号"，或干脆不用 `imported` 状态（保留"每次点一次 = 用谁登录就导谁"） |
| R6 | 单一入口依赖无头 Chromium | 国内站只剩 SSO，而 SSO 强制 `--headless=new`（`sso-import.mjs:169`） | 机器没有可用 Chromium ⇒ 国内站完全登不上（其他 provider 还可开窗） | 失败时给出可执行的手动路径；或把 SSO 的兜底改成"用户在系统浏览器里登录后回来重试" |
| R7 | `client.auth.set` 在本仓库从未验证 | 采用 3.2 可选项 | 跨 provider 写记录静默失败（officeace 里就是 `try{}catch{}` 吞掉，`3778`） | 真机探针一次：登录后看 `plugin-auth.json` 是否出现目标 provider 的键；失败就退回"两张卡各点一次" |
| R8 | 持久 profile 静默命中的是**上一个号** | 用户换号后 profile 里还是旧会话 | 点"开通"却进了旧账号；magpie 按 uid 去重 ⇒ "提示已添加、列表没变" | silent 命中后先 `fetchProfile` 比对，不同就问是否换号 / 直接开窗 |
| R9 | 国际版吃到国内 cookie | 任何新增共享代码把 `site` 写成国内站，或放宽 `cookieDomains` | 国际站 401（`AGENTS.md:126-127` 记录） | 硬约束写进代码注释 + 9.4/9.6 断言 |
| R10 | 五种方式被"自动化"劫持 | 为了省掉点击把 `AGREE_PROTOCOL_JS` 接进 `onPoll` | 只剩观猹一种能用 | 3.4-b 禁令；删除死 import 顺手消掉诱因 |
| R11 | 文档已把未实现的东西写成现状 | 见第 10 节 | 下一代照文档施工，做出"看起来很对但没人调用"的代码 | 改造同轮必须同步改 `docs/internals.md` / `README.md` |

---

## 9. 验收断言（可跑、可红）

### 9.1 A1 · 登录方式清单（改造后必须与目标态逐字一致）

```bash
MAGPIE_PLUGIN_DISABLE_BROWSER=1 node --input-type=module -e '
import assert from "node:assert"
const m = await import("./index.mjs")
const cn  = await m.MonkeyCodeAuthPlugin({ client: {} })
const intl= await m.MonkeyCodeIntlAuthPlugin({ client: {} })
const bz  = await m.BaizhiAuthPlugin({ client: {} })
assert.deepEqual(cn.auth.methods.map(x=>x.label), ["MonkeyCode 猴子编程 用百智云账号开通"])
assert.deepEqual(bz.auth.methods.map(x=>x.label), ["百智云 BaiZhiCloud 从本机客户端导入","百智云 BaiZhiCloud 浏览器登录"])
assert.equal(intl.auth.methods.length, 4, "国际版必须原样 4 个")
assert.ok(intl.auth.methods.every(x=>!/百智云/.test(x.label)), "国际版不许出现百智云入口")
console.log("A1 ok")
'
```

**当前状态**：会红（1.3 已证明）。改造完成后必须变绿。

### 9.2 A2 · 现有断言必须替换（不是"顺手改绿"）

`tests/multi-provider.test.mjs:113-118` 的 `assert.ok(types.includes("api"))` 与目标态互斥（1.3 真红）。
替代断言（每个 provider 单独说清），建议写进同一个文件：

```js
// monkeycode: 只剩 1 个 oauth，且必须立刻返回
// baizhi:     2 个 oauth，均无 api
// intl:       api + 3 oauth 保持
// 三家共同的一条：每个 oauth 的 authorize() 必须 < 1000ms 返回（原 124 行保留）
// 新增一条：任何 oauth 的 flow.url 都必须是 https://（原 130 行保留）
```

`tests/multi-provider.test.mjs:135-158`（国际站保留清单 + 无 SSO 入口）**保持不动**，它已经是
"国际版独立"的正向断言。

`tests/baizhi-phone-login.test.mjs` 仍测 `phone-login.mjs` 的纯函数：只要**只删 import、不删文件**
（4 节清单），它继续绿。

### 9.3 A3 · 冒烟：全量测试 + 合规检查

```bash
node --test          # 期望 pass 全绿、fail 0（基线 252/252，见 1.1）
node scripts/check.mjs   # 期望 通过 49 · 警告 0 · 失败 0 · exit 0
```

### 9.4 A4 · 国际版域隔离（现状**没有测试覆盖**，本次实测过）

```bash
$ node --input-type=module -e '
import { cookiesFromJar, domainMatches } from "./src/monkeycode/desktop-session.mjs"
const jar = JSON.stringify([
  { name:"monkeycode_ai_session", value:"CN",   domain:".monkeycode-ai.com", expires:Date.now()+86400000 },
  { name:"monkeycode_ai_session", value:"INTL", domain:".monkeycode-ai.net", expires:Date.now()+86400000 },
])
console.log("cn  ->", cookiesFromJar(jar,{names:["monkeycode_ai_session"],domains:["monkeycode-ai.com"]}))
console.log("intl->", cookiesFromJar(jar,{names:["monkeycode_ai_session"],domains:["monkeycode-ai.net"]}))
console.log("net 吃 com 域?", domainMatches(".monkeycode-ai.com","monkeycode-ai.net"))'
cn  -> monkeycode_ai_session=CN
intl-> monkeycode_ai_session=INTL
net 吃 com 域? false
```

建议把这三行固化成测试（`tests/multi-provider.test.mjs` 或 `tests/desktop-session.test.mjs`）——
现在 `grep cookieDomains tests/` 是空的，`tests/desktop-session.test.mjs` 只测了"名字到齐"和"过期"。

### 9.5 A5 · 五种方式与登录方式无关（不需要真登录）

对 `finishSignIn`（百智云）注入假 `fetchImpl`，喂五种方式**同一套 cookie 形状**，
断言五种都 `ok: true` 且 `uid` 来自这次 cookie 的 `fetchProfile` 结果：

```js
// 伪代码：五种方式只改"用户怎么登的"，不改我们读到的 cookie 形状
for (const way of ["微信","支付宝","抖音","GitHub","观猹"]) {
  const out = await finishSignIn("sl-session=A; baizhi_session=B", BAIZHI, { fetchImpl: fake(way) })
  assert.equal(out.type, "success"); assert.ok("refresh" in out)
}
```

配套的**反例（真红）**：让 `accept()` 保持 `() => true`、假 `fetchImpl` 第一次返回 401 `needsKeyCreation`，
断言 `flow.wait()` 之后不得直接产出失败态 —— 这条现在会红（R1）。

### 9.6 A6 · 复用来源顺序（注入即可，不连网）

```js
// 依赖注入 readBaizhiSessions / readDesktopBaizhiSession / readCookiesSilently 的替身
// 期望：① 有账号库条目 → 用 ①，②③④ 一律不调用
//       ② 账号库为空、桌面有 → 用 ②，不开窗
//       ③ 都为空 → 走 ③（静默 profile）
//       ④ ③ 也空 → 才 openWindow（断言开窗只发生一次）
```

同时断言**反向**：`resolveBaizhiCookie()` 在任何分支都不得返回 `monkeycodeintl` 的
`site`（用 `exchangeSessionForKey` 的替身记录被传入的 `site.id`）。

### 9.7 A7 · 登录结果必须带 `refresh`（已有断言，别改坏）

`tests/signin-contract.test.mjs:32-57` 锁住 `signInSuccess` 的 `refresh` 位；`:59` 禁止
生产代码出现裸 `type:"success"`。改造中**新增**的任何返回（含 `client.auth.set` 的 body）
都要走 `signInSuccess`（`src/credential.mjs:79-92`）或等价的 `type:"oauth"` 记录形状。

---

## 10. 文档与代码不一致（改造同轮必须一起修）

| 文档 | 它说的 | 代码实际 | 证据 |
|---|---|---|---|
| `docs/internals.md:163-166` | "从已登录的百智云账号批量开通：读 magpie 账号库…每次调用导入一个没导过的" | 该函数 `importOneBaizhiAccount`（`sso-import.mjs:301`）**没有任何生产调用点**，只有 `readBaizhiSessions`/`nextUnimported` 被单测引用 | `grep -rn "importOneBaizhiAccount" --include=*.mjs .` → 只有定义处 |
| `docs/internals.md:188-189` | "一个百智云账号登过之后，国内站**与国际站**的第二次开通都是秒完成" | 国际站**没有** SSO 入口（`runtime.mjs:505` 守卫），也不认百智云 SSO（`internals.md:147-156` 自己写了反证） | `tests/multi-provider.test.mjs:148-152` |
| `docs/internals.md:174-178` | 华为云包"每个账号一个持久浏览器目录"共享登录动作 | 该包实跑的是"读 `plugin-auth.json`（只读）+ 探测桌面客户端会话"，不是浏览器 profile 复用 | `magpie-officeace/index.mjs:352-421`、`src/accounts.mjs:45-72` |
| `README.md:16` | "三种接入方式：桌面导入 / 浏览器登录 / API Key" | 改造后国内站只剩 1 种、百智云 2 种、国际版 4 种 | 本文 0.1 |

---

## 11. 明确未验证 / 不在本审计范围

**未验证（不得当事实引用）**

1. "五种方式登完都下发同一套 `sl-session` + `baizhi_session`" —— 出自 `AGENTS.md:88-101`
   记录的 2026-11-04 无头 DOM/实测，**本次没有复验**（不连真实站点、不读写真实凭证）。
2. 百智云登录页四个图标的顺序（支付宝/抖音/GitHub/观猹）—— 只有代码注释
   （`baizhi/runtime.mjs:255-258`）作为依据，本次未复验。
3. `client.auth.set` 在本仓库/本机 magpie 版本上的可用性 —— 依据是同机另一个已发版插件
   （`magpie-officeace`）在用 + 官方锚点映射（`OFFICIAL-SOURCES.md:77`），本仓库 0 处调用。
4. 桌面客户端在"只登过 MonkeyCode、没登过百智云"时，`baizhi-cookies.json` 是否存在（R4）——
   本次按要求**没有读写真实凭证/客户端目录**。
5. 微信/支付宝/抖音/GitHub/观猹任一种方式登完后 `baizhi_session` 的落点域是否恰为
   `baizhi.cloud` 根域（R 与 3.4-d）。
6. `~/.config/magpie/plugin-auth.json` 的真实内容（含国际站记录是否存在）—— 不读。

**不在本审计范围**

- 邀请码接入（`src/invite.mjs` 已存在但 0 处接线，属另一任务）。
- 模型目录 / 额度 / 签到 / 请求接管（`loader`）的任何改动。
- `index.mjs`、`src/**`、`tests/**`、`package.json` 的实际修改（本任务只允许写本文档）。
- 真机登录验证、发布流程（`UPDATING.md` / `CHECKLIST.md`）。

---

## 附录：本文档所有"实跑"的命令

### A · 登录方式清单

```bash
cd <repo> && MAGPIE_PLUGIN_DISABLE_BROWSER=1 node -e '
const m = await import("./index.mjs")
const { SITES } = m._internal
for (const [name, factory] of Object.entries({
  monkeycode: m.MonkeyCodeAuthPlugin,
  monkeycodeintl: m.MonkeyCodeIntlAuthPlugin,
  baizhi: m.BaizhiAuthPlugin,
})) {
  const plugin = await factory({ client: {} })
  console.log("=== " + name + " (auth.provider=" + plugin.auth.provider + ") ===")
  plugin.auth.methods.forEach((x, i) => {
    console.log(`  [${i}] type=${x.type} label=${JSON.stringify(x.label)} authorize=${typeof x.authorize} ask=${typeof x.ask} prompts=${Array.isArray(x.prompts) ? x.prompts.map(p=>p.key).join(",") : "none"}`)
  })
}
[...]'
```

### B · 目标态喂给现有断言（真红）

```bash
cd <repo> && MAGPIE_PLUGIN_DISABLE_BROWSER=1 node --input-type=module -e '
import assert from "node:assert"
const m = await import("./index.mjs")
const bz = await m.BaizhiAuthPlugin({ client: {} })
const cn = await m.MonkeyCodeAuthPlugin({ client: {} })
const target = {
  baizhi: bz.auth.methods.filter(x => x.label.includes("从本机客户端导入") || x.label.includes("浏览器登录")),
  monkeycode: cn.auth.methods.filter(x => x.label.includes("用百智云账号开通")),
}
for (const [name, methods] of Object.entries(target)) {
  const types = methods.map(x => x.type)
  try { assert.ok(types.includes("api"), "每家都要能直接粘 Key"); console.log(`${name}: 现有断言通过（意外）`) }
  catch (e) { console.log(`${name}: 现有断言真红 -> ${e.message}`) }
}'
```

### C · 生产可达模块 vs 死代码

```bash
cd <repo> && node -e '
const fs = require("node:fs"), path = require("node:path")
const seen = new Set()
function walk(f) {
  if (seen.has(f)) return; seen.add(f)
  let src; try { src = fs.readFileSync(f, "utf8") } catch { return }
  for (const m of src.matchAll(/from\s+["'"'"'](\.{1,2}\/[^"'"'"']+)["'"'"']/g)) {
    const p = path.resolve(path.dirname(f), m[1]); if (fs.existsSync(p)) walk(p)
  }
}
walk("index.mjs")
const reach = new Set([...seen].map(f => path.relative(".", f).replace(/\\\\/g, "/")))
const all = fs.readdirSync("src").filter(n => n.endsWith(".mjs")).map(n => "src/" + n)
for (const d of ["src/monkeycode", "src/baizhi"]) for (const n of fs.readdirSync(d)) if (n.endsWith(".mjs")) all.push(d + "/" + n)
console.log("可达:", [...reach].sort().join(" "))
console.log("仅测试/未接线:", all.filter(f => !reach.has(f)).sort().join(" "))'
```

### D · cookie-only 凭据可解析（SSO 复用的前提）

```bash
cd <repo> && node --input-type=module -e '
import { parseCredential, hasToken } from "./src/credential.mjs"
const c = parseCredential(JSON.stringify({ session_cookie: "sl-session=A; baizhi_session=B" }))
console.log("cookie-only 解析:", JSON.stringify(c), "hasToken:", hasToken(c))'
# cookie-only 解析: {"session_cookie":"sl-session=A; baizhi_session=B"} hasToken: false
```

⚠ 这条输出同时暴露一个设计要点：`readBaizhiSessions()`（`sso-import.mjs:83-85`）只要求
`parseCredential` 认得 + `session_cookie` 非空，而**百智云卡片自己的** `credentialOf`
（`src/baizhi/runtime.mjs:86-91`）要求 `hasToken` —— 所以"账号库里有一条 cookie-only 记录"
会让**卡片显示未登录、国内站 SSO 却能开通**。这不是 bug，但必须在文案/断言里说清（见 R8）。
