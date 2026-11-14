# 收割：本地目录建不出来时，任务既没有原因也不会停止重试

> 单元：`harvest-engine` 的两处本地 `mkdir` 未被任何 `try` 覆盖。
> 日期：2026-11-15。改动：`src/main/compute/harvest-engine.ts`（+ 同文件测试）。

## 1 症状与缺口

一个已经跑完的远端任务（`status` = success/failed/timeout），如果数据根上的收割目录建不出来
（`ENOSPC`、`EACCES`、或目录位置被一个同名的**普通文件**占着 ⇒ `ENOTDIR`），`harvestJob` 会**直接把异常抛出去**：

- 行上 `harvestedAt` 仍是 `null`、`harvestError` 仍是空 ⇒ 面板没有任何可解释的原因，用户看到的是
  「这个任务就是没有产物」，与「收割从没开始过」同形；
- 恢复扫描 `findTerminalUnharvested()` 的选择条件正是 `harvestedAt: null`，且**没有退避**，而它每 15 秒
  跑一次（`JobPoller.tick`）⇒ 同一份收割被无限重派，每次只在日志里留一行 warn。

即：一个本地权限/磁盘问题会表现成「永远在重试、永远没有原因」。

## 2 根因（两处，同一形状）

| 位置 | 旧形状 | 后果 |
| --- | --- | --- |
| 函数开头 `mkdir(featuredDir)` / `mkdir(hiddenDir)` | 在 `finalize` 助手**声明之前**，裸 `await` | 抛出即逃逸，无终态 |
| 下载循环里 `mkdir(dirname(localPath))`（featured / hidden 各一处） | 裸 `await` | 一个怪文件名的父目录失败 ⇒ 整次收割中止，**其余产物一并丢失**，且同样无终态 |

函数头注释原先写着「On any error: sets harvestError + harvestedAt (harvest_failed)」—— 对这两处**不成立**。
同一文件里磁盘余量闸（`availableBytes` 读不出来）此前已按同一形状修过，`mkdir` 是漏掉的那两处。

## 3 改动

1. 目录创建挪到 `finalize` / `finalizeAndReturn` 声明**之后**，包一层 `try`：失败走
   `finalizeAndReturn('harvest skipped: the local harvest directory could not be created (<msg>); the remote files were not enumerated and remain in <workdir>', null)`
   —— 与其它早退路径同一句式和同一条纪律，`left_on_remote` 写 `null` 而不是 `[]`（没有枚举过，不许被读成「远端什么都没有」）。
2. 下载循环里的父目录创建改为 `ensureParentDir()`：失败时**记进 `errors`**（与下载失败同一通道），`continue`
   到下一个文件 ⇒ 其余产物照常落地，任务以 `harvest_failed: …` 终结。
3. 函数头注释按新顺序改写，并写明**「为什么顺序重要」**（终态写入决定恢复扫描会不会再挑中它）。

## 4 读数

### 4.1 真机读数（真 SQLite 行 + 真文件系统 + 真仓库，探针跑完即删）

探针：`createProjectDbClient` + `ensureProjectSchema` 建**真** 库于临时根 → `ComputeJobRepository.create()`
落一行 → 把 `getJobHarvestDir(...)` 指向的位置用**普通文件**占住 → 调真 `harvestJob` → 再用真仓库回读。
只注入 ssh/scp 与主机查询（本机没有远端主机，且这条路径根本走不到它们）。

```
PROBE row created id=probe-job-1 harvested_at=undefined
PROBE scan-before count=1 ids=probe-job-1          ← 修复前：每次 tick 都会被重新派发
PROBE blocked <tmp>/notebooks/probe-proj-1/probe-sess-1/hpc/probe-job-1 with a regular file
PROBE row after harvested_at=1794699761662 reason=harvest skipped: the local harvest directory could not be created (ENOTDIR: not …
PROBE scan-after count=0                           ← 修复后：不再被挑中，循环终止
```

**对照（把守卫退回旧形状后，同一支探针）**：

```
PROBE scan-before count=1 ids=probe-job-1
Error: ENOTDIR: not a directory, mkdir '…/probe-job-1/featured'   ← 异常逃出 harvestJob
Tests  1 failed (1)                                                ← 行没被写，scan 会继续返回它
```

两行一起才说明问题：不是「日志更好看」，而是**同一行在修复前永远不会被写**。

### 4.2 变异自证（用例真的会咬）

| 变异 | 结果 |
| --- | --- |
| 目录创建退回裸 `await mkdir` | `records a skip reason …` 红 |
| `ensureParentDir` 去掉 `try/catch` | `keeps the other outputs …` 红 |

两次各只红对应那一条 ⇒ 两条用例分别钉住两处守卫，而不是被同一处偶然覆盖。

## 5 门禁

| 环 | 读数 |
| --- | --- |
| `npx vitest run src/main/compute src/shared --maxWorkers=2` | **184 files passed / 1 skipped（185）**；**2270 passed / 5 skipped（2275）** |
| `npx vitest run src/main/compute/harvest-engine.test.ts` | **21 passed**（新增 2 条） |
| 双 typecheck（`--composite false`） | node 0 / web 0 |
| `npx eslint --no-cache`（两个文件） | 0 problems |
| `npx prettier --check`（两个文件） | 通过 |

（用例总数 2270 与本轮开始时那次的 2271 之差可逐项对上：那次含一份**已撤回**的 `job-poller` 试验 +3，
本轮 `harvest-engine` +2 ⇒ 2271 − 3 + 2 = 2270。）

## 6 边界与具名未办

1. **只覆盖「本地文件系统失败」这一类**。远端侧的失败（枚举、scp）本来就走 `finalizeAndReturn` /
   `errors`，不在本单元范围内。
2. **没有窗口读数**：真实库里 `ComputeJob` 零行、空闲页 4,086（≈65 MB）、swap 可用 1.3 GB ⇒ 起不了
   Electron 窗口。本单元的读数落在「真库 + 真 fs」这一层，够证明行会写、循环会停，但面板上那句话
   没有在本轮被看到。
3. **`0o` 那条「旧形状下 ENOTDIR 会逃出去」的对照是靠变异取到的**（同一个探针、同一份代码、只把守卫退回），
   不是历史日志里的实录 —— 历史日志里这条路径只会表现为「每 15 秒一行 warn」，本来就分不出是哪一类失败。
4. 本轮**撤回了**一个已开工的试验：给 `job-poller` 的 `'harvest failed before recording a result'` 加
   「行是否已写」判据。撤回理由见台账 §三百三十五 §〇（台账里早有一条「复查后不成立」的更正，本轮复核**该更正成立**）。
