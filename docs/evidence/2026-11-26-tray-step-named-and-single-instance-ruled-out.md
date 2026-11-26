# 打包车道那次「窗口没开」停在托盘之前还是之后：日志现在答得出来了

日期：2026-11-26（执行器轮次 §三百六十五）｜车道：`Nightly 45777604322`（head `09dfed08`，macos-arm64）｜
涉及文件：`src/main/app-lifecycle.ts`、`src/main/app-lifecycle.test.ts`

## 一 读数：本轮 P0 只有一条 flaky，失败是「点名过」的那一种

同一趟作业的摘要行逐字：

```
1 flaky
  e2e/certification/lock-import.spec.ts:185:5 › the dialog prints every unsatisfied entry and creates nothing
11 skipped
127 passed (58.7m)
electron P0 reading: passed
```

那条 flaky 的首次尝试被 `09dfed08` 的具名失败路径接住了（这正是上一轮加的夹取与点名要的效果）：

```
Error: The Electron app never opened a window: electronApplication.firstWindow: Timeout 180000ms exceeded while waiting for event "window"
  process: is still running
  launch log: …/test-results/app-process/001-certification-lock-import-spec-ts-the-dialog-prints-every-un.log
  --- last 20 lines of that launch ---
    phase: 'install-lifecycle', elapsedMs: 2244
    phase: 'initial-window',   elapsedMs: 2245
  [main] main window created
```

同作业里另有 19 行 `[e2e] first-window budget: 180000ms requested, …ms left before the test's own deadline`
⇒ 夹取逻辑在打包车道上**真的执行过**（不是只在本机单测里成立）。

这一条**没有**打印夹取行，原因是它自己的预算不是 120 s：`lock-import.spec.ts` 第 47 行写着
`test.setTimeout(300_000)`，于是 `min(180000, 295000) = 180000`，等满 180 s 后由我们的具名路径（不是 runner 的
`Test timeout … setting up "app"`）报出失败。**这是设计行为，不是漏夹。**

## 二 这次读数把「单实例」这一支排除了

上一轮（§三百六十三 §五）立案时，两种可能同形：① 上一个实例还占着单实例锁 ⇒ 新实例转交后退回；
② 窗口创建路径自己挂住。`9d6c9cba` 给单实例分支补了具名行，本轮读数据此排除①：

| 判据 | 读数 | 含义 |
| --- | --- | --- |
| 诊断阶段 | `install-lifecycle` → `initial-window` | 已过 `single-instance-held`，锁拿到了 |
| 若无锁 | 日志会停在 `single-instance-lock` 并补一行 `single-instance-secondary` | 两行都不在 |
| `createInitialWindow` | `true` | 这个 launch 被要求开窗 |

⇒ 应用**确实拿到了锁、也确实被要求开窗**，并且它自报 `main window created`。

## 三 剩下的一段：`main window created` 之后、`tray created` 之前

`src/main/app-lifecycle.ts` 安装期的顺序与各自的具名行是：

```
openWindow()                       → info 'main window created'
createTray({ onShow, onHide, onQuit }) → info 'tray created'   （或 warn 'tray creation failed; …'）
```

失败那趟日志的最后一行就是 `main window created`，此后到 180 s 超时**一个字都没有**，而进程仍在。
两点合起来说明：卡点在**托盘那一步的调用内部或紧邻处**（同一文件 2026-10-21 那条注释记过同一形状：
「host 的状态栏服务卡住时 `new Tray` 不返回」，当时的修法是把窗口挪到托盘之前，让窗口先存在）。

**仍然只是假设的一半**：日志现在只能说「`main window created` 之后没有下一行」，还分不清
「托盘调用开始后没返回」与「根本没走到托盘调用」。这正是本轮要补的那条读数。
（顺带一条可解释症状的机制假说：主进程若在同步原生调用里不返回，CDP 的 target 事件也就送不出去，
于是 Playwright 报 `firstWindow` 超时——应用自己却认为窗口已经建好。本轮不为它改行为，先让日志分辨。）

## 四 交付：把「开始」也写进日志，并把「没有托盘」也点名

| 行 | 何时 | 为什么 |
| --- | --- | --- |
| `tray creation starting`（info） | 调用 `createTray` **之前** | 「开始了但没返回」与「没开始」必须打印得不一样 |
| `no tray for this host; continuing without one`（info） | `createTray` 返回 `undefined` | 无托盘的后果是用户可见的（关闭即退出、没有最小化到托盘），不能用沉默代替 |

## 五 门禁（本机，隔离开放树 `/tmp/ps-tray-step`，detached `28579ed6`）

| 项 | 读数 |
| --- | --- |
| `npx vitest run src/main/app-lifecycle.test.ts` | **50 passed**（新增 2 例：调用前已落行 / 无托盘具名） |
| 变异：把 `tray creation starting` 挪到调用**之后** | **2 failed**；恢复后 50 passed |
| `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:node` | **EXIT=0** |
| `npx eslint --no-cache`（两个改动文件） | **EXIT=0**（0 problems） |

## 六 下一次的判据（不加大超时、不加重试）

- 若这条 flaky 再出现，失败尾巴**应当**停在 `tray creation starting`：
  ⇒ 定因为「状态栏原生调用不返回」，下一单元才谈「托盘能否失败即弃 / 能否延后到窗口首帧之后」，
  并且此时窗口已经存在于应用内，说明要让**用户**也不受它影响。
- 若尾巴仍停在 `main window created`：卡点在窗口创建返回到托盘调用之间（含日志落盘路径），
  与托盘无关 ⇒ 改查 `openWindow()` 的返回路径与日志写入。
- 这条判据只在打包车道上成立（`PURESCIENCE_E2E_EXECUTABLE` 存在时），本机未起实例。
