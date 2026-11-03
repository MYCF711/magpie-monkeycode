# 更新记录

> 每个版本一节，**一条一行**，说用户能感知的变化。
> 格式与规矩见 [UPDATING.md](./UPDATING.md)。

## 0.2.2 — 2026-11-03

**百智云登录页换成真的那个；MonkeyCode 可以用百智云账号直接开通**

- 修百智云登录窗 404：`/console/login` 这个路由根本不存在，改开 `baizhi.cloud/console/`（上游用的就是它）
- 百智云登录改成要**两枚** cookie：`sl-session`（设备/风控）+ `baizhi_session`（登录），且必须精确落在 `baizhi.cloud` 域 —— 同名 `sl-session` 还有两枚属于 ai-models / agent-toolkit 子域，按后缀匹配会随机拿错
- 新增 MonkeyCode 登录方式「**用百智云账号开通**」：窗口里登录你的百智云账号（或换号再点一次），插件在后台无头完成 `monkeycode → baizhi.cloud/oauth/authorize → callback` 的 SSO 并换出网关凭据；首次登录时由 MonkeyCode 侧自动建号
- 新增登录方式「**从已登录的百智云账号批量开通**」：直接读 magpie 里已经登录的百智云账号，每次点一下自动挑下一个还没开通过的号做 SSO，已导入的记在本地不会重复

## 0.2.1 — 2026-11-03

**修三个装完就撞上的问题**

- 修「已登录，但 magpie 无法列出它」：模型 id 里的 `/` 被 magpie 读成「provider/模型」分隔符，`monkeycode-basic/deepseek-flash` 之类会凭空长出三个不存在的供应商。现在 magpie 侧用压平的 id，上游真实 id 交给 `apiId`
- 修登录窗口开错页面：MonkeyCode 直接开 `/login`（默认入口有「百智云登录」）；百智云改开控制台登录页 —— 之前开的是大模型商店，没登录态时它只会渲染一片「登录状态已失效」，用户以为账号坏了
- 修国际站登录超时：换凭据请求的超时从 10 秒提到 30 秒（国际站实测单次 11 秒以上），且登录窗口里遇到网络超时**继续等**而不是直接判失败

## 0.2.0 — 2026-11-03

**新增第三个供应商：百智云（BaiZhiCloud）**

- 新增 `baizhi` 供应商：`https://ai-models.app.baizhi.cloud/api/anthropic/v1`，与 MonkeyCode 两站并列，账号体系完全独立（按量计费、没有每日额度、没有签到）
- 登录两条路：浏览器登录（在控制台登录后自动取出账号下的 `sk-` Key）与 API Key（`sk-…` 直接粘，也接受带 session cookie 的 JSON）
- 模型目录走远端（`GET /api/anthropic/v1/models`）：登录后跟随平台上下架；拉不到时退回 15 条内置表，不返回空列表
- 额度卡片：可用积分、每日积分（零点过期，用官方 `runsOutAt` 字段表达）、充值积分、今日消耗
- 模型能力保守声明：只有 4 条 DeepSeek 声明 1,048,576 上下文，图片只给明确支持看图的模型
- 通用件抽到 `src/platform-http.mjs`、`src/credential.mjs`、`src/session-login.mjs`，MonkeyCode 与百智云共用，行为不变

## 0.1.0 — 2026-11-03

**首个版本：MonkeyCode 国内站 + 国际站，一个包两个供应商**

- 新增 `monkeycode`（monkeycode-ai.com）与 `monkeycodeintl`（monkeycode-ai.net）两个供应商，各自独立的登录态与账号池
- 登录两条路：浏览器登录（插件开一次性的受控窗口，登录完成后自动把网页会话换成网关凭据）与 API Key 录入（粘贴 `{"access_token":"oma_…","signing_secret":"…"}`，或 `oma_…:密钥`）
- 推理走 Anthropic Messages，按网关要求对每个请求的 prompt 现算 `X-OhMyAgent-Signature`（改 body 后签名跟着重算）
- 模型目录内置 9 条（basic / pro / ultra 三档额度的 deepseek 前缀模型 + 逐次扣积分的 deepseek 与 GLM-5）；网关没有远端目录接口，所以不假装能拉新
- 额度卡片：每日额度（计费 token）与积分余额两条读数，订阅档位（Basic / Pro / Ultra）显示在套餐名上
- 每日签到：自动解开厂商的 PoW 验证题后签到，已在签过的不发写请求；验证题形态变了就如实回报「需要手动签到」
- 没有续期端点：凭据是长期静态材料，插件不会每隔半小时发一次注定失败的刷新请求
