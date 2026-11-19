# 排期现状核对（2026-11-18 17:4x，执行器）

核对对象：`docs/plan-2026-11-18-capability-gap-roadmap.md`（v3.0–v3.4，提交 `b1a8f560`）。
目的是**动手前先把「缺口」核一遍**：排期表里的「无」有一半是写表时没搜、或只搜了一个根。
本文只做读码/读档核对与下一单元定型，不含运行读数（原因见 §五）。

## 〇 开工核对（防重做 + 并发 + 该谁做）

- `HEAD == origin/main == 62cbd0e4`，本地无领先；B 段（A7 / S3 / M2）仍无可做项。
- 共享工作树带 10 个在制路径，**全部属并发写入者**，一个字节没碰：
  `src/main/ro-crate/import(.test).ts`、`src/shared/ro-crate(.test).ts`、`src/shared/background-delivery-labels(.test).ts`、
  `src/shared/input-precheck(.test).ts`、`src/renderer/src/stores/session-store-run-output-helpers(.test).ts`、
  `docs/evidence/` 5 份未跟踪档（含 `2026-11-18-ro-crate-third-party-read.md`）。
- 写入者此刻在跑：上述文件 17:21–17:24 落盘、一个 `tsc --noEmit -p tsconfig.node.json` 进程、
  dev 实例占 44100（已 2h47m）、校验实例 `--user-data-dir=/tmp/ps-verify10` 占 9333。
- 机器读数（17:31 / 17:33 现取）：PhysMem **7,407 MB used / 211 MB unused**，compressor 2,819 MB，
  swap **13.6 GB / 14.3 GB used**，load **8.9 – 13.9** ⇒ **本轮不跑构建、不跑单测**：
  在换页到这个程度时起 `build:e2e` 或全量 vitest，会把用户正在用的那两条 Electron 实例一起拖死。
- CI（现取，`gh run list`）：`3f2bcbdc` **双车道已绿** —— Nightly run `44257704805` success、
  Windows Full Test run `44257704794` success ⇒ 上一轮记的「本版无 Nightly 判决」到此结案。
  `52061a0c`：Windows Full Test run `44269835077` success、Nightly run `44269834690` in_progress（无判决，不预判）。

## 一 方法（搜过什么就是结论的一部分）

按「域词 × 四个根」搜，不按 API 形状搜。根：`src/main`、`src/shared`、`src/renderer`、`src/preload`，
另加 `cli/`、`e2e/`、`scripts/`。域词（中英各试）：`cnki`、`wanfang` / `万方`、`维普`、`超星`、`noteexpress`、
`ris`、`halves`、`mcp`、`literature`、`rollback`、`previous`、`replay`、`reproduc`、
`creators` / `license` / `publisher`、`interrupted` / `stopped` / `failStreaming`。
下文每条都写命中文件:行；判「无」的条目同时写清搜过的词与根。

## 二 逐行核对

| 单元                  | 排期写的现状                                               | 仓内核对（证据）                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 判决                                                                                               |
| --------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 0.1 中文查询匹配      | 已在 `a26a9a78` 补「两半都在」                             | `src/shared/global-search.ts:132`（三档 `literal/segmented/halves`）、`:286-288`（`matched-by-halves` 备注）、`:465-469`（切点全试、两字不切）；判据本身已进门禁：`src/shared/global-search-cjk-bench.test.ts`（`3edc153b`，400 逐字 / 300 换序 / 300 负例三条召回阈值 + 100 条延迟；2026-11-19 起延迟那一项改为**读数**，门禁换成「切分数量随字长线性」的确定性门 —— 见 `docs/evidence/2026-11-19-cjk-bench-gate.md`）                                                                                                                                                                                 | **已交付**，不需另开工。排期该行判据已可从「待做」改为「仓内门禁」                                 |
| 0.2 CNKI 在线适配     | 无                                                         | `git grep -il 'cnki' src` 只命中 `src/shared/citation/ris-import.ts:2`（离线 RIS 解析）、9 份 i18n、`ReferencesLibraryDialog.render.test.tsx` ⇒ **没有任何在线检索接口**                                                                                                                                                                                                                                                                                                    | 准确；属外部阻塞（机构订阅接口），不动                                                             |
| 0.3 万方/维普/超星    | 无                                                         | 解析已交付：`src/shared/citation/ris-import.ts`（312 行，四种方言，`4a3cd4ff`）+ 接进文献库：`src/shared/ris-import-plan.ts`（156 行，按内容判 RIS/Zotero，零新通道）。缺的只是**真实机构导出文件**那一次验收                                                                                                                                                                                                                                                               | **「无」是过时读数**：能力半边已在仓里，剩下的是素材（用户侧）                                     |
| 0.4 中文专家包        | 12 位已发布验签 / 应用内 5 位跑通 / 新缺陷「中断半截落库」 | 12 位与 5 位见 `docs/verification/2026-11-18-specialist-marketplace-install.md`。新缺陷**根因未定**：同一档 §十 自己写明两种可能（落库标成 complete / 模型在连续工具失败后自己写坏）现有证据区分不了，并给了复现条件（稳定网络重跑）；代码侧 `failStreamingMessages()` 确实存在且在失败通路上生效（`src/renderer/src/stores/session-store-run-terminal-helpers.ts:97,213,264,295`）                                                                                         | 该行动作**不能**写成「修中断落库状态」：没有复现就没有修法。应写「待稳定网络复现后立案」           |
| 1.1–1.4 外部 MCP 五件 | 无                                                         | 机制已有：`src/main/acp/mcp-http-host.ts`（127.0.0.1、随机端口、Bearer token、`/mcp/<kind>/<sessionId>`、无状态重建），14 个 server builder 全在（artifacts / notebook / skills / plan / host_query / memory / context_summary / routine / goal / endpoint / annotation / pdf / knowledge / figure）。**缺的是外部入口**（用户可见 token/端口/清单 + 文档）与 **literature 专属 server**：`git grep -ln literature src/main/knowledge src/main/acp/mcp-http-host.ts` 零命中 | **量级更正**：不是「从零做五件」；1.1 的真实工作量 ≈ 一个 literature server builder + 一个外部入口 |
| 1.5 SDK               | 仅 CLI                                                     | `cli/index.mjs` 存在，无 TS 包                                                                                                                                                                                                                                                                                                                                                                                                                                              | 准确                                                                                               |
| 3.1 Windows 真机      | 无实机                                                     | 本机 macOS；`gh run list` 的 Windows 车道是 GitHub runner，不是产品真机                                                                                                                                                                                                                                                                                                                                                                                                     | 阻塞（等一台 Windows 机）                                                                          |
| 3.2 安装诊断闭环      | 已有失败点名 + 一键重装                                    | `src/main/settings/runtime-failure-diagnosis.ts:1-9`（把「装坏了请重装」拆成三种具名原因）；面板修复入口在 `src/main/settings/service.ts:1047` 附近                                                                                                                                                                                                                                                                                                                         | 实现半边在；判据要 Windows 真机 ⇒ 与 3.1 同阻塞                                                    |
| 3.3 升级回滚          | 更新失败可退回上一版                                       | **无**：`src/main/update/` 只有 downloader / strategy / service / scheduler / manifest；`git grep -n rollback src/main/update` 零命中，`previous` 命中的是同一进程内上一次下载与差分下载基线（`cache-maintenance.ts:27`、`electron-updater-strategy.ts:450-462`）                                                                                                                                                                                                           | 真缺口；判据（断网/坏包各退回一次）需真机                                                          |
| 4.1 隔离重放          | `artifacts/reproducibility-service.ts` 已有                | replay port / plan 在 `src/main/artifacts/reproducibility-service.ts:62-75`；**环境快照与依赖锁定无**：`git grep -ln 'environmentSnapshot\|envSnapshot\|dependencyLock\|lockfile' src/main/artifacts src/shared` 零命中                                                                                                                                                                                                                                                     | 真缺口；判据「干净机器重放成功」需第二台环境                                                       |
| 4.2 外部读校验        | 我方实现有校验规则                                         | 证据档 `docs/evidence/2026-11-18-ro-crate-third-party-read.md`（593 实体 / 278 文件 / 校验和全对 / 引用零悬空）**目前仍是未跟踪文件**，在别人在制里                                                                                                                                                                                                                                                                                                                         | 结论成立，但**引用前要先等它提交**                                                                 |
| 4.3 作者与许可        | 排期已单列，未开工                                         | 写入器早已支持：`src/main/ro-crate/export.ts:216-223`（`creators`/`license`/`publisher` 可选入参）、`:278-280`（空就不写）、`src/shared/ro-crate.ts:127-134`（`RoCrateBuildInput` 同三个字段）。缺口只在两处：`src/main/ro-crate/ipc.ts:196-209` 只传项目名与描述；设置没有这两个字段                                                                                                                                                                                       | 缺口确实存在，且**比排期估计更小**（写入器与「没设过就不写」都已就绪）                             |

## 三 需要就地更正的三行

1. **0.3**：把「无」改成「解析与接入已交付（`4a3cd4ff` + `ris-import-plan.ts`），缺真实机构导出文件验收」。
2. **0.4**：把「修中断落库状态」改成「待稳定网络复现后立案」——现有证据区分不了两种成因，照「修」去写代码就是猜。
3. **1.1**：把「无」改成「server builder 与 HTTP 宿主已在（14 个 builder + `mcp-http-host.ts`），缺外部入口与 literature server」。

## 四 下一单元定型（v3.4 4.3，四列齐）

| 列       | 内容                                                                                                                                                                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 现状读数 | 写入器就绪（`export.ts:216-223`、`278-280`）；导出处理器只传 `projectName`/`description`（`ipc.ts:196-209`）；设置里没有「作者/机构」「默认导出许可」（`src/main/settings/types.ts` 291 行内无相关字段）；9 份语言文件无对应键                                             |
| 修法     | ① 设置加两个可选字段（作者或机构名、默认许可标识），空即不写；② 导出时把两个字段投成 `creators`（`{type:'Person'\|'Organization', id, name}`）与 `license`（`{id,name}`），**不新增通道**；③ 设置面板两栏 + 9 语键；④ 单测钉「没设过就不写」「改设置后下一次导出逐字反映」 |
| 验收判据 | 设过之后导出的包被两个独立第三方读者读出**非空** `author`/`license`；没设过时两个字段**一个都不出现**（不写空串、不猜默认值）；改设置后下一次导出逐字反映                                                                                                                  |
| 边界     | 不做机构名录/许可目录的自动补全（仓里没有任何真实来源，编一个就是造数据）；不把「谁在用这台机器」当成作者（那是猜）                                                                                                                                                        |

**冲突面（开工前置判断，三条任一不干净就不开工）**：

- `src/shared/ro-crate.ts` —— 并发写入者此刻正在改；本单元只读它的类型，不改它。
- `src/renderer/src/pages/settings/SettingsPage.tsx` 与 `src/renderer/src/i18n/*.ts` —— 两个共享热点。
- 验收要真机（设置页填值 → 导出 → 第三方读），需要 `build:e2e` + 独立实例 ⇒ 必须等 dev 实例退出、且机器空闲页回到可用量级。

## 五 本轮的边界（不许读成更强）

1. 本文所有结论都是**读码 / 读档**结论：本轮因负载闸没有跑任何构建与单测，也没有起实例。
   引用的运行读数分两类：别人留下的证据档（注明出处）与 CI 的现取读数（run id 已写）。
2. 本轮**没有开工新代码单元**：0.4 的落点（`session-store-run-terminal-helpers.ts` 与 `run-output-helpers`）
   正是并发写入者此刻在改的目录；4.3 要动两个共享热点 + 真机验收。硬挤进共享树只会产出半成品。
3. 4.2 的证据档未跟踪这件事按「引用前先等提交」处理，不改写排期里的结论。
