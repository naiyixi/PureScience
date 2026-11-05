# 流畅度基线（2026-11-05，本机真窗口）

## 一句话

帧间隔仪自证可用后，第一次拿到**能横向比较的绝对数**：真正超标的是**流式回合的主线程成本**（10 回合共
639 ms，每回合 63.9 ms，高过 50 ms 预算），而不是滚动；滚动那一项样本只有 39 帧，p95 = 34 ms 读作
「证据不足」，不读作「滚动卡」。

## 一 怎么取的数

```
npm run build:e2e            # 24.39 s
npx playwright test e2e/perf/smoothness.spec.ts --reporter=line     # 1 passed (13.2 s)
```

窗口与场景都是真窗口（`e2e/fixtures/electron-app`），不是 jsdom。仪器先自证再取数：

```
instrument: usable — idle cadence 17ms is at or above 50 fps — frame intervals describe the app
```

这句话是这道门的前提：之前 p90 在离屏/软件光栅下两边都饱和成 81 ms，那样的数不能用来比较，只能用来
自欺。现在空闲帧距 17 ms（≥50 fps），说明帧间隔确实在描述应用本身。

## 二 读数（原样）

| 场景         | 最长阻塞任务 | 超 50 ms 的任务 | 帧数   | 帧距 max | 帧距 p95                      |
| ------------ | ------------ | --------------- | ------ | -------- | ----------------------------- |
| 流式 10 回合 | 0 ms         | 0 of 0          | 134    | 33 ms    | 18 ms                         |
| 输入框打字   | 0 ms         | 0 of 0          | 106    | 33 ms    | 31 ms                         |
| 滚动会话记录 | 0 ms         | 0 of 0          | **39** | 34 ms    | **34 ms**（n=39，不足以定性） |
| 命令面板     | 0 ms         | 0 of 0          | 3      | 17 ms    | n/a（<20 样本）               |
| 重开重会话   | 0 ms         | 0 of 0          | 2      | 17 ms    | n/a（<20 样本）               |

另外两项是**看得见的成本**：

```
流式 10 回合 main thread: task=639ms script=412ms | 每回合 task=63.9ms script=41.2ms
ipc idle:            project.list n=30 p50=0ms p95=1ms max=1ms
ipc after heavy:     project.list n=30 p50=0ms p95=1ms max=2ms
命令面板打开:        46 ms 到可见
重开重会话:          61 ms 到可见
```

## 三 结论：哪一条真的越线

1. **每回合 63.9 ms 的主线程成本越线**（预算 50 ms/回合）。10 回合 639 ms 是**累加**在流式过程中，
   用户在那段时间里做的每一次滚动/打字都要排在这些任务后面 —— 而这正是「卡」的实际来源。
   渲染次数看不出问题：mutation batches ≈89 commits / 135 帧 = 0.66/帧，说明不是「每个增量都重渲」。
   所以成本在**单次提交的脚本量**上，不是在提交频率上。
2. **滚动 p95 = 34 ms 证据不足**：39 帧、0 个超 50 ms 任务。34 ms 落在 30 fps 附近，但 39 个样本的 p95
   等于最大值附近，噪声占主导。要判滚动，先把样本做到 ≥200 帧（滚动更长的记录）再读。
3. IPC 与弹窗都不越线（p50 0 ms、46 ms/61 ms 到可见）。

## 四 下一步（按证据排序）

1. 把「每回合 63.9 ms」拆开：这一回合里脚本花在哪（消息合并、Markdown 解析、代码高亮、自动滚动定位）。
   先取分项，再决定改哪里 —— 不先猜。
2. 滚动样本做到 ≥200 帧后重读 p95，同时把「首屏可交互」与「长任务」两项按同一仪器补齐，凑齐四项预算。
3. 只改被读数指到的那一处，改完用同一条命令重跑，前后对照必须同机同窗口。

## 五 复算

```bash
cd <repo> && npm run build:e2e && npx playwright test e2e/perf/smoothness.spec.ts --reporter=line
grep '\[perf\]' <playwright 输出>
```

本次日志：`/tmp/ps_perf_baseline.log`（构建 `/tmp/psbuild_perf.log`）。
