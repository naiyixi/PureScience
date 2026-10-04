# 交接失败：把「重试从哪一步接上」印出来 —— 证据（2026-10-04）

## 缺口

普查点的是 ACP 事件上的 `handoffFailure.failedPhase`（`shared/acp.ts:99`，两相：
`stop-or-reconfigure` / `continuation-start`，产出点 `runtime-coordinator.ts:536`）。
逐层读下去，找到一个**更该先修的近亲**——同一个事实在**转录行的载荷里早就有**，只是屏幕不读：

- `HandoffLifecycleFailure`（`shared/handoff-lifecycle.ts:60-63`）**必填**字段
  `retryFrom: 'switching' | 'reconfiguring' | 'continuation-start'`——**重试会从哪一步接上**；
- 它**驱动行为**：main 就是按这个值决定恢复路径（`src/main/agents/app-handoff-runtime.ts:82-90`）产
  `completion-gate.ts:386-425`；
- 而转录行 `HandoffLifecycleStatus.tsx` 失败时**只印自由文本 `message`**（`:75`）——于是
  「运行时**根本没被重构**」与「重构完了、只是续跑没起来」在屏幕上**读起来一模一样**。
  投影（`handoff-lifecycle-projection.ts:71`）是原样携带 `failure`，没丢；丢在组件。

## 改法

失败行在 `message` 之外，把**接续点**也印出来（`data-testid="handoff-retry-from"`），
文案手动插 `{target}`（沿用该文件既有的约定：转录套件会走不做插值的回退字典，状态行在那里也必须成句）。
新增 3 键 × 9 语：`handoff.retryFrom.switching` / `.reconfiguring` / `.continuation-start`。

## 读数

`HandoffLifecycleStatus.integration.test.tsx` —— **3 passed**，两相各自断言且互斥：

| 夹具 | 断言 |
| --- | --- |
| `retryFrom: 'reconfiguring'` | 行内出现 `retry resumes at reconfiguring Data analyst`（在既有「无法续跑 + 原文 message」断言之后新增） |
| `retryFrom: 'continuation-start'` | 行内出现 `retry resumes at the continuation`，且**不出现** `retry resumes at reconfiguring` |

其他：`translation-quality` **42 passed**；`typecheck:web` **0**；`eslint` 0 problems。

## 未取 / 未覆盖（具名）

1. **ACP 侧那条（`AcpHandoffFailure.failedPhase`）仍未读**：它是**另一个面**（ACP 错误事件 /
   桌面通知那一支，产出点 `runtime-coordinator.ts:530-545`），不是这次改的转录行。⇒
   **普查里的 `failedPhase` 只算部分结案**：生命周期行现在说出了接续点（更可行动的那一半），
   ACP 错误事件上的相仍未上屏，**继续挂着**。
2. **真窗口读数未取**：需要一次真实专才交接失败（`Specialist handoff failed` 那条错误事件）。
   本轮验证停在真实组件的集成测试（真投影 + 真语言提供者）。

## 顺带

上一轮踩的坑（脚本插 i18n 时锚点必须落在**整条条目之后**）这次先用上了：插入前判跨行，
九份字典一次插对，门禁直接 42 passed。
