# `notebook:list-runtimes`：一次面板打开发 7 次读，每次各跑一遍机器级枚举

日期：2026-11-10（执行器单元）
相关：`src/main/notebook/runtime-binding.ts`、`src/main/notebook/runtime-service.test.ts`、
`docs/plan-2026-10-03-next-queue-and-round-convention.md` §三百零八

## 一 读数（真机日志，只读）

日志：`~/Library/Logs/PureScience/main.{log,1.log,2.log}`（打包版，2026-11-04 → 11-10）。

`ipc handler was slow` 里 `channel = notebook:list-runtimes` 共 **101 条**，落在 **45 个不同时间戳**上：

| 形状 | 读数 |
| --- | --- |
| 时间戳上有 **多条** 的 | **20 / 45** |
| 单条时间戳上的最大条数 | **7**（2026-11-04T15:33:24.001Z，七条 `durationMs` 全是 1,262） |
| 其余多条的样例 | 5 条 @1,001–1,002 ms、5 条 @1,110–1,111 ms、5 条 @2,877–2,878 ms、5 条 @980–981 ms |
| `attribution` | `inconclusive` 76 / `no-cpu-in-process` 23 / `cpu-bound-in-process` **2** |
| `cpuShare` 中位 | **0.235** |

**读法**：同一毫秒内 2–7 条、`durationMs` 只差 0–1 ms，是**一次爆发被合并**的形状（多条读等在同一个在飞结果上），
不是「一条读很慢」。`attribution` 里只有 2 条是「本进程在算」，中位 cpuShare 0.235 ⇒ 那一大片慢不是这条通道自己
烧 CPU，而是**同一批活被重复做了 N 遍**（枚举 + 版本探测）再加上当时的循环占用。

**边界**：这张表只覆盖**越过慢阈值的**记录 —— 同一毫秒里没越阈值的那几条不会出现在这里，所以「一次面板打开发几次」
的真值**不小于** 7，本表**不能**读成上限。上一轮记事本里写的「同一毫秒 5–12 条」与本轮的 7 条同族，取数口径不同，
以本表为准并保留这条保留意见。

## 二 缺口：枚举是**机器级**的，却被按「每次读」重做

`notebook:list-runtimes` 的调用方在渲染层只有一处（`NotebookPreview` 的 `loadRuntimes`，deps 全是原始值），
但一次面板打开会并发发出多条 —— 每条都走：

```
listRuntimes → sessionLifecycle.ensure（已按 sessionId 合流）
             → runtimeBindingOwner.list → discoverWithEnablement × 2（python / r）
             → discoverInterpreters：扫候选路径 + 逐个解释器探版本（探针有记忆化，枚举没有）
```

枚举结果只取决于这台机器，与是哪个会话、第几次读无关；因此同一毫秒里的 3–7 条读**本可以共用一次枚举**。
探针那一层 2026-11-02 已经做过「在飞的合并」（`interpreter-probe-memo.ts` 头注），**枚举这一层没有**。

## 三 交付

`runtime-binding.ts`：

- 新增 `discoveryPass(language, manualInterpreters)`：**只合流在飞的那一遍**，用
  `Map<key, {promise, joined}>` 记录；key = `language \0 manualInterpreters.join()`。
- 完成即**按身份删除**（`get(key) === pass` 才删，晚落定的旧遍不会删掉新遍）⇒ **不是缓存**：下一次读照旧重新枚举，
  两次读之间被删掉的环境仍在第二次读里消失（IC14 的判定不受影响）。
- 合流键里带**手工解释器清单**：设置在一批读的中途变化时，后来的读不会拿到另一份配置算出来的清单。
- 真有读合流时打一行具名日志 `interpreter discovery joined an in-flight pass`（`language` / `joinedReads`）——
  一次爆发一行，下一版装机后「一次面板打开发几次读」不必再从时间戳反推。

## 四 判据与自证

| 环 | 读数 |
| --- | --- |
| `runtime-service.test.ts` | **189 passed**（新增 3 例） |
| `src/main/notebook` 整目录 | **96 files passed / 9 skipped（105）· 1485 passed / 101 skipped（1586）**，exit 0 |
| `tsc -p tsconfig.node.json --composite false` | exit 0 |
| `tsc -p tsconfig.web.json --composite false` | exit 0 |
| `eslint --no-cache`（本笔 2 文件） | 0 error / 0 warning |

新增三例：① 三条并发读只各枚举一遍（`['python','r']` 而不是六条）；② **下一次读重新枚举**（合流不是缓存）；
③ 一次爆发里两个会话共用枚举、但各自的 `bindings` 与 `bound` 标记仍描述自己的会话。

**变异自证两次**：① 关掉合流分支 ⇒ ①读成 `['python','python','python',…]`（1 failed）；② 关掉「完成即删」⇒
②读成 `['python','r']`（1 failed）。两次均还原。

## 五 边界（不许读成更强）

1. **没有真机窗口读数**：这是 main 侧内部改动，装机版要等下一次发版。下一版判据 =
   日志出现 `interpreter discovery joined an in-flight pass` 且 `joinedReads ≥ 1`，同时同一时段的
   `notebook:list-runtimes` 慢行条数与时长下降（**不承诺降多少毫秒**：节省按「爆发条数 − 1」份枚举计，
   实际取决于该机器解释器数量与磁盘/内存状态，未测）。
2. **渲染层仍会发 N 次**：本笔只让第 2…N 次变便宜，没改「谁在同一个面板里发这么多次」。
   根因定位（是多个预览面板各发一次，还是同一面板的 effect 重跑）**仍未定**，需要装机新构建上的一次真机读数。
3. **慢的另一半没动**：`attribution` 里 23 条 `no-cpu-in-process` 说明部分慢是循环被别处占着，属另一族。
4. **只合流在飞的一遍**，不做跨读缓存：读必须是读（环境目录被删要立刻消失），这条不能被收益换掉。
