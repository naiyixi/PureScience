# 修正回合的 stop 又触发了一次评审：两份并发评审 + 撞车的 [Auditor] 注入（19 次）

日期：2026-11-10 ｜ 单元：自动复核在修正回合期间又起一份 ｜ 证据等级：真机日志读数 + 全量单测（真机窗口读数未取，见 §五）

## 一 读数（打包版真机日志，2026-11-09 同一 run）

来源：`~/Library/Logs/PureScience/main.log`（2.26.0）、`main.1.log`。同一 `runId` 下时间线：

```
10:46:44.354  acp | prompt stopped {stopReason: end_turn}            ← 修正回合结束
10:46:44.361  reviewer:correction | [Auditor] correction turn complete
10:46:45.082  reviewer:orchestrator | fix loop: running re-review   ← 修复环自己再审这一回合
10:46:45.203  reviewer:ipc | review triggered {turnMessageId: message-1794221199544-8}
10:46:45.781  scoped re-review created {reviewId: cmw94zapj…}
10:46:45.943  review created {reviewId: cmw94zau8…}                  ← 第二份复核
10:46:47.504  reviewer session started {sessionId: d3821ceb…}
             （同时 4eeaae1a… 也在跑：两个 reviewer session 交替请求权限）
10:49:40      review complete {outcome: flagged, checkCount: 5}；toolCalls 143
10:49:40      reviewer:correction | injecting [Auditor] …
10:49:40      error reviewer:correction | correction prompt sendPrompt failed
              {"error":"An ACP prompt is already running for this session"}
10:49:40      warn reviewer:orchestrator | correction failed in fix loop — marking remaining
              checks unaddressed {"round":0,"openCount":1}
```

计数：`An ACP prompt is already running for this session` 在 `main.log` 3 次、`main.1.log` 16 次，共 **19 次**；
三次都落在同一 `runId`（4c440a91…）、同一 `mainSessionId`、`round:0`、`openCount:1`。

## 二 归因（读源码定死，不是猜）

1. 抑制旗标只住在**渲染层**（`src/renderer/src/lib/acp/workspace-events.ts:56`，第 431 行消费）。主进程那侧对
   `reviewer:suppress-next-auto-review` 只做 `broadcastToRenderers`（`src/main/reviewer/ipc.ts`），**没有消费者**。
2. 自动复核的**权威触发点**已在主进程（`src/main/ipc.ts` 订阅 `stop/end_turn` → `triggerAutoReviewForTurn`）
   ⇒ 无窗口/CLI 回合根本不受那个旗标约束。
3. `[Auditor]` 修正 prompt 是**普通 prompt 回合**：它的 stop 与用户回合的 stop 同形，而修复环本来就会用
   scoped re-review 再审这一回合 ⇒ 主进程又开一份 = 同一回合被审两遍（本例：两个 reviewer session、各 143 次工具调用）。
4. 两份复核各自跑修复环：先完成的注入了修正 prompt（回合开始流式），后完成的注入时撞车，把 `openCount` 条检查
   标成 `unaddressed`，落库说明只有一句「The correction prompt failed.」——与「sendPrompt 真的坏了」无法区分。
5. 按 `turnMessageId` 的幂等也挡不住：修复环取修正回合的**首条** agent 消息（`message-1794217520869-7`），
   自动复核取**最新一条** complete 的 agent 消息（`message-1794221199544-8`）——同一回合两个 id，幂等键对不上。
6. **更根本的一处接线缺失**：主进程触发器的请求里**没有 `origin`**。而审查侧两道保护（按回合幂等、本轮新增的
   归属闸）都以 `request.origin === 'auto'` 为前提 ⇒ 主进程这条真实路径上两道保护一道都没生效。

## 三 交付

| 位置 | 改动 |
|---|---|
| `src/main/reviewer/auto-review-trigger.ts` | 请求带上 `origin: 'auto'`（类型里写清为什么必须有它：它才是审查侧两道自动保护的开关） |
| `src/shared/reviewer.ts` | `ReviewRunNotStartedReason` 增加 `'fix-loop-active'`，并写明「永不重试」与「手动复核不受影响」 |
| `src/main/reviewer/ipc.ts` | `triggerReview` 最前面加**归属闸**：`origin === 'auto'` 且 `fixLoopAbortControllers` 有该会话的键 ⇒ 不启动、返回 `{started:false, reason:'fix-loop-active'}`，并写具名日志 `auto review skipped: the fix loop owns this session` |
| `src/main/reviewer/correction.ts` | 新增 `CorrectionFailureReason = 'session-busy' \| 'provenance-failed' \| 'send-failed'` 与 `classifyCorrectionFailure`；失败日志带 `reason`，`onCorrectionFailed(reason)` 把原因交给上层 |
| `src/main/reviewer/orchestrator.ts` | `CORRECTION_FAILURE_NOTES` 按原因给用户可见说明；`correction failed in fix loop` 一行带上 `reason`；派生 provenance 抛错归 `provenance-failed` |

两条设计判据：① **判据是状态不是时序** —— 修正轮次的生命周期已有权威来源（`fixLoopAbortControllers` 的增删挂在
`onFixLoopStart` / `onFixLoopEnd` 上），用它比再算一遍时序可靠；闸放在**唯一入口**（`triggerReview`，`run` 与
IPC 是同一个函数），窗口、Web 面、CLI 三条路一起受管。② **拒绝要具名** —— `started:false` 若是静默的，就与
「没有回合」同形，所以给具名 reason + 具名日志；撞车这一类另有具名落库说明
（`The fix could not be sent: another turn was already running in this session.`）。

## 四 门禁（实跑，取自最后一次改动之后）

| 环 | 读数 |
|---|---|
| `vitest run src/main/reviewer`（整簇） | **28 files / 350 passed**，exit 0 |
| 全量 `vitest run --maxWorkers=4` | **1473 passed \| 31 skipped（1504 文件）**；**18414 passed \| 228 skipped（18642）**；235.57 s；exit 0 |
| `tsc --noEmit`（node / web，`--composite false`，堆 4096） | 各自 exit 0 |
| `eslint --no-cache .` | **0 error**（本单元 6 个文件 0 error / 0 warning） |

**变异自证**：把归属闸的条件短路成 `false && …` ⇒ 新用例当场红
（`expected { started: true } to deeply equal { started: false, reason: 'fix-loop-active' }`），改回后 35 例全绿。

新增用例：① 修正轮次期间自动请求被拒（且手动照常、轮次收尾后同一自动请求恢复）；② 触发器请求带 `origin:'auto'`
（少了它两道自动保护都不会生效）；③ 撞车 → `session-busy`、认证错 → `send-failed`、纯分类不做联想。

## 五 边界（不许读成更强）

1. **真机窗口读数未取**：`vm_stat` 空闲页 4,183 × 16 KB ≈ 67 MB、swap 7,399 / 8,192 MB 已用 ⇒ 起 Electron 会把
   机器拖进抖动。本轮证据是「真机日志读数 + 源码归因 + 全量单测」，**不是**「装出去的实例不再起第二份」。
2. **验收判据（下一版装出去之后读同机日志）**：同类回合后应出现
   `auto review skipped: the fix loop owns this session`，且 `main.log` 不再新增
   `An ACP prompt is already running for this session`。两条一起才成立。
3. **闸只管自动路径**：手动「请求复核 / 重跑」在修正轮次里仍可启动（用户明确要求时应当能跑），这是有意的。
4. **不去动回合身份（`turnMessageId` 幂等键）**：把「同一回合多条 agent 消息」合成同键要先定义「一个回合」，
   牵动 Review 表与投影，属独立单元；本轮用状态闸从源头不再发第二次请求。
5. **残余撞车仍可能来自用户自己的回合**（修正 prompt 注入的瞬间用户点了发送）。这一态现在有具名落库说明，
   **不做重试**——重试会把同一批 findings 注入两次。
6. 渲染层的一次性旗标**保留**（窗口自己还会发起复核），但它不再是唯一防线；本轮没有改它。
