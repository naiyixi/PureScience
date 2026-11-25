# notebook-env:status 在窗口边界上的最后一次未捕获 await（2026-11-25）

一次发布车道的 P0 读数把三支认证旅程记成 flaky，三支的失败原因逐字相同。这份档记读数来源、
根因判据、修法、变异证明，以及「下一趟 P0 才能给出的那条判据」。

## 一、读数来源（真机，不是本机）

| 项 | 值 |
| --- | --- |
| 车道 | `Release`（tag `v2.33.7`），run `45592230446`，head `48ca13ce` |
| 作业 | `build / Build macos-arm64`，job `139143785476` |
| 步骤 | `Run P0 Electron certification`（打包产物上真窗口跑） |
| 汇总逐字 | `3 flaky` / `9 skipped` / `127 passed (1.0h)` |
| 步骤读数逐字 | `electron P0 reading: passed` |

三支 flaky（各自重试后转绿）：

| # | spec | 用例 |
| --- | --- | --- |
| 1 | `e2e/certification/lock-import.spec.ts:92` | the panel imports an environment from an external lock, with zero downloads |
| 2 | `e2e/certification/notebook-interrupted-run.spec.ts:112` | a run cut off by the user quitting the app is recorded as interrupted, not as a failure |
| 3 | `e2e/certification/packages-mutation.spec.ts:195` | the Packages dialog installs and removes through the app admission … |

三支的失败行逐字相同（`fixtures/renderer-failure-gate.ts:38`）：

```
AggregateError: Renderer emitted errors during Electron E2E.
Error: [renderer pageerror] Error invoking remote method 'notebook-env:status':
       Error: No handler registered for 'notebook-env:status'
```

## 二、根因判据（按「这条消息只能从哪来」逐条排除）

那句 pageerror 的原文里点名了通道 `notebook-env:status` ⇒ 它只能由渲染层对这一条通道的
`invoke` 产生，而渲染层对该通道的调用点**全部在这一个文件里**（`src/renderer/src/stores/notebook-env-store.ts`）：

| 调用点 | 位置 | 有没有接住拒绝 |
| --- | --- | --- |
| 结算 tick 后的回读 | `init()` 内 `applyProgress` 尾部，`.getStatus().then(...)` | 有（`.catch(() => undefined)`，注释写明这是关停期） |
| **启动时的一次读** | `init()` 末尾 `const status = await bridge.getStatus()` | **没有** |
| `provision()` 内 | try/catch 包住 | 有 |
| `cancel()` 内 | try/catch 包住 | 有 |
| `reset()` 内 | try/catch 包住 | 有 |

`App.tsx:319` 用 `void initEnv()` 起这一读 —— 被 `void` 掉的 async 函数一旦拒绝就是**未处理的
rejection**，Chromium 把它当 `pageerror`，`RendererFailureGate` 把它计入失败。同一文件往下三行的
`storage:get-info` 启动探测早就因为同一个形状被修过（注释里写着 `lock-import` 与 run `44902338624`），
这次漏下的是同一族里最后一个没接住的调用。

语义上它也不是「状态坏了」：主进程只在那个窗口还归自己管的时候回答状态读；窗口边界上答不出来，
丢的是这一次读，下一次启动会重读（`init()` 的注释本来就写着这句）。

## 三、修法（一笔，两文件）

- `src/renderer/src/stores/notebook-env-store.ts`：`init()` 末尾那次读包进 try/catch。答不上来就保持
  初始态 —— 「主进程没有回答」是一条读数，不是要上屏的错误；不伪造任何状态。
- `src/renderer/src/stores/notebook-env-store.test.ts`：新增一条用例，`getStatus` 第一次调用就抛那句
  原文，断言 `init()` **resolve**、没有 `unhandledRejection`、状态仍是初始态。

## 四、变异证明（断言没被削弱）

把实现回退到修前（只留用例）再跑同一支测试：

```
× does not reject when the window boundary eats the launch-time read
Tests  1 failed | 37 passed (38)
```

恢复实现后：

```
Tests  38 passed (38)
```

## 五、边界与下一趟才能给出的判据

- 本机没有打包态 P0 的等价环境（P0 只有 `macos-arm64` 构建作业里跑），所以这条修复的**效果读数
  只能由下一趟 P0 给出**。判据：下一趟 `macos-arm64` 的 P0 日志里
  `grep -c "No handler registered for 'notebook-env:status'"` = **0**，且这三支 spec 不再出现在
  flaky 名单里。
- 修的是渲染层最后一个未接住的调用；主进程侧「窗口边界上释放处理器」这个行为本身不改（那是正确
  的语义），也不为它加任何超时或重试。
