# `notebook:state` 的 1.2 秒里，它自己只占几十毫秒

日期：2026-10-23 · 单元：主进程读通道的分段诊断（`NotebookRuntimeService.state` → `NotebookSessionReadModel.state`）· 提交见文末

## 1 为什么要这一段

窗口侧最常读的一条笔记本通道是 `notebook:state`：打开会话、切回面板、每次内核事件之后都会重读它。
开发实例的日志（`logs/headless.out.log`，单文件 76 MB）里，越过 IPC 通道 50 ms 阈值的 `notebook:state` 有：

| 读数（现取，全量日志重算） | 值 |
|---|---|
| 次数 n | **116** |
| 中位 | **1,168 ms** |
| 均值 | 5,831 ms |
| p90 / p95 / max | **18,664 / 21,578 / 29,180 ms** |
| >1 s / >5 s / >10 s | **58 / 42 / 32** |
| 这些调用合计 | **676 秒** |

这份日志只记 ≥50 ms 的调用，所以 116 是**下界**，不是调用总数：这条通道没有全量计数，只有慢行。

旧日志只有一个总数，读者无法判断那 1.2 秒是：

- **自己的活**：`loadOrCreate` 把 `run.json` 读出来、`JSON.parse`、再逐 run 归一化（真实语料里
  125 份文档合计 **391 MB**，中位 2.06 MB、p90 6.5 MB、最大 15.9 MB）；
- 还是**主线程在跑别人的活**：同一进程里同时有 Prisma 事务、日志重写、运行落盘等。

两者的修法完全不同（缓存/换读模型 vs 给主线程减负），所以**先要一条能分开这两者的读数**。仓规：没有读数时先做仪器。

## 2 先量：把生产函数搬到真文档副本上单独跑

用生产函数 `NotebookRunRepository.loadOrCreate` 直接吃真文档副本（**只读**真实数据根，副本落在 `/tmp`），
每档三次取中位：

| 文档 | runs | `loadOrCreate` | 裸 `readFile`+`JSON.parse` |
|---|---|---|---|
| 5.85 MB | 54 | **57 ms** | 77 ms |
| 14.4 MB | 58 | **136 ms** | 129 ms |
| 16.6 MB | 100 | **198 ms** | 257 ms |

两列同量级 ⇒ **归一化几乎不花钱，成本就是读 + 解析**，且随文档大小线性。

第三条读数来自同一份日志之外的机器侧采样（打包版诊断 JSONL，22,169 条）：主进程卡顿归因
`process-not-scheduled` **11,078** 条、`cpu-bound-in-process` **11,060** 条、`inconclusive` 31 条；
`cpuShare` 中位 **0.09**，栈样本 top 是 Prisma runtime `request`、`tick`/`flush`、`resolveRoutinesRoot`、
`stringifyLogRecord`/`redactLogText`。

**结论**：这条通道自己的活是 **20–200 ms**（随文档大小线性），而字段上的中位是 **1,168 ms**，比它高一个数量级；
一半样本连 CPU 都没拿到 ⇒ 绝大多数时间**不是这段代码在跑**。这与审查读通道那条 203 秒的结论同形
（`docs/evidence/2026-10-19-review-read-path-attribution.md`：它在等别的通道）。

## 3 交付（仪器，不是优化）

| 位置 | 改动 |
|---|---|
| `src/main/notebook/session-read-model.ts` | 新增导出 `NotebookStateReadPhases`；`state(session, phases?)` 把**持久层那一段**（读 + 解析 + 归一化 `run.json`）写进**调用方自己持有的对象**。不传 `phases` 时行为与改动前逐字相同（既有调用方零改动） |
| `src/main/notebook/runtime-service.ts` | `state()` 取三个时间点（进入 / `sessionLifecycle.ensure` 返回 / 读模型返回），越过 `SLOW_NOTEBOOK_STATE_READ_THRESHOLD_MS = 200` 时打**一行** `warn: notebook state read was slow`，字段 `sessionId / cold / ensureMs / loadMs / projectMs / totalMs / runs` |
| `src/main/notebook/state-read-attribution.test.ts`（新） | 三条：慢读要打印三段且 `loadMs ≥ 250`；第二次调用 `cold=false`；快读**不出声**；另有一条 logger 抛错时答案照常返回 |
| `src/main/notebook/session-read-model.test.ts` | 补一条：`phases.loadMs` 被填且是数字；不传 `phases` 仍合法 |
| `src/main/notebook/runtime-service.architecture.test.ts` | 模块常量 pin 里**显式**加入新常量并写明理由（该门要求扩面必须是有意为之） |

**四条设计判据**

1. **相位写进调用方自己的对象**，不用服务上的字段：两路并发读不同会话时不会互相覆盖对方的数字。
2. **只记时长与条数，不记任何 run 内容**：`runs` 是计数。把内容塞进日志会让诊断本身变成被诊断的问题。
3. **阈值 200 ms**，不取 50 ms：IPC 通道自己已经报所有 ≥50 ms 的调用，再在通道中位数附近加一行只是噪声；
   200 ms 也刚好落在「本机最大文档的持久层成本（198 ms）」之上 ⇒ 越过它基本就不是单次读盘造成的。
4. **写成内联块而不是私有方法**：该 facade 的架构 pin 把私有面钉死为「无 IO 的策略助手」，一个打日志的助手就是 IO。
   同时 `try/catch` 包住 —— 诊断失败绝不让窗口等的那次读变成失败。

## 4 变异证明（两条，各自只红它该红的那一条）

1. 把门槛抬成 `Infinity`（等于永不打印）⇒ 红「慢读要打印三段」与「第二次调用 `cold=false`」两条；
   「logger 抛错时答案照常返回」仍绿（它本来就不依赖打印）。
2. 不把 `phases` 传给读模型 ⇒ **只**红 `loadMs` 那一条（`expected 0 to be greater than or equal to 250`）。

## 5 门禁（隔离工作树 `/tmp/ps-gate-2310` = `50e82458` + 本笔 5 文件，`node_modules` 软链）

| 环 | 读数 |
|---|---|
| `tsc --noEmit -p tsconfig.node.json --composite false` | **exit 0** |
| `tsc --noEmit -p tsconfig.web.json --composite false` | **exit 0** |
| 域内 vitest（`src/main/notebook` 全目录） | **91 passed \| 8 skipped（99 文件）**；**1437 passed \| 99 skipped**，exit 0 |
| `eslint --no-cache`（本笔 5 文件） | **0 error / 0 warning** |
| `prettier --check`（本笔 5 文件） | 全部合风格 |

**为什么门禁要开隔离工作树**：共享工作树此刻正被另一个写入者改动（`scripts/bench/**`、`src/main/ipc.ts`、
`src/main/web-service/task-api.ts`、`src/main/capabilities/notice-journal*`），它的在制品会让
`typecheck:web` 红在一处与本笔无关的文件上（实测 `task-api.ts(305,7) TS2353`）。那不是本笔的红，也不是产品缺陷——
是别人半截的接线。隔离工作树只用来判**我这 5 个文件**。

## 6 边界（不许读成更强）

1. **这一笔不优化任何东西**：它只让下一次读数能分开「自己的解析」与「主线程被占」。
2. **相位行尚未在真机上产生过**：运行中的 dev 实例是 1 天前的构建，日志里 `notebook state read was slow` 计数 **0**。
   要拿到它必须重启实例（内存闸门 + 用户正在用的实例）⇒ 本轮**不声称**任何窗口读数。
3. **下一刀不在缓存上**：中位 1,168 ms 里持久层只占 20–200 ms，占比个位数 ⇒ 按性能杠杆的判定闸门
   （占比 <1% 的段直接排除；单次改动的上限是「把 median 降到自己那一段」），给 `loadOrCreate` 做指纹缓存
   最多省掉这一小段，**不立项**。真正的杠杆在主线程被谁占着（同一条链上的 Prisma `request`、日志重写、运行落盘）。
4. 不占版本号：无用户可见能力变化。

## 7 提交

见 `git log --oneline --grep="notebook state read"`。
