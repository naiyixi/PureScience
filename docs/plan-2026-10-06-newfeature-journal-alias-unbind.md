# 新功能工作单：解除期刊别名（合并的"拆分"入口）

> 立案：2026-10-06（会话）。来源：IC49 核实结论「合并不可逆的文案**早已在位**，缺的只是**可撤销/拆分入口**」⇒ 作为**新功能单独立项**（不在 IC49 原行里假装已有）。状态：**已落地（执行器，2026-10-07，提交见下 §7）**；真机读数未取（内存不足，已具名立案 + 配方）。

## 1. 这个功能到底是什么（先划界，避免做成假功能）

合并（`journal-repository.ts:203` 的 `mergeJournals`，**单事务**）做了三件事：①把源刊的**指标/文献改归属**到目标刊；②写一条**别名**（源刊的规范化名 → 目标刊，`:274`）；③删掉源刊行。

因此**"拆分"诚实能做的只有一件事**：**解除那条别名** —— 旧写法不再解析到本刊，该名字重新可用于新建/显式归并。

**它不能做的**：把已经改归属的指标与文献**退回**源刊（合并时它们就换了主人，事务里没有任何"原归属"记录可回放）。⇒ **文案必须同时写清"做什么"与"不做什么"**，否则就是把不可逆的事说成可逆。

## 2. 落点与接缝（已逐一核实）

| 位置 | 现状 | 本功能要做的 |
| --- | --- | --- |
| `src/main/references/journal-repository.ts` | `mergeJournals`（`:203`）、别名读随刊表返回（`:410` 附近，select `normalizedName/journalId/createdVia`）、`journalAlias.findUnique/updateMany/create` | 新增 `removeJournalAlias({ normalizedName })`：**单事务**读该别名 → 不存在则**具名拒绝**（`alias-not-found`）→ 删除 → 返回结果（含被解除的名字与被释放的目标刊）；**不得**顺手动指标/文献 |
| `src/main/references/ipc.ts` | `mergeJournals`（类型 `:79`、处理器 `:249`、路由 `:345`） | 同族加一条 `removeJournalAlias`，处理器→仓库直通；**具名错误类型**与合并的 `JournalMergeRefusal` 同风格 |
| `src/preload/index.ts` | `mergeJournals: (input) => invoke('references.mergeJournals', …)`（`:701`） | 加 `removeJournalAlias` 包装（同形） |
| `src/preload/renderer-api.d.ts` | 有 `mergeJournals` 的类型 | 加同形声明 |
| `src/shared/renderer-contract-catalog.ts` | `references` 组（`:290` 附近） | 加 `['removeJournalAlias', 'references:remove-journal-alias', ELECTRON]` |
| `src/shared/journal-merge.ts` | `JournalMergeRequest/Result/Refusal` 与 `JOURNAL_MERGE_REFUSAL_LABEL_KEYS`（标签键表） | 新增解绑的请求/结果/拒绝类型；拒绝标签键照合并的体例给（渲染层按 key 翻） |
| 界面（期刊详情/指标面板） | 别名已随刊表返回，**无需新读通道** | 每个别名一行加「解除」控件 + 二次确认；确认文案见 §3 |

**pin 级联（必读）**：新增一条**通道**会同时影响五族计数（契约目录 / 前载可调用清单 / 本地 Web `unavailable` 计数 / 两个 Web 契约面 / 该家族 IPC 适配器与 local-only 集）⇒ **加完直接跑全量单测**，不要只跑连接器或 references 目录（本仓实测「定向簇必漏」）。

## 3. 文案（诚实是验收项，不是风格问题）

- 入口：`sessionInfo` 之外，放在期刊别名行上 ⇒ 键如 `journalAlias.remove` = 「解除这个旧写法」。
- 确认句必须**同时**说：①解除后**这个旧写法不再解析到本刊**；②**合并时并入的指标与文献不会退回**（它们已改归属）；③如需恢复，请按当前记录自行更正。
- 失败具名：别名不存在 / 存储不可写，各自一句**可行动**的话（"重试"或"先看日志"），不要一个笼统的"操作失败"。

## 4. 验收判据（真机为准）

1. **真入口**：在真窗口打开一个**真的合并过**的期刊（IC49 的 spec 已证：桥接导入两刊 → 走表单真合并 ⇒ 结果行留别名 `also known as <名>`）。
2. **解除生效**：点「解除」→ 该别名从面板消失；**磁盘上的 `journalAlias` 行真的没了**（用桥接读回，不是只看界面）。
3. **旧写法不再解析**：解除后按该旧名再走一次解析（`resolveJournalByName` 一类）⇒ 具名地说"不是别名"，且该名字可再次用于新建。
4. **不越界**：断言解除前后**指标与文献的归属没有变化**（解除 ≠ 撤销合并）—— 这条是本次最重要的一条，防止把"拆分别名"实现成"拆分子集"。
5. 只读守卫：解除是**唯一**的改变性控件；面板其余部分仍只读（IC52 的教训：控件集合要断言）。
6. 证据落 `docs/evidence/`（三块式：真实事实 / 本轮观测值 / 本轮没证到什么）。

## 5. 陷阱（本轮已踩过或极易踩）

- **别信"存储层能回滚"**：合并事务里没有"原归属"记录 ⇒ 任何"撤销合并"的说法都是编的。
- 别名键是**规范化名**（`normalizedName`）：界面显示的是原拼写、删除要用规范化名 ⇒ 已在 IC49 观察到别名行显示小写规范化名（`nature`），这不是 bug 但**别拿界面文本当键**。
- 新通道 ⇒ **跑全量单测**追平 pin（见 §2）。
- 真机取证**新建**工作树，别复用（旧 `out/` 会让新断言假红）。
- 夹具：造"已合并"的期刊要走**应用自己的桥接 + 表单**（IC49 的 spec 已有配方，直接抄），不要手写数据库行。

## 6. 关联

- IC49（已结案，明写不可逆在位）：排期档该行 + `e2e/certification/journal-merge-irreversibility.spec.ts`
- 合并实现与其拒绝语义：`src/main/references/journal-repository.ts:203+`、`src/shared/journal-merge.ts`
- 通道与 pin 的完整连锁：技能 `references/adding-an-ipc-channel.md`

## 7. 落地记录（执行器，2026-10-07）

**落地面**（§2 的六处全齐 + §3 的文案）：

| 落点 | 改动 |
| --- | --- |
| `src/main/references/ipc.ts` | `ReferencesHandlers.removeJournalAlias` + 处理器映射（**直通仓库**，与合并同形）+ 路由 `references:remove-journal-alias` |
| `src/main/references/application-commands.ts` | **四处登记**：`Pick` 联合、`defineApplicationCommand`、组成员数组、`scope.registerGroup` 的处理器（缺第四处会以「Application command handler is missing」在启动路径抛 ⇒ 窗口永不出现） |
| `src/shared/renderer-contract-catalog.ts` | references 组加一条（默认 Web 档 ⇒ 三处合成计数同动） |
| `src/preload/index.ts` + `renderer-api.d.ts` | 同形包装与声明 |
| `src/shared/web-api-map.generated.ts` | `gen:web-api-map` 重跑后 +1 行（与手改逐字一致） |
| 渲染层 | 新组件 `JournalAliasRelease.tsx`（每别名一行 + **二次确认**）；面板按「库里有别名 **或** 有结果」挂载 ⇒ 结果行不会随最后一条别名消失 |
| i18n | **10 键 × 9 语**（zh ≠ en、zh-Hant 纯繁体；拒绝标签键与共享层的键名逐字一致） |

**契约 pin（按失败原文逐个追平，未预判）**：目录 468→469、Web 安装集 393→394、Web invoke 投影 363→364、表面清单 468→469、preload 可调用清单 468→469、核心契约 231→232（requests 193→194）、本地 Web 可调用面 393→394、references 族通道 29→30（`screening-ipc.test.ts`）、合成计数内部 357→358 / 本地 Web 355→356 / 远程 Web 调度 231→232（**fail-closed 124 不变**：该通道是普通窗口写，与合并同档，不是本地专用）。

**证据**：新增 3 条渲染用例（走**整个面板**，含「请求带的是被点那一行的存储键」与「结果行在最后一条别名消失后仍在屏」）；定向套件 **153 文件 / 1754 passed | 1 skipped**；逐条读数见 `docs/evidence/2026-10-07-journal-alias-release.md`。

**⏳ 真机读数未取（具名立案）**：开工时本机 swap 8.99 G / 10.24 G 已用、空闲物理页 ~3.8k（≈60 MB）⇒ 无 `build:e2e`（8 GB 堆）+ Electron 的安全余量，**未改 `e2e/certification/**`**（未跑过的 spec 进仓＝一道从未通过的闸门）。
**配方（内存宽松时一次跑完，只允许跑绿后提交该 spec）**：以 `e2e/certification/journal-merge-irreversibility.spec.ts` 为骨架 —— 它已含「桥接导入两刊 → 走表单真合并 ⇒ 结果行留别名 `also known as <名>`」这条造数路径：
① 合并完成后，在同一个面板底部读到 `[data-slot="journal-alias-release-row"]` 一行，其文本含规范化名与 `resolves to <目标刊>`；
② 点该行 `[data-slot="journal-alias-release-open"]` ⇒ 断言确认块（`[data-slot="journal-alias-release-confirm"]`）**在屏**且含「不再解析」与「不会被退回」两句；
③ 点 `…-confirm-yes` ⇒ 断言 `[data-slot="journal-alias-release-done"]` 的文案例句，并**从存储回读**（`listJournalMetrics` 的 `aliases` 不再含该规范化名 —— 不是只看界面）；
④ **判据 4（不越界）**：解除前后各读一次 `listJournalMetrics` 的 `claims`，断言逐条主张的 `journalId` 集合**没有变化**（解除 ≠ 撤销合并）；
⑤ 点 `…-confirm-no` 那条路径断言磁盘态不变（二次确认的负向）。
**只允许跑绿之后提交该 spec**；尚未取到的部分在证据档第三节逐条具名。

**未做（本单原文之外，未假装已有）**：不提供「撤销合并」（数据层没有原归属可回放 —— 见 §1 与 §5）；不做别名的手工新增。

