# MonkeyCode 与百智云 for magpie

**一个包签入三家渠道，24 个模型直接进 magpie —— 浏览器登录一次，DeepSeek、GLM、Kimi、Qwen 就能被任何 agent 用。**

MonkeyCode（长亭科技）是面向工程团队的开源 AI 编程平台，托管版每天有免费额度，也能私有化部署；
百智云是 MonkeyCode 文档站背后的模型网关，按量计费、账号独立。这个插件把三家用你自己的账号接进来。

```
3 个供应商   国内站 monkeycode / 国际站 monkeycodeintl / 百智云 baizhi
24 个模型    9 条 MonkeyCode 额度模型 + 15 条百智云模型
2 条登录路   浏览器登录（自动换凭据）、API Key 录入
0 次手工抄   Cookie 是 HttpOnly 的，插件自己从浏览器读
```

---

## 功能

- **三家三张卡** —— 国内站与国际站账号池不互通（国内 cookie 打国际站回 401），百智云更是另一套账号体系，所以不能合成一张卡。
- **浏览器登录一次就够** —— 插件开一个一次性的受控浏览器窗口，你在里面登完，它自动读会话、换网关凭据、再读你的昵称或积分。
- **API Key 也能录** —— MonkeyCode 粘 `{"access_token":"oma_…","signing_secret":"…"}`（或 `oma_…:密钥`），百智云粘 `sk-…`。
- **网关签名现算** —— MonkeyCode 每个请求按最终 body 里的 prompt 重算 `X-OhMyAgent-Signature`；改了 payload 签名跟着变，不会出现只有一句 `invalid ohmyagent request` 的 403。
- **额度看得到** —— MonkeyCode 显示每日额度与积分余额，百智云显示可用 / 每日 / 充值积分与今日消耗。
- **模型目录跟得上** —— 百智云走远端目录，平台上下架会跟着变；MonkeyCode 网关没有目录接口，用内置快照。
- **每日签到自动做** —— MonkeyCode 的 PoW 验证题本地解完再领，今天签过就不发写请求。百智云没有签到，插件也不会假装有。
- **不假装能刷新** —— 两家的凭据都是长期静态材料，上游没有续期端点，插件也不会定时发注定失败的请求。

---

## 模型

**DeepSeek / 智谱 GLM / Kimi / MiniMax / Qwen** —— 各家在平台上架的都在；百智云跟随远端目录，MonkeyCode 用内置快照。

| 供应商 | 代表模型 | 上下文 | 计费方式 |
|---|---|---|---|
| MonkeyCode | `monkeycode-pro/deepseek-v4-pro` | 1,048,576 | 每日额度（pro 档） |
| MonkeyCode | `monkeycode-basic/deepseek-flash` | 1,048,576 | 每日额度（basic 档） |
| MonkeyCode | `deepseek-v4-flash` | 1,048,576 | 直接扣积分 |
| MonkeyCode | `glm-5` | 未声明 | 直接扣积分 |
| 百智云 | `deepseek-v4-pro` | 1,048,576 | 按量计费（积分） |
| 百智云 | `glm-5.1` / `kimi-k2.6` / `minimax-m2.7` | 未声明 | 按量计费（积分） |
| 百智云 | `qwen3.6-plus` / `qwen-flash` | 未声明 | 按量计费（积分） |

- MonkeyCode：带 `monkeycode-basic/` `monkeycode-pro/` `monkeycode-ultra/` 前缀的走对应档位的每日额度；不带前缀的直接扣积分。
- 上下文窗口只在**有实测证据**的模型上声明（服务端 400 原文写明 1,048,576）；其余不写 —— 宁可没有进度条，也不谎报一个会让 agent 推迟压缩的窗口。
- 图片输入只给明确支持看图的模型（百智云：`deepseek-v4-flash-vision-exp`、`glm-5.1`、`kimi-k2.6`、`minimax-m2.7`、`qwen3.5-plus`）。

---

## 签到

只有 MonkeyCode 有：每天一次、按账号。先查今天签没签（签过就直接回「今天已签」，不发写请求），
没签就取一道 PoW 验证题、本地解完、提交、再领。验证题形态变了（题面不认识 / 参数越界 / 解不完）时
如实回报「需要手动签到」，不会无限重试。百智云没有签到接口，插件不提供这个能力。

---

## 安装

在 magpie 的 **插件 → 发现** 搜 `MonkeyCode`，点**安装**；或在 **插件 → 安装** 里填仓库地址。

装完到 **Providers** 页面点要用的那张卡的「连接」：

- 选 **浏览器登录**：弹出窗口 → 登录 → 关掉窗口，卡片会自动变成你的昵称。
- 或选 **API Key**：MonkeyCode 到平台「OhMyAgent」页面生成 Key（`oma_…` 与签名密钥一起粘）；百智云到 `ai-models.app.baizhi.cloud/console/keys` 取一把 `sk-…`。

> MonkeyCode 的 API Key 与签名密钥是两个值，缺签名密钥每个请求都会被 403 —— 粘贴完整 JSON 最稳。

### 命令行

```bash
# 从仓库源码
magpie plugin add github:MYCF711/magpie-monkeycode

# 本地目录（自己改了代码）
magpie plugin add /path/to/magpie-monkeycode
```

---

## 常见问题

**为什么登录后卡片显示「剩余额度未知」？**
额度接口只认网页登录态（HttpOnly cookie），不认 API Key。用 API Key 登录的账号能发消息，但查不到额度/积分；点卡片上的「改 Key」补填 session cookie，或改用浏览器登录。

**为什么三个渠道不能合一张卡？**
MonkeyCode 国内站与国际站是同一程序的两套部署，账号池不互通；百智云是另一家公司、另一套账号。合成一张卡会让其中两家永远用不了。

**为什么没有「自动续期」？**
两家的凭据都是登录后一次性签发的长期静态材料，上游没有 refresh 端点。写一个续期只会在每半小时发一次注定失败的请求。

**模型列表怎么和平台上不一样？**
MonkeyCode 网关没有模型列表接口（405），插件里的表是快照；百智云有远端目录，登录后会跟着平台变。

**签名是什么？我要自己算吗？**
不用。签名密钥（`signing_secret`）在浏览器登录时和 Key 一起签发；手工录 Key 时把两个值都粘进来就行。百智云不需要签名。

---

## 参考源

| 来源 | 用在哪 |
|---|---|
| [iJetLi/dsh-providers-hub](https://github.com/iJetLi/dsh-providers-hub)（MIT） | MonkeyCode 与百智云的协议取证：网关地址、签名算法、平台接口、PoW 验证题、额度口径 |
| [Betsy20/magpie-Jet-Hub](https://github.com/Betsy20/magpie-Jet-Hub) | 最初要提取的 magpie 适配层 |
| [MYCF711/magpie-plugin-scaffold](https://github.com/MYCF711/magpie-plugin-scaffold)（MIT） | 九钩子骨架、检查脚本、`browser-login` 与 `quota` 工具 |

协议细节、取证行号与「为什么不这么做」写在 [docs/internals.md](./docs/internals.md)。

> 更新记录：[CHANGELOG.md](./CHANGELOG.md)

## 许可

[MIT](./LICENSE)。MonkeyCode 本身是 AGPL-3.0 的开源项目，与本插件无隶属关系。
