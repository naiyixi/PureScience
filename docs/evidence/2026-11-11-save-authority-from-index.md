# 保存路径的「主进程权威字段」改由列表索引作答

日期：2026-11-11（执行器单元）· 代码：`src/main/session-persistence/{repository,coordinator}.ts`

## 一 为什么动它

同一份装机日志（`~/Library/Logs/PureScience/main{,1,2}.log`，2026-11-04…09）里
`session save was slow` 共 789 行，分段合计 `totalMs` **1,118.9 s**，其中

| 段 | 合计 | 占比 | p50 | p90 | max |
| --- | --- | --- | --- | --- | --- |
| `queuedMs` | 34.9 s | 3% | 0 | 2 | 8,192 |
| `authorityMs` | **460.2 s** | **41%** | 91 | 688 | 22,682 |
| `prepareMs` | 28.5 s | 3% | 10 | 76 | 1,441 |
| `writeMs` | 383.2 s | 34% | 71 | 410 | 27,637 |
| ├ `writeDiskMs` | 320.3 s | 29% | 41 | 360 | 25,051 |
| `aftermathMs` | 212.1 s | 19% | 132 | 451 | 8,657 |

`authorityMs` 是「保存前先整份读一遍会话 JSON」的那一段：主进程要保住三样渲染端不许拥有的字段
（`runtimeContext` / `archivedAt` / `waiting-plan-approval` 状态）以及合并时用的 `updatedAt`。

## 二 真实语料上的机制读数（本机现取，只读）

`~/.purescience-project/sessions/`：**66 份会话文档 = 68.99 MB**，同一批的 `.summary.json`
（列表索引）**66 份 = 0.64 MB**。逐份 `readFileSync` + `JSON.parse`：

| | p50 | p90 | max |
| --- | --- | --- | --- |
| 文档（读 + 解析） | **4.00 ms** | 8.27 ms | 19.02 ms |
| 索引（读 + 解析） | **0.27 ms** | 0.46 ms | 0.85 ms |

口径：这是**机制**读数（同一台机器、同一批真实文件、热缓存），不是装机读数。

**诚实边界**：`authorityMs` 的 p90 是 688 ms，比一份文档的解析成本高两个数量级 ⇒ 这个窗口里
占大头的**不是解析**。它是墙钟窗口（`readAt - startedAt`），事件循环被别的活占住时同样计进来。
本单元移除的是「每次保存都读 + 解析一份 1 MB 文档」（真语料 p50 4.0 / p90 8.3 / max 19.0 ms），
**不声称 41% 全部消失**。窗口里的其余成因（冷页、事件循环饥饿、隔离检查的目录列举）本单元未归因，
留给装机新行区分：保存慢行新增 `authoritySource: index|document`，一眼看出这次到底有没有走窄路。

## 三 改了什么

| 位置 | 改动 |
| --- | --- |
| `repository.ts` | 新增 `loadSaveAuthority(projectId, sessionId)`：指纹（size + mtime）命中就答索引里的四个字段，否则回落 `loadSessionWithDiagnostics`（`missing` / `unreadable` 语义逐字不变）；新增 `SessionSaveAuthority` / `SaveAuthorityLookup`（带 `source`） |
| `repository.ts` | 索引里的每个字段都过与文档读同一套校验：`runtimeContext` 走 `sanitizeSessionRuntimeContext`、`archivedAt` 必须安全正整数、`status` 必须在持久化字面量集合里、`updatedAt` 必须安全整数 —— 任一不合格即回落文档，绝不把索引值带进写 |
| `repository.ts` | 写路径摘要（`.summary.json`）由 `void` 改成 `await`：它的指纹靠 `stat` 取得，不 await 时上一笔的条目可能「用后一笔的指纹写前一笔的内容」，那正是窄路会信的假条目；顺带让下一次保存一定命中索引（否则命中与否取决于写的完成顺序） |
| `coordinator.ts` | 保存的权威读取改走 `loadSaveAuthority`（冲突重基那条分支仍整份读，逻辑未动）；慢行新增 `authoritySource` |

未动：`where` 的归属条件、`unreadable` 抛错的措辞与时机、冲突重基路径、`aftermath`、写盘半边。

## 四 门禁（全部实跑，取自最后一次改动之后）

| 环 | 读数 |
| --- | --- |
| `src/main/session-persistence`（13 文件） | **271 passed**，exit 0 |
| 另五个消费方测试文件 | **5 files / 108 passed**，exit 0 |
| 双 typecheck（`--composite false`，node 侧 `NODE_OPTIONS=…8192`） | node 0；web 0 |
| `eslint --no-cache`（4 文件） | 0 error / 0 warning |

**变异自证两次均还原**：① 索引分支短路（`fromIndex && false`）⇒「从索引作答且不读文档」红；
② 协调者改回整份读文档 ⇒「不解析文档」红。

## 五 装机判据（本单元取不到，等下一次发版）

同一天使用时段里，`session save was slow` 行中 `authoritySource: index` 应占多数，且
`authorityMs` 的 p50/p90 下移（基线 91 / 688 ms）；`writeMs` 会因摘要改为 await 略微上升
（每次 +一份 ~10 KB 的小写，基线 p50 71 ms）。**不承诺毫秒数**：本机测到的解析成本
（p50 4.0 ms）说明这段窗口主要由别的东西填充，降幅要由装机新行给。
