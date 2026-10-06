# 新功能工作单：解除期刊别名（合并的"拆分"入口）

> 立案：2026-10-06（会话）。来源：IC49 核实结论「合并不可逆的文案**早已在位**，缺的只是**可撤销/拆分入口**」⇒ 作为**新功能单独立项**（不在 IC49 原行里假装已有）。状态：**待开工**。

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
