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

## 六 加测：成本随记录长度增长（2026-11-05 同日，PERF_TURNS=40）

10 回合那一份只能说明「每回合 63.9 ms」，说明不了「长会话会不会更糟」。把同一个场景拉到 40 回合：

| 回合数 | 每回合主线程 task | 每回合 script | 重开重会话到可见 |
| ------ | ----------------- | ------------- | ---------------- |
| 10     | 63.9 ms           | 41.2 ms       | 61 ms            |
| **40** | **94.2 ms**       | **62.3 ms**   | **97 ms**        |

**每回合成本随记录长度上升：63.9 → 94.2 ms（+47%），脚本 41.2 → 62.3 ms（+51%）。** 这不是「固定每回合
开销」，而是「每回合重做的活随消息数变多」。40 回合时一次流式回合已经接近 100 ms 主线程，用户在同一条会话里
继续聊只会更慢 —— 用户说的「卡」在这里有了可复算的形状。

同一份 40 回合读数里：长任务仍然 0 个（>50 ms 阈值下无单点），帧距 p95 仍是 18 ms，滚动 33 ms / 42 帧，
`mutation 330 commits / 380 帧 = 0.87`。也就是说**卡的不是某一帧**，是每回合压进来的主线程总量。

## 七 采样剖析：没有单点热点，工作是散的

`e2e/perf/profile-turns.spec.ts`（CDP 采样剖析，10 回合，warm-up 回合不计入）自证 1489 ms / 1512 样本：

```
831.6ms (idle)   234.1ms (program)   26.5ms (garbage collector)
 13.4ms removeChild(native)   13.1ms renderWithHooks   11.9ms commitHostUpdate
 11.6ms updateProperties      8.3ms mergeProps         7.4ms usePresence
  6.5ms beginWork             5.0ms elementText(native) 4.7ms formatMessageTimestampTitle
```

结论：**没有哪一帧函数吃掉大头**——最大的单项只有 13.4 ms（十回合累计，约 1.3 ms/回合）。工作量摊在
React 的提交路径（`renderWithHooks` / `commitHostUpdate` / `updateProperties` / `mergeProps` / `usePresence`）
与原生 DOM 操作上，形态是「每回合把整条记录再提交一遍」，而不是「某个函数写得慢」。

这条读数决定了修法：不该去找热点函数优化，而该让**已沉淀的回合不再参与提交**（记忆化失效的 props、
或列表虚拟化二选一，先量再选）。

## 九 补测：滚动样本到 227/241 帧，p50 与 p95 才第一次可读（同日）

§六 那句「滚动 33 ms / 42 帧」仍然是同一个缺陷：**42 帧的 p95 与最大值几乎重合**，读不出「滚动顺不顺」。
这一轮只改滚动场景本身——六步滚轮换成三组「下滚 10 步 / 上滚 10 步」（每步 60 ms，约 3.6 s），
并在报告里**同时**打印 p50（预算口径要的是中位，不是尾部）：

```
PERF_TURNS=40  # 第一次
[perf] scrolling the transcript: longest=0ms | >50ms=0 of 0 | frames=227 max=38ms p95=33ms
[perf] scrolling the transcript: p50=17ms over 227 frames (one frame at 60 Hz = 16.7ms)
PERF_TURNS=40  # 第二次（复现）
[perf] scrolling the transcript: longest=0ms | >50ms=0 of 0 | frames=241 max=35ms p95=33ms
[perf] scrolling the transcript: p50=17ms over 241 frames (one frame at 60 Hz = 16.7ms)
```

怎么读：

- **滚动 p50 = 17 ms**，与一帧 16.7 ms 同级（四舍五入落在同一格），即「滚动大体跟得上」；**p95 = 33 ms**
  且**没有一次超过 50 ms 的任务** —— 滚动不是「卡」的来源。这是四项预算里滚动一项的第一份可读读数。
- 两次运行的帧数（227 / 241）与 p50 / p95 完全一致 ⇒ 这不是一次运气好的采样。
- **只能说滚动达标，不能说四项预算达标**：长任务与弹窗、首屏有读数，但「每回合成本随记录长度增长」那条
  仍未修（§六/§七 的修法尚未动工），用户主观「卡」的那一半没有消失。

附带修掉一处**只在类型检查里现形**的缺陷（与读数无关但会让门禁红）：`e2e/perf/profile-turns.spec.ts` 把
`{ timeout: 240_000 }` 作为第三个参数传给 `appTest(...)`，而 Playwright 的 `TestDetails` 只认
tag/annotation —— `typecheck:node` 当场报 `TS2559/TS2353`，运行时却静默沿用默认 30 s 超时（40 回合的
剖析会在中途被切断，末尾样本看起来像「流结束了」）。改为在用例体内 `appTest.setTimeout(240_000)`。

## 八 复算第二份

```bash
cd <repo> && npm run build:e2e
PERF_TURNS=40 npx playwright test e2e/perf/smoothness.spec.ts --reporter=line
npx playwright test e2e/perf/profile-turns.spec.ts --reporter=line
```

日志：`/tmp/ps_perf_40.log`、`/tmp/ps_profile.log`。

## 九 40 回合的剖析：提交路径的增长远快于总数

同一剖析工具换成 40 回合（warm-up 那一回合仍不计入），采样窗口 16,295 ms / 9,790 样本。把两次的自耗时
并排，比值才是这条读数的重点（总数只涨 6×，提交路径涨了 20–47×）：

| 函数（自耗时）                  | 10 回合 | 40 回合      | 倍数    |
| ------------------------------- | ------- | ------------ | ------- |
| `commitHostUpdate`              | 11.9 ms | **559.1 ms** | **47×** |
| `updateProperties`              | 11.6 ms | 386.3 ms     | 33×     |
| `mergeProps`（framer-motion）   | 8.3 ms  | 314.1 ms     | 38×     |
| `renderWithHooks`               | 13.1 ms | 301.8 ms     | 23×     |
| `createWorkInProgress`          | 5.5 ms  | 220.5 ms     | 40×     |
| `removeChild`（原生）           | 13.4 ms | 205.2 ms     | 15×     |
| `beginWork`                     | 6.5 ms  | 203.7 ms     | 31×     |
| `formatMessageTimestampTitle`   | 4.7 ms  | **192.2 ms** | **41×** |
| `areHookInputsEqual`            | —       | 172.5 ms     | —       |
| `reconcileChildFibersImpl`      | 7.0 ms  | 162.0 ms     | 23×     |
| `react_production.cloneElement` | —       | 163.0 ms     | —       |

而 CDP 的脚本总量只从 412 ms 涨到 2,492 ms（**6×**）。也就是说：**记录变长时，多出来的成本主要不是
「渲染新内容」，而是「把老内容再提交一遍」** —— 提交路径（`commitHostUpdate` / `updateProperties` /
`mergeProps` / `cloneElement` / `removeChild`）是超线性增长的那一半。

## 十 目前能确定与不能确定的

**能确定**：超线性增长在老内容的重复提交上；时间戳格式化（`formatMessageTimestampTitle`，每次渲染都调
`Intl.DateTimeFormat.format`）在 40 回合里被调了 192 ms，是「整行参与重渲」的直接旁证 —— 它不是原因，
但它的量级能当**指示器**：修好重复提交后这个数应当跟着掉。

**不能确定（不写结论）**：究竟是谁让老行重渲。已经排掉的两个假设：

- 列表容器每次新造 props —— 排掉：`WorkspaceMessageScroller` 有 `itemPropsCacheRef` 逐槽缓存 props，
  依赖元组相同就复用，闭包也在缓存内；
- 行组件在每次增量都重新挂载 —— 未证实：`mutation` 只有 0.87 批/帧，不像整树重挂。

下一步要用**计数**而不是推断来定位：在每个行组件里数一次渲染次数（探针，不进产品），40 回合跑一遍，
看「渲染次数 × 行数」是否随帧线性增长。只有那个读数能区分「订阅选择器没回到同一个值」和
「`MessageScroller` 的虚拟化/containment 在重排」。

## 十一 复算第三份

```bash
PERF_TURNS=40 npx playwright test e2e/perf/profile-turns.spec.ts --reporter=line
```

日志：`/tmp/ps_profile40.log`。
