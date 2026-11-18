# 中断态会话「报成功却不续跑」：投影不是归属证明

对象：`acp:continue-interrupted-turn`（`src/main/acp/interrupted-turn-continuation.ts`）。
来源缺陷：`docs/verification/2026-11-18-specialist-marketplace-install.md` §十四 第 3 条 ——
带正确 `promptMessageId` 调 `continueInterruptedTurn`，返回 `{"status":"connected"}`，但会话仍是
`status: error`、最后一条仍是无回复的 user 消息；等 6 秒、再等 45 秒都一样。

## 一、判定：代码里只有一条路径能「返回成功且什么都不做」

```ts
// 修改前 src/main/acp/interrupted-turn-continuation.ts:222-234
const snapshot = dependencies.runtime.getSnapshot()
if (
  livePrompt &&
  (snapshot.agentPromptInFlightSessionIds ?? snapshot.promptInFlightSessionIds).includes(request.sessionId)
) {
  return snapshot        // ← 没有 startContinuation，也没有任何日志
}
```

三处佐证它是唯一的候选：

1. `requireInterruptedTurn` 不匹配时**抛错**（`Resume no longer matches …`），那是 API 契约；
2. `startContinuation` 失败会 `throw`，调用方看到的是 IPC 拒绝，不是成功；
3. 只有这一处 `return snapshot` 能在「不启动任何回合」的前提下把快照交回去。

而它读的 `promptInFlightSessionIds` **是投影**：`runtime-coordinator.ts:234-247` 把它从
「每个 runtime 自己的快照」聚合出来，并按 `sessionRuntimes` 归属过滤。换代（retire/重连/中断）时，
旧 generation 的条目可以留在数组里，而主进程那边**已经没有任何一轮在跑**（该 session 的
`pendingPromptStarts` 与 `activePromptCounts` 都已清零）。投影因此把「这一轮早结束了」读成
「这一轮还在跑」，函数据此返回成功 —— 与实测症状逐条对上（会话停在 error、无回复、无提示）。

## 二、修法：归属证据要问登记册本身

| 位置                                                  | 改动                                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `runtime-coordinator.ts:583`                          | 新增 `ownsInFlightPrompt(sessionId)` = `hasSessionInteraction(sessionId)`（pending 启动 + 活跃轮次计数）      |
| `interrupted-turn-continuation.ts:41`                 | 运行时接口加**可选** `ownsInFlightPrompt?`（缺省保持旧行为，替身不必一次性全改）                              |
| `interrupted-turn-continuation.ts:233-252`            | 投影说「在飞」时再问登记册：真在跑 ⇒ 原样返回**并记一条 info**；登记册说没人 ⇒ **继续启动**并记一条 warn     |
| `handler-workflows.ts:39`                             | 组合根契约同步声明该方法（生产传入的就是 coordinator，见 `src/main/ipc.ts:3043`）                            |

两条日志都带 `consequence` 具名取值（`continuation-not-started` / `continuation-started-despite-stale-flag`），
这样下次同一个症状进日志时，「入参没到」与「到了被自己当成就绪」可以一眼分开 —— 在没有这两行之前，
两种成因在日志里**完全同形**。

## 三、门禁（本机实跑，2026-11-18 21:4x）

| 环                                                   | 读数                                                     |
| ---------------------------------------------------- | -------------------------------------------------------- |
| `vitest run src/main/acp/interrupted-turn-continuation.test.ts` | **5 passed**（新增 3：陈旧标志⇒真启动、真归属⇒不启动、无登记册⇒旧行为） |
| `vitest run runtime-coordinator / application-commands / ipc` | **108 passed（3 文件）**                                  |
| `vitest run src/main/acp`（整个主进程 ACP 目录）      | **1512 passed \| 95 文件，exit 0**                       |
| `npm run typecheck:node`                             | exit 0，0 诊断                                           |
| `npm run typecheck:web`                              | exit 0，0 诊断                                           |
| `eslint --no-cache`（4 个改动文件）                   | exit 0                                                   |

## 四、真机读数与边界（不许含糊）

- **本机 dev 实例（`logs/headless.out.log`，401 万行）现取**：`acp:continue-interrupted-turn` 只出现过 2 次
  （第 86007、90191 行），两次之后都紧跟着 `[acp-prompt-turn-workflow] prompt start`（`textLength: 2038` /
  `1832`）。⇒ 这条通道在**该实例的那种状态下**是能真跑的，所以 §十四 的失败不是「人人都中」；
  也正因如此，修复不能靠「再点一次看看」，只能靠把**分支判据**改成登记册，并留具名日志。
- **未取到真机复验**：本次修复需要重建造物（`npm run build:e2e`）后起校验实例才能复现失败态并验证转好。
  本轮机器处于负载闸下（空闲页 4,098 ≈ 64 MB 可用、swap 已用 7.78 GB / 9.2 GB），且同一棵工作树上有
  桌面会话正在用 `out/` 跑自己的校验实例（`/tmp/ps-verify16`，remote-debugging 9333）——
  重建 `out/` 会打断它并与其抢内存。⇒ **本轮不重建、不起实例**，修复按「已由单测与类型检查证伪的候选路径」交付，
  真机复验具名到下一轮（判据：中断态会话点「继续」后 60 秒内出现新的 agent 消息；日志里能看到
  `prompt start`，或至少出现一条 `continuation-started-despite-stale-flag`）。
- **未修的另一半**：§十四 第 1 条「`api.acp.sendPrompt` 返回成功但不产生任何新消息」是**另一条路径**
  （主进程 `prompt-turn-workflow.run` 只有 `checkpoint === 'cancelled'` 会静默 `not-dispatched`，
  而该分支在收口处会 emit 用户消息）。现有证据无法把「请求没到主进程」「到了被判 cancelled」
  「到了但回放/归属失败」分开 ⇒ 按本仓纪律**先立具名日志再谈修**，不在本轮猜着改。

## 五、搜过什么（说不存在/说唯一时的证据）

- `grep -rn "continueInterruptedTurn" src` → 主进程实现 1 处、命令面 1 处、preload 1 处、渲染层调用 1 处；
- `grep -rn "getLatestUserPrompt\|ownsInFlightPrompt" src/main`（改前）→ 只有实现与两处类型声明；
- `grep -rn "resume-required" src --include=*.ts` → 生产代码 3 处（持久化派生 2、续跑校验 1），
  即 `sendPrompt` 路径**根本不看** `resumeRecovery`，这也解释了为什么「直接发新 prompt」在主进程看来完全合法。
