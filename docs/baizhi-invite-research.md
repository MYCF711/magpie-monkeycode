# 邀请码机制调研：百智云 / MonkeyCode

> 调研日期：**2026-11-09**（UTC 03:02–03:07）。
> 全程**匿名、只读**：只发无 Cookie 的 `GET`，只读公开 HTML 与公开前端 bundle。
> **没有注册账号、没有发验证码、没有登录、没有提交任何表单、没有读取或输出任何真实 cookie / token。**
> 本文所有「已确认」都在第 1 节的复现命令下可重跑；「未验证」单列在第 6 节，**不当结论用**。

---

## 0. 结论摘要

| 站点 | 邀请码是什么 | 邀请链接形态 | 参数名 | 携带位置 | 生效时点 |
|---|---|---|---|---|---|
| **MonkeyCode 国内站** `monkeycode-ai.com` | 邀请人的 **`user.id`**（数字 ID） | `https://monkeycode-ai.com/?ic=<code>` | `ic` → `inviter_id` | ① 首页 query `?ic=` → `localStorage["ic"]`；② 登录入口 query `GET /api/v1/users/login?redirect=&inviter_id=<code>` | **注册（首次 SSO 建号）那一刻**，事后补不了 |
| **百智云** `baizhi.cloud` | 平台下发的 `invite_code` 字符串 | `https://baizhi.cloud/sign-in?invite_code=<code>` | `invite_code` | OAuth 启动接口的 **query**：`GET /api/v1/user/oauth/login?platform=…&redirect_url=…&invite_code=<code>`；微信入口 `GET /api/v1/wechat/login?type=…&redirect_url=…&invite_code=<code>` | **好友完成注册后**（原文），事后补不了 |
| **MonkeyCode 国际站** `monkeycode-ai.net` | 同一份前端 bundle，但**硬编码的是 `.com` 域名** | 未知（复用 .com 链接） | 同上 | 同上（端点存在：`/api/v1/users/invitations` 401 而不是 404） | 未知，见 §5 |

三条对实现有直接影响的事实：

1. **两套邀请体系互不相干**：MonkeyCode 的 `inviter_id` 与百智云的 `invite_code` 是两个平台各自的推荐关系，
   SSO（`monkeycode → baizhi.cloud/oauth/authorize`）只搬身份，**不搬邀请关系**（§4）。
2. **邀请关系只在「建号」时建立**：两个平台的文案都是「好友通过该链接**注册**后」，
   没有「给已有账号补绑邀请码」的接口（§2.5、§3.4 的端点清单里没有 bind 类路径）。
3. **我们的插件现在一个邀请码都没带**：`src/invite.mjs` 只是通用骨架，
   `src/sites.mjs:70` / `src/baizhi/site.mjs:89` 的 `loginUrl` 都是裸登录页（§7 给最小接入点）。

---

## 1. 取证方法与边界

### 1.1 允许 / 禁止（本次实际执行）

| | 内容 |
|---|---|
| 允许 | 无 Cookie 的公开 `GET`；下载公开前端 bundle 并检索；读仓库源码 |
| 禁止（**未执行**） | 注册、`/user/phone_code` 发码、登录、提交 OAuth 授权、提交邀请、读取或输出任何真实 cookie/token |
| 关于浏览器 | 已载入 `ego-browser` skill；但本次唯一有价值的页面都在**登录之后**（禁止），匿名能拿到的只有公开 HTML 与 bundle。bundle 检索比 DOM 快照更精确（能逐字取到 URL 模板），所以实际用 `curl` + 检索完成，**没有启动浏览器** |

### 1.2 证据文件（本机临时目录，不含任何凭证）

| 文件 | 大小 (B) | sha256 前 16 位 | 来源 |
|---|---|---|---|
| `mc-index.js` | 6 123 247 | `301082a054a20cb2` | `https://monkeycode-ai.com/assets/index-0rgNk17_.js` |
| `bz-index-DYO0Oa6D.js` | 73 141 | `c2fc39756ed33230` | `https://baizhi.cloud/console/assets/index-DYO0Oa6D.js` |
| `bz-api-CQX99gwD.js` | 10 206 | `b284f8c147bea9ed` | `https://baizhi.cloud/console/assets/api-CQX99gwD.js` |
| `bz-wallet-WtvLRl7U.js` | 408 097 | `7638d96ba77cc008` | `https://baizhi.cloud/console/assets/wallet-WtvLRl7U.js` |
| `bz-signin-form.js` | 28 809 | `497d37672d34dfd5` | `https://baizhi.cloud/_astro/SignInForm.CbYraYul.js` |
| `bz-userv1.js` | 810 | `15d13d8afcdfb071` | `https://baizhi.cloud/_astro/UserV1.B1-Veu8K.js` |

> 存放目录仅用于本次调研的临时缓存（`/tmp/invite-research/`），**不是**交付物，也不含凭证：
> 全部是公开静态资源 + 匿名响应体。

### 1.3 复现命令（全部匿名只读，可重跑）

```bash
# ① 两端登录页都是 SPA 壳：真正的逻辑在 bundle 里
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" https://monkeycode-ai.com/login      # 200 3456
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" https://baizhi.cloud/console/        # 200 2309

# ② MonkeyCode 的邀请码就是 user.id：链接模板逐字取自 bundle
curl -s https://monkeycode-ai.com/assets/index-0rgNk17_.js \
  | grep -o 'https://monkeycode-ai.com/?ic=${[a-zA-Z.]*\.id[^}]*}' | sort -u

# ③ 登录入口把 localStorage 的 ic 作为 inviter_id 带出去
curl -s https://monkeycode-ai.com/assets/index-0rgNk17_.js \
  | grep -o '/api/v1/users/login?redirect=&inviter_id=' | sort -u

# ④ 匿名 GET 登录入口：302 到百智云授权页，Location 里**没有** inviter_id
curl -s -o /dev/null -D - \
  'https://monkeycode-ai.com/api/v1/users/login?redirect=&inviter_id=NOTAREALCODE123' | grep -iE '^(HTTP|location|set-cookie)'

# ⑤ 两个平台的「邀请相关」端点匿名一律 401（存在但要登录）
for u in https://monkeycode-ai.com/api/v1/users/invitations \
         https://baizhi.cloud/api/v1/user/invite-code \
         https://baizhi.cloud/api/v1/user/referrals?page=1\&size=100 ; do
  printf '%-60s ' "$u"; curl -s -o /dev/null -w '%{http_code}\n' "$u"
done
```

本次真实输出（节选，未做任何修饰）：

```
200 3456
200 2309
https://monkeycode-ai.com/?ic=${t.id||""}
https://monkeycode-ai.com/?ic=${ye.id}
/api/v1/users/login?redirect=&inviter_id=
HTTP/1.1 302 Found
Location: https://baizhi.cloud/oauth/authorize?client_id=monkeycode-ai&redirect_uri=https%3A%2F%2Fmonkeycode-ai.com%2Fapi%2Fv1%2Fusers%2Fbaizhi%2Fcallback&response_type=code&scope=user+phone&state=05f5ea1e-…
https://monkeycode-ai.com/api/v1/users/invitations      401
https://baizhi.cloud/api/v1/user/invite-code            401
https://baizhi.cloud/api/v1/user/referrals?page=1&size=100  401
```

> 401 的响应体是纯文本 `Unauthorized`（12 B）；`GET /api/v1/users/status` 同样是 401（80 B 的 JSON）。
> 三者都**没有** `Set-Cookie` —— 未登录时不下发会话（与 `docs/internals.md` §1 的既有结论一致）。

---

## 2. MonkeyCode（国内站 `monkeycode-ai.com`）

### 2.1 邀请码 = 自己账号的 `user.id`

前端生成邀请链接的两处（rewards 页与 wallet 对话框）逐字如下：

```js
// bundle 内两处，形如：
g = `https://monkeycode-ai.com/?ic=${t.id||""}`      // t = user 上下文
we = `https://monkeycode-ai.com/?ic=${ye.id}`        // ye = user 上下文
```

`user` 来自用户上下文 Provider，其数据源是 `GET /api/v1/users/status`：

```js
// 同一 bundle：
const t = (await new Ki().api.v1UsersStatusList()).data
const r = t?.data || null
const n = r?.user || null            // → { id, name }
```

⇒ **邀请码就是当前登录用户的 `data.user.id`**（数字），没有单独的「邀请码」字段。
AGENTS 0.1 的表里 `GET /api/v1/users/status` 返回 `data.user.{id,name}`，与此一致。

### 2.2 链接形态与 localStorage 种子

首页路由（`path: "/"` → 组件 `Y7e`）会把 query 里的 `ic` 写进 `localStorage`：

```js
const Y7e = () => {
  const [e] = useSearchParams()
  useEffect(() => { const t = e.get("ic"); t && localStorage.setItem("ic", t) }, [e])
  return jsx(G7e, {})          // 首页外壳
}
```

⚠ **只有首页 `/` 读 `?ic=`**：`path: "/login"` 挂的是另一个组件（`m7e`），它**只从 `localStorage` 取值**。
所以「`/login?ic=xxx` 也能种上」是错的 —— 种子必须落在首页。

### 2.3 登录入口的携带位置：`inviter_id`（query）

bundle 里 4 处一模一样的模板（登录页、welcome 外壳、两个页头）：

```js
`/api/v1/users/login?redirect=&inviter_id=${typeof window < "u" && localStorage.getItem("ic") || ""}`
```

匿名实测（无 Cookie）：

```
$ curl -s -o /dev/null -D - 'https://monkeycode-ai.com/api/v1/users/login?redirect=&inviter_id=NOTAREALCODE123'
HTTP/1.1 302 Found
Location: https://baizhi.cloud/oauth/authorize?client_id=monkeycode-ai
        &redirect_uri=https%3A%2F%2Fmonkeycode-ai.com%2Fapi%2Fv1%2Fusers%2Fbaizhi%2Fcallback
        &response_type=code&scope=user+phone&state=<uuid>
```

三种取值（无参 / 空值 / 假码）的响应**形状完全一致**：302、`Content-Length: 0`、无 `Set-Cookie`、
Location 里**不带** `inviter_id`，只有 `state` 不同。

⇒ 已确认：**前端确实用 `inviter_id` 这个参数名把码交给登录入口**。
⇒ 未确认：服务端怎么记住它（见 §6）。

### 2.4 生效时点：注册（首次 SSO 建号）

- 文案原文（简体）：`将邀请链接分享给好友，好友通过该链接注册后，你将获得 5000 积分奖励。`
- 另一处：`分享邀请链接，好友通过链接注册后你可获 5000 积分（奖励上限 10 人，即 5 万积分）。`
- `docs/internals.md` §「用百智云账号开通」已写明：`monkeycode → baizhi.cloud/oauth/authorize → callback`
  这条链是**首次登录自动建号**。

⇒ 邀请关系在「这个 MonkeyCode 账号第一次被创建」时建立；已有账号再走一遍不会补绑。

### 2.5 自己的码 / 已邀请列表

| 用途 | 端点 | 匿名结果 | 响应形状（前端取用） |
|---|---|---|---|
| 自己的邀请码 | **没有专用端点** | — | 码 = `GET /api/v1/users/status` 的 `data.user.id` |
| 已邀请列表 | `GET /api/v1/users/invitations?page=1&size=20` | 401 `Unauthorized` | `{code:0, data:{items:[…], count:N}}` |

```js
v1UsersInvitationsList: (t, r = {}) => this.request({
  path: "/api/v1/users/invitations", method: "GET", query: t, format: "json", ...r })
// 调用处：Ie("v1UsersInvitationsList", { page: 1, size: 20 }, [], k => {
//   if (k.code === 0) { const S = k.data?.items || []; o(S); u(k.data?.count || S.length) }
// })
```

列表渲染出的列：头像（`invite.avatarAlt`）、名字（取不到显示「未命名用户」）、
「{{time}}注册」（`dayjs.unix(created_at)`）、「+{{points}} 积分」。
**单条 item 的字段名没有从前端逐字取到**（组件里做了映射，未定位到映射函数）—— 记为未验证项。

### 2.6 奖励规则（公开文案，逐字）

| 项 | 值 |
|---|---|
| 每邀请 1 位新用户 | **+5,000 积分**（徽标写死 `+5,000`；i18n `每邀请 1 位新用户 → +5000 积分`） |
| 奖励上限 | **10 人**（`奖励上限 10 人，即 5 万积分`） |
| 积分流水类型 | `TransactionKindInvitationReward = "invitation_reward"`，中文名 `邀请奖励` |
| 反作弊条款 | `…通过批量注册、伪造身份、作弊邀请、脚本刷量、异常设备或其他恶意方式套取、盗刷、骗取邀请注册积分…`（用户协议原文） |

> ⚠ 最后一条对实现是硬约束：**任何脚本化自动邀请都属于平台明令禁止的行为。**
> 插件只能「把用户自己的码带到 URL 上」，不能替用户去拉新、不能批量注册。

---

## 3. 百智云（`baizhi.cloud`）

### 3.1 自己的码：`GET /api/v1/user/invite-code`

```js
// bundle bz-api-CQX99gwD.js 生成的 SDK：
W = (e = {}) => i({ path: "/api/v1/user/invite-code", method: "GET", type: Json, format: "json", ...e })
// 调用处（wallet chunk）：
const { data: n } = useQuery(() => inviteCodeApi({ isAlert: false }), …)
const u = n?.invite_code?.trim()
```

- 端点：`GET https://baizhi.cloud/api/v1/user/invite-code`
- 匿名：**401** `Unauthorized`
- 响应字段：`data.invite_code`（字符串）

### 3.2 邀请链接

```js
if (!u) return ``
let e = `/sign-in?invite_code=${encodeURIComponent(u)}`
return typeof window > "u" ? `https://app.baizhi.cloud${e}` : `${window.location.origin}${e}`
```

⇒ 浏览器里是 **`https://baizhi.cloud/sign-in?invite_code=<code>`**（`window.location.origin` 就是 `baizhi.cloud`）。
SSR 兜底用的 `app.baizhi.cloud` 在本机 **DNS 解析不到**（`curl` 返回 `000`），不要拿它当规范域名。

### 3.3 携带位置：OAuth 启动接口的 **query** 参数 `invite_code`

`baizhi.cloud/sign-in` 是 Astro 页 + `SignInForm` 岛，读 URL 的 `invite_code` 后**原样塞进启动请求**：

```js
function E() { return new URLSearchParams(location.search).get("invite_code")?.trim() || undefined }

// 第三方登录（支付宝 / 抖音 / GitHub / Watcha / 教育）：
const h = E()
S({ platform: i, redirect_url: C().href, ...h ? { invite_code: h } : {} }).then(w => { window.location.href = w.url })

// 微信扫码：
const F = E()
U({ type: k ? "oa" : "web", redirect_url: A.href, ...F ? { invite_code: F } : {} }).then(f => { … })
```

对应的真实请求（`S` = `UserV1.B1-Veu8K.js` 的 `e` 导出；`U` = `SignInForm` 顶部就地定义）：

| 入口 | 方法与路径 | 查询参数 |
|---|---|---|
| 第三方 OAuth 启动 | `GET /api/v1/user/oauth/login` | `platform` ∈ `alipay` / `douyin` / `github` / `watcha` / `ministry_of_education`，`redirect_url`，`invite_code` |
| 微信扫码启动 | `GET /api/v1/wechat/login` | `type` ∈ `oa` / `web`，`redirect_url`，`invite_code` |
| 手机号 + 短信码 | `POST /api/v1/user/login/phone` | body `{phone, code, captcha_token}` —— **不带** `invite_code`（前端没传） |

`redirect_url` 的默认值是 `/console/apps`（`header` chunk 的 `Se()`：没有合法 `redirect` 就退回 `new URL("/console/apps", location.origin)`）。

### 3.4 已邀请列表：`GET /api/v1/user/referrals`

```js
K = (e = {}, t = {}) => i({ path: "/api/v1/user/referrals", method: "GET", query: e, type: Json, format: "json", ...t })
// 调用处：referralsApi({ page: 1, size: 100 }, { isAlert: false })
```

- 匿名：**401**
- 前端取用：`data.items[]`，每条形如
  `{ referee_user_id, created_at, rewarded_at, inviter_reward_amount }`
- 展示口径：`rewarded_at ?? created_at` 作「注册时间」；`inviter_reward_amount / 100` 作「奖励积分」；
  状态列写死 `成功`；表头 `受邀用户 / 注册时间 / 状态 / 奖励积分`

### 3.5 奖励规则（公开文案，逐字）

```
好友完成注册后，你可获得 ${pF} 积分，最高可得 ${pF * hF} 积分。     // pF = 500, hF = 20
好友可享新用户 ${mF} 积分。                                        // mF = 500
* 若存在异常邀请或作弊行为，平台有权取消奖励资格。
```

| 项 | 值 |
|---|---|
| 每位受邀新用户，邀请人得 | **500 积分** |
| 奖励上限 | **20 人**（= 10,000 积分） |
| 被邀请的新用户得 | **500 积分** |
| 反作弊 | 「异常邀请或作弊行为，平台有权取消奖励资格」 |

（`pF = 500, mF = 500, hF = 20` 与文案在同一个 chunk 的同一作用域，逐字取自 `wallet-WtvLRl7U.js`。）

---

## 4. 两套邀请体系互不相干（与 SSO 的边界）

```
MonkeyCode 邀请：  ?ic=<user.id>  →  localStorage["ic"]  →  /api/v1/users/login?inviter_id=<code>
                                                                ↓ 302
百智云授权：        baizhi.cloud/oauth/authorize?client_id=monkeycode-ai&…
百智云邀请：        /sign-in?invite_code=<code>  →  /api/v1/user/oauth/login?invite_code=<code>
```

- MonkeyCode 的登录入口把 query **原样丢进 302** 的只有 `client_id / redirect_uri / response_type / scope / state`
  —— 没有 `inviter_id`，也没有 `invite_code`（§2.3 实测）。
- 百智云的 OAuth 启动接口是**另一个域名、另一套参数**（`invite_code`，§3.3）。
- ⇒ 「用百智云账号开通 MonkeyCode」这条 SSO 链**只搬身份**。
  想让**两边都记账**，必须**各自带各自的码**：MonkeyCode 侧带 `inviter_id`，百智云侧带 `invite_code`。
  这是两个独立字段，不存在「带一个就两边都有」。

---

## 5. 国际站（`monkeycode-ai.net`）

| 探针 | 结果 |
|---|---|
| `GET https://monkeycode-ai.net/login` | 200，引用**同一份 bundle** `/assets/index-0rgNk17_.js`（与国内站同一个 hash） |
| `GET /api/v1/users/login?redirect=&inviter_id=TESTCODE123` | 302 → `Location: /oauth/authorize?client_id=&redirect_uri=https%3A%2F%2Fmonkeycode-ai.net%2Fapi%2Fv1%2Fusers%2Fbaizhi%2Fcallback&…`（`client_id` **空**，不经 baizhi） |
| `GET /api/v1/users/invitations` | **401** `Unauthorized`（12 B）—— 端点存在 |

两条判断：

1. 前端是同一份构建，所以 `?ic=` / `inviter_id` 的模板一字不差 ——
   但**链接里硬编码的是 `https://monkeycode-ai.com/?ic=…`**（`.com`，不是 `.net`）。
   国际站用户点「复制邀请链接」，拿到的是国内站域名。
2. 国际站没有百智云 SSO（`client_id=` 空），`inviter_id` 交给它只会进它自己的 `/oauth/authorize`。
   **国际站是否真的发奖、是否认 `inviter_id`，本次无法匿名验证。**

⇒ 按团队目标「国际版保持独立」：**不接**。理由不是「确认不支持」，而是
「拿不到一手证据 + 硬编码域名指向 .com + 与 SSO 无关」，接了只会制造跨站归因错误。

---

## 6. 已验证 / 未验证

### 6.1 已验证（第一手，可重跑）

| # | 事实 | 证据 |
|---|---|---|
| V1 | MonkeyCode 邀请码 = 自己的 `user.id` | bundle 两处 `?ic=${user.id}` + `v1UsersStatusList() → data.user` |
| V2 | 种子只在首页 `/` 生效（`?ic=` → `localStorage["ic"]`） | `path:"/"` → `Y7e` 的 `useSearchParams` |
| V3 | 登录入口参数名是 `inviter_id`，在 query 上 | 4 处模板 + 匿名 302 实测 |
| V4 | 匿名 302 的 `Location` 不含 `inviter_id`、不带 `Set-Cookie` | §2.3 实测 |
| V5 | MonkeyCode 的「自己的码」没有专用端点 | 全量 `/api/v1/users/*` 路径清单里无 invite 类 GET（只有 `invitations` 列表） |
| V6 | 已邀请列表 `GET /api/v1/users/invitations?page&size` → `{code,data:{items,count}}` | bundle 调用处 + 匿名 401 |
| V7 | MonkeyCode 奖励 5,000 积分/人、上限 10 人、流水类型 `invitation_reward` | i18n 与枚举原文 |
| V8 | 百智云自己的码 `GET /api/v1/user/invite-code` → `data.invite_code` | `bz-api` 的 `W` + `n?.invite_code` |
| V9 | 百智云邀请链接 `https://baizhi.cloud/sign-in?invite_code=<code>` | wallet chunk 的模板 + `location.origin` |
| V10 | 百智云把 `invite_code` 作为 **query** 交给 `/api/v1/user/oauth/login` 与 `/api/v1/wechat/login` | `SignInForm` 的 `E()` + 两个调用点 |
| V11 | 百智云手机号+短信码登录**不**带 `invite_code` | `SignInForm` 的 `B({...i, captcha_token})` |
| V12 | 百智云已邀请列表 `GET /api/v1/user/referrals?page&size` → `items[]` | bundle 调用处 + 匿名 401 |
| V13 | 百智云奖励 500 积分/人、上限 20 人、新用户 500 | `pF=500, mF=500, hF=20` + 文案原文 |
| V14 | 国际站同一份 bundle；`client_id=` 空；`invitations` 401 | §5 实测 |
| V15 | 未登录时两端都不下发会话 cookie | 各 401/302 响应头均无 `Set-Cookie`（`/sign-in` 的匿名 `sl-session` 除外，见下） |

> 关于 `/sign-in` 的 `Set-Cookie: sl-session=<redacted>`：这是一次**匿名访问**下发的设备/风控会话，
> 与账号无关，值不落盘、不记录、不引用。

### 6.2 未验证（本次**故意**不验，因为需要注册/登录）

| # | 未验项 | 为什么不能验 | 真实验证需要 |
|---|---|---|---|
| U1 | 服务端是否真的把 `inviter_id` 落到**新建**账号上 | 需要一次真实注册（禁止） | 用一个已有账号的 id 做邀请人，注册一个新号，看 `GET /api/v1/users/invitations` 是否出现该条 |
| U2 | `inviter_id` 传**非法值**时是静默忽略还是报错 | 同上；匿名下三种取值响应形状一致 | 同上，比较「合法码 / 非法码 / 空」三次注册后的 `invitations` |
| U3 | 邀请列表单条 item 的**字段名** | 前端做了字段映射，未定位到映射函数 | 登录后 `curl` 一次 `invitations`，看原始 JSON |
| U4 | 百智云 `inviter_reward_amount` 的单位 | 只看到前端 `/100` 显示 | 登录后看一眼原始值是否 = 50000 |
| U5 | 国际站是否认 `inviter_id` / 是否发奖 | 需要国际站注册 | 同 U1 |
| U6 | 邀请关系能否「事后补绑」 | 端点清单里没有 bind 类路径，但「没有路径」不等于「服务端没有其他入口」 | 登录后看前端是否有补绑 UI（目前 bundle 里没有） |

---

## 7. 最小接入方案（可实施契约）

> 本节只给契约与落点，**不改代码**（本任务写作用域只有这份文档）。

### 7.1 语义：复用 `src/invite.mjs` 已有的三个数

`src/invite.mjs` 已经定了语义，**不要另造一套**：

| 输入 | 含义 |
|---|---|
| 留空 / `0` / `1` | 沿用当前策略里的码（`resolveInvite`） |
| 其它 | 当作新码 |

存储位置：`~/.cache/magpie/<prefix>-invite.json`（`createInviteStore(prefix)`，只写 cache、原子写、可整目录删）。

⚠ 本厂商**没有**「与码配对的额外字段」：MonkeyCode 只有 `inviter_id`，百智云只有 `invite_code`。
`createInviteStore` 的 `extra`（Accio 的 `sId` 那套）**用不上，不要硬塞**。

### 7.2 唯一需要新增的东西：两个纯函数，把码拼进 URL

```js
// 建议落在 src/sites.mjs（纯数据，可单测；不要放在 runtime 里）。
// 两个函数，因为 MonkeyCode 有两条入口，形态不同（见下表）。
export function loginUrlWithInvite(site, code) {
  const c = String(code ?? "").trim()
  if (!c) return site.loginUrl                                    // 空码：一字不改（保持现状）
  if (site.id === "monkeycode") return `https://monkeycode-ai.com/?ic=${encodeURIComponent(c)}`
  if (site.id === "baizhi") return `https://baizhi.cloud/sign-in?invite_code=${encodeURIComponent(c)}`
  return site.loginUrl                                            // 国际站：保持独立
}

// SSO 入口（直奔登录接口，不加载 SPA 壳）
export function ssoEntryUrlWithInvite(site, code) {
  const c = String(code ?? "").trim()
  if (!c) return `${site.platformBaseUrl}/api/v1/users/login`
  return `${site.platformBaseUrl}/api/v1/users/login?redirect=&inviter_id=${encodeURIComponent(c)}`
}
```

具体形态按站点分叉（三行表，别再抽象）：

| 站点 | 带码后的 URL | 为什么是这个形态 |
|---|---|---|
| `monkeycode`（SSO 路径） | `https://monkeycode-ai.com/api/v1/users/login?redirect=&inviter_id=<code>` | 前端自己的模板就是这条（V3）；SSO 走它就会建号 |
| `monkeycode`（浏览器登录路径） | 先 `https://monkeycode-ai.com/?ic=<code>` 种 `localStorage`，再 `Page.navigate("https://monkeycode-ai.com/login")` | 只有首页读 `?ic=`（V2）；直接开 `/login?ic=` **不会**生效 |
| `baizhi` | `https://baizhi.cloud/sign-in?invite_code=<code>` | V9；登录页自己会把它转进 OAuth 启动请求（V10） |
| `monkeycodeintl` | **不带**（保持 `https://monkeycode-ai.net/login`） | §5：拿不到证据 + 硬编码 .com 域名 |

### 7.3 各入口怎么接（现状锚点）

| 入口 | 文件:行 | 现状 | 接法 |
|---|---|---|---|
| 用百智云账号开通（SSO） | `src/monkeycode/sso-import.mjs:242` | `Page.navigate({ url: \`${site.platformBaseUrl}/api/v1/users/login\` })` | 改成 `${site.platformBaseUrl}/api/v1/users/login?redirect=&inviter_id=${encodeURIComponent(code)}` |
| 浏览器登录（MonkeyCode） | `src/monkeycode/runtime.mjs:242` | `browserLogin({ url: site.loginUrl ?? … })` | 有码时先导航到 `?ic=`，再由 `accept()` 之前导航到 `/login`（该 profile 是**一次性**的，见 `runtime.mjs:245` 的注释 —— 所以必须同一次会话内完成两步） |
| 浏览器登录（百智云） | `src/baizhi/runtime.mjs:187` | `url: site.loginUrl`（= `https://baizhi.cloud/console/`） | 有码时改成 `https://baizhi.cloud/sign-in?invite_code=<code>`；⚠ 注意 `/console/` 与 `/sign-in` 是两个入口，`/console/` 未登录时给的是登录框，`/sign-in` 才读 `invite_code` |
| 手机号验证码登录（百智云） | `src/baizhi/phone-login.mjs` | 两个 HTTP 请求 | **不需要改**：这条链根本不带 `invite_code`（V11） |

⚠ 两条落地注意：

1. **码必须在「建号那一次」的 URL 上**。两个平台都是「注册后」记账，事后补不了（§2.4、§3.5）。
   对已存在的账号带码是**无害但无效**的 —— 文案要说清楚，别让用户以为补上了。
2. **不要自动替用户邀请别人**。两家的条款都明文禁止脚本刷量（§2.6、§3.5），
   插件只做「把用户自己填的码放到 URL 上」。

### 7.4 可跑的最小测试（真红）

纯函数一落盘就能锁死，不需要网络：

```js
// tests/invite-url.test.mjs —— 形状锁
import { test } from "node:test"
import assert from "node:assert/strict"

test("空码 = 原 URL 一字不改", () => {
  assert.equal(loginUrlWithInvite(SITES.monkeycode, ""), "https://monkeycode-ai.com/login")
  assert.equal(loginUrlWithInvite(SITES.monkeycode, "  "), "https://monkeycode-ai.com/login")
  assert.equal(loginUrlWithInvite(SITES.monkeycode, undefined), "https://monkeycode-ai.com/login")
})

test("国内站 SSO：参数名必须是 inviter_id（写错时服务端照旧 302，只能靠断言锁）", () => {
  const u = new URL(ssoEntryUrlWithInvite(SITES.monkeycode, "12345"))
  assert.equal(u.pathname, "/api/v1/users/login")
  assert.equal(u.searchParams.get("inviter_id"), "12345")
  assert.equal(u.searchParams.get("redirect"), "")   // 前端模板里 redirect 恒为空
})

test("百智云：参数名必须是 invite_code，且落在 /sign-in", () => {
  const u = new URL(loginUrlWithInvite(BAIZHI, "ABC-123"))
  assert.equal(u.hostname, "baizhi.cloud")
  assert.equal(u.pathname, "/sign-in")
  assert.equal(u.searchParams.get("invite_code"), "ABC-123")
})

test("国际站：不带任何邀请参数（保持独立）", () => {
  assert.equal(loginUrlWithInvite(SITES.monkeycodeintl, "12345"), "https://monkeycode-ai.net/login")
})

test("特殊字符必须被编码，不能拼出第二个 query 参数", () => {
  assert.equal(new URL(loginUrlWithInvite(BAIZHI, "a&b=c")).searchParams.get("invite_code"), "a&b=c")
})
```

失败分支是真红：把 `inviter_id` 手滑写成 `inviterId`，上面第二条断言立刻红；
把国际站也接上，第四条立刻红。

本次把上面两个函数**原地实现**（`/tmp/invite-contract/contract.test.mjs`，直接 `import` 仓库里的
`src/sites.mjs` / `src/baizhi/site.mjs`），5 条断言真跑：

```
$ node --test contract.test.mjs
✔ 空码 = 原 URL 一字不改 (0.6393ms)
✔ 国内站 SSO：参数名必须是 inviter_id (0.1821ms)
✔ 百智云：参数名必须是 invite_code，且落在 /sign-in (0.1052ms)
✔ 国际站：不带任何邀请参数（保持独立） (0.0651ms)
✔ 特殊字符必须被编码 (0.1014ms)
ℹ pass 5
ℹ fail 0

# 再把 inviter_id 改成 inviterId（模拟手滑），确认真红：
$ sed 's/inviter_id=/inviterId=/' contract.test.mjs > red.test.mjs && node --test red.test.mjs
✖ 国内站 SSO：参数名必须是 inviter_id (0.5527ms)
    actual: null,
    expected: '12345',
ℹ pass 4
ℹ fail 1
$ echo $?
1
```

### 7.5 不要做的事

| ✗ 反模式 | 为什么 |
|---|---|
| 拿 `?ic=` 去开 `/login` | 只有首页 `/` 读 `?ic=`（V2），`/login` 只读 localStorage ⇒ 静默无效 |
| 以为「带了 MonkeyCode 的码，百智云那边也有记录」 | 两套独立体系（§4），字段名都不同 |
| 以为能「事后补绑邀请关系」 | 两家都是「注册后」记账，没有 bind 端点（U6） |
| 把 `app.baizhi.cloud` 当邀请域名 | 本机 DNS 解析不到（§3.2），规范域名是 `baizhi.cloud` |
| 在国际站带 `inviter_id` | 它没有百智云 SSO，且前端硬编码 `.com` 域名（§5） |
| 自动替用户邀请 / 批量注册 | 两家条款明文禁止（§2.6、§3.5） |

---

## 8. 需要一次真实注册才能关门的三件事（本次禁止，留给真机）

1. **U1**：new 账号是否真被记账 —— 判据：用 A 号的 id 作 `inviter_id` 注册 B 号，
   然后用 B 号的会话 `curl 'https://monkeycode-ai.com/api/v1/users/invitations?page=1&size=20'`，
   看 `data.items` 里是否出现 A。
2. **U2**：非法 `inviter_id` 是静默忽略还是 400 —— 判据：`inviter_id=0` / `inviter_id=abc` 各注册一次，
   比较两次的「注册是否成功 + `invitations` 是否为空」。
3. **U4**：百智云 `inviter_reward_amount` 的单位 —— 判据：登录后看原始 JSON 是否 = `50000`（=500 积分 ×100）。

---

## 9. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-09 | 首版：匿名只读探明两端邀请机制；给出 URL 契约与最小接入点；列 6 条未验项 |
