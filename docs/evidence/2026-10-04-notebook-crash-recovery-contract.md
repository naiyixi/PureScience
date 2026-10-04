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

## 追加四：真机验收**已通过**（用户退出路径读数），并如实说明前三轮为什么读不到

### 结论（先给读数）

用**用户自己的退出路径**（向应用发 Quit → 应用自己弹「仍有工作正在运行，退出将中断它们。」→ 点 **Quit**）取到的盘上读数：

```
run.json on disk: [["notebook-run-…-1","completed",null],
                   ["notebook-run-…-2","interrupted","app-terminated"]]      ← 在飞那格
1 passed (1.1m)
```

**没有 failed**，且退出期 trace 把整条链按顺序摆出来了（同一进程，毫秒级）：

```
+12348ms runForQuit:enter budgetMs=5000
+12355ms runtime.dispose:enter
+12355ms teardownOwnedSessions:enter terminal=true sessions=1     ← 会话在册（1）
+12357ms shutdownExecutor:enter session=e2e-session-1             ← 半① 立刻派发拒绝
+12357ms executor.shutdown:enter procs=1                          ← 清路由 map + 拒在飞
+12365ms shutdownExecutor:refusal-dispatched
（本轮**没有** crash-branch:fired —— 内核是被这次具名关停收走的，不是意外退出）
```

⇒ 契约在**真机上成立**：退出时在飞的单元格被记成 `interrupted` + `app-terminated`，不是 failed；
半①（拒在飞不再排在队列后面）与半②（终态按理由写成中断）都在读数里看得见。

### 为什么前三轮拿到的是「与修复前逐字相同」的 failed 读数（如实说）

三轮 trace 取证（临时 `quit-trace` 打点，已删）说明前两轮**测的根本不是这条路径**：

| 观测 | 事实 |
| --- | --- |
| `+0ms runForQuit:enter … sessions=0` | 这个退出属于**onboarding 之前的那个实例**（`completeOnboarding()`/`configureFakeAgent()` 各自会重启应用）：它的注册表**从来没有会话**，所以关停无事可拒 |
| `+2999ms runtimeService:constructed tag=rt1` / `+8367ms registry:session-created` | 真正跑单元格的实例在**那个退出之后**才起来（两个进程的 tag 计数都从 rt1 开始，正说明"两个进程"） |
| 该实例的 trace 里**完全没有** `runForQuit`／`runtime.dispose` | 跑单元格的那个实例**从未走自己的退出路径**：fixture 的 `application.close()` 优雅窗口超时后**按进程树强杀**，内核子进程先死、主进程还活着 ⇒ `child.on('exit')` 走意外退出分支 ⇒ 写下 `failed` + `Notebook kernel process exited.` |

⇒ 前两轮的 `failed` 是**夹具强杀的产物**，不是用户退出路径的读数；也因此"照形状改一处"看不出变化——**不是修复无效，是那两轮没触发这条路径**。
另：`requestMainWindowClose()` 在 macOS 上按 `windows.ts` 的分类是 **'hide'（最小化到托盘）**，不会退出、也不会弹确认框——这是第一次改动没取到读数的原因。

### 仍挂账、有据可查的一条（另立，不在本契约内）

**进程树被外部强杀、而主进程还活着时，在飞运行会被写成 `failed`**（证据：上面那张表第 3 行 + 本轮之前的盘读
`["…-2","failed",null]`，`traceback`/`stderr` 同为 `Notebook kernel process exited.`）。为什么这条值得立案：
盘上的运行已经**不再是 `running`**，所以下次启动的 `reconcileInterruptedRuns`（只认 running/queued）
**无物可改** ⇒ 用户看到的是一格 error，而不是"被中断"。触发面很窄（要内核先死、主进程后死），
真修法的形状是让**崩溃分支也能知道"应用正在终止"**（`before-quit` 已置位 / 收到 SIGTERM 时置一个 latch，
再把该运行按 `interrupted` + `app-terminated` 落盘）；寻常 SIGKILL 仍走"进程直接没了 ⇒ 下次加载恢复"那条路，无需改动。

### 顺带确证的第二个现象根因（原"重启后 `notebook.state` 返回空"）

重启后 `state` 答的是 `notebooks/**interrupted-run**/…`（**项目名**），而盘上真源在
`notebooks/**cmute…**/…`（**项目 id**）：同一 `sessionId` 在**另一个项目键**下建了聚合，答的是那份空文档
（`sessions.getOrCreate(sessionId, …)` 只按 sessionId 命中，项目名只对"首次创建"生效）。
与中断契约无关，但它就是"盘上有两条、状态返回空"的机械原因。

### 收尾与规范（本轮）

- **临时件全部删除**：`src/main/notebook/quit-trace.ts`、5 个文件里的打点、`e2e/fixtures/electron-app.ts` 的
  `requestQuit()` 探针助手、`e2e/certification/notebook-quit-trace.spec.ts`（红 spec 与探针 spec 都不落树）；
  `git status` 只剩自主执行器自己改的那个 plan 文件。
- **验收纪律（本轮代价换来的）**：断言"退出时在飞"的读数，**必须走应用自己的退出路径**
  （`app.quit()` → 确认框 → Quit）；用夹具的 `close()` 去"拿走应用"读不到这条契约——
  它会先给一个**没有会话的实例**发正常退出，再把**真正在跑的实例**强杀，
  两种都不落在"用户确认退出"这个触发条件上。平台差异也要先查：macOS 上关窗是 `hide`，不是退出。

## 追加五：队列第 2 项的结论（"重启后状态返回空"），与前一项的硬化候选

**结论：UI 面板路径不受影响，这一项按"探针误用 + 待硬化"收口。**

- 机械原因（追加四末节已证）：`sessions.getOrCreate(sessionId, …)` **只按 sessionId 命中**，项目名只对
  **首次创建**生效；`loadOrCreate` 又用**请求里的 projectName 做路径**。
- UI 传的是什么：`NotebookPreview.tsx:76-86` 的 `createNotebookRequest` 用
  `NotebookSessionReference.projectName`（主进程解析出来的**真实 projectId**），
  `session-persistence.ts:269` 同样用 `session.projectId` ⇒ **面板不会传显示名**，因此重启后打开会加载对的那份档。
- 我读到空，是因为探针把**项目显示名** `interrupted-run` 当 projectName 传了：新进程里那次调用成了
  "首次创建"，于是读到（并且**写出了**）那个项目下的空 `run.json`。这是探针误用，不是面板缺陷。

**据此立案两条硬化（都还没做，都已具名）**：

1. **同名会话 + 不同项目名 ⇒ 静默答另一份历史**：应改为**报错**（或按 `(projectName, sessionId)` 建键），
   而不是答一份空文档——静默是最坏的形态，读数会像"历史丢了"。
2. **只读通道不该落档**：`notebook.state` 走 `ensure` → `loadOrCreate`，对未知的
   `(projectName, sessionId)` 会**创建并写出**一份空 `run.json`（本轮就落了 `notebooks/interrupted-run/…`）。
   只读调用应先 `findExisting` 命中才加载，未命中就按"无历史"回答，绝不写档。

**队列其余项（本轮未动，如实记）**：第 3 项（v1.83.0 的 IC6 真机收割／A7 下载路径／egress 审批窗口侧）、
第 4 项（技能瘦身：`openscience-dev` 本体 99,664 字符已超 100,000 上限，references 307 个文件需合并）、
第 5 项（竞品差距：IEDB 免疫学连接器未做；PDB `pdb_search_by_sequence` 已实现待确认收口）均未开始。




