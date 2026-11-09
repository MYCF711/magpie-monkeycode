# MonkeyCode 国内站：每日额度 / 积分 的真实计费口径与目录整改契约

> **这份文档回答一个问题**：`monkeycode-basic/deepseek-flash`（档位条目）与 `deepseek-flash`
> （无前缀条目）在**当日免费额度耗尽之后**分别会怎样 —— 是自动转扣积分，还是 403 / 不可用？
> 并据此给出「模型目录该保留哪条、隐藏哪条、叫什么名字」的契约。
>
> **取证边界**（本文件所有结论都守这条）：只读源码、公开文档、**匿名**公开响应；
> **没有发过任何推理请求**（`max_tokens` 也算），**没有读过任何真实凭证**。
> 唯一用到的账号侧数据是插件自己的目录缓存 `~/.cache/magpie/monkeycode-models-*.json`
> （平台下发的模型清单，不含 cookie / key / 余额）。

- 取证日期：2026-11-09
- 站点：国内站 `https://monkeycode-ai.com`（前端 `edition=saas, region=cn`）
- 结论一句话：**基础 / 专业 / 旗舰三档的「当日免费额度」耗尽后，平台默认自动继续扣积分**（可用开关关掉）；
  无前缀条目本来就是纯积分口径。所以对**同一个底层模型**，档位条目是无前缀条目的能力超集 ——
  无前缀那条应当在目录里被隐藏，只在没有对应档位条目时保留。

---

## 0. 结论速览

| # | 问题 | 结论 | 状态 |
|---|---|---|---|
| Q1 | `basic` 档每日额度耗尽后，是自动转扣积分，还是 403 / 不可用？ | **自动转扣积分**（默认开；可被账号级开关关掉） | **已证实** |
| Q2 | 无前缀条目是否独立按积分计费？ | **是**。它是「付费模型」分组，调一次扣一次积分，与日额度无关 | **已证实** |
| Q3 | Pro / Ultra 是否同规则？ | **是**。官方开关文案点名「基础模型、专业模型、旗舰模型」三档；英文版同样点名 Basic/Pro/Ultra | **已证实** |
| Q4 | 平台返回的 `display_name` / `model` / `id` 能不能区分？ | **只有 `model` 的前缀能区分**。`id` 是每条记录一个 UUID（同一 `apiId` 在国内站/国际站缓存里都不同），无计费含义；`display_name` **不在这个端点上**（要展示名得读 `remark`） | **已证实** |
| Q5 | 关掉开关后额度耗尽的确切 HTTP 状态 / 文案 | 拿不到一手证据（前端不映射状态码，仓库里只有启发式分类） | **未证实** |
| Q6 | `1 积分 = 5000 计费 token`、`(input + cache_read + 10 × output) × 1.5` | 仓库里只有一句「上游 SPEC」，找不到一手出处；本次也没取得 | **未证实** |

**整改建议一句话**：档位条目保留并改名为 `… · 每日额度`；**同一 base 名**的无前缀条目隐藏
（本机实测目录里只有 `deepseek-flash`、`minimax-m2.5` 两条命中）；**没有档位孪生**的无前缀条目保留，
名字继续叫 `… · 积分`。

---

## 1. 一手证据与取证方法（可复现）

### 1.1 官方前端 bundle（匿名可下载，本文的主证据）

```bash
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
curl -s -o /tmp/mc.html -w "%{http_code} %{size_download}\n" -A "$UA" https://monkeycode-ai.com/
# 200 3456   ← SPA 外壳；/、/pricing、/docs、/faq 都回这一份同样的 3456 字节，没有服务端渲染的价格页
curl -s -o /tmp/mc.js   -w "%{http_code} %{size_download}\n" -A "$UA" https://monkeycode-ai.com/assets/index-0rgNk17_.js
# 200 6123247
sha256sum /tmp/mc.js
# 301082a054a20cb21389001b6a3dd9fcb2f66b95b0c2aa29f2d2685e4fff0c1e
```

> bundle 的哈希**每次发版都会变**。要复核时按下面的检索串 grep，不要按 offset。
> 本文引用的所有前端字符串都来自这份 6,123,247 字节的构建（sha256 `301082a0…0c1e`）。

### 1.2 匿名探测：目录/额度端点一律 401（说明必须带 cookie，也说明本次没有越界）

```bash
for p in /api/v1/users/models /api/v1/users/models/available /api/v1/users/subscription /api/v1/users/wallet; do
  printf "%-34s " "$p"; curl -s -o /dev/null -w "%{http_code}\n" -A "$UA" "https://monkeycode-ai.com$p"
done
# /api/v1/users/models               401
# /api/v1/users/models/available     401
# /api/v1/users/subscription         401
# /api/v1/users/wallet               401

curl -s -A "$UA" https://monkeycode-ai.com/api/v1/public/stats      # {"code":0,"message":"success","data":{"repo_stars":5114}}
curl -s -A "$UA" https://monkeycode-ai.com/api/v1/server/config     # {"code":0,"message":"success","data":{"edition":"saas","region":"cn","captcha_enabled":true}}
```

### 1.3 官方文档站（README 指向的 `work.docs.baizhi.cloud`）

- `https://work.docs.baizhi.cloud/node/01a15361-2b73-7c79-8e64-a533a648648e`「账号、权限与积分问题」：
  「积分不足怎么办？**进入「设置 - 积分」查看当前余额和额度。积分不足时，任务可能无法发起或执行失败。**」
- `https://work.docs.baizhi.cloud/node/01a1535f-91b0-7585-beb0-c56f268c7997`「积分、额度与使用统计」：
  这一页讲的是**管理后台的计费设置**（自建/团队口径：按天/周/月配额度、按成员分组重置），
  不是 SaaS 个人套餐的规则 —— 引用时别把它当成个人套餐说明。

---

## 2. 已证实的九条（每条都带一手出处）

### A1 · 存在一个账号级开关：「额度耗尽后消耗积分」，**默认是开的**

前端 i18n 原文（bundle 内检索串 `creditConsumptionDescription`）：

```
creditConsumptionTitle:       "额度耗尽后消耗积分"
creditConsumptionDescription: "开启后，基础模型、专业模型、旗舰模型的当日免费额度用完时，将继续消耗积分使用对应模型。"
creditConsumptionTitle:       "Use credits after free quota runs out"
creditConsumptionDescription: "When enabled, credits will be used to continue using Basic, Pro, and Ultra models after the daily free quota is exhausted."
```

开关的渲染条件（检索串 `enable_credit_consumption!==!1`）：

```js
l.jsx(_s,{checked: he?.enable_credit_consumption!==!1, onCheckedChange: fe=>{$t(fe)}, disabled:M})
```

`checked = enable_credit_consumption !== false` ⇒ **字段缺省 / undefined 时按「开」渲染**。

> ⚠ 精度说明：这是**前端渲染**层面的默认值。服务端在报文里不带该字段时的实际行为
> 无法在不登录的前提下读到（见 U5）。文案与控件一致指向「默认开」。

> 顺带一个事实：本仓库**完全不知道这个开关存在** —— `src/` 里没有任何地方读
> `enable_credit_consumption`（`grep -rn enable_credit_consumption src/` 无命中），
> `catalog.mjs:5-10` 记的 models 端点字段样本里也没有它。所以卡片上的「每日额度」
> 从来不会告诉用户「耗尽后会自动烧积分」。

### A2 · 开关覆盖三档：基础模型、专业模型、旗舰模型

A1 的中英文原文各自点名了三档，不是只对 basic。
官方对三档的称呼是 **基础模型 / 专业模型 / 旗舰模型**（bundle 检索串 `model:{basic:"基础模型"`），
徽标分别是「免费使用 / 专业会员可免费使用 / 旗舰会员可免费使用 / **消耗积分使用**」。

### A3 · 开关的写接口

bundle 里的 SDK 定义（检索串 `v1UsersSubscriptionCreditConsumptionUpdate`）：

```js
v1UsersSubscriptionCreditConsumptionUpdate:(t,r={})=>this.request({
  path:"/api/v1/users/subscription/credit-consumption", method:"PUT",
  body:t, secure:!0, type:"application/json", format:"json", ...r })
```

调用点：`Ie("v1UsersSubscriptionCreditConsumptionUpdate",{enable_credit_consumption:fe},…)`。
⇒ `PUT /api/v1/users/subscription/credit-consumption`，body `{ enable_credit_consumption: boolean }`。

### A4 · 订阅对象本身携带 `enable_credit_consumption`

控件读的是 `he?.enable_credit_consumption`（`he` = 这一层的订阅对象）。
该字段在整个 bundle 里只出现 **2 次**：一次是 PUT body（A3），一次就是这个读取处 ——
没有任何别的 GET 会下发它，而 SDK 里唯一的订阅读接口是 `v1UsersSubscriptionList`
（`GET /api/v1/users/subscription`）⇒ 它只能来自 `GET /api/v1/users/subscription` 的 `data`。

**这就是判据来源**：想告诉用户「你现在额度耗尽会转积分」，读这个字段，不用自己猜。

> 精度说明：校验这一层的组件与取订阅的那段代码**不在同一个 chunk**（bundle 合并后相距 45 万字节），
> 所以「`he` 就是那次的 `data`」是**强推断**，不是逐行闭合。字段归属本身已由「PUT 到
> `/subscription/credit-consumption`、GET 只有 `/subscription`」两条闭合。

### A5 · 三档日额度：10M / 100M / 300M 计费 token

```
featureValues:{ … dailyQuotaBasic:"每天 10M Token", dailyQuotaPro:"每天 100M Token", dailyQuotaUltra:"每天 300M Token" … }
features:{ … dailyQuotaBasic:"每日额度：每天 10M Token", dailyQuotaPro:"每日额度：每天 100M Token", dailyQuotaUltra:"每日额度：每天 300M Token" … }
```

与本地常量 **完全一致**：`src/monkeycode/credits.mjs:33`
`PLAN_DAILY_LIMIT = { basic: 10_000_000, pro: 100_000_000, ultra: 300_000_000 }`。
（`resolveTier()` 正是用这个等式反推档位，见 `credits.mjs:179-188` —— 这条交叉验证成立。）

### A6 · 档位与权限**只由 `model` 字符串前缀决定**（平台前端自己就是这么判的）

```js
function ja(e){ const t=e?.trim().toLowerCase(); if(t){ if(t.startsWith("monkeycode-basic")) return "monkeycode-basic";
  if(t.startsWith("monkeycode-pro")) return "monkeycode-pro"; if(t.startsWith("monkeycode-ultra")) return "monkeycode-ultra" } }

function Im(e,t){ if(!e) return !1; const r=ja(e.model);
  return r==="monkeycode-pro"   ? (t?.plan==="pro"||t?.plan==="flagship"||t?.plan==="ultra")
       : r==="monkeycode-ultra" ? (t?.plan==="flagship"||t?.plan==="ultra")
       : !0 }   // ← 无前缀、以及 monkeycode-basic/ 前缀，都恒为 true
```

⇒ **无前缀 = 任何账号都能选**（与套餐无关，因为它走积分）；`monkeycode-pro/` 要 pro 及以上；
`monkeycode-ultra/` 要旗舰及以上。这与 `src/monkeycode/catalog.mjs:327-336` 的 `filterByTier()`
**规则一致**（本地实现更宽一档：档位未知不过滤、过滤后为空原样返回，这两条是稳妥的差异）。

### A7 · 官方 UI 把模型分成七类，计费方式靠分组表达

```
taskDetail.page.models = { basic:"基础模型", basicBadge:"免费使用",
  pro:"专业模型", proBadge:"专业会员可免费使用",
  ultra:"旗舰模型", ultraBadge:"旗舰会员可免费使用",
  team:"团队模型", paid:"付费模型", paidBadge:"消耗积分使用",
  private:"我的模型", recommended:"推荐" }
```

套餐页 tooltip（检索串 `monthlyCredits`）：

```
"积分可用于 AI 调用图片识别、文档解析、联网搜索等工具时支付调用费用；也可以调用更多模型；
 当每日 Token 额度不足时，还可以消耗积分继续使用。"
"…They can also unlock more models and continue usage when the daily token quota is exhausted."
"gpt、deepseek、glm、qwen、minimax、kimi、mimo 等大模型，调用时消耗积分"
```

⇒ **无前缀（付费模型）与档位模型是两条计价路径；而档位模型在额度耗尽后会汇入积分路径。**

### A8 · 各档赠送积分：basic 不送，pro 每月 1 万，ultra 每月 10 万

```
values:{ basic:{label:"不赠送积分", status:"unsupported"}, pro:{label:"每月赠送 1 万积分"}, ultra:{label:"每月赠送 10 万积分"} }
```

⇒ **basic 账号的积分余额只能来自签到（100/天）、邀请（5000/人）、兑换码、充值**。
这意味着「basic + 零积分」的账号在日额度耗尽后，自动转积分**也会失败** ——
两边都是死路，此时无前缀条目同样调不通（与 `CHANGELOG.md:171` 的实测吻合：
积分耗尽后无前缀模型全部 403/402，只剩档位条目可用）。

### A9 · 官方前端**选默认模型**时也是优先选「自己档位的那条」

```js
function ry(e,t){
  const r = t?.plan==="pro" ? "monkeycode-pro" : (t?.plan==="flagship"||t?.plan==="ultra") ? "monkeycode-ultra" : "monkeycode-basic";
  const n = e.filter(s=>s.id && ja(s.model)===r && Im(s,t)) …[0];
  if(n?.id) return n.id;
  const i = e.filter(s=>s.id && s.owner?.type===Nn.OwnerTypePublic && Im(s,t)) …[0];   // 退回公共模型
  if(i?.id) return i.id;
  …
}
```

⇒ 平台自己把「同名的档位条目」当成同一模型的**首选入口**，无前缀那条只是兜底。
这条是「隐藏无前缀孪生」最直接的产品级依据。

---

## 3. 未证实的三条（**不得**写进用户可见文案）

### U1 · 关掉开关后，额度耗尽的确切表现

前端 bundle 里没有任何 402 / 「积分已耗尽」的状态码映射（grep `402` 命中的全是 SVG 路径数字），
所以拿不到一手证据。仓库里只有**启发式**：

- `src/monkeycode/signing.mjs:137-160` `classifyFailure()`：`402 → quota`；正文含「积分已耗尽」/
  「额度已耗尽」/「insufficient」/「quota」→ `quota`；401/403 → `auth`。
- `tests/monkeycode.test.mjs:131` 断言 `classifyFailure("积分已耗尽，调用失败", 500) === "quota"`
  —— 这条文案**没有留下抓包出处**（注释只写「状态码被改写成 500 但正文仍是额度文案」），
  属于「曾经见过」而不是「可复现证据」。

⇒ 结论：`quota` 分类可以继续用（它是保守的、宁可换号的一侧），但**不要在 UI 上承诺**
「关掉开关后会返回 402 / 会提示积分不足」。

### U2 · 计费换算口径

`docs/internals.md:224` 写：「计费 token 的口径（**上游 SPEC**）：`(input + cache_read + 10 × output) × 1.5`；
额度用完后按 `1 积分 = 5000 计费 token` 转扣积分。」仓库里没有这个 SPEC 的出处，
bundle 里也没有（`5000` 只命中邀请奖励 5000 积分）。本次未取得一手来源。

⇒ 结论：**未证实**。插件不自己折算是对的（`docs/internals.md:224` 自己也写了「只用于说明」），
也不要把它写进 README / 卡片文案。

### U3 · `remark` 原文（也就是「DeepSeek-V4.1-Flash-1017」这个名字本身）

官方前端取展示名的函数（检索串 `function Xm(`）：

```js
function jR(e){ return e?.trim().replace(/^monkeycode-[^/]+\//,"") || "" }        // 剥掉档位前缀
function Xm(e){ const t=e?.remark?.trim(); return t ? jR(t) : Xc(e?.model) }       // remark 优先，否则档位中文名
```

⇒ 平台的模型对象**有 `remark` 字段**（人读的名字），并且**它自己可能带档位前缀**（所以前端要 `jR()` 剥）。
但 `GET /api/v1/users/models` 匿名 401，本次**没有登录**，因此拿不到 `remark` 原文。

关于「DeepSeek-V4.1-Flash-1017」这个名字：`CHANGELOG.md` 0.2.17 记过一次**指纹实测** ——
`deepseek-v4.1-flash-1017`、`baizhi/deepseek-flash`、`baizhi/deepseek-v4-flash`、`monkeycode/deepseek-flash`
对同一组 5 个知识锚点回答**逐字相同**，对照组 `glm-5.3-flash` 明显不同 ⇒ 这几条是**同一个底层模型**。

⇒ 所以任务里说的「同名 DeepSeek-V4.1-Flash-1017(basic) 与无前缀版本」，落到平台标识上就是：

| 人读名字（推测来源） | 平台 `model` 原值 | 本插件 magpie id | 计费路径 |
|---|---|---|---|
| DeepSeek-V4.1-Flash-1017 · 基础模型 | `monkeycode-basic/deepseek-flash` | `monkeycode-basic-deepseek-flash` | 日额度 →（耗尽）→ 积分 |
| DeepSeek-V4.1-Flash-1017 · 付费模型 | `deepseek-flash` | `deepseek-flash` | 直接积分 |

（`(basic)` 后缀是渲染层加的档位标记，不是平台字段的一部分。）
**未证实**的部分只有「`remark` 原文就是这串」，其余（同一底层模型、两条不同的 `model` 原值）已证实。

### U4·U5 · 另两条精度说明

- **U4** `monkeycode-basic/deepseek-flash` 与 `deepseek-flash` 是否真的是同一份权重：
  只有「base 名相同」+ 平台自己把档位条目当同一模型的首选入口（A9）两条**强推断**；
  0.2.17 的指纹只测了 `monkeycode/deepseek-flash`（无前缀那条）。连带影响见 §4 的 R1 备注。
- **U5** 服务端在订阅报文缺字段时的真实默认值，以及「三档是否各自独立记账」：
  `/api/v1/users/wallet` 只下发**一对** `daily_token_balance` / `daily_token_limit`
  （`src/monkeycode/credits.mjs:140-147`），也就是账号只有一个日额度读数；
  「三档各自一块额度」没有证据。⇒ **不要**在文案里说「三个额度池」。

---

## 4. 目录整改契约

### 4.0 现有实现的核查结论

| 现有写法 | 判定 | 说明 |
|---|---|---|
| 按账号档位收窄的 `filterByTier()`（`catalog.mjs:313-336`） | **正确**，与官方 `Im()` 同规则 | 但注释里的「不同的额度池」措辞要改：三档的差别是**模型范围**，额度是账号一个池（U5） |
| 无前缀 → `· 积分`（`catalog.mjs:96-99`） | **正确** | 与官方「付费模型 / 消耗积分使用」一致 |
| 档位 → `· 基础档 / 专业档 / 旗舰档`（`catalog.mjs:63-68`） | **语义对、说法不对** | 官方叫「基础模型 / 专业模型 / 旗舰模型」，并且真正该强调的是**每日额度** |
| `apiId` 用平台 `model` 原值（`catalog.mjs:137-141`） | **正确** | UUID / slug / 裸名都会被 403（`CHANGELOG.md` 0.2.15） |
| `free: raw.is_free === true`（`catalog.mjs:149`） | **未证实的字段** | 官方前端**从不读 `is_free`**（bundle 里 0 次）；语义没有一手出处。当前实测目录 13 条全是 `false`，暂无实际影响；但一旦上游改成 `true`，magpie 的 Free-first 会把它排到前面，用户就在「以为免费」地烧积分。建议改成**不据未证实字段置 `free`**，或只在有计费端点证据时置 |
| `fetchPlan()` 只认 `basic/pro/ultra`（`credits.mjs:151-164`） | **保守但会漏** | 官方前端同时认 `flagship` 作为旗舰档的别名。若 SaaS 某天回 `flagship`，`resolveTier()` 走「档位未知 → 不过滤」这条安全兜底（会多列 pro/ultra 条目，不会误杀），可接受；但可考虑加别名 |
| 兜底快照写死无前缀模型（`sites.mjs:47-52`） | **取舍正确** | 兜底口径就是「谁都能走」的积分路径；只是显示名用了「（按积分计费）」而缓存路径用「· 积分」，建议统一 |

### 4.1 规则 R1（按 base 名去重，隐藏无前缀孪生）

**定义**：`baseOf(apiId)` = 去掉 `^monkeycode-(basic|pro|ultra)/` 前缀后的剩余串。

**判定**：把同一账号目录里的条目按 `baseOf()` 分组；组内若**同时**存在档位条目与无前缀条目 ⇒
隐藏**无前缀**那条，保留档位那条。组内有多条档位条目时（档位未知 / 未过滤的场景），
保留**档位顺序最高**的那条（ultra > pro > basic），顺序见 `catalog.mjs:313` 的 `TIER_ORDER`。

**依据**：
1. 无前缀条目恒可被任何账号选中（A6），档位条目在 basic 前缀下同样恒可选中（A6）⇒ 隐藏不会少入口；
2. 档位条目在日额度耗尽后**默认自动转积分**（A1/A2/A7）⇒ 它是无前缀条目的**能力超集**；
3. 平台自己的默认选择就是「先档位、后公共」（A9）；
4. 反向情形不成问题：积分耗尽时档位条目仍能吃日额度（`CHANGELOG.md:171` 实测），
   而无前缀条目此时直接 403/402 ⇒ 留无前缀反而多一个「看着能点、点了报错」的选项。

**R1 的两个前提要写进实现**（做不到就别启用去重）：

- 必须在**拿到账号目录之后**做（`filterByTier` 之后），不能在兜底快照上做；
- 组内**没有**任何档位条目时**不隐藏**（那是这条模型唯一的入口，见 R2）。

**风险登记（U4）**：若 basic 池与无前缀池其实是不同权重，「隐藏」等于让用户拿不到无前缀那条。
现有证据指向同一模型（A9 + 0.2.17 指纹 + base 名相同），但**没有 direct 证据**。
⇒ 建议**留一个逃生阀**：环境变量（例如 `MAGPIE_MONKEYCODE_SHOW_CREDIT_TWINS=1`）可让去重失效，
并在文档里写明「怀疑 basic 池不是同一权重时用它」。

### 4.2 规则 R2（不成对的无前缀条目：保留）

无前缀条目没有同 base 的档位条目 ⇒ 它是**唯一入口**，必须保留。
本机记录的国内站 basic 账号目录里，这类共有 6 条（见 4.4 表）。

### 4.3 规则 R3（档位未知：不要在收窄里夹带去重）

`tier === undefined`（`GET /api/v1/users/subscription` 与钱包限额都读不出来）时：
**不做 R1**。理由是「哪条是『本档位』」无从判断，误删会让用户少一条真能用的模型。
这与现有 `filterByTier()` 的「未知不过滤」原则一致。

### 4.4 建议保留 / 隐藏清单（基于本机记录的真实目录）

来源：`~/.cache/magpie/monkeycode-models-monkeycode.json`（国内站，`tier: "basic"`，13 条，
2026-11-09 记录）。**这里不抄 UUID** —— 每条记录的 `id` 是 UUID，同一个 `apiId` 在国内站与
国际站两份缓存里的 UUID 都不一样（本文不抄录），它只标识「哪个账号下的哪条记录」，没有任何计费含义。

| 平台 `model` 原值 | 建议 | 建议显示名 | 理由 |
|---|---|---|---|
| `monkeycode-basic/glm-5.3-flash` | **保留** | `GLM-5.3-Flash · 每日额度` | 无积分孪生（R2 反向） |
| `monkeycode-basic/qwen3.5-plus` | **保留** | `Qwen3.5-Plus · 每日额度` | 孪生是 `qwen3.6-plus`（不同版本，不是同 base） |
| `monkeycode-basic/deepseek-flash` | **保留** | `DeepSeek-Flash · 每日额度` | 与下一行成对，按 R1 保留档位这条 |
| `deepseek-flash` | **隐藏** | （原 `DeepSeek-Flash · 积分`） | R1：与 `monkeycode-basic/deepseek-flash` 同 base |
| `monkeycode-basic/minimax-m2.5` | **保留** | `MiniMax-M2.5 · 每日额度` | 与下一行成对 |
| `minimax-m2.5` | **隐藏** | （原 `MiniMax-M2.5 · 积分`） | R1：与 `monkeycode-basic/minimax-m2.5` 同 base |
| `monkeycode-basic/kimi-k2.5` | **保留** | `Kimi-K2.5 · 每日额度` | 孪生是 `kimi-k2.6`（不同版本） |
| `qwen3.6-plus` | **保留** | `Qwen3.6-Plus · 积分` | 无档位孪生 |
| `qwen3.7-max` | **保留** | `Qwen3.7-Max · 积分` | 无档位孪生 |
| `minimax-m3` | **保留** | `MiniMax-M3 · 积分` | 无档位孪生 |
| `glm-5` | **保留** | `GLM-5 · 积分` | 无档位孪生 |
| `glm-5.1` | **保留** | `GLM-5.1 · 积分` | 无档位孪生 |
| `kimi-k2.6` | **保留** | `Kimi-K2.6 · 积分` | 无档位孪生 |

⇒ 这份目录里 **只隐藏 2 条**（`deepseek-flash`、`minimax-m2.5`），13 → 11 条。

国际站那份缓存（`monkeycode-models-monkeycodeintl.json`，2 条：`monkeycode-basic/qwen3.5-plus`、
`monkeycode-basic/deepseek-flash`）**一条都不用隐藏**（没有无前缀孪生）—— 国际版继续独立，
本次改动不得跨站生效。

### 4.5 显示名契约

1. **档位条目**：`<品牌>-<版本> · 每日额度`（把 `基础档/专业档/旗舰档` 换掉：
   用户要判断的是「这条吃不吃日额度」，档位名由账号自己决定，写进名字反而每次都要解释）。
   若想保留档位信息，可写 `· 每日额度（基础）`，但**必须**先出现「每日额度」。
2. **无前缀条目**：`<品牌>-<版本> · 积分`（现状正确，不动）。
3. **转积分的提示不要塞进模型名**：它是**账号级状态**，读
   `GET /api/v1/users/subscription` 的 `enable_credit_consumption`（A4），
   写进 `auth.usage` 的一个**窗口级**文案（例如 `额度耗尽后自动用积分（已开启）` /
   `额度耗尽后停止（已关闭）`）—— 一个状态写一次，而不是给 20 个模型名各加一句。
   ⚠ 具体挂 `display` 还是单开一个 text-only 窗口，先按 [HOOKS 三](../HOOKS.md) 的窗口规矩核一遍
   （数量型窗口的 `display` 在宿主侧的呈现与本仓库 `usageWindow()` 的约束）再定，别直接塞。
4. **不许**自己拼「1 积分 = 5000 token」（U2），也不许在额度窗口里换算成积分。

### 4.6 兜底快照（`sites.mjs` 的 `MODELS`）

维持「只写无前缀」不变（谁都能调，是唯一不会因档位而 403 的口径），但把显示名
`DeepSeek Flash（按积分计费）` 统一成 `DeepSeek-Flash · 积分` 的形状，
避免与缓存路径出现两套措辞。

---

## 5. 验收 / 回归判据（可当场跑）

```bash
# ① 现有语义不被破坏（本文不改 src，只做基线；改成 R1 之后这条必须仍全绿）
node --test tests/catalog.test.mjs
# ℹ tests 10   ℹ pass 10   ℹ fail 0

# ② 合规扫描：不得引入真凭证 / 真手机号 / 本机绝对路径
node scripts/privacy-scan.mjs   # 退出码 0 = 干净

# ③ 平台口径复核（匿名，零额度消耗）
ASSET=$(curl -s -A "$UA" https://monkeycode-ai.com/ | grep -o '/assets/index-[A-Za-z0-9_-]*\.js' | head -1)
curl -s -A "$UA" "https://monkeycode-ai.com$ASSET" | grep -c "额度耗尽后消耗积分"   # ≥ 1
curl -s -A "$UA" https://monkeycode-ai.com/ | head -c 200                          # SPA 外壳
```

实施 R1 后，单测至少要有这四条（用假目录，不碰网络）：

1. `[basic/deepseek-flash, deepseek-flash, glm-5]` + `tier=basic` → 剩 `[basic/deepseek-flash, glm-5]`；
2. 同一组但 `tier=undefined` → **三条都在**（R3）；
3. 只有 `deepseek-flash`（没有档位孪生）→ **保留**（R2）；
4. `MAGPIE_MONKEYCODE_SHOW_CREDIT_TWINS=1` → 去重失效，三条都在（逃生阀）。

---

## 6. 附：本文引用的一手片段索引

| 检索串（`grep -o` 用） | 用途 | 对应结论 |
|---|---|---|
| `creditConsumptionDescription:"开启后` | 中文开关文案 | A1/A2 |
| `creditConsumptionDescription:"When enabled` | 英文开关文案（点名 Basic/Pro/Ultra） | A2 |
| `enable_credit_consumption!==!1` | 默认开的渲染条件 | A1 |
| `v1UsersSubscriptionCreditConsumptionUpdate` | `PUT /api/v1/users/subscription/credit-consumption` | A3 |
| `enable_credit_consumption:fe` | 写请求 body 形状 | A3 |
| `dailyQuotaBasic:"每日额度` | 10M/100M/300M | A5 |
| `function ja(e)` / `function Im(e,t)` | 前缀判档、无前缀恒可选中 | A6 |
| `taskDetail:{page:{models:{basic:` | 七类分组 + 徽标 | A7 |
| `monthlyCredits:{label:"每月赠送积分"` | 积分可「在额度不足时继续使用」 | A7 |
| `values:{basic:{label:r("subscriptionPlan.featureValues.noCredits")` | basic 不送积分 | A8 |
| `function ry(e,t)` | 平台默认选「本档位条目」 | A9 |
| `function Xm(e)` / `function jR(e)` | `remark` 才是展示名，且自带前缀 | U3 |
| `daily_token_balance` | 钱包只给一对日额度读数 | U5 |

本地代码对照（行号为 2026-11-09 的 HEAD `3ae1a4c`）：

| 文件:行 | 内容 |
|---|---|
| `src/monkeycode/catalog.mjs:5-10` | `/api/v1/users/models` 的实测字段样本（无 `display_name` / 无 `remark`） |
| `src/monkeycode/catalog.mjs:63-68` | `TIERS` 文案（基础档/专业档/旗舰档） |
| `src/monkeycode/catalog.mjs:96-99` | 无前缀 = 扣积分（已与 A7 对齐） |
| `src/monkeycode/catalog.mjs:103-108` | `slugOf()`：magpie id 压平斜杠 |
| `src/monkeycode/catalog.mjs:137-141` | `apiId` 必须是平台 `model` 原值 |
| `src/monkeycode/catalog.mjs:149` | `free: raw.is_free === true`（未证实字段） |
| `src/monkeycode/catalog.mjs:184-193` | 过滤 `is_hidden`、按 `id` 去重 |
| `src/monkeycode/catalog.mjs:313-336` | `TIER_ORDER` / `filterByTier()` |
| `src/monkeycode/credits.mjs:33` | `PLAN_DAILY_LIMIT`（与 A5 一致） |
| `src/monkeycode/credits.mjs:124-148` | `fetchWallet()`：一对日额度字段 |
| `src/monkeycode/credits.mjs:151-188` | `fetchPlan()` / `resolveTier()` |
| `src/monkeycode/runtime.mjs:195-219` | `usage()` 的两个窗口（每日额度 / 积分余额） |
| `src/monkeycode/signing.mjs:137-160` | `classifyFailure()` 的 `quota` 启发式 |
| `src/sites.mjs:15-25` `:47-52` | 命名规律说明 + 兜底快照 |
| `docs/internals.md:224` | 「1 积分 = 5000 计费 token」（未证实） |
| `CHANGELOG.md:171` | 积分耗尽 → 无前缀模型 403/402（反向实测） |
| `CHANGELOG.md` 0.2.17 节 | 四条 id 指纹逐字相同 ⇒ 同一底层模型 v4.1-flash |
