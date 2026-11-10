# 会话队列的「持有者是谁」：62 条慢行把一件从未发生的事报告成了阻塞者

日期：2026-11-10 · 范围：`src/main/session-persistence/**`（+ 三处接线）· 只读输入：`~/Library/Logs/PureScience*/main*.log`

## 一 读数（先量；全部来自真机日志，只读）

`session save was slow` 一行里的 `queueBlockers` 是这条队列的**唯一**归因手段 —— 队列严格串行，所以「谁排在前面」就是谁拖慢了这次保存。九天的日志里带 `queueBlockers` 的行共 **76 条**，阻塞者名称分布：

| 阻塞者名 | 条数 | 中位 | 最大 |
| --- | --- | --- | --- |
| `save-session-specialist-binding` | **62** | 378 ms | **17,212 ms** |
| `read-session-runtime-context` | 9 | 4 ms | 347 ms |
| `assert-session-available` | 5 | 1,061 ms | 2,882 ms |

单条样例（原样，2026-11-05T16:46:32.353Z）：

```json
{"msg":"session save was slow","queuedMs":8192,"queueBlockers":"save-session-specialist-binding=17212ms","totalMs":10696}
```

同刻的 `sessions:save-session` IPC 行 `durationMs` 20,526 ms —— 也就是说一次保存的两万毫秒里有一万七千毫秒在等别人。

## 二 缺陷（不是「误报数字」，是名字指向了一件从未发生的事）

- `saveSession`（真正的保存，含「改专家绑定」那条路）入队标签是 **`save-session`**（`coordinator.ts` 1277 行）。
- **`save-session-specialist-binding` 这个标签只被 `runSessionMutation` 使用**，而它承载的是**所有**会话级副作用：上传落定、产物落定、用户改稿写入、产物溯源建版本/重放、复核记录持久化。
- 全仓 grep：这个字符串在生产代码里只有一处（`coordinator.ts:1508`）；没有任何测试钉它。

因此九天日志里那 62 条「专家绑定占着队列 17 秒」的结论**不成立** —— 那 17 秒里跑的可能是复核持久化、产物落定或上传落定；同时「专家绑定保存」这件事即便发生，也只会以 `save-session` 出现。这一条会把人指向错误的操作：`queuedMs` 一高就先怀疑专家绑定，而真正的持有者从未被点名。

时间线旁证（2026-11-05T16:46 那一窗）：17,212 ms 的持有窗口约 16:46:14.7 → 16:46:31.9，紧接在 `reviewer:correction | correction sendPrompt failed`（16:46:12.637）与 `fix loop — marking remaining checks unaddressed` 之后；窗口内没有上传/产物落定的日志。**这只能说「复核侧嫌疑最大」，不能说「就是复核」** —— 这正是本次要修的东西：日志连名字都给不出。

## 三 交付

| 位置 | 改动 |
| --- | --- |
| `src/main/session-persistence/coordinator.ts` | `runSessionMutation(projectId, sessionId, mutation, label = 'session-mutation')`；标签改为**调用方传入**；新增 `logSlowSessionMutation`：持有 ≥ 1,000 ms 时打一行 `session mutation held the queue`，带 `label` / `ranMs` / `cpuMs` / `cpuShare` / `attribution`（与慢保存同一套 `cpuAttributionFields`） |
| `src/main/uploads/command-owner.ts` | 接线签名可选第 4 参 + 调用点 `finalize-session-uploads` |
| `src/main/artifacts/ipc.ts` | 同上 + `finalize-run-artifacts` / `write-user-edited-version` |
| `src/main/reviewer/ipc.ts` | 同上 + `review-persist` |
| `src/main/ipc.ts` | 四处接线转发标签；产物溯源两处调用点标 `artifact-provenance-create-version` / `artifact-provenance-replay` |
| `src/main/session-persistence/coordinator.test.ts` | 新增 3 例：标签进入自己的慢行与等待者的 `queueBlockers`；缺省标签是中性的 `session-mutation` 且**旧名不再出现**；快于阈值的变异安静 |

**两条设计判据**

1. **标签只由调用方给**：接线层的一个闭包可能服务多个变异（产物那条就同时服务「落定」与「改稿写入」），把名字写在闭包里必然又变成一个大而空的词。名字写在**真正知道它做什么的那一层**。
2. **慢变异的 CPU 归属在持有者这一行算**，不从等待者的 `cpuShare` 反推：等待者的窗口里混着它自己的读盘，两者不是同一个量。

## 四 门禁（全部实跑，取自最后一次改动之后）

| 环 | 读数 |
| --- | --- |
| `session-persistence` + `uploads` + `artifacts` + `reviewer` | **67 files / 957 passed** |
| `coordinator.test.ts`（含新增 3 例） | **120 passed** |
| `tsc --noEmit -p tsconfig.node.json --composite false` | exit 0 |
| `tsc --noEmit -p tsconfig.web.json --composite false` | exit 0 |
| `eslint --no-cache`（6 个改动文件） | **0 error / 0 warning** |

**变异自证（两次，都还原）**：① 把入队标签改回硬编码旧名 ⇒ 两条新用例当场红（2 failed / 3 passed）；② 删掉 `logSlowSessionMutation` 的调用 ⇒ 同样是那两条红。还原后 120 passed。

## 五 边界（不许读成更强）

- **没有真机窗口读数**：新行只在下一次装机后才会出现在 `main.log` 里。装机后的判据两条：① `grep "session mutation held the queue" main.log` 能出现且 `label` 是上表里的具体名字；② 同一段时间里 `queueBlockers` 的字符串**不再**含 `save-session-specialist-binding`（否则说明还有第二条硬编码路径）。
- **本次只让读数可归因，没有让 17 秒变短**。那 17 秒的归属要等第一批带名字的行落地；拿不到就不猜。
- 阈值 1,000 ms 是判断值：低于它的一次变异不会拖慢别人到值得记一行。
- `runSessionMutation` 的校验顺序与 `validatedBindingTopologies` 清理语义**未变**（用例覆盖：tombstone 后拒绝、清理仍在 `finally`）。
