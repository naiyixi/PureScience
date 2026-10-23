# 权限请求那一秒的等待：把「谁决定的」与「那 1 秒等到了什么」变成可读的数

日期：2026-10-23 · 单元：主会话 MCP 权限请求为什么把 1 秒的入参等待等满（§两百一十八 §四 4 ③ 的下一单元）
· 提交范围：`src/main/acp/permission-broker.ts`（决定记录四态补齐）、`src/main/acp/permission-context.ts`
（等待结果 / 不可用更新 / 迟到入参三条读数）、`src/main/acp/runtime-session-composition.ts`（三条日志接线）
＋ 两份用例（各新增一组）

## 1 上一轮留下的两个说不清

上一轮把「复查会话不再白等」修完（`01f86101`）之后，剩下的问题是**主会话**的 106 次等待。当时有两句话
没法在日志里落实：

1. **「谁决定的」没有记录。** 全仓只有复查路径写过决定行；主会话里一次权限请求最终是**策略自动放行**、
   **命中记住的授权**、还是**真的弹了卡**，三者在日志里**完全同形**（都只有 `permission request received`
   与 `permission context wait timed out` 两行）。于是「这 1 秒里用户到底被挡了一次，还是根本不需要他」——
   当时**答不了**。
2. **「那 1 秒等到了什么」也没记录。** `OpenCode permission context wait timed out` 只在**超时**时打印；
   一次**等到了**的等待一声不响。所以「290 次等待全部超时」这句话是**推断，不是测量**——分母根本不在日志里。
   （本单元把上一轮那句结论就地更正，见 §6。）

## 2 真机读数（只读，未重启实例）

日志：`~/Library/Logs/PureScience (DEV)/main*.log` 三份，合计 **36,095** 条 JSON 行，
窗口 **2026-10-21T14:16:14Z → 2026-10-23T11:02:06Z**。

| 读数 | 值 |
|---|---|
| `OpenCode permission context wait timed out` | **290** |
| `permission request received` | 1,906 |
| 超时按其归属切分 | 复查会话 **184** / 主会话 **106** |
| 复查侧形态 | `reviewer_read_turn` 100、`reviewer_read_turn_history` 78、`reviewer_query_execution_log` 6 |
| 主会话侧形态 | `knowledge_list_sources` 48、`notebook_state` 46、`annotation_list` 11、`notebook_restart` 1 |
| 主会话超时涉及的会话 | **78** 个，且每个会话都有**自己的** `prompt start`（都是用户真实在用的一轮） |
| 290 次超时里带 `permission request received` 同 `toolCallId` | **290 / 290**（等待结束后请求都照常走到闸门，不是被打断） |

**主会话侧的白等量**：106 × 1,000 ms = **106,000 ms ≈ 1 分 46 秒**，全部花在**应用自有 MCP 工具**上
（都是读类：列来源、读笔记本状态、列批注，外加 1 次 `notebook_restart`）。

### 2.1 复查那一半已经在真机上确认修好了

| 时间（UTC） | 事件 |
|---|---|
| 2026-10-23T05:41:32.949Z | 最后一条 `wait timed out` |
| 2026-10-23T05:41:44.220Z | 第一条 `skipping OpenCode input wait`（`reason: identity-only-decision`） |
| 之后到日志末尾 11:02:06Z | 一共 **5** 条 skip，**0** 条超时 |

也就是说 `01f86101` 那条「要不要等入参由调用方自报」在**真机跑过、并且真的把复查侧的等待关掉了**：
skip 出现之后，同一段日志里再没有一次复查超时。这条以前只有单测，现在有真机读数。

### 2.2 判别「提供方没发」与「我们丢了」的读数是**不存在**的

把 290 个 `toolCallId` 拿去全日志反查：除了 `permission request received`（290）与复查的批准行（184），
**没有任何一行**提到这些 id 的 `tool_call` 更新。原因是 `observeToolCall` 里的三条丢弃分支（标题不是 MCP 名、
解析不出身份）**一条日志都没有**，而缓存命中那一半也只在解析等待者时才起作用。

于是两种完全不同的成因在日志里长得一模一样：

- **A 提供方真的没发**（那就该按「这次等待买不到东西」处理）；
- **B 提供方发了，但被我们的标题/身份判据丢了**（那是**我们自己的缺陷**，修法是放宽判据甚至改缓存键）。

本轮不能凭直觉在 A 与 B 之间选一支——所以交付的是**把这条路每一环变成数**，而不是猜一个修法。

## 3 交付

| 位置 | 改动 |
|---|---|
| `permission-broker.ts` | `recordPermissionDecision` 补齐**四态**：`automatic`（首判与「实时自动放行」两条路）、`remembered-grant`、`session-grant`、**`card`**（`enqueuePermissionRequest`，即真正弹卡那一刻）。字段只有 `sessionId / toolCallId / decision / isMcp / rawInput('present'|'missing') / tool / profile`：**不记标题、不记入参内容**，`rawInput` 只报「有没有」——那 1 秒等的正是它 |
| `permission-context.ts` | 新回调 `onOpenCodeInputWaitOutcome`：**每一次**走过这条路的请求都报一次 `input-present / resolved / timeout / cancelled` 与 `waitedMs`（`resolved` 以前**一声不响**，现在有分母了） |
| 同上 | 新回调 `onOpenCodeToolCallUpdateUnusable`：带**入参**的 `tool_call` 更新被丢弃时具名报出 `reason: 'not-an-mcp-title' | 'unresolved-identity'` 与**标题**（工具名，截断 120 字符；**从不记入参本身**）。上面 A/B 的判据就落在这里 |
| 同上 | 新回调 `onOpenCodeInputArrivedLate`：超时**之后**才到的入参报 `lateMs`（按 `toolCallId` 有界记账，上限 32/会话，会话清理即删）。A/B 之外还有第三种成因 C——「只是迟了」，这条把它分出来 |
| `runtime-session-composition.ts` | 三条回调接成三条具名日志：`OpenCode permission input wait outcome` / `OpenCode tool call update unusable as permission input`（warn）/ `OpenCode permission input arrived after the wait gave up` |
| 用例 | 新增 5 条：决定四态的取值顺序（`automatic` → `card` → `session-grant`）且**不含入参内容**；`input-present` 不计时；`resolved` 报 `waitedMs: 40`；`timeout` 报 `waitedMs: 1000` 且随后到达的入参报 `lateMs: 250`、**只报一次**；不可用更新报 `reason`+`title`，**没带入参的更新不产生噪声** |

## 4 门禁（全部实跑，取自最后一次改动之后）

| 环 | 读数 |
|---|---|
| `npx vitest run src/main/acp/permission-context.test.ts src/main/acp/permission-broker.test.ts` | **2 files / 116 passed**，exit 0 |
| 新增 5 条用例 | 逐个具名跑出（`--reporter=verbose` 命中 5/5） |
| **变异自证**（同时挖掉三处：`card` 决定记录、等待结果回调、不可用更新回调） | 恰好 **4 条红**：决定记录 1 条、`resolved` 1 条、`timeout`/`lateMs` 1 条、不可用更新 1 条（`4 failed | 112 passed`）；恢复后 116 全绿 |
| 双 typecheck（`--composite false`，堆 8192） | node **0**；web **0** |
| `eslint --no-cache`（本单元 5 文件） | **0 error**（顺手修掉一条 prettier 折行告警，现 0 problems） |
| `npx vitest run src/main/acp --maxWorkers=2`（整个域） | **89 files / 1457 passed**，exit 0 |

## 5 边界（不许读成更强）

1. **本单元没有改等待行为**：`OPENCODE_PERMISSION_CONTEXT_WAIT_MS = 1_000` 与「等 / 不等」的判据一个字没动。
   理由是 A/B/C 三种成因**都还没有数**，先动行为就是猜（§2.2）。
2. **没有取到新代码的真机读数**：本机此刻空闲页 4,176（≈68 MB）、swap 17.6G/18.4G，dev 实例**没有重启**
   （重启要重编 vite 包，这个内存位会拖死整机）。所以上面所有真机数字都来自**旧构建**的日志基线，
   新日志行**尚未**在真机上出现过——下一轮的解封条件写在 §6。
3. **`lateMs` 只在内存里记账**，重启即丢；它要回答的是「迟到的比例」，不是「某一次的历史」。
4. **决定记录不含入参内容**是有意的：这条日志会长期开着，它的职责是「谁决定的」，不是「决定了什么」。
5. **不改复查侧任何行为**：那一半已在真机确认关闭（§2.1），本单元只补主会话侧的可见性。

## 6 下一轮的判据（先取数，再动手）

dev 实例下次以本提交构建重启后，按这四张表读数，**修法由数决定**：

| 读数 | 读法 |
|---|---|
| `OpenCode permission input wait outcome` 按 `outcome` 计数 | `resolved` 占比 ≈ 0 ⇒ 这条等待在主会话族里**从来没买到过东西**，可考虑按族跳过（沿用 `awaitsProviderInput` 那条既有缝）；`resolved` 有可观占比 ⇒ 等待有效，只能谈「值不值这 1 秒」 |
| `permission decision` 按 `decision` 计数（同一批 `sessionId`） | 那 106 形态若是 `automatic`/`remembered-grant`/`session-grant` ⇒ **没人看过入参**，等待是纯延迟；若是 `card` ⇒ 卡片确实需要它 |
| `OpenCode tool call update unusable as permission input` | 出现 `not-an-mcp-title` + 裸工具名形态 ⇒ 成因 B（**我们的判据丢了入参**），修缓存键/身份判据，**不许**去放宽等待 |
| `OpenCode permission input arrived after the wait gave up` 的 `lateMs` 分布 | 出现即成因 C（只是迟了）⇒ 修法是放宽或改成「先发卡、后补入参」，**不是删掉等待** |

一句话：**先让这四张表有数，再决定那 1 秒该不该付**；本轮只是把「付没付、付给谁、等到了没有」变成可核对的四行。

> 2026-10-23 补：四张表已在真机上取到第一份读数，见 `2026-10-23-correction-wait-attribution.md` §2。
> 其中**表三的判据要收紧**：只按 `reason === 'not-an-mcp-title'` 计数会把**非 MCP 原生工具**的正常丢弃
> 误报成「我们的判据丢了入参」（实测 65 条里 53 条同 `toolCallId` 被应用自己判成 `isMcp: false`，0 条是 MCP 请求）；
> 正解是再看「同 `toolCallId` 是否是一次 MCP 权限请求」。
