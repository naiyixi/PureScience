# `fs-queue-saturated` 这个判决在 98.8% 的记录上没有证据：一次「循环不在了」被记成了「线程池满了」

> 时间：2026-11-02 06:0x（执行器轮次 §277）。对象：`src/main/diagnostics/stall-cause.ts` 的
> `classifyStallCause()`。数据源：用户本人打包版的三份真机日志
> `~/Library/Logs/PureScience/{main,main.1,main.2}.log`（窗口 2026-10-28T06:35Z → 2026-11-01T21:57Z）。

## 一 缺口：判决用的那把尺，测不到它声称在测的东西

`classifyStallCause()` 对每一次事件循环停滞给一个具名 cause。`fs-queue-saturated` 的判据是两条：
`canaryMs ≥ 20` 且 `canaryMs ≥ lateMs × 0.1`（见 `stall-cause.ts` 的 `FS_SATURATED_*`）。

**问题一：canary 的等待里必然包含停滞本身。** canary 是一次 `readFile()`，它的完成回调是**事件循环回调**。
看门狗在停滞结束的那一刻发起它、与采样器一起 await（`event-loop-stall-watchdog.ts:266`，注释还写着
「不能晚发起，否则量到的是已经追上的池」）。于是「循环不在了」和「线程池忙」在读数上**逐字同形**：
只要循环不走，回调就回不来。

**问题二：唯一能区分两者的那个字段被判据忽略了。** 读数里带着 `inFlight`（停滞结束那一刻我们自己的读还在排队的条数），
但 `fsSaturated` 的三行里没有任何一行看它。而它恰恰是这个判决唯一的正面证据：
`canaryMs` 大 + `inFlight = 0` ＝ canary 等的不是池，是循环。

## 二 现场读数（真机日志，改前）

按 `msg == "event loop stalled"` 抽全部记录（3,585 条），其中带可用 fs 读数 **3,503 条**：

| 判决 | 条数 |
|---|---|
| `fs-queue-saturated` | **3,460** |
| `garbage-collection` | 18 |
| `cpu-in-process` | 13 |
| `unexplained` | 12 |

在这 3,460 条里：

- **`inFlight = 0` 的有 3,436 条（99.3%）**；`inFlight` 1–3 的只有 24 条。
- `canaryMs / lateMs` 的**中位 4.1、p90 9.9** —— canary 比自己要解释的那段停滞还长 4–10 倍。
- 典型记录（原文）：

```
lateMs 507  canaryMs 5826  inFlight 0  windowMs 1007
lateMs 973  canaryMs 5723  inFlight 0  windowMs 1473
lateMs 801  canaryMs 5496  inFlight 0  windowMs 1301
```

同一批记录的机器读数：`freeMemMb 115 / totalMemMb 8590`、`loadAvg1m 7.31`。
也就是说这些窗口里机器在换页、循环没被调度 —— 而记录上写的是我们自己的文件系统线程池满了。
**这正是本仓反复立过的那条**：一次没有发生的测量被当成一次测量；缺席被印成了存在的证据。

## 三 交付

| 位置 | 改动 |
|---|---|
| `src/main/diagnostics/stall-cause.ts` | `fsSaturated` 增加一条硬前提 **`fs.inFlight > 0`**：没有任何我们自己的读在排队时，canary 的等待只能归给循环，不能归给池。`describeFs()` 两态写法（`with N of our reads waiting` / `with nothing of ours queued`）；`unexplained` 的句子在「canary 很慢但无人排队」时补一句 `; that canary waited on a loop that was gone, not on a busy pool` —— 否则读者只会看到那个 5,826 ms 又把它读回池。类型注释写明 `inFlight` **不是**池深度（只统计调用 `beginFsOperation` 的调用方，当前只有 managed preview acquire 一条路），所以 0 的含义是「没有证据」，不是「池空闲」 |
| `src/main/diagnostics/stall-cause.test.ts` | share 门槛那条用例的三处夹具补上「有排在队里的读」，让它继续测**份额**而不是被新闸顺带决定；新增两条成对用例：真机形状（`lateMs 507 / canary 5826 / inFlight 0`）必须**不是** `fs-queue-saturated` 且句子点名原因；`inFlight ≥ 1` 时**仍然**是 `fs-queue-saturated`（防止把闸满足成「永不再点名池」） |
| `src/main/diagnostics/event-loop-stall-watchdog.test.ts` | 走**真报道路径**再加一例：`inFlight: () => 0` + canary 5,826 ⇒ `unexplained`，`basis` 含 `nothing of ours queued` 与 `waited on a loop that was gone`，且 `fs` 读数原样保留 |
| `src/main/diagnostics/support-bundle.ts` | `event-loop-stalls.json` 的说明补一句：`fs-queue-saturated` 只在「我们自己的读也在等同一个池」时才给；canary 慢而无人排队＝循环不在了。导出件是外部读者唯一的说明书，说明与判据必须同步 |

## 四 真机读数（生产函数 × 真实记录的回放，改前/改后）

做法：用 `esbuild` 把 `HEAD` 版与工作区版**同一份生产模块**各转成 ESM，喂同一批 3,503 条真机记录
（`lateMs`/`attribution`/`gc`/`fs` 都是日志里原样的值，不改写），比两次判决。
**这是一次回放，不是一次实时窗口读数** —— 分类器是纯函数，回放与真机跑的是同一段代码；但它证明不了
「重启后的进程会这样写日志」，那一半见 §五 具名未办。

```
before: {"fs-queue-saturated":3460,"unexplained":12,"cpu-in-process":13,"garbage-collection":18}
after : {"unexplained":2664,"cpu-in-process":797,"garbage-collection":18,"fs-queue-saturated":24}
moved : 3436   （fs-queue-saturated → unexplained 2652 / → cpu-in-process 784）
留下的 24 条 inFlight: [1,1,1,1,1,1,1,1,1,3,2,2,1,1,1,1,1,1,1,1,1,1,1,1]
```

改后第一条真机记录的句子（原文）：

```
507 ms late with gc 0 ms in 0 pause(s) and fs canary 5826 ms with nothing of ours queued;
that canary waited on a loop that was gone, not on a busy pool; held outside what this process measures
```

三条要点：① 池判决从「几乎所有停滞」收敛到**有正面证据的 24 条**；② 那 24 条的 `inFlight` 全是 1–3，
与日志里 `inFlight > 0` 的计数**逐个对上**（21 + 2 + 1 = 24）；③ 被移动的 3,436 条落在
`unexplained` / `cpu-in-process`，这两个词的句子都如实带着「谁也没能解释这段窗口」这一层意思。

## 五 边界（不许读成更强）与具名未办

1. **没有实时窗口读数。** 要取的话需要重启一个实例并等它真停滞一次 —— 本轮不动用户正在跑的实例。
   回放证明「同一段代码对真实输入给出这个判决」，不证明「下一份日志会长这样」。
2. **`inFlight` 的覆盖面很窄**：`beginFsOperation()` 在生产里只有一个调用方
   （`managed-preview-resources.ts:192`）。所以本轮**不是**把「池满」测准了，而是把「没有证据时不点名池」这条立起来。
   要真正测池，得让更多读路径自报 —— 那是一条独立的、会牵动多个调用方的单元，未立项。
3. **不声称那 232 秒 / 268 秒的长停滞被解释**。它们的 `lateMs` 最大 268,736 ms，机器读数（`freeMemMb` 百兆级、
   `loadAvg` 数十）指向整机压力；本轮只修「读数被贴错标签」这一半。
4. **不改判据的其它两个分支**（GC、cpu-in-process）——它们的门槛与份额逻辑本轮一个字节没动。
