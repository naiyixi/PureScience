# 后台复查每调一次工具就白等 1 秒：把「要等谁来读入参」变成调用方自报

日期：2026-10-23 · 执行器 · 纯 main 侧（无界面改动）

## 一 现象与读数（生产日志，只读）

日志：`~/Library/Logs/PureScience (DEV)/main.log`（11,051 行，2026-10-21 16:09 → 10-22 20:01 UTC）

| 读数 | 值 |
|---|---|
| `OpenCode permission context wait timed out` | **289** 条，`waitMs` 恒 **1000** |
| 其中落在**复查会话**上（该 sessionId 有 `reviewer session started`） | **184** 条，跨 **100** 个复查会话（每会话 1–3 条） |
| 剩下 105 条 | 主会话的 MCP 调用（卡片要显示入参，本单元不动） |
| 184 条之后紧跟的那一行 | **184/184** 都是 `permission request received` |
| 超时行 → 下一行的时间差 | min 0.0 ms / **中位 1.0 ms** / max 16.0 ms |

⇒ 也就是说：这一次等待的**唯一产物**（提供方迟到的 `tool_call` 更新，用来把入参填进权限卡）
在这 184 次里**一次都没到**；等满 1,000 ms 之后，请求立刻被复查自己的规则批准。按日志窗口两天算，
**184 秒**纯延迟，全部付给「没人会读的那张卡」。

## 二 根因（读源，不是推测）

`permission-context.ts` 的 `handleProviderRequest` 对**所有** OpenCode MCP 请求先做一次
`restoreToolCall`，而 `restoreToolCall` 在拿不到入参时会 `await waitForOpenCodeMcpToolInput`（上限
`OPENCODE_PERMISSION_CONTEXT_WAIT_MS = 1_000`）。**这次等待发生在「谁来做决定」之前**：

- 主会话：决定要看入参（卡片渲染 + auto-review 策略读参数）⇒ 等是有意义的；
- 复查会话：决定由 `resolveReviewerPermission` 做出，而它只读 `title` / `kind` /
  `mcpServerNames`（`classifyReviewerToolCall`）——**这条路径一个字节的入参都不读** ⇒ 等是纯延迟。

## 三 交付

| 位置 | 改动 |
|---|---|
| `src/main/acp/permission-context.ts` | `PermissionRestoreContext` 增可选 `awaitsProviderInput`（缺省＝等，主会话行为不变）；`handleProviderRequest` 里由 `reviewerContext === undefined` 决定；`restoreToolCall` 在该项为 `false` 时走 `skipOpenCodeInputWait`（返回 `'ready'`，因为等待的产物对这类决定没有意义） |
| `src/main/acp/permission-context.ts` | 新增 `onOpenCodeInputWaitSkipped`（具名 `reason: 'identity-only-decision'`），**跳过必须自己说出来** —— 否则「有意跳过」与「从来不需要等」在日志里同形 |
| `src/main/acp/runtime-session-composition.ts` | 接上该回调：`info` 级 `skipping OpenCode input wait`（带 sessionId / toolCallId / reason） |
| `src/main/acp/permission-context.test.ts` | 2 条：① `awaitsProviderInput:false` 时不排定时器（`setTimer` 未被调用）、超时回调不响、落具名跳过行；② **路由级**：复查请求（真实 timer）直接拿到批准响应，跳过行带 reason，超时回调未响 |

## 四 门禁（全部实跑）

| 环 | 读数 |
|---|---|
| `src/main/acp/permission-context.test.ts` | **11 passed** |
| `src/main/acp` + `src/main/reviewer` | **115 files / 1,748 passed**，exit 0 |
| 双 typecheck（`--composite false`，堆 8192） | node **0**；web **0** |
| `eslint --no-cache`（3 文件） | **0 errors**（3 条 prettier 警告已 `--write` 收掉，复查 0） |
| `prettier --check`（3 文件） | 全过 |
| 变异（把 `awaitsProviderInput` 写死为 `true`） | 路由级那条**红**，且**耗时 1011 ms** —— 失败时长本身就是被省掉的那 1 秒 |

同一支用例在两种状态下的墙钟：**修前 1011 ms（变异）／修后 50 ms**（含 setup；单跑 verbose）。

## 五 边界（不许读成更强）

1. **只治「复查会话」这一类**：剩下 105 条主会话等待保持原样 —— 那里的入参是卡片与
   auto-review 策略要读的，省掉就能省出一张缺参数的卡。
2. **没有窗口读数**：本机内存闸门未解；本条的证据是「生产日志既有读数（before）」＋「真代码路径上
   的变异/单跑墙钟（before/after）」，**不是**在窗口里点出来的。下一次真机会话会在日志里出现
   `skipping OpenCode input wait`，那才是 end-to-end 的 after 读数。
3. **不改变任何决定**：批准/拒绝/取消三条出口、判定规则、优先级全部未动；跳过的只是「等入参」。
4. 不占版本号（无新的用户可见能力）；它随下一版到达读者，届时才能核到真机日志里那一行。
