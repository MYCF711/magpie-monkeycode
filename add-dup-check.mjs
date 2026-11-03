import { readFileSync, writeFileSync } from "node:fs"

const p = "src/monkeycode/runtime.mjs"
let s = readFileSync(p, "utf8")

// 1) 顶部加 helper（放在 import 之后的第一段空行前）
const anchor = 'import { KNOWN_CONTEXT, isStale, prettyModelName, readCatalog, refreshCatalog } from "./catalog.mjs"'
if (!s.includes(anchor)) { console.log("IMPORT_MISSING"); process.exit(1) }
if (!s.includes("function existingAccountWithUid")) {
  s = s.replace(anchor, anchor + `

/**
 * magpie 里是不是已经有这个 uid 的账号了。
 *
 * 只读：插件对 magpie 的目录**只有读的份**（写入多账号的唯一载体是 authorize 的
 * 返回值，插件不碰这些文件）。
 *
 * 为什么要看这个：点「添加另一个账号」但复用到了同一个身份时，magpie 会按 uid
 * 去重 —— 界面提示「已添加」，而列表里还是那一个。不把这件事说出来，用户
 * 会一直以为插件坏了。
 */
function existingAccountWithUid(providerId, uid) {
  if (typeof uid !== "string" || uid.length === 0) return false
  try {
    const store = JSON.parse(readFileSync(join(homedir(), ".config", "magpie", "plugin-auth.json"), "utf8"))
    return Object.entries(store ?? {}).some(([key, record]) =>
      (key === providerId || key.startsWith(\`\${providerId}#\`)) && record?.uid === uid)
  } catch {
    return false
  }
}
`)
}

// 2) SSO 成功返回带上「已存在」的提示
const oldReturn = `                    const signed = await signInWithBaizhiSession(baizhiCookie, site)
                    return {
                      type: "success",
                      access: JSON.stringify(signed.credential),
                      expires: 0,
                      accountId: signed.nickname ?? "",
                      uid: signed.userId ?? "",
                    }`
if (!s.includes(oldReturn)) { console.log("RETURN_MISSING"); process.exit(1) }
const newReturn = `                    const signed = await signInWithBaizhiSession(baizhiCookie, site)
                    const duplicated = existingAccountWithUid(site.id, signed.userId ?? "")
                    return {
                      type: "success",
                      access: JSON.stringify(signed.credential),
                      expires: 0,
                      accountId: signed.nickname ?? "",
                      uid: signed.userId ?? "",
                      // 同一个授权身份只能对应一个 MonkeyCode 账号 —— 复用到旧身份时
                      // magpie 会按 uid 去重。说清楚，别让「提示成功但列表没变」变成谜。
                      ...(duplicated
                        ? { message: "这个百智云账号已经开通过 MonkeyCode（同一账号，凭据已更新）。要加新号，请换一个百智云账号登录，或用「添加另一个账号」。" }
                        : {}),
                    }`
s = s.replace(oldReturn, newReturn)

writeFileSync(p, s)
console.log("PATCHED")
