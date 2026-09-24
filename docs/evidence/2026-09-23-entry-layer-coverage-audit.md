# 入口层与交互层覆盖审计（2026-09-23）

四轴排查：**显性入口**（能力有没有可点的入口）、**可发现性**（入口能不能被找到）、**空态**（集合为空时说了什么）、**键盘闭环**（键盘能不能走完）。

结论一句话：**能力本体（后端 + 通道 + 类型 + 测试）完整度很高，缺的是"最后的 30 厘米"**——431 条渲染层合同面里 33 面在界面代码里零调用点，61 处集合表面缺空/加载/错误态，21 条快捷键里只有 4 条在屏上有提示。

## 一、审计口径与方法（可复跑）

| 方法                                       | 命令 / 脚本                                                                               | 覆盖                   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------- |
| 正向：每个渲染层合同面是否有调用点         | `audit-01-contract-inventory.mjs`（严格 root 限定）→ `audit-02-renderer-call-sites.mjs`（宽松裸成员，含 `getCommands().x()` 间接调用） | 431 面                 |
| 分组读覆盖度：后端 N 动词 / UI 触达 M 个   | `audit-03-group-coverage.mjs <root...>`（如 `pdf references runtime`）                    | 43 个能力组            |
| 反向：main 有 handler 而渲染层拿不到的通道 | `audit-04-unexposed-channels.mjs`                                                         | 675 处 `ipcMainHandle` |
| 通道-处理器对账（辅助口径）                | `audit-05-channel-handlers.mjs`——按字面量匹配，经常量表定义的通道会误报，需人工复核       | 430 通道               |
| 空态/加载/错误态子审计                     | 独立子代理，逐文件读 `.map(` 与互斥分支                                                   | 63 个集合表面          |
| 键盘闭合子审计                             | 独立子代理，逐浮层比对 `Escape/onKeyDown/tabIndex/autoFocus/aria-modal/onOpenAutoClose`   | 全部浮层与列表选择器   |

判定规则：一条面记为「零调用点」需**严格**（`root.member`）与**宽松**（任意 `.member`，含 `getCommands().x()` 间接调用）两轮搜索都为空，再逐条人工打开源文件确认；`window.*` 一类由独立载体消费的面**不计入缺口**（见第七节）。

## 二、A 类：能力本体存在 / 半存在，界面入口缺失

| #   | 能力                                                         | 后端证据                                                                                                                                                                                                                                                                                                                                                   | 今天谁能触达                                                                                     | 用户缺什么                                                                                                                                                                            | 处置                                                      |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| A1  | PDF 分层阅读：**目录**、**图表**                             | `src/main/settings/pdf-ipc.ts:1-2` 自陈「renderer's surface for layered PDF reading (**used by future UI**)」；通道 `pdf:outline` `:19`、`pdf:figures` `:22`                                                                                                                                                                                               | 仅 agent（`pdf_*` MCP 工具）                                                                     | 预览里没有目录树/图表区                                                                                                                                                               | 已备未建（代码自陈）→ 立案                                |
| A2  | PDF **表格**抽取——UI 用的是**弱方法**                        | 主进程几何法 `PdfService.tables()` 已真机达标（`docs/evidence/2026-09-17-pdf-table-extraction-wired.md` §3.5：真机 7 行 × 4 列）                                                                                                                                                                                                                           | agent 有几何法；**UI 没有**                                                                      | `components/pdf/PdfTablePanel.tsx:56` 只调 `pdf.open`+`pdf.pages`，再在渲染层跑**纯文本**抽取（`extractPdfTableCandidatesFromText(page.page, page.text)`，不带坐标），扫到 200 页封顶 | **P1 真实功能差**：接通 `pdf:tables` 即可让 UI 用上几何法 |
| A3  | 图表复核 `figure_review`                                     | `src/main/settings/figure-ipc.ts:2` 自陈「used by future UI」                                                                                                                                                                                                                                                                                              | 仅 agent（figure MCP）                                                                           | `components/figure/` 只有数字化/拾取，无复核入口                                                                                                                                      | 已备未建 → 立案                                           |
| A4  | 宿主数据 SQL 查询 `query:run`                                | `src/main/settings/host-query-ipc.ts:2` 自陈「used by future UI」                                                                                                                                                                                                                                                                                          | 仅 agent（`host_query` MCP）                                                                     | 项目数据无查询面                                                                                                                                                                      | 已备未建 → 立案                                           |
| A5  | 文献合集：**删除合集**、**从合集移除**                       | `src/main/references/ipc.ts:152`、`:166`                                                                                                                                                                                                                                                                                                                   | 无人                                                                                             | 库对话框能建合集、能加入（`components/references/ReferencesLibraryDialog.tsx`），**不能删、不能移出**                                                                                 | **P1 半截功能**：有 A→B 没有 B→A                          |
| A6  | 运行时：**扫描机器**、**选择解释器**、**注销解释器**         | `src/main/notebook/runtime-ipc.ts:20`、`:35`、`:83`                                                                                                                                                                                                                                                                                                        | 无人                                                                                             | `settings/RuntimesPanel.tsx`（978 行）只 list / enable / 授权 / 挑选 / 注册；**选择态只读**（`shared/notebook-runtime.ts:57` 回显 `selection` 却无控件）                              | **P1 半截功能**                                           |
| A7  | 笔记本单元格级 API（begin / append / finish / **run-cell**） | `src/main/notebook/ipc.ts:24,27,30,33`                                                                                                                                                                                                                                                                                                                     | 仅 agent                                                                                         | UI 只有终端式 `notebook.execute({source:'user'})`（`pages/workspace/NotebookPreview.tsx:536`），没有「运行这一格」                                                                    | 立案（需先确认产品意图）                                  |
| A8  | 会话包**导出** `sessions:export-package`                     | `src/main/session-package/ipc.ts:31`                                                                                                                                                                                                                                                                                                                       | 无人                                                                                             | GUI 只有导入（`components/session-package/SessionPackageImportDialog.tsx:76`）                                                                                                        | **P1 半截功能**                                           |
| A9  | 版本**重放**（可复现重跑）                                   | `src/main/artifacts/ipc.ts:580`                                                                                                                                                                                                                                                                                                                            | **仅 CLI**：`purescience replay <versionId>`（`packages/purescience/cli.mjs:749`、`CLI.md:220`） | 溯源面板无「重放」；同一能力 CLI 有界面没有                                                                                                                                           | **P1**：GUI 应能在版本上重跑                              |
| A10 | 继续被打断的回合                                             | `src/main/acp/ipc.ts:41`，实现 `interrupted-turn-continuation.ts:186`                                                                                                                                                                                                                                                                                      | 无人                                                                                             | UI 显示「会话已被中断」（`ConversationPanel.tsx:598`）只给 **Resume**（重连会话）；「按原 prompt 续跑同一回合」无入口，二者语义不同                                                   | **P1**：这是崩溃恢复的体验断点                            |
| A11 | 计算主机/任务三件：启用主机直读、任务标记已消费、待通知任务  | `src/main/compute/ipc.ts:633` 等                                                                                                                                                                                                                                                                                                                           | 无人                                                                                             | 计算面板无「已启用主机」直读与任务已读语义                                                                                                                                            | P2                                                        |
| A12 | handoff 生命周期**新面** list / retry / changed              | `src/main/agents/handoff-lifecycle-ipc.ts:26,29` + `shared/handoff-lifecycle.ts:90-94`                                                                                                                                                                                                                                                                     | 无人                                                                                             | 渲染层仍走旧面 `specialist.getHandoffEvents/retryHandoff`（`pages/workspace/handoff-lifecycle-source.ts:103,114`）——同一功能两套面                                                    | P2（先定性哪套是正本）                                    |
| A13 | 散件                                                         | `local-fs:reveal`（`main/local-fs/ipc.ts:27`）、`remote-access:disable`（`main/remote-access/ipc.ts:47`）、`storage:validate-data-root`（`main/storage/ipc.ts:27`）、`settings:get-package-mirror`（`main/settings/ipc.ts:294`）、`settings:xai-oauth-refresh/status`（`:188`）、`specialist:cancel-handoff`（`main/agents/completion-handoff-ipc.ts:26`） | 无人                                                                                             | 有实现无入口；其中 `remote-access:disable` 已被 `setMode({mode:'off'})` 覆盖                                                                                                          | P2 / 归档                                                 |

代码自陈「used by future UI」的三处（A1/A3/A4）是**已备未建**，不是缺陷；但它们占了「能力本体存在而体验层缺失」的一大块，应当显式记档而不是留在代码注释里。

## 三、B 类：死面与合同漂移

| 现象                                                               | 证据                                                                                                                             | 判断                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `acp:event`、`acp:permission-request` 两条事件流**渲染层从不订阅** | 渲染层只用 `acp.onState` 快照 + `acp.onElicitationRequest`（`lib/acp/useAcpRuntime.ts:127`）                                     | 死面：状态快照已承载同等信息 → 可归档 |
| handoff 合同**自相矛盾**                                           | `shared/handoff-lifecycle.ts:96-98` 明写「deliberately has no command methods」，同文件 `:92` 却注册了 `handoff-lifecycle:retry` | 需二选一：删通道或改注释              |
| main 有 handler、渲染层合同里没有                                  | 仅 2 条：`compute:session:set-concurrency-limit`、`compute:session:status`（`main/compute/ipc.ts`）                              | 内部用，非缺口                        |

## 四、C 类：可发现性

| #   | 现象                                                                                                | 证据                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| C1  | **没有命令面板**：全仓无 `cmdk` 依赖、无 CommandPalette                                             | `package.json`；`rg -l 'CommandPalette\|command-palette\|cmdk'` 零命中                                     |
| C2  | 原生菜单**只有系统角色**：无「设置…」、无「查找」、无「帮助」                                       | `src/main/app-menu.ts` 全文（80 行）                                                                       |
| C3  | 设置搜索**只匹配面板 label/id**：搜「镜像 / mirror / proxy」搜不到对应开关                          | `pages/settings/SettingsPage.tsx:279-286`；条目里的 `leaf`（子标题，如 `:574` 包镜像）只用于面包屑 `:1030` |
| C4  | **无快捷键清单 / 帮助面**：i18n 里 `shortcut` 零命中，`aria-keyshortcuts` 全仓仅 1 处               | `i18n/en.ts`；`SettingsPage.tsx:863`                                                                       |
| C5  | 检查清单 / 折叠时间线 / 复核只作为**预览工具页签**存在，且工具项由事件创建                          | `previews/PreviewToolContent.tsx:76,105,115`；`stores/preview-workbench-store.ts:188,202,212,230`          |
| C6  | 预览区右键菜单是**唯一入口**（下载、复制路径、存为产物、图形数字化、omics、表格抽取、PDF 文献导入） | `PreviewPanel.tsx:230,307`，仅 `onContextMenu:706`                                                         |

## 五、D 类：空态 / 加载态 / 错误态（63 个集合表面）

- **空态缺失 11 处**、**加载态缺失 15 处**、**错误态缺失 12 处**、**文案硬编码英文 10 处**。
- 最伤用户的 5 处：
  1. `pages/workspace/WorkspaceSidebar.tsx:216` 无条件 push `{label:'Active'}`，空项目 → 主侧栏只有标题加空白，无解释无「新会话」入口（同级最佳对照 `HomePage.tsx:605` 有文字空态）。
  2. `pages/settings/PermissionsPanel.tsx:379-382` 空态写成 `sr-only` → 视觉用户看到纯空白面板（骨架 `:370`、错误重试 `:348` 都在，唯独空态不可见）。
  3. `components/global-search/GlobalSearchDialog.tsx:1220-1236` 浏览态两段都被 `length > 0` 门控 → ⌘K 面板结果区全白（同一弹窗的搜索态却有完整空文案 `:1412`）。
  4. `pages/settings/AgentPanel.tsx:656,664` 两个列表各自 `: null` → 框架未检测完或全不可用时只剩标题。
  5. `pages/home/HomePage.tsx:482` 未消费 `project-store.isLoaded`（`stores/project-store.ts:12,61`）→ 首帧对**已有项目**的用户闪「No projects yet」。
- 另有 10 处硬编码英文 `Loading… / Failed to load… / No files match…`（`rg -n "Loading…|Could not load|No files match"` 可一次定位）。
- 现成范式（照搬即可）：`settings/SpecialistMarketplace.tsx:1137-1154`（空态+命名动作按钮）、`components/pdf/PdfTablePanel.tsx:105`（空态说明扫描范围）、`settings/EndpointPanel.tsx:275-284`（三态齐全样板）。

## 六、E 类：键盘闭环

**结构性根因**：项目没有 Radix 封装层。`components/ui/dialog.tsx` 不存在，`components/ui/dialog-chrome.ts`（26 行）**只导出 className，零行为**——ESC / 焦点陷阱 / 焦点归还全靠各文件自己 import `radix-ui` 的 `Dialog`。凡是不走 `Dialog.Root` 的手写浮层，三项全无。

最严重 8 条：

| #   | 现象                                                          | 证据                                                                                                                                                                           | 后果                                                                            |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| E1  | `#` 会话引用弹层**把 Enter/Esc/↑↓ 全吞掉且无接收方**          | `composer/ComposerEditor.tsx:242` 在三个弹层任一时 `return`，而 `SessionMentionPopup.tsx` 全文件 **0 个 keydown**（`rg -n 'Escape\|Arrow\|onKeyDown\|keydown'` 零命中）        | 唯一「按键进黑洞」级缺陷：`#` 一打出来 Enter 既不能提交也不能选中，Esc 也关不掉 |
| E2  | 图形拾取面 `role="application"` **无键盘路径**                | `components/figure/FigurePickOverlay.tsx:131-137` 仅 `onClick`，无 `tabIndex/onKeyDown`；同类 `PdfRegionOverlay`、`SelectionAnnotator.tsx:68`                                  | 打点、锚点标定、导出 CSV 纯鼠标                                                 |
| E3  | 预览右键菜单是唯一入口**且无键盘唤起**                        | `PreviewPanel.tsx:413`、`:706` 只挂 `onContextMenu`；菜单 `:177-196` 无 roving tabindex                                                                                        | C6 那些动作对键盘用户不可达                                                     |
| E4  | `FolderGrantsPanel` **全无键盘关闭**                          | `:87-93` 是 `role=dialog aria-modal` 的假语义；`rg 'Escape\|keyDown\|tabIndex\|.focus()\|autoFocus'` 该文件仅命中输入框的 Enter（`:135`）                                      | 只能 Tab 到 ✕（`:103`）或鼠标点遮罩                                             |
| E5  | `ReferencesLibraryDialog`（`z-[95]` 全屏）**无 ESC、无 trap** | `:515-521`；`:555`/`:782` 的 keydown 只服务两个输入框                                                                                                                          | 必须 Tab 到 ✕（`:528`）                                                         |
| E6  | `SessionBookmarksDialog` **连遮罩点击都没有**                 | `:132` 外层无 `onClick`，`:134` 无 `aria-modal`、无 ESC                                                                                                                        | 只剩 ✕（`:143`）一条窄路                                                        |
| E7  | `ExportConversationDialog` **主动取消初始焦点**               | `:90 onOpenAutoFocus={(e) => e.preventDefault()}`                                                                                                                              | 打开后焦点仍在触发按钮，需盲按 Tab                                              |
| E8  | Radix 对话框统一「焦点落在无轮廓面板上」                      | `dialog-chrome.ts:8` `outline-none` + Radix 默认聚焦 `Content`；仅 `RenameSessionDialog:86`、`ProjectFormDialog:103`、`ContextWindowDialog:712`、`GlobalSearchDialog:383` 例外 | ~40 个对话框打开瞬间无可见焦点指示                                              |

其余：`SessionInfoCard.tsx:141-146`、`AnnotationDialog.tsx:88-94` 同类；`FileBrowserModal.tsx:633,780` 两个 `role=listbox` 无 ↑↓/active-descendant；`NotificationBell.tsx:154,279` 焦点迁移只在移动端；`JobDetailModal.tsx:347` 用 `aria-label` 替代 `Dialog.Title`；审批类弹窗（`ComputeApprovalDialog:60` 等 4 处）刻意屏蔽 ESC（设计有意，但期间无退出语义）。

**快捷键可发现性**：21 条里只有 4 条有屏上提示——`Cmd/Ctrl+K`（`HomePage.tsx:407` 徽标 + `SettingsPage.tsx:863 aria-keyshortcuts` + 搜索页脚 `:1467-1482`）、缩放（原生 View 菜单 `app-menu.ts:49-62`）、`Enter/Shift+Enter` 与 `/` `@` `#`（输入框占位文案 `ConversationPanel.tsx:938`）。**`Cmd/Ctrl+,` 与 `Cmd/Ctrl+W` 属「只有读过源码才知道」**（`App.tsx:164-192`、`main/windows.ts:338-342`）。

## 七、排除项（避免误报）

- `window.findInPage / clearFind / closeFind / onFindInPageResult / onShowWindowFind / onWindowFindAppearance` 6 面由**独立载体** `resources/find-overlay/` 消费，`Cmd/Ctrl+F` 由 `main/windows.ts:321-327` 的 `before-input-event` 触发 → **不是缺口**。
- `searchPins.list/save`、`preview.load/save/delete`、`settings.listSkills/installCodex` 等在渲染层经 `getCommands()` / `window.api?.x?.y` **间接调用**，两轮搜索已确认可达 → **不是缺口**。
- `compute:session:*` 两条是 main 内部通道 → 不是缺口。

## 八、整改清单（按优先级的决策表）

| 优先级 | 项                                                | 做法                                                                                                                     | 验收口径（实机）                                                       |
| ------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| **P0** | E1 `#` 弹层按键黑洞                               | 给 `SessionMentionPopup` 补 keydown（↑↓/Enter/Esc + active-descendant），或在 `ComposerEditor.tsx:242` 不再为它 `return` | 真机：打 `#` 后能按 ↑↓ 选中、Enter 插入、Esc 关掉且 Enter 仍能提交消息 |
| **P0** | D1 侧栏空态 + 首帧假空                            | `WorkspaceSidebar` 空分组给文案与「新会话」入口；`HomePage` 消费 `isLoaded`                                              | 真机：全新安装首屏不闪「No projects yet」；空项目侧栏有解释与入口      |
| **P0** | E4/E5/E6 三个自建浮层补 ESC + 初始焦点 + 焦点归还 | 抽一个共享浮层壳（ESC、trap、focus 归还、初始焦点），三处接入                                                            | 真机：三个浮层的 ESC 关闭、打开即有可见焦点、关闭后焦点回到触发按钮    |
| **P1** | A2 UI 表格走几何法                                | `PdfTablePanel` 改调 `pdf:tables`（保留现有空态文案与审计标签）                                                          | 真机：同一份真表格 PDF，UI 与 agent 得到同样的 4 列结果                |
| **P1** | A5 文献合集删/移出                                | 库对话框补两个动作                                                                                                       | 真机：建合集→加入→移出→删除全程可点                                    |
| **P1** | A6 运行时选择/注销/扫描                           | `RuntimesPanel` 补选择控件与注销按钮                                                                                     | 真机：切换解释器后面板与笔记本两侧状态一致                             |
| **P1** | A8 会话包导出                                     | GUI 补导出入口                                                                                                           | 真机：导出的包能被本机导入回来                                         |
| **P1** | A9 版本重放在 GUI 落地                            | 溯源面板加「重放」                                                                                                       | 真机：GUI 重放与 `purescience replay` 结果一致                         |
| **P1** | A10 继续被打断的回合                              | 中断横幅除 Resume 外给出「继续这一回合」                                                                                 | 真机：强制退出后重启，能续跑同一回合                                   |
| **P1** | E2/E3 图形拾取与右键菜单键盘化                    | 拾取面补键盘锚点/微调；右键菜单加 `Shift+F10`/Menu 键唤起 + roving tabindex                                              | 真机：纯键盘完成一次打点与一次「存为产物」                             |
| **P1** | D 类空/加载/错误态成套补齐                        | 以 `EndpointPanel` 三态样板为准，先补 11 处空态 + 10 处硬编码文案                                                        | 真机：逐屏走查，无「空白无解释」面板                                   |
| **P2** | C1/C2/C4 可发现性                                 | 命令面板或菜单级入口 + 快捷键清单面 + 设置搜索扩到 `leaf`/关键词                                                         | 真机：⌘K 能搜到命令；设置里搜「镜像」能命中                            |
| **P2** | C5/C6 上下文门控入口                              | 工具页签补主动打开入口                                                                                                   | 真机：无评审记录时也能主动打开清单页签                                 |
| **P2** | B 类死面与合同漂移                                | `acp:event` 等归档；handoff 双面择一                                                                                     | 合同清单与测试 pin 同步更新                                            |
| **P2** | A1/A3/A4/A7/A11/A12/A13                           | 按产品意图择一：建入口或显式归档                                                                                         | 归档需在本文档留下结论                                                 |

**差异化要求（交付红线）**：上述每一项落地时必须优于「有入口」本身——例如 A2 的表格抽取要带 `verify-against-source` 审计标签与扫描范围说明（本仓已有），A9 的重放要带环境锁与结果对比（本仓已有 `replay-*` 证据链），不允许出现「点得动但说不出所以然」的入口。

## 批次 4 归档结论（零代码收口，2026-09-24）

按 2026-09 验收口径，以下差距项以「归档」收口：结论落档即为完成，不造空壳入口。逐条依据见排期 `docs/plan-2026-09-23-entry-layer-optimization.md` 的「批次 4 进行中记录」U23/U24 两节。

| 差距项 | 归档依据（渲染层调用点 / 已有等价路径） |
| --- | --- |
| `compute` 三件（启用主机直读 / 任务标记已消费 / 待通知任务） | 面板已覆盖主机 CRUD、详情、任务事件与审批卡（`ComputePanel.tsx` / `ComputeHostDetail.tsx` / `ComputeApprovalDialog.tsx` / `stores/compute-store.ts` / `App.tsx:458,464`）；审计自身定级 P2，余下为细粒度读回 |
| `local-fs:reveal` | 渲染层 0 命中；同意图已有 `localFs.openPath`（`LocalFileHeaderActions.tsx:46`） |
| `remote-access:disable` | 渲染层 0 命中；已被 `setMode({ mode: 'off' })` 覆盖（`RemoteControlPanel.tsx:304`） |
| `storage:validate-data-root` | 渲染层 0 命中；保留为 host/agent 命令（`host-application-commands.ts:284`、`storage/ipc.ts:27`） |
| `settings:get-package-mirror` | 渲染层 0 命中；镜像经设置快照下发（`settings-store.ts:113/173/193`） |
| `settings:xai-oauth-*` | 已覆盖：`ProvidersPanel.tsx:182/183/198` 已用 start/complete/logout |
| `specialist:cancel-handoff`（含旧面 `getHandoffEvents` / `retryHandoff` / `onHandoffLifecycleEvent`） | 渲染层对 cancel 为 0 消费；**读回与重试仍是生产面**（`ipc.ts:910` 安装）。新面 `handoff-lifecycle:list/:changed/:retry` **在 main 里从未安装**（见 U22/U29），故 U22 的迁移已回退 |
| `acp:event` / `acp:permission-request` | 渲染层 0 命中；权限请求由 `permission-grants-store` 与会话状态 `waiting-permission` 承载，主进程仍按 `application-events.ts:37-38` 广播；保留为兼容/观测通道 |

### 批次 5 守卫自查出的两处缺口（U25 落地当轮，2026-09-24）

这两条不是人工审计发现的，是新门禁第一次运行时报出来的，因此此前所有轮次都漏过：

| # | 缺口 | 证据 | 结论 |
|---|---|---|---|
| U27 | `endpoint:approve` 无 UI：脚本字节的哈希锚定要求用户在设置面板里批准，而窗口零调用点 | `src/main/settings/endpoint-ipc.ts:1-5`（注释自陈是渲染层的面）；渲染层 `endpoint.approve` / `approveEndpoint` 均 0 命中 | **立案建 UI**（安全相关：没有批准入口则锚定链路走不通） |
| U28 | ~~窗口内查找整组面无 UI~~ **审计前提有误**：查找栏是**独立浮层**，不在主窗口 DOM 里 | 6 条通道**全部**被 `resources/find-overlay/findOverlay.js:20/62/93/116/117/118` 消费；触发在 `main/windows.ts:321`（⌘/Ctrl+F → `findOverlay.open()`），ESC 关闭在 `:332`；既有真机用例 `e2e/windows-window-system.spec.ts:49-60`（Windows）。原判据只扫 `src/renderer/src/**` 而消费者在 `resources/**` | **已结案（归档 + 守卫扩容）**：守卫纳入该渲染面、6 条登记项移除、新增平台自适应真机用例 `e2e/certification/window-find-overlay.spec.ts` **4.6s 通过** |

两处均已写入 `src/shared/entry-layer-archived-surfaces.ts` 的登记册（带 PENDING BUILD 标记与证据），门禁在建成前保持绿。

### U31：真机取证时发现的更大缺口（2026-09-24）

| # | 缺口 | 证据 | 结论 |
|---|---|---|---|
| U31 | 笔记本面板**无入口**：`notebook:available` 从未被触发 | `session-lifecycle.ts:159` 的 `notifyAvailable()` 主进程零调用点（`notifyChanged` 有多处）；`application.ts:48`、`application-events.ts:41`、合同清单与 preload 全部齐备 | **已修**：在 `runCell` / `executeControl` / `executeShell` 三条运行路径宣告；新增 `session-lifecycle.test.ts` 3 条（含一条源码级断言防复发） |

### U27：已修（批次 6 / v1.74.0 预置）

`endpoint:approve` 此前渲染层零调用点，而 `endpoint-manager.ts:89-92` 的 `start` 对未批准的哈希直接抛
「has not been approved yet」⇒ **用户能注册本地模型服务、但永远起不来，界面既不说缺什么、也不能补上**
（`EndpointPanel.tsx:14-16` 的注释早已声称"APPROVE a pending script set（scripts 原样展示）"，实现里没有这条路）。
而且 9 语字典里 `settings.endpointsApprove` / `settings.endpointsPending` 两条 key 早已存在、无人使用。

修法：`listAll` 输出加上 `approved` 标志（`ManagedEndpointView`），面板对未批准的服务显示徽标 + 原因 + **待批准脚本原文**
+ 批准按钮，并禁用那个只会失败的启动按钮。测试 7 条（面板 4 + IPC 3），其中一条当场抓出我自己实现里的错误顺序
（先 `setError` 再 `load()`，而 `load()` 成功会清掉错误 ⇒ 提示永远看不到）。

**真机证据**：`e2e/certification/endpoint-approval.spec.ts`（新增）在打包窗口里跑通 **6.7s**：待批准徽标可见、启动按钮禁用、
展开脚本原文后两句都在、点批准后徽标与批准按钮消失且启动按钮转为可用。取证中另修正两处夹具问题（受管端点端口被限制在
20000–29999；侧栏设置入口在项目视图下叫 `Settings`、会话视图下才叫 `Model settings`）。

这条是 U21 真机取证的副产物：卡片控件写完了，但面板本身进不去 —— 又一次印证本仓反复出现的形状：**通道声明齐全 ≠ 链路可达**。
