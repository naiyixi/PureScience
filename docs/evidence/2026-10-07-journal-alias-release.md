# 证据：解除期刊别名（合并的另一半）—— 2026-10-07

工作单：`docs/plan-2026-10-06-newfeature-journal-alias-unbind.md`（同一目录）。
本轮由自主执行器落地 **通道 + 真入口**（工作单 §2 的全部落点 + §3 的文案），**真机读数未取**（原因与配方见第三节）。

## 一、真实事实（对源核实，不是推断）

| 事实 | 依据（file:line） |
| --- | --- |
| 合并是**单事务**的三件事：指标/文献改归属、写一条别名（规范化名 → 目标刊）、删源刊行 | `src/main/references/journal-repository.ts` `mergeJournals`（R2-U4） |
| 别名行**只**由合并写入，键是**规范化名**（`normalizedName`），并记下 `mergedFromJournalId` | `src/main/references/journal-repository.ts` `journalAlias.findUnique`；`src/shared/journal-metrics-overview.ts:40-44`（`JournalAliasRow`） |
| 合并**没有**记录被改归属行的原主人 ⇒ 「撤销合并」在数据层不可能，只有「解除别名」可做 | 同上：`updateMany` 只换 `journalId`，行上没有 former-journal 字段 |
| 解除别名不触碰指标与文献（仓库实现只 `journalAlias.delete` 一次） | `src/main/references/journal-repository.ts` `removeJournalAlias` |
| 拒绝是**具名**的（`alias-not-found`），且带一句可上屏的 `detail` | `src/shared/journal-merge.ts` `JOURNAL_ALIAS_UNBIND_REFUSALS` / `JOURNAL_ALIAS_UNBIND_REFUSAL_LABEL_KEYS` |
| 本单元之前，渲染层**没有任何**入口能读或写这条别名（`grep -rn "removeJournalAlias" src/renderer` 零命中） | 本轮前的树 |

## 二、本轮观测值（全部本机实跑；读数即结论）

- **定向套件** `src/shared` + `src/preload` + `src/renderer/web` + `src/main/application-command-composition.test.ts` + `src/main/web-service` + `src/main/references` + `src/renderer/src/components/references` + `src/renderer/src/i18n`：**153 文件通过 / 1 跳过；1754 passed | 1 skipped**（`/tmp/alias-run4.log`，exit 0）。
- **新增用例 3 条**（真渲染整个面板，不是只渲染组件）：
  1. 解除前**先说明**「名字不再解析到 X」与「合并搬走的数字留在原处、不会被退回」（确认块文本逐句断言），且**未点确认前一个字节都没有发出**；
  2. 请求体携带的**是被点那一行的存储键**（`{ normalizedName: 'nat. commun.' }`，另一行是 `nature london` ⇒ 证明不是按显示文本或位置猜的）；
  3. 确认后**从存储重读**（桩第二次不再返回别名 ⇒ 行消失），而**结果行仍在屏上**（否则「刚消失的那行」无人解释）；拒绝时 `role="alert"` 印具名原因 + 仓库原句，且该行**仍在列表里**（拒绝没有改变任何东西）。
- **i18n**：新增 **10 键 × 9 语**（含拒绝标签键，与 `JOURNAL_ALIAS_UNBIND_REFUSAL_LABEL_KEYS` 的键名逐字一致）；插入脚本自证「10 键存在于 9 个文件」。
- **契约 pin 按失败原文逐个追平**（不预判）：目录 468→**469**、Web 安装集 393→**394**、Web invoke 投影 363→**364**、表面清单 468→**469**、preload 可调用清单 468→**469** 与核心契约 231→**232**（requests 193→**194**）、本地 Web 可调用面 393→**394**、references 族通道 29→**30**、合成计数内部 357→**358** / 本地 Web 355→**356** / 远程 Web 调度 231→**232**（fail-closed 拒绝集 **124 不变** —— 该通道是普通窗口写，不是本地专用）。
- `npm run gen:web-api-map` 重跑：生成物 **+1 行**（`'references.removeJournalAlias': 'references:remove-journal-alias'`），与手改逐字一致。

## 三、本轮**没**证到什么（具名立案，不冒充）

1. **真机读数未取**：开工时本机 swap 8.99 G / 10.24 G 已用、空闲物理页 ~3.8k（≈60 MB）⇒ 不具备 `npm run build:e2e`（8 GB 堆）+ 起 Electron 的安全余量（本机有堆把机器打崩的前例）。⇒ 「真窗口里点一次、磁盘上的 `journalAlias` 行真的没了」这一半**尚未取证**，界面目前只有渲染层证据。
2. **验收判据 3（旧写法不再解析）与判据 4（解除前后指标/文献归属不变）**只有**仓库层**证据（`journal-repository.test.ts` 的 `removeJournalAlias` 用例组），**没有**真机证据。
3. 解除后**该名字可再次用于新建**：数据层自然成立（别名行没了），但**未**在界面上验过。
