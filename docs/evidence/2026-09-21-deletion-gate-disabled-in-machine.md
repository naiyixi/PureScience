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
