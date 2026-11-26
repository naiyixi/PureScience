# 启动步骤的落盘标记：流里读不到的那一步，改成直接写文件描述符

日期：2026-11-27 · 执行器轮次 · 提交对象：`src/main/diagnostics/startup-step.ts`（新）、
`src/main/app-lifecycle.ts`、`src/main/index.ts` 与两份用例。

## 一 要解决的问题（现取读数）

打包认证车道（`macos-arm64`）上，「应用没开窗」这一类失败在三天里点到了四支 spec、三趟 run，
每一趟的形状都一样：夹具等 `firstWindow` 等满 180 s，`process: is still running`，应用自己的日志
尾巴停在 `main window created`。

| run | head | spec | 失败行 |
| --- | --- | --- | --- |
| `45650744918` | `f9b9b4ee` | `session-vision-evidence-card`、`workspace-activity-group-expand-all` | `The Electron app never opened a window: … Timeout 180000ms` |
| `45727316594` | `e6f7295b` | `session-density-reading` | 同上 |
| `45777604322` | `09dfed08` | `lock-import` | 同上（retry #1 通过） |

上一轮（`98394b45`）为这条读数加了 `tray creation starting`，写在原生托盘调用之前。它解决的是
「有没有叫过托盘」，但**没有解决「这行会不会落下来」**：日志镜像写的是 stdout，而 stdout 是 Node 的流。
主线程一旦卡在同步原生调用里，排在后面的行永远不会被排空 —— 于是尾巴说的是**日志写到哪**，
不是**进程走到哪**。这正是上面四处读数里 `main window created` 之后一片空白的那种形状。

## 二 改动

| 文件 | 内容 |
| --- | --- |
| `src/main/diagnostics/startup-step.ts`（新） | 闭集词表的启动步骤标记；`writeSync(1, …)` 直写描述符（不经流）；写失败只吞掉自己，绝不影响启动。头注释写明「一条卡住的启动怎么读」的四条判据 |
| `src/main/app-lifecycle.ts` | 五点记录：`window-creation-start`（原生建窗**之前**）→ `window-created` → `tray-call-start`（原生托盘**之前**）→ `tray-created` / `tray-absent` / `tray-failed`。`markStartupStep` 包一层 try/catch，注入的录像器抛错也不改启动 |
| `src/main/index.ts` | 与 `shutdownBreadcrumb` 并排创建录像器，经 `onStartupStep` 接进生命周期（与既有的退出侧 `onShutdownPhase` 同一处接线） |

**卡住的启动怎么读**（写进了模块头，读的人不必猜）：

| 尾巴里最后一条标记 | 结论 |
| --- | --- |
| `window-creation-start` | 原生建窗调用没回来 |
| `window-created` | 停在建窗返回与托盘调用之间（或托盘调用进入前的那一次写之后） |
| `tray-call-start` | 状态栏项被要了、没回来 |
| 有 `tray-created` | 启动走完了；此时夹具没拿到窗口，是**夹具侧的投递问题**，不是主线程卡住 |

这一格是上一轮做不到的：上一轮的 `tray creation starting` 与成功行都可能被同一次卡住吞掉，两者同形。

## 三 门禁（本机，隔离工作树 `/tmp/ps-startup-step` @ `991d464a`）

| 项 | 读数 |
| --- | --- |
| `npx vitest run src/main/app-lifecycle.test.ts src/main/diagnostics/startup-step.test.ts` | **59 passed** |
| 变异：把 `tray-call-start` 挪到原生调用之后 | **2 failed**；恢复后 55 passed（生命周期那支） |
| `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:node` | **EXIT=0** |
| `npx eslint --no-cache`（五个文件） | **EXIT=0**，0 problems |

## 四 边界

1. **本条没有真机读数**：它只在打包车道产生；本机内存闸不允许起实例。判据写在下一节。
2. 词表是闭集，新增步骤必须同时改 `STARTUP_STEPS` 与模块头的读法表 —— 否则读的人会拿到一个
   没有解释的字符串（用例钉着这份词表）。
3. 标记只有六条，一次启动最多六行 stdout；不引入文件、不引入轮转、不影响退出侧那份 breadcrumb。

## 五 下一次同形状失败时的判据

- 尾巴里出现 `[startup-step] …` 且**停在 `tray-call-start`** ⇒ 状态栏原生调用不返回，下一单元谈
  「托盘延后到窗口首帧之后 / 没有托盘也照常服务」。
- 停在 `window-creation-start` ⇒ 卡点在原生建窗，与托盘无关。
- 六条标记齐全却仍无窗口 ⇒ 主线程没卡，问题在夹具对窗口事件的投递（CDP 目标事件），
  那时才去改夹具或 Playwright 的启动方式，不动应用。
