# 打开会话时那条「读不到计划」的拒绝：85 次，一次也说不出为什么

日期：2026-10-20 · 单元：`acp:get-plan-projection` 对「主进程还没有这个会话的运行时上下文」不再假装失败
来源：本机真实运行日志（打包版用户实例，只读取证）

## 一 读数（先把账摊开）

日志：`~/Library/Logs/PureScience/main.log`（JSONL，17,306 行，窗口到 2026-10-20 06:38）。

| 读数 | 值 |
| --- | --- |
| `ipc / ipc handler rejected`，通道 `acp:get-plan-projection` | **85 次**（2026-10-16T13:15Z → 10-19T13:35Z，6 个应用运行） |
| 其中能读出「为什么被拒」的条数 | **0** —— 85 条的 `data` 逐字相同，除了 `durationMs`：`{channel, surface, location, principalKind, actionOrigin, errorCategory:"error"}` |
| 拒绝耗时 | 1–9 ms（同步抛出，不是等超时） |
| 同一通道的慢记录 | **173 次**，中位 **273 ms**、p95 **11.0 s**、max **67.4 s**，其中 **47 次 >1 s** |

两组读数合起来说明两件事：这条读被问得很频繁（打开会话就问一次），而**一半是拒绝、另一半在排队**。
拒绝那一半在日志里是 85 行一模一样、只写着 `error` 的告警 —— 看不出是「会话还没落盘」还是「会话 JSON 坏了」。

## 二 它为什么会拒

渲染端在会话打开时立刻读一次计划投影：

- `WorkspacePage.tsx`（`getPlanProjection(...).then(...).catch(() => undefined)`）
- `session-plan/respond-to-session-plan.ts`（答复计划后做一次最佳努力刷新）

主进程侧这条读走 `PlanService.getProjection` → `readRuntimeContext` → `coordinator.readSessionRuntimeContext`，
而后者先 `loadSessionWithDiagnostics`，**磁盘上还没有这个会话的 JSON 就直接 `throw new Error('Cannot read runtime context for a missing Session.')`**
（`coordinator.ts` 的 `loadRuntimeContextSession`）。

也就是：**新建但还没落盘的会话**，一问计划就给一个拒绝。这不是缺陷的边界，而是打开会话的常规时序。

渲染端其实早就把这件事当常态处理了 —— `respond-to-session-plan.test.ts` 里那条用例的注释逐字写着：

> `getPlanProjection` throws for a session main has no runtime context for. That must not escape as a
> rejection: the callers in the workspace await this, and an unhandled rejection there is what the
> renderer failure report recorded.

两边的约定已经一致（「没有计划」是常态），只有主进程还把它说成失败。而这条拒绝的**代价是双向的**：
窗口白拿一次异常，日志被 85 行无法区分的信息占满 —— 真出问题（会话 JSON 读不出来）时，
它和这 85 行长得一模一样。

## 三 交付

| 文件 | 改动 |
| --- | --- |
| `src/main/session-persistence/coordinator.ts` | 新增并导出 `SessionRuntimeContextMissingError`（`code:'session-missing'`），`loadRuntimeContextSession` 的 `missing` 分支改抛它。**`name` 故意保持 `Error`**：被拒 IPC 的诊断把错误名映射成类别，改名会把这些行从 `error` 静默挪到 `object` |
| `src/main/session-plan/plan-service.ts` | `getProjection` 只在这一种错误上回答 `null`（＝「没有计划」，就是实话）；`unreadable` 与其它任何失败照旧抛出 |
| `src/main/session-plan/production-plan-service.ts` | 按既有 `isRevisionConflict` 的同一形状注入 `isMissingRuntimeContext` |
| `src/main/session-plan/plan-service.test.ts` | +3：缺会话 ⇒ `null` 且不再去读文档；JSON 不可读 ⇒ 仍拒；其它失败 ⇒ 仍拒 |
| `src/main/session-plan/production-plan-service.test.ts`（新） | +2：**按应用的方式装配**真实 service，喂 coordinator 真会抛的那个类 ⇒ `null`；喂 `unreadable` ⇒ 仍拒（证明判据是窄的） |
| `src/main/session-persistence/coordinator.test.ts` | +1：钉住这个错误的三件事 —— 身份（`instanceof`）、`code`、以及 `name === 'Error'`（日志类别不会静默变化） |

单元测试用的是「消息匹配」的替身，它只证明分支、证明不了接线（导入写错一处，全部用例照样绿而产品照旧拒绝），
所以另加了一支按产品装配路径走的文件。**变异证明**：把 `isMissingRuntimeContext` 改成恒 `false`
⇒ `production-plan-service.test.ts` **1 failed / 1 passed**（红的正是缺会话那条，`unreadable` 那条仍绿），已还原。

## 四 门禁读数（全部实跑）

| 项 | 读数 |
| --- | --- |
| `src/main/session-persistence` + `src/main/session-plan` + `src/main/acp` | **105 文件 / 1717 passed** |
| 变异证明（判据恒 false） | 1 failed / 1 passed，只红缺会话那条；已还原 |
| `eslint --no-cache`（改动 5 文件） | **0 error**，2 warning（新文件的 prettier 折行，已 `--fix`） |
| 双 typecheck | 本机各 **5 条红，全部在 `src/main/references/repository.ts`**；对**基线提交**（把本轮文件 stash 掉）跑出**同样 5 条** ⇒ 与本轮无关，根因是本机共享的生成客户端比 schema 旧（缺 `citedAt`/`citedSessionId`），CI 侧 `prisma generate` 用带列的 schema |

## 五 顺带立案（本轮不动）

同一通道 **173 次慢读、p95 11.0 s、max 67.4 s**，与 `sessions:save-session` 的排队同源：
`readSessionRuntimeContext` 也走 `coordinator.enqueue`，而该队列是**全局串行**的 —— 一次 118 s 的保存
会把这条只读的计划投影堵到分钟级。这属于真机审计档 §5 第 6 条（保存/投影性能）那一整块，
不在本单元的连锁范围内，故不在此处动它；本单元只去掉「拒绝」这一半的噪声。
