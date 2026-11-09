// MonkeyCode 国内站 / 国际站 + 百智云 —— 一个 magpie 插件包，三个独立供应商。
//
// magpie 把入口里的每个具名函数导出当成一个插件实例：
//   MonkeyCodeAuthPlugin     → monkeycode      (monkeycode-ai.com)
//   MonkeyCodeIntlAuthPlugin → monkeycodeintl  (monkeycode-ai.net)
//   BaizhiAuthPlugin         → baizhi          (ai-models.app.baizhi.cloud)
//
// 三个供应商共享的是「magpie 钩子的装配方式」与若干通用件（凭据解析、平台请求、
// 浏览器会话登录、额度构造器）；协议、凭据、额度口径各自独立：
//   · MonkeyCode 走自签网关（x-api-key + HMAC 签名），有每日额度与积分、有签到；
//   · 百智云走标准 Anthropic Messages（只认 x-api-key），按量计费、每日领积分（checkin 自动领取）。
//
// 协议来源：iJetLi/dsh-providers-hub 的 src/monkeycode-*.ts 与 src/baizhi-*.ts
// （2026-11-03 读取，commit 9047d42）。

import { makePlugin } from "./src/monkeycode/runtime.mjs"
import { makeBaizhiPlugin } from "./src/baizhi/runtime.mjs"
import { SITES } from "./src/sites.mjs"

export const MonkeyCodeAuthPlugin = makePlugin(SITES.monkeycode)
export const MonkeyCodeIntlAuthPlugin = makePlugin(SITES.monkeycodeintl)
export const BaizhiAuthPlugin = makeBaizhiPlugin()

export const _internal = Object.freeze({
  SITES,
  makePlugin,
  makeBaizhiPlugin,
  providers: Object.freeze(["monkeycode", "monkeycodeintl", "baizhi"]),
})
