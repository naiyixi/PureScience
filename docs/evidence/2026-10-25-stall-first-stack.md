# 第一段停顿也要有栈：把「事后才开采样」换成常开 + 有界轮转

日期：2026-10-25（执行器轮次，§两百二十九）。改的是量仪（`src/main/diagnostics/**`），不动任何业务路径。

## 一 缺口是什么

`event-loop-stall-watchdog` 原来只在**报出第一段 stall 之后**才去开 V8 profiler，于是**一次突发里最长的那一段
（2026-10-23 日志里 19.7 s）永远没有栈**：它每次都只能记 `no-second-stall`。这不是「碰巧没采到」，是构造上采不到。

## 二 先量代价，再决定 cadence

同一台 8 核机、同一个 CPU 密集循环（约 1.2 s/次）、六轮 A/B/A/B 交替（避免漂移全落在某一档）：

| cadence       | 中位    | 相对自身基线 | 备注                                        |
| ------------- | ------- | ------------ | ------------------------------------------- |
| 不开 profiler | 1214 ms | 0            | 六次落在 806–1287 ms ⇒ 本机噪声约 ±25 %     |
| 1 ms          | 1434 ms | **+18.10 %** | 另一轮独立测量 **+22.60 %**（基线 2227 ms） |
| 20 ms         | 1022 ms | −15.86 %     | 在噪声内                                    |
| 50 ms         | 1190 ms | −1.99 %      | 在噪声内                                    |
| 100 ms        | 1371 ms | +12.89 %     | 在噪声内（噪声就那么大）                    |

机器状态照实记：`load1` 11.9–13.5（8 核），swap 已用 6.78 GB / 7.17 GB —— 所以**粗档的差别测不出来**，
这句话的正确读法是「低于本机噪声下界」，**不是「0 代价」**。1 ms 常开两轮都在噪声之上 ⇒ 不能作为默认。

## 三 机制自证（探针先证明读数通道可用）

1. **一条 inspector 会话能反复 stop/start**（有界轮转的前提）：一次会话连续服务了 4 段录制，段段都有读数。
2. **50 ms cadence 仍能点出阻塞函数**：一次 1.1 s 的忙等得到 17–20 个样本，全部落在阻塞函数上。
   同一次测量里还记到一条**诚实的限制**：第 2、3 段在 TurboFan 内联之后报成 `(anonymous) (…:0)`。
   ⇒ 粗档能点名「没被内联掉」的帧；真机日志里那些 `stringifyLogRecord (out/main/index.js:282)` 属于这一类。

## 四 真机读数（Electron 自己的运行时）

用 esbuild 把 `event-loop-stall-watchdog`（含新模块）打成单文件，用 `ELECTRON_RUN_AS_NODE=1 electron` 跑
——即 **Electron 43.7.5 的 Node 24.21.0 / V8 15.0.245.31-electron.0**，真 inspector、真 host 线程、真忙等：

```
runtime: node=24.21.0 electron=43.7.5 v8=15.0.245.31-electron.0
[record 1] event loop stalled { windowMs:1603, lateMs:1503, cpuShare:0.371,
  attribution:"cpu-bound-in-process",
  stack:{ status:"profiled", mainThreadMs:1658, unobservedMs:0,
          frames:[{frame:"blockLoop (tmp/ps-stall-probe.cjs:14)", samples:21},
                  {frame:"main (tmp/ps-stall-probe.cjs:23)", samples:1}] },
  host:{ status:"window-armed" } }
[record 2] event loop stalled { windowMs:1101, cpuShare:0.355, stack:{status:"profiled", frames:[…16 samples]},
  host:{ status:"sampled", intervalMs:250, samples:4, maxGapMs:253, continuity:"kept-sampling",
         pageouts:0, swapouts:0 } }
SUMMARY every-record-profiled=true
```

第一段就是**这一次运行的第一段**，它有栈，且点出来的就是那个忙等函数。

## 五 边界（不许读成更强）

1. 本单元证明的是「第一段 stall 也能被点名」，**不是**「10-23 那 20 秒是谁按住的」。真机这次的阻塞是探针自己造的。
2. `mainThreadMs` 可以**略超** `windowMs`（本例 1658 > 1603）：窗口按 `stall + max(50 ms, cadence)` 取，
   会把紧邻停顿之前的一两个样本算进来。比值仍然夹在 `[0,1]`，`attribution` 用的是夹过的值。
3. 只在 **Electron 的 Node 运行时**里取到读数，没起带窗实例；产品主进程里那一行要等下一次真机 stall。
4. `host` 的第一段仍是 `window-armed`（采样线程还是事后才起）——同族的下一件，本单元没动。
