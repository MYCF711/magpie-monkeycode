# 0.2.42 本机安装与热升级复核

日期：2026-11-09

## 安装范围

- 执行 `magpie plugin add .`，将 `<WORKSPACE>/magpie-monkeycode` 安装为本机插件。
- 三个 provider 均由这份本地目录服务；原有 GitHub 安装源保留作回滚，不删除账号。
- 回滚：`magpie plugin add https://github.com/MYCF711/magpie-monkeycode`。
- 未重启 DSH，未提交、未推送、未发布。

## 首次安装发现与修复

第一次热安装后，登录入口已更新，但宿主仍列出 13 条国内站模型及旧「基础档」名称。根因是旧 `provider.models` 被合并回新目录。

修复：`src/monkeycode/runtime.mjs` 的 `config` 与 `provider.models` 都改为用 `configModels(site)` 整体替换旧目录，不再双向合并。新增国内站 / 国际站 × 缓存 / 内置目录共 4 条升级回归，覆盖旧 13 条加 stale 模型不得复活。

## 实际加载证据

重装后读取 `magpie plugin list --json`：

| provider | 登录入口数 | 模型数 | 状态 |
|---|---:|---:|---|
| `monkeycode` | 1 | **11 个唯一 id（5 条每日额度、6 条积分）** | 已登录 |
| `baizhi` | 2 | 15 | 已登录 |
| `monkeycodeintl` | 4 | 2 | 已登录 |

国内站没有 `Legacy`、`Stale` 或「基础档 / 专业档 / 旗舰档」旧名称。网关 `GET http://127.0.0.1:3425/v1/models` 返回 **200**。

## 测试与审核

- 实现方全量测试：**337 / 337 / 0**。
- 独立只读审核：目标测试 **66 / 66 / 0**；`node scripts/check.mjs` **49 / 0 / 0**；`git diff --check` 通过。
- 审核范围：`src/monkeycode/runtime.mjs` 两处整体替换、4 条升级测试、国内 / 国际缓存隔离、内置目录兜底，以及实际安装后的 JSON。
- 独立审核结论：**PASS，blocker 0 / high 0**。未修改文件、未读取凭证。

## 留待用户真机试用

- 百智云登录 / 导入后，国内 MonkeyCode 的 `client.auth.set` 自动写入与卡片出现。
- 五种百智云上游登录方式及邀请关系真实消费。
- 国际站真机回归。

以上未验项不写成已通过；用户明确确认试用无问题后才提交、推送。
