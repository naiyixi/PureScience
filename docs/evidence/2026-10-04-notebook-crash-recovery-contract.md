# 笔记本崩溃恢复契约：一次真机取证，与它没测到的那一半 —— 2026-10-04

## 我原本要取什么

今晚修的徽章（`ff05c41c`）把「问题状态」按真实状态分说，其中一条是
**app-terminated 的中断不再被称作 error**。它**显示**的是记录里的状态，所以关键是**记录里到底写什么**。
契约写在 `src/main/notebook/repository.ts:271-287`：

> 「Crash recovery: **on the first load of a session in a fresh process**, any run still marked 'running'
> (or 'queued') was in flight when the previous process died — its kernel is gone, so mark it 'interrupted'
> with interruptionReason 'app-terminated'（**NOT failed** — the code may have been fine）」

## 取证过程（八次运行，前七次都在纠我自己的探针）

八次里前七次失败的成因**全部落在探针侧**，逐条记下来免得重踩：

| # | 现象 | 真因 |
| --- | --- | --- |
| 1–2 | 重启后 `runs: []` | 我**没传 `projectName`**；运行历史按 `(storageRoot, projectName, sessionId)` 解析（`repository.ts:80-85`），少一个字段就读到另一个根的空白历史 |
| 3–4 | 单元格「在跑」这个前提从没成立 | 我在**默认环境还在准备**时就发单元格——应用自己报的原文：「The Python environment is still being prepared — retry shortly.」 |
| 5 | `Invalid notebook path segment: Interrupted run` | 我的项目名**带空格**，被路径段校验拒 |
| 6 | 等环境就绪等到超时 | 我盯的是 `notebook.state.environments`——而它**在首次运行前按设计就是空的**（V6 诊断量到过 `BEFORE any run: []`） |
| 7 | 默认环境 15 次「still being prepared」 | 隔离实例的**默认环境要下载**才能就绪，本机网络到不了那些源；改走**缓存包导入具名环境**（本会话 V6 已验证单元格真能跑） |

**第 8 次**：前提终于被**实测**站住（`attempt 1: running=true statuses=["completed","running"]`），
然后读数是：

```
[interrupt] runJsonPath=…/notebooks/<projectKey>/e2e-session-1/run.json
[interrupt] cell is running; taking the app away (90s cell)
[interrupt] runs after restart: []                     ← 重启后 notebook.state 返回空
[interrupt] run.json on disk: [["…-1","completed",null],["…-2","failed",null]]
                                                       ← 盘上那格是 failed，interruptionReason 为 null
```

## 结论：一个待取读数，两个已确证的现象（不夸大、不掩盖）

**已确证（两条读数都在同一轮里、同一时刻）**：

1. **重启后 `notebook.state` 返回空运行列表**，而盘上 `run.json` 有两条记录 ⇒ 这次读取**没有加载该会话的历史**。
2. **盘上那格记的是 `failed` 且 `interruptionReason` 为 `null`** —— 与契约承诺的 `interrupted` + `app-terminated`
   **不一致**。

**由此可推、但尚未实测的一环**（这正是契约的触发条件）：
恢复只在「新进程里**首次加载**该会话」时跑（`repository.ts:271`）。而我的读法（`sessions.loadAll()` +
`notebook.state`）**明显没有触发那次加载**（否则读到的不会是空）。所以：
- 我**不能**说「崩溃恢复坏了」——**那次恢复很可能压根没跑**；
- 我也**不能**说「契约没问题」——因为我读到的盘上内容与契约不符。

⇒ **这一条是「未取」，不是「已证伪」**。要把话说完，下一次要取的读数是：**让面板真的打开该会话的笔记本**
（UI 路径，而不是 `notebook.state` 探针），再读盘——那时恢复应当已跑过，盘上应变成 `interrupted` +
`app-terminated`；若仍是 `failed`，那才是真缺陷。

**对我今晚那次徽章修复的反向影响（如实说）**：徽章修的是**显示**（记录说 interrupted 才说 interrupted），
这一点没变、也没错。但**如果**记录在某些路径上被写成 `failed`，读者看到的仍会是 error——**那条路径的
真机读数我这一轮没取到**。所以 `ff05c41c` 的结论文案应理解为「显示与记录一致」，而不是「中断在任何情况下
都不会被显示成 error」。

## 追加：我试了一版修法，**实测无效**，已撤回并立案

**修法（已撤回）**：`session-lifecycle.shutdownAll()` 里「**先**对 `activeSessions()` 调
`repository.reconcileInterruptedRuns`、**再**收内核」，并用单元测试钉住顺序 `['mark','reap']`。
单元 5 passed（顺序、只碰有在飞运行的会话、历史写不进去也能退）。

**真机实测：逐字相同**（三连跑，其中一次还先 `npm run build:e2e` 重建过）：

```
attempt 1: running=true statuses=["completed","running"]        ← 前提成立（实测）
runs after restart: []                                          ← 状态读仍为空
run.json on disk: [["…-1","completed",null],["…-2","failed",null]]   ← 盘上仍是 failed、理由 null
```

**为什么两种顺序都不行**（这是本轮最有用的产出，下次不用重走）：

- **先改写、后收内核**：收内核让在飞执行抛错，那记抛错经
  `execution-owner.errorToExecutionResult` **把该运行写回 `failed`，覆盖掉我的改写**；
- **先收内核、后改写**：`reconcileInterruptedRuns` 只改写 `running`/`queued`（这是它的契约），
  而收内核之后该运行已经是 `failed` ⇒ **无物可改**。

⇒ 「在退出的某一时刻补一次改写」这个形状**做不到**，因为终态写入发生在收内核那一刻、且它把状态定成
`failed`。**真修法的形状**应是：让**终态写入本身知道「应用正在退出」**——一个 quitting 信号（或退出时
把「当时在飞的那些运行」记下来，收尾后按名单改写，而不是按状态筛选）。这属于终态写入路径的改动，
比一个 quit 钩子深，需要单独排期。

**撤回的理由**（如实说）：一个**观测不到任何效果**的改动 + 只钉住实现顺序的测试，正是本仓说的
「看着像修复」。所以源码与测试都已 `git checkout` 回 HEAD，spec 也移出树；留下一份**能直接
接着做的立案**，而不是一个假装的修复。

## 第二个已确证、独立挂账的现象

**重启后 `notebook.state` 返回空运行列表，而盘上 `run.json` 有两条记录**（三连跑均如此）。
UI 读的正是这条通道 ⇒ 一个刚重启的应用里，**笔记本面板可能看不到任何历史**。
它与我这一支的中断问题**无关**（我的探针读法若错，它仍是一条独立读数），需单独判：
先查这条通道在重启后是否需要「先打开笔记本」才会加载历史。

## 追加二：真因定位到一处**分叉**，且修法已有先例（本轮终局）

用 traceback 读出那句原话：`"Notebook kernel process exited."` —— **内核/传输错误，不是用户代码的错**
（`{"error":null,"traceback":"Notebook kernel process exited.","stderr":…}`）。而这句话只在
`kernel-executor.ts:531-553` 的 `child.on('exit')` 里产生，**且要求该 proc 还在路由 map 里**（注释：
「Intentional teardown (shutdown/restart) … clear the map first, so this only fires for a genuine crash」）。
⇒ 退出时那颗内核**不是**经 `shutdown()` 收的。

`lifecycle-shutdown.ts` 把分叉摆得很清楚：

```ts
runForQuit(...)       → this.deps.notebook.dispose()       // ← 用户退出走这条
runForUpdateGate(...) → this.deps.notebook.shutdownAll()   // ← 只有更新门走这条（干净路）
```

而 `kernel-executor.ts:390-398` 的 `shutdown()` 才是「先 `procs.clear()`、再以
**`'Notebook kernel was shut down.'`** 拒在飞运行」的那条路。**用户退出拿不到它** ⇒ 内核被从下面收走 ⇒
执行器判成**意外崩溃** ⇒ 在飞运行落 `failed`。域规则（app-terminated **NOT failed**，因为「代码可能没
错」）因此**只在更新门那条路上成立**。

**修法（两半，缺一不可）**：

1. **退出要走干净路**：`runForQuit` 目前 `dispose()`；应让它在 `dispose()` 之前先跑
   `shutdownAll()`（或让退出路径的 dispose 以**关停语义**拒在飞运行），这样执行器不再把「退出」误判成
   「崩溃」——判据就在 `kernel-executor.ts:531-553` 的注释里。
2. **终态写入要带上「非失败」的区分**：本文件的既有先例是**文本级**的
   （`execution-owner.ts:129-132`：取消仍落 `failed`，但文本具名 `CANCELLED_MESSAGE`），而域里退出用的是
   **状态级**词汇（`interrupted` + `interruptionReason: 'app-terminated'`，`repository.ts:271-287`）。
   所以退出路径的终态要么产出一个终态写入能识别的**具名错误**（照 `CANCELLED_MESSAGE` 的形状），
   要么在收尾时按**名单**（退出时在飞的那批）改写——**不能按状态筛选**，因为退出路径的拒斥落下来就是
   `failed`（这一点两轮实测已证）。

**验证路径已就绪**：脚手架（227 行）已能跑到 `runJsonPath` + 盘读；修复后盘上那格必须是
`interrupted` + `app-terminated`。这条断言就是验收，不需要新造夹具。


1. **测覆盖假设**：把盘读那一行加上 traceback —— 若那格 `failed` 的 traceback 是**内核/传输错误**
   （而非用户代码的错），即证「收内核的抛错覆盖了改写」，真修法方向即为「终态写入带 quitting 信号」；
2. **测状态读异常**：重启后**先用 UI 打开该会话的笔记本**，再读 `notebook.state` 与盘，比较两者；
3. 脚手架 `~/.hermes/cache/scratch/comp/notebook-interrupted-run.spec.ts`（227 行）**已跑通到
   `runJsonPath` 那一步**（导入+绑定+真跑+实测前提+盘读全可用），补上面任一读数只需改一行。


- **脚手架不落树**（跑不绿的不算验收）：227 行的 spec
  `~/.hermes/cache/scratch/comp/notebook-interrupted-run.spec.ts` —— 缓存包导入 → 绑定 → 真跑单元格 →
  **实测前提** → 重启 → 读回状态**并读盘仲裁**。它现在**红在最后一条断言**上，而这条红是**真读数**
  而非探针故障；改一处（把「读状态」换成「UI 打开该会话的笔记本」）即可继续。
- `docs/evidence/2026-10-04-notebook-run-badge-status.md` 的「未取」一节由本份接续。

## 追加三：最后一环——关停被排在自己要打断的那个执行后面（真因定位完毕）

`session-aggregate.ts:426-431`：

```ts
shutdownExecutor(): Promise<{ reaped: boolean }> {
  const executor = this.executorValue
  this.executorGenerationActive = false
  const lifecycleDrain = this.executorLifecycleQueue
  return lifecycleDrain.then(() => executor.shutdown())   // ← 关停排在生命周期队列之后
}
```

而 `executor.shutdown()`（`kernel-executor.ts:390-398`）的**第一步**就是 `procs.clear()` + 以
`'Notebook kernel was shut down.'` 拒在飞运行——**只有先跑到它**，执行器才不会把退出误判成崩溃
（`:531-553` 的意外退出处理要求 proc 还在路由 map 里）。

**链条**：退出 → `runtime.dispose()` → `sessionLifecycle.dispose()` → `sessions.dispose()` →
`disposePermanently()` → `teardownOwnedSessions(true)` → 每个会话 `shutdownExecutor()` →
**`lifecycleDrain.then(() => executor.shutdown())`**。而 drain 里压着的正是在飞的执行；关停要打断的
**恰恰是它自己在等的东西**。退出预算一到、主进程下去，子进程被系统收走——此时路由 map **还在** ⇒
`child.on('exit')` 走意外退出分支 ⇒ 在飞运行落 `failed`，文本 `Notebook kernel process exited.`
（本轮实测：`stderr` 与 `traceback` 同为此串，正合 `errorToExecutionResult` 的写法）。

**为什么更新门那条路也不可靠**：`shutdownAll()` 与 `dispose()` 最终都走同一个
`teardownOwnedSessions` → 同一个 `shutdownExecutor()`；差别只在 `terminalCleanup` 标志（影响失败处理，
不影响这个顺序）。⇒ 这个顺序缺陷是**共用的**，不是退出独有；只是退出是最常见的触发场景。

**修法形状（已收窄到一处）**：让「拒在飞运行」**不等**生命周期队列——把 `executor.shutdown()` 拆成两步：
**立刻**清 map + 拒在飞（并产出具名的关停错误），**再**等 drain 完成后收进程树。加上第二半（终态把具名
关停错误写成 `interrupted` + `app-terminated` 而不是 `failed`），域规则才成立。这一处属笔记本运行时核心的
等待链，**改动需单独排期并逐次真机验收**（脚手架 7.5 分钟/轮），不在发现问题的那一晚顺手改。

**证据强度说明（不夸大）**：文本来源的唯一性 + map 守卫是从源码读出的**推断**，与「退出路径确实会走到
`executor.shutdown()`」这一源码事实相抵；解开张力的正是上面那条**被排在 drain 之后**的顺序。若要更硬的
证据，可在 `kernel-executor.ts:396` 与 `:548` 各加一行退出期日志，跑同一份脚手架看哪一行先打。

**另一条本轮实测的边界**：退出时渲染进程里的 `execute()` promise **不会**拒（整个进程先没了，本轮日志
里那行 `execute rejected with:` 从未出现）⇒ 这类读数只能从**盘上记录**取，不能指望渲染层 promise。

## 追加四：两半修法已落码，真机读数**未转绿**（如实说）——靶子上移一层

**已实现（含单元测试 99 passed / 6 skipped，typecheck 与 prettier/eslint 均绿）**：

1. **拒在飞不再排在队列后面**：`session-aggregate.ts` 的 `shutdownExecutor()` 改为**直接**调
   `executor.shutdown({ interruptionReason: 'app-terminated' })`，再 `Promise.all([lifecycleDrain, shutdown])`。
   `kernel-executor.shutdown()` 的「清 map + 拒在飞」本就在它**第一个 `await` 之前**同步完成，所以直调即立刻生效。
2. **终态写入状态级区分**：新增具名 `NotebookKernelShutdownError`（带理由）；执行器的
   `errorToExecutionResult` 把**具名关停错误**写成 `interrupted` + `app-terminated`，
   **不带理由的关停（内核重启）仍是 `failed`**（没有把重启误标成 app-terminated）；
   `run-terminalization.ts` 按状态守卫携带 `interruptionReason`。

**真机读数（同一份脚手架，--workers=1）：与修复前逐字相同**：

```
attempt 1: running=true statuses=["completed","running"]         ← 前提成立（实测）
run.json on disk: [["…-1","completed",null],["…-2","failed",null]]
failed run … says: {"error":null,"traceback":"Notebook kernel process exited.","stderr":同}
```

**先排除掉「包是旧的」这个假读数来源**（本仓为此白跑过两轮）：`npm run build:e2e` 之后
`out/main/ipc-BoQKD4o9.js` 里确实有 `executor.shutdown({ interruptionReason: "app-terminated" })`
与终态守卫，且 `'Notebook kernel was shut down.'` 在包里**只剩类构造器那一处**（内联 `new Error(...)` 已消失）
⇒ 跑的是新包，读数是真的没变。

**新读数给出的关键坐标**：那格 `startedAt→endedAt` 只隔 **13.8 秒**（单元格要跑 90 秒），
`app.close()` 开始后约 6.6 秒主进程还在——即**优雅退出**、且**关停在自己 5 秒预算内也没走到 `procs.clear()`**。
⇒ 关停不是"走到了但太晚"，而是**在到达 `shutdownExecutor()` 之前就被谁挡住了**。

**靶子上移一层（下一轮从这里开跑）**——`session-registry.ts:151-158` 的 `teardownOwnedSessions` 在调
`shutdownExecutor()` **之前**有一串 await：

```ts
const removalOutcomes = await Promise.allSettled(removals…)      // 本轮为空
await this.options.beforeTeardown?.()   // runtime-service.ts:364 → environmentOperations.waitForRevocationDrains()
                                        //                            → runtimeBindingOwner.waitForWrites()
await Promise.allSettled(Array.from(this.creations.values()))
```

而 `session-lifecycle.ts:150` 的 `dispose()` 还要先过 `runtime-binding.ts:104 withGlobalTeardown` 的
**globalWriteGate**（`while (this.globalWriteGate) await this.globalWriteGate.promise`）。
⇒ 这两处都要**逐个排除**，但**本轮已排掉一个**（见下），别再凭形状猜。

**已排除（本轮真读代码）**：「在飞的 `execute` 持有绑定写租约，所以关停排在它后面」这个假设**不成立**：
`runWrites` 的调用点只有 `bindRuntime`/`switchRuntime`（`runtime-service.ts:616/627`）与环境/修复操作，
**`execute`/`runCell` 不在写租约里**（`session-lifecycle.ts:137` 的 `waitForWrites(sessionId)` 是移除单会话时用的）
⇒ `waitForWrites()` 在退出那一刻应当是空的。剩下的候选只有
`environmentOperations.waitForRevocationDrains()` 与 `creations`/`removalOutcomes` 两处 `allSettled`。

**下一步的判定手段（照证据档原话，先取证再改码，不要先改码）**：在 `kernel-executor.ts:396`（清 map 那行）、
`:548`（崩溃分支）与 `shutdownExecutor` 入口各加一行退出期日志，跑同一份脚手架看**哪一行先打**：

| 观测 | 结论 |
| --- | --- |
| `shutdownExecutor` 那行**没打** | 关停被挡在 registry 门/`beforeTeardown`/创建集之前 —— 继续往 `dispose()` 链上找 |
| 打了、`:396` 没打 | 挡在 `shutdown()` 自身（进程在 kill 之前就没了） |
| `:396` 打了而 `:548` 也打了 | 另有第二条在飞路径没走 `shutdown()`（本轮的半 ① 需要再收窄） |

在此之前**不要**再改码——本轮已证明"照形状改一处"得不到读数变化，白跑一轮。

**同时确证的第二个现象根因（原"重启后 `notebook.state` 返回空"）**：重启后 `state` 答的是
`notebooks/**interrupted-run**/…`（**项目名**），而盘上真源在 `notebooks/**cmute78s7…**/…`（**项目 id**）。
⇒ 新进程里 `notebook.state` 为**同一个 sessionId** 建了**另一个项目键**下的聚合，答的是那份空文档
（`sessions.getOrCreate(sessionId, …)` 只按 sessionId 命中，项目名只对"首次创建"生效）。
这条与中断契约无关，但它就是"盘上有两条、状态返回空"的机械原因，可直接据此立案。

**收尾**：红 spec 已按铁律从树里删除（`e2e/certification/notebook-interrupted-run.spec.ts`），
脚手架原件仍在 `~/.hermes/cache/scratch/comp/`。


