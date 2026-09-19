# 交接：扇出批量化与产物探测的收尾（v1.64.1 之后仍未闭合的项）

- 日期：2026-09-19
- 本版做了什么、数字多少：`CHANGELOG.md` 的 `## v1.64.1` 条目 + `docs/evidence/2026-09-19-u14-fanout-batched-verified.md`（§一~§十一）
- 本文只记**没做完的**，每条都给可判定的验收条件，避免留在汇报里无人认领。

## 一、`dbCanaryMs >100 ms` 高位：本机不可复现（需要能压深队列的负载）

- **现状**：在**真实语料的完整副本**（123 会话 / 2607 产物 / skills + 专家清单 + runtime + claude + notebooks 全就位）上，金丝雀最深 **4 ms**，`artifact version resolve was slow` 一条都没有；U11 记录的 135/124 ms 高位一次都没出现。
- **已确立的**：机制与量级 —— Home 扇出 **52 → 1**、启动期金丝雀中位 **42 ms → 3 ms**；无闸 52 并行时 canary 与读自身耗时 1:1（12 ms ↔ 12 ms），限流到 4 后 2 ms。
- **要闭合需要**：一个**真能压出引擎排队**的负载（不是合成的放大语料 —— 那会把真实语料实测变成自造负载实测）。候选：与大量产物读/写盘同时启动、或与运行时安装并跑；判据是同一窗口里平凡 `SELECT 1` ≥100 ms 且真查询同步变慢。
- **仪器已就绪**：`PURESCIENCE_DB_CANARY=1`（随本版入库，默认关闭零成本）。

## 二、打包版复测：本版数字全部来自 dev 构建

- **现状**：`electron-vite dev` 实例测的；打包版（`npm run build:unpack` 产物）尚未用同一套方法复测。
- **要闭合需要**：在 `dist/mac-arm64/PureScience.app`（版本号须为 1.64.1）上，用真实语料副本重测三项可观测项 —— chip 种类数/元素数、`storage:get-info` 首读耗时与 `pending`、以及启动期是否还有慢读报告。
- **限制**：IPC **调用计数**依赖临时追踪仪（`PS_IPC_TRACE`，不随发行版发出），打包版只能验证**用户可见结果**；计数结论仍以 dev 构建为准，须在复测文档里写明这一分层。

## 三、`ProjectFilesView` 预览批次闸：保留但未取得收益证据

- **现状**：`Promise.all(missingTargets.map(previewReader))` 已接共享限流器（`lib/request-limiter`，上限 4），但真机 A/B（有闸/无闸）**逐项相同**（`read-preview` 84 次、峰值 19）—— 说明该驱动没有让它成为瓶颈。
- **保留理由**：它在代码上确实是"一次发起 N 个读"，按机制迟早撞深队列；且有用例覆盖、只改发出顺序。
- **要闭合需要**：造出"一次打开几十个文件的大文件夹"的驱动（本轮的驱动只点开 3 行），拿到有闸/无闸的峰值差；若无差则按"审计归档"撤掉，别留着当装饰。

## 四、面板 `pending` 的其余消费者（已核对，无遗留）

- `StoragePanel`：三处字节数（on disk 行、总计行、迁移"将移动 X"）+ 用量条形区全部按 `pending` 显示等待文案，并有渲染用例断言**不出现 `0 B`**。
- `App.tsx`：`storage.getInfo()` 是 fire-and-forget，只读 `dataRootMissing` / `legacyDataMovePrompt`，与 usage 无关 ⇒ 无需改。
- 其它 `getInfo` 调用方（`DataRootMissingDialog` / `NetworkPanel` / `OnboardingWizard`）：均不渲染 `usage`。

## 五、运行隔离事故与规程（2026-09-19，打包版复测时发生，必须记住）

**事实（有 mtime 证据）**：我启动的打包版实例（`dist/mac-arm64/PureScience.app`，`CFBundleShortVersionString 1.64.1`）运行窗口内，**真实配置根 `~/.purescience-project` 被写入**：

| 文件 | mtime | 归因 |
|---|---|---|
| `settings.json` | 19:22:03 | **我那个打包实例**（常驻实例此时已 unload） |
| `claude/skills/mcp-*/SKILL.md`（一批） | 19:22:03 | 同上（启动期技能同步） |
| `web-service.json` | 19:22:04 | 同上（内容仍是常驻实例的 port 44100 / pid 911） |
| `purescience.db` | **17:45:57**（早于事故 1.5 h） | **未被写** |
| `sessions/**`（文档与索引） | 无窗口内 mtime | **未被写** |

**影响**：无数据丢失（库与会话未动；常驻实例 44100 正常、HTTP 401、62 个会话文档在）。被写的三个文件都是**应用自行维护**的（设置、从安装包同步的技能、web 服务登记），不是用户产物。

**机制（已定位到代码行）**：`src/main/storage-root.ts`

- `resolveE2eStorageRoot()`（`PURESCIENCE_E2E_STORAGE_ROOT`）→ 若无则 `PURESCIENCE_STORAGE_ROOT`（**仅 dev**）→ 再无则 `app.getPath('home')/.purescience-project`（固定、注释明写 "Never relocated"）。
- 但我**实测到 env 之外的写**：即便带了 `PURESCIENCE_E2E_STORAGE_ROOT`（并伪造 `HOME`），真实根仍被写。**尚未定位是哪条路径绕过了沙箱**（候选：技能/设置写入方用的是真实 home 而不是配置根）。要闭合需要给"配置根解析"与"技能同步"各加一条来源日志，属下一单元。

**规程（在定位之前，强制）**：

1. **不要再在本机跑打包版实例** —— 没有任何 env / `--user-data-dir` 组合能保证配置根不被写；需要打包版验证时，先在隔离用户或容器里跑。
2. dev 实例（`electron-vite dev` + `PURESCIENCE_E2E_STORAGE_ROOT`）同样会把**配置根**写在真实 home 下（这是本仓设计），所以"真实根零接触"这句话对**数据根**成立、对**配置根**不成立，以后汇报要分开说。
3. 事故后必须做窗口归因：用 `find <真实根> -newermt '<实例启动>' -not -newermt '<实例退出>'` 列出窗口内被写的文件，与常驻实例自身启动写区分开。

**已取得但仍成立的打包版观测**（在事故窗口内，读行为有效）：打包版渲染 chip **177 元素 / 16 种**（与 dev 逐项一致）；其自身日志里 `listFiles segments were slow`、`project file kinds read was slow`、`project files read was slow`、`artifact version resolve was slow` **全部为 0**。

**打包版存储读数为何是 0**：我给的语料是 **dev 布局**（`PureScience-DEV/{artifacts,notebooks,…}`），而打包版找的是 `PureScience/`（`dataFolderName()` 按 `app.isPackaged` 切换）⇒ 五个类别目录存在但计 0 字节。要用打包版复测存储，语料必须按打包布局构造（把 dev 树放进 `<root>/PureScience/`）。

