# 更新链不依赖站点：发现、修复与真机结论（2026-09-22）

本文件记录一次"站点没上线会不会影响使用"的追问结果，以及随之修掉的两处真实缺陷。

## 起点：三处事实（都可回查）

1. **应用自带的更新 feed 指向 CDN 镜像**：`electron-builder.yml` 的 `publish: { provider: generic, url: https://statics.zerolink.com/purescience/app/stable }` 会被写成安装包的 `app-update.yml`，electron-updater 就从这个地址取 `latest*.yml`。
2. **发布该镜像的工作流从未运行过**：`gh api repos/naiyixi/PureScience/actions/workflows/mirror-to-website.yml/runs` → `total_count: 0`（手动 dispatch 的 job，仓库里没有任何一次派发记录）。
3. **应用内的"更新说明"取 GitHub 上的 manifest**：`src/shared/app-config.ts` 的 `APP.update.manifestUrl` = `https://github.com/naiyixi/PureScience/releases/latest/download/version.json`；该资产在修复前的 `notes` 是占位串 `See the release notes on GitHub.`（32 字符）。

⇒ 结论：安装版用户既**收不到更新提示**（feed 不可达），**也看不到更新内容**（notes 是占位串）。根因并非站点未部署这一件事：notes 那个占位串来自生成器把字段写死——`scripts/generate-version-manifest.mjs` 里 `extractHighlights`（就是为"把发布正文压成更新说明"而存在的函数）**从未接到 CLI 上**。

## 修复一：manifest 的 notes 来自 CHANGELOG（脚本侧）

`generate-version-manifest.mjs` 新增 `manifestNotes(version)`：用 `release-notes.mjs` 已导出的 `extractChangelogSection` 取该版 CHANGELOG 条目，丢掉条目标题行后作为 `notes`；只有"版本未知"或"CHANGELOG 读不到"时才回落到 GitHub 外链占位串。发布页与更新对话框从此同源，不可能各说各话。4 条新测试（含一条直接读仓库自身 CHANGELOG，断言拿到的是真条目、不是占位串、不是标题）。

## 修复二：feed 不可达时改走 GitHub（应用侧）

`ElectronUpdaterStrategy.check()` 在配置的 feed 失败后**改走 GitHub Releases feed 重试一次**（`provider: github` + `owner/repo` 取自 `APP`）——同一批产物本就发布在 GitHub Releases，镜像只是加速器，不该是单点。

- 重试失败时**保留第一次的错误**（它点名的才是这台机器实际配置的 feed）。
- 应用**根本没有 feed** 时不重试（未打包构建是"构建状态"而非"feed 不可达"），避免用一条无用网络往返换掉一条准确的报错。
- 同一 strategy 生命周期内只重试一次；成功时往诊断日志写一条 `update: configured feed unreachable, retried on the GitHub feed`。
- 4 条新测试：重试成功→`available`、默认接缝传给 electron-updater 的 provider 配置、两路都失败→保留原错误、dev 无 feed→不重试。

## 证据一（真机，应用侧）：更新说明真的读到了真内容

隔离实例（`PURESCIENCE_WEB_PORT=44156`、`PURESCIENCE_STORAGE_ROOT=/tmp/ps-upd-root`、CDP `9226`，未碰用户的 44100 与已安装应用），把 `package.json` 版本临时钉到 `1.67.0` 让应用"看到"可供更新，然后真发一次检查：

```json
{ "found": "api", "beforeState": "available", "current": "1.67.0", "latest": "1.68.0",
  "state": "available", "error": null, "notesType": "string", "notesChars": 1533,
  "notesHead": "**`.science` 会话包开始携带文献库的 PDF——并且这一半是真机验证过才敢说的**\n\n- 包原本只带会话引用的引文，论文本身留在原地。现在文献库的 PDF 以 `references/…` 随包同行……" }
```

修复前同一次调用拿到的是 32 字符的占位串。取证后 `package.json` 已还原（`git checkout --`），工作区只留四处目标改动。

**限制具名**：macOS 未打包 dev 走的是 manifest 流（`UpdateService`），所以上面对应的是"应用侧 notes 路径"；`ElectronUpdaterStrategy`（in-place 流）在未打包/未签名时不会被选中，它的真机复验只能在打包版上做——本批只到"4 条单测 + electron-updater 真实暴露 `setFeedURL(options: PublishConfiguration | AllPublishOptions | string): void`（`node_modules/electron-updater/out/AppUpdater.d.ts:164`）"这一层，不冒充真机通过。

## 证据二（线上资产）：在装的用户能看到真说明

已发布的 `v1.68.0` 的 `version.json` 资产按新规则重传（`notes` 32 → 1,533 字符），**downloads 映射（url/size/sha256）在重传前后逐字相同**（`mac-arm64.sha256 = af0bda7ad53557f9…`，脚本内置"downloads 变了就拒绝写"断言）。复核（两个入口都查）：

```
releases/download/v1.68.0/version.json        -> notes 1533 chars | downloads 4 | mac-arm64 sha256 af0bda7ad535
releases/latest/download/version.json         -> notes 1533 chars | downloads 4 | mac-arm64 sha256 af0bda7ad535
```

资产数仍为 **19**（首次上传把文件名带进去了，生成了多余资产 `version-1.68.0-notes.json`，已删除后按 `version.json` 正确重传）。

## 顺带发现（未修，属站点线）：镜像工作流的调用接口与脚本不符

`mirror-to-website.yml` 的"Generate version.json"步骤用 **环境变量** 调用脚本（`DIST_DIR`/`OUTPUT`/`VERSION`/`CDN_BASE_URL`/`S3_PREFIX`/`NOTES`/`RELEASE_DATE`，并从发布正文取 `NOTES`），而 `generate-version-manifest.mjs` 只实现**位置参数** CLI（`<dir> [version] [--github]`，无 `process.env` 分支）⇒ 该步骤按现状会以 `usage:` 报错退出。也就是说：即便 DNS 就绪，镜像 job 也需要先消掉这处接口错配（脚本侧补 env 模式，或改工作流——工作流是受保护控制面）。本批**没有**动这条线。

## 仍然成立的前提

站点/下载页 + DNS 由用户处理；本批之后，**"检查更新"与"更新说明"都不再依赖它**。已安装用户若仍拿不到 in-app 提示，唯一剩下的变量是"这台机器上运行的版本是否已含修复二"（v1.68.0 不含），下一次发版后自然闭环。
