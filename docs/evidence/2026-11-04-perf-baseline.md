# v2.23.0 性能基线（2026-11-04，本机实测）

仪器：`e2e/perf`（Playwright 驱动真实 Electron 窗口，硬件光栅），`npx playwright test e2e/perf`。
构建：`npm run build:e2e`（本机 M2 / 8 GB，macOS 27.0.1）。

## 0. 先读这一条：同一构建两次运行的差异是 2 倍

同一份 v2.22.0 构建、同一台机器、同一套仪器，跑了两遍：

```
运行 A: streaming 10 turns  task=99.0ms/turn   script=59.3ms/turn | palette 37ms | reopen 58ms
运行 B: streaming 10 turns  task=198.7ms/turn  script=114.5ms/turn | palette 61ms | reopen 85ms
```

差异 1.6–2.0 倍。这意味着：**单次运行不能用来宣称"变快了"或"变慢了"**。下面第 1 节是运行 B 的完整
读数（本机偏慢的一次），第 3 节的批量读取改动有独立的 SQL/往返计数证据，不依赖这套墙钟数字；v2.23.1
的判据必须用 **n≥3 次运行取中位数**，否则就是在噪声上建结论。

## 1. 交互基线（改动前，v2.22.0 构建；运行 B）

```
[perf] scale: elements=2163 items=120 toolRows=0 textChars=2544
[perf] scroll up (14 steps): LayoutCount=+18 RecalcStyleCount=+55 LayoutDuration=8ms
        RecalcStyleDuration=23ms ScriptDuration=119ms TaskDuration=224ms
[perf] typing 57 chars: LayoutCount=+58 ScriptDuration=824ms TaskDuration=971ms
[perf] per keystroke: script=14.46ms task=17.04ms
[perf] one streamed turn: Nodes=+121 LayoutCount=+10 ScriptDuration=210ms TaskDuration=290ms
[perf] streaming 10 turns: longest=62ms | >50ms=1 of 1 | frames=361 p95=20ms max=49ms
[perf] streaming 10 turns main thread: task=1987ms script=1145ms | per turn: task=198.7ms script=114.5ms
[perf] typing into the composer: longest=0ms | frames=122 p95=18ms max=35ms
[perf] palette open: 61ms to visible
[perf] reopen heavy session: 85ms to visible
[perf] ipc idle: project.list p50=5ms p95=30ms max=30ms
[perf] ipc after heavy session: project.list p50=1ms p95=4ms max=4ms
```

读数解读（不粉饰）：

- **每键 17.04 ms 主线程**（script 14.46 ms）——这是"打字发涩"的来源。57 个字符累计 971 ms，
  用户能感觉到。
- **每轮流式 198.7 ms 主线程**（script 114.5 ms）——长会话越滚越慢的量级。
- **滚动**：14 步 224 ms，单步 ~16 ms，尚在 60 fps 预算内但无余量。
- **未出现 >500 ms 的卡死**：最长的单个长任务 62 ms。

## 2. CPU 剖面（`test-results/perf/streaming.cpuprofile`，2678 ms 采样）

按自耗时聚合，前 10：

```
 4.1%  commitHostUpdate
 3.1%  (garbage collector)
 2.7%  updateProperties
 2.6%  updateForwardRef
 2.4%  (anonymous, index bundle)
 2.2%  reconcileChildFibersImpl
 1.7%  MessageTimestamp
 1.7%  renderRootSync
 1.6%  beginWork
 1.2%  commitLayoutEffectOnFiber
```

结论：**没有一个可摘掉的"元凶函数"，代价平摊在 React 提交阶段的整棵树更新上**（commit/reconcile
合计超过 10%），说明流式增量把整条 transcript 反复提交，而不是局部更新。`MessageTimestamp` 单独
占 1.7%，因为它在每次渲染里重新走一遍 `Intl.DateTimeFormat`。这两件事都不是本版能"顺手"改掉的
——那是一次真刀真枪的渲染层改造，属于 v2.23.1 的范围，已在计划里立案。

## 3. 本版实际修掉的一条：计数扇出

首页"用户案例"要按产物数量给**所有跑过的项目**排序，此前每个项目一次 `getOverview`（4 条 count
查询 / 次），56 个项目 = 56 次 IPC + 224 条 count 查询，全部排在其他读取前面。

改成一次批量读取（`projectFiles.getOverviews`，两条分组查询）：

```
候选项目 56 个，真实数据库（88 MB）
旧：4 条 count × 56 项目  1.6 / 1.6 / 5.3 ms（三次，SQL 侧）
新：2 条分组查询           1.0 / 1.3 / 1.6 ms
IPC 往返：56 → 1
```

诚实说明：SQL 侧只省 0.6 ms，**省下的是 55 次 IPC 往返及其恢复闸门排队**（同机空闲 p50 5 ms，
据此量级约 275 ms 的排队时间从首屏路径上消失）。这条不能吹成"首页变快了 275 ms"——那是把队列
时间当墙钟时间。

## 3.1 这套基线的可信区间

- 每轮流式主线程：**99–199 ms**（两次运行）
- 每键主线程：17.04 ms（运行 B；运行 A 的输出被 tail 截断，未取到）
- 命令面板：37–61 ms；重开重会话：58–85 ms
- 滚动 p95：33 ms（两次一致）；最长长任务：62 ms（运行 B）

任何"性能改善 X%"的说法，若不能在这套区间之上重复 n≥3 次，都按噪声处理。

## 4. 本版未达成的预算

没有把"每键 17 ms / 每轮 199 ms"压下去。理由与后续：

1. 剖面显示代价在提交阶段整树更新，需要渲染层改造（局部订阅 / 增量追加 / 虚拟化），不是一处改动；
2. 该改造必须先补上能逐帧对比的仪表（本文件第 1 节就是它的基线）；
3. 立案：v2.23.1「流式渲染增量更新」，判据是打字 ≤8 ms/键、流式 ≤100 ms/轮，用同一套仪器复测。
