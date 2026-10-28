# 抖动窗口环「丢掉的覆盖」不再读成「循环没被占住」（2026-10-28）

## 一 缺口（改之前长什么样）

`src/main/diagnostics/loop-held-windows.ts` 的环是**有界**的（默认 64 条，只收 ≥200 ms 的停顿）。满了之后
`windows.shift()` 丢掉最旧的那条，源码注释写明这种丢法「under-reports held time（安全方向）」。问题在**读侧**：

- `heldMsWithin()` 对已丢弃的区间只能答 0；
- `heldSplitFromMeasured()` 把 0 当成「没有可拆的」⇒ `heldSplitFields()` 返回 `{}` ⇒ 慢行**一个字段都不打**；
- 于是「这一段没有任何窗口覆盖」与「循环在这段里根本没被占住」在日志里是**同一行**。

这不是理论问题：本机日志里有一次启动记录了 **160,367** 条停顿（中位 502 ms），而环只留最后 64 条 ≈ 32 秒。
在那 11 小时的风暴里，比这个边界更早开始的慢行，改前一律被读成「这些时间是我们的」——正是这套拆分存在
的理由（把机器侧的冻结读成产品侧的慢路径）被反过来用了一次。

同目录的兄弟环（`stall-record-ring`）早就有 `observed / kept / dropped / capacity` 四个数来说明自己丢了什么；
本环缺的正是这一半。

## 二 交付

| 位置 | 改动 |
|---|---|
| `loop-held-windows.ts` | `LoopHeldWindows` 新增 `coverageStartMs()`：环**还完整覆盖**的起点（= 最近一条被丢弃窗口的 `endMs`；一条都没丢时是 `undefined`，此时覆盖回溯到第一条窗口）。新增 `HeldUnsplittable = { heldUnmeasured: 'windows-dropped' }`，于是读侧有**三态**：拆开了 / 答不了（具名）/ 没有可拆的（字段缺席） |
| `loop-held-windows.ts` | `heldSplitForMonotonicWindow` / `heldSplitForWallWindow` / `heldSplitFields` 返回 `HeldReading | undefined`；`coverageStartMs` 是**可选**方法，只用 `heldMsWithin` 构造的替身保持原行为（没丢过 ⇒ 没什么要声明的）；它抛错时也退回原行为（仪器不许把慢行弄没） |
| `diagnostics/ipc-rejection.ts` | 慢 IPC 行默认从共享环取覆盖起点（`heldCoverageStartMs` 仅测试注入）⇒ 标记在**生产默认路径**上成立，不是只在注入时才成立 |
| `application-command-router.ts` | 同上（`slow-handler` / `handler-rejected` 两类行）；`HandlerTiming` 与诊断类型补 `heldUnmeasured` |
| `diagnostics/compose-steps.ts` | 启动步骤的快照条目带 `heldUnmeasured`（不写 `heldMs`），窗口 `heldMs` 合计**不把未知当 0 加进去**；慢行与归档件用同一个词 |

判据写在源码里：**「没测到」不许与「测到 0」同形**。第三条状态是这一族唯一的诚实出口 —— 报 0 会把一次冻结
说成我们的工作，什么都不报会把墙钟整体算成我们的成本。

## 三 真机读数（本机 `logs/headless.out.log`，只读，启动边界用每次启动都会打印的那行 `PureScience Web:` 切分）

| 读数 | 值 |
|---|---|
| 启动次数（日志内） | **224** |
| 每次启动的停顿条数：中位 / p90 / 最大 | **0 / 2 / 160,367** |
| 停顿条数 ≥ 64（即环被撑满过）的启动 | **3** 次（94 / 1,505 / 160,367） |
| 最严重那次 | 160,367 条，`stallMs` 中位 **502**、最大 1,880 ⇒ 累计「循环被占住」约 **39,665 秒** |
| 环在改前能覆盖的那一段 | 最后 **64** 条 ≈ **32 秒** ⇒ 风暴里更早的慢行**全部**落在覆盖之外 |

结论只到这为止：**这证明「环被撑满」在本机真发生过，且发生过一次极端的**，不证明标记已经在新代码上被打出来
（见 §四）。

## 四 边界（不许读成更强）

1. **改前那次风暴里的旧读数无法回填**：日志里的慢行是旧代码打的，没有 `heldUnmeasured` 这个词；本单元只保证
   **下一次**遇到同样的形状时，屏上/日志里会出现那个具名词。
2. **生产里的标记读数尚未取**：它只在「进程活到环被撑满 + 有一个跨越边界的慢行」时出现。本机当前常驻实例加载的
   是旧构建，取它需要一次新构建的长会话（与「重启常驻 dev 实例要用户点头」同一张待办）。
3. **`heldUnmeasured` 不是失败标记**，也不是「这段时间是我们的」：它只说这一段的窗口覆盖不够，**不做推断**。
4. 窗口下限（200 ms）与容量（64）**都没动**：本单元只让「丢了什么」可读，不改测量本身。

## 五 门禁读数（全部实跑；数字取自最后一次改动之后）

| 环 | 读数 |
|---|---|
| 定向：`src/main/diagnostics` + `application-command-router.test.ts` + `notebook/runtime-service.test.ts` + `settings/service.key-migration-attribution.test.ts` + `ipc-startup-attribution.test.ts`（`--maxWorkers=2`） | **24 files / 368 passed**，EXIT 0 |
| 新增用例 | 单元 4 条（覆盖起点、跨边界具名、可答区间仍照常拆、墙钟桥同答）+ 默认接线 1 条（撑满共享环后慢行行带标记、且**没有** `heldMs`）+ 启动步骤 1 条（归档件与慢行同词、合计不加未知） |
| 变异自证（4 次，逐个删掉改动的一部分，改完还原） | 删单调侧检查 ⇒ **1 红**；不记丢弃边界 ⇒ **3 红**；`ipc-rejection` 不传覆盖起点 ⇒ **1 红**（那条默认接线用例）；归档标记拍平为 0 ⇒ **1 红**。每次都只咬住守它的那一条 |
| 双 typecheck（`--composite false`，堆 8192，**在隔离工作树**上跑） | node **0**；web **0** |
| `eslint --no-cache`（本笔 7 文件） | **0 error / 0 warning**；`prettier --check` 全过 |
| 全量 vitest | **未跑**：本机 swap 已用 **9,352 MB / 10,240 MB**、空闲页 4,983（≈78 MB），上一轮同水位跑全量 45 分钟未完且出现 7 条负载假红。受影响面（两族适配器 + 消耗 `heldSplitFields` 的设置族 + 启动归因）逐个取过读数 |

**隔离工作树为什么必要**：共享树里另有并发写入者的未提交在制品（`src/main/acp/agent-connection-adapter.ts`），
主树上跑 `typecheck` 会在**它**那 24 行上报 3 条 `TS2339`（`cwd` / `env` 不存在于该子进程类型）——那不是本笔的红，
也不该被本笔修。读取数用的是 `/tmp/ps-holdcov`（HEAD + 本笔 7 个文件、`node_modules` 软链）。
