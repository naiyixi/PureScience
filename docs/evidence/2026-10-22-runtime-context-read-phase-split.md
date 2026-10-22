# 「这个会话有计划吗」3.8 秒慢在哪一段：把等待与解析分开报

日期：2026-10-22 · 单元：主进程读通道的分段诊断（`readSessionRuntimeContext`）· 提交见文末

## 1 为什么要这一段

上一单元（`docs/evidence/2026-10-22-plan-projection-ask-once-per-open.md`）治的是**次数**：同一次「打开会话」
里同一个问题被问了好几遍。**单次成本那一半没治**——开发实例九天的日志里，这条通道有 726 次慢行
（`ipc handler was slow`，阈值 50 ms），中位 3,819 ms、p95 121,600 ms、max 125,341 ms。

那时的日志只有一个总数，读者无法判断那 3.8 秒是：

- **排队**：这条读进的是**全局持久化队列**（`coordinator.enqueue`），读与写同一条 FIFO，一次写会话可以把后面的读全挡在后面；
- 还是**解析**：`loadRuntimeContextSession` 要把整份会话 JSON 读出来解析。

两者的修法完全不同（拆队列/降写成本 vs 换读模型/缓存），所以**先要一条能分开这两者的读数**，而不是先猜一个去优化。
仓规：没有读数时先做仪器。

## 2 交付

| 位置 | 改动 |
|---|---|
| `src/main/session-persistence/coordinator.ts` | 新增 `SLOW_SESSION_RUNTIME_READ_THRESHOLD_MS = 200`；`readSessionRuntimeContext` 在 `enqueue` **之前**取 `requestedAt`，出队取 `startedAt`、读后取 `readAt`、返回前取 `finishedAt`；新增 `reportSlowRuntimeContextRead` 打**一行** `session runtime context read was slow`，字段 `sessionId / queuedMs / loadMs / cloneMs / totalMs / hasPlan` |
| `src/main/session-persistence/coordinator.test.ts` | 新增 `describe('session runtime context read diagnostics')` 2 条 |

**三条设计判据**

1. **时钟从调用那一刻起**（`requestedAt` 在 `enqueue` 之前），这是这个单元的全部要害：起点若落在任务体内，
   排队整段就被算在读数之外——而排队恰恰是要判的那一半（`references/main-process-read-latency.md` §9）。
2. **阈值 200 ms**，不取 50 ms：IPC 通道自己已经报所有 ≥50 ms 的调用，再在通道的中位数附近加一行只是噪声；
   200 ms 与同文件里 `SLOW_SESSION_SAVE_THRESHOLD_MS` 同一口径，读的时候两行可以直接对照。
3. **只报布尔 `hasPlan`，绝不带计划内容**：那 726 次里有多少次是在答「这个会话没有计划」，
   直接决定这条通道值不值得治——一个没有计划的会话被问 3.8 秒，与一个真的要投影的计划被问 3.8 秒是两件事。
4. **best-effort**：`try/catch` 包住，诊断失败绝不让读者等的那次读变成失败。

**顺带闭合一条具名缺口**：上一单元把它记成「慢行不带会话 id，所以『一次打开内问了几次』无法从日志切分」。
本笔把 `sessionId` 放进这一行（读者本来就是按会话问的），那条缺口从此可以按 `sessionId` 聚合。

## 3 变异证明（两条，各自只红它该红的那一条）

| 变异 | 结果 |
|---|---|
| 时钟起点落在任务体内（`requestedAt` 在出队后才取） | **2 条都红**：`expected "vi.fn()" to be called 1 times, but got 0 times` —— 排队一跨阈值就一行都不报，正是「把等待藏起来」的形状 |
| `hasPlan` 写死 `true` | **只红**「says when the Session had nothing to project」：`expected true to be false`；另一条保持绿 |

第一条变异是这一段的**必需性证明**：换个起点，同一份代码在慢读上一个字都不说。第二条证明 `hasPlan`
不是装饰——它把「没有计划」与「有计划但慢」这两种情况在日志里分开了。

（第一次尝试的变异写错了：我改的是**字段名**而不是时钟位置，`times.requestedAt` 变成 `undefined` ⇒ 打出 `NaN`。
那是接错线、不是语义变异，读数无效，已作废重做。）

## 4 门禁（取自最后一次改动之后）

<!--GATES-->

## 5 边界（不许读成更强）

1. **这条分段读数还没有一次真机读数**：本机内存闸门未解（空闲页 ~3,900 ≈ 61 MB、swap used ~14.2 GB of 15.4 GB，
   测试 worker 在跑全量时反复被系统换页/重启）。`blocked-by` = 上一次安静窗口里的一次真慢读。
   拿到的命令（就绪即可跑，不需要改代码）：

   ```bash
   grep -A 4 "session runtime context read was slow" logs/headless.out.log \
     | grep -E "queuedMs|loadMs|totalMs|hasPlan" | tail -20
   ```

   **本文件不写这条读数**，也不许把「仪器已就位」写成「3.8 秒已治」。
2. **慢行只覆盖 `readSessionRuntimeContext` 这一条读**，`patchSessionRuntimeContext` 与其它 `enqueue` 调用点没有加，
   别把这一行当「队列整体」的画像。
3. **阈值 200 ms 以下的慢读不报**：能不能判「这条通道其实大多很快」要靠 IPC 通道那条 50 ms 的报告，不在本行。

## 6 下一步（有了读数之后才动）

- `queuedMs` 占大头 ⇒ 目标是把读从写队列里分出来（只读连接/快照读），不是优化解析；
- `loadMs` 占大头 ⇒ 目标是整份会话 JSON 的读取代价（读模型/投影缓存）；
- `hasPlan=false` 占大头 ⇒ 说明大部分慢读是在答「没有计划」，优先路线变成**别问**（上一单元的方向继续）。
