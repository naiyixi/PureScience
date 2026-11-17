# 空闲内核占了多少内存 —— 诊断包里多一格「谁在吃掉那 2.4 GB」

日期：2026-11-17（执行器轮次）
单元来源：上一轮记事本 `round-kernels` 点名的「空闲内核的观测（CPU/内存）」。

## 〇 开工核对（防重做 + 并发 + 该谁做）

- 开工时 `origin/main = fba0fcd3`（同日 21:11 的桌面会话提交），`git log origin/main..HEAD` 为空。
  上一笔 `6bcb6977` 的双车道判决**已拿到**：`Nightly` 与 `Windows Full Test` 均 `completed / success`。
- 在飞车道：`fba0fcd3` 的 `Nightly` 与 `Windows Full Test` 于 21:16 起跑 ⇒ 本笔**先落本地、末段再推**，
  推前再看一次 `gh run list`。
- 工作区带别人未提交的在制品（九份 i18n 字典、`main-message-catalog*`、`Connector{AddForm,ExportView,ImportView}`、
  `background-delivery-labels*`、一支未跟踪 e2e spec、四份未跟踪证据档）⇒ 一个字节没碰；本笔只提交自己那七个文件。
- 队列 B 段仍无可做项（A7 ✅ / S3 ✅ / M2 ⛔ 卡产品决定）；C 段外部阻塞。

## 一 为什么做这一格

CPU 那一半早在 `src/main/notebook/kernel-idle-spin.ts` 里：空闲内核在烧 CPU 会落一条具名日志行，并写进
`diagnostics/notebook-kernel-cpu.json`。但上一轮在同一台机器上读到的是另一半：**11 个 python 内核合计约
2,376 MB 常驻**，而 swap 已用到 10.4 / 11.2 GB —— 其中大部分内核**没在烧 CPU**（9 个空闲 0%），
所以 CPU 那一格对它们一个字都不会说。内核是**按会话故意保留**的（`kernel-executor.ts` 的 `DEFAULT_IDLE_MS = 0`，
理由写在那一行旁边：回收会丢命名空间），因此「一个内核握着 470 MB 却什么都不干」是设计的结果，
缺的是**读数**而不是控制。

## 二 交付

| 文件 | 做了什么 |
| --- | --- |
| `src/main/notebook/kernel-idle-spin.ts` | 新增**内存台账**：`KernelMemoryReading` / `KernelMemorySample` / `KernelMemoryRound` / `NotebookKernelMemorySummary` / `createKernelMemoryRing` / `sharedKernelMemory`，真实探针 `ps -o rss=`，解析器 `parseResidentBytes`（KB → 字节）。监控器在**同一拍、同一份 idle 目标表**上多测一轮内存，失败与 CPU 基线互不影响 |
| `src/main/notebook/kernel-executor.ts` | 观测选项透传（`idleSpinMemoryProbe` / `idleSpinMemoryRing`），生产走默认 = 真探针 + 进程级环 |
| `src/main/diagnostics/support-bundle.ts` | 新增**必填段** `notebookKernelMemory` → `diagnostics/notebook-kernel-memory.json`，`README.txt` 里加一节说明 |
| `src/main/ipc.ts` | 组合根把 `sharedKernelMemory.summary()` 交给诊断包 |
| 三份 spec | 环 / 监控器 / 执行器 / 诊断包各补断言，另加两条**真机探针**用例（真 ps、真内核进程） |

三条语义纪律（都写成注释钉在代码里，也各有一条用例）：

1. **内存是「水位」不是「速率」**：按「每拍每个空闲内核一条」记，不做窗口差分。
2. **总量必须带分母**：`last` 是**这一拍**的合计，同时给出 `kernels / measured / unmeasured`；
   一个内核没测到就记 `probe-failed` 或 `parse-failed`，**不进总量、不记 0**。
3. **`rss` 是常驻集，不是 `phys_footprint`**：共享页在每个映射它的进程里各算一次，所以跨内核求和是**上界**，
   逐内核的数字才是主读数 —— 这句写进了模块头注释、诊断包 README 和类型注释。

## 三 真机读数（本机 macOS 27.0.1 / darwin-arm64）

1. **整条链跑真内核**：新增用例 `NotebookKernelExecutor memory observation (real ps probe)` 起一个**真的 REPL 内核进程**
   （`resources/notebook/repl_loop.js`），用**默认的真 `ps -o rss=` 探针**、写进注入的环，等它自己被观测到：
   `Tests 24 passed`，实测该内核 **46,153,728 字节（44.0 MB）**，`last = { kernels: 1, measured: 1, unmeasured: 0 }`。
2. **探针校准**（独立于产品代码，直接对真进程读）：
   `node -e 'Buffer.alloc(150MB,1)'` → `ps -o rss=` 打印 `169952`（KB）→ 换算 **174,030,848 字节（166 MB，含 node 基线）**。
   这条证明的是单位：读成 KB 会是 166 MB、读成页会是 2.6 GB，两种错法都落不进用例的区间断言。
3. **读数时刻本机存活内核数 = 0**（`ps -Ao command | grep python_loop|repl_loop` 无命中；打包版与开发实例都在跑，
   但它们的会话内核已随会话关闭退出）⇒ 上一轮那 11 个内核的 2,376 MB **不能当本笔读数**，本笔只给「链通」的读数，
   以及下一次真机导出诊断包时才会出现的 `notebook-kernel-memory.json`。

## 四 门禁（本机实跑）

| 环 | 读数 |
| --- | --- |
| `npx vitest run src/main/notebook src/main/diagnostics --maxWorkers=3` | **131 files（122 passed / 9 skipped）／1,718 passed / 101 skipped**，退出 0 |
| `npx vitest run src/main/notebook/kernel-idle-spin.test.ts` | 1 file / **24 passed**（含两条真探针用例） |
| 变异证明（`measured > 0` → `measured >= 0`；`kilobytes * 1024` → `kilobytes`） | **3 例红**：解析换算、全失败轮仍给总量、真探针区间；还原后全绿 |
| `npx eslint --no-cache`（本笔七个文件） | **0 error**；2 条 warning 全在 `kernel-executor.ts:746/756`，是**HEAD 上就有的** prettier 漂移（`git show HEAD:…` 复制到同目录再 `prettier --check` 同样告警），不是本笔引入 |
| `npx prettier --check`（除该文件外六个） | 通过 |
| `npm run typecheck:node` / `typecheck:web` | **0 / 0** |

## 五 边界与具名未办

1. **安装版还没这个段**：`/Applications/PureScience.app` 是 2.27.0，不含本改动 ⇒ 「从真诊断包里读到
   `diagnostics/notebook-kernel-memory.json`」这半格**未取证**，要等下一次发版后的真机导出。
   本笔给的是「真内核 → 真探针 → 环」的链上读数，不是那半格。
2. **没有界面**：这是主进程观测（与 CPU 那一格同形），不新增通道、不动渲染层 ⇒ **无窗口读数**，按纪律具名。
3. **不回收**：把空闲内核关掉会丢命名空间（`DEFAULT_IDLE_MS` 的注释写着为什么），属需拍板项，本笔不动；
   本笔只让「谁占了多少」变得可读。
4. `ps -o rss=` 在 Windows 没有对等读数 ⇒ 该平台记具名 `unsupported-platform`（与 CPU 那一格一致）。

## 六 本轮实跑汇总

`src/main/notebook` + `src/main/diagnostics` 全量：**131 files（122 passed / 9 skipped）／1,718 passed / 101 skipped**，
退出 0。跳过项按 vitest 自己的 `skipIf` 条件产生（Windows 专用、需要外部运行时的集成项等），**本轮未逐条核对是哪几条**。
