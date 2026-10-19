# 进程树收口：被信号送走的进程不是「幸存者」

取数日期 2026-10-19（第三轮）。仓库 `naiyixi/PureScience`，基点 `15cbfcf1`（origin/main）。
来自真机审计 `docs/plan-2026-10-19-runtime-audit-and-fixes.md` §5 第 7 条
（「退出时进程树残留：7 次 `left N descendant(s) alive after SIGTERM`，最多 112 个子孙进程被 SIGKILL」）。

## 1 真机上到底发生了什么

应用日志里这类行一共 **15 条**（`main.log` 9 条 10-16 至 10-19、`main.1.log` 6 条 10-05 至 10-15），
`scope` 全是 `acp`，条数从 2 到 **112**：

```
{"t":"2026-10-18T16:29:47.279Z","level":"error","scope":"acp",
 "msg":"process tree left 112 descendant(s) alive after SIGTERM; escalating to SIGKILL", ...}
```

原来的读法是「这些进程不听话」。用真进程复现之后，读法是反的：**它们只是还没死完**。
`terminatePosixTree` 的做法是：`ps` 拍一张子孙快照 → 对整棵树发 SIGTERM → **只等直接子进程退出**
（`waitForExit(child, …)`）→ 立刻用 `kill(pid, 0)` 复查子孙。直接子进程通常在收到 SIGTERM 后几毫秒就没了，
于是复查发生在「信号发出后约 30 ms」，任何正在收尾的子孙都被记成幸存者，随即被 SIGKILL ——
而整棵树的结论被记成 `reaped: false`。

`reaped` 不是日志装饰：`terminateProcessTree` 的返回值被更新安装闸门
（`installGate` → `UPDATE_SHUTDOWN_BUDGET_MS`）用来判断「句柄是不是真的都放开了」，
`false` 会让升级流程拒绝继续。也就是说这条误判不只是噪音，它会把一次干净的退出读成「没退干净」。

## 2 真进程复现（生产代码原样，esbuild 打包后由真 `node` 跑）

树形：1 个根进程 + 5 个孙进程；三种孙进程行为各跑一遍。判据是**孙进程自己写的退出记录**
（`clean <pid>`：它收到了 SIGTERM 并完成了自己的收尾）。

| 孙进程行为 | 修复前（`15cbfcf1`） | 修复后 |
| --- | --- | --- |
| SIGTERM 后 600 ms 收尾 | `reaped:false`、升级 SIGKILL、**32 ms**、`cleanExits: 0` | `reaped:true`、**未升级**、**646 ms**、`cleanExits: 5` |
| 默认（收到即退） | `reaped:false`、升级 SIGKILL（记 2 个幸存者）、**40 ms** | `reaped:true`、未升级、**32 ms** |
| 显式忽略 SIGTERM | `reaped:false`、升级 SIGKILL、31 ms | `reaped:true`、升级 SIGKILL、**3109 ms**（先给满宽限，再杀，再等内核收完） |

第二行是最刺眼的一条：**连收到 SIGTERM 就立刻退出的进程，也会在那 30 ms 的复查里被记成幸存者** ——
可见原来的「幸存者」根本不是「不听话」，而是「还没死完」。

## 3 修法（`src/main/process-tree.ts`）

1. **宽限窗口给整棵树，不只给直接子进程**：`gracefulDeadline = 信号发出时刻 + 3 s`，
   直接子进程与所有子孙共用一个截止时间；子孙每 50 ms 复查一次，全部消失就立刻返回（不白等）。
   等待的计时点改成「真正发信号那一刻」——`ps` 快照可能已经花掉一部分窗口，而那段时间里还没有任何进程被信号。
2. **升级前重扫一次**：宽限内新 fork 出来的进程（快照里没有、会活过应用）从**仍然存活的那些进程**出发再拍一张快照，
   并进 SIGKILL 集合。不从已经退出的直接子进程出发 —— 它的 pid 可能已被内核分配给一个无关进程。
3. **杀完要等内核收完再下结论**：SIGKILL 不可捕获但不瞬时，马上复查会让一次已经成功的收口报成 `reaped:false`；
   现在按 `SIGKILL_GRACE_MS` 等它们真的消失，再给 `reaped` 定值。
4. 顺手把 `collectDescendantPids` 改成「多根、去重、永不 reject」：它现在会在宽限内被调用第二次，
   而收口路径上抛异常比返回空树更坏（抛出去等于把一次 kill 变成调用方的异常）。

**性能取向（有意为之）**：真正忽略 SIGTERM 的树，收口从 ~30 ms 变成最多 ~3 s（先给满宽限）。
退出预算是 `QUIT_SHUTDOWN_BUDGET_MS = 5000`，而多个 runtime 的收口是 `Promise.allSettled(...)` **并行**的
（`runtime-coordinator.shutdownAll`），所以这个 3 s 在多连接场景下重叠、不会线性累加。
用 3 s 换「不把正在收尾的进程砍掉」和「`reaped` 说实话」是这一轮的选择；代价写在这里，不藏着。

## 4 门（用例）与反向门

新增 4 条用例（`src/main/process-tree.test.ts`，假时钟 + 注入的 `process.kill`）：

- 子孙还在收尾（300 ms）时**不得**被记成幸存者，也不得 SIGKILL；它自己退出后整棵树 `reaped:true`、无升级日志；
- 一直不退的子孙：**差 10 ms 到宽限时仍不得 SIGKILL**，过了宽限才升级；
- 宽限内新 fork 的进程（第二张快照里才出现）也要被杀掉，杀完全树 `reaped:true`；
- 已发出但尚未反映到 `kill(pid, 0)` 的 SIGKILL 不得让整棵树报 `reaped:false`。

**反向门**（证明用例不是摆设）：把 `process-tree.ts` 换回 `15cbfcf1` 那一版、只留新用例 ⇒
`4 failed | 12 passed`，四条全红。换回修复版 ⇒ `16 passed`。

## 5 门禁读数

| 项 | 读数 |
| --- | --- |
| `src/main/process-tree.test.ts` | **16 passed**（12 既有 + 4 新增） |
| 受影响簇（process-tree / lifecycle-shutdown / acp 连接收口两侧 / notebook kernel+shell） | **6 files / 128 passed | 6 skipped** |
| `tsc -p tsconfig.node.json --composite false` | exit 0 |
| `tsc -p tsconfig.web.json --composite false` | exit 0 |
| `eslint --no-cache` 两个改动文件 | 0 error / 0 warning |
| 全量单测 | **1345 files / 17196 passed**（16 skipped files、207 skipped 用例，exit 0；比上一轮 +4 用例，正好是新增用例数） |

## 6 边界（不许读成更强）

1. **Windows 分支没动**：那边走 `taskkill /T /F`，本身就是一次到位，没有「等子孙」这一段。
2. **没有改成进程组**（审计原文写的是「POSIX 用进程组 / Windows 用 job object」）：ACP 子进程是与应用同一个
   进程组的，`kill(-pgid)` 会把应用自己一起杀掉；要用进程组必须先让 spawn 走 `detached: true`，
   那会改变信号的默认投递面（子进程不再随应用的前台组收到终端信号），是一条独立、需要单独取真机读数（真退出、
   真恢复、真升级）的改动 —— 本单元不做，留作候选。本轮做的是**同一份终态**的另一半：不靠提前 SIGKILL 收口。
3. **「新 fork 的进程」只覆盖到「仍存活的幸存者的子孙」**：一个已经干净退出的中间进程在退出前 fork 出来、
   又立刻被 init 收养的进程，不在任何快照里。要彻底关掉这一格还是得靠进程组（见第 2 条）。
4. **3 s 是宽限，不是测量**：本轮没有测量「真实应用树收尾需要多久」；`cleanExits: 5` 只证明 600 ms 够用，
   更大的树（112 个子孙）需要真机读数才知道够不够 —— 那是打包版的第一条读数（内存闸门关闭，未取）。

## 7 全量与判决

全量单测 `npx vitest run --maxWorkers=4` ⇒ **1345 files / 17196 passed | 207 skipped（17403）**，exit 0。

CI 判决：`<CI_VERDICT>`（推完就地替换；未落定前一律写「未取」，不写绿。）
