# 证据：项目/会话删除入口在真机上永久禁用（2026-09-21，本地真机复现）

## 现象

E2E 与本地真机**完全一致**：项目卡片的操作菜单里 `Delete` 菜单项是 **disabled**，点击 30s 超时
（Playwright：`element is not enabled`，重试 57 次）。**重启应用后仍然 disabled**（实测）。

```
PROBE before relaunch: disabled=true
PROBE after relaunch:  disabled=true
```

## 但恢复本身是成功的 —— 数据与界面不一致

渲染层实测（真机 Electron，探针经 `page.evaluate` 调用真实 bridge）：

```
window.api.sessions.loadAll({})
→ {"isComplete":true,"warnings":[],"isProjectDeletionRecoveryComplete":true}   ✅
```

即 **main 侧报"项目删除恢复已完成"** ✓，而界面上的删除入口仍是禁用 ✗。

## 链路（读取到的实际代码）

| 位置 | 内容 |
| --- | --- |
| `src/renderer/src/pages/home/HomePage.tsx:577` | `disabled={!canDeleteProjects}` |
| `src/renderer/src/App.tsx:581` | `canDeleteProjects={sessionPersistence.canDeleteSessionsAndProjects}` |
| `src/renderer/src/lib/session-persistence/session-persistence.ts:631` | `setCanDeleteSessionsAndProjects(result.diagnostics?.isProjectDeletionRecoveryComplete === true)` |
| `src/main/session-persistence/ipc.ts:124` | 恢复成功：`withProjectDeletionRecoveryStatus(await sessionLoader.loadAll(options), true)` |
| 同上 `:121` | 恢复失败（catch）：`withProjectDeletionRecoveryStatus(await sessionLoader.loadAllReadOnly(), false)` |

**单次 load 证明 main 会给 `true`** ✓，而该 state 是**加载时写一次**的（无重算路径 ✗）⇒ 界面读到 false 只能说明
**那次写入走了别的分支/时序**（例如首次加载时恢复尚未完成、或 `setIsHydrated` 之前的提前 return ✗）。**这一步尚未
定位**，是下一轮的第一件事。

## 已排除的假设（都做了实测，避免继续推断）

| 假设 | 实测 | 判定 |
| --- | --- | --- |
| 应用在 E2E 里启动卡住，删除门只是"还没就绪"的瞬时值 | 分时探针：`t0` 仍是 `Starting PureScience…`（23 字），**t+5s 已进入首页**（Projects / Recent sessions，178 字）并一路稳定到 t+30s | ✗ 排除；删除门是**稳定** false |
| 加载失败但被静默吞掉 | 启动后页面文本里**没有** "storage recovery could not finish" / "could not be read" / "Retry"；截图里也没有错误横幅 | ✗ 排除（未走失败分支） |
| `useSessionPersistence` 的 effect 因依赖变化重跑，把 true 覆盖成 false | effect 依赖只有 `[loadAttempt]`（启动不改它），且唯一调用点是 `App.tsx:54`，只调用一次 | ✗ 排除 |
| React StrictMode 双挂载导致 `isMounted` 早退 | `main.tsx:45` 确实包了 `StrictMode`，但 E2E 跑的是 **production 构建**，StrictMode 不双跑 effect | ✗ 排除（E2E 场景） |

> 顺带记一条 spec 侧隐患：`app.completeOnboarding()` **不等待应用就绪**（返回时还在 `Starting PureScience…`），
> 现在靠 Playwright 的自动等待兜住。

**下一件事**：在渲染层直接观测那次写入（在 `:631` 与 `:676` 各加一次性临时打印，或临时给 HomePage 加
`data-can-delete-projects` 调试属性），跑一次真机 E2E 即可看出是"走 catch"还是"isMounted 早退"。**不要再靠读代码推断**。

## 根因（实测锁定）

渲染层那次加载**没有走 catch**，只打出一条探针：

```
PROBE-CONSOLE: [probe] load outcome undefined
```

即 `result.diagnostics` 是 **undefined** ✗ ⇒ `undefined === true` 恒假 ⇒ 删除门恒为 false ✓。

原因在**列表层**：`loadPersistedSessions`（`session-persistence.ts:287-304`）**优先走 `api.listCatalog()`**：

```ts
const catalog = api.listCatalog ? await api.listCatalog() : undefined
const loaded = catalog ? { sessions: …, manifest: … }   // ← 不含 diagnostics ✗
                       : await api.loadAll()            // ← 含 diagnostics ✓
```

而 main 侧只有 `loadAll` 那条注入诊断（`ipc.ts:124` 的 `withProjectDeletionRecoveryStatus(…, true)`），列表层
（`ipc.ts:150`）**直接 `return sessionLoader.loadCatalog()`** ✗；且 `SessionCatalogResult`
（`shared/session-catalog-summary.ts:57`）**本身没有 diagnostics 字段** ✗。

⇒ 这是"目录读取从 55 MB 降到元数据"那次优化留下的缺口：列表层没把诊断带上，所有依赖诊断的能力门
（`canDeleteSessionsAndProjects`、`hasCompleteSessionCatalog`）在真实运行时都读到 undefined ✓。

### 修法（下一步实现）

1. `SessionCatalogResult` 增加可选 `diagnostics?: SessionLoadDiagnostics`；
2. main 的列表层注入诊断：恢复成功 → `true`，恢复失败 → `false`（降级语义与 `loadAll` 一致）；
3. 渲染层 catalog 分支把 `catalog.diagnostics` 带进返回对象；
4. 补测试（main 两侧注入 + 渲染层 catalog 路径下 `canDelete` 为 true）；
5. 本地真机 E2E 验证删除入口可点（这是本条的验收口径）。

### 已修复（真机验收通过）

已改：**1**（`shared/session-catalog-summary.ts`）、**3**（`session-persistence.ts` 的 catalog 分支带上 `diagnostics`）、以及 `ipc.ts` 的
`loadCatalogAfterProjectRecovery` 注入 + helper 泛化为 `<Result extends { diagnostics?: SessionLoadDiagnostics }>`。

**让修复生效的那一步**（实测指出）是 `sessions.listCatalog` 映射到通道 `sessions:list-catalog`
（`shared/web-api-map.generated.ts:192`），而该通道在 `session-persistence/ipc.ts:256` 注册成
`withDataRootWrite(() => handlers.listCatalog())`（handlers 直通 `repository.loadCatalog()` ✗）；`loadCatalogAfterProjectRecovery`
**全仓没有任何 import** ✗（只是被 `export`，是重构留下的 dead code）✓。所以：

1. `registerSessionPersistenceIpcHandlers` 增加可选参数（`ProjectDeletionRecoveryBackend`），在 `src/main/ipc.ts:2409` 的装配处传入（该文件已有实例，`loadSessionsAfterProjectRecovery` 就在 652/2422 行用它）；
2. `sessions:list-catalog` 的注册改为经 `loadCatalogAfterProjectRecovery(...)`；
3. 断言：`src/main/session-persistence/ipc.test.ts` 新增两条直测 `loadCatalogAfterProjectRecovery`（恢复完成 → `true`、恢复失败 → `false` 且仍返回扫描结果）；
   `session-persistence.render.test.tsx` 新增一条证明 **catalog 路径**会把删除门打开（`data-deletion-ready="true"`，且 `loadAll` 未被调用）。

**真机验收结果** ✓：`e2e/electron-foundation.spec.ts` 的删除旅程**首次通过**（Delete 可点 → 确认 → 重启后项目确实消失）；
同批修复后 macOS 的两条 lane 在真机上全绿——功能旅程 **3 passed**、workspace 旅程（含 launch-environment）**8 passed**。
单元侧 `typecheck` 0 错误、`session-persistence` 两套件 **284 passed**。

> 注：`sessions:load-all` 通道（`ipc.ts:222`）同样直通 handlers，但渲染层的 `loadAll` 走的是 application-command 装箱路径
> （`src/main/ipc.ts:652/2422` 用 `loadSessionsAfterProjectRecovery` 包装 ✓），所以那条**有**诊断——这也解释了为什么探针
> 直接调 `loadAll` 能看到 `true`，而界面走的 `listCatalog` 看不到。

## 影响面（同源字段）

`canDeleteSessionsAndProjects` 同时喂两个 prop：

- `canDeleteProjects`（首页项目卡片的 Delete）
- `canDeleteConversations`（会话的删除）

⇒ 一旦为 false，**项目与会话两条删除路径同时点不动** ✓（用户侧表现："看着有删除，点了没反应"）。

## 复现步骤（本地真机，可复用）

```bash
cd ~/purescience
NODE_OPTIONS="--max-old-space-size=8192" npm run build:e2e      # 默认内存会 node abort（exit 134，缺 out/renderer）
NODE_OPTIONS="--max-old-space-size=8192" npm run build:web
npx playwright test e2e/electron-foundation.spec.ts --reporter=line --retries=0
# 期望：2 failed / 1 passed（改名那条通过；创建那条等的是已删除文案 `Set up your research workspace.`；
#       删除那条卡在 disabled 的菜单项）
```

## 与本轮两个 PR 的关系

**无关** ✓：本轮改动只落在 main 进程的 Artifact 能力/票据（`artifact-turn-owner.ts`、`local-rpc-server.ts`、
`runtime*.ts`）与搜索面板（renderer 的 global-search 目录），未触及上述任何一环。此缺陷是既有的，靠
`electron-foundation.spec.ts` 暴露出来；此前一直没暴露，是因为 **main 的 push 流程（Nightly / Windows Full
Test）根本不跑 E2E**，只有 pr-gate 跑，而本仓库的 PR 历来只有 dependabot 的（跳过 E2E lane）✓。

## 同批的其它定性

- `e2e/launch-environment.spec.ts`：两条纯函数断言缺了有意的 `--lang=en-US` 参数 ✓ → **已修，本地 4/4 绿**。
- `e2e/electron-foundation.spec.ts` 第一条：断言等 `Set up your research workspace.`，该文案在 v1.67 的 renderer
  里**已不存在**（全量 grep 零命中）✓ → spec 老化。
