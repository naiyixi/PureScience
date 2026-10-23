# 闸门说「是 MCP」、入参恢复说「标题解析不到」：18 条无读数的请求逐条归位（1 条是真分叉，17 条是另一种框架）

日期：2026-10-24 · 单元：`docs/plan-2026-10-03-next-queue-and-round-convention.md` §两百二十一 §6 第 3 条定的下一单元
· 提交范围：`src/main/acp/permission-context.ts`（判据合流 + 一次一行的分叉读数）＋
`src/main/acp/permission-context.test.ts`（3 条新用例）＋
`src/main/acp/runtime-session-composition.ts`（一行日志接线）

## 1 问题提法

§两百二十一 取到的读数是：`05:41:32Z` 之后 `permission request received` 里 `isMcp: true` 有 **125** 条，
而等待侧只留下 **2** 条 `wait outcome` ＋ 104 条 `skipping`，**18 条没有任何等待侧读数**。
当时的推测是「`restoreToolCall` 只用标题判 MCP，裸标题在这里解析不到，于是在等待之前就返回」。

本轮先把这条推测变成读数，再决定改不改。

## 2 两个判据（读源，不是推测）

| 位置 | 判据 | 说明 |
|---|---|---|
| `handleProviderRequest` 的审计行（`permission request received`） | `isMcpToolName(title) ∥ isMcpToolName(extractProviderToolName(toolCall))` | **两个名字都看**；`providerToolName` 来自 `_meta.toolName` / `_meta.tool_name` / `_meta.claudeCode.toolName` |
| `restoreToolCall` 的 opencode 分支 | `isMcpToolName(title)` —— **只看标题** | 不成立且不是原生 skill 候选 ⇒ 直接 `return`，**不落任何等待侧读数** |

两者在这种形状上必然分叉：**标题是裸工具名（`read_turn` / `query_execution_log`），服务器限定名只在 `_meta` 里**。
审计行照样判它是 MCP，而入参恢复这条路看不见它，于是「闸门说是 MCP、等待侧一句话没有」。

## 3 真机读数（只读生产日志；未重启实例，本轮重新聚一遍）

日志 `~/Library/Logs/PureScience (DEV)/main*.log` 三份，**17,808** 条 JSON 行，
窗口 `2026-10-21T15:51:11Z → 2026-10-23T21:02:50Z`（本机日志轮转决定，不是人为截断）。

| 读数 | 值 |
|---|---|
| `permission request received` | **2,042** 行 |
| 其中 `isMcp: true` | **1,396** |
| 这 1,396 条里**有**任一等待侧读数（`wait outcome` / `skipping` / `timed out` / 迟到 / 丢弃） | **396** |
| 这 1,396 条里**没有**任何等待侧读数 | **1,000** |
| 跳过修复（`05:41:32Z`）之后：请求 / `isMcp` / 有读数 / 无读数 | **161 / 125 / 107 / 18** |

> 全窗口那 1,000 条不是缺陷：等待是 **opencode 独有**的机制（`restoreClaudeCodeMcpToolInput`、codex 分支
> 都不做等待、也不落这类读数），所以在别的框架上「没有等待侧读数」是设计。判据只能取到
> 「这条请求属于哪个框架」为止，而日志里没有逐条框架字段 —— 所以下面按 `toolCallId` 逐条归位。

### 3.1 那 18 条逐条归位

按 `toolCallId` 精确配对，18 条分布在 4 个复查会话里：

| 会话 | 条数 | `tool` 字段形态 | 该会话的 opencode 等待读数 | 判读 |
|---|---|---|---|---|
| `ses_e98b8853…`（opencode） | **1** | `purescience_reviewer_query_execution_log`（服务器限定名） | **有**（5 条 `skipping`，同会话另 5 条请求都落了） | **真分叉**：标题裸、`_meta` 有限定名 |
| `0745858e-…` | 8 | `mcp__purescience_reviewer__*` | 0 | 另一种框架（不使用 opencode 等待） |
| `01a16855-…` | 6 | `read_turn` / `query_execution_log` / `submit_findings` | 0 | 同上 |
| `01a1686b-…` | 3 | 同上 | 0 | 同上 |

四条请求每一条都紧跟一行 `approving scope-bounded reviewer MCP tool call`（复查闸门按身份直接放行）。

⇒ 18 条 = **1 条真分叉 + 17 条另一种框架**。原提法「18 条都因为裸标题早返回」是**错的**：
十七分之十六的那部分压根不是 opencode 等待的适用对象，把 18 当成同一个缺陷会去改一条不需要改的路径。

## 4 交付（只做这一件事：让分叉自己报名字，不加大任何等待）

| 位置 | 改动 |
|---|---|
| `permission-context.ts` `restoreToolCall` opencode 分支 | 判据拆成 `titleSaysMcp` 与 `providerNameSaysMcp` 两个具名布尔，再合成 `isMcpRequest` |
| 同上 | 新的 `isMcpRequest = titleSaysMcp ∥ (providerNameSaysMcp && hasOwnInput)`：**只有在请求自带入参时**才按提供方名字认它是 MCP。等待只为「入参为空」的请求而生，所以这条**不可能让任何请求多等一毫秒**（用例用 `setTimer` 未被调用证明） |
| 同上 `reportProviderNameOnlyMcpRequest()` | 每个 `toolCallId` 只报一次、按会话有界（与既有各 store 同纪律），载荷只有 `hasOwnInput` / `awaitsProviderInput` 两个布尔，**不含标题、不含入参** |
| `runtime-session-composition.ts` | 接一行 `info`：`OpenCode permission request names its MCP server only in provider metadata` |

**为什么空入参那半边不改判据**：入参落库那一侧（`observeToolCall` 的 MCP 分支）**同样以标题为准**，
裸标题的更新在那里也进不去 ⇒ 就算把请求认成 MCP 并开始等待，那个输入也永远存不进等待者手里，
只会换来一次确定的超时。那半边要靠「更新侧也认 `_meta`」，是另一件事，先由这条读数决定要不要做。

## 5 门禁（全部实跑，取自最后一次改动之后）

| 环 | 读数 |
|---|---|
| 改动前基线 | `permission-context.test.ts` 18 passed |
| 本文件用例 | **21 passed**（新增 3：自带入参 ⇒ 认 MCP 且报 `input-present` 0 ms；空入参 ⇒ 只报读数、`setTimer` 未被调用；同一调用只报一次且普通形状保持沉默） |
| 变异① 去掉「提供方名字」这半边 | 恰 **1** 条红（1 failed / 20 passed），恢复全绿 |
| 变异② 去掉那行读数 | 恰 **3** 条红（3 failed / 18 passed），恢复全绿 |
| 变异③ 去掉「一次调用只报一次」 | 恰 **1** 条红（1 failed / 20 passed），恢复全绿 |
| `src/main/acp` 整域 | **89 files / 1463 passed**，exit 0（基线 1460，+3） |
| node / web typecheck（`--composite false`，堆 8192） | **EXIT 0 / EXIT 0** |
| `eslint --no-cache` 3 文件 / `prettier --check` | **0 problems / 全过** |

## 6 边界（不许读成更强）

1. **新读数本身还没有真机样本**：它的第一次出现就是这条分叉的下一次发生。本机日志里那条
   （1 条 opencode 分叉）发生在**旧构建**上，不会回溯出这一行。
2. **主会话 MCP 请求仍然没有样本**：`05:41:32Z` 之后 125 条 `isMcp` 请求里，**107 条**有等待侧读数
   （`skipping` 或 `wait outcome`）、**18 条**一条都没有（其中 17 条属另一种框架、1 条是本轮这条分叉）
   ⇒ **主会话那条路一次都没被观测到**。
   「1 秒该不该付」仍然不是已证明不用付，而是没有样本；等待预算一个字未动。
3. **空入参那半边仍会静默早返回**（见 §4 末段）：它有读数（本轮的这行会报 `hasOwnInput: false`），
   但没有修——修它要同时改更新侧，属于下一个单元。
4. 本轮未重启 dev 实例（上一轮的内存闸门：空闲页 4,463 ≈70 MB）。本轮复核 `vm_stat` 空闲页已回到
   **31,902（≈522 MB）**，但 `swap` 用量是 **8.93G / 10.24G**（上一轮 7.96G）⇒ 仍按「不重启」处理，
   真机样本留待与下一次重启窗口一起取。

## 7 同一轮的第二个单元：更新侧那半边的判据也补一个布尔（不修，先量）

§4 末段说「空入参那半边要靠更新侧也认 `_meta`」。做那件事之前必须先回答一个问题：
**提供方到底会不会在裸标题的更新上把服务器名放进 `_meta`？** 旧日志答不了——那条
`OpenCode permission input dropped while a wait was pending` 行里没有这个信息，而标题检查跑在最前面，
`_meta` 里的限定名跟着标题一起被丢掉了。

因此本轮在同一处补一个布尔：`DroppedOpenCodeInput` 增 `hasProviderName`
（`event.providerToolName != null`），并把它透传到日志载荷。

| 位置 | 改动 |
|---|---|
| `permission-context.ts` `DroppedOpenCodeInput` | 新增 `hasProviderName`（带注释说明它区分的两件事：从没说过服务器名 / 说在了我们不看的字段里） |
| 同上 `handleUnusableOpenCodeInput()` | 增一个参数，两条记录（立即报 / 先记着）都带上它 |
| 同上 `reportDroppedOpenCodeInput()` | 载荷透传 |
| 同上 `observeToolCall` 两处调用 | 传 `event.providerToolName != null` |
| `runtime-session-composition.ts` | 那行 `warn` 多一个字段 |
| `permission-context.test.ts` | 新增 1 条用例（裸标题 + `_meta` 限定名 ⇒ `hasProviderName: true`）；两条既有断言补上 `hasProviderName: false`（收紧，不是放宽） |

**为什么这算一个单元而不是半截**：它把「要不要改更新侧」从猜测变成可测量的判据 ——
`hasProviderName: true` 的出现次数就是那条修法的封顶收益；一次都不出现，那条修法就当场作废，
不再花第二个单元。行为一个字未变（判定、等待、上报时机全部照旧）。

### 门禁（第二单元，取自最后一次改动之后）

| 环 | 读数 |
|---|---|
| `permission-context.test.ts` | **22 passed**（21→22） |
| 变异：把该调用点的 `event.providerToolName != null` 换成 `false` | 恰 **1** 条红（1 failed / 21 passed），恢复全绿 |
| `src/main/acp` 整域 | **89 files / 1464 passed**（1463→1464） |
| node / web typecheck | **EXIT 0 / EXIT 0** |
| 3 文件 `eslint --no-cache` / `prettier --check` | **0 problems / 全过**（中途 prettier 要求把回调形参折行，已就地修） |

### 边界

- 新字段**同样没有真机样本**：它随下一份日志一起出现。
- 「更新侧认 `_meta`」这件事**仍未做**；判据是上面那个布尔的出现频率，不是本次交付。

