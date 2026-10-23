# 「我们把提供方入参丢了 77 次」的实际读法：一次都没有 —— 把判据做进生产者，让这条读数不再需要 join 才能纠正

日期：2026-10-24 · 单元：主会话权限等待那条线留下的噪声读数（
`docs/plan-2026-10-03-next-queue-and-round-convention.md` §两百二十 §五 ② 的第二格：
`tool call update unusable` 的 `reason` 分布）
· 提交范围：`src/main/acp/permission-context.ts`（判据重排 + 三处回调分流）＋
`src/main/acp/permission-context.test.ts`（3 条新用例、2 条旧用例改写）＋
`src/main/acp/runtime-session-composition.ts`（一句日志文案）

## 1 为什么做这一刀

§两百二十 给这条通道新加了三行日志，其中 `OpenCode tool call update unusable as permission input`
原本的含义是「一条带 `rawInput` 的更新，我们没法把它当成权限入参，于是丢掉了」。这句话在日志里
读起来就是「我们丢了提供方的入参」——也就是 §两百二十 §四 1 里列的三种成因之一（被我们丢了）。

上一单元（`docs/evidence/2026-10-23-permission-input-wait-observability.md` §2.3）只**收紧了读数侧判据**
（「再看同 `toolCallId` 是不是 MCP 请求」），也就是纠正这件事需要人工 join 四张日志表。本轮把那条判据
**做进生产者**：让「丢了」这条路在源头就只在真的丢了东西时才出现。

## 2 真机读数（只读生产日志，未重启实例；本轮重新聚一遍复核）

日志 `~/Library/Logs/PureScience (DEV)/main*.log` 三份（`main.2.log` / `main.1.log` / `main.log`），
共 **17,804** 行；窗口 `2026-10-21T15:48Z → 2026-10-23T17:00Z`，落在窗口内 **17,804** 条。

| 读数 | 值 |
|---|---|
| `OpenCode tool call update unusable as permission input`（warn） | **77 行 / 49 个 `toolCallId` / 14 个会话** |
| `reason` 分布 | **100% `not-an-mcp-title`**，无一条 `unresolved-identity` |
| 标题形态 | `read` 27、`skill` 12、`bash` 9，其余是 `ls -la …` 这类**命令行本身** |
| 同一调用重复行 | 40 个调用各 1 行、8 个 4 行、1 个 5 行（提供方分块更新 ⇒ 一行调用刷 5 行） |
| 这 49 个调用里**有权限请求**的 | **35**，`isMcp` **100% = false** |
| 这 35 个调用的决定 | **100% `automatic`**（36 条 `permission decision` 里 35 条落在这 35 个调用上） |
| 请求自己的入参 | `rawInput` **100% `present`** |
| 与 290 次 `OpenCode permission context wait timed out` 的 `toolCallId` 交集 | **0** |

结论：那 77 行**一次都不是「我们丢了提供方的入参」**。35 个调用的请求自己带着入参、另外 14 个压根没有
权限请求；而真正等待入参的 290 次超时里，**没有一次**与这些调用重叠。

## 3 交付

| 位置 | 改动 |
|---|---|
| `permission-context.ts` `handleUnusableOpenCodeInput()` | 把同形的三种情况分开：① 已有等待在飞 ⇒ 立即报告；② 等待已放弃（该调用在 `timedOutInputWaits` 里）⇒ 走既有的「迟到」通道（带 `lateMs`）；③ 两者都不是 ⇒ **只记账不报**，留给请求裁决 |
| 同上 `reportRememberedOpenCodeInputDrop()` | 在**请求到来且确实要等入参**的那一刻（`awaitsProviderInput !== false` 分支，紧接 `waitStartedForOpenCode` 之前）才把记得的丢弃上账 —— 这正是「我们丢了这条请求要的字节」 |
| 同上 `reportDroppedOpenCodeInput()` | 一次调用只报一次（有界去重 `openCodeDroppedInputReports`），把「行数」变成「调用数」 |
| 同上 `reportLateInput()` | 改为返回 `boolean`，避免同一条更新被计两次（迟到通道 + 丢弃通道） |
| 同上 `forgetDroppedInputState()` | 调用关闭/取消时把两处记账一起清掉（与既有各 store 同样有界） |
| `runtime-session-composition.ts` | 日志文案改成 `OpenCode permission input dropped while a wait was pending`：旧那句以后不再出现，读数一眼可分新旧 |

**判据为什么必须在请求侧才成立**：提供方的真实顺序是**先发入参、约 300 ms 后才来请求**
（实测：更新 `15:56:54.836Z`、请求 `15:56:55.210Z`）。入参到达的那一刻还没有请求，所以「这次丢弃算不算丢」
在更新侧无法回答；只有等到请求出现、且它确实要等入参，才等于「那些字节就是它要的」。
决定只从工具身份做的请求（`awaitsProviderInput === false`，即 skip 路径）从不读入参 ⇒ 那里丢掉不算丢失。

## 4 门禁（全部实跑，取自最后一次改动之后）

| 环 | 读数 |
|---|---|
| 改动前基线 | `permission-context.test.ts` 15 passed |
| 本文件用例 | **18 passed**（新增 3 条：无人等待保持沉默 + 跳过路径不报；请求确实要等 ⇒ 报一次；迟到 ⇒ 走迟到通道不报） |
| 变异① 去掉「等待在飞则报」分支 | 恰该 2 条红（2 failed / 15 passed），恢复全绿 |
| 变异② 去掉去重 | 恰 1 条红（1 failed / 17 passed），恢复全绿 |
| 变异③ 关掉「请求侧补报」 | 恰 1 条红（`reports the drop when the request … waits`），恢复全绿 |
| `src/main/acp` 整域 | **89 files / 1460 passed**，exit 0（基线 1457，+3） |
| node / web typecheck（`--composite false`，堆 8192） | **EXIT 0 / 0 error** |
| `eslint --no-cache` 3 文件 / `prettier --check` | **0 problems / 全过**（中途咬一次 prettier 折行，已就地修） |

## 5 边界（不许读成更强）

1. **290 次等待超时的入参确实一次都没到**。本单元**没有修**这件事，只是把「我们丢了」这条路从读数里
   去掉了噪声。那 1 秒该不该付，仍然要等 §两百二十 的四张表（`wait outcome` 的 `resolved` 占比等）数出来。
2. **新日志行尚无真机读数**：新文案只在「真的丢了」时出现，而真机在旧构建上从未丢过（交集 0）⇒ 它下一次
   出现本身就应当是一次缺陷证据。本机空闲页 **4,463**（≈70 MB）、swap **7.96G / 9.2G** 仍在闸门内，dev
   实例未重启。
3. **只覆盖 `opencode` 框架**的这条入参通道；`claude-code` 那侧走的是另一条（`ClaudeCodeMcpToolInput`，标题
   必须能解析到已配置服务器），未受影响也未改动。
4. 不占版本号：无用户可见文案、无窗口读数、无行为变化（等待行为一个字未动）。
