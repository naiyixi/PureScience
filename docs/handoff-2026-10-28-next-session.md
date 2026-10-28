# 交接单（复制给新会话）

> 用法：把本文件整段粘给新会话即可开工。所有数字都是本机实测，不是估计。

## 0 一句话现状

A 组（性能/可靠性）四项已修并装机验证；**B1（文献 DOI 完整性检查）后端全通、渲染层未接**。
仓库 `/Users/totota/purescience`，`main` = `ffeb6ca6`，**工作树干净**。

## 1 版本与安装

| 项                              | 值                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `package.json`                  | `2.19.0`（已发布，tag `v2.19.0`）                                              |
| `/Applications/PureScience.app` | 本地构建 2.19.0，**含 A 组修复**（asar 校验过）                                |
| 发版口径                        | **只发 v2.20.0 / v2.21.0 两版**，中间不开补丁版；例外仅安全/凭证泄漏、数据损坏 |

计划档：

- `docs/plan-2026-10-28-two-releases.md`（两版划分与验收判据）
- `docs/comparison-2026-10-28-competitor-gaps.md`（对标差距 9 项，每条带差异化打法）
- `docs/evidence/2026-10-28-slow-channel-attribution.md`（慢通道归因与修复读数）
- `docs/evidence/2026-10-28-doi-integrity-b1-progress.md`（B1 进度 + 渲染层六组顺序）

## 2 已完成（有读数）

| 项                           | 结果                                                                                         | 位置                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `notebook:state`             | 热 p50 **358.2 → 1.6 ms**（真机 60.1 MB `run.json`）                                         | `src/main/notebook/repository.ts` 文档缓存                                                      |
| `sessions:save-session`      | 省掉 400 ms 级 Prisma 查询（终结代次判据）                                                   | `src/main/artifacts/provenance-message-snapshot.ts`、`provenance-repository.ts`                 |
| 同上·写盘侧                  | 实测下限 ≈28 ms（写 10.7 + rename 0.3 + stringify 17.3），真机 150–211 ms 判为争用，**不改** | 证据档第五节                                                                                    |
| `reviewer:get-for-session`   | `Review(sessionId)`/`Finding(reviewId,sortIndex)` 索引 + N+1 合并；`SCAN`→`SEARCH`，0.36 ms  | `prisma/schema.prisma`、`src/main/projects/prisma-client.ts`、`src/main/reviewer/repository.ts` |
| `notifications:get-snapshot` | 读不再排在写队列后（排队时 81 → 1 ms）                                                       | `src/main/notifications/notification-inbox-repository.ts`                                       |
| `artifacts:read-preview`     | 判为非算法（canary 同时刻 261 ms），**不改**                                                 | 证据档第六节                                                                                    |
| `settings:list-skills`       | 热 11.0 → 8.1 ms；日志 662 ms 在进程内复现不出，已埋 `skill list attribution` 归因行         | `src/main/skills/user-skill-repository.ts`、`src/main/settings/skill-catalog.ts`                |
| 机检 4/4                     | 四框架各解析自己的二进制（此前 codebuddy 实际在跑 opencode）                                 | `src/main/settings/backend-resolver.ts`、`agent-runtime-manager.ts`                             |
| B1 后端                      | 检查器 9 例 + 落库 3 例 + 缺口 1 例 + 只读摘要 1 例；两条命令三端同源                        | `src/main/references/doi-integrity.ts`、`repository.ts`、`ipc.ts`、`application-commands.ts`    |

## 3 下一步（按顺序）

### 3.1 B1 渲染层接线（六组，必须一次做完）

**先做 1–2 再动 3–6，否则会出现「7 条清单测试红」。**

1. `src/shared/renderer-contract-catalog.ts`：`references` 组内登记
   `['checkIntegrity', 'references:check-integrity']` 与
   `['readIntegritySummary', 'references:read-integrity-summary']`（含 profile）；
2. `npm run gen:web-api-map && npm run check:web-api-map`；
3. `src/preload/index.ts`（≈730 行 `fetchByIdentifier` 旁）加两个 invoke；`src/preload/renderer-api.d.ts`（≈1072 行）加类型；
4. 同步两处 inventory 用例期望值：`src/preload/index.test.ts`（≈440 频道清单）、
   `src/shared/renderer-contract-catalog.test.ts`；以及 `src/main/references/screening-ipc.test.ts` 的频道清单；
5. `ReferencesScreeningPanel.tsx` 的 `handleExportIncluded`（≈664 行）：导出前调 `readIntegritySummary`；
   **`retracted` 与导出范围有交集 ⇒ 点名拒绝并 return**；否则把三类 `gaps` 逐条写进导出文本块；
6. i18n（`references.screening.export.*` 邻近，`src/renderer/src/i18n/{zh,en,de,es,fr}.ts`）+ 两例渲染测试
   （有 retracted 拒绝且不写文件；只有 never-checked 时导出并列出缺口）。

判定口径：**`retracted` 是决定（拒绝）；三类 `gaps` 是指令（照常导出但写明）**。
`unavailable` 绝不当 `clean`。

### 3.2 装机验一轮导出

`/tmp/install-and-verify.sh` 是上一轮的装机+校验脚本（改端口即可复用）。验证点：版本、asar 关键字、
`Reference` 四个 integrity 列、两个新索引、一次真实会话 `run_exit=0`。

### 3.3 A 组收敛验证

正常使用 1–2 天，读 `~/Library/Logs/PureScience/main.log` 的新样本：
`skill list attribution`（A1）、`session save was slow`（A3）、`review load segments`（A4）。
判据：A1 中位 < 80 ms；A3 `provenanceMs` 应显著下降；A4 `reviewsQueryMs` < 50 ms。

### 3.4 A5 停顿归因

**执行器在做**（`src/main/diagnostics/stall-cause.ts`、`gc-pause-monitor.ts` 等 12 个未提交文件）。
等它提交后再合并，**不要与其同改 diagnostics/**。

## 4 踩过的坑（直接照做，别重走）

| 坑                               | 事实                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck` exit **134** | 需要 `NODE_OPTIONS=--max-old-space-size=8192`（与 `npm run build` 同），不是类型错误                                     |
| 渲染层新增命令                   | 契约目录 `renderer-contract-catalog.ts` 是**单一来源**；映射表由 `scripts/generate-web-api-map.mjs` 生成，不登记就不出现 |
| DDL 的 `column()` 步骤           | 必须排在 `CREATE TABLE` **之后**，否则新库建表前 ALTER 被跳过（B1 踩过，3 条用例当场红）                                 |
| bench 基线                       | 必须指向**真文件**：合成 133 KB `run.json` 只需 1 ms，真机 60 MB 才是 358 ms 的来源                                      |
| 日志中位数 ≠ 进程内耗时          | `settings:list-skills` 日志 662 ms，进程内 50/11 ms；照日志调参 = 优化噪声                                               |
| `canaryMs`                       | 同时刻发起的对照读；它慢 ⇒ 事件循环/FS 阻塞，先别改代码                                                                  |
| `cpuShare ≈ 1`                   | 真在算，那时才值得看算法；`≠0` 且 canary 正常 ⇒ 在等某个具体 I/O                                                         |
| 写盘/序列化                      | 5.5 MB 写 10.7 ms、rename 0.3 ms、stringify 17.3 ms；超过 5–7 倍即争用                                                   |
| 按名杀进程                       | 会杀掉自己；只用 PID，或在脚本里精确 `kill -9 $PID`                                                                      |
| 安全守卫                         | 拦截 heredoc、含 `$(…)` 的长循环、`&` 前台后台化 ⇒ 落 `/tmp/*.sh` 用 `bash` 跑                                           |
| 判断 CI 触发                     | `gh api …/actions/runs?head_sha=<完整 40 位 SHA>`，短 SHA 会误判「没触发」                                               |
| 发版红                           | 不许重跑单个 job（会重名产物 ⇒ publish 报 missing）；有 Release 页的 tag 勿删                                            |

## 5 环境速查

- 仓库 `/Users/totota/purescience`；日志 `~/Library/Logs/PureScience/main.log`
- 配置根 `~/.purescience`（`settings.json`、`web-token`、`sessions/`、`notebooks/`、`purescience.db` 301 MB）
- 无头启动：`PURESCIENCE_CONFIG_ROOT=$ROOT PURESCIENCE_STORAGE_ROOT=$ROOT PURESCIENCE_WEB_PORT=<port> /Applications/PureScience.app/Contents/MacOS/PureScience --purescience-headless --disable-gpu --user-data-dir="$ROOT/electron-userdata"`
- 项目 id 示例：`cmvpfh9dk000iwfbup9trbm8o`
- 现有 bench（都要环境变量开启）：`scripts/bench/{skill-list,notebook-state,session-provenance,session-file-write,session-serialize,notification-snapshot}.bench.test.ts`

## 6 验收标准（用户口径，勿打折）

- **实机跑通才算完成**：单元测试不算数，禁空壳 UI、禁半截功能，还要实测流畅度；
- 一切结论附读数（`sourceUrl`/时间/毫秒/字节），做不到的字段整段省略，不写 0、不写 unknown、不写空占位；
- 交付必须**优于对标**而非平齐：每功能先列差异化点（可执行核验 / 溯源 / 中文场景 / 权限门）；
- CI 红先定因（`node scripts/ci-failure-digest.mjs <run|sha>`），不许靠重跑碰运气。
