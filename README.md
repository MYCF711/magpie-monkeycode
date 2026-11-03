# MonkeyCode 猴子编程 for magpie

**一个包签入 MonkeyCode 国内站与国际站，9 个模型直接进 magpie —— 浏览器登录一次，DeepSeek 与 GLM 就能被任何 agent 用。**

MonkeyCode（长亭科技）是面向工程团队的开源 AI 编程平台：托管版每天有免费额度，也能私有化部署。
这个插件把它的两个站点注册成 magpie 的两个供应商，用你自己的账号额度，不需要另外买 API。

```
2 个供应商   国内站 monkeycode / 国际站 monkeycodeintl，两组登录态互不覆盖
9 个模型     basic / pro / ultra 三档额度的 DeepSeek 系 + 逐次扣积分的 DeepSeek 与 GLM-5
2 条登录路   浏览器登录（自动换凭据）、API Key 录入
0 次手工抄   Cookie 是 HttpOnly 的，插件自己从浏览器读
```

---

## 功能

- **两个站点两张卡** —— 国内与国际各自独立账号池；国内站的 cookie 打国际站会 401，所以不能合成一张卡。
- **浏览器登录一次就够** —— 插件开一个一次性的受控浏览器窗口，你在里面登完，它自动读会话、换一对网关凭据、再读你的昵称。
- **API Key 也能录** —— 已经手上有 `oma_…` 和签名密钥的，直接粘贴 `{"access_token":"…","signing_secret":"…"}`（或 `oma_…:密钥`）。
- **网关签名现算** —— 每个请求按最终 body 里的 prompt 重算 `X-OhMyAgent-Signature`；改了 payload 签名跟着变，不会出现只有一句 `invalid ohmyagent request` 的 403。
- **额度看得到** —— 卡片上两条读数：每日额度（计费 token）与积分余额；订阅档位写在套餐名上。
- **每日签到自动做** —— 厂商发的是本地可解的 PoW 验证题，插件解完再领；今天签过就不发写请求。
- **不假装能刷新** —— 凭据是长期静态材料，上游没有续期端点，插件也不会定时发注定失败的请求。
- **缺什么说什么** —— 没有网页会话时推理照常，只是额度与签到降级，并明确告诉你为什么。

---

## 模型

**DeepSeek / GLM** —— 各家在 MonkeyCode 上架的都在；目录由平台决定，插件内置的是登录前的快照。

| 发行商 | 代表模型 | 上下文 | 计费方式 |
|---|---|---|---|
| DeepSeek | `monkeycode-basic/deepseek-flash` | 1,048,576 | 每日额度（basic 档） |
| DeepSeek | `monkeycode-pro/deepseek-v4-pro` | 1,048,576 | 每日额度（pro 档） |
| DeepSeek | `monkeycode-ultra/deepseek-v4-pro` | 1,048,576 | 每日额度（ultra 档） |
| DeepSeek | `deepseek-v4-flash` | 1,048,576 | 直接扣积分 |
| 智谱 | `glm-5` | 未声明 | 直接扣积分 |

- 带 `monkeycode-basic/` `monkeycode-pro/` `monkeycode-ultra/` 前缀的走上订阅档位的每日额度；不带前缀的直接扣积分。
- 上下文窗口只在有实测证据的 DeepSeek 系上声明（服务端 400 原文写明 1,048,576）；`glm-5` 没有实测，就不写 —— 宁可没有进度条，也不谎报一个会让 agent 推迟压缩的窗口。
- 网关没有模型列表接口（`GET /v1/models` 返回 405），所以模型表是内置快照；上游加模型后插件不会自动多出来。

---

## 签到

每天一次，按账号。先查今天签没签（签过就直接回「今天已签」，不发写请求），没签就取一道 PoW 验证题、本地解完、提交、再领。
验证题形态变了（题面不认识 / 参数越界 / 解不完）时如实回报「需要手动签到」，不会无限重试。

---

## 安装

在 magpie 的 **插件 → 发现** 搜 `MonkeyCode`，点**安装**；或在 **插件 → 安装** 里填仓库地址。

装完到 **Providers** 页面点 `monkeycode` / `monkeycodeintl` 的「连接」：

- 选 **浏览器登录**：弹出窗口 → 登录 → 关掉窗口，卡片会自动变成你的昵称。
- 或选 **API Key**：到 MonkeyCode 平台的「OhMyAgent」页面生成 Key，把 `oma_…` 与签名密钥一起粘贴进去。

> API Key 与签名密钥是两个值，缺签名密钥每个请求都会被 403 —— 粘贴完整 JSON 最稳。

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
额度接口只认网页登录态（HttpOnly cookie），不认 API Key。用 API Key 登录的账号能发消息，但查不到额度、也签不了到；点卡片上的「改 Key」补填 session cookie，或改用浏览器登录。

**为什么两个站点要分两张卡？**
国内站与国际站是同一程序的两套部署，账号池不互通（国内 cookie 打国际站回 401）。合成一张卡会让其中一个站点永远用不了。

**为什么没有「自动续期」？**
MonkeyCode 的凭据是登录后一次性签发的长期静态材料，上游没有 refresh 端点。写一个续期只会在每半小时发一次注定失败的请求。

**模型列表怎么和平台上不一样？**
网关没有模型列表接口（405），插件里的表是登录前的快照。平台上新模型后需要等插件更新；已经在表里的模型照常能用。

**签名是什么？我要自己算吗？**
不用。签名密钥（`signing_secret`）在浏览器登录时和 Key 一起签发；如果你手工录 Key，把两个值都粘进来就行。

---

## 参考源

| 来源 | 用在哪 |
|---|---|
| [iJetLi/dsh-providers-hub](https://github.com/iJetLi/dsh-providers-hub)（MIT） | MonkeyCode 的协议取证：网关地址、签名算法、平台接口、PoW 验证题、额度口径 |
| [Betsy20/magpie-Jet-Hub](https://github.com/Betsy20/magpie-Jet-Hub) | 最初要提取的 magpie 适配层 |
| [MYCF711/magpie-plugin-scaffold](https://github.com/MYCF711/magpie-plugin-scaffold)（MIT） | 九钩子骨架、检查脚本、`browser-login` 与 `quota` 工具 |

协议细节、取证行号与「为什么不这么做」写在 [docs/internals.md](./docs/internals.md)。

> 更新记录：[CHANGELOG.md](./CHANGELOG.md)

## 许可

[MIT](./LICENSE)。MonkeyCode 本身是 AGPL-3.0 的开源项目，与本插件无隶属关系。
