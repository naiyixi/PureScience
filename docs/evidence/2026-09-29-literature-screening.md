# 文献纳排分诊 S3 / S4 / S5 实机验收存档（2026-09-29）

本档只记录**跑出来的东西**：每条数字后面都能追到一条命令、一处断言或一个由本次运行写出的文件。
凡是没有真机来源的，明确写成「仅单测钉住」或「本机未能产生」，不补数字。

- 仓库：`/Users/totota/PureScience`
- 基线提交：`4b4488f9039a24188b9a801bdde94ff95a8e8eb1`（S4 已完成）+ **本次 S5 未提交改动**（工作区内）
- 环境：macOS 27.0 · Node v22.22.3 · Electron 43（`npm run build:e2e`）· Playwright 1.62.1
- 规格：`docs/plan-2026-09-29-literature-screening.md`（S5 = 覆盖率清单视图 + 本档）

---

## 1. 可复现命令

```bash
# 0) 构建渲染面/主进程产物（e2e 拉的是 out/）
npm run build:e2e

# 1) 真机 e2e：S5 + S3/S4 回归（证据落盘由 PURESCIENCE_EVIDENCE_DIR 打开）
PURESCIENCE_EVIDENCE_DIR=/Users/totota/PureScience/docs/evidence \
  npx playwright test \
    e2e/certification/references-screening.spec.ts \
    e2e/certification/references-screening-export.spec.ts \
    e2e/certification/references-screening-coverage.spec.ts

# 2) 受影响单测目录
npx vitest run src/main/references \
  src/shared/references-screening-export.test.ts \
  src/shared/references-screening-coverage.test.ts \
  src/renderer/src/components/references src/renderer/src/i18n

# 3) 全量单测 + 相关门禁
npm run test:gate
npm run typecheck
npm run lint
npx prettier --check <改动文件>
node scripts/i18n-coverage.mjs
npm run check:web-api-map
```

`PURESCIENCE_EVIDENCE_DIR` 只在设置时写盘（下面 §4 的三个文件），CI 跑同一批规格时不落任何文件。

---

## 2. 真机 e2e：用例名与耗时（本次归档运行，逐字）

```
Running 3 tests using 1 worker

  ✓  1 e2e/certification/references-screening-coverage.spec.ts:135:5 › reconciles one collection’s coverage tiers against a real corpus (15.7s)
  ✓  2 e2e/certification/references-screening-export.spec.ts:83:5 › screens a collection, overrides two records, and exports only the included ones (8.8s)
  ✓  3 e2e/certification/references-screening.spec.ts:49:5 › screens a collection, names its reasons, and layers a human override over the AI verdict (12.6s)

  3 passed (37.5s)
```

跑的是真窗口 + 真 IPC + 真 SQLite 库；模型侧沿用仓库既有的 e2e 假 Agent（`e2e/fixtures/fake-opencode.mjs`，
按提示词里的准则 id 作答），因此提示词装配、四条护栏、解析、落库、投影全部真跑。

---

## 3. S5 覆盖率清单：真机数字

来源：`docs/evidence/2026-09-29-literature-screening-readings-before-pass.txt`（跑之前）
与 `docs/evidence/2026-09-29-literature-screening-coverage-readings.txt`（跑之后）——都由上一条命令
在真机上把面板 DOM 读出来写盘，不是手抄。截图：`docs/evidence/2026-09-29-literature-screening-coverage-list.png`（301,172 字节）。

语料（5 篇，全部经应用自身通路造出）：

| 记录                                             | 真机怎么来的                                                                                                                     | 真机读到的覆盖类  |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `table evidence`                                 | 假 Agent 用应用自己的 artifact 工具写出真 PDF → 经 `references.add` + `references.attachPdf` 入册，全文由应用自己的 PDF 服务读回 | `full-text`       |
| `Abstract only: cohort with a measured endpoint` | `references.add` 带 `abstractSnippet`（手工添加表单没有摘要字段，这是库里真实存在的字段）                                        | `abstract-only`   |
| `Metadata only A / B / C`                        | 界面「Manual add」只填标题                                                                                                       | `metadata-only`   |
| —                                                | 本机**未能**产生 `unavailable`（见 §7）                                                                                          | `unavailable` = 0 |

清单读数（两态对照）：

| 读数                   | 跑之前                                                          | 跑之后                                                                                                                                                                            | 断言位置                                                                  |
| ---------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `data-scope`           | `collection-members`                                            | `collection-members`                                                                                                                                                              | spec `expect(list.getAttribute('data-scope')).toBe('collection-members')` |
| `data-searched`        | 5                                                               | 5                                                                                                                                                                                 | 同上（`data-searched`）                                                   |
| `data-candidate`       | 5                                                               | 5                                                                                                                                                                                 | 同上（`data-candidate`）                                                  |
| `data-classified`      | 5                                                               | 5                                                                                                                                                                                 | 同上（`data-classified`）                                                 |
| `data-within-searched` | `true`                                                          | `true`                                                                                                                                                                            | 同上（`data-within-searched`）                                            |
| `data-reconciled`      | `true`                                                          | `true`                                                                                                                                                                            | 同上（`data-reconciled`）                                                 |
| `data-unprocessed`     | **5**                                                           | **0**                                                                                                                                                                             | 同上（`data-unprocessed`）                                                |
| 四类计数               | full-text 1 · abstract-only 1 · metadata-only 3 · unavailable 0 | 同左（判定不动证据分层）                                                                                                                                                          | spec 里 `readCoverageGroups()` 逐组读 `data-count` 后 `toEqual([...])`    |
| 四类合计               | 5                                                               | 5                                                                                                                                                                                 | `data-classified` 与 candidate 相同，且 spec 逐组重算                     |
| 未处理逐条列出         | 5 条（表头 + 每条标题+覆盖类）                                  | 0 条                                                                                                                                                                              | `[data-testid="screening-coverage-unprocessed-item"]` 计数与文本          |
| 同屏统计               | —                                                               | AI decisions 5 · Human overrides 0 · Unprocessed 0 · Included 1 · Needs review 4 · Excluded 0 · Not evaluated 0 · Full text 1 · Abstract only 1 · Metadata only 3 · No evidence 0 | spec 末尾逐项 `toBe(...)`                                                 |

逐字界面文案（真机 DOM）：

```
reconcile line:     Searched 5 (the collection's members) · candidates 5 · the four tiers total 5
reconciliation line: The four tiers add up to the candidate count: 5.
unprocessed line:   Unprocessed 0 — listed one by one, never omitted:
```

每篇恰属其一（spec 在窗口里重算，不信面板的总数）：5 条成员行、5 个不重复 `referenceId`、
每个 tier 列表长度等于该组自己的计数、四类成员集合与主列表行的 `data-reference-id` 集合相同、
覆盖类集合相同。跑之前那 5 条的未处理行逐条列出（见 before-pass 文件）。

---

## 4. S4 统计三数与导出的实际内容

三数（导出前 / 覆盖覆盖后 / 导出后，S4 规格逐次断言，取自 `screening-stat-*` 元素文本）：

| 读数               | 值                                                         | 断言位置                                                                       |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| AI 判定数          | `AI decisions 3`                                           | `references-screening-export.spec.ts`（`statText(panel,'screening-stat-ai')`） |
| 人工覆盖数         | `Human overrides 0` → `2`                                  | 同上                                                                           |
| 未处理数           | `Unprocessed 0`（并同屏声明「绝不进入导出」）              | 同上 + `screening-stats` 文案                                                  |
| 四态分布（覆盖前） | Included 0 · Needs review 3 · Excluded 0 · Not evaluated 0 | 同上                                                                           |
| 覆盖分布（覆盖前） | Full text 0 · Metadata only 3                              | 同上                                                                           |

导出回执（真机逐字，落盘文件 `docs/evidence/2026-09-29-literature-screening-export-receipt.txt`）：

```
exported-file-name (suggested by the app): references-screen-hits-included-only-r1-gbt7714-2015-2026-09-29.txt
file-bytes: 67
citation-lines: 1

screening-export-receipt-summary:      Exported 1 included citations in GB/T 7714-2015 (numeric) · scope included only.
screening-export-receipt-not-exported: Not exported 2: needs review 1 · excluded 1 · not evaluated 0 · by a human override 1
screening-export-receipt-reasons:      Named reasons: The decision itself is uncertain: 2
screening-export-receipt-provenance:   collection Screen hits · rule revision 1 (1352d454ea1d) · 9/29/2026, 5:35:12 PM
screening-export-receipt-path:         Saved to /var/folders/…/ps-screening-export-Tv0ZXQ/screening-export.txt.

exported file verbatim:
[1] . Adults with a measured primary endpoint[EB/OL]. [2026-09-29].
```

文件名形状：`references-<collection>-included-only-r<revision>-<styleId>-<YYYY-MM-DD>.txt`；
本机真名见上，正则在规格里钉住（`/^references-screen-hits-included-only-r1-gbt7714-2015-\d{4}-\d{2}-\d{2}\.txt$/`），
渲染面单测另有同形状断言（`ReferencesScreeningPanel.render.test.tsx` 的 `suggestedName`）。
文件名由应用自己交给系统保存对话框（`dialog.showSaveDialog({ defaultPath })`），测试读的就是那一刻的 options，
不是测试编的名字。

真机导出文件只含「有效判定 = included」的一条：文件 67 字节、1 行、以 `[1] ` 开头；被人工排除的那条与未处理的第三条都不在文件里（规格 `expect(exported).not.toContain(...)`）。

### 4.1 规格自身的历史（如实记录，红线未放宽）

为使文件名可核账，本次给 S4 规格加了「应用自己提议的文件名」观测。**第一版写错了层**：在渲染进程里给
`window.api.saveBlobFile` 赋值包装 —— 而 `window.api` 是 `contextBridge.exposeInMainWorld('api', api)`
（`src/preload/index.ts:1021`）暴露的不可写对象，赋值静默无效，断言 `expect(suggestedNames).toHaveLength(1)`
读到 `[]` 而变红（`Received array: []`，失败点 `references-screening-export.spec.ts:277`）。所有既有导出断言
（只含 included、回执逐字、文件内容）在它之前**全部通过**，即红的是新增的观测、不是 S4 的实现。

改法：把观测挪到主进程的保存对话框边界 —— `e2e/fixtures/electron-app.ts` 的 `stubSaveDialog` 记录它被传入的
options（应用是 `dialog.showSaveDialog(parentWindow, { defaultPath: suggestedName, … })`，见
`src/main/file-save.ts:176-181`），新增只读方法 `lastSaveDialogOptions()`。**S4 规格原有断言一行未改**，改后该规格复绿
（1 passed，13.3s）。同一 fixture 的另一消费方 `e2e/support-bundle.spec.ts`（含取消保存那条）一并复跑通过（见 §2 之后 §9 的确认命令）。

---

## 5. 两条硬约束的守护位置

### 5.1「每篇恰属 full-text / abstract-only / metadata-only / unavailable 之一」

| 层                    | 用例/断言                                                                                                                                                               | 钉住什么                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 领域纯函数（S5 新增） | `src/shared/references-screening-coverage.test.ts` › _“puts every reference in exactly one of the four tiers, and all four tiers are always present”_                   | 四类恒在（空类计数 0 也不删）、成员恰好一次、四类合计 = 候选数、`violations` 为空                        |
| 同上                  | › _“refuses to file the same reference twice”_                                                                                                                          | 同一条目出现两次 → 拒绝入类 + 报 `appears more than once`，合计与候选数不符即 `reconciled=false`         |
| 同上                  | › _“refuses to bucket a coverage value that is not one of the four tiers”_                                                                                              | 未知覆盖值不进任何类，报具名违规（不静默归类）                                                           |
| 同上                  | › _“re-counts its own membership lists to the same totals, by a second, independent walk”_                                                                              | 成员列表二次遍历的合计与打印的组计数一致                                                                 |
| 证据分层（S2，既有）  | `src/main/references/screening-evidence.test.ts` › 表驱动 5 条 + _“reads as unavailable when the record itself is gone/…no field at all”_                               | 四类的判定规则本身（含 `unavailable`）                                                                   |
| 渲染面（S3 面）       | `ReferencesScreeningPanel.render.test.tsx` › _“lays the corpus out as four tier lists, reconciles them against the candidate count, and names the unprocessed records”_ | 从 DOM 重算分区：4 组按词表顺序、组计数、成员恰好一次、集合等于行集合、并与行的 `data-coverage` 逐组一致 |
| 真机（S5）            | `references-screening-coverage.spec.ts`                                                                                                                                 | 真机上重算分区（5 条成员、不重复、每组行数 = 组计数、与主列表行一致）；三类真有数据、第四类显式为 0      |

### 5.2「未处理量显式（不得静默省略）」

| 层               | 用例/断言                                                                                                                                                                              | 钉住什么                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 领域（S1，既有） | `src/main/references/screening-freshness.test.ts` › _“states the unprocessed remainder instead of omitting it”_、_“keeps a record with no evidence unprocessed rather than uncertain”_ | `unprocessedCount = candidateCount − assessedCount` 恒定算出                       |
| 领域（S5 新增）  | `references-screening-coverage.test.ts` › _“enumerates the unprocessed references by id, and cuts them by evidence tier”_                                                              | 未处理逐条具名 + 按覆盖类分档，分档合计 = 总数                                     |
| 同上             | › _“says zero unprocessed on an untouched-but-assessed collection…”_、› _“treats an empty collection as four empty tiers plus zero unprocessed”_                                       | 0 也是显式状态，不是空格                                                           |
| 统计（S4，既有） | `screening-statistics.test.ts` › 第一条                                                                                                                                                | 未处理数 = 库里没有判定的成员数，逐项与台账核对                                    |
| 渲染面           | `ReferencesScreeningPanel.render.test.tsx` › _“prints zero unprocessed rather than leaving the count to be inferred from an empty space”_                                              | 0 也打印「列出一条不漏」那一行                                                     |
| 真机（S5）       | `references-screening-coverage.spec.ts`                                                                                                                                                | 跑前：`Unprocessed 5` + 5 条具名；跑后：`Unprocessed 0` + 0 条具名（两份落盘读数） |
| 真机（S3）       | `references-screening.spec.ts`                                                                                                                                                         | `unprocessed 0` 在界面上被说出来（不是省略）                                       |

### 5.3「candidateCount ≤ searchedCount（两个数都要显示）」

| 层               | 用例/断言                                                                                                                                                                                                               | 钉住什么                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 领域（S1，既有） | `screening-freshness.test.ts` › _“asserts candidateCount ≤ searchedCount instead of trusting it”_、› _“refuses a coverage list longer than the candidate set”_、› _“refuses counts that are not non-negative integers”_ | 违反即抛错（写入口）                                                                                                                    |
| 领域（S5 新增）  | `references-screening-coverage.test.ts` › _“carries both totals so the nesting candidateCount ≤ searchedCount can be checked, and reports it when it fails”_、› _“reports a non-integer total…”_                        | 读出口不抛错而是具名上报：`withinSearched=false` + 违规文本                                                                             |
| 渲染面           | `ReferencesScreeningPanel.render.test.tsx` › _“shows a failed reconciliation instead of a total that quietly means nothing”_                                                                                            | 两个数同屏（`data-searched`/`data-candidate`）+ 核账失败文案 + 违规块                                                                   |
| 真机（S5）       | `references-screening-coverage.spec.ts`                                                                                                                                                                                 | `data-searched=5`、`data-candidate=5`、`data-within-searched=true`，并读回那行 `Searched 5 (…) · candidates 5 · the four tiers total 5` |

---

## 6. 四条提示词护栏：哪几条真机可见、哪几条只由单测钉住

| 护栏                         | 真机可见？     | 证据                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ② 缺证据 = 不确定，不是否定  | **真机可见**   | S5 规格：`Abstract only` 与 3 条 `Metadata only` 共 4 条，假 Agent 对这 4 条都答「included」，界面却是 `Needs review 4` / `Included 1`（唯一被采纳的是有全文那条）；另见 S3 规格：被要求排除的那条在真机上 `Excluded` 计数为 0，两行都显示 `Needs review` + `The decision itself is uncertain`                                          |
| ③ 判 no-match 必须给显式反证 | **仅单测钉住** | `src/main/references/screening-prompt.test.ts` › _“parseScreeningResponse — guardrail ③: no exclusion without explicit counter-evidence”_（4 条：无反证→uncertain、引用非排除准则→uncertain、有显式反证才保留排除）。真机上假 Agent 的排除答复**本身带反证**，且缺全文时会被覆盖度护栏压成 needs-review，故反证缺失这一支在真机不可分辨 |
| ① 文献正文按数据处理，防注入 | **仅单测钉住** | `screening-prompt.test.ts` › _“assembleScreeningPrompt — guardrail ①: literature text is data, never instructions”_（4 条：数据不进指令区、伪闭合标签中和、实体转义、指令区声明不可信数据）。真机语料里没有注入样例                                                                                                                     |
| ④ 忽略被引研究的内容         | **仅单测钉住** | `screening-prompt.test.ts` › _“guardrail ④: the content of cited works is ignored”_ + `screening-evidence.test.ts` › `stripCitedWorks` 系列（含 CJK「参考文献」表头）。真机那份全文 PDF（表格）没有参考文献段                                                                                                                           |

---

## 7.「检索候选数」这个量到底存不存在 —— 结论与证据

**结论：应用目前没有「检索到多少」这个独立量，因此 S5 没有编一个。** 面板显示的「检索数」与「候选数」
出自同一个数：集合成员数。

证据链（命令与输出尾部）：

1. 全仓非测试来源里，`searchedCount` 只有一处产生：

   ```
   $ grep -rn "searchedCount" src e2e --include=*.ts --include=*.tsx | grep -v "\.test\."
   src/main/references/screening-service.ts:204:      searchedCount: references.length,
   src/main/references/screening-freshness.ts:169/210   (函数入参/回传)
   src/shared/references-screening.ts:167               (类型字段)
   src/renderer/src/components/references/ReferencesScreeningPanel.tsx:246/373   (仅展示)
   src/renderer/src/components/references/ReferencesScreeningCoverageList.tsx:62/82 (仅展示)
   ```

   服务端的注释写明口径（`screening-service.ts:201`）：_“The collection IS the searched corpus: candidates are its members…”_。

2. 库里没有任何「命中数/检索轮次」字段可挂这个量：

   ```
   $ grep -n "searched\|hitCount\|resultCount\|totalResults\|foundCount" prisma/schema.prisma
   (no match in prisma/schema.prisma)
   ```

   `ReferenceCollection` / `CollectionItem` / `Reference` 三张表只有成员关系与题录字段，没有检索运行/命中记录。

3. 因此界面上**两个数都显示**，但「检索数」的口径被写成 `collection-members`（界面文案：
   `Searched 5 (the collection's members) · candidates 5 · …`），并有专门一句说明本版本不单独统计检索命中数
   （`references.screening.coverageList.scopeNote`，9 语言齐备）。真机读数：`data-searched=5`、`data-candidate=5`、
   5 ≤ 5 成立。

**宁缺勿造**：本档不给出任何「检索命中 N 条」的数字；若将来真有了检索运行记录，落点应是
`ScreeningCoverageSummary.searchedCount` 的输入（服务注入处），清单侧的比较逻辑无需改动。

---

## 8. 本次未能验证 / 不确定的点

1. **`unavailable` 覆盖类在本机不可产生**：该档要求记录存在但题录字段全空；`references.add` 明确要求标题非空
   （`src/main/references/service.ts:305`：`if (!input.title.trim()) throw new Error('A title is required.')`），
   界面上更不可能。真机只验证到「第四类显式为 0 且列出」，`unavailable` 的判定规则由
   `screening-evidence.test.ts` 钉住。
2. **`abstract-only` 的摘要是经 `references.add` 注入的**（手工添加表单没有摘要字段）：走的是应用自己的
   IPC 与库字段，不是桩；但真机上它是**通过 IPC 造语料**而非点界面按钮造出来的，这一点与 PDF 记录相同。
3. **既有缺陷（本次未改，仅记录）**：文献库「PDF 入册」选择器永远看不到项目 PDF ——
   `src/renderer/src/components/references/ReferencesLibraryDialog.tsx:451` 传 `limit: 500`，而
   `src/main/project-files/query-support.ts`（`MAX_PAGE_LIMIT = 100`，第 68–69 行）拒绝 >100，真机报错逐字为：

   ```
   Error invoking remote method 'project-files:list-files': Error: Project files page limit must be between 1 and 100.
   ```

   面板同时显示「项目内没有 PDF 文件。」。这与 S1–S4 冻结语义无关，也不是 S5 引入的；S5 规格改为用同一按钮
   本来要调用的两条通道（`references.add` + `references.attachPdf`）造出带 PDF 的记录。

4. **`Excluded 0` 在真机未被正面压测**：S5 语料里没有一条「有全文且带反证」的排除样例（假 Agent 只在标题含
   `Please exclude me` 时给反证，而那条记录在 S4 规格里是 metadata-only、会被覆盖度护栏压成 needs-review）。
   排除路径的真机确认来自 S3/S4 规格的 `Excluded` 计数与具名原因断言。
5. 覆盖率清单的两份读数文件里的成员是 **CUID**，不是标题：真机标题与覆盖类的对应关系见本档 §3 表格与截图。

---

## 9. 我自己复核的步骤（建议顺序）

1. `git status --short` → 确认 §10 文件都在工作区（未提交，符合本次约束）。
2. `npm run build:e2e` → 然后跑 §1 的第 1 条命令（约 40 秒），应看到三条 `✓`，耗时与 §2 同量级。
3. 打开 §4 的三个落盘文件核对每个数字：`2026-09-29-literature-screening-readings-before-pass.txt`、
   `…-coverage-readings.txt`、`…-export-receipt.txt`；截图为 `…-coverage-list.png`。
4. `npx vitest run src/shared/references-screening-coverage.test.ts` → 11 条；再跑 §1 第 2 条（312 通过 1 跳过）。
5. 想看核账失败的界面：`npx vitest run src/renderer/src/components/references/ReferencesScreeningPanel.render.test.tsx -t "failed reconciliation"`。
6. 复现被记录的缺陷：文献库 → 「PDF 入册」，即使项目里有 PDF 也会看到上面那条 alert 与「项目内没有 PDF 文件。」。
7. 改动过 `e2e/fixtures/electron-app.ts` 的 `stubSaveDialog`，它的另一个消费方也要复跑：

   ```bash
   npx playwright test e2e/support-bundle.spec.ts \
     e2e/certification/references-screening.spec.ts \
     e2e/certification/references-screening-export.spec.ts \
     e2e/certification/references-screening-coverage.spec.ts
   # 本机 5 passed (52.5s)
   ```

---

## 10. 本档涉及/新增的文件

- `src/shared/references-screening-coverage.ts`（新：覆盖率清单纯函数）
- `src/shared/references-screening-coverage.test.ts`（新：11 条）
- `src/renderer/src/components/references/ReferencesScreeningCoverageList.tsx`（新：清单视图）
- `src/renderer/src/components/references/ReferencesScreeningPanel.tsx`（在统计面板下方接入清单）
- `src/renderer/src/components/references/ReferencesScreeningPanel.render.test.tsx`（+3 条清单用例 +1 条 9 语言文案用例）
- `src/renderer/src/i18n/{en,zh,zh-Hant,ja,ko,fr,de,es,ru}.ts`（各 +11 键）
- `e2e/certification/references-screening-coverage.spec.ts`（新：S5 真机规格）
- `e2e/certification/references-screening-export.spec.ts`（+ 文件名观测断言 + 证据落盘，原断言未动）
- `e2e/fixtures/electron-app.ts`（`stubSaveDialog` 记录 options + 新增 `lastSaveDialogOptions()`，纯增量）
- `docs/evidence/2026-09-29-literature-screening.md`（本档）
- `docs/evidence/2026-09-29-literature-screening-{readings-before-pass,coverage-readings,export-receipt}.txt`、`…-coverage-list.png`（本次运行写出）
