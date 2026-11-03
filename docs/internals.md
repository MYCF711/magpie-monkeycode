# 实现细节与取证

> README 只讲用户能看到什么；这里讲协议、取舍和「验证到哪一步」。
> 所有事实来自 2026-11-03 读取 [`iJetLi/dsh-providers-hub`](https://github.com/iJetLi/dsh-providers-hub)
> 的 `src/monkeycode-*.ts` 与 `src/baizhi-*.ts`（该仓库是 Betsy20/magpie-Jet-Hub 的上游，
> commit `9047d42`）。第 1-7 节讲 MonkeyCode，第 8 节讲百智云。

## 1. 两个站点，一份协议

| | 国内站 | 国际站 |
|---|---|---|
| provider id | `monkeycode` | `monkeycodeintl` |
| 平台 | `https://monkeycode-ai.com` | `https://monkeycode-ai.net` |
| 推理网关 | `https://proxy.monkeycode-ai.com/v1` | `https://proxy.monkeycode-ai.net/v1` |
| 会话 cookie | `monkeycode_ai_session` | 同名（**未真机验证**，见下） |
| 接口路径 | `/api/v1/...` | 逐字相同 |

两站是同一程序的两套部署：`GET /v1/models` 在两边都返回 405（逐字节一致的行为），平台接口路径也完全相同。
**账号池不互通** —— 国内站的 cookie 打国际站回 401，这是上游 RPC 层真机踩过并写进注释的事实。

未验证项（照抄上游标注，不当作已确认）：

- 国际站换 Key 端点的响应字段、cookie 名是否与国内一致；
- 国际站账号级登录本仓没有真机跑通（上游源码里同时存在「真机验过」与「只有国内账号」两种说法）。

## 2. 鉴权：两套凭据，各管一段

```
推理：x-api-key: oma_…  +  X-OhMyAgent-Signature: v1=<hex HMAC-SHA256(signing_secret, prompt)>
额度/签到：Cookie: monkeycode_ai_session=…
```

- **推理凭据**：一对 `oma_…`（36 位）+ `signing_secret`（48 位），由平台在登录后签发，长期静态、没有 refresh 端点。
- **平台会话**：HttpOnly cookie，用户在浏览器里读不到（`document.cookie` 看不见），所以必须靠浏览器登录或手工粘贴。
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

### 浏览器登录

```
开一次性 Chromium（独立 user-data-dir） → platformBaseUrl
  ↘ 每 1s：CDP 读 cookie → 有会话就试 POST /api/v1/users/ohmyagent/api-keys
       ├ 401/403 → 继续等（窗口一打开就有匿名会话，读到 cookie ≠ 登录完成）
       └ 200 → { id, api_key, signing_secret, created_at }
  ↘ GET /api/v1/users/status → data.user.{id,nickname}
```

- **为什么不能「读到 cookie 就算成功」**：窗口一开，服务端就下发匿名 `monkeycode_ai_session`。把它当登录完成，用户刚登完却看到「会话已失效」，窗口还被收掉 —— 等于白登一次。
- **身份只用 `data.user.id`**：兑换响应里的 `id` 是「这把 Key 的记录 id」，同一账号每兑换一次就变。拿它判重会让「同一账号第二次登录」变成新账号（每登一次多一张卡 + 多签发一把 Key）。
- 窗口是可见的 1024×800、一次性 profile，关掉即回收（含临时目录）。

### API Key 录入

`{ type: "api" }` 方式**刻意不写 `authorize`**：magpie 的 api 方式只收一个字符串，而 `inputs` 只在方法带 `prompts` 时才传（HOOKS 陷阱 2）。所以让宿主原样保存 `{ type:"api", key }`，由 `parseCredential` 解析三种输入：

```
{"access_token":"oma_…","signing_secret":"…"}   完整 JSON（推荐）
oma_…:密钥                                        冒号分隔
oma_…                                             裸 token（缺密钥，请求会 403，loader 给可读错误）
```

解析层**不校验前缀**（`oma_` 不是白名单），只要求 token 形状 `^[A-Za-z0-9_.\-/+=]{16,}$` —— 上游将来换前缀时，写死前缀会把新 Key 直接判成「凭据不完整」。

### 续期

**没有。** `auth.refresh` 恒返回 `undefined`，不发任何网络请求。凭据是长期静态材料，上游没有 refresh 端点；写一个「每 30 分钟刷新一次」只会制造一串注定失败的请求，并在面板上制造「续期失败」的假故障。

## 4. 额度

`GET /api/v1/users/wallet`（Cookie）：

| 字段 | 含义 | 换算 |
|---|---|---|
| `balance` | 积分余额 | **千分之一积分**（网页前端 /1000 显示） |
| `daily_token_balance` | 今日剩余 | 计费 token，不换算 |
| `daily_token_limit` | 今日上限 | 计费 token，不换算 |

`GET /api/v1/users/subscription` → `plan ∈ {basic, pro, ultra}`，只有档位名，**没有到期时间**（上游不下发，插件也不编）。

计费 token 的口径（上游 SPEC）：`(input + cache_read + 10 × output) × 1.5`；额度用完后按 `1 积分 = 5000 计费 token` 转扣积分。这个公式**只用于说明**，插件不自己折算 —— 折算错了会让用户看到无法核对的数字。

映射到 magpie 的两个窗口：

| 窗口 | 类型 | 字段 |
|---|---|---|
| 每日额度 | 数量型 | `amount = limit − remaining`、`limit`、`unit: "计费 token"`、`span: 86400` |
| 积分余额 | 钱包型 | `balance`、`unit: "积分"`（**不给** amount/limit —— 上游没有总额，给分母就是假占比） |

两个细节：

- **每日额度只有上限与剩余都有才画**。缺剩余时把 0 当剩余，会让用户以为今天已经用光。
- **负余额**（真机见过 −8.191）不能直接喂进度条：改成 `balance: 0` + `display: "-8.191 积分（已透支）"`。
- `signIn` 不因 cookie 401 写 `expired`：额度走 cookie、推理走 `oma_`，cookie 失效不影响发消息；标 expired 会把还能用的号判死。

## 5. 签到（PoW）

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

## 6. 模型与窗口

网关没有远端目录（`GET /v1/models` → 405），所以目录只有内置快照（来源：平台侧 `GET /api/v1/users/models` 的快照）。

- 带 `monkeycode-basic/` `pro/` `ultra/` 前缀的走对应档位的**每日额度**；basic 账号请求 pro/ultra 前缀会被 403。
- 不带前缀的直接扣积分。
- 上下文窗口只在**有实测证据**的 DeepSeek 系上声明 `1,048,576`（服务端 400 原文：`maximum context length is 1048576 tokens`）。`glm-5` 未实测，就不声明 —— 这个字段会被 agent 拿去算压缩阈值，谎报比缺一条进度条代价大得多。
- 不声明 `reasoning` 档位：MonkeyCode 没有下发「每个模型支持哪些思考档位」的元数据，编一张表就是假能力。

## 8. 百智云（第三个供应商）

与 MonkeyCode 是**两套账号体系**：独立凭据、按量计费、没有每日额度、没有签到。
它是 MonkeyCode 文档站（`monkeycode.docs.baizhi.cloud`）背后的模型网关，但不是同一个平台。

### 两套凭据，各管一段

| 凭据 | 能干什么 | 不能干什么 |
|---|---|---|
| 控制台 cookie（`baizhi_session` / `sl-session`） | 查积分、查用量、读资料、读 Key 列表 | 不能推理 |
| 推理 Key（`sk-` + 64 位，共 67 字符） | 调模型网关、拉模型目录 | 查不到积分（`x-api-key` 打控制台一律 401） |

⚠ 两个「两套」最容易搞混：

1. 控制台 `baizhi.cloud/api/v1/user/api-keys` 只发 **`bzy_`** 前缀（15 位），拿它打模型网关恒 401 ——
   真正能用的推理 Key 来自**大模型商店**的 console 接口
   `GET https://ai-models.app.baizhi.cloud/api/console/api-keys`（响应字段是 `api_key`，不是 `key`）；
2. 控制台 cookie 只够查余额，**不是**推理凭据。

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

映射到 magpie：四个钱包型窗口（可用 / 每日 / 充值 / 今日消耗）。没有数量型窗口 —— 按量计费没有上限，
硬造一个分母就是假占比。

- 每日积分用官方 `runsOutAt` + `runsOut` 表达「零点过期」（`nextUtc8Midnight()`），不拼进 `display`；
- 今日消耗是 `textOnly` 窗口：只有文字，不参与路由排序（它本来也不是额度）。

## 7. 代码地图

| 文件 | 职责 |
|---|---|
| `index.mjs` | 只装配：导出两个插件工厂 |
| `src/sites.mjs` | 两站差异（域名、cookie 名、模型快照、图标） |
| `src/monkeycode/runtime.mjs` | 九钩子装配与共享逻辑 |
| `src/monkeycode/signing.mjs` | 签名、prompt 提取、凭据解析、错误分类（纯函数） |
| `src/monkeycode/credits.mjs` | 平台接口：换 Key、钱包、订阅、签到、PoW |
| `src/monkeycode/browser-login.mjs` | 受控 Chromium + CDP 轮询 |
| `src/monkeycode-icon.mjs` | 官方图标（data URI） |
| `src/baizhi/site.mjs` | 百智云常量与 15 条兜底模型 |
| `src/baizhi/runtime.mjs` | 百智云九钩子装配（无 checkin） |
| `src/baizhi/credits.mjs` | 钱包 / 用量 / 换 Key / 远端模型目录 |
| `src/platform-http.mjs` | 两家共用的平台请求（cookie、信封、失败翻译） |
| `src/credential.mjs` | 两家共用的凭据解析 |
| `src/session-login.mjs` | 两家共用的浏览器会话登录（CDP） |
| `src/quota.mjs` / `src/usage-cache.mjs` | 脚手架自带的额度构造器与缓存 |

## 8. 测试

```bash
node --test        # 187 条，全部离线（需要网络的地方注入 fetchImpl）
node scripts/check.mjs   # 49 条合规检查
```

`tests/monkeycode.test.mjs` 锁的是语义：签名公式与「改 body 签名跟着变」、prompt 提取顺序、凭据三种输入、cookie 归一、PoW 回归向量与解验证、信封解包、失败分类、额度窗口映射、loader 的请求改写。
