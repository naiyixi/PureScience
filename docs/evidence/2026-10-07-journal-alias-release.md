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

## 四、会话侧复核（2026-10-06/07，另一执行体）

对上面这份实现做的**独立复核**（不采信提交信息，自己跑）：

- **测试**：`npx vitest run src/renderer/src/components/references src/main/references` ⇒ **28 文件 / 367 passed**（含新增的 3 条整面板用例）。
- **通道链在位**：`grep -c removeJournalAlias` ⇒ 目录 1 / `main/references/ipc.ts` 3 / `preload/index.ts` 2（声明 + 包装各一）⇒ 与它报的 pin 追平一致。
- **一处过程性事故（我造成、已回退）**：我在不知道已实现的情况下"重新接线"，因**未先核实**而写出**重复条目**（目录同键两行、preload 同键两个包装、ipc 两条同通道 handler）。已 `git checkout` 整笔回退，未提交。**教训**：动一个"以为缺"的缺口前，先 `grep -rn "<通道名>" src/preload src/main src/shared src/renderer` 全树核对 —— 这正是本仓"补缺口前先在代码里确认它真的缺"那条规矩，我这次跳过了。

**仍未取证（同第三节，且阻塞原因相同）**：真机读数。复核时本机 **swap 9367.88M / 10240M 已用、空闲物理页 5278（≈84 MB）**，重进程 WorkBuddy 1.9G / Hermes 1.8G / 两个 Electron 各 ≈1.4G ⇒ 与执行器开工时（8.99G/10.24G、≈60 MB）同一堵墙。本机 8 GB 内存 + 大堆有**硬崩（SIGTRAP）**前例 ⇒ **不硬上**，等机器空闲时按第三节配方取证。

## 五、真机读数已取（2026-10-07，会话；此处更正上面两节的"未取证"）

阻塞解除后（`build:e2e` 25.5 s 成功），按第三节配方取证：新建工作树于当时 HEAD（`42dd7855`）→ `npm run build:e2e` → 只跑 `e2e/certification/journal-alias-release.spec.ts`（**本条 spec 为本轮新写**）。

```
[ic56alias] import result: {"imported":2,"skipped":0,"journalsCreated":2, …}
[ic56alias] the stores carry the alias after the merge: [{"normalizedName":"nature","journalId":"…","createdVia":"explicit-merge"}] — releasing "nature"
[ic56alias] the confirm says: "After this, “nature” will no longer resolve to Nature (London). The metrics and references the merge moved stay where it put them — nothing is moved back — and no journal, number or reference is deleted."
[ic56alias] the panel reports the name released
[ic56alias] after the release: aliases=[] journals=["cmuxlcyza0003wfwbiicw8ii3"]
 1 passed (6.6s)
```

逐条对应判据：①**真入口**——经表单真合并（`source` 索引 1 → `target` 索引 2）；②**解除生效**——重读存储后 `aliases=[]`，别名行**真的没了**（不是只看界面）；③**确认句两件事都在**（原句见上，逐字匹配 `/no longer resolve to/` 与 `/stay where it put them|nothing is moved back/`）；④**不越界**——解除前后刊表快照 `JSON.stringify` **逐字相等**（没有任何归属被搬动，这正是本单元最要紧的一条）。

**一条本轮的自我纠正**（留档）：spec 首跑断言"合并后的别名是 `nature london`"⇒ 真机回 `{"normalizedName":"nature"}`（合并写入的是**源刊**的规范化名，下拉索引让"Nature"成了源）⇒ 说明**我猜了名字**。改法是**读出来**（先断言存在别名、再取名字用于后续比对），不是放宽断言。

**仍未取证**：判据③里"该名字可再次用于新建"这一半没在本条 spec 里验（数据层自然成立）；渲染层的键盘可达性不在本单元判据内。

