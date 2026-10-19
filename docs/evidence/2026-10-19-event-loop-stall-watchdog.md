# 事件循环停顿看门狗：把「进程停了」与「我们的代码挡住了」分开

取数日期 2026-10-19。仓库 `naiyixi/PureScience`，基点 `2de9975d`（origin/main）。
上一轮的结论见 `docs/evidence/2026-10-19-save-session-attribution.md`：`sessions:save-session` 那 118.9 秒
**不在保存的实现里**，而是同一 150 秒窗口里整个进程一起停住（`SELECT 1` 也要 7.2 s、`readEventLoopMaxMs`
7.3–12.0 s）。那份档把下一步定为「① 事件循环延迟看门狗（>500 ms 采同步栈）② 同刻机器侧读数」。
本轮交付的就是这台仪器。

## 1 为什么现有读数不够

`queuedMs` / `authorityMs` / `writeMs` 这些分段都是**墙钟**分段：进程被换页停住、与代码同步阻塞，
读数**同形**——定时器在两种情况下都会迟到。上一轮已经用「等比放大」否掉了「保存里某一步贵」，
但没有东西能把「我们自己挡住的」与「机器没调度我们」分开。

仪器加两条读数，各自能回答一半：

| 读数 | 怎么来 | 判什么 |
| --- | --- | --- |
| `cpuShare` | 一个 500 ms 心跳，用 `process.cpuUsage(previous)` 取这段时间的 CPU 时间，除以墙钟迟到的毫秒数 | 迟到的大部分时间在烧 CPU ⇒ 是我们；几乎没烧 ⇒ 进程没被调度 |
| 主线程运行时间 + 同步栈 | 首次停顿后给 V8 抽样剖析器开一个 15 秒窗口（1 ms 采样，**另一条线程**采样），窗口内的第二次停顿结束时停表，按「剖析自身的时长」切出停顿那一段 | 主线程真跑了多久；跑的是哪个函数 |

判据（写成常量、写进档，不藏）：

- `cpuShare ≥ 0.6` → `cpu-bound-in-process`
- `cpuShare ≤ 0.15` → `process-not-scheduled`
- 之间 → `inconclusive`（**不许**把中间带硬塞进某个结论）

第二次停顿有剖析时，用**主线程运行时间/墙钟**再做一次同样的判定，并覆盖第一次的结论——
`process.cpuUsage` 数的是整个进程（含 libuv 线程池与 V8 辅助线程），那些线程忙而主线程没跑时，
`cpuShare` 会虚高。

## 2 交付

| 文件 | 内容 |
| --- | --- |
| `src/main/diagnostics/event-loop-stall-watchdog.ts` | 仪器本体：心跳、判别、按需剖析、日志 |
| `src/main/diagnostics/event-loop-stall-watchdog.test.ts` | 7 条注入式（假时钟/假 CPU/假剖析器）+ 1 条**真时钟真剖析器** |
| `src/main/index.ts` | 开机接线（拿到诊断日志之后立刻起一次），并在既有的 `process.on('exit')` 里收掉 |

设计上刻意不做的三件事：

- **不做常驻剖析**：健康进程一个采样都不采；只有在**已经迟到过一次**之后才开 15 秒窗口，窗口内没有
  第二次停顿就自己停表（常驻 1 ms 抽样会为进程的一生攒样本）。
- **不新开通道、不碰界面、不加 9 语键**：读数写进应用自己的日志（`warn` / 帧 `diagnostics` / 消息
  `event loop stalled`），分析者按日志读，与 §一的取证方式同一条链。
- **不顺手改保存路径**：上一轮已证伪「保存慢」，这一轮只加仪器。

## 3 真进程读数（不是单测）

两跑都是**真** `node` 进程、真 `initLogger` 写盘、真 `monitorEventLoopDelay` 之外的一切（心跳、`cpuUsage`、
剖析器）都走生产代码；脚本用 esbuild 把仓内两个模块打成一份可执行件后运行。日志是应用自己的
JSON Lines 格式。

### 3.1 我们自己挡住事件循环

```
{"windowMs":699,"cpuMs":607,"cpuShare":0.868,"attribution":"cpu-bound-in-process",
 "stack":{"status":"no-second-stall"}}
{"windowMs":1000,"cpuMs":906,"cpuShare":0.906,"attribution":"cpu-bound-in-process",
 "stack":{"status":"profiled","mainThreadMs":1051,
          "frames":[{"frame":"block (tmp/wd-driver.mjs:476)","samples":91},
                    {"frame":"(anonymous) (tmp/wd-driver.mjs:0)","samples":6}]}}
```

第一次停顿只说了「这半小时里有 CPU」并开启了窗口；第二次停顿**点名了那个函数**（`block`，
就是驱动脚本里那个忙等）。`mainThreadMs 1051` 略大于窗口 1000 ms，是因为窗口带 50 ms 松弛
（`PROFILE_WINDOW_SLACK_MS`），不是量错了。

### 3.2 操作系统把进程停住

同一份代码，不做忙等，改由**外部** `kill -STOP` 停 2 秒再 `kill -CONT`——这正是换页/磁盘换入时进程的形状：
墙钟在走，CPU 不烧。

```
stopped 40237 at 15:37:00
continued at 15:37:02
{"windowMs":2087,"cpuMs":0,"cpuShare":0,"attribution":"process-not-scheduled",
 "stack":{"status":"no-second-stall"}}
```

`cpuMs` 是 **0**、结论是 `process-not-scheduled`。这两跑合起来，就是上一轮缺的那条判别线：
**同形读数，现在能分开**。

### 3.3 单测里的真时钟那一条

`npx vitest run src/main/diagnostics/event-loop-stall-watchdog.test.ts` ⇒ **8 passed**。
其中真时钟那一条阻塞两次事件循环，断言剖析结果里出现本文件自己的函数：

```
blockLoop (src/main/diagnostics/event-loop-stall-watchdog.test.ts:198)   samples 60
```

这条用例的价值在「剖析器能返回东西」——它是唯一会**静默返回空**的一半（剖析器不可用、或时间窗切错，
都只会得到 `frames: []`）。第一版就踩了这个：按 `profile.startTime` 当纪元微秒去切窗口，实测
`startTime` 是**单调时钟**（819902348376 µs ≈ 开机后 9.5 天），于是所有样本被切掉、`frames` 恒为空。
改成「按剖析自身的时长取尾部 `stalledForMs` 那一段」后才有输出；档里记这一笔，是因为它长得完全像
「这次停顿里没有我们的代码」。

## 4 边界（不许读成更强）

- **没有在 Electron 主进程里跑过**。本机内存闸门（现取）：空闲物理页 **4,048（≈63 MB）**、swap 已用
  **9.70 G / 10.24 G** ⇒ 本轮不起 Electron。开机接线在 `src/main/index.ts`，但它的**第一条真实读数
  还没产生**，这一格姓「未取」。解封条件：下一次打包版或 dev 实例正常运行（哪怕不停顿，也只会在
  真的迟到时才写行）。
- **剖析帧在生产包里长相不同**：打包后产品代码都在 `out/main/index.js:<行>`。构建若压缩，函数名会退化成
  单字母——行号仍指向 bundle，可回查 sourcemap，但本轮**没有**在打包产物上验证过这一步。
- **机器侧读数是停顿结束那一刻取的**，不是停顿期间：`freeMemMb` / `loadAvg1m` / `rssMb` 反映的是「刚
  恢复时」的机器，不能当成停顿中的快照。
- **一次停顿只能分到两半里的一半**：点名函数需要窗口内的**第二次**停顿。上一轮那 14 分钟里停顿是成串的
  （5 个不同的秒、多个通道），所以这种策略对那次的形状有效；单发的 600 ms 卡顿只会得到
  `no-second-stall`。
- 判别阈值（0.6 / 0.15）是**标定值不是定律**：两跑的读数分别是 0.87–0.91 与 0.0，中间带留给
  `inconclusive`。

## 5 下一步（判据沿用上一轮那份档）

拿到一条真实顿挫读数后，按 §7 的口径收口：

- `attribution: cpu-bound-in-process` 且 `frames` 点名了我们自己的函数 ⇒ 去改那个函数。
- `attribution: process-not-scheduled` 或机器侧读数显示空闲页耗尽 ⇒ 这是机器侧问题，**不动保存路径**，
  转而记容量/换页这条线（例如把「同时打开的项目/大文件」与停顿对齐）。
- `inconclusive` ⇒ 加读数（更长窗口、更高采样率、或把 `vm_stat` 的空闲页与换页计数并进同一条记录），
  **不要**凭它改代码。
