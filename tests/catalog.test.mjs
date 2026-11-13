// 单测不许读开发机上的真实账号缓存（可能是「探测后全不可用 ⇒ 空表」）。
process.env.MAGPIE_MONKEYCODE_CACHE_DIR = "C:\__magpie_test_cache__"
// MonkeyCode 平台目录：UUID 才是请求体里的 model，内置名字早过时了。
import test from "node:test"
import assert from "node:assert/strict"

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { entryOf, fetchCatalog } from "../src/monkeycode/catalog.mjs"

const site = { id: "monkeycode", platformBaseUrl: "https://monkeycode-ai.com", gatewayBaseUrl: "https://proxy.monkeycode-ai.com/v1" }

test("entryOf：UUID 进 apiId，model 名压成 slug；隐藏与 OpenAI 协议的被跳过", () => {
  const entry = entryOf({
    id: "8ca0c30e-08ac-42d5-a4db-584d52fabe98",
    model: "monkeycode-pro/hy3",
    context_limit: 200000,
    output_limit: 32000,
    support_image: true,
    interface_type: "anthropic",
    is_hidden: false,
  })
  assert.equal(entry.id, "monkeycode-pro-hy3", "斜杠必须压平，否则 magpie 拆出幽灵供应商")
  // 实测：同一个模型传 UUID 回 403、传 model 名回 200 —— 请求体里的 model 是后者。
  assert.equal(entry.apiId, "monkeycode-pro/hy3", "请求体里的 model 是平台 model 名（带档位前缀）")
  assert.equal(entry.uuid, "8ca0c30e-08ac-42d5-a4db-584d52fabe98", "UUID 留着做区分，但不用于请求")
  assert.equal(entry.context, 1048576, "按 1M 报（平台标的 200K 是软配置）")
  assert.equal(entry.image, true)
  assert.equal(entryOf({ id: "x", model: "y", interface_type: "openai_responses" }), undefined)
  assert.equal(entryOf({ model: "y" }), undefined, "没有 id 的条目不能用")
})

test("fetchCatalog 用 cookie 认证，过滤隐藏模型并去重", async () => {
  let seenCookie = ""
  const result = await fetchCatalog("sl-session=a; baizhi_session=b", site, {
    fetchImpl: async (url, init) => {
      seenCookie = init.headers.cookie
      assert.equal(url, "https://monkeycode-ai.com/api/v1/users/models")
      return Response.json({
        data: [
          { id: "u1", model: "a/b", is_hidden: false, interface_type: "anthropic", context_limit: 200000 },
          { id: "u2", model: "a/b", is_hidden: false, interface_type: "anthropic" },
          { id: "u3", model: "hidden-one", is_hidden: true, interface_type: "anthropic" },
          { id: "u4", model: "resp", interface_type: "openai_responses" },
        ],
      })
    },
  })
  assert.match(seenCookie, /baizhi_session=b/)
  assert.equal(result.models.length, 1, "隐藏的、重复的都只剩一条")
  assert.equal(result.models[0].apiId, "a/b", "apiId 是 model 名")
})

test("fetchCatalog：平台没有可用模型时报失败，不返回空表", async () => {
  const result = await fetchCatalog("c", site, { fetchImpl: async () => Response.json({ data: [] }) })
  assert.equal(result.ok, false)
})

test("prettyModelName：basic 标「免费」，pro / ultra 标「每日额度」，无前缀标「积分」", async () => {
  const { entryOf, prettyModelName } = await import("../src/monkeycode/catalog.mjs")
  // 2026-11-13 平台口径变更：基础会员「永久免费、不赠送额度」
  // （官方前端 `dailyQuotaBasic: "不赠送额度"`，模型选择器里 basic 模型标「免费使用」），
  // 所以 basic 前缀不能再标「每日额度」；只有 pro / ultra 吃日额度。
  assert.equal(prettyModelName("monkeycode-basic/glm-5.3-flash"), "GLM-5.3-Flash · 免费")
  assert.equal(prettyModelName("monkeycode-pro/hy3"), "HY3 · 每日额度")
  assert.equal(prettyModelName("monkeycode-ultra/qwen3.7-max"), "Qwen3.7-Max · 每日额度")
  // 无前缀 = 官方「付费模型 / 消耗积分使用」分组，直接扣积分（同上 A7）。
  assert.equal(prettyModelName("qwen3.6-plus"), "Qwen3.6-Plus · 积分")
  assert.equal(prettyModelName("minimax-m2.5"), "MiniMax-M2.5 · 积分")
  assert.equal(prettyModelName("deepseek-flash"), "DeepSeek-Flash · 积分")
  assert.equal(prettyModelName(""), "")
  // 缓存条目上的 displayName 是同一套口径（读缓存时算出来的那个字段，用户看到的就是它）。
  const entry = entryOf({ id: "u1", model: "monkeycode-basic/deepseek-flash", interface_type: "anthropic" })
  assert.equal(entry.displayName, "DeepSeek-Flash · 免费")
})

test("probeCatalog：只有 200 才算能用，403/异常一律不可用", async () => {
  const { probeCatalog } = await import("../src/monkeycode/catalog.mjs")
  const credential = { access_token: "oma_x", signing_secret: "s".repeat(48) }
  const models = [{ apiId: "u1", id: "m1" }, { apiId: "u2", id: "m2" }, { apiId: "u3", id: "m3" }]
  const probed = await probeCatalog(credential, { gatewayBaseUrl: "https://gw.example/v1" }, models, {
    concurrency: 2,
    probe: async (cred, site, model) => model.apiId === "u2",
  })
  assert.deepEqual(probed.map((m) => m.usable), [false, true, false])
})

test("refreshCatalog 带 credential 时会把可用性探进去", async () => {
  const { probeCatalog } = await import("../src/monkeycode/catalog.mjs")
  assert.equal(typeof probeCatalog, "function")
})

test("签名 prompt：没有 system 的请求必须补 FALLBACK_SYSTEM（否则网关一律 403）", async () => {
  const { FALLBACK_SYSTEM, parseBodyQuietly, signingPrompt } = await import("../src/monkeycode/signing.mjs")
  assert.ok(FALLBACK_SYSTEM.length > 0)
  // 无 system 的请求：prompt 为空 —— 这就是网关回 invalid ohmyagent request 的原因。
  const bare = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] })
  assert.equal(signingPrompt(parseBodyQuietly(bare)), "")
  // 补上 system 之后就有东西可签了。
  const patched = JSON.stringify({ ...JSON.parse(bare), system: FALLBACK_SYSTEM })
  assert.equal(signingPrompt(parseBodyQuietly(patched)), FALLBACK_SYSTEM)
})

test("上下文窗口按 1M 报（平台标的 200K 是软配置，实测 500K 都能过）", async () => {
  const { entryOf, KNOWN_CONTEXT } = await import("../src/monkeycode/catalog.mjs")
  const raw = { id: "u", model: "m", context_limit: 200000, output_limit: 32000, interface_type: "anthropic" }
  // magpie 拿这个值决定 agent 何时压缩上下文：报 200K 就会在 200K 丢历史。
  assert.equal(entryOf(raw).context, 1048576)
  assert.equal(KNOWN_CONTEXT, 1048576)
  // 平台给得更大时不被压小。
  assert.equal(entryOf({ ...raw, context_limit: 2000000 }).context, 2000000)
})

test("签名 prompt：没有 system 的请求必须补 FALLBACK_SYSTEM（否则网关一律 403）", async () => {
  const { FALLBACK_SYSTEM, parseBodyQuietly, signingPrompt } = await import("../src/monkeycode/signing.mjs")
  assert.ok(FALLBACK_SYSTEM.length > 0)
  // 无 system 的请求：prompt 为空 —— 这就是网关回 invalid ohmyagent request 的原因。
  const bare = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] })
  assert.equal(signingPrompt(parseBodyQuietly(bare)), "")
  // 补上 system 之后就有东西可签了。
  const patched = JSON.stringify({ ...JSON.parse(bare), system: FALLBACK_SYSTEM })
  assert.equal(signingPrompt(parseBodyQuietly(patched)), FALLBACK_SYSTEM)
})

// ── 目录整改契约：档位收窄 + 去重（docs/monkeycode-model-billing.md §4.1-§4.3）──
//
// R1 同一 base 名（`apiId` 去掉 `^monkeycode-(basic|pro|ultra)/`）在**同一份目录**里既有
//    档位条目又有无前缀条目时，隐藏无前缀那条 —— 档位条目才是能力超集（日额度耗尽后
//    默认自动转积分，见文档 A1/A2/A7），无前缀那条只是「直接扣积分」的重复入口。
// R2 没有档位孪生的无前缀条目必须保留（它是这条模型唯一的入口）。
// R3 档位未知/非法时**完全不去重**（和「不收窄」同一原则：不做没有依据的判断）。
// ④ `MAGPIE_MONKEYCODE_SHOW_CREDIT_TWINS=1` 是逃生阀：只保留原来的档位权限过滤，
//    不再隐藏积分孪生（怀疑两池不是同一底层权重时用）。
//
// 顺序很关键：**先去重后收窄会让列表变空**（basic 账号只有 ultra 孪生时，无前缀那条是唯一能用的）。

const tierModels = () => [
  { id: "b", apiId: "monkeycode-basic/deepseek-flash" },
  { id: "p", apiId: "monkeycode-pro/deepseek-flash" },
  { id: "u", apiId: "monkeycode-ultra/deepseek-flash" },
  { id: "c", apiId: "deepseek-flash" }, // 无前缀孪生：直接扣积分
  { id: "g", apiId: "glm-5" },
]
// 权限语义单独用一份「每条模型各占一个 base」的目录，避免与去重搅在一起。
const permissionModels = () => [
  { id: "b", apiId: "monkeycode-basic/glm-5.3-flash" },
  { id: "p", apiId: "monkeycode-pro/hy3" },
  { id: "u", apiId: "monkeycode-ultra/qwen3.7-max" },
  { id: "c", apiId: "kimi-k2.6" },
]
const idsOf = (models) => models.map((model) => model.id)

test("filterByTier：档位权限（原有语义——够不着的高档前缀被挡）", async () => {
  const { filterByTier } = await import("../src/monkeycode/catalog.mjs")
  // 与官方前端 `Im()` 同规则：无前缀恒可用，pro 前缀要 pro 及以上，ultra 要做旗舰。
  assert.deepEqual(idsOf(filterByTier(permissionModels(), "basic")), ["b", "c"])
  assert.deepEqual(idsOf(filterByTier(permissionModels(), "pro")), ["b", "p", "c"])
  assert.deepEqual(idsOf(filterByTier(permissionModels(), "ultra")), ["b", "p", "u", "c"])
})

test("filterByTier ①：tier=basic 时同 base 的无前缀孪生被隐藏（只留档位条目与本模型）", async () => {
  const { filterByTier } = await import("../src/monkeycode/catalog.mjs")
  const models = [
    { id: "b", apiId: "monkeycode-basic/deepseek-flash" },
    { id: "c", apiId: "deepseek-flash" },
    { id: "g", apiId: "glm-5" },
  ]
  // `deepseek-flash` 与 `monkeycode-basic/deepseek-flash` 是同一底层模型的两个入口，
  // 档位那条在额度耗尽后会自己转积分 ⇒ 留档位那条（R1）。
  assert.deepEqual(idsOf(filterByTier(models, "basic")), ["b", "g"])
})

test("filterByTier ②：没有档位孪生的无前缀条目保留", async () => {
  const { filterByTier } = await import("../src/monkeycode/catalog.mjs")
  const models = [
    { id: "c", apiId: "qwen3.6-plus" },
    { id: "g", apiId: "glm-5" },
    { id: "b", apiId: "monkeycode-basic/deepseek-flash" }, // 孪生不存在 ⇒ 自己就是唯一入口
  ]
  assert.deepEqual(idsOf(filterByTier(models, "basic")), ["c", "g", "b"])
})

test("filterByTier ③：tier 未知 / 非法时完全不去重（也不收窄）", async () => {
  const { filterByTier } = await import("../src/monkeycode/catalog.mjs")
  const models = tierModels()
  const all = ["b", "p", "u", "c", "g"]
  assert.deepEqual(idsOf(filterByTier(models, undefined)), all)
  assert.deepEqual(idsOf(filterByTier(models, "free")), all, "不认识的档位名按「未知」处理")
  assert.deepEqual(idsOf(filterByTier(models, "")), all)
  assert.deepEqual(idsOf(filterByTier(models, "Ultra")), all, "大小写不同也算未知，别猜")
})

test("filterByTier ④：MAGPIE_MONKEYCODE_SHOW_CREDIT_TWINS=1 时不隐藏积分孪生", async () => {
  const { filterByTier } = await import("../src/monkeycode/catalog.mjs")
  const models = tierModels()
  const before = process.env.MAGPIE_MONKEYCODE_SHOW_CREDIT_TWINS
  process.env.MAGPIE_MONKEYCODE_SHOW_CREDIT_TWINS = "1"
  try {
    // 授权过滤照旧（basic 仍然吃不到 pro / ultra 前缀），只是不再隐藏无前缀孪生。
    assert.deepEqual(idsOf(filterByTier(models, "basic")), ["b", "c", "g"])
    // 档位未知本来就不过滤；逃生阀下更不该少任何一条。
    assert.deepEqual(idsOf(filterByTier(models, undefined)), ["b", "p", "u", "c", "g"])
  } finally {
    // 必须恢复：这个 env 是进程级的，泄漏会让后面的用例（以及整个仓库的其它测试文件）串味。
    if (before === undefined) delete process.env.MAGPIE_MONKEYCODE_SHOW_CREDIT_TWINS
    else process.env.MAGPIE_MONKEYCODE_SHOW_CREDIT_TWINS = before
    assert.equal(process.env.MAGPIE_MONKEYCODE_SHOW_CREDIT_TWINS, before)
  }
})

test("filterByTier ⑤：同 base 多个可用档位时保留最高档（pro > basic，ultra > pro）", async () => {
  const { filterByTier } = await import("../src/monkeycode/catalog.mjs")
  const two = [
    { id: "b", apiId: "monkeycode-basic/deepseek-flash" },
    { id: "p", apiId: "monkeycode-pro/deepseek-flash" },
  ]
  // pro 账号两条都够得着 ⇒ 只留 pro 那条；ultra 账号同理（pro 仍高于 basic）。
  assert.deepEqual(idsOf(filterByTier(two, "pro")), ["p"])
  assert.deepEqual(idsOf(filterByTier(two, "ultra")), ["p"])
  const three = [...two, { id: "u", apiId: "monkeycode-ultra/deepseek-flash" }]
  assert.deepEqual(idsOf(filterByTier(three, "ultra")), ["u"])
})

test("filterByTier ⑥：收窄 / 去重都不许把列表清空", async () => {
  const { filterByTier } = await import("../src/monkeycode/catalog.mjs")
  // 去重必须在收窄**之后**：basic 账号只有 ultra 孪生 + 无前缀两条，
  // 先按 base 去重就会把唯一能用的无前缀那条也删掉。
  const onlyUltraTwin = [
    { id: "u", apiId: "monkeycode-ultra/deepseek-flash" },
    { id: "c", apiId: "deepseek-flash" },
  ]
  assert.deepEqual(idsOf(filterByTier(onlyUltraTwin, "basic")), ["c"])
  // 收窄后为空（这个号只有 pro 前缀）→ 原样返回，宁可多列也不清空。
  const onlyPro = [{ id: "p", apiId: "monkeycode-pro/x" }]
  assert.deepEqual(idsOf(filterByTier(onlyPro, "basic")), ["p"])
  // 空输入就是空表（这不是清空，是本来就没有）。
  assert.deepEqual(filterByTier([], "basic"), [])
})

// ── 旧缓存的显示名重算（docs/final-review.md 的 M6：这条契约原先只有手测，没有测试）──
//
// 为什么值得写：`displayName` 是**落盘**的（`writeCatalog` 存进去的那份），而缓存要 6 小时
// 才过期。文案从「基础档/专业档/旗舰档」改成「每日额度」之后，老缓存如果不重算，用户会在
// 升级后最长 6 小时内一直看到旧标签 —— 而这条路径唯一能改的就是 `readCatalog()` 里的重算。
// 把它写成测试，才不会有人「为了少一次 map」把它删掉。
//
// 顺带锁三件事：① 重算只动 `displayName`，其它字段（uuid/context/output/image/free…）原样
// 保留；② 重算是**只读**的 —— 不许顺手把缓存文件改写（那会把「拉目录」的失败态写死）；
// ③ providerId 是参数：国内站的缓存不能在国际站里读出来。

/** 写一份「文案改版前」的缓存（displayName 还是旧标签），返回目录。 */
function writeLegacyCatalogDir() {
  const dir = mkdtempSync(join(tmpdir(), "magpie-catalog-legacy-"))
  const models = [
    {
      id: "monkeycode-basic-glm-5-3-flash",
      apiId: "monkeycode-basic/glm-5.3-flash",
      uuid: "11111111-1111-4111-8111-111111111111",
      name: "monkeycode-basic/glm-5.3-flash",
      displayName: "GLM-5.3-Flash · 基础档",
      context: 1048576,
      output: 32000,
      image: true,
      free: false,
    },
    {
      id: "monkeycode-pro-hy3",
      apiId: "monkeycode-pro/hy3",
      uuid: "22222222-2222-4222-8222-222222222222",
      name: "monkeycode-pro/hy3",
      displayName: "HY3 · 专业档",
      context: 1048576,
      output: 32000,
      image: false,
      free: false,
    },
    {
      id: "monkeycode-ultra-qwen3-7-max",
      apiId: "monkeycode-ultra/qwen3.7-max",
      uuid: "33333333-3333-4333-8333-333333333333",
      name: "monkeycode-ultra/qwen3.7-max",
      displayName: "Qwen3.7-Max · 旗舰档",
      context: 1048576,
      output: 32000,
      image: true,
      free: false,
    },
    {
      // 积分孪生：与下一条同 base，去重时该被隐藏。
      id: "deepseek-flash",
      apiId: "deepseek-flash",
      uuid: "44444444-4444-4444-8444-444444444444",
      name: "deepseek-flash",
      displayName: "DeepSeek-Flash · 积分",
      context: 1048576,
      output: 32000,
      image: true,
      free: false,
    },
    {
      id: "monkeycode-basic-deepseek-flash",
      apiId: "monkeycode-basic/deepseek-flash",
      uuid: "55555555-5555-4555-8555-555555555555",
      name: "monkeycode-basic/deepseek-flash",
      displayName: "DeepSeek-Flash · 基础档",
      context: 1048576,
      output: 32000,
      image: true,
      free: false,
    },
  ]
  writeFileSync(join(dir, "monkeycode-models-monkeycode.json"), `${JSON.stringify({ fetchedAt: 1, tier: "basic", models }, null, 2)}\n`)
  return { dir, models }
}

/** 在一份临时缓存目录下跑 fn，结束后恢复 env 并删目录（env 是进程级的，泄漏会串到别的用例）。 */
async function withCacheDir(fn) {
  const previous = process.env.MAGPIE_MONKEYCODE_CACHE_DIR
  const { dir, models } = writeLegacyCatalogDir()
  process.env.MAGPIE_MONKEYCODE_CACHE_DIR = dir
  try {
    await fn({ dir, models })
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_MONKEYCODE_CACHE_DIR
    else process.env.MAGPIE_MONKEYCODE_CACHE_DIR = previous
    rmSync(dir, { recursive: true, force: true })
    assert.equal(process.env.MAGPIE_MONKEYCODE_CACHE_DIR, previous, "必须恢复 MAGPIE_MONKEYCODE_CACHE_DIR")
  }
}

test("readCatalog ⑤：旧缓存的「基础档/专业档/旗舰档」读出即重算成「免费 / 每日额度」，且只读不改文件", async () => {
  const { readCatalog } = await import("../src/monkeycode/catalog.mjs")
  await withCacheDir(({ dir, models }) => {
    const file = join(dir, "monkeycode-models-monkeycode.json")
    const before = readFileSync(file, "utf8")

    const catalog = readCatalog("monkeycode")
    assert.ok(catalog, "缓存能读出来")
    assert.equal(catalog.fetchedAt, 1)
    assert.equal(catalog.tier, "basic", "落盘的档位要带回来（runtime 靠它收窄）")

    // basic 前缀 = 「免费」，pro / ultra 前缀 = 「每日额度」；无前缀继续「积分」。
    assert.deepEqual(
      catalog.models.map((model) => model.displayName),
      [
        "GLM-5.3-Flash · 免费",
        "HY3 · 每日额度",
        "Qwen3.7-Max · 每日额度",
        "DeepSeek-Flash · 积分",
        "DeepSeek-Flash · 免费",
      ],
    )
    // 除了 displayName，其它字段一个字都不许动（uuid 还要用来区分记录）。
    assert.deepEqual(
      catalog.models,
      models.map((model) => ({
        ...model,
        displayName: model.displayName
          .replace(/ · 基础档$/, " · 免费")
          .replace(/ · 专业档$/, " · 每日额度")
          .replace(/ · 旗舰档$/, " · 每日额度"),
      })),
    )
    // 只读：重算不许把缓存文件改写（写回会把「目录拉失败」的旧表钉死）。
    assert.equal(readFileSync(file, "utf8"), before, "readCatalog 不许改写缓存文件")
    // providerId 是参数：国内站的缓存不能在国际站里读出来。
    assert.equal(readCatalog("monkeycodeintl"), undefined, "别把国内站的目录串到国际站")
  })
})

test("readCatalog + filterByTier：重算后的目录照常去重（积分孪生隐藏；逃生阀下保留）", async () => {
  const { filterByTier, readCatalog } = await import("../src/monkeycode/catalog.mjs")
  await withCacheDir(({ dir, models }) => {
    const catalog = readCatalog("monkeycode")
    assert.ok(catalog)
    // runtime 的路径：读出 → filterByTier(缓存里的 tier)。pro/ultra 前缀被挡掉，
    // 同 base 的积分孪生（deepseek-flash）被隐藏，只留档位那条。
    const narrowed = filterByTier(catalog.models, catalog.tier)
    assert.deepEqual(idsOf(narrowed), ["monkeycode-basic-glm-5-3-flash", "monkeycode-basic-deepseek-flash"])
    // 留下来的那条也必须是重算过的名字（否则「去重对了、名字还是旧的」会漏网）。
    assert.equal(narrowed[1].displayName, "DeepSeek-Flash · 免费")

    // 逃生阀：只关去重，权限过滤照旧（basic 账号仍然看不到 pro / ultra）。
    const previousOptOut = process.env.MAGPIE_MONKEYCODE_SHOW_CREDIT_TWINS
    process.env.MAGPIE_MONKEYCODE_SHOW_CREDIT_TWINS = "1"
    try {
      const escaped = filterByTier(readCatalog("monkeycode").models, "basic")
      assert.deepEqual(
        idsOf(escaped),
        ["monkeycode-basic-glm-5-3-flash", "deepseek-flash", "monkeycode-basic-deepseek-flash"],
      )
      // 逃生阀下重算照样生效（改名与去重是两件事）。
      assert.equal(escaped.find((model) => model.id === "deepseek-flash").displayName, "DeepSeek-Flash · 积分")
      assert.equal(escaped.find((model) => model.id === "monkeycode-basic-deepseek-flash").displayName, "DeepSeek-Flash · 免费")
    } finally {
      if (previousOptOut === undefined) delete process.env.MAGPIE_MONKEYCODE_SHOW_CREDIT_TWINS
      else process.env.MAGPIE_MONKEYCODE_SHOW_CREDIT_TWINS = previousOptOut
    }

    // 去重是按「当前目录」算的，不是把缓存写小 —— 原文件仍有 5 条。
    const onDisk = JSON.parse(readFileSync(join(dir, "monkeycode-models-monkeycode.json"), "utf8"))
    assert.equal(onDisk.models.length, 5)
    assert.equal(models.length, 5, "夹具本身也是 5 条")
  })
})
