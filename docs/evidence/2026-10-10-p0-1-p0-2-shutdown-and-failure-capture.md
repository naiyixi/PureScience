# P0-1 / P0-2：退出即 abort 与「异常只有分类」——取证与落地（2026-10-10）

> 证据来源：打包版应用的真实使用数据（`~/Library/Logs/PureScience/{main,main.1,main.2}.log`，
> 窗口 2026-10-01 → 10-10，28,039 条，其中 error 1,500）与一条真实崩溃报告
> `~/Library/Logs/DiagnosticReports/Retired/PureScience-2026-10-10-195205.ips`。

## 一、P0-1：应用退出即 abort（真机取证）

**崩溃报告读数**（`PureScience 1.97.0`，2026-10-10 19:52:05 CST）：

| 项 | 读数 |
|---|---|
| 异常 | `EXC_CRASH` / `SIGABRT` / `Abort trap: 6`（`termination.code=6`） |
| 故障线程 | 0（`CrBrowserMain`） |
| 故障栈（自下而上） | `node::FreeEnvironment` → `node::Environment::RunCleanup()` → `node::Environment::CleanupHandles()` → `uv_run` → `node::ThreadPoolWork::ScheduleWork()::'lambda'` → **`libquery_engine-darwin-arm64.dylib.node`（14 帧）** → `abort()` |

**同一时刻的日志序列**：19:51:30 启动 → **25 秒空档**（`main/operation phase` 之间无任何记录）→ 19:51:57 数据根解析 →
19:52:00 触发 `trigger=quit` 的退出，四个阶段（`usage-drain` / `renderer-session-flush` / `backend-teardown`）
**全部报 `completed`** → 19:52:05 abort。

**根因判断（由栈定位，不是猜）**：Prisma 查询引擎在 **Node 环境收尾**时被唤醒并中止进程 ——
即「进程带着一个仍然打开的查询引擎退出」。全树检索确认：`$disconnect` **只出现在测试文件里**，
**退出路径从未调用过它**；`getProjectDbClient` 是常驻单例，没有任何收尾释放。

**落地**：
1. 收尾新增 `database-release` 阶段（在 `backend-teardown` 之后、进程收尾之前）：显式释放查询引擎，
   有界 **3 s**，结果具名 `no-client` / `never-connected` / `disconnected` / `timeout` / `failed`；
   释放后再开新客户端按名拒绝（`ProjectDbReleasedError`，fail-closed 并可见）。
2. 新增**逐阶段持久化面包屑** `logs/shutdown-breadcrumb.json`（`write + fsync + rename + 目录 fsync`）：
   下一次启动能点名上一个进程死在哪个阶段，并把 **已完成 / 从未记录完成 / 不可读** 三态分开
   —— 不再靠异步、带缓冲、会轮转的日志尾部去猜。

## 二、P0-2：1,481 次异常只有分类（真机取证）

| 读数 | 值 |
|---|---|
| 九天 `uncaughtException` | **1,481**（network **1,344** / system 137） |
| 单小时峰值 | **10-04 13 时 604 次**（连发，无折叠） |
| 记录内容 | **只有 `errorCategory` 一个字段**：无 message、无栈、无次数 |

**落地**：`uncaughtException` / `unhandledRejection` 现在记录
**脱敏消息 + 首个调用帧（仅 `basename:line:col`）+ 稳定签名 + 发生次数**，
按 **60 秒窗口**折叠连发并对同一签名**指数退避**（60 s → 120 s → … 上限 8 分钟），
进程退出时 flush 尚未发出的计数。隐私口径不变（URL / 绝对路径 / UUID / 邮箱 / 长令牌先替换才可入日志）。

## 三、本地门禁读数（本次提交）

- 受影响套件：**6 个文件 / 82 条用例**（`shutdown-breadcrumb`、`crash-diagnostics`、`crash-diagnostics.capture`、
  `app-lifecycle`、`prisma-client-shutdown`、`lifecycle-shutdown`）**全绿**。
- `typecheck:node` **exit 0**；`typecheck:web` **exit 0**。
- 触碰文件 `npx eslint --no-cache` **0 error / 0 warning**。
- 提交：`6c24323d`（9 文件 / +1129 −20）。

## 四、未取证项（具名，含解封条件）

| 项 | 状态 | 原因 | 解封条件与配方 |
|---|---|---|---|
| 退出路径的**真机读数**（连续 20 次「启动→退出」零新增 `.ips`、面包屑逐次以 `completed` 收尾） | **未取证** | **内存闸门**：取证需 `npm run build:e2e` + Electron，而本机 `vm_stat` 空闲物理页 **7,112（≈111 MB）**、`vm.swapusage` 已用 **5,044 MB / 6,144 MB** | 空闲物理页回到数万后：`npm run build:e2e` → 隔离实例（独立 `--user-data-dir` + `PURESCIENCE_STORAGE_ROOT` + 独立端口 + 配置里同时改 `settings.dataRoot`）→ 经 `/api/shutdown` 触发**真实退出路径** → 核 `logs/shutdown-breadcrumb.json` 为 `completed`、`ps` 无残留、`~/Library/Logs/DiagnosticReports` 无新增 PureScience `.ips`；收尾复核（端口已停 / 临时目录已删 / `git status --short` 为空） |

> 注：本条**不影响**已落地的实现与单测；它缺的是「真机上再跑一遍」的读数，而这台的资源此刻给不出。
