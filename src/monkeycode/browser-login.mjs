// MonkeyCode 的浏览器登录 —— 通用实现在 src/session-login.mjs。
//
// 保留这个入口是为了让 src/monkeycode/* 的调用方不必知道通用件放在哪。
export { browserLogin, BROWSER_LOGIN_TIMEOUT_MS, BROWSER_LOGIN_POLL_MS, _internal } from "../session-login.mjs"
