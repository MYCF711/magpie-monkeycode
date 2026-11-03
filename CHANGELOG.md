# 更新记录

> 每个版本一节，**一条一行**，说用户能感知的变化。
> 格式与规矩见 [UPDATING.md](./UPDATING.md)。

## 0.1.0 — 2026-11-03

**首个版本：MonkeyCode 国内站 + 国际站，一个包两个供应商**

- 新增 `monkeycode`（monkeycode-ai.com）与 `monkeycodeintl`（monkeycode-ai.net）两个供应商，各自独立的登录态与账号池
- 登录两条路：浏览器登录（插件开一次性的受控窗口，登录完成后自动把网页会话换成网关凭据）与 API Key 录入（粘贴 `{"access_token":"oma_…","signing_secret":"…"}`，或 `oma_…:密钥`）
- 推理走 Anthropic Messages，按网关要求对每个请求的 prompt 现算 `X-OhMyAgent-Signature`（改 body 后签名跟着重算）
- 模型目录内置 9 条（basic / pro / ultra 三档额度的 deepseek 前缀模型 + 逐次扣积分的 deepseek 与 GLM-5）；网关没有远端目录接口，所以不假装能拉新
- 额度卡片：每日额度（计费 token）与积分余额两条读数，订阅档位（Basic / Pro / Ultra）显示在套餐名上
- 每日签到：自动解开厂商的 PoW 验证题后签到，已在签过的不发写请求；验证题形态变了就如实回报「需要手动签到」
- 没有续期端点：凭据是长期静态材料，插件不会每隔半小时发一次注定失败的刷新请求
