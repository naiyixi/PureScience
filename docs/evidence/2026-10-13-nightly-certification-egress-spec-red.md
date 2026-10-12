# Nightly 认证车道红：`egress-settings-read-failure.spec.ts`（归因未定，先立档）

- 日期：2026-10-13（取证窗口 05:1x–05:2x CST）
- 被判提交：`f6b8723febd7436652ac823c7605d8602f6f6b80`（Nightly run `38285152756`，作业 `build / Build macos-arm64` = `114937711885`）
- 结果：`1 failed | 12 skipped | 88 passed (25.7m)`，失败唯一一条 =
  `e2e/certification/egress-settings-read-failure.spec.ts:20:5 › an unreadable settings store degrades instead of surfacing as a read failure`
- 失败步骤是 `Build macos-arm64` 里的 **`Enforce platform certification`**（该 job 的第一步性质的门禁），
  即认证读数不成立 ⇒ 这不是「下游后果」，是这一跑自己的判决。

## 一 失败面读出来的三行（逐字取自作业日志）

```
[ic31] Settings entries after a corrupt store: 0
[ic31] the allowlist section with the store degraded: "Notebook internet access Controls which ..."
[ic31] named read failure: false (retry buttons: 0)
```

这三行**与通过时逐字相同**（见下面第二节的对照）⇒ 用例正文的断言并没有走到「产品行为变了」，
红在夹具的渲染层错误门禁：

```
AggregateError: Renderer emitted errors during Electron E2E.
  at fixtures/renderer-failure-gate.ts:38   ← 由 ElectronAppHarness.dispose 触发
  [renderer pageerror] Error invoking remote method 'storage:get-info': Error: No handler registered for 'storage:get-info'
  [renderer pageerror] Error invoking remote method 'notebook-env:status': Error: No handler registered for 'notebook-env:status'
```

首跑与 retry #1 **都**如此（两条读数各出现两遍），所以它不是「偶发一次」。

## 二 对照读数（同一支 spec、同一条代码路径）

| 提交 | Nightly | `Build macos-arm64` | 该 spec 的 ic31 读数 |
| --- | --- | --- | --- |
| `dc0089ca` | `38255743811` success | success（作业 `114839513031`） | 三行**逐字相同**，`named read failure: false` |
| `656ac561` | `38249451395` success | —（同车道 success） | — |
| `e4d11b86` | `38243121999` success | —（同车道 success） | — |
| **`f6b8723f`** | `38285152756` **failure** | **failure** | 三行相同，但**多出两条 `No handler registered` 的 pageerror** |

本机侧（dev 构建产物 `npm run build:e2e` → `npx playwright test e2e/certification/egress-settings-read-failure.spec.ts`）：
**连跑 3 次全绿**（7.6s / 5.3s / 5.3s），`grep -c "No handler registered"` 三次**都是 0**。
注意本机没有可用的**打包**产物（`dist/` 下只有一个未改名的 stock `Electron.app`，未含应用代码），
所以本机取证只能验到 **dev 通道**，验不到「打包 + 高负载 runner」这一态——**这一格如实记为未取证**。

## 三 能确定的与不能确定的

能确定：

1. 这两条 pageerror 是**渲染层挂载期的读**：`storage:get-info` 来自 `src/renderer/src/App.tsx:326`
   （启动时读数据根状态），`notebook-env:status` 来自同一个 App 的 `initEnv()`（`App.tsx:319`）。
   两者的共同触发点是 **`completeOnboarding()` 里的 `page.reload()`**（夹具 `electron-app.ts:320`）——
   重载会重新挂载 App，于是这两个挂载期 effect 再跑一次。
2. 主进程侧，`registerIpcHandlers`（`src/main/index.ts:439`，`await` 过）**先于**窗口生命周期安装
   （`installAppLifecycle` 在 600+ 行），所以**正常启动路径上不存在**「窗口先于处理器」的窗口期。
   `storage:get-info` / `notebook-env:status` 的处理器由 `ipc.ts:2893` / `ipc.ts:2865` 注册；
   主进程另有 `disposeIpcHandlers`（`src/main/index.ts:696`）在**收尾**时把注册表整体撤掉
   （`src/main/ipc-handler-registry.ts:184`）—— 这是「已注册过又消失」的唯一已知来源。
3. `dc0089ca..f6b8723f` 这段提交里，与这两条通道相关的文件**只有** `src/main/ipc.ts` / `src/preload/index.ts` /
   `src/preload/renderer-api.d.ts` 的**新增通道**改动（`preview.loadRemoteStructure` + D6 装配处接线），
   没有任何改动触及处理器注册顺序或注册表生命周期（`git diff --stat dc0089ca..f6b8723f` 逐条核过）。

不能确定：**当时那一跑里，是「处理器从未注册」还是「注册后被撤掉」**——作业日志只给渲染层这一侧，
给不出主进程侧的相位（日志里没有该应用实例的 shutdown/relaunch 记录）。据此**不改代码、不改测试、不加大超时、
不跳过该文件**（三条都是把红藏起来）。

## 四 处置与下一步

- 本次处置：**不修**（归因未定 + 本机不可复现 + 三个前序绿对照）。下一跑（我的 `21e2ec18` 推送触发的 Nightly）
  是仲裁者：它再红在同一处 ⇒ 按「系统性」立办，届时**本机打一个真包**（`npm run build:mac`，
  内存闸门允许时）把「打包态 + 重载」这条路径复现出来再动手；它绿 ⇒ 按负载敏感的包装态抖动记档
  （本档即是那次记档，附三份对照与那次本机 3/3）。
- 若它再红，优先查的两个具体相位：① 收尾期 `disposeIpcHandlers` 与「渲染层仍在跑的挂载期 effect」的先后；
  ② 重载发生时主进程是否正处在**数据根迁移/重启**那条路径上（本例的 store 是被故意写坏的，
  降级后的空存储会让启动走另一条分支）。两者都以**打包态取证**为准，不用 dev 通道下结论。
