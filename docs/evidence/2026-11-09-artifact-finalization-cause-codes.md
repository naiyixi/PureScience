# 产物定稿的失败行说不出「哪条规则拒了它」

日期：2026-11-09（执行器轮次）
状态：**诊断面已交付**（原因码 + 日志字段 + 源码守卫）；**根因已定（2026-11-09 第二轮，见 §七）** —— 不是占位身份被改写，也不是段每同步新铸，而是「声明的 Prompt 从未成为图里的节点」。

## 一 症状（来自用户自己的真机日志，不是推测）

`~/Library/Logs/PureScience/{main,main.1,main.2}.log` 全量聚合（只读），`scope=artifacts:finalization`、
`msg="artifact finalization attempt failed"` 共 **20 条**：

| claim | 版本行 | 尝试次数 | 时间跨度 |
| --- | --- | --- | --- |
| `artifact-claim-1793897553264-38` | `4490f3e9…` | 1 → 15 | 2026-11-06 03:30 → 2026-11-07 16:02 |
| `artifact-claim-1793807368207-30` | `9e4b6288…` | 1 → 2 | 2026-11-04 15:49 → 15:54 |
| `artifact-claim-1793807815085-31` | `027f4c7a…` | 1 → 3 | 2026-11-04 15:56 → 16:47 |

每条的 `data` 里 `failureKind` **一律是 `invalid-proof`**，`durableFinalizationCompleted=false`、
`provenanceRetries=0`；除此之外只有 claim / run / message / frame / branch / segment 的 id。
**没有任何一个字段说明是哪一条证明规则拒绝的**：同一份日志里 20 条错误，读者能得到的结论只有
「证明无效」，而「无效」有 15 种可能（根帧不符 / 分支不属该帧 / 段属别的帧 / 提示消息不属声明 /
消息不属声明 / 版本不再合格 / 版本被漏报 / 版本已绑别的消息 / 证据非法 / 快照缺失 / 快照损坏 /
快照越出分支血缘 …）。要分辨，只能把那次运行再复现一遍——而这是终态失败（不重试），复现成本最高。

## 二 已读到的现场（只读，`~/.purescience/purescience.db`）

三个版本行现在的状态：

| 版本 | state | messageId | rootFrameId |
| --- | --- | --- | --- |
| `4490f3e9…` | `pending` | 空 | `root-frame-pending-session-1793891820688-12` |
| `9e4b6288…` | `unpublished` | 空 | `root-frame-pending-session-1793806439965-11` |
| `027f4c7a…` | `unpublished` | 空 | `root-frame-pending-session-1793806439965-11` |

三行的帧 / 分支 / 段都是 `*-pending-session-<时间戳>-<序号>` 形态（`pending-session` 前缀由
`src/renderer/src/stores/session-store-message-graph-owner.ts` 的 `createPendingSessionId()` 铸造）。
这是一条**有价值的线索，但不是结论**：证明校验比的是「声明身份 vs 持久会话图」，占位身份能不能与
落盘后的图对上，取决于会话绑定（`bindPendingSession`）时图里的 id 是否被改写。见 §五。

## 三 交付（3 个产品文件 + 1 条守卫用例）

| 位置 | 改动 |
| --- | --- |
| `src/main/artifacts/provenance-repository.ts` | 新增闭集 `ArtifactFinalizationProofCause`（19 个原因码）；`ArtifactFinalizationProofError` 构造要求**具名原因**；`ArtifactOwnershipPersistenceRaceError` 只接受两条可重试原因（`runtime-segment-not-durable` / `message-not-durable`）；17 处抛出点逐个具名 |
| `src/main/artifacts/ipc.ts` | 失败行新增 `proofCause`（仅当确为证明类拒绝）；claim 侧两处抛出点也具名 |
| `src/main/artifacts/proof-cause-naming.test.ts`（新） | 源码守卫：两文件的**构造数 == 具名数**（防新增抛出点忘记命名）× **声明集 == 使用集**（防「声明了却没人报」的漂移），并带「扫到 2 个文件、每份 > 1000 字符」的自检，避免路径写错导致全绿空转 |
| `src/main/artifacts/ipc.test.ts` | 终态失败用例断言 `proofCause` 真的进了失败行；既有「消息正文不得进日志」的红线断言保留且仍通过（原因码是枚举，不携带 id / 路径） |
| `src/main/data-content-application-commands.test.ts` | 构造点跟随新签名（行为未变） |

为什么是枚举而不是把错误正文抄进日志：正文里含版本 id，个别分支的正文来自被捕获的异常（可能带路径）。
枚举给出同样可操作的信息量，且**日志里不可能因此多出用户数据**——这条在 `ipc.test.ts` 里已有断言
（`not.toContain('/Users/private')`、`not.toContain('secret artifact contents')`），本轮继续成立。

## 四 验证读数（全部在最后一次改动之后）

| 环 | 读数 |
| --- | --- |
| 定向单测 `ipc.test.ts` + `proof-cause-naming.test.ts` | **Test Files 2 passed / Tests 39 passed**，exit 0 |
| 定向单测 `provenance-repository.test.ts` | **1 file / 41 tests passed**，exit 0 |
| 定向单测 `data-content-application-commands.test.ts` | **1 file / 9 tests passed**，exit 0 |
| `tsc --noEmit -p tsconfig.node.json --composite false` | **exit 0**（修复前它抓到一处漏改的构造点 `TS2345`，已修） |
| `tsc --noEmit -p tsconfig.web.json --composite false` | **exit 0** |
| `npx eslint --no-cache`（本次 5 个文件） | **exit 0**，0 error（3 条 prettier warning 已 `--fix`） |

**真机窗口读数：未取，原因具名** —— 要看到 `proofCause` 上屏需要一次**真实的证明失败**，而失败发生在
应用自己的定稿路径上（claim 登记表是内存结构，重启即丢，无法用脚本伪造一个「重启前的 claim」）。
本轮也没有起 Electron 实例：`vm_stat` 空闲物理页 **3,981 × 16 KB ≈ 62 MB**，
`vm.swapusage` **13,066 / 14,336 MB 已用** ⇒ 起窗只会把机器拖进抖动，读数也不可信。
因此本单元的实证强度停在：**真机日志证明缺口存在**（20 条）+ **单测/守卫证明新字段按设计产生**。
按本仓口径，这不构成「实机跑通」，已在计划档立案，等下一次真实失败或下一次真机取证补上。

## 五 立案：根因仍未知（两条候选，都不是结论）

1. **占位身份**：三条失败版本行的帧 / 分支 / 段都带 `pending-session` 前缀。若会话绑定后图里的 id
   被改写（`bindPendingSession` 只改 session id，图内 id 是否跟着改未核），声明侧与持久侧永远不等 ⇒
   终态拒绝且永不恢复。核法：对一个 pending 会话跑一次「创建 → 绑定 → 落盘」，读图里三个 id，
   与版本行的三个 id 逐字比。
2. **段每同步一次新铸一枚**：`synchronizeSessionGraph()` 每次调用都 `createRuntimeSegmentId()`，
   而版本行记录的是**声明那一刻**的段 id。若提示消息在后续同步里被投影到新段，校验的
   `promptMessage.runtimeSegmentId === context.runtimeSegmentId` 就会恒假。核法：同一会话连续两次
   同步后，比较同一提示消息的 `runtimeSegmentId`。
3. 无论哪条为真，**修复方向都不会是放宽校验**：前者要在绑定/落盘时把版本行的身份一起对齐（写侧），
   后者要让段 id 与「一轮」而不是「一次同步」绑定。两者都属写侧行为改动，需先取证再动。

下一轮第一步：用隔离数据根复现一条「新会话里产出产物 → 立刻定稿」的路径，读版本行与图里的三个 id；
若确认是候选 1/2，按候选对应的写侧修法立项；若两者都不成立，新的 `proofCause` 会让下一次真实失败**自己说出**
是哪条规则——这正是本轮交付的意义。

## 六 收尾

- 隔离工作树 `/tmp/ps-r298`（`origin/main` 738227d1 + 本轮改动），提交后即删；真实配置根 `~/.purescience-project`
  与 `~/.purescience` 全程**只读**（本单元的 SQLite 查询一律 `-readonly`）。
- 未打 tag、未抬版本号：本单元只改诊断字段，不构成运行时行为对用户可见的变化。

## 七 根因（2026-11-09 第二轮，只读字段数据定因）

### 一 三份真实数据放在一起看，缺口是哪一条规则就唯一了

| 来源 | 读数 |
| --- | --- |
| 日志（`~/Library/Logs/PureScience/main*.log`，只读） | 20 条失败行的 `data.messageId` 形如 `message-1793807367479-88`（**图里的 id 形态**），而 `data.promptMessageId` 形如 `prompt-a3cfe235-5ed5-4fdb-a077-c9b994382fc7`（**uuid 形态**），四条身份里另外三条与图逐字相同 |
| SQLite（`~/.purescience/purescience.db`，`-readonly`） | 五个失败版本行的 `promptMessageId` 全部是 `prompt-<uuid>`；`rootFrameId` / `messageBranchId` / `runtimeSegmentId` 全部是 `*-pending-session-1793…` 形态 |
| 会话 JSON（`~/.purescience/sessions/<project>/<session>.json`，只读） | `d8da1631…` 图里 73 个节点，其中 **32 个是 `prompt-<uuid>`**（app-routed 且未抑制的回合确实会落节点），但声明的那一个 `prompt-ec3409d2…` **不在图里**；`16abfdab…` 图里 **0 个** `prompt-` 前缀节点，两个声明都不在图里。两图的 `rootFrameId`/`messageBranchId`/`runtimeSegmentId` 与日志里那三条约 **逐字相同** |

⇒ 命中的是 `prompt-not-owned`（`src/main/artifacts/provenance-repository.ts:396-404`：`promptIndex < 0` 即拒），
而它在原因码里属**终态**（不是两条可重试的 race 之一）⇒ 与日志里 `failureKind: invalid-proof`、
`provenanceRetries: 0`、同一 claim 重试 15 次仍失败完全一致。

### 二 两条旧候选的判决

- **候选 2（「段每同步一次新铸一枚」）否证**：`ensureConversationRuntimeSegment`
  （`src/shared/conversation-graph.ts:543-570`）在 framework/backend/model 未变时**直接复用当前段**、丢弃新铸的那个 id；
  `synchronizeActiveConversationMessages`（同文件 `:330-370`）只给**新节点**分配段，对已知节点只在该消息 `updatedAt` 更新时同步载荷，
  **从不重指 `runtimeSegmentId`**。所以段 id 不会因为多同步一次而与声明侧分叉。
- **候选 1（占位身份）部分成立，但不是这条失败的原因**：`bindPendingSession`
  （`src/renderer/src/stores/session-store-message-graph-owner.ts`）确实只改 `session.id`、图内 id 保持 `pending-session-…` 形态 ——
  但**两侧用的是同一份**，所以 root/branch/segment 三条都对得上（上表第三行）。占位身份是**背景**，不是缺口。

### 三 真正的原因：被抑制的 Prompt 永远不会变成节点

没有 `provenanceContext` 的调用方，在派发处被补上一枚 uuid 形态的 Prompt 身份：

| 位置 | 行为 |
| --- | --- |
| `src/main/acp/runtime-coordinator.ts:690-695`（本轮改动后行号；告警在 `:696-708`） | `request.provenanceContext` 缺席 ⇒ 铸 `prompt-${randomUUID()}` |
| `src/main/acp/artifact-turn-owner.ts:364-401` | 四支 fallback：`root-frame-${appSessionId}`（:364） / `message-branch-${appSessionId}`（:366） / `prompt-${runId}`（:367） / `runtime-segment-${appSessionId}`（:401） |

而 `suppressUserMessage: true` 的回合**不发射用户消息事件**（`src/main/acp/prompt-turn-workflow.ts:294` 的
`emitUserMessage` 在该标志下直接 return），于是那枚 id 永远不会成为图里的节点，证明的 `prompt-not-owned` 必然成立。
已知的无 provenance 调用方四处：`src/main/ipc.ts:1799`（后台结果投递 `startTurn`）、
`screening-model-runner.ts:220`、`restricted-inference-runner.ts:260`、`artifact-code-reconstruction-runner.ts:300`。
四处都是**产品自己的**回合（后台投递最典型：它在一个真实用户会话里跑一整轮 agent，能写出产物）。
副作用：这类回合写出的产物**永远不会定稿**（版本停在 `pending`/`unpublished`），用户看到产物但看不到它被发布。

### 四 本轮交付（诊断面收口，不改语义）

1. `src/main/acp/runtime-coordinator.ts` —— 派发处**一次性具名告警**（每会话一条）：句子写明后果，
   字段 `consequence: 'prompt-not-owned'` 直接指向那条规则；去重表 `unownedPromptWarned` 让「调用方少带 provenance」
   这件事只报一次，而不是每个回合一报。
2. `src/main/acp/unowned-prompt-anchor.test.ts` —— 源码守卫：fallback 身份只有一处铸造、告警必须与它同段、
   `consequence` 必须是 `ArtifactFinalizationProofCause` 里真的存在且真的被构造的原因码（防止文案漂到一条不存在的规则上）、
   去重只在同一处生效。

### 五 边界（不许读成更强）

- **产品缺陷仍未修**：写侧修复要把锚点解析成持久图里**真实存在**的那条 Prompt（或把「app-owned 回合」这一形态在契约里具名），
  三条候选与连锁规模见计划档 §297。本轮只让下一次失败**在日志里自己说是哪一类**，不改变任何用户可见行为。
- 本节全部读数为**只读字段数据**（SQLite `-readonly`、会话 JSON、日志）；没有起 Electron：
  `vm_stat` 空闲页 4,251 × 16 KB ≈ 66 MB、`vm.swapusage` 7,888 / 9,216 MB 已用 ⇒ 起窗读数不可信，真机窗口取证仍未取。
- 三个会话只读到 `d8da1631…` 与 `16abfdab…` 两份 JSON；第三条版本行 `4490f3e9…` 所属会话与前者相同。

## 八 写侧修复（2026-11-09 第三轮）：app-owned 回合继承「本会话最近一条用户 Prompt」的锚点

按计划档 §297 §三 A 落地。判据不是「补上一枚更像样的 id」，而是**让声明的那条 Prompt 在持久图里真的存在**：
所有权证明按 `promptIndex < 0` 拒，唯一能让它不拒的办法就是声明一条图里有的 Prompt。

### 一 改动（1 个产品文件 + 1 个测试文件）

| 位置 | 改动 |
| --- | --- |
| `src/main/acp/runtime-coordinator.ts` | 派发处先判「这是产品自己的回合」（`!retainAsLatestUserPrompt` 或 `request.suppressUserMessage === true`）；这类回合**缺 provenance** 时，从 `latestPromptRequests` 取该会话最近一条用户 Prompt 的 `provenanceContext`，四条身份**原样**用；取不到（无用户 Prompt / 那条本身是 fallback）才落回 uuid 身份 + 既有告警 |
| 同上 | `completeGraphAnchor()`：只有 `promptMessageId` + `rootFrameId` + `agentFrameId` + `messageBranchId` + `runtimeSegmentId` 全在才算「图里的锚点」。**fallback 自带的那枚 uuid 不满足这五条 ⇒ 不会被下一代继承**（否则只是把一条不可拥有的身份复制给下一回合） |
| 同上 | 继承成功每会话记一条 `info`（`promptMessageId` 具名）：让「这回合的产物会记到谁名下」在日志里可查，而不是与 fallback 同形 |
| `src/main/acp/runtime-coordinator.test.ts` | 四条：① app-owned continuation 继承四条身份（逐字）；② 被抑制的 `sendPrompt`（后台投递真实形状）继承；③ 最近那条本身是 fallback（只有 `promptMessageId`）⇒ 仍然新铸；④ **普通用户回合不继承**（新用户动作是新的 Prompt，不能记到上一回合名下） |

### 二 为什么是这条链而不是注入持久图解析器

调用方四处（`src/main/ipc.ts:1799` 后台投递、`screening-model-runner.ts:220`、
`restricted-inference-runner.ts:260`、`artifact-code-reconstruction-runner.ts:300`）都在**同一个进程**里派发，
而用户那条 Prompt 的 `provenanceContext` 就是渲染端从图上取的（`getActiveConversationContext` 的四条身份）。
因此「最近一条用户 Prompt 的锚点」在进程内已经拿得到，不需要再加一条 `sessionId → projectId → loadSession → 图` 的异步链
（那会牵动组合根，并让派发路径多一次 DB 读）。语义与 §297 §三 A 一致：产物归属**本会话最近的用户 Prompt**。

### 三 门禁读数（最后一次改动之后）

| 环 | 读数 |
| --- | --- |
| `vitest run src/main/acp/runtime-coordinator.test.ts src/main/acp/unowned-prompt-anchor.test.ts` | 2 文件 / **63 passed**，exit 0 |
| `npx vitest run src/main/acp`（整目录） | 见本轮提交前的实测（见计划档 §298 §三） |
| `tsc --noEmit -p tsconfig.node.json --composite false` / `web` | 两环各自 exit 0 |
| `npx eslint --no-cache`（本批 2 个文件） | 0 errors / 0 warnings |

### 四 边界（不许读成更强）

- **跨重启的 app-owned 回合仍走 fallback**：`latestPromptRequests` 是进程内表。应用重启后若第一条回合就是后台投递
  （没有先经过用户 Prompt），锚点仍然取不到 ⇒ 仍会以 `prompt-not-owned` 被拒并留告警。要继续收这一格，得按
  `sessionId → projectId → loadSession → conversationGraph` 从盘上解析（§297 §三 A 的完整形态），本轮未做。
- **语义**：被抑制回合写出的产物，归属到**本会话最近一条用户 Prompt**（不是它自己的、它自己永远不会有）。这与图自己的投影规则
  （新节点落在活跃分支、最近一条 Prompt 之下）一致，不代表证明被放宽——`prompt-not-owned` 仍按原样拒绝不存在的 id。
- **真机窗口读数未取**：本轮 `vm_stat` 空闲页 4,450 × 16 KB ≈ 70 MB、`vm.swapusage` 6,722 / 8,192 MB 已用 ⇒ 起 Electron
  只会把机器拖进抖动，读数不可信。要证「后台投递回合产出的产物能定稿」，需一次隔离数据根的真机回合（造一次投递 → 读版本行五条身份）。
  本轮证据是**协调器行为（单元级）+ 双 typecheck + lint + 整目录 ACP 套件**，不是实机 UI 取证——按仓规，这一格仍记「未取证」。

