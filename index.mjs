// MonkeyCode 国内站 / 国际站 —— 一个 magpie 插件包，两个独立供应商。
//
// magpie 把入口里的每个具名函数导出当成一个插件实例：
//   MonkeyCodeAuthPlugin     → monkeycode      (monkeycode-ai.com)
//   MonkeyCodeIntlAuthPlugin → monkeycodeintl  (monkeycode-ai.net)
//
// 两站共享协议、签名、额度、签到与错误分类；网关、平台、登录域与模型快照
// 由 src/sites.mjs 的独立适配器提供。
//
// 协议来源：iJetLi/dsh-providers-hub 的 src/monkeycode-*.ts（2026-11-03 读取）。

import { makePlugin } from "./src/monkeycode/runtime.mjs"
import { SITES } from "./src/sites.mjs"

export const MonkeyCodeAuthPlugin = makePlugin(SITES.monkeycode)
export const MonkeyCodeIntlAuthPlugin = makePlugin(SITES.monkeycodeintl)

export const _internal = Object.freeze({
  SITES,
  makePlugin,
  providers: Object.freeze(Object.keys(SITES)),
})
