# 中断态续跑：一条「可能报成功却不启动」的早退分支（附归因更正）

对象：`acp:continue-interrupted-turn`（`src/main/acp/interrupted-turn-continuation.ts`）。

> ⚠️ **本档的归因已更正一次，先读这一节再读下面。**
>
> 我最初把「`continueInterruptedTurn` 返回 `{"status":"connected"}` 但会话没有续跑」这条读数，归因到下面
> §一 那个早退分支（把聚合投影当成归属证明）。**这个归因是错的，撤回到「只是可能」**。同一棵工作树上
> 的另一个执行体在 `d02c888c` 里用界面路径复验后撤回了同一批读数，并在 `70ecf7a0` / `6a766d02` 里给出了
> 真正的原因链：
>
> 1. `api.acp.continueInterruptedTurn` 要求会话**先 attach**（应用自己的恢复顺序是
>    `reattachInterruptedWorkspaceSession` → `continueInterruptedTurn` → `markResumed`）；只调 API 而不
>    attach 时，主进程拿不到这个会话，答案是没有意义的。**我这条读数就是这么来的。**
> 2. 走界面的真实恢复路径是好的：同一会话消息数 13 → 17，agent 回复 46 字与 456 字都落库。
> 3. 会反复落进 `error` 的真因是**产物定稿被跳过**（`finalizationSkips: ambiguous-turn-message=1,
marker-owned-by-another-session=30, version-context-mismatch=6`；根因 `root-frame-mismatch`），
>    跳过之后整轮被判失败、界面永久 `error`（`6a766d02` 让新 prompt 开始时清掉上一轮的定稿错误）。
>
> ⇒ 本轮的代码改动因此**降级为「消掉一条可能静默早退的路径 + 留下具名日志」**，不再声称它修好了那条缺陷。

## 一、改动针对的形状（可能，不是已证）

```ts
// 修改前 src/main/acp/interrupted-turn-continuation.ts:222-234
const snapshot = dependencies.runtime.getSnapshot()
if (
  livePrompt &&
  (snapshot.agentPromptInFlightSessionIds ?? snapshot.promptInFlightSessionIds).includes(
    request.sessionId
  )
) {
  return snapshot // ← 没有 startContinuation、没有任何日志
}
```

它读的 `promptInFlightSessionIds` 是**投影**：`runtime-coordinator.ts:234-247` 把各 runtime 自己的快照
聚合起来再按归属过滤。换代（retire / 重连 / 中断）之后，旧 generation 的条目可以留在数组里，
而主进程那边可能已经没有任何一轮在跑（`pendingPromptStarts` 与 `activePromptCounts` 都已清零）——
此时「这一轮早结束了」会被读成「还在跑」，函数返回一份健康的快照，**调用方无从分辨**。

这一条**没有**任何一次实测把它认成真凶（实测那条另有原因，见上）。留它的理由是：
一个「把投影当归属证明」的判据本身就是错的判据，而它出错时**与正常路径同形**。

## 二、改法：归属问登记册，两条分支都留名

| 位置                                       | 改动                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `runtime-coordinator.ts:583`               | 新增 `ownsInFlightPrompt(sessionId)` = 私有 `hasSessionInteraction()`（pending 启动 + 活跃轮次计数） |
| `interrupted-turn-continuation.ts:41`      | 运行时接口加**可选** `ownsInFlightPrompt?`（缺省保持旧行为，替身不必一次性全改）                     |
| `interrupted-turn-continuation.ts:233-252` | 投影说「在飞」时再问登记册：真在跑 ⇒ 原样返回**并记 info**；登记册说没人 ⇒ **继续启动**并记 warn     |
| `handler-workflows.ts:39`                  | 组合根契约同步声明（生产传入的就是 coordinator，`src/main/ipc.ts:3043`）                             |

两条日志各带 `consequence` 具名值（`continuation-not-started` / `continuation-started-despite-stale-flag`）。
在没有这两行之前，「入参根本没到」与「到了被自己当成就绪」在日志里**完全同形** ——
这正是当初把一条 API 读数误诊成产品缺陷的机制。

## 三、门禁（本机实跑，2026-11-18 21:4x–22:0x）

| 环                                                                             | 读数                               |
| ------------------------------------------------------------------------------ | ---------------------------------- |
| `vitest run src/main/acp/interrupted-turn-continuation.test.ts`                | **5 passed**（新增 3 例）          |
| `vitest run runtime-coordinator / application-commands / ipc`                  | **108 passed（3 文件）**           |
| `vitest run src/main/acp`（整个主进程 ACP 目录）                               | **1512 passed \| 95 文件**，exit 0 |
| `vitest run runtime-state-ownership.architecture + runtime-composition-wiring` | **39 passed（2 文件）**            |
| `npm run typecheck:node` / `npm run typecheck:web`                             | exit 0 / exit 0（0 诊断）          |
| `eslint --no-cache`（4 个改动文件）                                            | exit 0                             |
| `scripts/pre-push-checks.sh`                                                   | 全部通过（含品牌词零命中）         |

车道：`46dff33c` 的 `Windows Full Test` = **success**；它的 `Nightly` 被 `6a766d02` 的后一笔推送顶掉
（`cancelled`），按「引包含它的后一笔」口径取 `6a766d02` 的车道判决。

## 四、没取到的读数（具名）

- **没有真机读数**：本轮机器在负载闸下（空闲页 4,098 ≈ 64 MB、swap 已用 7.78 GB / 9.2 GB），且同一棵树上
  的校验实例正跑着 `out/` 产物 ⇒ 没重建、没起实例。这条改动**不需要专门复验**（它的价值是判据正确 + 日志），
  但「中断态续跑」这件事的真机读数已经由另一个执行体在 `d02c888c` 里用界面路径取到（13→17、46/456 字），
  本档直接引用，不重复造一次。
- **仍未修**：会话未 attach 时 `continueInterruptedTurn` 的答案读不出「我没做成什么事」——
  它的返回值只有快照，没有具名结论。要不要改成「未 attach ⇒ 具名拒绝并提示先恢复」属于接口语义变更，
  需要拍板；本档只立案，不改。

## 五、搜过什么

- `grep -rn "continueInterruptedTurn" src` → 主进程实现 1 处、命令面 1 处、preload 1 处、渲染层调用 1 处；
- `grep -rn "getLatestUserPrompt\|ownsInFlightPrompt" src/main`（改前）→ 只有实现与两处类型声明；
- `grep -rn "resume-required" src --include=*.ts` → 生产代码 3 处（持久化派生 2、续跑校验 1）⇒
  `sendPrompt` 路径**根本不看** `resumeRecovery`，直接发新 prompt 在主进程看来完全合法。
