// 凭据解析（两个供应商共用）。
//
// magpie 的登录把凭据存成一个字符串（oauth 存 `auth.access`，api 存 `auth.key`），
// 而两家厂商需要的字段不一样：
// - MonkeyCode：`access_token`（oma_…）+ `signing_secret`（签名密钥），缺后者每个请求 403；
// - 百智云：只有 `access_token`（sk-…）；
// - 两家都可以带 `session_cookie`（HttpOnly，只用于查额度 / 换 Key）。
//
// 所以这个 key 存 JSON。同时也接受「裸 token」与「token:secret」两种人肉写法。
//
// ⚠ 刻意**不校验前缀**：上游将来可能换前缀，把 `oma_` / `sk-` 写死会让新 Key
// 直接被判「凭据不完整」（opencode 的 IKPLRU 教训）。只做「像不像 token」的形状检查。

const TOKEN = /^[A-Za-z0-9_.\-/+=]{16,}$/

/**
 * 解析凭据字符串。
 *
 * 三种输入：
 * - 完整 JSON：`{"access_token":"oma_…","signing_secret":"…"}`（可带 session_cookie / nickname / user_id）
 * - 冒号/空白分隔：`oma_…:密钥`、`oma_… 密钥`
 * - 裸 token：`oma_…`
 *
 * @returns {{ access_token: string, signing_secret?: string, session_cookie?: string, nickname?: string, user_id?: string } | undefined}
 */
export function parseCredential(raw) {
  if (typeof raw !== "string") return undefined
  const text = raw.trim()
  if (text.length === 0) return undefined
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed !== "object" || parsed === null) return undefined
      // 至少要有一个可用字段。**只有 `session_cookie` 也放行**：有些厂商的
      // 额度 / 积分只认网页登录态，用户手抄 cookie 就能用那部分能力（虽然发不了
      // 消息）—— 判死的代价比放行大，能不能推理交给 hasToken 去管。
      const hasKey = typeof parsed.access_token === "string" && parsed.access_token.length > 0
      const hasCookie = typeof parsed.session_cookie === "string" && parsed.session_cookie.length > 0
      if (!hasKey && !hasCookie) return undefined
      return parsed
    } catch {
      return undefined
    }
  }
  // `oma_…:<secret>` 或 `oma_… <secret>`：平台把两个值分开显示，用户会很自然地拼一行。
  const pair = text.match(/^([^\s:]+)[\s:]+([^\s:]+)$/)
  if (pair && TOKEN.test(pair[1]) && TOKEN.test(pair[2])) {
    return { access_token: pair[1], signing_secret: pair[2] }
  }
  // 裸 token 只接受「像 token 的值」：含空格/中文的输入不是 token，判无效而不是硬塞。
  return TOKEN.test(text) ? { access_token: text } : undefined
}

/**
 * 拼一个 oauth 登录的 `success` 结果。
 *
 * ⚠ **`refresh` 不是可选项，是「存不存得下」的开关。**
 * magpie 的插件宿主（`host.js` 的 `save()`）只认这个形状：
 *
 * ```js
 * if ("refresh" in result) setAuth(key, { type: "oauth", refresh, access, expires, ...extra })
 * else if ("key" in result || apiKey) setAuth(key, { type: "api", key, metadata })
 * ```
 *
 * 两条都不命中时它**既不保存也不报错**：`saved` 照常回 `{ok:true}`，magpie 于是
 * 显示「已登录」，而账号根本没落盘 —— 紧接着的 `providers?wait=1` 里自然找不到这个
 * account，卡片打出一句「{user} 已登录，但 magpie 无法列出它，请反馈此问题」。
 *
 * 这个包没有 refresh 端点（凭据是长期静态材料），但 `refresh` 位必须占上：
 * 放同一串 JSON，`secretOf()` 才有值、同账号判重才按秘密比对。`expires: 0`
 * 表示永不到期，`auth.refresh` 恒返回 undefined，不会有人拿它去续期。
 *
 * @param {object} fields
 * @param {string} fields.access 存进 `auth.access` 的凭据字符串
 * @param {string} [fields.accountId] 卡片上的**名字**（不是身份）
 * @param {string} [fields.uid] 平台账号 id（身份，magpie 按它判重）
 * @param {string} [fields.message] 给用户看的补充说明
 */
export function signInSuccess({ access, accountId, uid, message, ...rest }) {
  return {
    type: "success",
    access,
    // 与 access 同值：没有 refresh_token 的厂商，两格装的是同一份静态凭据。
    refresh: access,
    // 0 = 永不到期（长期静态材料）；调用方给 expires 就以它为准。
    expires: 0,
    ...rest,
    ...(typeof accountId === "string" && accountId.length > 0 ? { accountId } : {}),
    ...(typeof uid === "string" && uid.length > 0 ? { uid } : {}),
    ...(typeof message === "string" && message.length > 0 ? { message } : {}),
  }
}

/** 凭据是否有可用的推理 Key。 */
export function hasToken(credential) {
  return Boolean(credential && typeof credential.access_token === "string" && credential.access_token.length > 0)
}

/** 凭据是否有签名密钥（MonkeyCode 网关要求）。 */
export function hasSigningSecret(credential) {
  return Boolean(credential && typeof credential.signing_secret === "string" && credential.signing_secret.length > 0)
}

/** 面板展示用的打码 key（`前4…后4`）；形状不合法返回空串。 */
export function maskKey(apiKey) {
  if (typeof apiKey !== "string" || apiKey.length < 12) return ""
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`
}
