# 交接：① 扇出批量化（`project-files:list-kinds`）—— 设计已定，实现待做

- 日期：2026-09-19
- 前置：U11 证实**引擎队列**是共享瓶颈（平凡 `SELECT 1` 与真查询同慢，135 vs 136 ms）；U12 已用 `omitOrigins` 去掉 chip 扇出里白付的来源查询（`originsMs` 29 → **0**，单次 77 → **51–54 ms**）。
- 现状：**仍未修**的是**扇出本身** —— `HomePage` 对**每个 active project** 各发一次 `listFiles`（`activeProjects.map(...)`，`Promise.allSettled`），实测启动期 **48 次慢读**（每次 ≥50 ms）。`projectSummaries` 渲染**全部**项目卡片，**没有可见子集**可退让，所以只能批量化。

## 一、要做的事（一次调用取代 N 次）

新增通道 **`project-files:list-kinds`**：一次调用返回**多个项目各自的文件类型**。

### ✅ 已完成（`4aef17b`，测试全绿，无行为变化）
1. **共享类型与规则**：`ListProjectFileKindsRequest` / `ProjectFileKindsSummary` 已加入 `src/shared/project-files.ts`；`src/shared/project-file-kinds.ts` 提供 `PROJECT_FILE_KIND_LIMIT` + `deriveProjectFileKinds`（**单一实现**，`HomePage` 已改为引用它，本地副本已删），并有自己的用例（最新优先、去重、上限 4、无法识别的扩展名）。
2. **主进程批量读**：`ProjectFilesQueryOwner.listProjectFileKinds` —— **一次往返**，窗口函数 `ROW_NUMBER() OVER (PARTITION BY projectId ORDER BY sortAtMs DESC, seq DESC)` 取每项目最新 **30** 条（`$queryRawUnsafe` + `?` 占位，**不拼字符串**；`≤100` 项目、空数组早返回、非字符串入参过滤、逐个 `requireIdentifier`），kinds 用共享规则推导，≥50 ms 记 `project file kinds read was slow`。
   - `ProjectFilesClient` 已补 `$queryRawUnsafe`；架构测试（钉住查询 owner 公开方法清单）已更新并写明该方法存在的理由。
3. 用例：`query-owner.kinds.test.ts`（一次查询 + 每项目推导 / 空项目集不发查询 / 去重、空标识符、超上限三例）。

### ⏳ 待做（剩下的接线，一次做完并实测）

### 1. 共享类型（`src/shared/project-files.ts`）
```ts
export type ListProjectFileKindsRequest = { projectIds: string[] }
export type ProjectFileKindsSummary = { projectId: string; kinds: string[] }
```
并把**类型推导规则**放到 shared（**单一实现**，避免主进程与渲染层各写一份而漂移）：

```ts
export const PROJECT_FILE_KIND_LIMIT = 4
export const deriveProjectFileKinds = (
  items: ReadonlyArray<{ name: string; sortAtMs: number }>
): string[] => { /* 逐字搬 HomePage.tsx:108-121 的现有实现 */ }
```
搬完删掉 `HomePage.tsx` 里的本地副本（`src/shared` 有独立测试目录，加一条用例）。

### 2. 主进程查询（`src/main/project-files/query-owner.ts`）
新增 `listProjectFileKinds(request)`，**一次往返**取回"每项目最新 K 条"：

```sql
SELECT projectId, displayName, sortAtMs FROM (
  SELECT projectId, displayName, sortAtMs,
         ROW_NUMBER() OVER (PARTITION BY projectId ORDER BY sortAtMs DESC, seq DESC) AS rn
  FROM "ManagedFile"
  WHERE projectId IN (?, ?, ...) AND deletedAt IS NULL
) WHERE rn <= 30
```
- 经 `$queryRawUnsafe(sql, ...ids)` 传参（placeholders `?`，**不要拼字符串**）；`projectIds` 逐个 `requireIdentifier`，并设上限（建议 **≤100**），空数组直接返回 `[]`。
- `sortAtMs` 可能以 BigInt/string 回来 ⇒ 映射时 `Number(...)`；kinds 用共享的 `deriveProjectFileKinds`（每项目 30 条 → 取最新、去重、上限 4，与旧语义一致）。
- 记一条慢报告（同一套仪器：`projectFilesBatchLog`，含 `projects`、`rows`、`ms`，阈值 50 ms），便于与"48 次慢读"直接对比。

### 3. IPC 与桥（**契约测试会拦，必须同步**）
- `src/main/project-files/ipc.ts`：新增 `ipcMainHandle('project-files:list-kinds', ...)` + `ProjectFilesHandlers.listKinds`。
- preload：`src/preload/index.ts` 的 `projectFiles` 桥新增 `listKinds`（沿用 `electronRendererContracts.invoke('projectFiles.listKinds', request)`）。
- **渲染层契约目录**：`electronRendererContracts` 的通道清单与 wrapped 集合要加这一条 —— 仓库有**计数断言**（本批已遇到：`data-content-application-commands.test.ts` 的"51 channels"清单、`renderer-contract-catalog`/`renderer-surface-matrix`）。51 → **52**，并补 wrapped key。

### 4. 渲染层（`HomePage.tsx` 的 chip effect）
```ts
const listKinds = window.api?.projectFiles?.listKinds
if (!listKinds || activeProjects.length === 0) return
const summaries = await listKinds({ projectIds: activeProjects.map((p) => p.id) })
// 直接构造 { [projectId]: kinds }；无桥时照旧不渲染 chip
```

## 二、验收判据（写死；与 U12 同口径）

1. **查询数**：启动期该项目扇出的引擎往返由 `N`（每项目 1 次）降到 **1**；`listFiles segments were slow` 里与 chip 相关的条目应**归零**（文件面板自身的慢读不受影响，仍会记录）。
2. **排队高位**：`dbCanaryMs` 的高位（>100 ms）在启动窗内**消失或显著减少**（U11 已证 canary 是排队指示器）。
3. **真机功能**：Home 在真实语料上仍渲染**同样多的 chip**（U12 基线：**18 种**，`MD/JSON/PY/PNG/CSV/PDF/SDF/GZ/XLSX/NPZ/HTML…`，CDP 读 DOM）。
4. **不回归**：`project-files`、`pages/home`、`shared`、契约（composition/wiring/router/catalog/surface-matrix）全绿。

## 三、风险与取舍

- **窗口函数**：SQLite 3.25+ 支持 `ROW_NUMBER() OVER (PARTITION BY ...)`；本项目 SQLite 由 Prisma 打包（版本足够），但**首次实现后务必用真实库验证一次**；若不支持，退路是**一次 `findMany({projectId: {in: ids}, select: {projectId, displayName, sortAtMs}, take: 2000})`** 再在内存里按项目分组取最新 30（仍是一次往返，代价是载荷上限）。
- **`omitOrigins`**：批量化后，Home 不再走 `listFiles`，`omitOrigins` 就只剩"其他未渲染来源的调用者"可用；**保留**（文件面板仍需要来源，别误删）。
- **桥缺失时的降级**：现在是"无桥 ⇒ 无 chip"，改造后保持同样行为即可，不要引入未验证的降级路径。

## 四、之后（同一机制的第二个候选）

**并发闸**：给仍在扇出的读（文件面板、产物列表）设并发上限，用 `dbCanaryMs` 验证"排队高位消失"。U11 已证并发在引擎队列下**只能产生等待、不产生吞吐**，所以这条有理论依据，但仍需前后实测。
