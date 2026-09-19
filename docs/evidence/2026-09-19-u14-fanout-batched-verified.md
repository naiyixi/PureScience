# U14：扇出批量化实测 —— 同一启动路径上 52 次 project-files 读降到 **1 次**

- 日期：2026-09-19 / 提交 `6720299`（接线）与基线 `eb1a720`（未接线）
- 机位：macOS 26.6；两次运行**同一台机器、同一份语料快照**（`~/.purescience-project` 的 sessions/db/settings/token + 硬链产物树 → `/tmp/ps-bench-{before,after}`，62 个会话文档、**52 个 project**），dev 带窗口构建，各自独立端口与 `--user-data-dir`。
  - before：`/tmp/ps-before`（`eb1a720` worktree，软链 node_modules）→ 44104 + CDP 9335
  - after：主干工作树（`6720299`）→ 44105 + CDP 9336
- 真实数据根只读拷贝，未指向、未修改；常驻实例 `com.totota.purescience` 已 `launchctl unload` 让位、收尾 `load` 复原（44100 已确认在听）。

## 一、仪器（两侧完全相同，临时、未提交）

`application-command-router` 看不到这条通道（它是 Electron IPC），所以计数用一份**临时探针**：在 `ipc-handler-registry.ts` 的 `invoke` 里把每次通道调用写成一行 `<epochMs> <channel>`（`PS_IPC_TRACE`）。同一 patch 应用到两棵树，跑完 `git apply -R` 回退，工作树干净。慢读数字则来自**已在库的仪器**（`[ipc] ipc handler was slow` / `listFiles segments were slow` / `project file kinds read was slow` / `artifact version resolve was slow`），两侧同一套阈值（50 ms）。

## 二、判据 1：引擎往返 52 → 1 ✅

同一驱动同一窗口（CDP `Page.reload` 起 90 s，两次都用 `probe.mjs`）：

| 指标 | before | after |
|---|---|---|
| 启动窗内 `project-files:list-files` | **52** | **0** |
| 启动窗内 `project-files:list-kinds` | 0 | **1** |
| 启动窗内全部被追踪调用 | 102 | 51 |
| 全程 `project-files:list-files` | 215（≈4 次 Home 挂载 × 52 + 面板） | **7**（全为面板自身） |
| 全程 `project-files:list-kinds` | 0 | 5（每次 Home 挂载 1 次） |

**每次 Home 挂载的扇出 = 52 → 1**，与项目数解耦（52 次读换成 1 次读，一次往返、窗口函数取每项目最新 30 条）。

**文件面板自身的读保留** ✅：两次驱动都走「项目行 → 等 URL 含 `?project=` → 点「文件」」，面板正常挂载；after 全程仍有 **7 次 `project-files:list-files`**（面板打开 + 产物浏览），且 with 面板渲染的预览元素由 3 → 7（before 1 → 7）。

## 三、判据 1（续）：chip 相关 `listFiles` 慢读条目归零 ✅

| 慢读条目（同一仪器，50 ms 阈值） | before | after |
|---|---|---|
| `listFiles segments were slow` | 1（rowsMs 50 / originsMs **0**） | **0** |
| `project file kinds read was slow` | 0 | **0**（<50 ms，未触发） |
| `project files read was slow` | 3（1× list-files 50.9 ms + 2× searchArtifacts） | **0** |

## 四、判据 2：`dbCanaryMs` 高位 —— 本轮**无高位可消**（空结果，如实记）

| | before | after |
|---|---|---|
| `artifact version resolve was slow` 报告数 | 2 | 0 |
| `dbCanaryMs` | 6 / 6 ms | 无样本 |
| **>100 ms 的个数** | **0** | **0** |

U11 里出现的 135/124 ms 金丝雀，在本轮的**两次运行里都没有复现**：这台的引擎在我这次的启动窗里根本没排队（对照：before 的 `listFiles segments were slow` 只有 1 条，而 U12 记录的同类慢读是 48 条）。所以判据 2 **既未改善也未恶化 —— 它是一个空结果**：高位不是被消掉了，而是本轮压根没出现。要把判据 2 变成有意义的证据，需要在一个真能压出排队的负载下重跑（例如与并发写盘/大量产物读同时启动），这条留给下一个单元。

## 五、判据 3：真机 Home 仍渲染同样的 chip ✅（但数字与档案的 18 不同）

CDP 读真实 DOM（`[class*="rounded-[5px]"]`）：

| | before | after |
|---|---|---|
| chip 元素 | **177** | **177** |
| 去重种类 | **16** | **16** |
| 种类清单 | CSV, GZ, HTML, IPYNB, JSON, LOG, MD, NPZ, PDB, PDF, PNG, PY, SDF, SVG, TXT, XLSX | 同上，逐项一致 |

**与档案的差异要说清**：交接档案写的基线是「18 种」。本轮两次实测都是 **16 种**（`MD/JSON/PY/PNG/CSV/PDF/SDF/GZ/XLSX/NPZ/HTML` 全部在内，另加 IPYNB/LOG/PDB/SVG/TXT = 16，即少 2 种）。chip 由「每项目最新 30 条」推导，随语料移动；档案的 18 来自更早一次运行的语料快照，不能直接比。**能站住的结论是 A/B 本身：同语料同仪器下，接线前后逐项一致（177/16）**，不是「等于档案里的 18」。

（`chipsAtMs`：before 2706 ms / after 5755 ms —— 单样本、1 s 轮询粒度，**不作为改善证据**，只记着。）

## 六、判据 4：不回归 ✅

- 全量门禁 `npm run test:gate`（`--maxWorkers=4`）：**1034 文件通过 / 14 skipped，13887 用例通过 / 190 skipped，EXIT 0**
- `npm run typecheck`（node + web）干净；`eslint --no-cache` 干净；`prettier --check` 干净
- 契约计数随通道各 +1：catalog 417→418、invoke 315→316、local-Web 安装 345→346、Electron 路径 417→418、coreContracts 191→192、requests 153→154、composition internal 309→310 / local Web 307→308 / remote 206→207、data-content 51→52
- CI：`Windows Full Test`（run 35421103048）与 `Nightly`（run 35421103273）在 `6720299` 上均 **completed / success**（用 `gh api … --jq .conclusion` 判定，不用 `gh run watch`）

## 七、诚实边界

1. 单机、单次、dev 构建；两轮的运行时长与驱动脚本相同，但**不是**统计意义上的重复实验。
2. 计数依赖临时探针（每次调用一行同步 append，~µs 级），两侧同样付出，不影响 52 → 1 的量级判断。
3. 判据 2 是空结果（见 §四），**不要**把它读成「排队被消除」。
4. chip 种类数与档案的 18 不一致，已在 §五 明说；A/B 一致是结论，绝对值不是。

## 八、并发闸（§四 的第二个候选）：机制 A/B + 审计 + 补上第二处未加闸的扇出

同一台机、同一语料、同一驱动，一次只跑一个模式（各起一个实例，避免日志归属混淆）。这一轮把**引擎金丝雀接到了被优化的读路径上**（见 §八.3），所以每次读都会报出自己的耗时和一条与它同窗的平凡 `SELECT 1`：

| 模式 | 发起方式 | 读次数 | `totalMs` 中位 / 最大 | **`dbCanaryMs` 中位 / 最大** | >100 ms |
|---|---|---|---|---|---|
| m4 **无闸** | 52 个 `listFiles` 同时发出（改造前的渲染层写法） | 59 | 12 / 21 | **12 / 20** | 0 |
| m5 **有闸（4）** | 同样的 52 个读，4 个一批 | 59 | 2 / 15 | **2 / 15** | 0 |
| m6 **批量** | 1 次 `listKinds`（本次改动后的写法） | 7 | 4 / 12 | **3 / 7** | 0 |

**读出来的结论**：无闸时金丝雀与读自身耗时**中位相同（12 ms vs 12 ms）** —— 平凡查询和真查询排同一个队，U11 的机制在这条路径上复现；限流到 4 后同样 59 次读的金丝雀中位掉到 **2 ms**（≈6×），批量后读次数从 59 降到 7。

**判据 2 的边界（仍未消掉的那半）**：本轮三个模式的 canary **最深只有 20 ms**，`>100 ms` 高位**一个都没有**。所以 U11 记录的那条 135/124 ms 高位依旧未被复现 —— 这台机、这份语料压不出更深的队列。**能站住的是方向与量级（6×），不是"高位消失"**。要取那条数字需要一个真能压深队列的负载，仍留在案上。

### 八.1 审计：渲染层每个 project-files 读取点的闸情况

| 位置 | 扇出形态 | 原先是否加闸 |
|---|---|---|
| `use-project-files-index.ts`（`requestLimiterRef`，6 处 `.current(` 调用点 + `loadInitialProjectFiles` 的参数） | 每个展开的会话组/上传组各一页 | **有**（内联 `createRequestLimiter(4)`，但**无任何用例**） |
| `ProjectFilesView.tsx` 预览扇出 `Promise.all(missingTargets.map(previewReader))` | 打开一个文件夹即对所有缺失预览同时发起（每读 = 引擎查询 + 文件读） | **无**（本次补上，同 4 上限） |
| `ArtifactMentionPopup` / `DownloadSessionArtifactsDialog` / `ReferencesLibraryDialog` | 单次读（非扇出） | 不需要 |

### 八.2 本次代码（配合 §八.1）

- 抽出 `src/renderer/src/lib/request-limiter.ts`（原先是 `use-project-files-index.ts` 里的内联副本），并补 4 条用例：限额成立、FIFO、**拒绝也释放槽位**、运行中再排队的峰值 ≤ 上限。原先这份实现**零用例**。
- `ProjectFilesView` 的预览扇出接上同一把闸。
- 金丝雀工具化：`PURESCIENCE_DB_CANARY=1` 时，`listFiles` 与 `listKinds` 各自在查询前起一条 `SELECT 1`、查询后 await，并把它写进慢读报告；开启时读阈值降为 0，**所以一次运行拿到的是分布而不是"只报慢的那几条"**。默认关闭 ⇒ 生产零成本（这正是本轮要避免的"为了测排队而多加一次排队"）。用例 `query-owner.canary.test.ts` 钉住两半：关着时**只发一次查询、不记一行**；开着时 SQL 顺序是 `SELECT 1` → 真查询，且报告里带 `dbCanaryMs`。

### 八.3 仍未取的证据（如实列出）

**预览扇出的真机 A/B 没做**：新增的那把闸目前由 limiter 用例 + m4/m5 的同机制实测支撑，没有专门跑一次"打开多文件文件夹"的前后对比。它与 §四 的高位缺口共用同一个前置条件（需要能压深队列的负载）。

## 九、补测：启动期金丝雀 A/B，以及"加闸"三次尝试的真实结果

### 9.1 启动期带金丝雀的 A/B（判据 2 真正该做的实验）

把**同一份金丝雀补丁**同时打到 `eb1a720` 与 `fc83649`（`git apply` 到 before worktree；两棵树的 `query-owner.ts` 在该补丁前逐字相同），两边都开 `PURESCIENCE_DB_CANARY=1`，同一驱动（CDP `Page.reload` 后等 chip 挂载）：

| 启动期、同一仪器 | before `eb1a720` | after `fc83649` |
|---|---|---|
| 启动窗内 `project-files:list-files` | **52** | 0 |
| 启动窗内 `project-files:list-kinds` | 0 | **1**（`rows=445`、覆盖 52 个项目） |
| `totalMs` 中位 / 最大 | 42 / 57 | 11（单次） |
| **`dbCanaryMs` 中位 / 最大** | **42 / 56** | **3** |
| `>100 ms` | 0 | 0 |

**读出来的**：启动期每一次 chip 读都坐在一条**与自身耗时同深**的队里（canary 中位 42 ms vs 读 42 ms，1:1），改造后只剩一次读、队列读数 3 ms。**判据 2 的机制在启动路径上拿到了数字（42 ms → 3 ms），但"`>100 ms` 高位消失"仍未复现** —— 本次能压出的最深队列是 56 ms，U11 的 135/124 ms 高位在这台机、这份语料上没有出现（含金丝雀自身带来的额外查询在内）。

### 9.2 "加闸"在真机上的三次尝试：**全部是空结果**

用带**起止时间**的探针算每个通道的**峰值并发**（`START`/`END` 两行，`END` 在同一毫秒先于 `START` 计），驱动方式固定（打开产物最多的项目 `cmtuc9z500000wft0otm9ub6t`，31 个产物 → 文件面板 → 点行）：

| 对比 | 树 | `read-preview` 调用 | **峰值并发** |
|---|---|---|---|
| 预览批次闸 | `fc83649`（有闸） | 84 | **19** |
| 预览批次闸 | 同上、把闸去掉 | 84 | **19** |
| 缩略图闸 | `fc83649`（无缩略图闸） | 84 | **19** |
| 缩略图闸 | 工作树（有缩略图闸） | 84 | **19** |

四种组合**逐项相同**。结论：**那 19 并发的 `read-preview` 突发既不是文件面板的预览批次、也不是每行缩略图发出的**（它们是启动期就在跑的另一处调用者，本轮未定位 —— 探针按隐私设计不记参数，要区分得再加一个 `maxBytes` 数值字段）。所以：

- 这两把闸**没有拿到真机收益证据**，它们目前只有"机制实测（§八：同样 59 次读，无闸比有闸排队深 ~6×）+ 用例"支撑；
- 我没有把它们写成"已提速"，也没有因此撤掉：`ProjectFilesView` 的 `Promise.all(missingTargets.map(...))` 与每行缩略图在**代码上确实是"一次发起 N 个读"**，按 §八 的机制它们迟早会撞上深队列；两把闸都由 `request-limiter` 的用例覆盖，且只改发出顺序、不改结果。

### 9.3 下一步（唯一还没拿到的东西）

**定位那 19 并发 `read-preview` 的真实调用者**，再决定要不要也给它加闸 —— 仪器已就绪（把 `maxBytes` 加进探针即可区分"缩略图 256 KB"与"整篇预览"）。这条与 §四 的高位缺口合并为同一件事：**需要一个真能压深队列的负载**，本轮在这台机/这份语料上造不出来（合成的放大语料我没有做，因为那会把"真实语料实测"变成"自造负载实测"，会误导结论）。


