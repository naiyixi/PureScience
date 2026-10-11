# 具名环境的体积读数与「移除释放了多少」上屏（P0-10(b) 的窗口半边）

> 单元来源：P0-10「内容存储回收」线。**生产侧早已有读数**（`2af5e324` 交付：移除前测量前缀、列表按前缀计大小、
> agent 工具的结果映射器一路带出），但**窗口那一面一个字段都没消费**——用户在「设置 → 运行环境 → 具名环境」
> 里既看不到某个环境占多少，移除掉一个 GB 级环境后也**不会被告知释放了多少**。本单元补的正是这半边。
>
> 类型：**纯渲染层**（零新通道、零契约计数涟漪、零新 pin）。占一个版本位。

---

## 一、缺口核实（对源逐条核过，不是按计划措辞）

| # | 事实 | 证据（file:line） |
| --- | --- | --- |
| 1 | 移除路径**在删除之前**测量前缀并回报 `freedBytes` | `src/main/notebook/environment-management.ts` 的 `case 'remove'`：`dirSize(prefix, …)` → `manager.removeEnvironment(name)` → `return { environments, freedBytes }` |
| 2 | 列表路径按前缀计大小（`sizeBytes`） | 同文件 `withSizes()`（`stat` 先判存在，不存在/非有限值一律**不填**，注释写明「could not look」不得读成 0） |
| 3 | 契约里两个字段都在，且窗口那条通道**用的是同一个结果类型** | `src/shared/notebook-env.ts`：`ManageEnvironmentsResult { environments; freedBytes? }`；`NamedEnvironmentResult = ManageEnvironmentsResult`；`EnvironmentInfo.sizeBytes?` |
| 4 | agent 面**已消费**（因此不是「有值没人读」的另一半） | `src/main/notebook/mcp-server.ts` 的 `compactManageEnvironmentsResult`：`environments` 取 `sizeBytes`、`freedBytes` 显式透传（注释自指 P0-10b） |
| 5 | 窗口通道链路齐备，值确实到达渲染端 | `runtime:manage-named-environments`（`src/main/notebook/runtime-ipc.ts`）→ `runtime-selection-workflows.ts` 的 `manageNamedEnvironments` → `runtime-service.ts` 的 `manageEnvironments` → `ipc.ts` 的 `notebookService.manageEnvironments` |
| 6 | **缺口一**：渲染端把 `freedBytes` 直接丢掉 | `RuntimesPanel.tsx` 的 `confirmRemoveNamedEnv`：旧代码只取 `result.environments`，回执句是「Removed “X”.」——释放了多少一个字都没有 |
| 7 | **缺口二**：渲染端从不读 `sizeBytes` | 同上文件的具名环境行：旧代码只印 name / language / ready / interpreterPath；`grep -rn "sizeBytes" src/renderer/src` 在组件里 0 命中（只有一处测试夹具） |

**结论**：这属于本仓点过名的「契约/投影里有了、生产里没有任何消费方」那一类；两条都在**渲染层**，因此
本单元不动主进程一个字节。

## 二、交付（1 改源码 + 1 改用例 + 9 语字典）

- `RuntimesPanel.tsx`：
  - 具名环境行新增 `[data-testid="named-env-size"]` 一行，**只在该环境确有读数时**渲染
    （`formatByteSize(env.sizeBytes) === undefined` 就整行不渲染）；
  - `confirmRemoveNamedEnv` 按返回值分两种回执：`freedBytes` 为**正数**时用新键报出释放量，
    否则沿用原句。**0 与缺失一律按「没有读数」处理**——生产侧把「量不了」折成了 0，
    窗口据此印「freed 0 B」就是替一个没人做过的测量背书。
- 两个新键 × 9 语（`runtimes.namedEnvSizeLabel` / `runtimes.namedEnvRemovedWithSize`），
  走本技能自带的 `scripts/add-i18n-keys.py`（九文件齐平预检 + 写后按 key 反查自证）⇒ 覆盖率见 §四。
- 渲染用例 **+3 条、改 1 条**（同一 describe 内，沿用既有 `flush()` 双击宏任务写法）：
  1. 既有那条「列表 + 移除 + 回报」现在同时断言行上的 `1 KB`（来自 `sizeBytes: 1024`）与
     回执里的 `2 KB`（来自 `freedBytes: 2048`）；
  2. 回执**不带** `freedBytes` ⇒ 屏幕上不得出现任何字节数（`not.toMatch(/\d+\s?(B|KB|MB)\b/)`）；
  3. 回执带 `freedBytes: 0` ⇒ 同上，且明确不得印 `0 B`；
  4. `sizeBytes` 缺失 ⇒ 整行 `named-env-size` 不存在。

## 三、门禁读数（全部实跑，读数即结论；数字取自**最后一次改动之后**的运行）

| 环 | 读数 |
| --- | --- |
| 定向 vitest（`RuntimesPanel.render.test.tsx` + `src/renderer/src/i18n`） | 5 文件 / **96 passed** |
| `prettier --check`（本单元 11 个文件） | 通过（首跑 11 文件全 `[warn]`，核对 `HEAD` 版本**全部 CLEAN** ⇒ 漂移是本单元引入的，已对**仅本单元的文件**跑 `--write`，复跑 `All matched files use Prettier code style!`） |
| `eslint --no-cache .`（全仓，CI 同口径） | **0 error / 122 warning**，exit 0；**本单元 11 个文件 0 warning**（122 是既有基线，逐条都在别的文件里） |
| `tsc` node / web（均带 `--composite false`） | exit 0 / exit 0 |
| 全量 `vitest run --maxWorkers=4` | **1247 passed \| 16 skipped（1263 文件）**、**16114 passed \| 207 skipped（16321 条）**，exit 0，206 s（上一轮 16111 ⇒ 本轮 +3 恰为本单元新增用例） |
| `bash scripts/pre-push-checks.sh` | exit 0 |

**i18n 质量门**：新键随 `src/renderer/src/i18n` 套件一起跑（与上表第一行同一批），未新增 pending 条目；
zh ≠ en、zh-Hant 纯繁体。

**不触碰的基准核过**（不是等 CI 报）：`e2e/visual-regression.spec.ts` 的基准只有
`home-empty.png` / `project-create-dialog.png` / `workspace-empty.png` / `settings-general.png`
（General/Appearance 页）⇒ 本单元所在的「运行环境」页不在任何基准里。

**认证车道不会被本单元弄红**（逐条核过，不是推断）：`e2e/certification/` 里三个会点「移除具名环境」的 spec
（`lock-import.spec.ts` / `named-env-kernel-in-use.spec.ts` / `packages-mutation.spec.ts`）**都不断言那句回执文案**——
它们断言的是行数、目录是否还在、以及拒绝语原文（`runtimes-error`）。行高变化也不影响
`hasText` 定位。

## 四、口径边界（不许读成「已做」）

1. **没有真机窗口读数**：本机内存闸门仍关着（空闲物理页 ≈ 121 MB，swap 已用 5.0 G / 6.0 G），
   起不了 `build:e2e` + Electron。界面那半边由渲染用例作证，**不冒充窗口读数**。
   取证配方（内存宽松时一次跑完）：`lock-import.spec.ts` 已经走到「导入 → 行 → 移除」，只需在移除前加
   `expect(namedRow.getByTestId('named-env-size')).toBeVisible()`、移除后读 `runtimes-notice` 原文，
   即可拿到两条真机读数。
2. **0 与「没量到」在窗口侧同形**：生产侧把测量失败折成 `0`（既有实现，本单元未改），所以窗口只能
   对正数说话。要让两态在屏上分开，需要主进程先分态（`freedBytes?: number` 之外再加一个具名状态）——
   属**独立单元**，不在本单元。
3. **本单元不承诺「总量会掉 N」**：行上显示的是「这个前缀在盘上占多少」，不是可回收量。
