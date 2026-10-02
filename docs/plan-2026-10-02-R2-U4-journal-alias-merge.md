# R2-U4 执行清单：期刊别名与显式合并（本片；先写计划再动代码）

> 依据 `docs/plan-2026-10-01-R2-journal-entity.md` §U4 的验收口径：
> **「别名与更名（同一期刊的多种写法）：只做精确规范化匹配 + 用户显式合并，不做模糊自动合并」**。
> 前序片：U1/U2（实体+解析落库，`b4509920`）、指标导入（`041146dd`，真机读数
> `docs/evidence/2026-10-02-r2-journal-metric-import.md`）、U3 筛选/统计面（`8b074459` + 面板 DOM 读数
> `c4ef3189`/`fc21385c`，读数 `docs/evidence/2026-10-02-r2-u3-journal-metrics-surface.md`）。

## 0. 现状（读自当前 HEAD `351d4ebc`，不是猜）

| 事实                                                                                           | 位置                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Journal` **只有 `normalizedName`**，没有展示名 ⇒ 面板显示 `nature` 全小写（U3 §5 已立案）     | `prisma/schema.prisma:668`；`src/shared/journal-metrics-overview.ts:193` (`name: journal.normalizedName`)                                                                                                          |
| `resolveJournal` 只认 ISSN 与**精确规范化名**，没有别名表                                      | `src/main/references/journal-repository.ts:132-155`                                                                                                                                                                |
| `JournalMatch` = `by-issn` / `by-normalized-name` / `no-issn` / `name-not-exact` / `ambiguous` | 同上 `:26-35`                                                                                                                                                                                                      |
| 引用落库**一个函数里统一解析**（所有写入路径都过它）                                           | `src/main/references/repository.ts:237-258`                                                                                                                                                                        |
| 读路径两次查询、无 N+1；面板由纯函数算视图                                                     | `journal-repository.ts:240-271`；`src/shared/journal-metrics-overview.ts:151`                                                                                                                                      |
| 面板 = 容器（读通道）+ 纯展示表；开关照 `showScreening` 形状                                   | `src/renderer/src/components/references/JournalMetricsPanel.tsx`；`ReferencesLibraryDialog.tsx:1125`                                                                                                               |
| 归档决策登记（导入无界面）                                                                     | `src/shared/entry-layer-archived-surfaces.ts:105`                                                                                                                                                                  |
| 契约计数连锁（加一条通道会动到的测试）                                                         | `application-command-composition.test.ts`（341/222/119）、`renderer-contract-catalog.test.ts`（454/349/379/75/119）、`preload/index.test.ts`（224/186）、`renderer-argument-shape-characterization.test.ts`（379） |
| 生成物                                                                                         | `npm run gen:web-api-map`（`src/shared/web-api-map.generated.ts`，须幂等）                                                                                                                                         |

## 1. 设计决策（先把会漂移的口径钉死）

1. **别名 = 一张显式的名字→期刊映射表**（`JournalAlias`），**唯一写入方是用户的显式合并**。
   不做「近似名自动并表」：名字像不等于同一本刊，自动合并会制造假事实（本仓红线）。
2. **合并 = 一次可审计的重归属**，语义固定：
   - 源刊的全部指标行、引用行、已有别名 **重指向** 目标刊；
   - 源刊的**规范化名本身成为目标刊的一条别名**（这就是「更名」：旧名以后仍能解析到同一本刊）；
   - 源刊行**删除**（它的名字活在别名行里，不丢）；
   - 别名行留 `mergedFromJournalId`，合并这件事本身可追溯。
3. **合并拒绝一律具名**（返回判别式联合，不抛判定类错误）：`self-merge` / `source-not-found` /
   `target-not-found` / `alias-conflict`（该名字已别名到**别的**刊 ⇒ 拒绝，绝不静默改写）。
   只有**非判定类**（引擎故障）才上抛——否则「引擎坏了」会被报告成一堆合理原因（同导入片口径）。
4. **解析顺序**：ISSN → 精确规范化名 → **别名**（新增 `by-alias`）。别名在名字之后查，保证
   刊自己的名字永远优先于任何别名，别名不会覆盖一本真刊。
5. **展示名（U3 立案项收口）**：`Journal.displayName` 存**来源给的原始写法**，面板优先显示它，
   缺则回落 `normalizedName`。加列走既有 `addColumnIfMissing`（`prisma-client.ts:941`）。
6. **`by-alias` 必须一路传到底**：导入结果的 `journalMatch` 联合要加它（`src/shared/journal-metrics.ts:86`），
   否则「按别名匹配」会被断言成两种之一 ⇒ 撒谎。
7. **界面**：面板新增「合并」区块（两个下拉选源/目标 + 确认 + 具名结果行），并在期刊行上显示别名。
   纯函数 `describeMergeRefusal`（shared）把拒绝码映射成 9 语种键，**穷尽 Record**——新拒绝码漏映射即编译失败。
8. **不做的**：不做模糊匹配、不做自动合并、不做批量合并、不做撤销（合并是不可逆的用户决定；
   要恢复只能再合并回来——本片不提供，如实写在文案里）。

## 2. 编辑清单（按序，每步可单独绿）

1. `src/shared/journal-merge.ts`（新）：`JournalMergeRequest` / `JournalMergeResult` /
   `JOURNAL_MERGE_REFUSALS` / `JOURNAL_MERGE_REFUSAL_LABEL_KEYS`（穷尽）/ `isJournalMergeResult` 守卫。
2. `src/shared/journal-metrics.ts`：导入结果 `journalMatch` 并集加 `'by-alias'`。
3. `src/shared/journal-metrics-overview.ts`：`JournalIdentityRow` 加可选 `displayName`；
   `JournalOverviewRow.name` 取 `displayName ?? normalizedName`；新增 `aliases` 投影类型。
4. `prisma/schema.prisma`：`model JournalAlias`；`Journal` 加 `displayName String?`。
5. `src/main/projects/prisma-client.ts`：`JOURNAL_ALIAS_TABLE_DDL` + 索引 + `Journal.displayName`
   的 `addColumnIfMissing`，挂进同一条执行序列（`:1164-1181`）。
6. `src/main/references/journal-repository.ts`：`JournalClient` Pick 加 `journalAlias` / `reference` /
   `$transaction`；`resolveJournal` 加别名回退；`mergeJournals`；`listJournalsWithMetrics` 带
   `displayName` 与别名；`upsertBy*` 写 `displayName`。
7. `src/main/references/ipc.ts`：handler 类型 + 实现 + `ipcMainHandle('references:merge-journals')`。
8. `src/main/references/application-commands.ts`：命令对象 + group + 注册映射。
9. `src/preload/index.ts` + `src/preload/renderer-api.d.ts`：桥与类型。
10. `src/shared/renderer-contract-catalog.ts` + `npm run gen:web-api-map`。
11. **契约计数连锁**：composition 343/341/222（rejected 119 不变）、catalog 454、invoke 349、
    localWeb 379、preload 224/186、argument-shape 379，全部 +1（无 local-only 标记 ⇒ 远端 dispatch 也 +1）。
12. `JournalMetricsPanel.tsx`：合并区块（源/目标下拉 + 按钮 + 具名结果）+ 别名显示 + 合并后重读。
13. i18n：`references.journalMetrics.merge.*` 与 `…merge.refusal.*`（4 条）在 **9 个语言文件**实译
    （zh ≠ en），跑 `translation-quality.test.ts`。
14. 测试：shared（拒绝码穷尽映射、`displayName` 回落、别名投影）、repository（合并的四种拒绝 +
    重归属计数 + 别名解析 + 幂等性）、ipc 契约、面板渲染（选中/确认/具名结果/别名可见）。

## 3. 验收（真机/真文件，逐条；单测不算）

| 判据                     | 怎么取                                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **显式合并生效**         | 隔离实例：由本产品自己的导入命令造两本近似但不同的刊（如 `Nature` 与 `Nature Communications`，先确认**没被自动并掉**＝两行），走真实 RPC `references:merge-journals` 合并 ⇒ 读回库：只剩一行、指标/引用被重归属、别名行存在 |
| **近似名不会被自动吞并** | 合并前读回：两本刊各占一行、指标各自独立（这是「不模糊合并」的**正向证据**）                                                                                                                                                |
| **旧名仍能解析**         | 合并后向该库写入/导入一条用**旧名**的引用 ⇒ `journalId` 指向目标刊（`journalMatch = 'by-alias'`），不新建行                                                                                                                 |
| **具名拒绝**             | `self-merge` / 不存在的 id / 别名指向别的刊 三种各取一次读数，逐条具名，**零静默改写**                                                                                                                                      |
| **展示名**               | 面板与读回视图显示来源原始写法（如 `Nature`），不再是全小写 `nature`                                                                                                                                                        |
| **面板级读数**           | 真窗口 + 真库：合并区块可选、确认后表格从两行变一行、别名可见、拒绝时显示具名文案                                                                                                                                           |
| 无空壳                   | 合并控件必须有真交互闭环（选→确认→结果），**禁**只有禁用占位控件                                                                                                                                                            |

隔离与清理口径同上一片：`PURESCIENCE_STORAGE_ROOT` + `settings.json` 里绝对 `dataRoot` + 独立
`PURESCIENCE_WEB_PORT`；收尾停进程、端口无监听、删临时目录、`git status` 干净。真实根只读。

## 4. 明确不做（本片）

- 不做模糊/自动合并，不做批量合并；
- 不做合并撤销（不可逆，文案写明）；
- 不改既有引文列表对 `venue` 文本的显示（未解析的引用仍按文本显示，不回填）。
