# 窗口不再排在托盘之后 —— 一次「永远没有窗口」的读数，与它带出的顺序契约

日期：2026-10-21（执行器）
提交：见本文件所在批次（`fix(lifecycle): 窗口先于托盘创建`）

## 一 起点：macOS 构建车道上的那次红（读数，不是印象）

`106cf6ee` 的 `Nightly`（run `39569817054`）**failure**，`Verify (lint + typecheck + test + package)` 与
`Windows Full Test` 都是 success，红的是 **`build / Build macos-arm64`**（job `119126871492`）。作业级日志里只有
**一条**失败：

```
1) e2e/certification/storage-info-read-failure.spec.ts:30:5 › a hostile data root keeps the section usable, and a repaired one is re-read for real
   Error: The Electron app never opened a window: electronApplication.firstWindow: Timeout 30000ms exceeded while waiting for event "window"
     process: is still running
     launch log: …/001-certification-storage-info-read-failure-spec-ts-a-hostile-da.log
```

**同一次运行里 114 支认证 spec 正常打开了窗口**，只有这一支连续两次（首次 + `retry #1`）都没打开。所以这不是
「这一版的代码把所有窗口都弄坏了」——否则不会是 114 : 1。

两次启动的日志（从该 run 的 `p0-test-results-macos-arm64` 产物里取出，各自 92 / 76 行）**都停在同一个位置**：

```
[session-persistence] … phase: 'reconcile-unread-sessions'
[main] operation phase { …, operation: 'application-startup', phase: 'install-lifecycle' }
```

对照一次**同作业里成功**的启动（`001-certification-kernel-controls-spec…log`，250 行），它在这两行之后紧接着：

```
[main] operation completed { …, phase: 'install-lifecycle', outcome: 'completed', durationMs: 2887 }
```

⇒ 结论（这一层是读数）：**应用卡在 `install-lifecycle` 这一步里面**，进程活着、窗口对象从未建立。

## 二 那一步里有什么（读源）

`src/main/app-startup.ts:73-77`：`phase('install-lifecycle')` 之后依次是 `installMigrationQuitGuard(context)`（同步、
只挂一个 `before-quit`）与 `installAppLifecycle(context)`。后者在安装期同步创建两个**原生对象**，而当时的顺序是
**托盘在前、窗口在后**：

- `src/main/app-lifecycle.ts:199`（改前）`trayBox.current = deps.createTray({…})`
- `src/main/app-lifecycle.ts:379`（改前）`if (deps.createInitialWindow !== false) mainWindow = openWindow()`

⇒ **托盘排在窗口之前**。任何一个在原生层不返回的调用，都会把「窗口」一起带走——症状正是「进程活着、没有窗口」。

## 三 边界：这份读数证明什么、不证明什么

**证明**：卡点在 `install-lifecycle` 之内；当时那一步的顺序是托盘→窗口；两次启动都是同一形状。
**不证明**：究竟卡在 `new Tray(...)` 还是 `new BrowserWindow(...)`。容器侧那次运行的主机是 CI runner，日志里
没有任何一行说「托盘建好了」——**这正是当时无法分辨的原因**（改前这两步都不落日志）。

所以本次改动**不声称修掉了那次红**。它做两件事，各自可验证：

1. **顺序**：窗口先建，托盘后建 ⇒ 即使托盘在原生层卡住，用户也已经有窗口（对认证 spec 而言，`firstWindow`
   会当场返回，那条红不再由托盘承担）。
2. **可分辨**：两步各落一条具名日志（`main window created` / `tray created`），托盘抛错时落一条具名 `warn`
   并**继续**（不再让一个托盘异常把窗口与退出路径一起带走）。
   ⇒ 下次再出现「永远没有窗口」，启动日志会直接说出它是卡在**窗口**还是**托盘**；若首次改后仍是窗口那一步卡住，
   那就把范围收窄到窗口/原生层，而不是继续在整段安装里猜。

## 四 改动

| 位置                             | 改动                                                                                                                                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/app-lifecycle.ts`      | 安装期顺序改为 **窗口 → 托盘**；两条具名 `info`（`main window created` / `tray created`）；`createTray` 包 `try/catch`，失败落 `tray creation failed; continuing without a tray` + `errorCategory`，`trayBox` 保持 `undefined`（照既有语义：无托盘 ⇒ 关窗即退出） |
| `src/main/app-lifecycle.test.ts` | 夹具新增 `order`（记录原生对象创建次序）与 `trayThrows`（让 `createTray` 抛错）；新增两条用例：顺序契约 + 托盘失败不连带窗口（并断言日志两条 info / 一条 warn、`classifyClose()` 在无托盘时回 `quit`）                                                            |

**没有改的东西**：退出流程、`classifyClose` 语义、单实例锁、窗口重建（`activate`）、托盘菜单项——一个字节未动，
本单元只动「谁先被创建」与「创建失败怎么说话」。

## 五 门禁（实跑）

| 环                                                                | 读数                                          |
| ----------------------------------------------------------------- | --------------------------------------------- |
| 定向 vitest `src/main/app-lifecycle.test.ts`                      | **47 passed**（改前 45，本单元 +2）           |
| 簇 `app-lifecycle` + `app-startup` + `tray` + `app-menu`          | **79 passed / 4 files**                       |
| `tsc --noEmit -p tsconfig.node.json --composite false`（堆 8192） | `NODE_EXIT=0`，**0 error**                    |
| 全量 vitest / web typecheck / eslint / pre-push                   | 见本轮计划档 §两百零九 的读数表（与提交同批） |

## 六 具名未办

1. **真窗口读数未取**：`blocked-by` = 内存闸门（本机空闲物理页 ≈ 76 MB、`swap used 13.1 G / 14.0 G`）。
   解封后判据：起一次打包态实例，确认两行日志都在、顺序为 `main window created` → `tray created`。
2. **这次 CI 红没有自己的复现**：认证车道只在 `macos-arm64` 的构建作业里跑，且需要构建产物；本机内存闸门未解除前
   不冒充「已复现 / 已修复」。
