# NOTICE

本项目的部分**协议原语与工程模式**提炼自以下以 MIT 许可发布的项目。实现已改写为厂商无关的通用版本：
没有复制厂商域名、签名算法、登录页选择器、模型目录或额度表。

## magpie-community/plugins

- 仓库：https://github.com/magpie-community/plugins
- 许可：MIT
- 版权：Copyright (c) 2026 magpie-community contributors；`packages/codearts` 包内 LICENSE 另列
  Copyright (c) 2026 yuweihao17 / Sakura-Natsu，`packages/zen-free` 包内 LICENSE 另列
  Copyright (c) 2026 xiaozhou26。
- 吸收内容：
  - `packages/codearts`（https://github.com/magpie-community/plugins/tree/main/packages/codearts）：
    `parseSseEvents` / `completionFromChunks` / `foldAnswer` 的 SSE 折叠与 tool_calls 合并思路；
    `peekAnswer` 的 200 内嵌错误窥探与 replay 思路（`src/openai-sse.mjs`）；
    `createConcurrencyGate` 的并发闸参考（未直接采用）
  - `packages/zen-free`（https://github.com/magpie-community/plugins/tree/main/packages/zen-free）：
    `stream.mjs` 的 Chat accumulator、`tool-response.mjs` 的 `framesFrom` 帧解析、
    `TextDecoder(fatal, ignoreBOM)` 与 32 MiB 上限（`src/openai-sse.mjs`）
  - `packages/raccoon`（https://github.com/magpie-community/plugins/tree/main/packages/raccoon）：
    loopback OAuth 的 state 单值校验、Host 校验、单次回调与 CSP 处理（`src/oauth-pkce.mjs`）；
    refresh 单飞 + 60 秒回放（`src/refresh-lock.mjs`）
  - `packages/workbuddy`（https://github.com/magpie-community/plugins/tree/main/packages/workbuddy）：
    refresh 单飞 / 短回放结构（`src/refresh-lock.mjs`）

## MYCF711 自有 MIT 插件

- `magpie-magicrew-auth` — https://github.com/MYCF711/magpie-magicrew-auth
  - `src/model-context.mjs`：查 `~/.cache/magpie/models.json` 的递归索引与 TTL 缓存模式（`src/model-context.mjs`）
  - `src/hooks/loader.mjs`：工具 schema 兼容改写（`walkSchema` 只走 schema 位置、非布尔 `additionalProperties` → `true`、删 `items:{}`、`items` 子树 union 摊平且不留空 schema）的思路与边界（`src/tool-schema.mjs`）
  - `src/key-store.mjs`：`renewOnce` 按 siteId + account 的并发去重（`src/refresh-lock.mjs`）
- `magpie-officeace` — https://github.com/MYCF711/magpie-officeace
  - `src/login.mjs`：`refreshOnce` 按 refreshToken 键控（`src/refresh-lock.mjs`）
- `magpie-trustoken-auth` — https://github.com/MYCF711/magpie-trustoken-auth
  - `src/oauth.mjs`：`beginOAuth` / PKCE S256 / 127.0.0.1 随机端口回调（`src/oauth-pkce.mjs`）
- `magpie-loomy-auth` — https://github.com/MYCF711/magpie-loomy-auth
  - `tests/mount.test.mjs`：入口唯一函数导出 / 九钩子 / config / loader / usage 的挂载测试结构（`tests/mount.test.mjs`）

以上项目的版权归各自作者所有，按 MIT 许可使用。本项目自身同样以 MIT 许可发布，完整许可正文见 `LICENSE`。

## MonkeyCode 协议取证

- 仓库：https://github.com/iJetLi/dsh-providers-hub
- 许可：MIT
- 版权：Copyright (c) 2026 iJetLi / dsh-providers-hub contributors
- 吸收内容（本项目按 magpie 钩子重写，未复制其 cordis 运行时结构）：
  - `src/monkeycode-product.ts`：两个站点的网关与平台地址、接口路径、内置模型快照
  - `src/monkeycode.ts`：`X-OhMyAgent-Signature` 的签名算法、被签 prompt 的取值优先级、失败分类
  - `src/monkeycode-credits.ts`：网页会话换网关凭据的接口、钱包 / 订阅 / 签到接口、PoW 验证题算法（`prng` / `solveOne`）
  - `src/monkeycode-browser-login.mjs`：受控浏览器轮询会话 cookie、401 继续等用户登录的判据
- 协议说明另见上游：[chaitin/MonkeyCode](https://github.com/chaitin/MonkeyCode)（AGPL-3.0，与本插件无隶属关系）
