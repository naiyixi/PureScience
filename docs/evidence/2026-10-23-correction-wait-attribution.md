# 修正回合那一等：四张表的第一次真机读数，以及「修复轮 28 次、零次重审」

日期：2026-10-23 · 单元：① 上一单元留下的四张表取数（`2026-10-23-permission-input-wait-observability.md` §6）；
② 修复轮（fix loop）在「修正回合没进持久层」时把三种成因分开
· 提交范围：`src/main/reviewer/orchestrator.ts`（等待结果改成具名五种状态 + 拒绝行带诊断字段）
＋ 新增 `src/main/reviewer/orchestrator-correction-wait.test.ts`

## 0 一句话

上一轮埋的四行数**第一次在真机上出现了**：主会话那 1 秒**一次都没付**（0 超时、0 等到、1 次入参本来就在），
而「不是 MCP 工具却带着入参被丢」的 65 条**不是我们丢的**（53/65 是应用自己判成 `isMcp:false` 的原生工具）。
顺手在同一个语料里数出另一件事：**自动审查的修复轮 28 次进入、0 次重审** —— 28 次「修正回合已结束」之后，
28 次都判「没进持久层」。这句话把三种完全不同的成因糊成了一句，本轮把这三种分开（不改行为、不放宽判据）。

## 1 语料与窗口

| 项 | 值 |
|---|---|
| 日志 | `~/Library/Logs/PureScience (DEV)/main.{2,1,}.log` |
| 行数 / 体积 | **37,715** 条 JSON 行 / 14.9 MB（21,442 + 722 + 15,551） |
| 窗口 | **2026-10-21T14:16:14Z → 2026-10-23T13:45:17Z** |
| `app starting` 按版本 | 2.15.3 **59** 次 / 2.16.0 **8** 次 |
| 四张表的取数窗口 | **≥ 2026-10-23T11:30:49Z**（`f2bfd5dd` 的提交时刻；此后起的实例都带着那四行） |

> 本轮的读数**全部是只读**：dev 实例由桌面会话自己重启（最近一次 `13:42:53Z`，版本 2.16.0），我没有重启、
> 没有起新实例。新日志行之所以有数，是因为新构建已经在跑；这不是「我为了取证重启了实例」。

## 2 四张表（上一单元 §6 要求的那四条）

### 2.1 表一 `OpenCode permission input wait outcome` 按 `outcome`

| outcome | 次数 |
|---|---|
| `input-present` | **1**（`waitedMs: 0`） |
| `resolved` | 0 |
| `timeout` | 0 |
| `cancelled` | 0 |

**等待请求的账目是闭合的**：窗口内 `permission request received` **95** 条 = **63** 条 MCP + **32** 条非 MCP；
63 条 MCP 里 **62** 条走了 `skipping OpenCode input wait`（`reason: identity-only-decision`，复查会话，`f2bfd5dd` 之前那笔的修复），
剩下 **1** 条走等待并立刻拿到入参（`input-present`，0 ms）。**62 + 1 = 63**，没有第三种去向。

⇒ 在这个窗口里**那 1 秒一次都没付**。但样本量是 **1**（主会话 MCP 权限请求在这一小时里只有 1 次），
所以这张表**还不能回答上一单元的 106 次**——它只证明了仪器在工作、且账目能闭合。

### 2.2 表二 `permission decision` 按 `decision`

| decision | isMcp | profile | rawInput |
|---|---|---|---|
| `automatic` **32** | `false` **32** | `full` **32** | `present` **32** |

⇒ 这 32 条**全部是非 MCP 工具**（所以它们根本没进等待路径，见 2.1 的账目），全部由 `full` 档**自动放行**、
入参本来就在。它们对「主会话 MCP 那 106 次该不该付 1 秒」**不构成证据**：`card` 与 `remembered-grant`
在这个窗口里一次都没出现过。上一单元 §6 表二想要的判别（「没人看入参 ⇒ 纯延迟」）要等出现 MCP 权限请求才成立。

### 2.3 表三 `OpenCode tool call update unusable as permission input`

**65** 条，`reason` **100% 是 `not-an-mcp-title`**（无一条 `unresolved-identity`）。标题形态：`read` 25、`skill` 11、
`bash` 7、其余是 `ls -la …` 这类**命令行本身**当标题。

上一单元 §6 把「`not-an-mcp-title` + 裸工具名」写成「成因 B：**我们的判据丢了入参**」。**本窗口的数据说明那条判据要收紧**：

| 检查 | 值 |
|---|---|
| 65 条里，`toolCallId` 同时出现在 `permission request received` 的 | **53** |
| 其中被应用自己标成 `isMcp: true` 的 | **0** —— 53/53 都是 `isMcp: false` |
| 属于 MCP 权限请求却被丢弃的 | **0** |

⇒ 这些更新本来就是**非 MCP 原生工具**（读文件、跑 shell、加载 skill）的 `tool_call`，它们不会、也不该被当成 MCP
权限入参。**不是成因 B**。判据的正确写法是：**同 `toolCallId` 是 MCP 权限请求、而入参被判不可用** 才是我们丢了东西；
只看 reason 字符串会把这一族正常丢弃误报成缺陷。

### 2.4 表四 `OpenCode permission input arrived after the wait gave up`（`lateMs`）

**0** 条。⇒ 窗口内没有「只是迟到了」的样本（成因 C 未出现）。

### 2.5 四张表合起来说的一句话

窗口内**那 1 秒没有被任何人付过**，也**没有任何一次因为丢弃入参而让卡片少东西**；因此「该不该付」这件事在本窗口
**没有数据可判**，只能等 MCP 权限请求自然出现。把「没有样本」写成「已证明不需要」是失真，本节到此为止。

## 3 同一个语料里的另一件事：修复轮 28 次进入、0 次重审

| 读数（全语料） | 值 |
|---|---|
| `review triggered` / `runReview started` / `review created` | 117 / 117 / 117 |
| `review complete` | **101** |
| `review protocol incomplete`（error） | 15 |
| `submit_findings evidence access validation failed` | **54** |
| 其中**重试后成功提交**（同 run 内随后 `submit_findings received by MCP handler`） | **54 / 54**，丢失 0 |
| `injecting [Auditor] message into main session` | **28** |
| `[Auditor] correction turn complete` | **28** |
| `correction turn did not reach durable session storage; refusing stale re-review` | **28** |
| `fix loop: running re-review`（真正重审） | **0** |

两条结论：

1. **取证访问闸门是好的**：54 次「没读活动执行日志就提交」全部被拒，**54 次都在同一轮里补读后提交成功**，
   0 次丢审。这条不是缺陷（它是 fail-closed 的正确形状），代价是每族多一轮。
2. **修复轮从来没跑通过一次**：28 次进入、28 次「修正回合已结束」、28 次判「没进持久层」、**0 次重审**。
   28 次的 `round` 全是 **0**（第一轮就没过去），`timeoutMs` 全是 10,000。
   从「修正回合结束」到判词的时间：27 组可配对的里 **26 组是 10.0–10.1 s**（等满），1 组 1.0 s
   （生产侧没有任何调用方覆盖 10 s 默认值，这一组更像我的配对方式而非不同的预算，故不据此下结论）。

　　**这句话以前只有一句**：「修正回合没进持久层」。它对下面三种情况**同样成立**，而三种的修法完全不同：

| 形状 | 含义 | 修法方向 |
|---|---|---|
| `session-missing` | 等待期间**一次都没读到**这个 Session（根本没有写入方 / 根不对） | 写入方或根的问题，与「慢」无关 |
| `no-new-agent-message` | Session 读到了、也长了，但**没有新的 agent 消息**（只有用户消息或根本没长） | 修正轮本身没有产出，或快照比它新 |
| `agent-message-incomplete` | 新的 agent 消息**在**，`status` 却不是 `complete`（`streaming` / `error`） | 落盘时机或状态机的问题，等待再久也没用 |

## 4 交付（可见性，不是行为改动）

| 位置 | 改动 |
|---|---|
| `src/main/reviewer/orchestrator.ts` | `waitForCorrectionAgentMessage` 的返回从 `{…} \| undefined` 改成**具名五态**：`found` / `aborted` / `session-missing` / `no-new-agent-message`（带 `newMessages` 与最后一条的 `role`/`status`）/ `agent-message-incomplete`（带 `messageId` 与 `messageStatus`），每个都带 `polls` 与 `elapsedMs`；新增 `waitDiagnostics()` 把非 `found` 的态映射成日志字段 |
| 同上 | 拒绝那一行**消息文本不变**（`correction turn did not reach …; refusing stale re-review`，这样语料里的计数仍然可比），新增 `reason` + 上面那些字段；abort 分支改成按返回态判定，语义不变 |
| `orchestrator-correction-wait.test.ts`（新） | 6 条：找到（含 `polls`/`elapsedMs`）、`session-missing`、只有用户消息（`newMessages: 1`、`lastRole: 'user'`）、**根本没长**（`newMessages: 0`）、**`streaming` 的 agent 消息不被接受**（报 `messageStatus: 'streaming'`）、已 abort 时**不去问 provider** |

**没动的**：等待预算 10 s、「要不要等」的判据、拒绝后把未处理项标 `unaddressed` 的行为、用户可见文案
（disposition 的 note 仍是 `The correction turn did not reach durable storage.`）。本轮只让下一次出现时**能归因**。

## 5 门禁（全部实跑，取自最后一次改动之后）

| 环 | 读数 |
|---|---|
| 新用例单独 | **1 file / 6 passed**，exit 0 |
| 变异 ①：把「非 complete 的 agent 消息」并进 `no-new-agent-message` | `streaming` 那条**红**（1 failed / 5 passed），恢复后全绿 |
| 变异 ②：把「从没读到 Session」并进通用分支 | `session-missing` 那条**红**（1 failed / 5 passed），恢复后全绿 |
| `src/main/reviewer` 整域 | **27 files / 306 passed**，exit 0（本单元 +1 file / +6 tests） |
| 双 typecheck（`--composite false`，堆 8192） | node **0**；web **0** |
| `eslint --no-cache`（2 文件） | 见 §5.1 |
| `prettier --check`（2 文件） | 全过 |

### 5.1 门禁读数取法

`npx tsc --noEmit -p tsconfig.node.json --composite false`、`-p tsconfig.web.json` 同参数；eslint 用
`--no-cache`（`npm run lint` 带缓存，会漏 CI 抓得到的东西）；每条都读它**自己的退出码**，不经过管道。

## 6 边界（不许读成更强）

1. **没有改修复轮的判定与预算**：10 s 与「读不到就拒绝」一个字没动。三种成因的比例**还没有数**。
2. **28/28 的根因仍未定**：三种形状现在能分开，但要在下一次真机出现时按 `reason` 计数才有数。
   本轮**不许**把「大概是没写入方」写成结论——语料里这 28 个 Session 的持久化目录已被清理，无法回看。
3. **四张表的样本量是 1（主会话 MCP 权限请求）**，见 §2.5；不能拿它回答上一单元的 106 次。
4. **表三的判据要按本文件收紧**：只看 reason 字符串会把非 MCP 原生工具的正常丢弃误报成「我们丢了入参」；
   判据是「同 `toolCallId` 是 MCP 权限请求」。
5. 不占版本号：无用户可见文案、无窗口读数、无行为变化。

## 7 下一轮第一步

1. 按完整 40 位 SHA 读本笔的 `Nightly` + `Windows Full Test`（`cancelled` 不算绿；推送前先查在飞车道）。
2. 修复轮的下一次真机出现：按 `reason` 三态计数（`session-missing` / `no-new-agent-message` /
   `agent-message-incomplete`）。**只有** `no-new-agent-message` + `newMessages: 0` 连续出现，才说明「修正轮没有产出」；
   若是 `session-missing`，问题在写入方/根，先去查谁该写这个 Session。
3. 主会话 MCP 权限请求一出现，回到 §2.1/§2.2 补表一表二（判据不变：`resolved ≈ 0` 且无 `card` ⇒ 谈跳过）。
