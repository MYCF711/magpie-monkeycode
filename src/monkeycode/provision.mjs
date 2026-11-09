// 百智云登录成功 → **自动**写出国内 MonkeyCode 账号（像华为云插件那样，一份身份两处通用）。
//
// ## 这个文件解决什么
//
// 用户要求：在「百智云 BaiZhiCloud」卡片上登录 / 从本机客户端导入成功之后，
// 国内 MonkeyCode 账号要自己开出来，不再要求用户去点第二次。
// 接线点在百智云的 `finishSignIn()`（`src/baizhi/runtime.mjs:179`，两条登录方式共用），
// 它拿到会话后调这里；**本文件不接线，只管「安全地写一条记录」**。
//
// ## 为什么不能直接 `client.auth.set` 了事
//
// 宿主（magpie 的 plugin-host）只给一个出口，而且它有三条会静默出错的性质
// （逐行核定见 docs/automatic-credential-reuse.md §1.2，此处只列结论）：
//
//   1. **整体替换**：body 就是那条记录的全部，不给的字段就是没有；
//   2. **失败也回 `{data:true}`**：`id` 不是字符串 / body 不是对象 / 账号库读不出来时
//      它一个字都不写，调用方看不出区别 —— 所以**必须回读**，且不能只比 uid
//      （宿主也可能把旧记录留在那里，uid 对得上、凭据是旧的，每个请求 403）；
//   3. **读不出账号库时写回照样发生**，写回的内容只有这一次那一条 —— 用户其它账号
//      会从 `plugin-auth.json` 里消失（原文件只留在 `.bad-<时间戳>`）。
//      所以「读不出来」必须由**我们**挡在写之前。
//
// ## 键怎么选（决定的全部理由）
//
//   · `uid` 命中库里已有的账号  → **原位重写**那个键（不新增账号行）；
//   · 库是空的                  → 裸键 `monkeycode`（与宿主自己的习惯一致：第一颗账号）；
//   · 裸键被**别的**账号占着     → `monkeycode#<sha256(uid)[0:8]>`（确定性：同一个身份永远
//     落到同一个键，重复自动开通天然幂等。**不能**用随机后缀 —— 那是「每次登录一个新账号」）；
//   · `uid` 拿不到 / 库读不出来  → **不写**（前者没有幂等键，后者会挤掉别人的账号）。
//
// ## 边界
//
//   · **不起浏览器**：SSO 由调用方注入（`options.sso`），本文件一个网络请求都不发；
//   · 目标站点是**常量** `SITES.monkeycode` —— 国际站（`monkeycodeintl`）永不在自动路径上；
//   · 同一份会话**单飞**：连点两次登录只换一次号（一次 SSO = 5~90 秒 + 多签一把 Key）；
//   · 任何失败都返回结构化结果（`{ok:false, ...}`），**从不抛** —— 自动开通不许把
//     百智云登录带崩；
//   · 不做启动扫库（理由见 docs §4）：这里只在一次登录成功之后被调一次。

import { existsSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

import { SITES } from "../sites.mjs"
// 「已导入」台账：与手动「用百智云账号开通」**同一个文件、同一种格式**，
// 否则自动路径开过的号会被手动路径再导一遍（重复一次 SSO）。
import { markImported as markImportedInLedger } from "./sso-import.mjs"

/** 自动开通的目标站点：**常量**，绝不从调用方传进来（国际站绝不能被写）。 */
const TARGET = SITES.monkeycode
const PROVIDER = TARGET.id

/** 单飞表：会话指纹 → 在跑的那个 Promise（同一份 cookie 只换一次号）。 */
const inFlight = new Map()

/** `sha256(x)` 前 16 位：单飞键（够短、够散，不进日志）。 */
const fingerprintOf = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 16)

/** `sha256(x)` 前 8 位：账号键的确定性后缀。 */
const keySuffixOf = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 8)

/** magpie 的账号库位置（与 sso-import.mjs 的 `authStorePath()` 同一套约定）。 */
function defaultAuthFile() {
  return join(homedir(), ".config", "magpie", "plugin-auth.json")
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** 凭据能不能拿去调 MonkeyCode 网关：两把都得在（缺 signing_secret 每个请求 403）。 */
function usableCredential(credential) {
  return isPlainObject(credential)
    && typeof credential.access_token === "string" && credential.access_token.length > 0
    && typeof credential.signing_secret === "string" && credential.signing_secret.length > 0
}

/**
 * 读某个 provider 已有的记录。
 *
 * `ok` 是给调用方做**写前闸**用的，不是装饰：
 *   · `ok:true` + 空 `accounts` = 文件不存在（首次使用，正常路径，可以写裸键）；
 *   · `ok:false` = **读不出来**（坏 JSON / 顶层不是对象）—— 此时一个字都不许写。
 *
 * ⚠ 判据必须是 `key === providerId || key.startsWith(providerId + "#")`：
 *   `monkeycode` 是 `monkeycodeintl` 的前缀，写成 `startsWith(providerId)`
 *   会把国际站的账号当成国内站的，键选择就会按错的库做判断。
 *
 * `access` / `refresh` 一并带出来，是给写完之后的回读校验用的（见 `verifyWritten`）。
 *
 * 只读，不写、不创建目录、不加锁。
 *
 * @param {string} providerId provider id（`monkeycode` / `baizhi` / …）
 * @param {string} [file] 账号库路径（默认 magpie 的那个）
 * @returns {{ ok: boolean, accounts: Array<{ key: string, accountId: string, uid: string, access: string, refresh: string }> }}
 */
export function readProvisionedAccounts(providerId, file = defaultAuthFile()) {
  if (typeof providerId !== "string" || providerId.length === 0) return { ok: false, accounts: [] }
  if (typeof file !== "string" || file.length === 0) return { ok: false, accounts: [] }
  if (!existsSync(file)) return { ok: true, accounts: [] }

  let all
  try {
    all = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return { ok: false, accounts: [] }
  }
  if (!isPlainObject(all)) return { ok: false, accounts: [] }

  const accounts = Object.entries(all)
    .filter(([key]) => key === providerId || key.startsWith(`${providerId}#`))
    .map(([key, record]) => ({
      key,
      // accountId 是**显示名**、uid 是**身份**（宿主同名口径，见 docs §1.3）。
      accountId: typeof record?.accountId === "string" ? record.accountId : "",
      uid: typeof record?.uid === "string" ? record.uid : "",
      access: typeof record?.access === "string" ? record.access : "",
      refresh: typeof record?.refresh === "string" ? record.refresh : "",
    }))
  return { ok: true, accounts }
}

/**
 * 要不要写、写到哪个键。**纯函数**，不碰文件系统。
 *
 * @param {{ store: { ok: boolean, accounts: Array<object> }, uid: string }} input
 * @returns {{ key: string } | { skip: string }}  `skip` 取 `no-uid` / `store-unreadable`
 */
export function decideProvision({ store, uid } = {}) {
  const identity = typeof uid === "string" ? uid.trim() : ""
  // 没有稳定身份就没有幂等键：写下去就是「每登一次多一个账号」。
  if (identity.length === 0) return { skip: "no-uid" }
  // 库读不出来时宿主的写回会挤掉用户其它账号（docs §1.2-E），这道闸必须在我们这里。
  if (!store || store.ok !== true) return { skip: "store-unreadable" }

  const accounts = Array.isArray(store.accounts) ? store.accounts : []
  const same = accounts.find((account) => account && typeof account.uid === "string" && account.uid === identity)
  if (same) return { key: same.key }
  if (!accounts.some((account) => account && account.key === PROVIDER)) return { key: PROVIDER }
  return { key: `${PROVIDER}#${keySuffixOf(identity)}` }
}

/**
 * 一条账号记录的**全部内容**（宿主整体替换，少一个字段就是丢）。
 *
 * 形状与宿主 `save()` 落盘的一致（`src/credential.mjs:79-92` 的 `signInSuccess` 同源）：
 * `refresh` 位不是可选项 —— 它是宿主「存不存得下」的开关，值为 0 表示永不到期。
 *
 * @param {{ credential: object, accountId?: string, uid?: string }} input
 * @returns {{ type: "oauth", refresh: string, access: string, expires: number, accountId?: string, uid?: string }}
 */
export function monkeycodeRecord({ credential, accountId = "", uid = "" } = {}) {
  const access = JSON.stringify(credential ?? {})
  return {
    type: "oauth",
    // 没有 refresh 端点的厂商，两格装同一份静态凭据（见 src/credential.mjs 的注释）。
    refresh: access,
    access,
    expires: 0,
    // 空串不写：宿主按 accountId 判重，空串会把两个不同账号并成一个。
    ...(typeof accountId === "string" && accountId.length > 0 ? { accountId } : {}),
    ...(typeof uid === "string" && uid.length > 0 ? { uid } : {}),
  }
}

/**
 * 回读校验：**key + uid + access + refresh 四样都要对上**。
 *
 * 只比 uid 是不够的 —— 宿主可能「留下旧记录」（uid 一样、凭据是上一次的），
 * 也可能干脆没写（`{data:true}` 但文件没变）。两种都必须报失败。
 */
function verifyWritten(store, key, body) {
  if (!store.ok) return false
  const stored = store.accounts.find((account) => account.key === key)
  if (!stored) return false
  return stored.uid === body.uid && stored.access === body.access && stored.refresh === body.refresh
}

/**
 * 把一个字符串里出现的会话 / 凭据抹掉。日志与返回值都只写「发生了什么」，不写能用的东西。
 *
 * 两层，缺一层都会漏：
 *   ① **已知值**：我们手上那份会话串 / access_token / signing_secret / session_cookie；
 *   ② **按形状**：错误信息常常不是我们拼的（SSO、宿主、fetch 都会往外抛），
 *      里面的 `access_token=…` / `signing_secret=…` / cookie 对、以及裸的 `oma_…` 串，
 *      我们并不知道具体值 —— 只能按字段名与前缀抹。
 *   第 ② 层就是「SSO 自己抛错、我们还没拿到凭据」时唯一的防线。
 */
const SECRET_FIELD = /(^|[^A-Za-z0-9_-])((?:sl-session|baizhi_session|monkeycode_ai_session|access_token|signing_secret|session_cookie|refresh|api_key)=)[^\s;&"'),\]]+/gi
const BARE_SECRET = /\b(?:oma_|sk-|sk_)[A-Za-z0-9._-]{8,}\b/g

function scrubber(secrets = []) {
  const list = secrets.filter((value) => typeof value === "string" && value.length >= 8)
  return (message) => {
    let text = String(message ?? "")
    for (const secret of list) text = text.split(secret).join("<redacted>")
    text = text.replace(SECRET_FIELD, "$1$2<redacted>")
    return text.replace(BARE_SECRET, "<redacted>")
  }
}

// ── 写锁：一次只让一个自动开通做「读 → 判键 → 写 → 回读」────────────────
//
// 为什么需要：SSO 可以并行（两个百智云账号各起各的浏览器），但**写**不能。
// 两个不同 cookie 同时从空库开通时，若两边都先读到「裸键 `monkeycode` 空着」，
// 后写的那次会把先写的那条**整条替换**掉（宿主是整体替换）—— 用户会看到
// 「开了两个号，只有一个在」。同 cookie 的单飞管不到这种跨 cookie 的情形。
//
// 队列是模块级的：同一进程里所有自动开通都排这一条队。代价只有几十毫秒的文件 IO，
// 换来的是「判键时看到的库，就是写的时候那个库」。
let writeQueue = Promise.resolve()

/**
 * 排队做一次写事务。
 *
 * ⚠ 前一个任务**失败（reject）不得毒化队列**：它的错误只交给它自己的调用方，
 * 队列照常往下走。否则一次写失败会让之后所有自动开通瞬间全部失败，而且再也恢复不了。
 */
function withWriteLock(run) {
  const mine = writeQueue.then(() => run(), () => run())
  // 队尾永远是一条「已办结」的 promise：成功失败都不往下传。
  writeQueue = mine.then(
    () => {},
    () => {},
  )
  return mine
}

async function attempt({ client, cookie, inviteCode, signal, sso, identity, authFile, ledger, log }) {
  const scrub = scrubber([cookie])

  // ── 一次 SSO：换出 MonkeyCode 账号 ──────────────────────────────────
  let signed
  try {
    signed = await sso(cookie, TARGET, { inviteCode })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log?.(scrub(`自动开通失败：SSO 没换出账号（${message}）`))
    // 返回值也脱敏：调用方多半会把它写进日志（`result.error`）。
    return { ok: false, error: scrub(message) }
  }

  const credential = signed?.credential
  const secretScrub = scrubber([cookie, credential?.access_token, credential?.signing_secret, credential?.session_cookie])

  // 取消要看得见：用户在 magpie 里取消了这次登录，后台不许再留副作用。
  if (signal?.aborted) return { ok: false, skipped: "aborted" }
  // 凭据不完整就不写：缺 signing_secret 写进去 = 每个请求 403，比不写更难查。
  if (!usableCredential(credential)) return { ok: false, skipped: "unusable-credential" }

  const uid = String(signed?.userId ?? "").trim()

  // 首次读预检：`uid` 空 / 库读不出来这种「注定不写」的情形先快速退回，不去占写锁。
  const precheck = decideProvision({ store: readProvisionedAccounts(PROVIDER, authFile), uid })
  if (precheck.skip) return { ok: false, skipped: precheck.skip }

  // ── 临界区：「第二次读 → 判键 → 写 → 回读」必须原子地做完 ──────────────
  //
  // 预检那次读只用来快速失败；真正决定写哪个键的，是**这里**重新读到的库。
  // 两个不同 cookie 并发时，后进队列的那个会看到前一个写下的记录，于是它拿走
  // 自己的 `monkeycode#<sha8(uid)>` 键，而不是把对方的裸键覆盖掉。
  return await withWriteLock(async () => {
    if (signal?.aborted) return { ok: false, skipped: "aborted" }

    const store = readProvisionedAccounts(PROVIDER, authFile)
    const decision = decideProvision({ store, uid })
    if (decision.skip) return { ok: false, skipped: decision.skip }

    // 宿主只给这一个出口，形状必须是 {path:{id}, body}。
    const body = monkeycodeRecord({ credential, accountId: signed?.nickname ?? "", uid })
    try {
      await client.auth.set({ path: { id: decision.key }, body })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log?.(secretScrub(`自动开通失败：写入记录时出错（${message}）`))
      return { ok: false, error: secretScrub(message) }
    }

    // 回读：`{data:true}` 不代表写成功（docs §1.2-F）────────────────────
    if (!verifyWritten(readProvisionedAccounts(PROVIDER, authFile), decision.key, body)) {
      log?.(secretScrub("自动开通失败：写完回读不到这次的记录（宿主没落盘，或还留着旧凭据）"))
      return { ok: false, error: "记录没有出现在账号库里" }
    }

    // 台账：已经写进去了，台账失败**不能**推翻这个结论 ──────────────────
    // 也放在临界区里：`markImported` 是「读-改-写」一个 JSON 文件，两个账号同时
    // 登记会互相覆盖（少记一个号 = 手动路径会把它再导一遍）。
    if (typeof identity === "string" && identity.length > 0 && typeof ledger === "function") {
      try {
        await ledger(identity)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log?.(secretScrub(`已开通，但「已导入」台账没写成（${message}）`))
      }
    }
    return { ok: true, key: decision.key }
  })
}

/**
 * 自动开通：用一条百智云会话写出国内 MonkeyCode 账号。
 *
 * @param {object} options
 * @param {object} options.client magpie 给插件的 client（要 `client.auth.set`）
 * @param {string} options.cookie 百智云会话串（`sl-session=…; baizhi_session=…`）
 * @param {Function} options.sso **必须注入**：`(cookie, site, {inviteCode}) => {credential, nickname, userId}`。
 *   本文件不起浏览器 —— 那条路在 `src/monkeycode/sso-import.mjs`。
 * @param {string} [options.inviteCode] 国内站邀请码（与手动路径**同一个策略值**，原样透传）
 * @param {AbortSignal} [options.signal] magpie 取消这次登录时给的那个
 * @param {string} [options.identity] 百智云账号身份（写台账用；空 = 不写台账）
 * @param {string} [options.authFile] 账号库路径（默认 magpie 的；单测传临时文件）
 * @param {Function} [options.markImported] 台账写入（默认 `sso-import.mjs` 导出的那个）
 * @param {(message: string) => void} [options.log] 一行说明（**已脱敏**，不含会话 / 凭据）
 * @returns {Promise<{ ok: true, key: string } | { ok: false, skipped?: string, error?: string }>}
 *   失败**不抛**：调用方（百智云登录收尾）fire-and-forget 地跑它。
 */
export async function provisionMonkeyCode(options = {}) {
  const { client, cookie, sso } = options

  // 测试门闩：单测 / 无窗环境一律不跑（`MAGPIE_PLUGIN_DISABLE_BROWSER=1`）。
  if (process.env.MAGPIE_PLUGIN_DISABLE_BROWSER === "1") return { ok: false, skipped: "test-latch" }
  if (typeof client?.auth?.set !== "function") return { ok: false, skipped: "no-client" }
  // SSO 必须由调用方注入：自动路径绝不自己起浏览器。
  if (typeof sso !== "function") return { ok: false, skipped: "no-sso" }
  if (options.signal?.aborted) return { ok: false, skipped: "aborted" }

  // 单飞：同一份会话并发（用户连点两次）只换一次号，两个调用**共享同一个结果**。
  const fingerprint = fingerprintOf(cookie)
  const running = inFlight.get(fingerprint)
  if (running) return running

  const task = attempt({
    ...options,
    ledger: options.markImported ?? markImportedInLedger,
  })
  inFlight.set(fingerprint, task)
  try {
    return await task
  } catch (error) {
    // 兜底：`attempt` 已经把每条失败都结构化返回了，走到这里只能是意料之外的错。
    // ⚠ 这里也必须脱敏 —— 抛上来的东西同样可能是「带着凭据的错误信息」。
    const message = error instanceof Error ? error.message : String(error)
    const safe = scrubber([options.cookie])(message)
    options.log?.(safe)
    return { ok: false, error: safe }
  } finally {
    // 只在还是自己那一份时清：避免把后来者的闸删掉。
    if (inFlight.get(fingerprint) === task) inFlight.delete(fingerprint)
  }
}
