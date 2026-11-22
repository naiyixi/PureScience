# [Auditor] 纠正被撞掉：等不到「主轮离开链路」的那条缝，改成「被拒就重发」

2026-11-23。缺陷读数来自装机版自己的日志（`~/Library/Logs/PureScience/main*.log`），修复的读数来自
`src/main/reviewer` 的 27 个文件 / 325 例与两处变异。**没有打包版修复后读数**（见第四节边界）。

## 一 缺陷读数（现取，三份轮转日志全量计数）

| 日志 | 覆盖日期 | 注入 | 成功 | 失败 | 注入前的等待日志行 |
| --- | --- | --- | --- | --- | --- |
| `main.2.log` | 2026-11-05 → 11-09 | 50 | 32 | **17** | **0** |
| `main.1.log` | 2026-11-09 → 11-18 | 17 | 15 | **3** | **0** |
| `main.log`（装机 2.33.2） | 2026-11-22 | 3 | 2 | **1** | **0** |
| 合计 | | **70** | 49 | **21** | **0** |

`26fbc316`（2026-11-18，「纠正等主轮离开链路再注入」）加的正是那条等待，而 2.33.2 里它**一次都没有打印**，
失败仍然发生。也就是说：**预判「主轮还在链路上」的那条缝在生产里从未命中过。**

### 唯一一条修复后的失败，逐字（`main.log`，同一会话 `80bc9e17-…`）

| 时刻 (UTC) | 行 |
| --- | --- |
| 16:00:24.859 | `reviewer:orchestrator | runReview started`（turnMessageId `message-…-47`） |
| 16:01:53.366 | `reviewer:orchestrator | review complete` `{outcome: flagged, checkCount: 5}` |
| 16:01:53.378 | `reviewer:correction | injecting [Auditor] message into main session` `{findingCount: 1}` |
| 16:01:53.380 | `reviewer:correction | [Auditor] correction sendPrompt failed` `{reason: session-busy, error: An ACP prompt is already running for this session}` |
| 16:01:53.381 | `reviewer:orchestrator | correction failed in fix loop — marking remaining checks unaddressed` `{round: 0, openCount: 1}` |
| 16:02:25.981 | `acp | prompt stopped`（同一 sessionId，**比那次拒绝晚 32.6 秒**） |

两件事同时成立：①注入到拒绝之间只有 **2 毫秒**，注入前的等待没有触发；②它撞上的是一次**还在跑的轮次**——
用户已经发出了下一条消息，那条消息又跑了 32 秒才停。

对照组（同一天 16:29，会话空闲时）：注入 16:29:22.160 → 纠正轮 16:30:20.136 完成（58 秒）→ 定点重审 →
`fix loop: finding resolved`。机制本身是通的，被丢的是例外。

## 二 根因：判据与拒绝读的不是同一个时刻

- 拒绝发生在 `src/main/acp/prompt-turn-workflow.ts:167` 的 `assertSessionIdle`，读的是
  `SessionInteractionOwner.current()`（`session-interaction-owner.ts:124`，`activeInteractions`）。
- 预判走 `runtime.getActivePromptSessions()`（`src/main/acp/runtime.ts:644`）→
  `getInFlightSessionIds()` → `sessionInteractions.snapshot()`，**同一个 map**。

同一个 map 读数却在 2 ms 内相反，说明这两次读取之间有一层没被看见：70 次注入里等待**一次也没跑**，
而单位测试注入的是「完整形状」的替身，所以它绿。**这一层到底是运行时作用域（`withActivity` 口径）、
还是代际轮转，本轮没有定因** —— 所以修法不建立在「猜准它」上（见下），只把这条缝具名立案。

## 三 修法：被拒就重发，但有界、且只在「本轮独苗」时

`src/main/reviewer/correction.ts`：

1. **以拒绝为信号**，不再依赖预判：`sendPrompt` 抛 `already running for this session` 时重发，
   预算 `MAX_BUSY_RESEND_ATTEMPTS = 20` × 200 ms（4 秒）。
2. **只在独苗时重发**：新增模块级 `correctionLanes`（按主会话计数，握手之前登记，`finally` 里退出）。
   计数 > 1 表示另有 lane 正在等本次结果去决定是否接管 —— 那时重发会挡住接管，所以不重发。
   这正是既有「两 lane 接管」用例钉住的行为，改完仍然绿（下面变异②证明这条闸是承重的）。
3. **失败行多一个数**：`busyResends`（`0` = 没重发过，被别人占着；`>0` = 前一轮活过了预算），
   让下一次真机失败自证是哪一种形状，不必再从时间线推。

## 四 读数与边界

| 项 | 读数 |
| --- | --- |
| `npx vitest run src/main/reviewer` | **27 files / 325 passed** |
| `npx eslint --no-cache`（改动的两个文件） | **0 error / 0 warning** |
| `npm run typecheck:node` | 我的文件 **0 条**；该项目的 2 条红在会话在制的 `src/main/settings/provider-env.test.ts`（未导入的两个常量），与本单元无关，未动 |
| 变异① 预算置 0 | 两条新用例红（`resends…` / `gives up…`）；还原后 21 例全绿 |
| 变异② 去掉 `alone` 闸 | `takes the slot when the running turn failed…` 红；还原后全绿 ⇒ 该闸承重 |

边界（具名，不许读成已完成）：

1. **没有修复后的真机读数**：要一条「被拒 → 重发 → 落进会话」的日志，需要含本修复的构建 + 一次真实碰撞。
   下一次判据：`grep 'correction refused while the turn in front'` 出现，且同一会话随后出现
   `correction turn complete`；仍失败的那行必须带 `busyResends`。
2. **2026-11-22 那次失败，4 秒预算救不回来**（撞上的轮次又跑了 32.6 秒）。要不要「等用户下一条跑完后
   再补注一次」是产品取舍（会把一条纠正插到后面某轮之后），本轮**没有决定**，只把读数留在这里。
3. **预判那条缝仍未定因**：本单元只保证「预判错了也不会丢」，没有修预判本身。
