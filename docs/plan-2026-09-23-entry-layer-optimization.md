# 入口层与交互层优化排期（2026-09-23）

依据：`docs/evidence/2026-09-23-entry-layer-coverage-audit.md`（四轴审计 + 五脚本复跑）。
口径：**一批 = 一个版本边界**；批次内的每个单元独立走「实现 → 相关簇绿 → 双 typecheck + eslint → 提交 → 推送 → 盯 CI → 进下一单元」，批次走完再走完整发版流程（CHANGELOG + 双语 README 横幅 + 全量门禁 + tag + Release）。

每条验收都是**实机可验**（真入口、真执行、真数据）；单元测试只作回归网，不作完成证据。

## 排期总览

| 批次 | 版本    | 主题                            | 单元数 | 交付重心                               |
| ---- | ------- | ------------------------------- | ------ | -------------------------------------- |
| 0    | v1.69.0 | 键盘闭环必修                    | 4      | 消除「按键进黑洞」与「无路可退」的浮层 |
| 1    | v1.70.0 | 三态成套 + 文案归位             | 4      | 不再有「空白且无解释」的面板           |
| 2    | v1.71.0 | 半截功能补齐（有 A→B 没有 B→A） | 5      | 已建能力的管理动作闭环                 |
| 3    | v1.72.0 | 体验真实差距 + 可发现性         | 5      | UI 用上后端更强的实现；入口找得到      |
| 4    | v1.73.0 | 拍板项落地（建入口或归档）      | 6      | 把「已备未建」清成有结论的状态         |
| 5    | v1.74.0 | 防复发门禁                      | 2      | 让这类缺口不能再悄悄长出来             |

版本号按批次边界实际运行时行为分配；纯文档/测试改动不占版本号。

---

## 批次 0（v1.69.0）键盘闭环必修

| 单元 | 内容                                                                                                      | 目标位置                                                                                                                                                                                                                                                     | 验收（实机）                                                                                               |
| ---- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| U1   | `#` 会话引用弹层按键黑洞：补 ↑↓/Enter/Esc + `aria-activedescendant`，或让 `ComposerEditor` 不再为它吞掉键 | `pages/workspace/composer/SessionMentionPopup.tsx`、`ComposerEditor.tsx:242`                                                                                                                                                                                 | 打 `#` 后 ↑↓ 能选、Enter 插入、Esc 关闭，且随后 Enter 仍能提交消息                                         |
| U2   | 共享浮层壳（ESC、焦点陷阱、初始焦点、关闭后焦点归还）并接入自建浮层                                       | 新建 `components/ui/overlay-shell.tsx`；`components/FolderGrantsPanel.tsx:87`、`components/references/ReferencesLibraryDialog.tsx:515`、`workspace/SessionBookmarksDialog.tsx:132`、`workspace/AnnotationDialog.tsx:88`、`workspace/SessionInfoCard.tsx:141` | 五个浮层：ESC 可关、打开即有可见焦点、关闭后焦点回到触发按钮                                               |
| U3   | 对话框焦点语义统一                                                                                        | `components/ui/dialog-chrome.ts`；`workspace/ExportConversationDialog.tsx:90`                                                                                                                                                                                | 打开瞬间有可见焦点指示；导出对话框不再取消初始焦点；~40 个 Radix 对话框共用同一策略                        |
| U4   | 键盘可达性补口                                                                                            | `settings/FileBrowserModal.tsx:633,780`、`workspace/PreviewPanel.tsx:177-196,413,706`、`components/NotificationBell.tsx:154,279`                                                                                                                             | 两个 listbox 有 ↑↓/Home/End；右键菜单可由 `Shift+F10`/Menu 键唤起且菜单内 ↑↓；通知中心桌面端焦点迁移与归还 |

批次 0 收口：`e2e/accessibility.spec.ts` 增一条「键盘闭环」用例（纯键盘走完：开浮层 → ESC → 焦点归位）。

## 批次 1（v1.70.0）三态成套 + 文案归位

| 单元 | 内容                                   | 目标位置                                                                                                                                                                                                                                                                                                                    | 验收                                                                                                                      |
| ---- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| U5   | 11 处空态补齐（一律带下一步动作）      | `WorkspaceSidebar.tsx:216`、`PermissionsPanel.tsx:379`、`GlobalSearchDialog.tsx:1220`、`AgentPanel.tsx:656,664`、`ArtifactProvenancePanel.tsx:1123`、`ContextWindowDialog.tsx:109,541`、`OmicsPreviewPanel.tsx:101`、`StoragePanel.tsx:495`、`MemoryPanel.tsx:173`、`SkillUploadView.tsx:35`、`ConnectorImportView.tsx:183` | 每处空态说明「为什么空 + 下一步点哪」，范式照 `settings/EndpointPanel.tsx:275-284`、`SpecialistMarketplace.tsx:1137-1154` |
| U6   | 15 处加载态 + 12 处错误态（含重试）    | 审计 D 节清单                                                                                                                                                                                                                                                                                                               | 加载有骨架/文案，失败有原因与重试                                                                                         |
| U7   | 10 处硬编码英文清成 i18n key（9 语言） | `GlobalSearchDialog.tsx:1262,1420`、`ProjectFilesView.tsx:1909`、`SessionNotebookDialog.tsx:219,222`、`DownloadSessionArtifactsDialog.tsx:209`、`FoldTimelinePanel.tsx:133`、`LocalFileBrowser.tsx:224`、`SpecialistsPanel.tsx:1204`、`ComputePanel.tsx:231`、`CredentialsPanel.tsx:494`（误用记忆的加载 key）              | `rg -n "Loading…\|Could not load\|No files match"` 零命中；9 语字典同步                                                   |
| U8   | 首帧假空与空分组                       | `pages/home/HomePage.tsx:482` 消费 `project-store.isLoaded`；`WorkspaceSidebar` 空分组                                                                                                                                                                                                                                      | 全新安装不闪「No projects yet」；空项目侧栏有解释与「新会话」入口                                                         |

## 批次 2（v1.71.0）半截功能补齐

| 单元 | 内容                                                                                                  | 验收                                                               |
| ---- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| U9   | 文献合集删/移出（`references:delete-collection` `:152`、`references:remove-from-collection` `:166`）  | 建合集 → 加入 → 移出 → 删除全程可点，删空后可再建同名              |
| U10  | 运行时扫描/选择/注销（`runtime:survey` `:20`、`set-selection` `:35`、`unregister-interpreter` `:83`） | 面板切换解释器后，设置与笔记本两侧状态一致；注销后不再出现在候选   |
| U11  | 会话包导出（`sessions:export-package`）                                                               | 导出→本机导入回环成功，包内清单与界面一致                          |
| U12  | GUI 版本重放（`artifacts:replay-version`）                                                            | GUI 重放结果与 `purescience replay` 逐字段一致；带环境锁与结果对比 |
| U13  | 继续被打断的回合（`acp:continue-interrupted-turn`）                                                   | 强制退出后重启，能续跑同一回合；与 Resume 的语义差别在界面上写清   |

## 批次 3（v1.72.0）体验真实差距 + 可发现性

| 单元 | 内容                                                                          | 验收                                                                           |
| ---- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| U14  | PDF 表格改走几何法（`pdf:tables`），保留审计标签与扫描范围空态                | 同一真表格 PDF，UI 与 agent 都得 4 列、表头与数值同列                          |
| U15  | 图形拾取键盘化（`FigurePickOverlay.tsx:131`、`SelectionAnnotator.tsx:68` 等） | 纯键盘完成打点/锚点标定并导出 CSV                                              |
| U16  | 预览动作从「只能右键」升为一等入口                                            | 下载/存产物/数字化/表格抽取/文献导入均有工具栏或命令面入口，右键仍可用         |
| U17  | 可发现性基建：命令面 + 菜单级入口 + 快捷键清单面 + 设置搜索扩到 `leaf`/关键词 | ⌘K 能搜到命令；设置搜「镜像/mirror/代理」命中；`Cmd+,` 与 `Cmd+W` 在界面上可见 |
| U18  | 上下文门控入口（检查清单/复核/折叠时间线可主动打开）                          | 无评审记录时也能主动打开清单页签，并给出「还没有评审」的解释                   |

## 批次 4（v1.73.0）拍板项落地

每项二选一：**建入口**（附交互草案）或**归档**（在审计文档落结论，并同步合同清单/测试 pin）。

| 单元 | 项                                                                                                                                                                                  | 需要的拍板                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| U19  | PDF 目录 / 图表（`pdf-ipc.ts:1-2` 自陈 future UI）                                                                                                                                  | 预览里建目录树 + 图表区，还是归档为 agent-only？                |
| U20  | 图表复核 `figure_review`、宿主 SQL `query:run`                                                                                                                                      | 给用户入口，还是明确定为 agent-only？                           |
| U21  | 笔记本单元格级 API（run-cell 等）                                                                                                                                                   | 是否做「运行这一格」（会改变用户对笔记本的心智）                |
| U22  | handoff 双面（新面 `handoff-lifecycle-ipc.ts:26,29` vs 旧面 `specialist.*`）                                                                                                        | 哪套是正本：删新面，还是把 UI 迁到新面                          |
| U23  | 计算三件 + 6 条散件（`local-fs:reveal`、`remote-access:disable`、`storage:validate-data-root`、`settings:get-package-mirror`、`settings:xai-oauth-*`、`specialist:cancel-handoff`） | 多数可归档（部分已被 `setMode({mode:'off'})` 等覆盖），逐条确认 |
| U24  | 死面清理：`acp:event`、`acp:permission-request`                                                                                                                                     | 归档（状态快照已承载同等信息）                                  |

## 批次 5（v1.74.0）防复发门禁

| 单元 | 内容                                                                                                     | 验收                                            |
| ---- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| U25  | **入口守卫**：新增 IPC 面必须在合同清单里登记「有 UI 调用点」或带显式归档标记，否则门禁红                | 故意加一条未接线的面 → 门禁红；接线或标记后转绿 |
| U26  | **交互守卫**：手写 `role="dialog"` 必须走共享壳（ESC/trap/焦点归还），否则门禁红；集合表面缺空态时给告警 | 故意写一个裸浮层 → 门禁红                       |

---

## 执行顺序与依赖

1. 批次 0 先行：改动面小、违和感最强（按键黑洞是唯一「按键进黑洞」级缺陷）。
2. 批次 1 纯增量、无跨模块风险，与批次 0 无依赖，可在批次 0 之后立刻进。
3. 批次 2 依赖批次 0 的共享浮层壳（U9/U11 的确认弹窗复用）。
4. 批次 3 的 U14 独立，可与批次 2 并行排；U17 体量最大，建议单独占一段。
5. 批次 4 只在拍板后动；未拍板项**保持记账状态**，不留空。
6. 批次 5 最后做，否则前面的守卫会一直红。

## 差异化红线（交付时必须附上）

- U14：表格候选必须带 `verify-against-source` 审计标签与「扫了哪些页」说明（本仓已有）。
- U12：重放必须带环境锁与结果对比（本仓 `replay-*` 证据链已有）。
- U9–U13：每个管理动作都要有「做了什么 + 现在是什么状态」的读回，不做只发命令不给回执的入口。
- 全部：禁止「点得动但说不出所以然」的入口；禁止空壳 UI。

## 本排期不包含

- v1.68.2 的对外发布状态（由发布流程另行处理）。
- 既有能力收敛路线（ROC 路线图）里的条目。

## 进度记账

### 批次 0（v1.69.0）

| 单元 | 状态               | 落点                                                                                                                                                                       |
| ---- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1   | 完成               | `3105371`：`#` 会话选择器自认领 ↑↓/Enter/Esc，高亮行 `aria-selected`，无匹配时 Enter 让位给消息提交                                                                        |
| U2   | 完成               | `35e9562`：四个自建浮层迁到 Radix 对话框壳（ESC + 焦点陷阱 + 初始焦点），会话信息卡自认领 Escape 且让位上层；新增 `components/ui/dialog-focus-restore.ts`                  |
| U3   | 完成（范围重定义） | `0a54684`：导出对话框不再取消初始焦点；⌘K 命令面板接入焦点归还                                                                                                             |
| U4   | 完成               | `0210367`：文件浏览器两个 listbox 键盘化（跳转菜单取焦/ESC 归还、目录列表单一 Tab 停靠 + ↑↓/Home/End）；预览文件动作菜单可由 `Shift+F10`/Menu 键唤起、打开即取焦、ESC 归还 |

**U2 顺带发现的系统性缺陷（比原计划多出来的工作量）**：全仓 Radix 对话框的 `open` 都是页面 state、`Dialog.Root` 内没有 `Dialog.Trigger`，于是 Radix 关闭时只能走「回到打开前的 activeElement」这条兜底——而这条兜底在**卸载式关闭**下不执行（jsdom 实测 `onCloseAutoFocus` 从未触发，焦点掉到 `<body>`）。

- 本次已修：四个自建浮层（U2）+ 命令面板（U3），每处都有焦点归还断言。
- **刻意未接线的两处及原因**：导出对话框走 `useRetainedDialogValue`（退场动画期间面板仍在，陷阱会把焦点抢回），且常驻式对话框在浏览器里 Radix 自身那条兜底是有效的；接线反而会压制它，故只做「打开后焦点进面板」。
- 仍待处理：其余「无 Trigger」的 Radix 对话框（`grep -rl "Dialog.Content" src/renderer/src --include=*.tsx` 减去 `Dialog.Trigger`，共 47 个文件，其中仅卸载式关闭的会真丢焦点）。**不并入本批次**：无逐条验证的批量改动属于半截工程，需作为独立单元逐个接线并补测试。

**U4 的收口方式**：通知中心桌面端取焦/归还以 `e2e/accessibility.spec.ts` 的键盘闭环用例覆盖（真机 Electron，非 jsdom 断言）；预览菜单与文件列表另有 jsdom 用例 29 + 11 条。

### 本批次实测发现的待办（归入 U17）

- **搜索按钮上印着 `⌘K`，按键打不开面板**。真机 Electron 实测：配好 agent、进入 workspace、焦点在 composer 内按 `Meta+k`，面板不出现（`palette:false`，焦点停在 DIV）；同一状态下走可见按钮（聚焦 + Enter）正常打开。源码侧疑点在 `App.tsx:249-272` 的一串门控（`isSettingsLoaded` / `startupView === 'app'` / `isSessionPersistenceHydrated` / 各浮层开关 / 数据根缺失等），尚未定位到具体哪一条返回早。证据链：`npm run build:e2e` 后 `npx playwright test`（构建产物为 `out/`，改源码不重新构建等于测旧包）。
- 归入 U17 的理由：U17 本来就要做「快捷键清单面 + 命令面」，改门控之前需要先决定快捷键在哪些状态下应当生效，避免把门的开关和清单面做成两套口径。

### 方法学（写给后续单元）

- **改完渲染层代码跑 e2e 前必须 `npm run build:e2e`**：Playwright 通过 `APP_ROOT` 加载 `out/main/index.js`，跑的是构建产物。本轮曾在未重建的情况下得出过三条错误结论（「⌘K 打不开」「焦点掉 body 且钩子无效」「预览菜单打不开」），重建后其中两条被推翻。凡是真机结论都要先确认 `out/` 是新的。
- 真机 e2e 的选点：把断言打在 `e2e/accessibility.spec.ts` 的键盘闭环用例上（打开即取焦 / Escape 收起 / 焦点回 opener），失败时先读 `test-results/electron/<用例名>/error-context.md` 的可访问性树，比截图快。

### 批次 1（v1.70.0）进行中

| 单元            | 状态          | 已落地 / 剩余                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U5（11 处空态） | 8/11 + 3 归档 | ✅ `e8c3376` 侧栏会话空态；✅ `e041249` 权限面板（原 `sr-only`，现区分「完全没记住」与「当前范围为空」并给清除筛选按钮）；✅ `925b657` 命令面板（浏览态门控致全白 → 显式空态；无结果区分「筛选收窄」与「关键词未命中」；产物重试文案入字典）；✅ `d49abbf` agent 框架面板（两组空态 + `Installed · N`/`Available · N` 入字典）；✅ `0d0002a` 上下文面板逐次调用区（原来 `return null`，与「本版本没这个区」无法区分）+ 记忆面板两处；✅ 存储面板用量条空态给「什么会填进来」；✅ 溯源面板执行页空态补「怎么才会有」（`ArtifactProvenancePanel.tsx:1235-1243`，原文只有一句「无法确定」，没说怎么才会有）。**零代码归档 3 处**（已复核，现有形态就是范式）：`SkillUploadView.tsx:494-533` 默认视图本就是虚线投放区 + 图标 + 主副文案 + 「改为手写」出口；`ConnectorImportView.tsx:97-124` 同理（投放区 + 图标 + 文案 + 限额说明）；`components/omics/OmicsPreviewPanel.tsx:140-145` 未选主机时已有说明（含「无主机时如实说明未计算」）。**新发现（并入 U7）**：该 omics 面板整体是硬编码中文（`:92,:98,:142,:150,:74` 等），对 9 语用户是坏文案，且不属先前「硬编码英文」清单，U7 一并清 |
| U6              | **收官（27/27 + 归档）** | ✅ 文件视图搜索未命中（`ws.noFilesMatch` + 提示）。✅✅ **store 层 11 条 toast 失败文案改为字典 key**：新增 `stores/settings-write-error-keys.ts`（11 key + `isSettingsWriteErrorKey` 守卫），两个 slice 只发 key，`SettingsPage.tsx:1086` 单点翻译（非 key 的原始 IPC 报文原样透传，有测试守住）。✅ 报错对话框 3 条（剪贴板/日志揭示）+ 一条无 message 兜底用例。✅ **四处 `Loading…`** → `common.loading`（`LocalFileBrowser:224`、`FoldTimelinePanel:133`、`SkillEditor:479`、`SpecialistsPanel:1204`、`StoragePanel:332`）。✅ 分子渲染兜底、笔记本/会话产物加载失败、产物弹层三态（`ws.artifactPopup*`）、切专员失败、**handoff 状态行 6 句 + `Main Agent` 标签 + 重试失败句**（新增 `handoff.*`，helper 通过新导出的 `Translate` 类型接 `t`）。✅ **第二轮清尾（`rg` 扫全 renderer 找出的残留）**：`validation-message.ts` 十条校验文案改为 **key + 注入 `t`**（`describeValidation(result, t)`，ProviderStep 5 处 + SettingsPage 1 处接线）· 数据根三处（`DataRootMissingDialog`、`LocationStep` ×2 + 一段英文尾巴）· 计划面板三处（`plan.updateFailed`/`plan.feedbackUnavailable`）· `ProvidersPanel` Codex 重新导入 · **`use-project-files-index` 的失败兜底改为 key + `isProjectFilesErrorKey` 守卫，`PageLoadError` 单点翻译（顺手把硬编码 `Retry` → `common.retry`）**。**收口复核**：`rg "Loading…\|Could not \|Failed to load\|No files match\|Unable to "` 在 renderer 非测试文件里**零命中**；纯 `console.error` 的 `PdfPreview:177,557`、`MoleculePreview:80` 归档为非用户可见 |
| U7              | 2/3 面已完成  | 10 处硬编码英文入 9 语字典（侧栏的 `Pinned/Active` 已顺带清掉）。**✅ 设置面（`fe151fe`）**：标题/字段名、状态行（Loading hosts… / Preparing preview… / Testing…）、存储迁移三标题、计算主机标签、无障碍名（Close/Back/Settings/reasoning effort），含两处英文 setup 步骤与一句硬编码中文示例占位符；19 key × 9 语（`gbRam`/`connectorLabel` 被 i18n 质量门拦下后改为 `GB メモリ`/`GB Arbeitsspeicher`/`Konnektor`）。**✅ workspace 面**：计划卡 `Approve`/`● n confidence`/`SCOPE & FEASIBILITY`、`Loading notebook…`、复核器 `● ok`/`● error`/`Session Reviewer`、`Thinking`/`· taking longer than usual`、`Preview unavailable`/`此文件类型不支持预览`、`Add local folder…`/`Add SSH host…`、溯源面板十四个表头与 `Model · not triggered`、`Provenance` 及其 aria（`Open Provenance for {name}`）、移动预览 `Preview` 标题与描述、`Unavailable`/`Disabled`/`will be permanently removed`、`WorkspacePage` 的硬编码中文 `会话书签`/`文献库`；**权限范围确认对话框整句重写**（原来由 `Allow {subject} {scopePhrase}?` 这类英文片段拼接，改为 11 个 key 组合，插值留在组件内以兼容 fallback 字典的测试）。38 key × 9 语。**剩余**：components 面（`OmicsPreviewPanel` 整片中文、`FigurePickOverlay`/`FigureDigitizePanel` 中文、`PermissionUndoSnackbar`、`ReviewerCard`、`ThemeControls`、一批 `aria-label="Close"`） |
| U8              | 未开始        | 首帧假空（`HomePage.tsx:482` 消费 `isLoaded`）+ 侧栏空分组（侧栏部分已随 U5 完成）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**每处空态的验收口径**：说得清「为什么空」+ 给得出「下一步点哪」；新增文案必须 9 语齐备（`translation-quality.test.ts` 会拦 en/zh 不对齐、zh 未翻译、zh-Hant 简体字、占位符不成对），被取代的旧 key 要一并删除，避免留下零调用点的死键。
