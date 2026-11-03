# MonkeyCode 与百智云 for magpie

把 **MonkeyCode 国内站 / 国际站 / 百智云** 三家接进 magpie，一个插件、三个独立供应商、三套互不干扰的账号池。

```
3 家供应商 · 国内站与国际站各自独立登录态
桌面客户端直接导入，装过客户端就不用再登一次
三个 provider 各有额度条、积分与每日签到
```

---

## 功能

- **三家供应商，账号池分开** —— `monkeycode`（monkeycode-ai.com）、`monkeycodeintl`（monkeycode-ai.net）、`baizhi`（百智云）各自登录、各自计费，互不覆盖
- **三种接入方式** —— 从本机 MonkeyCode 桌面客户端导入（最快）/ 浏览器登录（自己挑登录方式，插件不替你点）/ API Key 手填
- **网关请求签名** —— MonkeyCode 的网关要求每个请求带 `X-OhMyAgent-Signature`；插件改过请求体（补 system、钳 max_tokens）之后会重新算签名
- **额度与积分如实显示** —— 每日 token 额度、订阅档位（Basic / Pro / Ultra）、积分余额各一条读数；查不到的显示未知，不编造
- **每日签到** —— 自动解开厂商的 PoW 验证题后签到；今天签过就不发写请求
- **多账号按序兜底** —— 勾几账号就排几号，前一个额度用完自动换下一个
- **模型目录跟随平台** —— 登录后跟随平台上下架；接口抖动时退回上次快照，不会把列表清空

---

## 模型

**DeepSeek / GLM / Kimi / Qwen / MiniMax** —— 各家最新的都在，登录后跟随平台目录上下架。

| 供应商 | 代表模型 | 上下文 | 备注 |
|---|---|---|---|
| `monkeycode` | `monkeycode-basic/deepseek-flash` | 200K | 每日额度内免费，按档位（basic / pro / ultra）分池 |
| `monkeycode` | `monkeycode-basic/glm-5.3-flash` | 200K | 同上 |
| `monkeycode` | `monkeycode-pro/deepseek-flash` | 200K | pro / ultra 档模型需要对应订阅，未订阅时标记为已锁定 |
| `baizhi` | `deepseek-v4-pro` | 1,048,576 | 按量扣积分；四条 DeepSeek 是长上下文档 |
| `baizhi` | `deepseek-v4-flash` | 1,048,576 | 同上，更便宜的一档 |
| `baizhi` | `glm-5.3` / `kimi-k3` / `qwen3.8-max` | 200K | 按量计费 |

思考档位按各家自己声明的透传。图片能力只给明确支持看图的模型标 `image`，其余一律 text-only（不猜）。

> 只列各家的最新与热门。模型目录随时上下架，全表抄进 README 一个月就过期；
> 装好以后 `magpie plugin list` 拿到的才是真实的全部。

---

## 签到

MonkeyCode 与百智云都支持每日签到（解开厂商的 PoW 验证题后自动完成）。幂等：今天签过就不会再发写请求。
签到失败不影响推理 —— 额度照常可用，只是当天没拿到奖励。

---

## 安装

在 magpie 的 **插件 → 发现** 搜 **MonkeyCode 与百智云**，点**安装**。

装好后先选**一种**登录方式，最快的是「从本机客户端导入」：

- 装过 MonkeyCode 桌面版并登录过 → 点「从本机客户端导入」，一两秒就好，不弹任何窗口
- 没装过 → 点「浏览器登录」，在打开的窗口里自己挑扫码 / 支付宝 / 抖音 / GitHub / 观猹 / 账号密码；插件只做一件事：等你登完，读会话、换网关凭据
- 已经有网关密钥 → 点「API Key」，粘 `{"access_token":"oma_…","signing_secret":"…"}`（也接受 `oma_…:密钥` 一行）

想加第二个账号：再点一次「浏览器登录」—— 每次都是干净窗口，不会读到上一个号的登录态。

### 命令行

```bash
# 从 npm（推荐）
magpie plugin add magpie-monkeycode

# 从仓库源码（拿最新代码，不走 npm）
magpie plugin add github:MYCF711/magpie-monkeycode
```

装完确认：

```bash
magpie plugin list
# magpie-monkeycode  on
#   monkeycode (MonkeyCode 猴子编程, 9 models)  signed in as 观猹员 ####
#   monkeycodeintl (MonkeyCode International, 9 models)
#   baizhi (百智云, 15 models)  signed in as 观猹员 ####
```

---

## 常见问题

**「从本机客户端导入」说没读到登录态？** 桌面版要**先登录成功**才会把会话写到本机。打开桌面版登一次，再回来点。

**导入时说「桌面版里的登录可能已经过期」？** 桌面版的会话有有效期（通常几天到一个月）。重新打开桌面版，它会自己续期；或者直接用「浏览器登录」。

**为什么我加第二个号，列表还是只有一个？** magpie 按上游账号 id 去重 —— 同一个账号点两次只会更新凭据、不会变成两个。要加新号，得在窗口里**换一个账号登录**。

**为什么模型列表里有「已锁定」的？** MonkeyCode 的 pro / ultra 档模型需要对应订阅才能用，未订阅时插件照实列出来并标记，不是 bug。

**额度条显示「剩余额度未知」？** 平台接口暂时读不到（网络抖动或未登录态查额度）。推理不受影响，下一轮刷新会恢复。

---

## 参考源

| 来源 | 用在哪 |
|---|---|
| [magpie 插件脚手架](https://github.com/usemagpie/magpie-plugin-scaffold) | 钩子契约、`src/` 通用件（`session-login` / `desktop-import` / `browser-login` / `quota` / `store` 等） |
| [magpie-Jet-Hub](https://github.com/Betsy20/magpie-Jet-Hub) | MonkeyCode 供应商的协议取证（端点、签名头、错误码） |
| MonkeyCode 桌面客户端（`com.chaitin.baizhi.monkeycode`） | cookie 落盘位置与字段形态（用于「从本机客户端导入」） |
| Anthropic Messages API | 推理报文形态（MonkeyCode 走 `/v1/messages`） |

## 许可

MIT，见 [LICENSE](./LICENSE)；归属说明见 [NOTICE.md](./NOTICE.md)。

> 更新记录：[CHANGELOG.md](./CHANGELOG.md)
