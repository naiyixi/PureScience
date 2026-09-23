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

#### U7e（本批次新增拍板项）：图形数字化导出的 CSV 审计头要不要跟着 UI 语言走

**现状**：`src/shared/figure-to-data.ts:155-176` 生成的 CSV 头是**中文**（`# 数据来源：…`、`# 状态：estimated · 需审查（不得直接进入正文，先进审查 Finding）`、`# 审计：通过（仍需审查后方可使用）`、`# 审计：不可用——缺少来源文件…`、`注意事项：…`）。这个 CSV 是**用户下载/附着到结果里的证据文件**，不是屏幕文案。

| 选项                      | 效果                                                                            | 代价                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **A（建议）单一稳定英文** | 任何语言的用户拿到的审计头一致、可逐字节比对；CLI/agent/审查 Finding 引用同一串 | 中文用户看到的证据头变成英文（但正文列名可另议）                                                          |
| B 跟随 UI 语言出 9 套     | 每种语言的用户都读母语                                                          | 审计证据不再可比：同一份数据在不同语言环境下导出的头不同，测试要按语言分支，CLI 无 UI 语言时还得兜底      |
| C 保持中文                | 零改动                                                                          | 现状即缺陷：9 语里 8 种用户拿到读不懂的审计声明，且「不得直接进入正文」这类**禁止性声明**读不懂就等于没有 |

**建议 A**，并在实现时把 `figure-to-data.test.ts:92-107`、`FigureDigitizePanel.render.test.tsx:105-106`、`FigurePickOverlay.render.test.tsx:118-119` 的中文断言一并改为英文断言。**未拍板前不动代码**。

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

### 批次 1（v1.70.0）已完成并发布

| 单元            | 状态                      | 已落地 / 剩余                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U5（11 处空态） | **收官（8 改 + 3 归档）** | ✅ `e8c3376` 侧栏会话空态；✅ `e041249` 权限面板（原 `sr-only`，现区分「完全没记住」与「当前范围为空」并给清除筛选按钮）；✅ `925b657` 命令面板（浏览态门控致全白 → 显式空态；无结果区分「筛选收窄」与「关键词未命中」；产物重试文案入字典）；✅ `d49abbf` agent 框架面板（两组空态 + `Installed · N`/`Available · N` 入字典）；✅ `0d0002a` 上下文面板逐次调用区（原来 `return null`，与「本版本没这个区」无法区分）+ 记忆面板两处；✅ 存储面板用量条空态给「什么会填进来」；✅ 溯源面板执行页空态补「怎么才会有」（`ArtifactProvenancePanel.tsx:1235-1243`，原文只有一句「无法确定」，没说怎么才会有）。**零代码归档 3 处**（已复核，现有形态就是范式）：`SkillUploadView.tsx:494-533` 默认视图本就是虚线投放区 + 图标 + 主副文案 + 「改为手写」出口；`ConnectorImportView.tsx:97-124` 同理（投放区 + 图标 + 文案 + 限额说明）；`components/omics/OmicsPreviewPanel.tsx:140-145` 未选主机时已有说明（含「无主机时如实说明未计算」）。**新发现（并入 U7）**：该 omics 面板整体是硬编码中文（`:92,:98,:142,:150,:74` 等），对 9 语用户是坏文案，且不属先前「硬编码英文」清单，U7 一并清                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| U6              | **收官（27/27 + 归档）**  | ✅ 文件视图搜索未命中（`ws.noFilesMatch` + 提示）。✅✅ **store 层 11 条 toast 失败文案改为字典 key**：新增 `stores/settings-write-error-keys.ts`（11 key + `isSettingsWriteErrorKey` 守卫），两个 slice 只发 key，`SettingsPage.tsx:1086` 单点翻译（非 key 的原始 IPC 报文原样透传，有测试守住）。✅ 报错对话框 3 条（剪贴板/日志揭示）+ 一条无 message 兜底用例。✅ **四处 `Loading…`** → `common.loading`（`LocalFileBrowser:224`、`FoldTimelinePanel:133`、`SkillEditor:479`、`SpecialistsPanel:1204`、`StoragePanel:332`）。✅ 分子渲染兜底、笔记本/会话产物加载失败、产物弹层三态（`ws.artifactPopup*`）、切专员失败、**handoff 状态行 6 句 + `Main Agent` 标签 + 重试失败句**（新增 `handoff.*`，helper 通过新导出的 `Translate` 类型接 `t`）。✅ **第二轮清尾（`rg` 扫全 renderer 找出的残留）**：`validation-message.ts` 十条校验文案改为 **key + 注入 `t`**（`describeValidation(result, t)`，ProviderStep 5 处 + SettingsPage 1 处接线）· 数据根三处（`DataRootMissingDialog`、`LocationStep` ×2 + 一段英文尾巴）· 计划面板三处（`plan.updateFailed`/`plan.feedbackUnavailable`）· `ProvidersPanel` Codex 重新导入 · **`use-project-files-index` 的失败兜底改为 key + `isProjectFilesErrorKey` 守卫，`PageLoadError` 单点翻译（顺手把硬编码 `Retry` → `common.retry`）**。**收口复核**：`rg "Loading…\|Could not \|Failed to load\|No files match\|Unable to "` 在 renderer 非测试文件里**零命中**；纯 `console.error` 的 `PdfPreview:177,557`、`MoleculePreview:80` 归档为非用户可见                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| U7              | **收官（四波全绿）**      | 10 处硬编码英文入 9 语字典（侧栏的 `Pinned/Active` 已顺带清掉）。**✅ 设置面（`fe151fe`）**：标题/字段名、状态行（Loading hosts… / Preparing preview… / Testing…）、存储迁移三标题、计算主机标签、无障碍名（Close/Back/Settings/reasoning effort），含两处英文 setup 步骤与一句硬编码中文示例占位符；19 key × 9 语（`gbRam`/`connectorLabel` 被 i18n 质量门拦下后改为 `GB メモリ`/`GB Arbeitsspeicher`/`Konnektor`）。**✅ workspace 面（`a214e44`）**：计划卡 `Approve`/`● n confidence`/`SCOPE & FEASIBILITY`、`Loading notebook…`、复核器 `● ok`/`● error`/`Session Reviewer`、`Thinking`/`· taking longer than usual`、预览兜底、`Add local folder…`/`Add SSH host…`、溯源面板十四个表头与 `Model · not triggered`、`Provenance` 及其 aria、移动预览标题与描述、`Unavailable`/`Disabled`/`will be permanently removed`、`WorkspacePage` 的硬编码中文 `会话书签`/`文献库`；**权限范围确认对话框整句重写**（原为英文片段拼接 `Allow {subject} {scopePhrase}?`，改为 11 key 组合）。38 key × 9 语。**✅ components 面第一批**：`PermissionUndoSnackbar` 两处 `Dismiss`、`ReviewerCard` 的 `Reviewer`/`fix limit reached`、`ThemeControls` 的 `Theme`、文献库 `解除 PDF`/`挂载 PDF`（两处硬编码中文 title）、`ZoomablePreview` 的 `Zoom level`、**八个文件里读屏唯一能听到的 `aria-label="Close"`** 与 launcher 的 `关闭`；7 key × 9 语（`common.dismiss`/`common.theme` 已有，插入重复被 typecheck 拦下后去重）。**剩余**：✅ **`U7c-2` 图形拾取/数字化面板已收官（本提交）**：`FigurePickOverlay` 18 处 + `FigureDigitizePanel` 9 处中文入 9 语（相位提示、进度计数、刻度数值、拾取区 aria、锚点 title、四个按钮、来源/页码/图号与两条审计警告）；`PHASE_LABEL` 常量表改为 `describePhase(phase, t)`；**共享层错误改为「带 key 抛出」**——`src/shared/figure-pick-session.ts` 七处 `FigureDigitizationError` 现在带英文兜底 + `messageKey`，渲染层经 `components/figure/figure-error-keys.ts` 的 `isFigureErrorKey()` 守卫翻译，未知 key 原样透传（新增 `figure-pick-session.keys.test.ts` 钉住这条契约）。30 key × 9 语。**✅ `U7d` omics 面板已收官**（本提交）：面板 10 处 + 启动器 10 处 + 共享层 23 处入字典，**43 key × 9 语**；共享层改为「注入 `t` + 自带 `fill` 插值」并新增 `omics-translate.ts` 适配器，agent 面向的 `describeFullRunHandoff`/`describeFullRunProposal` 定为**固定英文**。**`U7e` 待拍板**（图形数字化 CSV 审计头语言，见拍板表） |
| U8              | **收官（`1b890b3`）**     | ✅ **首帧假空**：`HomePage.tsx` 现在消费 `project-store` 的 `isLoaded`——项目列表在首帧后一个 IPC 往返才到，原先那一帧直接渲染空态，等于对有项目的用户说「你还没有项目」。新增加载行（`home.loadingProjects`），并把「失败但无 message」的情况从 store 里的英文散文 `'Unknown error'` 改为 **key 跨界 + `isProjectLoadErrorKey()` 守卫**（传输层原始报文仍原样透传）。✅ **批量复核了同形的另外三个 store**：`specialist-store`（`SpecialistsPanel:1203`、`SpecialistSubmenu:158` 均已消费 `isLoaded`）、`compute-store`（`ComputePanel:230` 已消费）、`settings-store`（`main.tsx:22` 已消费）——**都已正确**，不是「计划里写的两处」。✅ **新发现的第三处**：`RemoteJobBadge` 的 `allJobs.length === 0 → return null` 把「这个会话真的没有作业」与「作业列表还没被读过」渲染成同一种「看不见」——而全仓**没有任何地方调用 `hydrate()`**（只有 `WorkspaceMessageScroller:409` 会调），所以该会话一旦不在滚动器里，有运行中作业也永远不显示徽标。改为**徽标自取数据**（同 `SpecialistSubmenu` 的做法），并顺手把它的 5 处硬编码英文（`{n} running · {elapsed}`、`{n} jobs`、`REMOTE · {n}`、两条 aria）入字典。7 key × 9 语。新增回归用例分别钉住「首帧不是空态」与「徽标自己读 feed」。侧栏空分组已随 U5 完成                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |     |

### 批次 1 发布记录（v1.70.0）

| 项         | 值                                                                                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本提交   | `e108fe3`（含验收与立案）· `c5702a7`（迁移缺陷归因）                                                                                                                                                |
| U8 提交    | `1b890b3` — `Windows Full Test` run `35843365543` = **success**（head `1b890b328`）                                                                                                                 |
| Release    | https://github.com/naiyixi/PureScience/releases/tag/v1.70.0 — `draft=false`，`published=2026-09-23T10:35:04Z`                                                                                       |
| 资产       | `zerolink-purescience-1.70.0-mac-arm64.dmg` **296874950** bytes · `sha256 a006076c7e54d2098a609ceb286e819ae2b3d852c00c7b6143a78eb250e754d7` · `version.json` · `.dmg.blockmap`（三个均 `uploaded`） |
| 客户端清单 | `releases/latest/download/version.json` 远端返回 `version=1.70.0`，`size`/`sha256` 与本地构建**逐字节一致**                                                                                         |
| 最新标记   | `gh release list` → **Latest = v1.70.0**                                                                                                                                                            |

**发布过程中踩到的坑（值得记）**：`npm run build:mac` **没有**设 `NODE_OPTIONS=--max-old-space-size`（`build:e2e` 有），而本机 8GB、发布前空闲内存只剩约 115MB → `electron-vite build` 以 `Abort trap: 6`（V8 fatal）崩溃，并且**构建先清空 `out/`**，于是后续真机 e2e 读到「页面不存在」（`net::ERR_FILE_NOT_FOUND`），一度看起来像 e2e 本身坏了。对策：跑发布前 `launchctl unload com.totota.purescience`（KeepAlive 的 headless 实例会占内存），并用 `NODE_OPTIONS=--max-old-space-size=8192 scripts/publish-release.sh <version>`；上传 297MB 到 GitHub 耗时约 21 分钟属正常（国内链路）。

### 批次 1 验收（真机，v1.70.0）

新增 `e2e/empty-library.spec.ts`——**空库首屏走查**，用 fixture 的全新 storage root 跑真构建（无种子数据、无 mock store），一条用例走完 8 个表面：

| #   | 表面                     | 真机断言的句子                                                                                                                   |
| --- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 首页项目列表             | `No projects yet. Create one to get started.`，且加载行 `[data-testid="home-projects-loading"]` **不残留**                       |
| 2   | 首页最近会话             | `Sessions you start will appear here.`                                                                                           |
| 3   | 命令面板（还没有项目）   | `Create a project to search sessions and artifacts.`                                                                             |
| 4   | 设置 → 权限              | `No permission decisions remembered yet`                                                                                         |
| 5   | 设置 → 记忆              | `No notes yet.` + `Write the first note above and press Enter to save it.`                                                       |
| 6   | 设置 → 存储              | 非空白（要么说明「什么会占用空间」，要么列出分类）                                                                               |
| 7   | 工作台侧栏               | `No conversations yet` + `Use New above to start one, or open a project from the library.` + **动作按钮** `Start a conversation` |
| 8   | 命令面板（有项目但为空） | `Nothing to browse yet` + `Type above to search…`                                                                                |

**真机把两处书面假设纠正了**（这正是这条用例存在的理由）：

1. **命令面板有「两个」空态，不是一个**。空库（连项目都没有）走的是 `home.createProjectToSearch`（`GlobalSearchDialog.tsx` 的 `!primaryProject` 分支），U5 改的 `gs.browseEmptyTitle`/`browseEmptyHint` 要在「项目已存在、但项目里没有会话与产物」时才渲染（`GlobalSearchDialog.tsx:1256`，分支可达、非死键）。两处都是显式空态，但**它们不是同一句话**——所以断言按状态分别打，而不是一句走天下。
2. **记忆面板默认选中的是内置分类**，因此 `settings.memoryEmpty`（「左侧选一个分类」）在全新安装下**根本不会出现**；该状态下真正要说的空态是笔记列表那对 `No notes yet.` + 「在上面写第一条」。（存储面板同理留了两种合法状态，因为它可能已有几百字节。）

**证据**：`npx playwright test e2e/empty-library.spec.ts` → **1 passed (8.0s)**；同批 `e2e/accessibility.spec.ts` **4/4 passed**；全量 e2e 套件在本提交前跑过（见提交信息）。跑之前 `launchctl unload com.totota.purescience` 并 `npm run build:e2e`，收尾 `load` 回。

### 立案：数据根迁移被环境清单拖住（既有缺陷，非本批引入）

**现象**：`e2e/certification/storage-migration.spec.ts` 在真机构建上稳定失败——`api.storage.migrate()` 返回

```
{ ok: false, error: 'Could not verify provenance data: Notebook Environment manifest checksum mismatch: ab688d61…' }
```

**已核实（不是猜的）**：

1. **可稳定复现**：单跑该 spec 两次都失败（同一句错误）。
2. **不是本批引入**：把批次 1 的全部改动 stash 掉、`git checkout 9dfc986`（v1.69.0 发布提交）后 `npm run build:e2e` 重跑，**同样失败**。因此也与本次版本号变更无关。
3. **失败点在 `migrate` 的第一道校验**：`migration-service.ts:423` 先校验**源数据根**（`deps.currentDataRoot`），`provenance-migration-validation.ts:151-166` 取运行记录里的 `environmentManifestChecksum`，先确认 `runtime/provenance/environment-manifests/<checksum>.json` 在目录清单里，再对该文件重新求哈希；两者不一致即抛错。报的是 `mismatch` 而不是 `unavailable`，说明**同名文件存在**，但**它的字节哈希不等于它的文件名**。
4. **写入端看起来是自洽的**：清单目录只有 `environment-state-tracker.ts` 一个写入者（`grep` 全仓 `environment-manifests` 的非测试命中仅 4 处：校验器 2 处、迁移目录常量 1 处、tracker 1 处），两处写清单都是「先 `JSON.stringify(..., null, 2) + '\n'` 求哈希、再把**同一字符串**写盘」，且 `writeImmutable`（`:1367`）是 utf8 原子写。所以字节与文件名之间**不应**出现分歧——分歧需要再定位。

**影响面（按代码判定，不是推测用户场景）**：任何数据根里存在 Notebook 环境清单、且运行记录引用了它的用户，`storage.migrate()` 会在**源根校验**这一步就返回失败——即**换数据根整个走不通**，与 GUI 入口无关。

**根因（已用一次性探针定位，证据可复现）**：

1. **校验器读的不是 e2e 的隔离根，而是开发者真实数据根 `~/PureScience-DEV`**。探针把各根整份拷出后：临时根顶层是 `claude / opencode / sessions / runtime-support / purescience.db / settings.json`，**没有 `runtime/`、也没有 `notebooks/`**——源侧那条路径根本不可能抛出这句话；而引用该 checksum 的运行记录实际在 `~/PureScience-DEV/notebooks/<project>/<session>/run.json`（正是校验器遍历的那个路径布局）。配置根由 fixture 固定为临时目录（DB 与 `sessions/` 在那边），**数据根没有被固定**，`settings.json` 里也没有 `dataRoot` 键，于是回落到默认的 dev 数据根。
2. **那个文件确实存在，但「文件名 ≠ 自身哈希」**：`~/PureScience-DEV/runtime/provenance/environment-manifests/ab688d61….json`，94,722 字节，`captureKind: "completed-run"`，捕获时间 `2026-09-17T07:50:47Z`，实际 sha256 是 `6fcc9b55…`。即**文件名由一个序列化算出、写进盘的是另一个**——正是 `environment-state-tracker.ts:885-890` 注释里记的那次「两个摘要」修复之前的旧写入者留下的产物。
3. **全量量化**：该目录 1071 个清单，**1070 个自洽，只有这 1 个**自相矛盾（写于 `2026-09-17T15:50:47`）。一个陈旧的坏文件，就足以让整个数据根**永远无法迁移**。

**结论与影响面**：校验器按契约 fail-closed（文件名必须等于字节哈希）本身没错，问题在于 ① **app 自己的旧版本产出过它今天拒绝搬动的数据**，② 没有检测/修复路径，③ 错误信息不指名项目/会话，也不说明这是陈旧遗留产物。修法（未开工，待定）：把「名字自相矛盾」的清单识别为**陈旧证据**（报 warn 并在结果里列出，而不是 block），或提供隔离/修复入口；错误信息至少要给出 `project/session` 与文件路径。

**另一处独立问题（同一次定位中发现）**：`e2e/certification/*.spec.ts` **没有隔离数据根**——它们会读写开发者真实数据根。这解释了「本机红、CI 绿」（CI 上没有这份遗留数据），也意味着这些 spec 在本机运行时可能**真的搬动/删除开发者的数据**（本例中 `migrate` 因校验失败才没走完）。修法：fixture 在临时根里写入 `settings.dataRoot`，让认证 spec 真正跑在隔离根上。

**每处空态的验收口径**：说得清「为什么空」+ 给得出「下一步点哪」；新增文案必须 9 语齐备（`translation-quality.test.ts` 会拦 en/zh 不对齐、zh 未翻译、zh-Hant 简体字、占位符不成对），被取代的旧 key 要一并删除，避免留下零调用点的死键。

### U7d ✅ 收官：omics 面板的句子归位（两条判定 + 一个适配器）

**消费者判定（动手前做的第一件事）**：`src/shared/omics-preview.ts` / `omics-full-run.ts` 的句子生产者**只有渲染层一个消费者**——全仓 `rg` 无主进程/CLI 引用（`src/main` 里的 omics 命中是无关的 connector 描述）。所以「不能像 store 那样发 key」这个担心不成立，真正的问题是**共享层不该放词**。

**第 1 条判定：按听众分流，不是按文件分流**

| 听众                                                                                    | 文本             | 处理                                                                         |
| --------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------- |
| **用户**（面板渲染的 scope 标签、摘要、提案的 reason/deliverable/labels/missing/notes） | 会随语言变       | 入字典：共享层只给 **key + 变量**，`t` 由渲染层注入                          |
| **agent / 日志 / 交接**（`describeFullRunHandoff`、`describeFullRunProposal`）          | **不该随语言变** | **固定英文**（原来是中文——对 agent 是指令、对 9 语用户是读不懂，两边都不对） |

后者是本轮新立的口径：**给 agent 读的指令文本不本地化**，否则同一份 manifest 在不同语言环境下会被以不同措辞执行，行为不可复现。

**第 2 条判定：注入 `t`，不是改返回形状**

立案时给了两条路（结构化返回 / 注入 `t`）。选了**注入 `t`**，理由是句子形状太多（scope 三分支 × 摘要四段 × 提案六字段 × 列表分隔符随语言变），结构化返回会把「怎么成句」的判断搬回组件，等于把 `shared` 的规则摊到 UI 里。实现形态：

- `src/shared/omics-preview.ts` 导出 `type OmicsTranslate = (key: string) => string`，并自带 `fill(template, vars)` 做占位符替换——**插值发生在共享层**，所以「不插值的 fallback 字典」也能渲染出完整句子（这正是前两波踩过的坑）。
- **分隔符也入字典**：`omics.missingLabel` / `omics.labelsLabel` 作为前缀键，列表用 `; ` 连接；不再硬编码中文顿号/分号。
- **适配器单点收口**：`src/renderer/src/components/omics/omics-translate.ts` 的 `asOmicsTranslate(t)` 是共享签名与渲染层 `Translate` 之间唯一的桥——共享层保持零渲染依赖，字典仍受类型检查。

**验收**：面板 10 处 + 启动器 10 处 + 共享层 23 处全部入字典，**43 key × 9 语**；共享层测试改为注入真 `en` 字典的 `t`，断言读的正是用户看到的英文句子（`OmicsPreviewPanel.render.test.tsx`、`OmicsPreviewLauncher.render.test.tsx`、`omics-preview.test.ts`、`omics-full-run.test.ts` 的中文断言全部改英文）。**安全性语气未弱化**：`omics.provisionalWarning` 仍是「不得作为最终结论交付」，`omics.selectHostFirst` 仍要求「如实说明未计算、不得用预览数值替代」。

**i18n 质量门又拦下两处**：zh「该文件」被判机翻腔标记词（→「这个文件」）；fr `variants` 与英文同形（→ `variantes`）。
