# 实现细节与取证

> README 只讲用户能看到什么；这里讲协议、取舍和「验证到哪一步」。
> 协议事实最初来自 2026-11-03 读取 [`iJetLi/dsh-providers-hub`](https://github.com/iJetLi/dsh-providers-hub)
> 的 `src/monkeycode-*.ts` 与 `src/baizhi-*.ts`（该仓库是 Betsy20/magpie-Jet-Hub 的上游，commit `9047d42`）；
> 2026-11-09 的登录面收敛、自动开通、邀请码、计费口径四件事分别另有取证文档：
> [登录统一审计](./login-unification-audit.md)、[自动凭证复用契约](./automatic-credential-reuse.md)、
> [邀请机制取证](./baizhi-invite-research.md)、[计费口径与目录契约](./monkeycode-model-billing.md)。
>
> 第 1–6 节讲 MonkeyCode（国内站 / 国际站），第 7 节讲百智云，第 8 节代码地图，第 9 节测试。

## 1. 两个站点，一份协议

| | 国内站 | 国际站 |
|---|---|---|
| provider id | `monkeycode` | `monkeycodeintl` |
| 平台 | `https://monkeycode-ai.com` | `https://monkeycode-ai.net` |
| 推理网关 | `https://proxy.monkeycode-ai.com/v1` | `https://proxy.monkeycode-ai.net/v1` |
| 会话 cookie | `monkeycode_ai_session` | 同名（**国际站只算推断**，见下） |
| 插件里的登录面 | **一条**：「用百智云账号开通」（走百智云 SSO，可选邀请码） | 四条：API Key / 账号密码 / 从本机客户端导入 / 浏览器登录 |
| 站点自己的登录页 | 微信 / 支付宝 / 抖音 / GitHub / 观猹 / 账号密码 —— **插件不再开这个页面** | **GitHub / Google / 账号密码**（2026-11-04 无头读 DOM） |
| 百智云 SSO | `GET /api/v1/users/login` → 302 `baizhi.cloud/oauth/authorize` | **不认**：302 到它自己的 `/oauth/authorize`，`client_id=` 为空 |
| 接口路径 | `/api/v1/...` | 逐字相同 |

两站是同一程序的两套部署：`GET /v1/models` 在两边都返回 405（逐字节一致的行为），平台接口路径也完全相同。
**账号池不互通** —— 国内站的 cookie 打国际站回 401，这是上游 RPC 层真机踩过并写进注释的事实。

国际站已确认的事实（2026-11-04）：

- 登录页只有 **GitHub / Google / 账号密码** 三种，页面明写「当前访问的是国际版」（无头浏览器读 `document.body.innerText`）
- `GET /api/v1/users/login` → 302 `Location: /oauth/authorize?client_id=&redirect_uri=https%3A%2F%2Fmonkeycode-ai.net%2Fapi%2Fv1%2Fusers%2Fbaizhi%2Fcallback...`
  —— **`client_id` 是空的，且是相对自己站点的路径**，不经过 `baizhi.cloud`
- 把百智云会话注入一次性 Chromium 再走这条路：最终只落到国际站首页，**不会**签发国际站 session
  ⇒ 国际站**不提供**「用百智云账号开通」入口（`src/monkeycode/runtime.mjs` 的登录面按
  `site.id === "monkeycode"` 装配：国内站拿 SSO 那一条，国际站拿原来的四条）
- `POST /api/v1/public/captcha/challenge` 回 201、形状与国内站相同；
  `POST /api/v1/users/password-login {email,password}` 缺 `captcha_token` 回 **403**（与国内站同一套语义）
- 未登录时**不下发**任何会话 cookie（`/`、`/login`、`/oauth/authorize` 三条都不带 `Set-Cookie`）

仍未验证项（照抄上游标注，不当作已确认）：

- 国际站换 Key 端点（`/api/v1/users/ohmyagent/api-keys`）的**响应字段**是否与国内一致
  —— 路径存在（无 cookie 回 401 而不是 404），但没有国际站账号跑完过一次
- 国际站会话 cookie 的**名字**：`monkeycode_ai_session` 只是推断（代码里两站共用 `SITES.*.sessionCookie`）。
  间接证据是报错形态「{user} 已登录，但 magpie 无法列出它」—— 说明 `accept()` 曾经命中过（否则会是「登录超时」）；
  但这不足以排除「插件把别的 cookie 当成了会话」。真机判据见 AGENTS 0.7

### 1.1 登录结果必须带 `refresh`（否则 magpie 一格都不存）

magpie 的插件宿主（`host.js` 的 `save()`）只有两条保存出口：

```js
if ("refresh" in result)      setAuth(key, { type: "oauth", refresh, access, expires, ...extra })
else if ("key" in result)     setAuth(key, { type: "api", key, metadata })
```

**两条都不命中时它既不保存也不报错**：`plugin-auth.json` 里没有记录，而界面照样显示「已登录」，
紧接着的 `providers?wait=1` 里找不到这个 account，就打出
「{user} 已登录，但 magpie 无法列出它，请反馈此问题」。

本包没有 refresh 端点（凭据是长期静态材料），但**这一格必须占上**：统一由
`src/credential.mjs` 的 `signInSuccess()` 填 `refresh`（与 `access` 同值）与 `expires: 0`。
`tests/signin-contract.test.mjs` 锁住两件事：`signInSuccess` 一定带 `refresh`；
**生产代码里不许再出现裸的 `type: "success"`**。

> 历史坑（别再犯）：0.2.36 之前，国内站与百智云都用 **API Key** 方式添加账号（`type: "api"`，走 api 分支），
> 于是「网页登录从来没存下来过」这件事一直没被发现，直到国际站（只能用网页 / 密码登录）撞上。
> 现在三家的登录入口都走 oauth（国内站只有 SSO 一条），这条约束依然有效：新增任何登录返回都要过 `signInSuccess`。

## 2. 鉴权：两套凭据，各管一段

```
推理：x-api-key: oma_…  +  X-OhMyAgent-Signature: v1=<hex HMAC-SHA256(signing_secret, prompt)>
额度/签到：Cookie: monkeycode_ai_session=…
```

- **推理凭据**：一对 `oma_…`（36 位）+ `signing_secret`（48 位），由平台在登录后签发，长期静态、没有 refresh 端点。
- **平台会话**：HttpOnly cookie，用户在浏览器里读不到（`document.cookie` 看不见），所以必须靠登录流程拿。
- 两者**完全解耦**：没有 cookie 时推理照常，只是查不到额度、签不了到。插件按这个前提做降级，不会因为缺 cookie 把账号判死。

### 签名覆盖的是 prompt，不是 body

```js
// src/monkeycode/signing.mjs
prompt 取值顺序：system → instructions（多块 join）→ messages 里首个 system → input 里首个 developer/system
signature = "v1=" + hex(HMAC-SHA256(signing_secret, prompt))
```

三个必须守住的点：

1. **必须基于最终序列化的 body 算签名**。先建 headers 再改 body，就会得到一个只在「body 恰好没变」时正确的签名，症状是 403 `invalid ohmyagent request`。
2. **空 prompt 也要签**（空串的 HMAC 是合法值）。「为空就跳过签名」会让边界请求 403。
3. **`system` 只取第一块，`instructions` 要全量 join** —— 这是实测出来的差别，写成同一种处理会在多块 instructions 时签名不匹配。

签名算法是公开的（上游 `backend/biz/llmproxy/ohmyagent_prompt.go`）。

## 3. 登录

### 3.0 三家的登录面（2026-11-09 实测，`auth.methods` 原样）

| provider | 方法序号 | type | label | 可选的 `prompts` |
|---|---|---|---|---|
| `monkeycode` | 0 | oauth | `MonkeyCode 猴子编程 用百智云账号开通` | `invite` |
| `monkeycodeintl` | 0 | api | `MonkeyCode 国际版 API Key` | — |
| `monkeycodeintl` | 1 | oauth | `MonkeyCode 国际版 账号密码登录` | `email`、`password` |
| `monkeycodeintl` | 2 | oauth | `MonkeyCode 国际版 从本机客户端导入` | — |
| `monkeycodeintl` | 3 | oauth | `MonkeyCode 国际版 浏览器登录` | — |
| `baizhi` | 0 | oauth | `百智云 BaiZhiCloud 从本机客户端导入` | — |
| `baizhi` | 1 | oauth | `百智云 BaiZhiCloud 浏览器登录` | `invite`、`monkeycodeInvite` |

`baizhi` 那两格是**两个不同的邀请码**（百智云的 `invite_code` / 国内站的 `inviter_id`），不是两个新按钮 ——
`ask()` 按顺序问，见 §3.4。`monkeycode` 那条手动入口只有一格（国内站的码）。

回归判据：`MAGPIE_PLUGIN_DISABLE_BROWSER=1 node --test tests/multi-provider.test.mjs` ——
登录面形状、`authorize()` 立刻返回、域隔离、邀请码语义都在那里锁着。

### 3.1 国内站：唯一入口「用百智云账号开通」（平时自动，这条是补开/恢复）

「国内 MonkeyCode 登录统一通过百智云 SSO 复用凭证」——所以国内站**自己**的 API Key /
账号密码 / 本机导入 / 浏览器登录四个入口全部下线，只剩这一条。
**但它平时不需要用户点**：百智云登录成功就会自动开通（见本节末尾「自动开通」）；
这条手动入口保留给两类情况 —— ① 插件装好**之前**就登录过的百智云账号（不做启动补开），
② 自动开通失败、想重试一次。

底层链路是平台自己的 SSO（2026-11-03 从登录页 `<a href>` 与 302 链实测）：

```
GET https://monkeycode-ai.com/api/v1/users/login[?redirect=&inviter_id=<码>]
  → 302 https://baizhi.cloud/oauth/authorize?client_id=monkeycode-ai
        &redirect_uri=<monkeycode>/api/v1/users/baizhi/callback
        &response_type=code&scope=user+phone&state=<uuid>
  → 百智云看 cookie：已登录就直接 302 回 callback?code=…
  → MonkeyCode 签发自己的 `monkeycode_ai_session`
```

**复用顺序**（`authorize()` 里依次判断，前一步成立就不往后走）：

| 步 | 来源 | 要不要开窗 | 失败/缺失时 |
|---|---|---|---|
| ① | magpie 账号库里**还没导入过**的百智云账号（`hasUnimportedBaizhiSession()` → `importOneBaizhiAccount()`） | 不开 | **一次只导一个**；已导入的记在 `~/.cache/magpie/monkeycode-imported.json`，点第二次导第二个 |
| ② | 本机桌面客户端里的百智云会话（`readDesktopBaizhiSession()`，两枚 cookie 到齐才算） | 不开 | 文件不在 = 正常路径，继续往下 |
| ③ | 本机持久 profile 里的百智云会话（`readCookiesSilently()`，无头读 `profileDirFor("baizhi")`） | 不开 | 读完没会话 → ④ |
| ④ | 打开百智云控制台让用户登一次（`startBrowserLogin()`，持久 profile，登完下次静默命中） | 开 | 起不来就 `opened:false` + 手动地址说明，交给 magpie 开系统浏览器 |

实现细节与坑：

- **③④ 必须在 12 秒内出结论再决定 `opened`**。后台起飞 + 立刻 `opened:true` 的组合在宿主里会翻车：
  spawn 失败时既没窗口、又没人去开系统浏览器（2026-11-04 真机卡死）。
- **`accept` 会真的问一次平台**：`createBaizhiCookieVerifier()` 用
  `GET /api/v1/user/profile`（百智云控制台接口）验候选 cookie，401 / 网络失败一律「还没登完」；
  同一份 cookie 只问一次。窗口一打开就有匿名会话，**读到 cookie ≠ 登录完成**。
- **身份只用平台 `data.user.id`**：兑换响应里的 `id` 是「这把 Key 的记录 id」，同一账号每兑换一次就变。
  拿它判重会让「同一账号第二次登录」变成新账号（每登一次多一张卡 + 多签发一把 Key）。
- **重复开通要说清楚**：同一身份再次开通时 `existingAccountWithUid()` 命中，返回里带一句提示 ——
  magpie 按 uid 去重，否则就是「提示成功但列表没变」的谜。
- **超时 30 秒**（换 Key）与 **240 秒**（等用户登窗口）；网络层失败在等待循环里继续等，只有「接口通了但报文被拒」才抛。

#### 自动开通：百智云登录成功 → 国内站账号自己开出来

上面这条手动入口**不是唯一的入口**：百智云登录（本机导入 / 浏览器登录，两条都走同一个 `finishSignIn()`）
成功后，插件会在后台用**同一份会话**走一次平台 SSO，把国内站账号开出来并**写进 magpie 的账号库**
（`client.auth.set`）。用户不用再点第二次。
契约与取证见 [自动凭证复用契约](./automatic-credential-reuse.md)；实现是 `src/monkeycode/provision.mjs`。

接线（`src/baizhi/runtime.mjs` 的 `finishSignIn()`）：

```js
if (typeof provision === "function" && site.id === "baizhi") {
  const identity = profile?.userId ?? exchanged.apiKey   // 幂等键：百智云账号身份
  void Promise.resolve().then(() => provision(cookie, { signal, identity })).catch(() => {})
}
```

四条硬约束（任何一条破了都会伤到用户）：

| 约束 | 为什么 | 落点 |
|---|---|---|
| **不 await** | 一次 SSO 要起无头浏览器、5~90 秒；等它 = 登录面板一直转圈，用户以为插件挂了 | `void …`；包一层微任务，连 provision **同步抛错**也不会把登录变成 rejected |
| **失败不改变百智云的结果** | 自动开通是"顺手做的事"，挂了只是少一张国内站卡 | `.catch(() => {})`；provision 内部**从不抛**，一律返回 `{ok:false, skipped/error}` |
| **只在百智云这条路上** | 国际站永不能被自动写 | `site.id === "baizhi"` 守卫 + provision 里目标站点是**常量** `SITES.monkeycode` |
| **同一份会话单飞** | 用户连点两次登录，不该换两次号（SSO 5~90 秒 + 多签一把 Key） | `sha256(cookie)[0:16]` 做键的 `inFlight` 表，第二个调用**共享同一个 Promise** |

键怎么选（`decideProvision`，纯函数，先读盘再决定）：

| 情况 | 写到哪 |
|---|---|
| 库里有 **同 uid** 的账号 | **原位重写**那个键（不新增账号行） |
| 库是空的 | 裸键 `monkeycode`（宿主自己的习惯：第一颗账号） |
| 裸键被**别的**身份占着 | `monkeycode#<sha256(uid)[0:8]>` —— **确定性**，同一身份永远落同一个键，重复登录天然幂等（用随机后缀就会"每登一次多一个账号"） |
| **uid 拿不到** | **不写**（没有幂等键） |
| **账号库读不出来**（坏 JSON / 顶层不是对象） | **不写** —— 宿主在坏库时写回照样发生，会把用户其它账号挤掉（原文件只留在 `.bad-<时间戳>`） |
| 凭据缺 `access_token` / `signing_secret` | **不写**（缺签名密钥写进去 = 每个请求 403，比不写更难查） |

写完之后**必须回读**（`readProvisionedAccounts` 再读一遍，比 `key + uid + access + refresh` 四样）：
宿主的 `auth.set` 在「`id` 不是字符串 / `body` 不是对象 / 账号库读不出来」时**照样回 `{data:true}` 但不落盘**，
也可能留下**旧凭据**（uid 对得上、access 是上一次的）—— 只比 uid 会把这两种都放过。

其它边界：

- **不做启动扫库**：模块顶层只有常量与函数定义，插件启动时**不会**替历史账号补开
  （理由见契约文档 §4：本地判不出"这个百智云账号有没有对应 MonkeyCode 账号"，补开 = 每号起一次 Chromium；
  而且静默建号会**消耗邀请关系**）。要补开就用上面那条手动入口。
- **邀请码不会绕过**：自动路径调的是 `signInWithBaizhiSession(cookie, SITES.monkeycode, { inviteCode })`，
  `inviteCode` 取自 `createInviteStore("monkeycode").read()` —— 与手动路径**同一个策略文件、同一个拼 URL 函数**；
  百智云那份 `baizhi-invite.json` 永不参与。
- **台账共用**：写入确认后调 `markImported(identity)`（与手动路径同一个 `monkeycode-imported.json`），
  否则自动开过的号会被手动路径再导一遍。台账写失败只记一行日志，不推翻"已经写进账号库"这个结论。
- **日志脱敏**：会话串、`access_token`、`signing_secret` 在日志与返回的 `error` 里都替成 `<redacted>`。
- **测试门闩**：`MAGPIE_PLUGIN_DISABLE_BROWSER=1` 是第一行判断（返回 `skipped:"test-latch"`），单测因此零网络、零浏览器。

### 3.2 百智云：本机导入 + 浏览器登录

百智云的登录面收敛为**两条**（API Key 与手机号验证码入口下线，见 §3.5）：

```
① 从本机客户端导入：%APPDATA%\com.chaitin.baizhi.monkeycode\baizhi-cookies.json
     → 取 sl-session + baizhi_session（两枚到齐才算）→ exchangeSessionForKey
② 浏览器登录：一次性/持久 Chromium 打开百智云控制台
     → 每 1s 读 cookie → acceptBrowserCookie() 真去换一次 Key
        ├ 换不到（401/403/网络/非 JSON） → false，继续等
        └ 换到（ok / needsKeyCreation） → true，登录完成
     → fetchProfile 取身份 → signInSuccess
```

- **五种官方方式都要可用**：微信扫码 / 支付宝 / 抖音 / GitHub / 观猹（外加账号密码）。
  登录页那排图标的第 4 个是**观猹**，所以插件**绝不**替用户点。自动点图标的
  `AGREE_PROTOCOL_JS` 已整段删除；`tests/multi-provider.test.mjs` 用 `doesNotMatch` 锁住生产代码里
  不出现 `onPoll`、自动脚本和 `ways[3].click`，防止以后误接。
- **`acceptBrowserCookie(cookie, site, { fetchImpl })`** 是这条路的判据，也是曾经的 bug：
  早期 `accept()` 恒返回 `true`，窗口一打开读到匿名 cookie 就"登录完成"，接着换 Key 失败，用户白登一次。
  现在它真的兑换，并且**同一份 cookie 不会每轮轮询都重兑一次**：
  - 拿到定论（`ok: true`）→ 进 `exchangeCache`，键 `<site.id>\n<cookie>`，LRU 上限 16；
  - 只拿到「账号下还没有可用 sk- Key」（`needsKeyCreation`）→ 进 `pendingExchange`，**一次性交接**给同一次登录的
    `finishSignIn`（取走即删），下次重试仍会重新请求；
  - 所有非 `ok` 结果还会进 **5 秒轮询负缓存**，只供 `accept` 抑制重复请求；`finishSignIn` 绝不读取，
    并在收尾时使它失效，因此建 Key 后的主动重试仍能恢复。
- **profile 用法（容易记反）**：百智云卡片的「浏览器登录」默认是**一次性** profile ——
  加第二个号就是再点一次，窗口里不会带着上一个号的登录态（复用会读到旧 cookie，magpie 按 uid 去重，
  用户看到「提示已添加、列表没变」）。**持久** profile `~/.cache/magpie/monkeycode-baizhi/profile`
  只有两处用：建 Key 页（`openKeyPage`）和**国内站 SSO 的第 ③④ 步**（读它 / 在里面登一次）。
- 远端模型目录有 45 个 id；额度 / 积分只认控制台 cookie（见 §7）。
- **登录成功之后**：`finishSignIn()` 先返回百智云的登录结果，再 fire-and-forget 地触发 §3.1 的**自动开通**
  （不 await、失败不影响百智云）。邀请码在 `ask()` 里问两格：`invite`（百智云）→ `monkeycodeInvite`（国内站）。

### 3.3 国际站：四条入口原样，且不接百智云

`API Key` / `账号密码登录`（纯 API，PoW 解验证码后 `POST /api/v1/users/password-login`）/
`从本机客户端导入` / `浏览器登录`。这三条 oauth + 一条 api 是国际站自己的登录面，**一条都没有删**：

- `signInWithBrowser()` / `loginWithPassword()` / `readDesktopMonkeyCodeSession()` 仍被国际站使用；
- 国际站的 `authorize()` 同样立刻返回，窗口里等 240 秒；
- **cookie 按本站域取**：`cookieDomains: [new URL(site.platformBaseUrl).hostname]`。
  两站同名 `monkeycode_ai_session`，不过滤域就会把另一站（或持久 profile 里上一个号）的会话当自己的 ——
  `tests/multi-provider.test.mjs` 从"桌面 cookie 文件"和"CDP 读到的 cookie"两侧各锁了一条断言；
- **不接邀请码**：`src/sites.mjs` 的两个拼码纯函数对 `monkeycodeintl` 一律返回原 URL。

### 3.4 邀请码：两套独立，只挂在登录入口上

邀请码是**可选输入**（`ask()` 返回 `text` prompt），不是多出来的一种登录方式。两套码互不相通，
**各存各的文件**：

| 填在哪 | `ask()` 的 key | 参数名 | 拼在哪 | 拼码函数 | 策略文件 | 生效时机 |
|---|---|---|---|---|---|---|
| 百智云「浏览器登录」第 1 格 | `invite` | `invite_code` | `https://baizhi.cloud/sign-in?invite_code=<码>` | `loginUrlWithInvite(site, code)` | `baizhi-invite.json` | 首次**注册**百智云账号 |
| 百智云「浏览器登录」第 2 格 | `monkeycodeInvite` | `inviter_id` | `https://monkeycode-ai.com/api/v1/users/login?redirect=&inviter_id=<码>` | `ssoEntryUrlWithInvite(site, code)` | `monkeycode-invite.json` | 首次**开通**国内站账号（**自动开通**会用它） |
| 国内站「用百智云账号开通」那格 | `invite` | `inviter_id` | 同上 | 同上 | `monkeycode-invite.json`（同一个） | 首次开通国内站账号（手动补开时） |

- **为什么两个参数名不一样**：是两家前端各自的写法（百智云 `/sign-in` 自己会把码转进 OAuth 启动请求；
  MonkeyCode 只在**首页** `?ic=` 种 localStorage，登录入口再把 `inviter_id` 拼进 SSO 请求）。
  一手取证见 [邀请机制取证](./baizhi-invite-research.md)。
- **为什么国内站的码要在百智云卡片上问**：百智云登录成功会**自动开通**国内站，而 MonkeyCode 的邀请关系
  **只在建号那一刻**生效 —— 自动开通抢跑就等于把上级奖励永久用掉。所以必须在**用户点登录的那一刻**
  就能把码交出来（`ask()` 能串"先问码、再登录"，静态 `prompts` 串不起来）。
- **「从本机客户端导入」没有输入框**：它不经过 `ask()`，自动开通直接用 `monkeycodeInvite.read()` 里**已保存**的码。
  想换码就先在「浏览器登录」那两格里填一次。
- **只影响建号那一刻**，事后补不了；已开通 / 已注册的账号带上它也无副作用（服务端照旧 302）。
- **输入语义**（`src/invite.mjs:resolveInvite`）：留空 / `0` / `1` = **沿用**当前码；其它 = 新码。
  填了非空就立刻落盘（否则这次没开通成功，用户下次还得再填一遍）。
  **只有从来没存过码时才是空码**（不带码登录）—— 插件不替用户造码，也不会在没码时静默用掉邀请机会。
- **按插件实例创建**：`createInviteStore(site.id)`，不用模块级单例 —— 多实例 / 多账号才不会抢同一个文件。
  删掉该文件 = 回到"不带码"。
- **国际站不接**：`monkeycodeintl` 的登录面没有邀请 prompt，两个拼码函数对它也原样返回。
- 拼码必须 `encodeURIComponent`：`o'k&1` → `inviter_id=o'k%261`，否则会拼出第二个 query 参数（静默改语义）。

### 3.5 API Key 只剩国际站；老凭据照样能用

`{ type: "api" }` 方式**刻意不写 `authorize`**：magpie 的 api 方式只收一个字符串，而 `inputs` 只在方法带
`prompts` 时才传（HOOKS 陷阱 2）。所以让宿主原样保存 `{ type:"api", key }`，由 `parseCredential` 解析三种输入：

```
{"access_token":"oma_…","signing_secret":"…"}   完整 JSON（推荐）
oma_…:密钥                                        冒号分隔
oma_…                                             裸 token（缺密钥，请求会 403，loader 给可读错误）
```

解析层**不校验前缀**（`oma_` 不是白名单），只要求 token 形状 `^[A-Za-z0-9_.\-/+=]{16,}$` ——
上游将来换前缀时，写死前缀会把新 Key 直接判成「凭据不完整」。

⚠ **入口收敛不等于凭据失效**：国内站与百智云虽然不再提供 API Key 输入框，但**已经落盘的
`{type:"api",key}` 账号照旧解析、照旧能推理**（`credentialOf` / `parseCredential` / `loader` 一行未动）。
这是刻意保留的兼容面：删入口是为了登录面收敛，不是为了让老用户掉线。

### 3.6 持久 profile：只有「百智云那份」在复用

| 用途 | profile 目录 | 现状 |
|---|---|---|
| 百智云持久登录态（唯一一份） | `~/.cache/magpie/monkeycode-baizhi/profile` | 国内站 SSO 的 ③ 静默读 / ④ 开窗、以及建 Key 页在用 |
| 百智云卡片「浏览器登录」 | 临时目录（`mkdtemp`） | **一次性**：关窗即删，加第二个号不会带上一个号的登录态 |
| 国际站「浏览器登录」 | 临时目录（`mkdtemp`） | **一次性**，同理 |
| MonkeyCode 两站的旧 profile 目录 | `…/monkeycode-monkeycode/profile`、`…/monkeycode-monkeycodeintl/profile` | 改造后**已不再使用**（留着不影响；删掉只影响旧会话） |

国内站那条「用百智云账号开通」用的是**百智云那份** profile（③ 静默读 → 没会话才 ④ 开窗 → 登完下次静默命中）。
所以"从这个入口登过一次，以后就不用登"成立；**国际站不参与**（它不认百智云 SSO，也没有这份复用）。

#### 华为云那个包到底怎么共享的（纠正一处旧说法）

旧版这里写过"华为云包给每个账号建持久浏览器目录，两个供应商打开控制台都用这份 profile"。**实测不是这样**：

- 它真正在跑的是**反方向读盘 + 不重登**：`authorize()` 一进去先找已保存的凭据
  （OfficeAce 客户端本地会话 → 内存 → `~/.config/magpie/plugin-auth.json`，**只读**），
  找不到才走华为云 OAuth；
- 跨 provider **写**记录的能力存在（`client.auth.set`），但它的注释明确说不再互写：
  华为云的 refresh token 是**一次性**的，两条记录共用一枚会互相把对方踢下线；
- 因此它也没有"共享浏览器 profile"这条路径。

对我们没有一次性 token 问题（`baizhi_session` 是长期静态 cookie，SSO 换来的是另一套独立凭据），
所以「先复用、最后才开窗」这条顺序可以照抄；**跨 provider 写记录**这条路我们也走通了 ——
但**不是**拿华为云那套一次性 token 去共享，而是「百智云会话再换一次国内站账号」，见 §3.1 的
「自动开通」与 [自动凭证复用契约](./automatic-credential-reuse.md)。

⚠ 持久 profile 意味着 cookie 会留在磁盘上，这是「不用重复登录」的代价 —— 不想留就删目录（只影响下次要重登）。

### 3.7 登录页

- 百智云控制台：`https://baizhi.cloud/console/`（`/console/login` 是 404，上游用的也是 `/console`）；
  带邀请码时改成 `https://baizhi.cloud/sign-in?invite_code=…`（`/sign-in` 才读码，`/console/` 不读）。
- MonkeyCode 国内站：**插件不再打开它自己的登录页** —— 用户只在百智云控制台里登录。
- MonkeyCode 国际站：`https://monkeycode-ai.net/login`。

⚠ 开 `ai-models.app.baizhi.cloud/console/keys` 会得到一片空白 +「登录状态已失效」——
那个 SPA 拿不到平台登录态时会 `location.replace("/")` 再渲染失败页，它**没有登录入口**。

⚠ 两枚 cookie 缺一不可：`sl-session`（设备/风控）+ `baizhi_session`（登录）。只带
`baizhi_session` 时 `/api/v1/user/profile` 会 401。而且 `sl-session` 同名有三枚，
必须按 `domain === 'baizhi.cloud'` 精确匹配 —— 另两枚属于 `ai-models.app.baizhi.cloud`
与 `agent-toolkit.app.baizhi.cloud`。

### 3.8 续期

**没有。** `auth.refresh` 恒返回 `undefined`，不发任何网络请求。凭据是长期静态材料，上游没有 refresh 端点；写一个「每 30 分钟刷新一次」只会制造一串注定失败的请求，并在面板上制造「续期失败」的假故障。

## 4. 额度

`GET /api/v1/users/wallet`（Cookie）：

| 字段 | 含义 | 换算 |
|---|---|---|
| `balance` | 积分余额 | **千分之一积分**（网页前端 /1000 显示） |
| `daily_token_balance` | 今日剩余 | 计费 token，不换算 |
| `daily_token_limit` | 今日上限 | 计费 token，不换算 |

`GET /api/v1/users/subscription` → `plan ∈ {basic, pro, ultra}`，只有档位名，**没有到期时间**（上游不下发，插件也不编）。

**额度用完之后默认走积分** —— 这是平台前端的账号级开关「额度耗尽后消耗积分」，默认开（字段缺省即按开处理），
写接口是 `PUT /api/v1/users/subscription/credit-consumption {enable_credit_consumption}`。
所以要提前预判"会不会变 403"没有意义：默认不会。一手取证（官方前端 bundle）见
[计费口径与目录契约](./monkeycode-model-billing.md) §2 的 A1–A4。

计费 token 的**换算口径**（每 token 的权重、以及额度与积分的兑换比例）**没有一手证据**，
插件因此**不做任何折算**：页面显示的是平台自己给的 `balance` / `daily_*` 原值。
（旧版本这里写过一条"额度与积分之间的换算比例"，那句没有一手出处，已删除；不要把它加回来。）

映射到 magpie 的两个窗口：

| 窗口 | 类型 | 字段 |
|---|---|---|
| 每日额度 | 数量型 | `amount = limit − remaining`、`limit`、`unit: "计费 token"`、`span: 86400` |
| 积分余额 | 钱包型 | `balance`、`unit: "积分"`（**不给** amount/limit —— 上游没有总额，给分母就是假占比） |

三个细节：

- **每日额度只有上限与剩余都有才画**。缺剩余时把 0 当剩余，会让用户以为今天已经用光。
- **负余额**（真机见过 −8.191）不能直接喂进度条：改成 `balance: 0` + `display: "-8.191 积分（已透支）"`。
- `signIn` 不因 cookie 401 写 `expired`：额度走 cookie、推理走 `oma_`，cookie 失效不影响发消息；标 expired 会把还能用的号判死。

## 5. 签到（PoW）—— 只有 MonkeyCode 两站有

```
GET  /api/v1/users/wallet/checkin        → { checked_in }      已签则直接 done，零写请求
POST /api/v1/public/captcha/challenge {} → { token, challenge: {c,s,d} }
     本地解 c 道题
POST /api/v1/public/captcha/redeem {token, solutions} → { token: captcha_token }
POST /api/v1/users/wallet/checkin {captcha_token}
```

题目派生（**1-based**，写成 0-based 会让 redeem 恒失败）：

```
第 i 题（i 从 1）：
  target = prng(token + i + "d", d)
  salt   = prng(token + i,     s)
  解：最小 n 使 hex(sha256(salt + n)) 以 target 为前缀
```

`prng` 是 FNV-1a 32 位 + xorshift32 变体（13 左 / 17 右 / 5 左，每步 `>>> 0`），每轮产出 8 位十六进制，拼够长度后截断。
比较口径是**十六进制前缀**，不是「前 d/2 个字节」—— 上游前端那份字节比较的 fallback 对奇数 d 会少比半个字节，照抄会被判 `invalid solutions`。

防护：单题 2000 万次、总计 500 万次预算；每解完一题让出一次事件循环，避免上游调高难度时冻结宿主。
**只有三种情况判 `captcha`**（题面形状不认识 / c·s·d 越界 / 预算打穿），其余失败如实报 `failed`。

奖励金额：上游不回（真机就是 `{checked_in:true}`，网页上那句「+100 积分」是前端常量），插件用「签到前后余额差」实测；两次读数有一次失败就回 0 + 说明，不编造。

⚠ **百智云有签到，而且形态不同**（2026-11-09 真机对照）：控制台按钮是「每日领积分 +100」，
`POST /api/v1/user/wallet/daily-temporary-credit`（body 只有 `{captcha_token}`），
**不是** MonkeyCode 的 `/api/v1/users/wallet/checkin`。它同样需要先解 captcha
（`/api/v1/public/captcha/challenge` → 本地 PoW → `/redeem`），与 MonkeyCode 是同一套题面。

`src/baizhi/runtime.mjs` 的 `auth.checkin` 因此分两步：

1. **先读钱包**（`GET /api/v1/user/wallet/balance`）的 `daily_temporary_credit_claimed`：
   已领取 ⇒ 0 个写请求直接回 `claimed`；钱包读失败 ⇒ `failed`，**绝不盲发 POST**。
2. 未领取才 challenge → 求解 → redeem → 领取。响应的 `claimed:false` 按幂等已领取处理
   （并发下另一个会话先领了）；到账金额只认领取前后「每日积分」的正差额，不硬编码 100。

`outcome` 用 `claimed` 而不是 `done`：宿主只在 `claimed` 时补领取时间，`done` 会显示成黄灯。
并发按账号单飞（`createRefreshLock({ replayMs: 0 })`），成功后清该账号的 usage 缓存。

## 6. 模型与窗口

网关没有远端目录（`GET /v1/models` → 405），所以目录只有内置快照（来源：平台侧 `GET /api/v1/users/models` 的快照）。

⚠ **模型 id 里不能有 `/`**（2026-11-03 真机踩到）：magpie 把 `<a>/<b>` 读成「provider a 的模型 b」，
于是上游的 `monkeycode-basic/deepseek-flash` 会让网关里凭空出现 `monkeycode-basic`、`monkeycode-pro`、
`monkeycode-ultra` 三个不存在的供应商，卡片提示「已登录，但 magpie 无法列出它」。

所以 magpie 侧的 id 用连字符压平（`monkeycode-basic-deepseek-flash`），上游真实 id 放 `apiId`，
由它决定请求体里的 `model`。`tests/multi-provider.test.mjs` 里有断言锁住这条。

### 前缀管的是「能调哪些模型」，不是"三个额度池"

- `monkeycode-basic/` `monkeycode-pro/` `monkeycode-ultra/` 前缀 = **模型范围 / 权限**：basic 账号请求 pro/ultra 前缀会被 403；
- **额度只有一个当日读数**（`daily_token_balance` / `daily_token_limit`），三档是 10M / 100M / 300M 的**上限值**，
  不存在"三个独立池子分别扣"；
- 不带前缀的直接扣积分；**档位条目把当日额度用完之后，同一条模型继续按积分扣**（不会切到另一条模型），
  这是账号级开关「额度耗尽后消耗积分」的默认行为（§4）。

### 显示名：一眼看出按什么计费

`prettyModelName()` 给每条模型加后缀（2026-11-09 起）：

| 上游 `model` | 卡片显示名 |
|---|---|
| `monkeycode-basic/deepseek-flash`、`monkeycode-pro/…`、`monkeycode-ultra/…` | `DeepSeek-Flash · 每日额度`（三档同名，差别在权限） |
| `deepseek-flash`（无前缀） | `DeepSeek-Flash · 积分` |

`readCatalog()` 读出时会用当前的 `prettyModelName(apiId ?? name)` 重算 `displayName` ——
旧缓存里残留的「基础档」不需要重拉目录就会变成新说法。

`config` 与 `provider.models` 都用 `configModels(site)` **整体替换**宿主传入的旧 `provider.models`，
不做双向合并。否则升级时旧「基础档」和已删除的积分孪生会被宿主持久化目录重新加回来。

### 积分孪生默认隐藏（R1 / R2 / R3）

同一个模型常常同时有「档位条目」和「无前缀条目」（`apiId` 去掉 `^monkeycode-(basic|pro|ultra)/` 后同名）。
默认只留**档位**那条：它额度用完会自动转积分（能力超集），而平台自己的默认选择也是先档位、后公共。
完整规则与反例见 [计费口径与目录契约](./monkeycode-model-billing.md) §4：

- **R1**：组内同时存在档位条目与无前缀条目 ⇒ 隐藏无前缀那条；多条档位条目时留最高档（ultra > pro > basic）；
- **R2**：组内**没有**档位条目 ⇒ 无前缀条目是唯一入口，保留；
- **R3**：`tier` 未知（订阅与钱包都读不出来）⇒ **不收窄也不去重**；
- **顺序**：先按档位收窄，再去重（反过来的话，「只有 ultra 孪生 + 无前缀」时会把唯一能用那条删掉）；
- **逃生阀**：`MAGPIE_MONKEYCODE_SHOW_CREDIT_TWINS=1` ⇒ 只关去重、保留权限过滤（怀疑两档不是同一权重时用）。

### 能力字段

- 上下文窗口只在**有实测证据**的 DeepSeek 系上声明 `1,048,576`（服务端 400 原文：
  `maximum context length is 1048576 tokens`）。其它模型未实测就不声明 ——
  这个字段会被 agent 拿去算压缩阈值，谎报比缺一条进度条代价大得多。
- 不声明 `reasoning` 档位：MonkeyCode 没有下发「每个模型支持哪些思考档位」的元数据，编一张表就是假能力。
- 图片能力只给明确能看图的模型标 `image`，其余一律 `["text"]`（五个模态键都写布尔，省略会被 models.dev 裸 id 投票误判）。

## 7. 百智云（第三个供应商）

与 MonkeyCode 是**两套账号体系**：独立凭据、按量计费、没有每日 token 额度（只有每日积分）。
它是 MonkeyCode 文档站背后的模型网关，但不是同一个平台。每日积分同样需要**领取**（不是自动到账），
插件通过 `auth.checkin` 自动完成，见上一节。

### 两套凭据，各管一段

| 凭据 | 能干什么 | 不能干什么 |
|---|---|---|
| 控制台 cookie（`baizhi_session` / `sl-session`） | 查积分、查用量、读资料、读 Key 列表、**换 Key** | 不能推理 |
| 推理 Key（`sk-` + 64 位，共 67 字符） | 调模型网关、拉模型目录 | 查不到积分（`x-api-key` 打控制台一律 401） |

⚠ 两个「两套」最容易搞混：

1. 控制台 `baizhi.cloud/api/v1/user/api-keys` 只发 **`bzy_`** 前缀（15 位），拿它打模型网关恒 401 ——
   真正能用的推理 Key 来自**大模型商店**的 console 接口
   `GET https://ai-models.app.baizhi.cloud/api/console/api-keys`（响应字段是 `api_key`，不是 `key`）；
2. 控制台 cookie 只够查余额，**不是**推理凭据 —— 但它可以拿来换 Key（这也是登录流程的最后一步）。

### 请求

```
POST https://ai-models.app.baizhi.cloud/api/anthropic/v1/messages
x-api-key: sk-…            ← 只有这一个鉴权头
anthropic-version: 2023-06-01
```

**没有签名头** —— 这是与 MonkeyCode 最大的差别，也是为什么它单独一个 runtime。

### 模型目录（唯一有远端的一家）

`GET https://ai-models.app.baizhi.cloud/api/anthropic/v1/models` →
`{"data":[{"id":"deepseek-v4-pro","type":"model","display_name":"…","created_at":"…"}]}`（实测 45 个 id）。

远端**没有能力字段**（窗口、图片都没有），所以：

- 窗口只从本地已知表补，且只给 4 条 DeepSeek（1,048,576，服务端 400 原文作证）；
- 图片只给明确知道能看图的 5 个模型；
- 未知模型照常列出，但不声明窗口、不声明图片 —— 省略比谎报安全；
- 远端失败退回 15 条内置表，**不返回空表**（空表会让用户的模型列表整片消失）。

### 积分

`GET https://baizhi.cloud/api/v1/user/wallet/balance`（cookie）：

| 字段 | 含义 | 换算 |
|---|---|---|
| `available_credit_cents` | 可用积分（必须） | **1/100 积分** |
| `temporary_credit_cents` | 每日积分（零点过期） | 1/100 积分 |
| `permanent_credit_cents` | 充值积分（长期有效） | 1/100 积分 |
| `frozen_credit_cents` | 冻结积分 | 1/100 积分 |
| `daily_temporary_credit_claimed` | 今天的每日积分领了没有 | 布尔 |

用量：`GET /api/v1/user/wallet/app-credit-usage?period=week|month|year` → `items[].{period, call_count, credit}`
（`period` 是**本地日历日**，所以「今天」也按本地时区算）。

映射到 magpie：**三个钱包型窗口**（可用积分 / 每日积分 / 充值积分）+ **一个 `textOnly` 窗口**（今日消耗）。
没有数量型窗口 —— 按量计费没有上限，硬造一个分母就是假占比。

- 每日积分 / 充值积分**只在余额 > 0 时才画**（0 是"没有这一档"，画出来反而像额度用光了）；
- 每日积分用官方 `runsOutAt` + `runsOut` 表达「零点过期」（`nextUtc8Midnight()`），不拼进 `display`；
- 今日消耗是 `textOnly` 窗口：只有文字，不参与路由排序（它本来也不是额度）。

## 8. 代码地图

| 文件 | 职责 |
|---|---|
| `index.mjs` | 只装配：导出三个插件工厂（`monkeycode` / `monkeycodeintl` / `baizhi`） |
| `src/sites.mjs` | 两站差异（域名、cookie 名、模型快照、图标）+ 邀请码拼 URL 的两个纯函数 |
| `src/invite.mjs` | 邀请码策略存储（`~/.cache/magpie/<provider>-invite.json`）与 `0/1/空=沿用` 语义 |
| `src/monkeycode/runtime.mjs` | MonkeyCode 九钩子装配 + 国内站唯一入口的复用链 |
| `src/monkeycode/sso-import.mjs` | 用百智云会话换 MonkeyCode 账号、从账号库逐个开通、`accept` 用的身份读取 |
| `src/monkeycode/provision.mjs` | **自动开通**：百智云会话 → 国内站账号 → 读盘选键 → `client.auth.set` → 回读校验 → 台账（单飞、失败不抛） |
| `src/monkeycode/desktop-session.mjs` | 桌面客户端 cookie 读取（两站按域判） |
| `src/monkeycode/signing.mjs` | 签名、prompt 提取、凭据解析、错误分类（纯函数） |
| `src/monkeycode/credits.mjs` | 平台接口：换 Key、钱包、订阅、签到、PoW |
| `src/monkeycode/catalog.mjs` | 模型目录缓存、`filterByTier` + 积分孪生去重、显示名 |
| `src/monkeycode/browser-login.mjs` | 受控 Chromium + CDP 轮询（薄壳，实现在 `session-login`） |
| `src/monkeycode-icon.mjs` / `src/baizhi-icon.mjs` | 官方图标（data URI） |
| `src/baizhi/site.mjs` | 百智云常量与 15 条兜底模型 |
| `src/baizhi/runtime.mjs` | 百智云九钩子装配（无 checkin）+ `acceptBrowserCookie` + 邀请码那格输入 |
| `src/baizhi/credits.mjs` | 钱包 / 用量 / 换 Key / 远端模型目录 |
| `src/baizhi/phone-login.mjs` | 手机号验证码纯 API 登录（**入口已下线**，模块保留给单测与将来复用） |
| `src/platform-http.mjs` | 三家共用的平台请求（cookie、信封、失败翻译、出站 UA） |
| `src/credential.mjs` | 三家共用的凭据解析与 `signInSuccess` |
| `src/session-login.mjs` | 三家共用的浏览器会话登录（CDP） |
| `src/quota.mjs` / `src/usage-cache.mjs` | 脚手架自带的额度构造器与缓存 |

## 9. 测试

```bash
node --test               # 309 条，全部离线（需要网络的地方注入 fetchImpl）
node scripts/check.mjs    # 49 条合规检查
```

- `MAGPIE_PLUGIN_DISABLE_BROWSER=1` 是单测门闩：任何一条登录路都不许真的拉起 Chromium。
- `tests/multi-provider.test.mjs` 锁**登录面形状**（国内站 1 条 / 百智云 2 条 / 国际站 4 条）、
  `authorize()` 立刻返回、`https://` 地址、两站同名 cookie 的域隔离、邀请码两套拼法、匿名 cookie 不被接受，
  以及自动开通的接线形态（`options.provision ??`、两格邀请、`sso: signInWithBaizhiSession`、源码里 0 处 `monkeycodeintl`）。
- `tests/provision.test.mjs` 锁**自动开通**的契约：记录体形状、读盘的前缀判据（`monkeycodeintl` 不串味）、
  键选择（原位 / 裸键 / 确定性 `#sha8`）、`auth.set` 参数、写后回读四样、坏库与空 uid 不写、
  单飞、失败隔离（sso / set / abort / 门闩）、台账只在成功后写、日志与 `error` 都脱敏。
- `tests/signin-contract.test.mjs` 锁登录结果的 `refresh` 位（§1.1）。
- `tests/catalog.test.mjs` 锁计费目录契约（显示名、R1/R2/R3、逃生阀）。
- `tests/monkeycode.test.mjs` 锁语义：签名公式与「改 body 签名跟着变」、prompt 提取顺序、凭据三种输入、
  cookie 归一、PoW 回归向量与解验证、信封解包、失败分类、额度窗口映射、loader 的请求改写。
