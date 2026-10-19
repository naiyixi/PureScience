# 停顿期间的机器侧采样线：另一条线程在停顿时到底看见了什么

取数日期 2026-10-19（第二轮）。仓库 `naiyixi/PureScience`，基点 `0f51a96e`（origin/main）。
上一轮交付的看门狗见 `docs/evidence/2026-10-19-event-loop-stall-watchdog.md`，它自己 §4 第三条写着边界：
**机器侧读数（`freeMemMb` / `loadAvg1m`）是在停顿结束那一刻取的，不是停顿期间**。本单元收的就是这一格。

## 1 为什么「结束那一刻」不够，以及为什么非得另起一条线程

看门狗的心跳、`process.cpuUsage`、`machine()` 全跑在主进程的主线程上。主线程被停住时，
**它自己一个读数都取不到**：能写进日志的要么是停顿之前，要么是停顿之后。于是「当时机器是不是没内存了」
这件事从来没有被测量过，只是从恢复后的快照里被推断。

一条自己的线程不受此限：主线程被同步块挡住时，worker 的 tick 照常跑；主线程被操作系统整体停止
（换页、`SIGSTOP`、磁盘换入）时，worker 也一起停。**这个差别本身就是一条读数**：

| worker 的 timeline 在停顿里 | 能说什么 |
| --- | --- |
| 采样照常（`continuity: kept-sampling`） | 机器在跑，只有主线程被饿住 ⇒ 不是整机冻结 |
| 恰好停顿时宽一个洞（`continuity: gapped`、`samples: 0`） | 整个进程（所有线程）都没被调度 ⇒ 换页 / 整机停住的形状 |

配上停顿窗口内的空闲内存、load 与换页计数，就是「机器侧」那一半。

## 2 交付

| 文件 | 内容 |
| --- | --- |
| `src/main/diagnostics/host-stall-sampler.ts`（新） | worker 线程（`eval` 内联程序，无打包入口）：250 ms 取 `process.cpuUsage` 增量 + `freemem` + `loadavg` + `rss`；500 ms 取一次平台换页计数原文（darwin `vm_stat`、linux `/proc/vmstat`）。收到 `flush` 时**把缓冲整份回传**（不是靠逐条 postMessage 投递，避免主线程刚恢复时消息还没排到），主线程再按 `[停顿开始, 停顿结束]` 切片。平台换页原文的**解释**在主线程（`parsePagingCounters`），IO 与解释分开 ⇒ 解析规则只有一个家、可单测 |
| 同名 `.test.ts`（新） | 4 条解析（真 `vm_stat` 原文、`/proc/vmstat` 形状、无此能力的平台返回空、文本不认识返回空）+ 5 条切片（窗口内读数、**整段冻结的洞**、只有一个锚点只能说 `unknown`、一个样本都没有、换页增量只认窗口内的读数）+ 2 条**真线程**（主线程忙等 600 ms 期间照常有 ≥2 个窗口内样本且 `cpuMs > 0`；worker 起不来时报 `unavailable` 而不是「什么都没看见」） |
| `src/main/diagnostics/event-loop-stall-watchdog.ts` | 每条记录多一格 `host`（`window-armed` / `sampled` / `no-in-stall-samples` / `unavailable`）；窗口打开时同时起剖析器与采样线程，第二次停顿结束时两半一起收；另修一处**读错的墙钟**（见 §4） |
| 同名 `.test.ts` | 既有 7 条注入式全部补上采样线程的桩（否则它们在假时钟下会起真线程）；新增 1 条「第一次停顿说 `window-armed`、第二次把窗口交给线程并报出它看见的读数」+ 2 条剖析器读数规则（真冻结 vs 真忙） |

**刻意不做**：不开通道、不碰界面、不加 9 语键（读数进应用自己的日志）；不给「机器压力」另立一条阈值——
那会是先编一个数字再让读数去凑；**不把 `host` 折进 `attribution`**：`attribution` 仍只回答
「我们自己烧 CPU 还是没被调度」，机器侧读数是并列证据，分析者两格一起看。

## 3 真进程读数（不是单测）

两跑都是真 `node` 进程、真 `initLogger` 写 JSON Lines、生产代码原样（esbuild 打包后运行），
与上一轮同一套驱动方式；机器侧读数由**真线程**在停顿期间取。

### 3.1 我们自己挡住事件循环（忙等 1.2 s）

```json
{"windowMs":1299,"cpuMs":1213,"cpuShare":0.934,"attribution":"cpu-bound-in-process",
 "stack":{"status":"profiled","mainThreadMs":1350,"unobservedMs":0,
          "frames":[{"frame":"block (tmp/wd2-driver-busy.mjs:734)","samples":112},
                    {"frame":"(anonymous) (tmp/wd2-driver-busy.mjs:0)","samples":10}]},
 "host":{"status":"sampled","intervalMs":250,"stallMs":1299,"samples":5,"expectedSamples":4,
         "maxGapMs":259,"continuity":"kept-sampling","cpuMs":1025,"cpuShare":0.789,
         "freeMemMbMin":1165,"freeMemMbMax":1178,"loadAvg1mMax":5.02,"rssMbMax":71,
         "pageouts":0,"swapouts":0}}
```

`host.cpuShare 0.789` 是**另一条线程**量出来的进程 CPU 占比，与主线程自己算的 `0.934` 独立但一致
（差值来自 250 ms 采样的边界）；`pageouts 0` 是「窗口内真的取到了两次以上的换页读数，且一条都没动」，
不是「没测」。

### 3.2 操作系统把整个进程停住（外部 `kill -STOP` 两次，各 2 s）

第一次停顿只负责打开窗口；第二次停顿（也是 2 s）才有采样线：

```json
{"windowMs":2049,"cpuMs":1,"cpuShare":0,"attribution":"process-not-scheduled",
 "stack":{"status":"profiled","mainThreadMs":73,"unobservedMs":2027,"frames":[]},
 "host":{"status":"sampled","intervalMs":250,"stallMs":2049,"samples":1,"expectedSamples":7,
         "maxGapMs":2224,"continuity":"gapped","cpuMs":12,"cpuShare":0.006,
         "freeMemMbMin":1043,"freeMemMbMax":1043,"loadAvg1mMax":4.33,"rssMbMax":65}}
```

`continuity: gapped` + `samples: 1`（而按 250 ms 应有 7 个）+ `maxGapMs 2224` 合起来就是
「采样线程自己也被停了」——这正是整机冻结的形状，与 §3.1 的 `kept-sampling / maxGapMs 258` 正相反。
两跑用的是**同一份生产代码**，只有停顿的成因不同。上面是**最终代码的第二跑**（修法与状态机调整之后）；
再往前同一形状还跑过一次，读数同向（忙等 `0.931 / kept-sampling / 258`，冻结 `process-not-scheduled /
gapped / 2221`）⇒ 不是一次巧合。中间那次全量单测占用过内存，所以两张表的 `freeMemMb` 不同——
那是机器状态不同，不是仪器漂移。

## 4 这一跑抓出的一处真缺陷（上一轮留下的）

第一次跑 §3.2 时，同一条冻结记录报的是：

```
"attribution":"cpu-bound-in-process","stack":{"status":"profiled","mainThreadMs":2103,...}
```

一个 2053 ms 的停顿里「主线程跑了 2103 ms」——**把整机冻结说成了我们自己的代码在烧 CPU**。
根因在 V8 剖析读数：`timeDeltas` 是两个样本之间的时间，而冻结期间**采样线程也停了**，恢复后那一个
delta 就等于整个冻结时长，原实现把它原样加进 `mainThreadMs`。这与「没测量就当测量」是同一类错。

修法（已落地并有用例钉住）：**delta 超过 `PROFILE_UNOBSERVED_DELTA_MS`（500 ms）就算「没人观测到」**，
计进新字段 `unobservedMs`，不计入主线程运行时间，也不参与 `attribution` 的覆盖。

- 判据来自实测：剖析器按 1 ms 请求、这台机器给的是约 10–11 ms 一个样本（§3.1 的 120 样本 / 1298 ms），
  所以几百毫秒的洞只可能是采样线程没在跑，不可能是「主线程忙」。
- 修后同一跑：`mainThreadMs 73 / unobservedMs 2026 / attribution process-not-scheduled`（§3.2 原文）。
- 单测：「一次 2 s 的洞 + 三个正常样本 ⇒ 主线程 33 ms、未观测 2000 ms、帧仍点名」；对照「四个正常样本 ⇒
  未观测 0、主线程 44 ms」。

## 5 边界（不许读成更强）

- **仍未在 Electron 主进程里跑过**。本机内存闸门（现取）：空闲物理页 **4,074（≈64 MB）**、
  swap 已用 **10.1 G / 11.0 G**。worker、`vm_stat` 调用、开机接线都只在真 `node` 进程里跑过。
  解封条件：下一次打包版或 dev 实例正常运行。
- **`vm_stat` 依赖 PATH**：打包版从 Finder 启动时 PATH 很窄，找不到命令就**没有换页读数**（`pageouts`
  缺席，不是 0）。这条只有真机才验得出来，本轮**未验**。
- **窗口对齐用的是墙钟**（`Date.now()`）：worker 与主线程共享同一个墙钟，但系统时钟被 NTP 拨动时
  `[from, to]` 会偏；偏差表现为「窗口内少了一两个样本」，不会造出假读数。
- **`continuity` 是命名启发式，不是定律**：3× 采样周期的门限是标定值；机器负载高时 worker 自己的 tick
  会拉长，`kept-sampling` 可能变成 `gapped`。所以真线程那条用例**只断言样本数**，不断言 continuity；
  continuity 由合成 timeline 的用例钉住（那里是精确的）。
- **一次停顿仍只能看一半**：采样线跟着剖析窗口走，只有窗口内的**第二次**停顿才有读数；单发停顿只有
  `window-armed`。这是照搬上一轮的策略（那 14 分钟里停顿成串），不是遗漏。
- **`host.cpuMs` 的边界**：第一个窗口内样本的 delta 跨越了停顿前的时刻，会有约一个采样周期的多算；
  1.3 s 的停顿上这是 20% 量级的误差，只看量级、不当精确值用。

## 6 下一步

- 拿到**真机**（Electron 主进程 / 打包版）的第一条读数时，按这台仪器的判据分流：
  `cpu-bound-in-process` + 帧点名 ⇒ 改那个函数；`process-not-scheduled` + `gapped` ⇒ 机器侧（换页/冻结）；
  `process-not-scheduled` + `kept-sampling` ⇒ 主线程被单独饿住（调度或别的进程）。
- `inconclusive` 不再靠「再加读数」猜：现在有 `host` 三格（窗口内内存/负载/换页）与 `unobservedMs`，
  中间带出现时先看这几格再决定要不要更长的窗口。
