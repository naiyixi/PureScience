# 慢调用的那份读数不再只活在日志里：支援包带 `diagnostics/slow-operations.json`

日期：2026-10-28（执行器本轮）
提交：本文件与代码同批

## 一 结论

`ipc handler was slow` / `slow-handler` 这两族日志行，本来就已经带上了「这段时间是我们的还是进程没在跑」的
拆分（`heldMs` / `ownMs` / `heldUnmeasured` + `cpuShare`）。问题是它们只落在日志里，而支援包（用户真正会发出来
的那个 `.tar.gz`）只按**字节上限**从最新日志往回拷 8 MB。于是「慢」这件事的第二份读数（可机读、带丢弃计数）
在包里根本没有，检查者只能祈祷那一行还在。

本笔补上这一格：两个生产写入点 → 一个有界环 → 包的 `diagnostics/slow-operations.json`。字段与日志行同源同一
次测量，不新增第二套词汇。

## 二 前提读数（本机真机日志，只读，现取）

数据源：`logs/headless.out.log`（`~/purescience/logs/`，本次未写入）。

| 读数 | 值 |
|---|---|
| 文件大小 / 行数 | **77,191,907 B / 3,754,483 行** |
| 日志内启动次数（按每次启动都打印的 `PureScience Web:` 切分） | **224** |
| 支援包的日志上限（`DEFAULT_MAX_LOG_BYTES`） | **8 MB** |
| 8 MB 窗口覆盖到的启动次数 | **29 / 224（13 %）** |
| `[ipc] ipc handler was slow` 记录的条数 | **3,005** |
| 其中落在最新 8 MB 之内的 | **276（9.2 %）** ⇒ **2,729 条慢调用行随包一起发不出去** |
| 慢调用耗时 p50 / p90 / 最大 | **315 ms / 14,550 ms / 2,507,409 ms** |
| 已带 `heldMs` 的行 | **2**（拆分是最近才落地的，旧行没有这个词） |
| 最常出现的慢通道 | `acp:get-plan-projection` 727、`sessions:save-session` 400、`sessions:list-catalog` 280、`settings:get-preflight` 198、`settings:npm-available` 197、`storage:get-info` 190、`notebook:state` 116、`settings:get-settings` 109 |

**这组数字只证明「前提成立」**：这类记录在真机上大量存在，而按字节上限走的包里几乎没有。它**不**证明新的
那一段已经被真机归档出来（见 §五 边界）。

顺带的一条（不属于本笔的判决，只作对照）：同一份日志里有一次旧构建的停顿风暴，单次启动就打了 **160,367** 条
`event loop stalled`（**3,587,524 行，占全文件行数的 95 %**），而带 `lateMs` 的现构建记录全文件只有 **257** 条、
分布在 **225 次启动中的 30 次**（单次 1–94 条，多数 1–9 条）—— 那个洪泛是 `lateMs` 修正之前的事，已修。这条留在
这里，是因为它同时说明了「日志被顶满」不是假设，而正是本笔要绕开的那种情形。

## 三 交付

| 位置 | 改动 |
|---|---|
| `src/main/diagnostics/slow-operation-ring.ts`（新） | 有界环（24 条）：`observed` / `dropped` / `capacity` 三个数分开答；`status` 在空时具名为 `no-slow-operations-observed`；`at` 记墙钟，最新在末尾。写入前归一：**只保留真正测到的字段**，`heldUnmeasured: 'windows-dropped'` 这种具名缺态必须存活（拍平成 0 会被读成「循环没被占住」），而 `cpuShare: 0` 这种**测到的零**也必须保留（它是一句读数，不是缺测） |
| `src/main/diagnostics/ipc-rejection.ts` | 新增 `slowOperationSink` 接缝，**默认写共享环**；CPU 一次采样同时喂日志行与环（两次 `process.cpuUsage()` 会描述两个窗口，两处就会各说一套） |
| `src/main/application-command-router.ts` | 同上：`report()` 里对 `slow-handler` / `handler-rejected` 且**耗时过阈值**的记录入环。阈值不能省 —— 路由对每次抛错都报 `handler-rejected`，不过阈值的那条不该进一个叫「慢」的文件 |
| `src/main/diagnostics/support-bundle.ts` | 新增**必填** `slowOperations`，写 `diagnostics/slow-operations.json`，README 里写明这一段是什么（含计数含义） |
| `src/main/ipc.ts` | 组合根的包事实里追加 `slowOperations: sharedSlowOperations.summary()`（写进环却没人读＝用户永远收不到） |

## 四 门禁读数（全部实跑，数字取自最后一次改动之后）

| 环 | 读数 |
|---|---|
| 定向：`src/main/diagnostics` + `application-command-router.test.ts` + `ipc-startup-attribution.test.ts`（`--maxWorkers=1`） | **24 files / 191 passed**，EXIT 0 |
| 新增/扩写用例 | 环 4 条、默认接线 3 条（IPC 默认环、命令默认环、组合根↔包源码链）、IPC 生产者 2 条（同源同一测量 / sink 抛错不改结果）、命令生产者 1 条（慢记录、**快速抛错不记录**、慢抛错带 `code`）、支援包 2 条（带拆分与计数 / 空态具名） |
| 变异自证 4 次 | ① IPC 默认 sink 改空操作 → **1 红**；② 路由去掉耗时阈值 → **1 红**（补了「快速抛错不入环」用例之后）；③ 包段改名为不存在的文件 → **2 红**；④ 环归一里删掉 `heldUnmeasured` 传递 → **1 红**。每次都只咬住守它的那一条，改完复原 |
| 双 typecheck（`--composite false`，堆 8192） | node **0**；web **0** |
| `eslint --no-cache`（本笔 11 文件） | **0 error / 0 warning**（prettier 的 5 条 warning 已用 `--write` 消掉，复检全过） |
| 全量 vitest | 见 §六（本机 swap 已用 10,298/11,264 MB、空闲页 ~4,015（≈63 MB）⇒ 按 `--maxWorkers=2` 跑，读数以日志为准） |

## 五 边界（不许读成更强）

1. **包里的这一段是单元/集成级证据**：`support-bundle.test.ts` 真的写出一个 `.tar.gz` 再解出来读回内容（含
   README 的描述），但**真机窗口导出**（`diagnostics/slow-operations.json` 从一次真实「导出支援包」里拿回来）
   没有取 —— 那条通道是 ELECTRON-only 且走原生保存对话框，本机常驻实例的窗口不归本笔驱，而带窗口的隔离实例
   要先 `build:e2e`（会与在跑的 dev 实例抢 `out/`）。**具名未取，不冒充。**
2. **不改变日志行为**：这些行照旧写日志，本笔只多一个机读落点。因此「包里有、日志里也有」不是重复，而是两种
   不同寿命的载体（日志按 8 MB 截断，环按 24 条滚动，且环自己说丢了几个）。
3. **环不是请求日志**：只有过阈值的调用才进来（IPC 50 ms、命令 50 ms，与既有日志阈值同一个常量语义）。快速调用
   一个都不记 —— 这由「快速抛错不入环」那条用例钉住。
4. **没有新增界面文案**：这一段只出现在支援包里的 README.txt（与既有 `diagnostics/*` 各段同一体裁），不涉及
   i18n 字典。

## 六 全量与推送

见计划档 §二百五十五（本文件与那一节同批；全量读数在那一节如实写，含「未跑完/负载假红」的分流口径）。
