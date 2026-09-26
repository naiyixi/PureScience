# 入口层与交互层优化排期（2026-09-23）

依据：`docs/evidence/2026-09-23-entry-layer-coverage-audit.md`（四轴审计 + 五脚本复跑）。
口径：**一批 = 一个版本边界**；批次内的每个单元独立走「实现 → 相关簇绿 → 双 typecheck + eslint → 提交 → 推送 → 盯 CI → 进下一单元」，批次走完再走完整发版流程（CHANGELOG + 双语 README 横幅 + 全量门禁 + tag + Release）。

每条验收都是**实机可验**（真入口、真执行、真数据）；单元测试只作回归网，不作完成证据。

## 排期总览

| 批次 | 版本    | 主题                            | 单元数 | 交付重心                                                                                   |
| ---- | ------- | ------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| 0    | v1.69.0 | 键盘闭环必修                    | 4      | 消除「按键进黑洞」与「无路可退」的浮层                                                     |
| 1    | v1.70.0 | 三态成套 + 文案归位             | 4      | 不再有「空白且无解释」的面板                                                               |
| 2    | v1.71.0 | 半截功能补齐（有 A→B 没有 B→A） | 5      | 已建能力的管理动作闭环                                                                     |
| 3    | v1.72.0 | 体验真实差距 + 可发现性         | 5      | **✅ 已完成**：U14–U18 全部落地并逐项真机验收                                              |
| 4    | v1.73.0 | 拍板项落地（建入口或归档）      | 6      | 把「已备未建」清成有结论的状态                                                             |
| 5    | v1.74.0 | 防复发门禁                      | 2      | 让这类缺口不能再悄悄长出来（U25/U26 **已落地**，双向验收实跑；守卫自查出 U27/U28，已立案） |

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

**收口（2026-09-23）**：U9–U13 全部完成，`package.json` 已置 **1.71.0**。五项入口各自带「优于有个入口」的差异化（U9 空合集分态、U10 来源三态 + 按规范路径删除、U11 活值开合、U12 mode/origin/verdict 不合并 + 字节级比对、U13 继续与恢复语义分写并实测通过 27.5s）。本批另修三处产品缺陷（守卫无人写恢复记录、继续不先重挂、清状态过早抹掉恢复记录）+ 一处夹具问题（消息 id 随进程重置）、迁移隔离与报错点名、无障碍字面量。门禁：typecheck 0、eslint 0、全量单测 14275 passed（1078 文件）、认证 e2e **串行** 15/15 全绿。

| 单元 | 内容                                                                                                                                                                                                                                                                                     | 验收                                                                                                                                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U9   | ✅ **收官** 文献合集删/移出（`references:delete-collection`、`references:remove-from-collection`）——后端与 preload 早已就绪，渲染层**零调用点**，合集只增不减；现已接上删除（两步确认，明说「条目仍留在库里」）、移出、选中空合集的专属空态，并修掉同行里反向硬编码的中文 `title="删除"` | 建合集 → 加入 → 移出 → 删除全程可点，删空后可再建同名 —— **真机 1 passed (6.1s)**，jsdom 4 用例                                                                                                                     |
| U10  | 运行时扫描/选择/注销（`runtime:survey` `:20`、`set-selection` `:35`、`unregister-interpreter` `:83`）                                                                                                                                                                                    | **✅ 已收官**：面板可「用作笔记本运行时」（写 `setSelection`，返回的 survey 立即回填）＋「当前运行时」徽标 ＋ `survey` 载入 ＋ 注销；真机 `e2e/certification/runtime-selection.spec.ts` 1 passed                    |
| U11  | ✅ **收官** 会话包导出（`sessions:export-package`）                                                                                                                                                                                                                                      | 导出→本机导入回环成功，包内清单与界面一致                                                                                                                                                                           |
| U12  | ✅ **收官** GUI 版本重放（`artifacts:replay-version`）                                                                                                                                                                                                                                   | 逐字段一致（**真机 1 passed (14.5s)**）：基准＝远端任务 API 调用的同一条命令返回，窗内渲染的每个值（verdict／mode／origin／环境锁／执行行／逐文件字节偏移与字节数／reasons 原串）都被断言要出现；带环境锁与结果对比 |
| U13  | ⏳ **半落**：界面已接、单测 6 绿；真机 e2e 未通（卡在本机残留 dev 实例，见落地记录）继续被打断的回合（`acp:continue-interrupted-turn`）                                                                                                                                                  | 强制退出后重启，能续跑同一回合；与 Resume 的语义差别在界面上写清                                                                                                                                                    |

### U10 落地记录（真机带出的三件事）

1. **候选来源必须是一等数据**。真机探针显示：注册 `/opt/homebrew/bin/python3` 前后列表**毫无变化**——PATH 扫描本来就发现它，手工目录与系统扫描被 `defaultCandidatePaths` 合并成一个无标签的列表。因此「注销」若按原设计挂在每张 `user-own` 卡片上就是空壳入口（点得动、什么都没发生）。已引入 `RuntimeRegistration = 'catalog' | 'system' | 'both'`（`shared/notebook-runtime.ts`），发现层按来源打标（`environment-discovery.ts` 的 `catalogued` / `scanned` 两个集合），UI 只在 `'catalog'` 上提供注销——那是唯一点下去真的会消失的一类。
2. **注销曾按字符串精确匹配**：面板传 `env.envId`（发现层的 `realpath`），而目录里存的是用户当初选的那串路径。macOS 上 `/var` → `/private/var`、解释器是符号链接时两者不同，于是注销**静默落空**、解释器赖在候选里。已在 `notebook-runtime-settings.ts:removeManualInterpreter` 改为**按规范路径等价删除**（`canonicalInterpreterPath`，容忍已不存在的陈旧条目），并补了一条用符号链接别名的单测。
3. **数据根隔离缺陷的第二处表面**：隔离实例的 `listEnvironments` 列出的是 `~/PureScience-DEV/runtime/envs/*`（含 app-managed 与 agent-created 真实环境）——与迁移失败同源（见上文迁移缺陷段）。U10 的真机 spec 因此改用 `python -m venv --copies` 造一个只可能来自手工目录的临时解释器（默认 venv 会把解释器符号链接到 Homebrew，按 realpath 归并成 `both`，测不出注销）。

### U11 落地记录（导出→导入回环）

1. **补的是哪半截**：`sessions:export-package` 在 preload 已有、渲染层零调用——桌面能读别人发来的包（导入对话框），却做不出自己的包，会话只进不出。新增 `SessionPackageExportDialog`（`src/renderer/src/pages/workspace/`）：模式二选一（仅要点＝对话/引用/复核结论/验证；全部＝再加会话文件、参考文献 PDF、环境锁与复现产物）、成功态给出文件名与大小并逐条列出 `notes`（已知 code 映射成句并带 `{detail}`／`{count}`，未知 code 原样显示）、4 条具名失败、**保存面板被关掉不当失败**（直接关闭）。入口在会话菜单里紧挨文本导出，desktop 与移动两处都接了线。
2. **真机带出的缺陷（已修，属批次 0 主题）**：`ExportConversationDialog` 用 `useRetainedDialogValue` 的返回值决定 `open`，于是 **Cancel／Escape／关闭按钮都调用 `onClose` 却关不掉面板**——真机证据：导出对话框 Cancel 后 `data-state="open"` 仍在屏上。同类写法在仓内是少数派（`DataRootMissingDialog`/`UpdateDialog` 用活值开门），已改成 `open={Boolean(session)}`，并补了一条「清空 session 后面板真的消失」的回归用例——**该用例在坏形式上会红**（已用回退验证），此前套件只断言 `onClose` 被调用过，所以一直没抓到。
3. **真机验收口径（如实说明）**：保存面板是 OS 对话框，Playwright 驱动不了。UI 侧验到「菜单入口→对话框打开→模式可选→Cancel 关闭」；回环本身用同一批通道跑真字节：导出到磁盘（Node 侧核对存在、字节数与返回一致、`PK` 头）→ `previewPackage` 判定 `accepted` 且 `assertion = {origin:'source-party', locallyVerified:false}`、`mode='full'`、`messages ≥ 2` → `importPackage` 后新会话确实出现在会话表里。
4. **CI 首红原因（记在 U10 名下）**：`RuntimesPanel` 被 onboarding 的笔记本步骤复用，而 `onboarding-test-utils.ts` 的 `runtime` stub 没有 `survey` → `window.api.runtime.survey is not a function`，败在 `NotebookStep.render.test.tsx`。已补 stub（onboarding 簇 7 文件 / 81 用例绿）。教训：改共享面板的数据需求时，簇必须覆盖**所有挂载它的界面**，不只它自己所在的目录。

### U12 落地记录（重放：同一命令、两种读者、逐字段对得上）

1. **补的是哪半截**：`artifacts:replay-version` 在 preload 已暴露、渲染层**零调用点**；而远端任务 API 早在调它（`src/main/web-service/task-api.ts:188-192`，注释明确「调的必须是窗口调的那条命令，不许有第二份实现」）。于是同一台机器上，agent 能重放、窗口不能——溯源面板只列版本、不给重跑。新增 `ArtifactReplaySection.tsx`（`src/renderer/src/pages/workspace/`）挂成 `ArtifactProvenancePanel` 的 **Replay** 页签。
2. **按需触发，不在切页时自动跑**：重放是**真执行**（不是读记录），所以只在按「运行重放」时发请求——切到该页签不会偷偷跑一遍配方。
3. **两句话必须分开说**（沿用 `shared/replay-verification.ts` 的口径）：`mode: 're-run'` 是「现算一遍」、`'record-integrity'` 是「核对记录里的字节」，两者结论不能合并成一句；`origin: executed` 与 `reconstructed` 也各自标注。`stopped`（无配方／版本读不出／未配置）只报具名原因，**不冒充 verdict**。比对结果给到字节级：`第 N 字节不一致（记录 A 字节，重放 B 字节）`；`not-comparable` 给具名理由（无摘要／太大不比对／他版本记录／此类产物不比对）。环境锁 applied/not-applied、`environmentManifestChecksum`、执行行 `via X · 退出码 N · N ms`（含 timeout 与 stderr 尾）都单列。
4. **真机验收怎么做的**：`e2e/certification/artifact-replay.spec.ts` —— 用伪造 agent 产出溯源产物，**先按远端路径调同一条命令取基准**，再让窗口从「产物卡片 → 预览 → 溯源入口 → Replay 页签 → 运行重放」走一遍，断言基准里的每个值都出现在渲染结果里（比对的是**值**，不是两本字典比长短）。真机实况：该产物的重放判定是 `unverifiable`、`mode: re-run`、`origin: executed`、`environmentLock: not-applied`、`execution: {via: 'notebook:python', exitCode: 1, durationMs: 560}`、stderr 里是真实的 `SyntaxError: invalid syntax`（记录的配方按 notebook python 重跑确实跑不通）——**如实显示跑不通**，而不是伪造一个「复现成功」。
5. **真机带出的入口事实（写下来，免得下个单元重新踩）**：① 产物在答复里的卡片名是 `Preview generated file <name>`，与 Files 视图行同名；② 溯源入口**只有在全屏预览时**才是尾部按钮（`Open Provenance for <name>`），普通预览里是「File actions for <title>」菜单的第一项（`PreviewPanel.tsx:788` 按 `isFullScreenOpen` 分流）；③ 面板页签是 `role="tab"`，不是 button。
6. **i18n**：`ws.replay.*` 35 key × 9 语；de 的页签名原与英文同字（`Replay`）→ 改为 `Wiederholung` 才过 en≠de 门禁。

### U13 落地记录（继续被打断的回合：界面已接，真机卡在一个实测问题上）

1. **补的是哪半截**：`acp:continue-interrupted-turn` 在 preload 已暴露、渲染层**零调用点**；中断横幅只给一个 Resume，而 Resume 是渲染层自己把那条消息**重新发一遍**（`useWorkspaceAgentRuntime` 里 remove + 重新提交），不是把同一个回合交给 agent 接着跑。
2. **已接的界面**：`SessionInterruptedBanner` 新增「继续这一回合」，调 `window.api.acp.continueInterruptedTurn({projectId, sessionId, promptMessageId})`（`promptMessageId` 取自导出的 `findInterruptedUserTurn`，即「最后一条没有成功回复的用户消息」），成功后 `markResumed` 清中断态。**两个动作的差别写在横幅上**（`data-testid="session-interrupted-hints"`）：继续＝从那一步接着跑、消息与附件还是原来那条、已在跑不会起第二次；恢复＝把这条消息重新发一遍、算新回合。飞行中两个按钮互斥禁用；没有可续回合时继续按钮禁用并明说原因；续跑失败显示具名原因。i18n 6 key × 9 语；横幅套件 3 → **6 passed**；typecheck 0。
3. **真机未通（实测两轮，不是猜测）**：
   - 第一轮（跨重启）：假 agent 先流一段半成品再永不作答，随后 `app.restart()`（走 Electron 自己的 close，属优雅退出）。重启后 `api.sessions.loadAll()` **返回 0 个会话**、首页 Recent sessions 为空、横幅不出现——「回合没写完就退出」在这条路径上什么也没留下。**结论：跨重启不是正确的验证形状**。
   - **两处更正（都在 2026-09-23 晚实测推翻）**：
     - 上面「不重启也中断」那条**作废**：换了干净的运行后，同样的在飞回合跑了 **120 秒仍是 `Session status: Running`**——应用不会自己在运行期把回合标成中断。横幅只有在该会话被恢复成中断态时才出现。
     - 上面「重启后 0 个会话」那条**也作废**：它是在**窗口 bug** 下测的。`completeOnboarding()` 与 `configureFakeAgent()` 各自**返回它们留下的那个窗口**，而当时 spec 仍握着 reload 前的旧窗口，于是整个运行在 onboarding 阶段就以 `Target page, context or browser has been closed` 死掉，数据来自一个已经关掉的实例——**这条测量不算数，必须重测**。旁证：同一个仓里另一条 spec（`artifact-replay`）按惯例写 `page = await ...` 重新赋值，13.1s 通过；环境本身没问题。
   - 卡点已从「环境」改判为「spec 自身」，窗口 bug 已修（`page = await completeOnboarding()` / `page = await configureFakeAgent()`），spec 改为**重启形状**并标 `test.fixme`，等下一轮按正确形状重测。**U13 的真机验收仍未完成**，但下一步是明确的、可执行的。
4. **仍然成立的部分**：横幅本身、IPC 调用形状、main 侧 `continueInterruptedTurn` 的幂等（已在跑则原样返回快照）都由单测与 main 侧测试覆盖；缺的是端到端那一半。

## 批次 3（v1.72.0）体验真实差距 + 可发现性

| 单元 | 内容                                                                          | 验收                                                                           |
| ---- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| U14  | PDF 表格改走几何法（`pdf:tables`），保留审计标签与扫描范围空态                | 同一真表格 PDF，UI 与 agent 都得 4 列、表头与数值同列                          |
| U15  | 图形拾取键盘化（`FigurePickOverlay.tsx:131`、`SelectionAnnotator.tsx:68` 等） | 纯键盘完成打点/锚点标定并导出 CSV                                              |
| U16  | **✅ 完成**（真机 `1 passed`）：预览头部工具栏，与右键同一份动作集            | 下载/存产物/数字化/表格抽取/文献导入均有工具栏或命令面入口，右键仍可用         |
| U17  | **✅ 完成**（真机 `1 passed`）：命令面 + 快捷键清单面 + 设置搜索扩到关键词    | ⌘K 能搜到命令；设置搜「镜像/mirror/代理」命中；`Cmd+,` 与 `Cmd+W` 在界面上可见 |
| U18  | **✅ 完成**（真机 `1 passed`）：会话级入口，不要求已有评审                    | 无评审记录时也能主动打开清单页签，并给出「还没有评审」的解释                   |

### 批次 3 进行中记录

**U16 ✅ 完成（真机 `1 passed (9.7s)`）— 预览动作升为一等入口**：

- **缺口**：文件的能力（数字化、PDF 表格抽取、PDF 文献导入、下载、存为产物、复制路径）**只挂在右键菜单**上，界面上没有任何提示说这个文件能做什么——预览头部只有全屏/关闭/下载/更多。读者要么猜，要么永远不知道。媒体类型门控（`DIGITIZABLE_MEDIA`/`OMICS_DATA_MEDIA`/`PDF_TABLE_MEDIA`）写成菜单组件内的私有常量，谁想再加一个入口都得复制一遍。
- **做法**：把动作集抽成**纯模块** `previews/preview-content-actions.ts`（谓词 + `buildPreviewContentActions(name, handlers)` → `{ id, labelKey, testId, Icon, run }[]`，媒体门控与顺序都在这里），右键菜单与**新的预览工具栏**都从它渲染——单一来源，两个面不可能给出不同的动作集；工具栏因而不需要单独判断媒体类型，只按列表渲染。
- **入口**：`PreviewFileSurface` 头部新增 `contentActions` 槽（`role="toolbar"` + `data-testid="preview-toolbar"`，每个动作一个 `preview-toolbar-<id>` 按钮，`aria-label` 与 tooltip 同源），`PreviewFilePanel` 用与右键同一批 handler 构建列表（表格抽取/文献导入仍按 `window.api` 能力在场与否决定是否出现，与菜单的门控一致）。
- **测试**：`preview-content-actions.test.ts` 6（顺序、媒体门控、能力缺失即不出现、每个动作真的调用自己的 handler）· `PreviewFileSurface.test.tsx` +2（工具栏渲染与命名、无动作时不渲染工具栏）· 真机 `e2e/certification/preview-toolbar.spec.ts` 1——**用工具栏抽表并断言与右键菜单一致**（4×4 同值），证明两个面是同一份动作而不是两套实现，并复核右键仍可用。
- 9 语 +1 键（`previewSurface.toolbar`）。

**U18 ✅ 完成（真机 `1 passed (7.6s)`）— 上下文门控入口**：

- **缺口**：检查清单 / 折叠上下文都是**会话级**的（不需要评审行），但两个入口（`WorkspaceMessageScroller:288`、`ArtifactProvenancePanel:786`）都要求**已有评审**，所以「这个会话还没有评审」= 这条能力完全够不着。代码里甚至已经写着注释 `fall back to the newest when the item carries no reviewId (e.g. a session-level entry point)` —— 那个 entry point 当时并不存在（又一处名不副实）。
- **补的入口**：`SessionInfoCard` 新增「Verification checklist」（`session-info-open-review`），不要求已有评审；`SessionInfoCard` 的 `onOpenReview` 由 `ConversationPanel` 接线到 `upsertAndActivateItem(createSessionReviewerPreviewItem({ sessionId, findingId: undefined, locator: undefined }))`，`SessionReviewerPreviewInput.reviewId` 改为可选（工具项 id 仍是 `tool:<sessionId>:reviewer`，与「从某条 finding 进入」复用同一个页签）。
- **空态按「说清是哪种空 + 给下一步」**：无评审时面板显式说明「本会话还没有评审记录；下面的检查清单与折叠上下文不需要评审也能用」，并把**折叠上下文**标签一并放出来（此前无评审分支只有清单一个标签）。
- **顺带修掉一个真缺陷**：`reviewStore.getChecklist()` 的空态每次返回**新对象**，而它是被 zustand selector 读取的 → 快照永不相等 → 清单面板挂载即 `Maximum update depth exceeded`。改为按会话缓存空对象。**这条路径正是本次新入口会放大的那条**（新入口让「还没加载出清单」成为常见态）。定位教训：`=> state.getX(...)` 这类**方法调用式 selector** 不在我先前「返回对象/数组的选择器」扫描（`=> ({` / `=> [`）的覆盖范围内——扫描口径要含方法调用。
- **测试**：`PreviewToolContent.no-review.test.tsx` 2（标签集 + 说明 + 切到折叠上下文）· `SessionInfoCard.render.test.tsx` +1（入口存在、点击回报并关闭）· `review-store.test.ts` +1（空清单对象身份稳定，修前必红）· 9 语 +2 键（`sessionInfo.review` / `reviewer.noReviewsYet`）· 真机 `e2e/certification/reviewer-session-entry.spec.ts` 1。

**U17 ✅ 完成（真机 `1 passed (8.5s)`）— 可发现性基建四件**：

- **命令面**：⌘K 的宿主就是 `GlobalSearchDialog`（此前 1520 行里只有搜索源，注释却自称 command palette）→ 新增「命令」这一组，目录做成纯数据模块 `components/global-search/palette-commands.ts`（打开设置 / 网络与镜像 / 运行环境 / 模型与供应商 / 计算主机 / 存储与数据根 / 智能体 / 快捷键清单）。命中规则：**标签命中优先于关键词命中**，关键词覆盖 `mirror/镜像/代理/registry/npm/host/算力` 等用户真会输入的词；键盘走位与渲染顺序一致，回车与点击共用同一条执行路径。
- **⌘K 打不开面板的真因**：不在 `App.tsx` 的门控串，而是 `SettingsPage` 里一条无条件的 ⌘K 监听抢先 `preventDefault`（详见下节）。
- **快捷键清单面**：新增 `components/KeyboardShortcutsDialog.tsx`，只列**真实存在**的弦（⌘K / ⌘, / ⌘W 三级阶梯 / ↑↓ / ↵ / esc），修饰键按 `window.api.platform` 显示，从命令面可达。
- **设置搜索扩到关键词**：19 个面板各带 `keywords` 并抽出纯函数 `matchesSettingsQuery`；搜「镜像 / mirror / 代理」命中网络与运行环境面板。
- **顺带**：面板页脚原有 4 个硬编码英文（navigate/open/mention/close）入 9 语；三处快捷键门控补上新对话框的排除，避免在清单面上再开一层。
- **测试**：命令目录 5（含「每条命令必须真的执行一个动作」——防空壳入口）· 快捷键面 2 · 面板集成 1（输入 mirror → 命令行 → 点击真的把 store 指向网络面板）· 设置搜索 3 · 设置 ⌘K 所有权 1 · 真机认证 1。

**U14 ✅ 完成（真机 `1 passed (10.7s)`，提交 `640b22d`）**

- 表格面板改走与 agent 同一条 `pdf:tables` 几何通道；`html` 也由主进程产出，三种导出与 agent 逐字节一致；审计标签（`verify-against-source`）与扫描范围空态保留；`pdf.table.capped` 取代 `pdf.table.truncated`（9 语）。认证用例 `e2e/certification/pdf-table-extraction.spec.ts`。
- **真缺陷（已修）**：面板拿到的 `item.path` 是产物的**版本定位符**（`artifact-version:<projectId>/<appSessionId>/<artifactId>/<versionId>`，`src/shared/artifact-provenance.ts:116`），而 `pdf:open` 当路径用 → 用户点「提取表格」必然 ENOENT。修法：`pdf-service.ts` 新增 `resolveSessionArtifactPath` 注入点与 `resolveInputPath`（定位符交解析器、其余走原路径），`open/tables/figures` 统一走它并在落盘记 `sourceSessionId`；`main/ipc.ts` 注入**仓内已有**的 `resolveSessionArtifactFilePath`；`pdf-ipc.ts`/preload/类型带可选 `sessionId`；面板与 `PreviewPanel` 传下去。单测 +2（`pdf-service.test.ts`）、面板 +1。
- 环境事实：**文字落在 MediaBox 之外 pdfjs 完全读不到**（夹具 y=700 > 页高 600 → 0 候选；移进框内立刻得 4 列）。排障时 vitest 只在失败时回显 `console.log`。

**U15 图形拾取键盘化（实现 + 单测完成；真机用例已写，复跑待确认）**

- `FigurePickOverlay` 拥有自己的游标：方向键 ±1px、Shift ±10px、Enter/空格打点、Backspace/Delete 撤点、Home 收回；**点击与键盘共用同一条打点路径**（`placePoint`）；拾取面 `tabIndex` + 焦点环 + `aria-describedby` + 坐标播报行。2 key × 9 语。
- 计划点名的 `SelectionAnnotator.tsx:68` 复核结论：它是选中文字时渲染的**原生 `<button>`（带可见文案）** → 键盘本就可达，**归档**（附证据）。
- **顺带抓住两个真缺陷（均已修）**：
  1. **数字化导出静默**：`PreviewPanel` 的 `onExport` 原为 `void navigator.clipboard.writeText(csv)`，失败被吞。现在 `onExport` 可 reject，成功显示 `CSV 已复制 · N 行`（`figure.exported`），失败显示 `figure.exportFailed`（含原因）；编辑后自动作废上次导出状态。2 key × 9 语。
  2. **剪贴板在打包态全坏（系统性）**：`src/main/windows.ts:82-85` 的加固 `setPermissionCheckHandler(() => false)` 把 Chromium 权限一律拒掉（含 `clipboard-write`）→ 渲染层 **20+ 处复制按钮**在打包应用里全部静默失败（含 U14 面板的 copy）。修法：新增 `src/main/clipboard-ipc.ts`（`clipboard:write-text` → 主进程 `clipboard.writeText`，不涉权限）→ 合同目录/preload/`renderer-api.d.ts` → 渲染层单点 `src/renderer/src/lib/copy-text.ts`（无 bridge 时回落 `navigator.clipboard`，故既有 jsdom 测试仍有效）→ 全部调用点迁移，含把可用性守卫 `!navigator.clipboard` 改为 `!window.api?.clipboard`。
- 真机用例 `e2e/certification/figure-keyboard-picking.spec.ts`：预览右键 → 数字化 → **纯键盘**标定两轴、打点、导出，并断言导出成功的状态行。首跑即用它抓到上面的剪贴板缺陷。

**U7e ✅ 拍板 A（单一稳定英文）已落地**

- `src/shared/figure-to-data.ts`（来源行/提取方式/标定分辨率/状态/注意事项 + `auditDigitizationForUse` 的四条拒绝原因）与 `src/shared/figure-pick-session.ts`（`# audit: passed` / `# audit: unusable`）改为英文；`formatDigitizationProvenance` 只喂 CSV、不上屏（已核）。
- 四处中文断言同步：`figure-to-data.test.ts`、`figure-pick-session.test.ts`、`FigurePickOverlay.render.test.tsx`、`FigureDigitizePanel.render.test.tsx`；迁移脚本以「零 CJK 残留」自检收尾。

**v1.71.0 Release 失败与更正（必须保留）**

- `build / Build macos-arm64` 失败 → Release 无页无资产。CI 日志：认证 e2e `artifact-replay.spec.ts:43` 让渲染层抛 **React #185（无限更新循环）**，被 `RendererFailureGate` 判失败。
- **更正**：批次 2 门禁里同一条用例的失败曾判为「并行 worker 假红」——结论不完整，该用例确有渲染层问题。
- 本地（全新构建）复现出**另一个**真缺陷并已修：`artifacts:replay-version` → `ENOTEMPTY: rmdir …/replay-*/data`（递归 rm 与刚被叫停的内核写入竞态，Node `maxRetries` 默认 0）→ `replay-composition.ts` 的移除加 `maxRetries: 5 / retryDelay: 100`。该用例 `1 passed (12.5s)`、整套认证 e2e 串行 **16 passed (2.8m)**、本地零次 "185"（提交 `e139676`；Windows 全测 **success**，Nightly 进行中）。
- **未确认项 → 已确认（2026-09-23 深夜）**：`e139676` 的 **Nightly 结论 = failure**，失败 job 仍是 `build / Build macos-arm64`（job id `107255993753`）：`artifact-replay.spec.ts`「the remote command returns」失败（**15 passed / 1 failed (7.1m)**，两次 retry 均失败 → 不是抖动），日志里 `RendererFailureGate` 抓到 `Renderer pageerror: Minified React error #185`。**结论：ENOTEMPTY 修复（`e139676`）没有消解 #185**，二者是两个独立缺陷。**v1.71.0 需重打 tag**，且**批次 3 的发布门禁会被这个 job 卡住**，必须在批次 3 收尾前修掉。

- **#185 复现方法（2026-09-24，已跑通）**：CI 用的是**打包产物**——`build.yml:356`「Run P0 Electron certification」以 `PURESCIENCE_E2E_EXECUTABLE=<打包可执行文件>` 跑 `npm run test:e2e:p0`。照 CI 的未签名方式本地打包即可复现：
  `unset CSC_LINK CSC_KEY_PASSWORD; export CSC_IDENTITY_AUTO_DISCOVERY=false; npx electron-builder --mac --arm64 --dir -c.dmg.sign=false --publish never`，再 `PURESCIENCE_E2E_EXECUTABLE="$PWD/dist/mac-arm64/PureScience.app/Contents/MacOS/PureScience" npx playwright test e2e/certification/artifact-replay.spec.ts --workers=1`。`out/`（非打包）版同用例 12.5s 通过。
- **三个环境坑（都已实测）**：① 有实例在跑（launchagent 或残留）时打包版**秒退**——它占着 web 服务端口/单实例锁，跑前必须 `launchctl unload` 并确认 `pgrep -f PureScience` 为 0；② 夹具 `app` fixture 自带 **180s** 上限，`--timeout` 覆盖不了；③ **trace.zip 与 JSON reporter 都不含** pageerror 的栈（已在 `e2e/fixtures/renderer-failure-gate.ts` 临时加写文件打印，待回滚）。
- **已排除的假设（各有证据）**：`useSyncExternalStore` 快照不缓存（全渲染层仅一处 `useHandoffLifecycleEvents.ts:31`，其 `getEvents()` 返回 Map 内缓存数组 `handoff-lifecycle-source.ts:82`；CI 日志亦无该警告）；渲染层 `isPackaged` 分支（`src/renderer|preload|shared` 零命中）；effect 调不稳定回调 prop / 依赖里含内联对象（静态扫描零命中）；**"只是跑得久"**（`out/` 版加 120 秒静置的探针用例 `1 passed (2.2m)` → 时间本身不触发）；主进程两处打包分支（`windows.ts:382` 只改 dev 标题后缀、`storage-root.ts:25-45` 打包态优先用 E2E root，均无害）；**更新源文件**（`--dir` 产物里根本没有 `app-update.yml`，而没有它时那次复现**通过**，故更新器目前既不能定罪也不能排除）。
- **现象是间歇的**：同一打包产物有时抛 minified #185、有时渲染层**直接卡死到 180s 超时**（无 pageerror）、有时**通过（37.4s）**。CI 上"两次 retry 都失败"说明在更慢的 runner 上更容易越过 React 的更新深度门槛——与"异步自喂循环在慢环境里连成同步 burst"一致；**每次实验必须把"这次是否真的触发"作为读数，不能把一次通过当排除**。
- **#185 结案（2026-09-24，CI 全绿核验）**：`build / Build macos-arm64` 在 `b8e4036` 上 **success**——Nightly run `35921904594` 全绿、四平台全 success、`publish` success；`v1.71.0` 重打 tag 后 Release run `35925237489` 成功，Release 页 `published 22:16`、资产全平台齐（mac arm64/x64 dmg+zip+blockmap、linux AppImage+deb、win setup.exe+zip、`SHA256SUMS.txt`、`RELEASE-CERTIFICATION.json`）。
  根因是**三层叠加**，每一层都由 CI 单独证伪/证实：
  1. **每次写入都造新对象** ⇒ 任何通知都触发全体消费者重渲染（`notebook-env-store` 的 `applyUi`/`applyLang`/`applyRecoveryBlocks`）→ 改为**引用稳定**：值不变则返回原 state，zustand 不通知（`97d351f`）。
  2. **每收一帧 progress 就整读一次权威 status 并写回**（provisioner 每帧广播一次 tick）→ 改为**只在落定（done/error）时重读**，progress 本身已携带横幅所需信息（`2937bbc`）。
  3. **flush 用微任务**：微任务会落进 React **恢复被挂起渲染**的中途（Suspense 以 promise 续体恢复），React 把"渲染期调度"计为**嵌套更新**，50 次即 #185 → flush 改**定时器（宏任务）**，宏任务无法与渲染交错（`b8e4036`）。
     **定位工具链（可复用）**：性能线用「写风暴探针 + 闸门把 `error.stack` 带进失败消息」拿到渲染层原始栈（trace.zip 与 JSON reporter 都不含 pageerror 栈）；React 开发版构建（`define: {'process.env.NODE_ENV': '"development"'}`）确认了错误是**从 Electron IPC 消息监听器逃出**（`wrappedListener ← emit ← onMessage`），而 `#185` 是**提交期守卫**，因此不会有组件栈——不要再用"让 dev 版点名组件"这条路。
     **排除项（各有证据）**：不稳定选择器（脚本扫描渲染层返回新对象/数组的选择器 **0 个**、`useShallow` **0 处**）、`useSyncExternalStore` 快照不缓存（渲染层仅 `useHandoffLifecycleEvents.ts:31`，其源返回缓存数组）、渲染层 `isPackaged` 分支（零命中）、主进程打包分支（无害）、更新器（渲染层零消费点）。
     **纪律**：一次通过不算排除（间歇性）；失败栈必须带**完整同步链**才动手。

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

### 批次 4 进行中记录

**U19 ✅ 完成（真机 `1 passed (8.5s)`）— PDF 目录与图表升为可见入口**

- **缺口**：`pdf:outline` 与 `pdf:figures` 自 PDF 阅读器落地起**在渲染层零调用点**（`grep 'api\.pdf\.' src/renderer/src` 当时 0 命中），于是读者看不到论文有目录，也事先不知道哪几页有图。`pdf-ipc.ts:1-2` 的注释自陈 "used by future UI"——即本单元。
- **做法**：新增 `components/pdf/PdfExplorePanel.tsx`，读**与 agent 同一条通道**（`pdf.open` → `outline` + `figures`，并发取），渲染文档自身的书签树（按文档层级缩进、附自身页码）与按页分组的图表（尺寸、图注、`captionSource: none` 时明说、逐条 warnings）。不作跳跃导航：本仓没有页视图面，书签行就是结构信息而不是一个点了没反应的按钮。
- **如实交代扫描范围**：扫描页数、因过小被丢弃的处数（`skippedSmall`）、文档未配图注的张数（`withoutCaption`）都显示；空图列表**必须与扫描页数同时出现**，禁止单摆一个空列表。
- **入口**：`pdfExplore` 进 U16 的单一来源动作集（`PDF_DOCUMENT_MEDIA` 门控 + `window.api.pdf.outline` 能力在场判断），右键菜单与工具栏同时获得，宿主与表格面板同构。
- **测试**：`preview-content-actions.test.ts`（含 PDF-only 与「能力缺失即不出现」）· `PdfExplorePanel.render.test.tsx` 5（文档自身页码 / 层级缩进 / 无图注明说 / 空列表带扫描页数 / 通道缺失说不可用）· 真机 `e2e/certification/pdf-structure-panel.spec.ts` 1。

**U20 ✅ 完成（图核验建入口；宿主 SQL 按 P-b 默认建议归档 agent-only，待你追认）**

- **缺口**：`figure:review`（发表级正确性清单，七条规则：#1 排除行不得混入汇总、#2 轴/系列标签与密度、#3 同类别同色且调色板可辨、#4 图形类型贴合数据形状、#5 渲染并目视、#6 对数轴刻度合理性、#7 图与脚本双产物 + 最小字号）只有 agent 的工具能跑。
- **做法**：新增 `components/figure/FigureReviewPanel.tsx`。规则引擎要的是**申报**，所以面板只放读者从图上能看见的字段（图形类型、数据结构四选、系列数、标签数、最小字号、对数轴刻度、是否已渲染、图/脚本路径），**未申报的字段不发**（引擎按未申报处理），并在界面上写明「排除行是否混入汇总统计只能由出图方申报，此处报『无违规』不覆盖该规则」——不让「绿」被读成「数据已核」。
- **入口**：`figureReview` 进同一动作集（`DIGITIZABLE_MEDIA` 门控 + `window.api.figure.review` 在场判断）。
- **真机 + CI 双证**：`e2e/certification/figure-review-panel.spec.ts` 本地 `1 passed (10.8s)`；`73ac7a6` 的 Nightly `35991771501` 与 Windows Full Test `35991770935` 双绿（macos-arm64 打包认证同绿）。两处修法值得记住：规则 id 必须取共享常量 `FIGURE_RULE_COLOR_THREADING`（下划线形态，我按习惯写成连字符导致定位不到），两次运行之间只留**一个**变量（系列数），其余申报逐字相同。
- **同批修掉一个真缺陷（认证门先发现的）**：`useManagedPreviewResource` 的两处 release 是裸 fire-and-forget，主进程重新组合命令分组时没有该 handler，rejection 被 PDF 缩略图的 catch 打成渲染层 `console.error`，把当时在跑的 `pdf-figure-extraction` 拖红（上一轮绿色 run 的同一 job 日志里该字样 0 命中 ⇒ 新出现）。改为 `releaseQuietly`（释放尽力而为），带回归「release 拒绝时不产生 unhandledRejection」。
- **测试**：`FigureReviewPanel.render.test.tsx` 4（**请求断言**：只发读者给的值、`excludedRows`/`summaryUsedExcluded`/路径一律 undefined；引擎 findings 带自身 rule/severity；clean 只覆盖已申报；通道缺失说不可用）· 真机 `e2e/certification/figure-review-panel.spec.ts`（9 系列 → `color-threading`/error；2 系列 + 已渲染 → 同引擎 clean）；9 语 +23 键。
- **待办**：真机跑一次（等放行）；宿主 SQL `query:run` 的归档结论待你追认后落审计文档。

**U21 已落地、待真机（入口 + 阻塞原因已实现并单测；真机用例待跑）— 笔记本「运行这一格」**

- **缺口**：`notebook:run-cell` 及单元格级三件（`begin/append/finish-code-cell`）在渲染层**零调用点**（`grep 'api.notebook.'` 只有 state/inspectVariables/execute/restart/shutdown）——agent 写下的格子一旦过期（界面上已有的 `notebookStale` 徽标就是那个信号）是死路：能力在，入口不在。
- **做法**：每条运行记录行右侧加「运行这一格」，走同一条 `notebook:run-cell`，`source: 'user'`（记录行随即出现 `you` 徽标），并带上该 run **实际运行的环境**（python/r 的 `default-*` 或具名 env；repl/bash 不发该字段）。运行结果以一行回执说明（引擎自己的 status），并刷新笔记本状态。
- **阻塞不再「点了没反应」**：逐格判定并显示原因——整本有一次运行在飞、agent 正在往这一格写代码（**只挡那一格**，邻格照常）、环境尚未准备好（供给门）。
- **测试**：`NotebookPreview.rerun.render.test.tsx` 7 条（载荷逐字段、只重跑被点那格、三种阻塞原因各自可见且点击不发出调用、结果回执）· i18n 门禁 42 passed · 9 语 +5 键。
- **未完成的部分（不标 ✅）**：真机用例未跑（本轮第三次触发终端守卫、未获响应）。真机跑通前不计入完成。

**U21 真机取证完成（2026-09-24）**：新增 `e2e/certification/notebook-rerun.spec.ts`，本地真机 **9.6s 通过**。
取证过程本身抓出一个更大的缺口（见下 U31）——没有它，U21 的控件在运行的应用里根本不可达。

**U22 结论修正：迁移已回退（新面在 main 里从未安装）— 立案 U29**

- **原计划（P-d 默认建议）**：把 UI 迁到 `handoff-lifecycle:list/:changed/:retry`（新面）、删旧面 retry。**按此实现并推送 `fa7dfb5`，随后被 CI 证伪。**
- **CI 证据**：`fa7dfb5` → Nightly `35997046852` **failure**（`build / Build macos-arm64`），**16 条认证用例全红**，根因原文：
  `[renderer pageerror] Error invoking remote method 'handoff-lifecycle:list': Error: No handler registered for 'handoff-lifecycle:list'`
- **真根因（比错误文案更深）**：`registerHandoffLifecycleIpcHandlers`（`src/main/agents/handoff-lifecycle-ipc.ts:25`）**只出现在它自己的模块与它自己的单测里**——主进程从未调用；`HandoffLifecycleCoordinator`（`src/main/agents/handoff-lifecycle.ts:26`）也**没有任何 `new` 调用点**。生产实际安装的是**旧面**：`src/main/ipc.ts:910` 的 `registerCompletionHandoffIpcHandlers(completionHandoffLifecycle)` 装了 `specialist:get-handoff-events` / `retry-handoff` / `cancel-handoff`，且 `ipc.ts:911-914` 把 `completionHandoffLifecycle` 传给闸门。⇒ 新面是一套**声明齐备、从未安装**的平行实现（合同清单与 preload 都有，main 没有），我把它当成了正本。
- **处置**：**回退**这次渲染层迁移，让窗口回到真正在跑的面；不把「迁 UI」建成半截新面（那正是禁止的空壳）。
- **立案 U29**：把新面接成生产生命周期（用 `HandoffLifecycleCoordinator` 替换/桥接 `CompletionHandoffLifecycle`：注册 IPC、`onChange` 广播 `handoff-lifecycle:changed`、补事件形状转换），完成并拿到真机证据后再迁 UI。
- **U25 守卫的能力边界（必须记住）**：入口守卫只保证**窗口有调用点**，**不保证主进程安装了该面**——本轮就栽在这条边界上。要覆盖需解析主进程的常量间接引用（`SPECIALIST_IPC.X` 这类），立案 U30。

**U23 归档（零代码收口，逐条结论）— P-e 默认建议**

| 项                                                           | 渲染层调用点                                               | 结论与依据                                                                                                                                                                                    |
| ------------------------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compute` 三件（启用主机直读 / 任务标记已消费 / 待通知任务） | 面板已覆盖主机 CRUD、详情、任务事件、审批卡                | **归档**：审计自身对这三处的定级是 P2，且 `ComputePanel` / `ComputeHostDetail` / `ComputeApprovalDialog` + `compute-store.ts` 已承载用户实际操作；余下属「直读/已读」细粒度读回，不构成缺入口 |
| `local-fs:reveal`                                            | **0**                                                      | **归档**：同类意图已有 `localFs.openPath`（`LocalFileHeaderActions.tsx:46`）；reveal 是更细粒度的同意图变体，面窄低值                                                                         |
| `remote-access:disable`                                      | **0**（面板走 `detect`/`getSnapshot`/`approve`/`setMode`） | **归档**：已被 `remoteAccess.setMode({ mode: 'off' })` 覆盖（`RemoteControlPanel.tsx:304`）                                                                                                   |
| `storage:validate-data-root`                                 | **0**                                                      | **归档**：保留为 host/agent 命令（`host-application-commands.ts:284`、`storage/ipc.ts:27`）；数据根设置走设置保存路径，未发现需要用户单独触发校验的场景                                       |
| `settings:get-package-mirror`                                | **0**                                                      | **归档**：镜像经设置快照下发（`settings-store.ts:113/173/193`），无需单独面                                                                                                                   |
| `settings:xai-oauth-*`                                       | **已有 UI**                                                | **归档（已覆盖）**：`ProvidersPanel.tsx:182/183/198` 已用 start/complete/logout 三件，本就不是缺口                                                                                            |
| `specialist:cancel-handoff`                                  | **0**                                                      | **归档**：交接失败的重试/继续由**生产面** `specialist:retry-handoff` 承载（`ipc.ts:910` 安装）；cancel 无窗口意图。新面 `handoff-lifecycle:*` 未安装，见 U22                                  |

**U24 归档（零代码收口）— P-e 默认建议**

- `acp:event` / `acp:permission-request`：渲染层 **0** 命中（`onEvent` / `onPermissionRequest` 亦 0）；权限请求在渲染层由 `permission-grants-store`（`permissions.list/revoke`）与会话状态 `waiting-permission` 承载，主进程仍按 `application-events.ts:37-38` 广播。**归档**为兼容/观测通道（删除会波及 agent 事件面，收益不抵风险）。

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

### 本批次实测发现的待办（归入 U17）—— **已定位并修复**

- **搜索按钮上印着 `⌘K`，按键打不开面板** —— **根因不在 `App.tsx` 的门控串**（那条串本身是对的），而在 `SettingsPage.tsx:411` 的全局监听：它匹配**正好 ⌘K**（`event.key.toLowerCase() !== 'k'` + `metaKey/ctrlKey`）并 `preventDefault()` 去聚焦设置搜索框，注释写着「Settings search owns Cmd/Ctrl+K **while the dialog is open**」，**代码却是 `useEffect(..., [])` 且没有 `open` 判断** —— 于是设置页在任何状态下都抢走 ⌘K，App 的 `toggleGlobalSearch` 第一项 `event.defaultPrevented` 直接返回，命令面板永远收不到这个键。
- **定位过程（可复用）**：临时真机探针分别用 (a) 真实按键、(b) `GLOBAL_SEARCH_OPEN_EVENT` 事件、(c) 在 `body`/`window` 上派发的合成 `KeyboardEvent` 三条路径对打 —— 事件路径能开、合成事件在 `window` **冒泡**阶段被 `prevented=true`（捕获阶段未拦），于是排除「面板本身/门控条件/焦点在编辑器」，锁到「window 冒泡阶段的监听器抢先 preventDefault」。全仓 `!== 'k'` 一处即中。
- **修复**：`SettingsPage.tsx` 的监听按 `open` 门控（`if (!open) return` + deps `[open]`）——设置打开时它仍是 ⌘K 的唯一消费者（App 侧本来就排除 `isSettingsOpen`），设置关闭时 ⌘K 归还给命令面板。
- **回归锁**：`SettingsPage.render.test.tsx` 新增「settings 关闭时不得消费 ⌘K」（断言 `defaultPrevented === false`，修前必红）；`e2e/certification/palette-commands.spec.ts` 真机覆盖 ⌘K→命令→落到设置→设置打开时 ⌘K 不再在背后开面板，以及快捷键面上的 `Cmd+,`/`Cmd+W`。
- **教训**：注释与依赖数组不一致的「名不副实」监听是最难查的一类门控缺陷——它让外层门控的 `defaultPrevented` 分支静默吞键，而所有既有测试都不拥有这个键的所有权断言。

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

## 2026-09-23 收尾记录（迁移缺陷按建议执行 + U13 干净实测 + 一处无障碍缺陷）

### 迁移缺陷：按建议执行（1a 隔离 + 1b 点名）

- **1a 根因坐实**：`e2e/fixtures/electron-app.ts` 只在 `PURESCIENCE_E2E_EXECUTABLE` 存在时才设 `PURESCIENCE_E2E_STORAGE_ROOT`，而数据根是从它派生的（`src/main/storage-root.ts`：`defaultDataParent()` 先读 E2E 根、否则回落 `app.getPath('home')`）。因此**开发态跑 e2e 时数据根是开发者真实 `~/PureScience-DEV`**，配置根才是隔离的——这就是「本机红、CI 绿」的机制，也解释了隔离实例里为何能列出真实 `~/PureScience-DEV/runtime/envs/*`（U10 探针同形第二处）。**改动**：夹具对每次运行都设 `PURESCIENCE_E2E_STORAGE_ROOT`（不再只针对打包认证）。
- **1b 落点与改法**：`src/main/storage/provenance-migration-validation.ts:164` 原文只报 `Notebook Environment manifest checksum mismatch: <checksum>`，不说差在哪。改为**仍 fail-closed**，但点名条目与双方摘要：清单相对路径、磁盘实际摘要、以及引用它的 notebook run 与 `项目/会话`；上层 `migration-service.ts:423` 会把它拼成 `Could not verify provenance data: …` 呈现给用户，因此用户能看见该修哪一条。
- **验证**：`provenance-migration-validation.test.ts` + `migration-service.test.ts` **96 passed**；typecheck 0；eslint 0。

### U13：干净条件下的第四次实测（结论变了）

- 重启成功、项目可打开，但工作区会话列表显示 **`No conversations yet`**（快照原文）。
- 结论：**唯一那个"永不结束"的回合没被持久化**——会话要有已完成的回合才会被写下来。因此本夹具的造法（只发一次、那一发就一直挂着）**测不到横幅**，不是应用的问题。可续回合的真实可达路径是：会话已有一个完成回合 → 之后的某个回合被打断。
- 下一步（未做）：夹具改成"第一发正常作答、第二发挂住"，spec 相应发两次。

### 无障碍缺陷（顺手修，实机快照抓到）

- `src/renderer/src/pages/workspace/ConversationPanel.tsx:1191` 写成 `aria-label="{t('workspace.sendMessage')} options"`——**引号让 `t()` 从未求值**，模板字面量原样进了无障碍树（快照里可见 `group "{t('workspace.sendMessage'')} options"`）。改为新增 `workspace.sendOptions`（9 语）并直接求值。
- **验证**：i18n **47 passed**；typecheck 0；eslint 0。

### U13：第五次实测（本轮自伤 + 一个可复用的结构事实）

- 夹具已能造出**有完成回合的会话**（第一节答完并落盘，会话行显示 `Session status: Error Answer this turn before the interruption.`），第二发也进了会话——但 `Cancel run` 未出现。
- 原因**在本轮的自伤**：我把「这一轮故意挂着」的记忆放进 `PURESCIENCE_FAKE_AGENT_STATE`，而**假 agent 拿不到应用的环境变量**——它的后端是用**配置里的 env** spawn 的（`src/main/acp/agent-connection-adapter.ts:179`），不是 `agent-process.ts:154` 那条继承 `process.env` 的路径。缺少该变量时我写的守卫直接抛错，于是第二发被应用记成 Error。
- 已撤掉该守卫与那个变量；`interruptedTurnMarker` 现在**没有路径也不报错**，退化为进程内计数（够用在「运行内」形状，不够用在「跨重启」形状）。
- **可复用结构事实**：给假 agent 传状态，必须走**它真正收到的通道**（配置 env／cwd），不能走应用的环境变量。

### U13：第七/八次实测 —— **横幅已在真机触达**（U13 的真机缺口从"够不着"变成"被主进程拒绝"）

- 夹具现在能造出这条路径：第一节**答完**（落盘）→ 第二节**挂住**并留下半截回答（会话里显示 `Part of the answer arrived before the app went down.` + `Failed`）→ **回合在飞时重启**。
- 为此先修了两件基础设施：
  - **`restart()` 必须有界**：`close()` 原本是无界的 `await application.close()`，回合一在飞就永久挂住（实测 284s 后测试超时）。现改为「优雅 10s → 强杀 10s」，与清理路径同一套预算。
  - **挂起记忆不能按会话 id 命名**：假 agent 的会话 id 每次运行都一样（`e2e-session-1`），失败一轮留下的标记会让下一轮**不挂而直接作答**（实测）。spec 现在**开跑前清理**残留标记；标记也改为答完即自删。
- **真机结果（快照原文）**：会话行 `Session status: Error Answer this turn before the interruption.`；横幅 `Session was interrupted before the app closed.` + `Continue turn` 与 `Resume session` 并列 + 语义差别整句写在界面上（`Continue picks the turn up where it stopped: … · Resume sends this message again as a new turn.`）+ 失败时**具名报错**。
- **剩余缺口（唯一一条）**：主进程拒绝继续 —— `Error invoking remote method 'acp:continue-interrupted-turn': Error: Resume no longer matches the interrupted turn on the active Conversation Branch.`
  - 渲染层→preload→主进程的接线**已通**（报错是具名的，正是 U12/U13 的契约）；
  - 下一步是读 `src/main/acp/interrupted-turn-continuation.ts` 的匹配逻辑：是比对错了消息，还是"半截回答"被当成了回答——**不猜，读代码**。
- **另需注意**：真机跑的是构建产物，本次源码里的 i18n 标签修复（`workspace.sendOptions`）**必须先 `npm run build:e2e` 才会进真机**；快照里仍见到旧的 `group "{t('workspace.sendMessage')} options"` 即为构建陈旧所致。

### U13：第九次实测 —— **修掉一个"永远不可能满足"的守卫**，拒绝理由前移

- **发现（全仓 grep 级证据）**：`resumeRecovery.kind === 'resume-required'` 这个前置条件，全仓**只有类型定义**（`src/shared/session-persistence.ts:202`）与**要求它的守卫**（`src/main/acp/interrupted-turn-continuation.ts:48`）两处，**没有任何代码写它** → 该守卫恒真拒绝 → **"继续这一回合"这个动作对任何用户都不可能成功**。这正是本轮审计要抓的「有入口、有实现、但路径不通」。
- **修法（按"在哪里第一次知道回合被打断"落点）**：在 `normalizeSessionAfterRestore` 里、把中断会话恢复成可重试错误的那一支，**写入** `resumeRecovery: { cause: 'app-restart', kind: 'resume-required', promptMessageId }`；`promptMessageId` 取"最后一条没有完成回复的 user 消息"，与渲染层 `findInterruptedUserTurn` **同一条规则**（主侧不能引用渲染层模块，故按同规则各自实现，并在注释里写明）。
- **验证**：`session-persistence.test.ts` **39 passed**（新增两例：中断会话命名被打断的那条消息；最后一回合已答完则不记录）；typecheck 0；eslint 0；`build:e2e` 成功。
- **真机结果（快照原文，拒绝理由变了）**：
  - 修复前：`Resume no longer matches the interrupted turn on the active Conversation Branch.`（守卫恒拒）
  - 修复后：`The turn could not be continued: … acp:continue-interrupted-turn: Error: ACP session not found: e2e-session-1`（`src/main/acp/prompt-turn-workflow.ts:219`）
    → 说明**守卫已通过、继续流程真的往前走了**，现在缺的是重启后那条 ACP 会话本身。
- **下一处的读法（不猜）**：假 agent 声明 `loadSession: false` 且实现了 `session/resume`；而应用侧同时有 `:219` 与 `:200`（`after force-load`）两条分支。到底该由应用在重启后先 resume/重建会话，还是夹具该声明可装载 —— **下一步是给假 agent 记录它收到的 ACP 方法序列**，看应用究竟调没调 resume。
- **同机顺带确认**：重建后无障碍修复已生效 —— 输入区 group 的标签从 `{t('workspace.sendMessage')} options` 变为 **`Send options`** ✓。

### U13：第十次实测 —— **「继续」缺少重挂会话那一步**（假 agent 请求日志为证）

- 给假 agent 加了「它收到的每个请求」日志（写到临时目录固定路径，因为 agent 收不到应用的环境变量；spec 每次运行前清理）。
- 实测日志（重启前那一个进程）：
  `initialize` → `session.new -> e2e-session-1` → `session.prompt e2e-session-1: <第一发>` → `session.new -> e2e-session-2` → `session.prompt e2e-session-2: <reviewer_instructions>` → `interrupted prompt … marker=false`（第二发按设计挂住）。
- **之后什么都没有**：重启后**没有新的 agent 进程**、**没有 `session.resume`**。于是 prompt 工作流里 `activeSession` 为空，抛出 `ACP session not found: e2e-session-1`（`:219` 的普通分支，不是 `:200` 的 "after force-load"）→ 说明**「继续」没有先重挂会话**，而并列的 **Resume 会**。
- 下一步的决策点（对着代码定，不猜）：重挂这一步该由**继续工作流**做，还是该由「打开会话」做（真实用户自然路径是打开会话→点继续）。
- 夹具侧同时落地：假 agent 现在对 `session/load` 显式报「不支持」并记日志（原先静默）。

### U13：第十一次实测 —— **「继续」已会重挂（界面路径实测生效）**，但继续请求静默未发出

- **渲染层修复已落地**（按代码里的合同注释：`contextReset` "仅当 session/resume 采纳了新 provider 上下文时才有" ⇒ 重挂本就该由渲染层先做）：
  - 抽出 `reattachInterruptedWorkspaceSession(runtime, sessionId)`：Resume 与 Continue 共用「重挂」这一半；Resume 仍是「重挂 + 重发」，Continue 是「重挂 + 交给主进程续」。
  - 新增 `continueInterruptedSession(sessionId)` 并导出，`WorkspacePage` 以 `onContinueSession` 接到 `ConversationPanel`；面板不再直接调 bridge（直接调就是跳过重挂的旧行为）。
  - 新消息常量 `CONTINUE_CONTEXT_RESET_MESSAGE`（`src/shared/run-error-classification.ts`）：当重挂**不得不采纳全新会话**时明确告知「只有 Resume 能带上下文重放」，而不是让 agent 在失忆状态下继续。
  - 验证：typecheck 0、eslint 0、运行时/面板/横幅/store 四套件 **293 passed**。
- **真机实测（假 agent 日志为证）**：点击「继续」→ 日志出现新进程 `initialize` + **`session.resume e2e-session-1`**（这正是界面点击触发的）→ 会话行转为 `Session status: Idle`、横幅消失（`markResumed` 生效）。
- **仍不通的地方（换了形态）**：日志止于 `session.resume`，**没有任何 continuation 提示到达 agent**；界面上**也没有任何拒绝提示**（既非第八次那条守卫拒绝，也非新加的 contextReset 分支）。也就是说主进程那条继续请求**静默返回、不发也不报**——这是与先前"被拒"不同的失败形态。
- **下一步**：给主进程 `continueInterruptedTurn` 加临时候选分支日志（或查它依赖的 live prompt / Conversation Branch 前置条件），确认它从哪一个 early return 走掉；spec 保持 fixme 挂账。

### U13：第十二次实测 —— **继续请求已完整送达 agent**（先前被拒/静默的问题解除），剩回复呈现

- **根因（探针直接测出，非推测）**：点击前后各读一次落盘会话 →
  - 点击前：`status: error`，`resumeRecovery: {cause:'app-restart', kind:'resume-required', promptMessageId:'message-…-3'}`（指向被打断的那条 user 消息 ✓）
  - 点击后：`status: idle`，**`resumeRecovery` 消失** → 主进程守卫读不到记录 → 抛错；而横幅已被清掉，**报错无处渲染**，所以表现为"静默"。
  - 即：`markResumed` 的落盘会把 `resumeRecovery` 抹掉，**次序错了**——不能在请主进程续之前清状态。
- **修复**：`reattachInterruptedWorkspaceSession` 只负责"接上"，**不再清中断状态**；它把 `frameworkId/backendId` 交回调用方，由各自在**自己的动作被接受之后**再清——Resume 接上后清（原行为不变），Continue **等继续请求返回之后再清**。
- **验证**：typecheck 0、eslint 0；运行时/面板/工作区/store 四套件 **317 passed**。
- **真机实测（第十二次，假 agent 日志为证）**：
  ```
  pid=54382 initialize
  pid=54382 session.resume e2e-session-1                                    ← 界面点击触发的重挂
  pid=54382 interrupted prompt pid=54382 marker=true at …interrupted-turn-e2e-session-1
  pid=54382 session.prompt e2e-session-1: Continue the interrupted turn from where it stopped. Do not repeat completed work or compl…
  pid=54382 session.new -> e2e-session-1                                    ← 继续之后应用又挂了一个同名 agent 会话
  ```
  即**第八次那条守卫拒绝与第十一次的静默丢弃都已解除，继续请求真正到达并驱动了 agent**。
- **仍差最后一步（已缩到"回复呈现"）**：agent 按设计回了 `The interrupted turn continued from where it stopped.`（`fake-opencode.mjs:310` 与 spec 期待同文），但会话里看不到它 → 断言（spec:171）失败。日志里续答提示之后紧跟 `session.new -> e2e-session-1`，**疑似继续之后应用又接了一个 agent 会话**，回复落到了应用不再读的会话上。
- **下一步（方法已定）**：给假 agent 的**回复**也加日志（现在只有请求日志，无法区分"agent 没答"与"答了没呈现"），据此锁定回复落在哪个会话；spec 保持 fixme 挂账。

### U13：第十三次实测 —— **agent 确实作答（正确会话、正确文本），应用没把它呈现出来**

- **诊断基建**：给假 agent 补上**回复日志**（`e2e/fixtures/fake-opencode.mjs`，回复以 `session/update` 通知发出后记一行）。此前只有请求日志，无法区分"agent 没答"与"答了没呈现"——补上后立刻分清了。
- **实测（唯一一次运行的原始日志，无推测）**：
  ```
  pid=55369 session.resume e2e-session-1                       ← 界面点击触发的重挂
  pid=55369 session.prompt e2e-session-1: Continue the interrupted turn from where it stopped. …
  pid=55369 reply -> e2e-session-1 e2e-message-1: The interrupted turn continued from where it stopped.
  pid=55369 session.new -> e2e-session-1                       ← 135ms 后应用又挂了一个同名 agent 会话
  ```
  结论：**请求已送达、已作答、会话与文本都对**；回复到达后 **135ms** 应用又为同一会话 id 建了一个新 agent 会话，回复落在那之前 → 会话里看不到 → spec:171 断言失败。
- **性质判断**：这已**不是入口层问题**（入口、重挂、送达三步都实测通过），而是**主进程续答的投递/呈现**环节（`prompt-turn-workflow.ts:155-208` 的 `activeSession`/force-load 与续答的会话所有权次序）。
- **下一步（已收窄到一处）**：查续答之后那条 `session/new` 由谁发起、以及续答的 `session/update` 在应用侧被丢弃的条件（很可能是应用在重挂/重载后会重新建会话，旧会话上的更新被忽略）。spec 保持 fixme 挂账。

### 门禁纪律：认证 e2e 必须**串行**跑（本批新立）

- 现象：`npx playwright test e2e/certification`（默认并行）在 `artifact-replay.spec.ts:43` 假红——`artifact-replay-verdict` **元素根本没渲染**（20s 超时），换过一次仍复现；而该 spec **单独跑 9.7s 通过**，整套 **`--workers=1` 串行 15/15 全绿（2.5m）**。
- 判据：**默认并行下多个 Electron 实例共享同一套临时目录/存储根，互相污染 → 假红**。与 launchagent 是否 unload 无关（两次失败时 daemon 状态不同、失败形态完全相同）。
- 规程：认证套件用 `npx playwright test e2e/certification --workers=1`；单跑与套件结果不一致时，先串行复核再判定回归。

### 批次 5 完成记录（v1.74.0）

**U25 入口守卫 — 已落地（门禁，非文档）**

- 新增 `src/shared/renderer-contract-entry-coverage.test.ts`：遍历合同清单里**桌面应用真实安装**的面（`surfaceInstallation.electron ∈ {preload, browser-native}`），每个面必须在 `src/renderer/src` 下有调用点，否则必须在登记册里。
- 登记册 `src/shared/entry-layer-archived-surfaces.ts`：23 条，每条带「决策 + 证据」，并反向校验（登记册里的路径必须仍在清单里，否则门禁红）+ 校验理由非空。
- 匹配口径：容忍写法差异（`window.api.handoff.list` / `const h = window.api?.handoff; h.list(...)` / 解构），按「同一文件同时出现 capability 与 member」判定——刻意从宽，因为这条门禁的价值是抓**新声明**的面（新面的 member 名在窗口里根本不存在）。i18n 排除规则只跳 9 本字典，不跳 `i18n/index.tsx`（它会持久化界面语言）。
- **验收（已在本地实跑）**：登记册填满 → 4 passed 绿；**故意在合同清单里注入一条没人接线的面（`handoff.notifyNobody`）→ 门禁红并点名它**；撤销 → 恢复绿。
- **守卫自己抓到的两处真缺口（非我预见）**，已立案：
  - **U27 `endpoint.approve`** — `src/main/settings/endpoint-ipc.ts:1-5` 明写这是「渲染层设置面板的面」，脚本字节的哈希锚定**必须由用户在面板里批准**，而窗口里没有任何调用点 ⇒ 批准动作无 UI。
  - **U28 窗口内查找（`window.findInPage`/`clearFind`/`onShowWindowFind`/`onFindInPageResult`/`onWindowFindAppearance`/`closeFind`）** — 桌面应用装了这套面，窗口里**没有查找栏**。

**U26 交互守卫 — 已落地（门禁）**

- 新增 `src/shared/renderer-interaction-guard.test.ts`：① 手写 `role="dialog"` 必须走共享壳（`components/ui/dialog*`），否则红；仅放行**已核验**的非模态浮层（登记理由：自持 ESC / 指针离开即关 / 焦点归还），并对放行项做反向校验（该文件必须真的还声明 dialog 角色）；② 集合面用 `length > 0` 门控且全文无空态语义 → **告警**（按排期口径不阻断）。
- 识别「声明」而非「检测」：`querySelector('[role="dialog"]')` 这类选择器字符串不算。
- **守卫抓到的第三处真缺口并已修**：`pages/settings/SpecialistsPanel.tsx` 的 ZIP 预览步骤用 `<div role="dialog" aria-modal="true">` **冒充模态**（无 ESC / 无焦点圈闭 / 无归还）——正是 U2 在别处修掉的同一类缺陷；它是流程内的一个步骤视图，故**纠正语义**为 `role="region"` + 保留标签，而不是套壳伪造模态。
- **验收（已在本地实跑）**：写入一个裸 `role="dialog"` 浮层 → 门禁红并点名该文件；删除 → 恢复绿（守卫 + 面板簇 40 passed）。

**接线**：两个守卫位于 `src/**`（vitest 默认 include），CI 的 `npm run test:coverage` 会跑 ⇒ 无需改 workflow。

**U31 笔记本面板无入口（`notebook:available` 从不触发）— 已修（真机取证时发现）**

- **怎么发现的**：U21 的真机用例第一条断言（打开笔记本面）30s 超时。DOM 快照显示右侧 `complementary: No preview content`、composer 区没有「Open notebook」按钮 —— 渲染层根本没有笔记本引用。
- **链路排查**：`window.api.notebook.onAvailable` ← `notebook:available`（合同清单 `renderer-contract-catalog.ts:219`）← `application-events.ts:41` 已声明并转发 ← `application.ts:48` 由 runtime 回调发布 ← `session-lifecycle.ts:159` 的 `notifyAvailable()` —— **该方法在主进程里零调用点**（兄弟 `notifyChanged` 在 `runtime-service.ts` 多处都有调用）。
- **触发条件**：`notifyAvailable` 此前只被 `beginCodeCell`（agent 流式**写入**单元格的路径）调用。agent 用 `bash_execute`（`executeShell`）或直接跑一格（`runCell`）时走的是**运行路径**，从不宣告 ⇒ 只要 agent 没有先流式写入一个单元格，窗口就永远不知道有笔记本，整个面板（含 U21 的「运行这一格」）都不可达。单测看不见：通道声明、preload 订阅、发布层全齐备。
- **修法**：在三条运行路径上宣告一次（`runCell` 与 `executeControl` 用 `request.source ?? 'agent'`；`executeShell` 记 `'agent'`，其调用者只有 MCP 的 `bash_execute` 与 host RPC）。语义不变：仍每会话一次、仍只对 agent 发起的会话发。
- **测试**：新增 `src/main/notebook/session-lifecycle.test.ts`（3 条）——agent 每会话一次、user 从不宣告，外加一条**源码级**断言（「行为测试看不见『少了一次调用』这类缺陷」），保证下一条运行路径不会又把宣告漏掉。

### U29 方案（把生命周期新面接成生产面）— 待开工

**问题**：`handoff-lifecycle:*` 这套面（合同清单 + preload + `handoff-lifecycle-ipc.ts` + `HandoffLifecycleCoordinator`）在生产里**从未安装**：`registerHandoffLifecycleIpcHandlers` 只出现在自己的模块与单测里，`HandoffLifecycleCoordinator` 没有任何 `new` 调用点；生产状态由 `CompletionHandoffLifecycle`（`src/main/ipc.ts:899-910`，带 `FileCompletionHandoffRepository` 持久化）持有。U22 的迁移因此必须回退。

**两条路线**：

| 方案                    | 做法                                                                                                                                                                                                                                                | 风险                                                                                                              | 取舍                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **A. 传输适配（推荐）** | 保留 `CompletionHandoffLifecycle` 作为状态所有者，新增一个**薄适配器**把它的数据搬到新面通道：`CompletionHandoffLifecycleEvent → HandoffLifecycleEvent` 形状转换、注册 `handoff-lifecycle:list/:retry`、`onChange` 广播 `handoff-lifecycle:changed` | 低：不触碰持久化与重试语义（`CompletionHandoffLifecycle` 的 777 行与 `FileCompletionHandoffRepository` 原样留用） | 解锁 UI 迁移，新旧面并存；新面成为可迁的**真面** |
| B. 整体替换             | 用 `HandoffLifecycleCoordinator` 顶替闸门生命周期                                                                                                                                                                                                   | 高：持久化（run/事件落盘）、失败恢复、`retryById/cancelById` 语义都要一并迁移                                     | 终态更干净，但必须单独立项、逐条对打             |

**推荐 A**，理由：U22 的教训是「不要在没有正本迁移方案前把窗口搬到另一套面上」；A 用最小改动让新面先成为真面，B 可以在 A 稳定后作为独立单元再评估。

**U29 验收（必须实机）**：

1. 打包应用里调用 `handoff-lifecycle:list` **不再**返回 `No handler registered`（这正是把 16 条认证用例打红的那条错误）；空态返回 `[]`。
2. 新增一条认证用例断言新面可达（真窗口，非 jsdom）。
3. 事件：一次真实交接的状态变化同时出现在旧面（现有用法）与新面（新订阅）——`onChange` 广播用确定性对打验证。
4. 单测覆盖形状转换的两个方向（含 `target: null → { kind: 'main' }`、`commitOrder` 缺失时的排序退化到 `observedAt → sequence → id`）。

**完成后**：U22 的 UI 迁移可以重做（那时的迁移才是有证据的）。

**U27 已修（`631dbd5`）**：`endpoint.approve` 由登记册转为实装（`listAll` 带 `approved`、面板待批准态 + 脚本原文 + 批准按钮、未批准时禁用启动按钮）；真机 `endpoint-approval.spec.ts` 6.7s 通过。

### U28 结案：不是缺口 —— 查找栏是独立浮层，我的审计前提错了

**此前的判断（错）**：「桌面装了 6 条 `window.*Find*` 通道（`findInPage`/`clearFind`/`closeFind`/`onFindInPageResult`/`onShowWindowFind`/`onWindowFindAppearance`），窗口零调用点 ⇒ 没有查找栏。」

**实际情况**：查找栏**存在且端到端接通**，只是它不在主窗口的 DOM 里：

| 环节                                        | 落点                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 浮层本体（自带渲染层 + JS 逻辑 + 自带测试） | `resources/find-overlay/index.html`、`findOverlay.js`（4.7 KB）、`findOverlay.test.js`                                                           |
| 创建与生命周期                              | `src/main/windows.ts:301` `createFindOverlayManager(...)`、`windows.ts:39` 入口路径                                                              |
| 触发                                        | `windows.ts:321` `before-input-event` → `isFindInPageChord`（darwin 用 ⌘F、其它平台 Ctrl+F）→ `findOverlay.open()`；ESC 关闭（`windows.ts:332`） |
| 6 条通道的消费者                            | `resources/find-overlay/findOverlay.js:20/62/93/116/117/118`（**全部**在用）                                                                     |
| 既有真机覆盖                                | `e2e/windows-window-system.spec.ts:49-60`（Windows 主机：和弦前 `findOverlayIsVisible()===false` → 后 `true`；macOS 上被平台门跳过）             |

**为什么我会判错**：U25 的守卫只扫 `src/renderer/src/**` 的 `.ts/.tsx`，而消费者是 `resources/**` 里的 `.js` ⇒ 守卫看不见 ⇒ 我把「守卫看不见」当成了「没人用」。这正是本仓另一个反复出现的形状：**测量工具的边界被当成了事实的边界**。

**本轮交付**：

1. **守卫扩容**：`renderer-contract-entry-coverage.test.ts` 现在把 `resources/find-overlay/**` 也当作渲染面扫描（`{ types/tsx }` → 可传扩展名，含 `.js`）。6 条登记项随之**移除**（反向校验通过即证明它们真被调用）。
2. **双向验收**：抽掉浮层里的一次 `api.findInPage(` → 守卫变红并点名 `window.findInPage`；恢复 → 绿。
3. **平台自适应的真机用例**：`e2e/certification/window-find-overlay.spec.ts`（新增），本地真机 **4.6s 通过**——和弦打开浮层、ESC 关闭（比既有的 Windows 用例更深：多验一步关闭）。

**顺带**：这条也把 **U30**（守卫边界）的内容补全了——守卫有**两处**盲区，不只是「不验证主进程安装侧」：
(i) 不验证主进程真的安装了该面（U22 从这条缝过去）；
(ii) 只认 `src/**` 里的消费者，看不见 `resources/**` 等仓库内非 src 渲染面（U28 的误判来源）。

### U30 结案：守卫的两处盲区都已补上

| 盲区                           | 表现                                                                                                         | 补法                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (i) 不验证主进程真的安装了该面 | U22 从这条缝过去：`handoff-lifecycle:*` 合同、preload 全齐，`registerHandoffLifecycleIpcHandlers` 却零调用点 | 新增 `src/shared/main-installation-guard.test.ts`：**从主进程入口做可达性分析**（静态 `from`、懒 `import()`、`require()` 都算），要求每个导出的 IPC 注册器在**启动路径上的模块**里被引用；import/export 语句不算引用（否则注册器能靠导出语句自证合规）。未知的登记在 `MAIN_INSTALLATION_PENDING`（当前只有 U29 那一条），反向校验要求它一旦装上就必须出列 |
| (ii) 只认 `src/**` 里的消费者  | U28 的误判来源：查找栏消费者在 `resources/find-overlay/**`                                                   | 见 U28 结案：守卫扫描面纳入该渲染面                                                                                                                                                                                                                                                                                                                       |

**验收（双向）**：抽掉 `MAIN_INSTALLATION_PENDING` 里那条 → 守卫变红并点名 `registerHandoffLifecycleIpcHandlers (main/agents/handoff-lifecycle-ipc.ts, off the boot path)`；把该注册器假装接到 `ipc.ts` → 反向校验变红（"installed again and must leave"）；恢复 → 3 passed。

**过程中修掉的两个自身缺陷（都靠先跑一遍发现）**：

- 命名匹配只认 `export const/function` ⇒ 漏掉 `const f = …` + 单独 `export { f }` 这种写法——**恰好就是它本该抓的那条**；
- 可达性解析只认静态 import ⇒ 主进程入口刻意懒加载重模块，导致 44 条误报（"off the boot path"）。解析器补上 `import()` / `require()` 后归零。

### U29 结案：窗口的 handoff 面改由生产生命周期供数（薄传输适配，按方案 A）

**做了什么**：`handoff-lifecycle:*`（`list` / `retry` / `changed`）此前有一套**从未安装**的并行实现（U22 真机红 16 条的根因），现改为由生产侧 `CompletionHandoffLifecycle` 供数：

- 新增 `src/main/agents/handoff-lifecycle-adapter.ts` —— 把所有者的事件形状转成该面的形状，转法是**全量且不臆造**的：能带过的字段带过，带不过的显式窄化，`switchReadback` 不是真 target 时**丢掉** `continuation` 而不是用 handoff 自己的 target 编一个（那就是断言记录没说的事）。
- `src/main/ipc.ts` —— 在既有注册点旁边装上新面：`list` → 所有者的 `getEvents(sessionId)` 逐条映射；`retry` → 由 `originatingTurnId` 在所有者**自己的记录**里（取最新）解析出 handoff id 再 `retryById`，解析不到就静默无操作；`changed` → 与旧面在同一回调里发，两个面看到同一份生命周期。
- `src/main/application-events.ts` —— 声明 `handoff-lifecycle:changed`（`broadcastToRenderers` 只接受声明过的通道，U31 同款机制）。
- 登记册 `MAIN_INSTALLATION_PENDING` 清空：U30 守卫的待办项出列。守卫仍是「可从启动入口到达的模块集合里必须有调用点」。

**真机证据**：`e2e/certification/handoff-seam.spec.ts` —— 打包应用里 `window.api.handoff.list(...)` 解出数组、`retry` 对无记录的回合是静默无操作（而不是 `No handler registered`）。**本地 7.4s 通过**。这就是本可以拦住 U22 的那条断言。

**真机首跑两处我自己的错**：①`app.configureFakeAgent()` **返回它导航后的页面**，我丢了返回值、在已关闭的旧句柄上 `evaluate`（`Target page, context or browser has been closed`）；②守卫脚本的 python 括号写错导致整段没跑（本身没动过文件）。

### 新立案 U32：`HandoffLifecycleCoordinator` 在生产里没有消费者

`src/main/agents/handoff-lifecycle.ts:26` 的 `HandoffLifecycleCoordinator implements CompletionGateLifecycle` —— **与 U29 不是同一个东西**（U29 是窗口面的传输，这个是完成闸门的一个实现）。非测试文件里除它自身模块**零引用**，只有 `handoff-lifecycle.integration.test.ts` / `app-handoff-runtime.integration.test.ts` 在跑它。待定：接进闸门链，或删掉。

### U32 结案：不是缺口 —— 闸门的 lifecycle 槽是双模的，协调器是「通知味」那一味的唯一实现（测试专用）

事实（逐条带路径）：

- `src/main/agents/completion-gate.ts:186-193` —— `CompletionGateLifecycle` 只要求三个钩子：`onCaptured` / `onPhase` / `onFailed`。
- 闸门用 `in` **特性检测**决定调哪一味 lifecycle：`'approve'`（:268）、`'onCaptured'`（:333）、`'capture'`（:351）、`'onPhase'`/`'onFailed'`（:376-388）。
- 生产传的是**所有者那一味**：`src/main/ipc.ts:939-942` `new CompletionGateCoordinator(completionGateRuntimeRegistry, completionHandoffLifecycle)`；而所有者 `completion-handoff-lifecycle.ts` 里 `onCaptured/onPhase/onFailed` **零命中** ⇒ 闸门的通知分支在生产中不触发。这是设计使然、不是接线漏了：阶段本来由所有者自己的记录路径写入，U29 的适配器正是从那些记录里读 `phase`。
- `HandoffLifecycleCoordinator`（`handoff-lifecycle.ts:26`）是「通知味」那一味的**唯一实现**，只在测试里构造：`handoff-lifecycle.integration.test.ts`（4 处）、`app-handoff-runtime.integration.test.ts`（2 处）、`completion-gate.test-harness.ts:146`。

**结论：不是缺口。** 一个活接口的测试专用实现——删掉会让闸门的通知分支失去唯一覆盖。按已拍板的验收口径（架构已覆盖或面窄低值可归档零代码收口）落档，不删、不改。

### 同时记一个「实测后决定不建」的守卫（避免下一轮重复踩）

想加「`ApplicationEventMap` 里声明过的通道都必须有广播点」，实测**三次都测不准**：

1. 只认字符串字面量 → 26/36 条判成「无人广播」（`broadcastToRenderers(SPECIALIST_IPC.X, …)` 这类常量调用全漏）；
2. 再把 `export const CONTAINER = { … }` 里的常量解析出来 → 仍剩 17 条：`notebook:available` 是经 **第三种原语** `events.publish('notebook:available', …)`（`src/main/notebook/application.ts:48`）发的；
3. 三种原语（`broadcastToRenderers` / `webContents.send` / `events.publish`）全算上 + 常量解析 → 仍剩 14 条，而其中 `update:status`、`session:created` 等**确实在发**——发送点常把通道当**参数**传（`send(channel, payload)`），静态扫不到。

判据本身不可静态判定 ⇒ 这类守卫会大量误报，而误报比没有守卫更糟（技能条目 14）。**故不建**，理由落档。

### U29 补证：这条面拿到的是**真数据**（不是「总能返回空数组」的空壳）

写了 `src/main/agents/handoff-lifecycle-adapter.integration.test.ts`（3 条，全过），用**生产那套组合**验证：真闸门 `CompletionGateCoordinator` + 真所有者 `CompletionHandoffLifecycle` + **文件仓库** `FileCompletionHandoffRepository`（生产用的就是它，`ipc.ts:906`）。

- **生命周期投影是「每条 handoff 一条当前状态」，不是阶段日志**：`completion-handoff-lifecycle.ts:597-607` 读仓库后 `map(phase: handoff.stage)` ⇒ 一条已继续完的 handoff 报 `continued`，不会重放它经过的每个阶段（这一点我最初的断言想错了，是测试纠正的）。窗口若需要「它经历过什么」，得另设计；当前面给的是状态 + 排序（`commitOrder → sequence → id`）。
- **待批准态真的会到窗口**：走生产入口 `onAwaitingApproval`（`:344`，AgentsService 经 `approvalLifecycle` 在权限卡出现前调用）⇒ 适配器读出 `awaiting-approval` + 真 target。
- **没有 handoff 的会话返回空数组**：不臆造。

也就是说 U29 不是「答得上但没有数据」的空壳：生产链（闸门 → 所有者 → 文件仓库 → 适配器 → 窗口）能给出真实的 phase / target / provenance 与稳定排序。

## U33（新立案）：流式期的 markdown 重渲降压

**问题（已用真机总量口径量化）**：45 轮会话的流式阶段主线程任务 **5699ms（126.6ms/轮）**，其中脚本执行 3756ms（83.5/轮）。已排除的候选：slot 级重渲（`U33` 前置的闭包稳定化已把槽位 3→1，总量差异在噪声内 ⇒ 不是大头，原因见 `docs/evidence/2026-09-25-interaction-smoothness.md`）。当前判断：大头是**流式中那一个消息自己每个片段都重新解析渲染 markdown**。

**目标**：同口径（`PERF_TURNS=45 npm run test:e2e:perf`）的 `task=…ms | per turn: task=…ms` **下降**；这是判定标准，帧指标不作为判据。

**进度**：第一步（写入侧合批）的建筑块**已落地两件** —— `streaming-text-coalescer.ts`（合批语义）+ `streaming-text-batcher.ts`（按消息管理实例、`settle`/`settleAll`/`discard`，注入式 sink，不耦合 store），共 14 条单测（不改动任何现有行为，接线前先保证合批器自身的语义：不丢字、不重排、flush 后不发第二次、flush 期间新增的片段归入下一窗）。**接线（把 delta 写入路径改为经合批器 + 完成态 flushNow）与 `PERF_TURNS=45` 对照仍待做**。
**（后记·已纠正）**：接线**已完成**——`src/renderer/src/stores/streamed-agent-text.ts` 在生产路径里 `createStreamingTextBatcher` 并调用 `batcher.append/settle/settleAll/discard`（`PERF_TURNS=45` 对照随后由 U33 系列仪器给出，表现为每轮成本逐层下降）。此前的"仍待做"是**陈旧记录**。

**候选方案（按风险从低到高）**：

1. **写入侧合批**：流式文本写入按 ~50ms 合并落库（flush 保证最终文本逐字一致、完成态立即 flush）。预期直接砍掉大部分重复渲染；风险=丢字/顺序错，必须配「最终文本逐字一致」断言 + 流式期间可观感的验证。
2. 渲染侧降频：`AgentMarkdown` 在 `isAnimating` 时按帧节流重渲（不改数据路径，风险更低，但收益上限也低）。
3. 分段增量渲染：只对新增尾部做解析（收益最大、实现最重，留作后备）。

**验收（缺一不可）**：`PERF_TURNS=45` 对照数字 + 最终文本逐字一致 + 流式期间肉眼/录像确认仍在流 + workspace 簇与认证套件里对话相关用例全绿 + **带窗口真机跑**（`launchctl unload` 前置）。

**它不属于本轮已发布的 v1.73.0**；作为独立单元排入下一版本。

### U33 接线点（已侦察，接线时直接照做）

- **写入路径**：`projectAgentMessageChunk`（`src/renderer/src/stores/session-store-run-output-helpers.ts:142`，其中 `:202`/`:222` 是 `content:` 的落点），由 `src/renderer/src/stores/session-store-run-projection-owner.ts:24` 引入、在 owner 里被 chunk 事件驱动。
- **改法**：owner 收到**纯文本** chunk 时走 `batcher.append(messageId, delta)`，由 batcher 的 `onFlush` 调既有投影落库；**非文本 chunk（工具调用/状态）必须先 `settle(messageId)` 再立即应用**，否则文本与工具的先后顺序会被打乱；回合完成/取消调 `settle(messageId)`，切会话调 `settleAll()`。
- **顺序正确性是本单元最脆的地方**：合批只能合并**相邻的纯文本**，跨事件类型的顺序必须保持。这一条要单独写断言（文本→工具→文本 三段落的最终顺序与内容）。
- **验证清单**（缺一不可）：① `PERF_TURNS=45` 总量对照（基线 `task=5699ms / 126.6ms 每轮`）；② 最终文本逐字一致（含跨事件交错那例）；③ 真机确认流式期间仍在逐字出现、无明显跳变；④ workspace 簇 + 认证套件里对话相关用例全绿。

### U33 接线的新约束（影响设计，先说清楚再动手）

读 owner 后发现拦路的一处**返回值契约**：

- `appendAgentMessageChunk(input)` 的签名是 `(input) => AppendMessageResult | undefined`（`session-store-run-projection-owner.ts:43`）——**调用方依赖这个返回值**（要拿到被追加消息的 id）。
- 若直接在 action 层做「先囤后写」，**首次 chunk 的返回值就拿不到了** ⇒ 调用方会读到 `undefined` ⇒ 静默的坏路径。

**结论：合批不能拦在 action 层**。两个可行设计（接线时二选一并写断言）：

1. **下移一层**：把合批放在 owner 里 `projectAgentMessageChunk` 的**调用点之内**（即 action 照常返回结果，但内容合并/落库按窗口延后）——注意此时返回的 message id 逻辑必须保持与现状一致。
2. **上移一层**：在事件桥（把 ACP chunk 事件转成 action 调用的那一层）做窗口化，**首帧立即透传**（保证返回值语义不变），后续同消息纯文本帧才合批；任何非文本事件（工具活动 / `finishRun` / `failRun` / 取消）先 settle 再应用。

两种都要满足的顺序断言：**文本 → 工具 → 文本** 三段落的最终顺序与内容逐字一致。

### U33 接线进度（第 3 件已落地）

**store 侧已备好合批入口**（纯增量，旧行为零变化）：

- `AppendAgentMessageChunkInput` 新增可选 `eventIds?: string[]`（缺省等价于 `[eventId]`）；
- 投影改为：**全部 id 都已记录 ⇒ 判定为已应用**（重放幂等）；追加时把 `chunkEventIds` **整批**记入 `message.eventIds`。
- 关键点：合批**必须连 eventIds 一起合**——只传最新 id 会让重放把中间那段文本再追加一次。已由 5 条单测钉住（含「整批已应用 ⇒ 不重复追加」）。

**剩下最后一步**：把 `lib/acp/workspace-events.ts:554` 那处唯一的调用点改成「文本按窗口合批 + 非文本事件前先 settle + 回合结束 settle」，然后跑 `PERF_TURNS=45` 对照（基线 `task=5699ms / 126.6ms 每轮`）与真机确认。

### U33 接线第一次实测（收益被证实，接线本身踩到截断/重发 bug ⇒ 已回退）

**收益（真机 45 轮，同一仪器口径）**

| 指标                | 基线（合批前）        | 接线后                    | 变化      |
| ------------------- | --------------------- | ------------------------- | --------- |
| 主线程 task         | 5699ms / 126.6ms 每轮 | **5184ms / 115.2ms 每轮** | **-9%**   |
| 脚本时间            | — / 83.5ms 每轮       | — / **74.1ms 每轮**       | **-11%**  |
| 流式期 >50ms 长任务 | 3–5 条                | **1 条**                  | -60%~-80% |
| 帧 p95 / 最大       | 18 / 51ms             | 18 / 51ms                 | 持平      |

⇒ **合批方向被实测证实**（写入侧降压确实吃掉了主线程任务量），这也是本轮唯一一次对「随会话长度增长的总工作量」给出可复现下降。

**但接线不可直接上线 —— 踩到真 bug**：`truncate-and-resend`（编辑重发）之后，**旧流缓冲的文本仍会落地**，把已被截断的 agent 消息复活（证据：`useWorkspaceAgentRuntime.test.ts:4759`「grows an agent bubble from streamed reply events after the truncate-and-resend」与 `useWorkspaceAgentRuntime.first-output.render.test.tsx` 各 1 条红）。

**修法（已定）**：截断/重发与 `discard`/`removeMessage` 路径上，必须 `workspaceTextBatcher.discard(streamId)` 并清掉 `bufferedChunkIds` 同步项；工具活动/`finishRun`/`failRun`/取消前的 `settleAll` 规则（本次已实现并验证有效）保留。

**处置**：接线已回退（`git checkout`），只留三件建筑块（合批器 / 批次管理器 / 整批 eventIds + 5 单测）；回退后 `lib/acp + stores` **751 passed**、工作树干净。下一次接线带上 discard 规则再测同一组数字。

### U33 第 4 件：批次宿主与截断守卫（生产侧仍未接线）

落地 `src/renderer/src/stores/streamed-agent-text.ts`：

- **批次宿主放在 stores 层**（不是 ACP 事件层），因为两侧必须对同一份缓冲达成一致：生产者（事件桥）写入，而**会话 store 自己在截断时必须丢弃**——缓冲若活过截断，就会把用户刚编辑掉的 agent 消息复活。
- 写入路径用 **sink 注入**而非 import：该模块若有消费者是 store，自己再 import store 会成环。
- `session-store-message-graph-owner.ts` 的 `truncateSessionFromMessage` 现在对被切掉的每条消息 `discardStreamedAgentText(message.streamId)`（覆盖首轮实测踩到的 truncate-and-resend bug）。
- **状态：生产侧尚未接线**（`workspace-events.ts` 未调用它），因此当前行为零变化；`lib/acp + stores` **751 passed**。

### U33 未解问题（下一轮第一件）

接线本身已实测有收益（task −9%、峰值长任务 5→1），但**接线版的测试时钟不成立**：接上之后，`workspace-events.test.ts` 里第二条 delta 的 flush **不触发**。两次探针结论：`[append] event-1 Hel` / `[flush] Hel ['event-1']` / `[append] event-2 lo` —— **第二次没有任何 flush**，且第一条的 flush 来自第二个文本分支里的 `settle`（不是定时器回调），换 `advanceTimersByTimeAsync` 无改善。⇒ 即「合批器的调度在 vitest fake timers 下不被推进」这一交互未查明（同一现象很可能也是 `useWorkspaceAgentRuntime` 两条用例红的根因之一）。

**下一轮做法**：先在单测里直接验证「`createStreamingTextBatcher` 在 fake timers 下能按时 flush」（不经过事件层），据结果二选一：修调度（例如让调度可注入、测试注入 fake 计时器）或改测试驱动方式（改用真实时钟 + 等待）。**在此之前不动 `workspace-events.ts`。**

**收窄（同轮探针）**：新增 `src/renderer/src/stores/streaming-text-batcher.fake-clock.test.ts`（3 例，全绿）证明合批器在 fake clock 下可被推进，且三种形状都成立——① 测试期创建、② 每次 append 前先 settle（照抄事件桥的调用序列）、③ **模块加载期创建**（早于 `useFakeTimers()`，即应用单例的真实形状）。⇒ **合批器与批次宿主无问题**，未解现象被压缩到「`workspace-events.ts` 的事件分支 ↔ 批次宿主」之间：下一步只需在该分支加两行探针（记录 `settle` 与 `append` 的先后与 key），即可定位为何第二条 delta 的 flush 不触发。

### U33 第二探针结论（接线第三次回退，但拿到两条硬信息）

接线后跑 `lib/acp + stores`：**755 passed / 2 failed**，两条都在 hook 层：

- `useWorkspaceAgentRuntime.test.ts` 「grows an agent bubble from streamed reply events after the truncate-and-resend」→ 断言处最后一条仍是 user 消息，agent 回复**完全没落地**（即使等待 80ms 真实时钟）。
- `useWorkspaceAgentRuntime.first-output.render.test.tsx` 「does not rearm waiting when prompt ownership and the first visible output share a snapshot」→ 同上（首屏可见输出被窗口推迟）。

而**同一个接线**下 `workspace-events.test.ts` 79/79 全绿（含两片文本合成 'Hello'、顺序、eventIds 全记）⇒ 差异在 **hook 驱动路径**（`processVisibleWorkspaceRuntimeEvents` 之类的注入式 apply），不在产品写入链。

**附带修掉一个真陷阱**（保留）：模块级单例在**同一进程内跨测试文件共享**，测试若把 `setStreamedAgentTextSink` 换成自己的 no-op 又不还原，后续文件里所有 flush 都会写进空气。现在 setter **返回上一个 sink**，测试 set/restore 成对（`streamed-agent-text.test.ts`）。这条对任何「模块级可替换依赖」都成立。

**下一轮**：在 hook 驱动的用例里接线后先 `settleAllStreamedAgentText()`（或让 hook 驱动本身在断言前关闭窗口），确认这两条转为绿；若绿 ⇒ 接线收口、跑复测；若不绿 ⇒ 说明 hook 路径还存在第二处未预期的文本入口，届时以探针定位（探针已备好写法）。

### U33 关键反证：合批接线实测**显著退步**（前提被推翻）

接线全部转绿后（`lib/acp` 237/237、stores **520**、workspace 合计 **2177 passed**、typecheck 0 error）跑 45 轮真机对照，结果与预期相反：

| 指标                | 基线（合批前）            | 接线跑绿后                 | 变化          |
| ------------------- | ------------------------- | -------------------------- | ------------- |
| 主线程 task         | 5699ms / **126.6ms 每轮** | **12554ms / 279.0ms 每轮** | **2.2× 更差** |
| 脚本时间            | 83.5ms 每轮               | **174.0ms 每轮**           | 2.1× 更差     |
| 帧 p95 / 最大       | 18 / 51ms                 | **50 / 167ms**             | 明显退化      |
| 流式期 >50ms 长任务 | 3–5 条                    | **41 / 42**                | 全面超时      |
| 打字进输入框最长    | 33ms                      | 61ms                       | 退化          |

⇒ **「减少 store 写入次数 ⇒ 降低总成本」这个前提被真机数据推翻**。合批把连续 delta 攒成较少但更大的写入，总主线程成本反而翻倍——说明流式期的成本大头**不是写入/渲染次数本身**，而是**每次落地的单次代价**（候选：落地触发的持久化 `saveSessionInOrder`、转录派生重算、或每次落地都要重解析整段累积文本）。合批让每次落地都更贵，于是更少次数的贵落地 = 更贵。

**处置**：接线第四次回退（`git checkout`），仓库保持全绿（`lib/acp + stores` **757 passed**）。保留：合批器、批次管理器、批次宿主（含截断守卫）、以及整套守卫（14 + 5 + 3 + 3 例）。**同时按验收口径判定「合批」这条路线不达标，不再重试同一形态**。

**下一轮方向（换了假设）**：先把「一次流式落地到底花在哪」量出来——在接线上加分段计时（store 写入 / 持久化 / 派生 / markdown 解析各占多少），拿到 279ms/轮 的构成再定方案。U33 的候选方案表相应更新：写入侧合批**已否决**，剩下「渲染侧按帧节流」与「增量渲染」需先有分段数据再选。

### U13 续答侦察（本轮，答案已定位到具体入口）

「回复到达后 135ms 应用又为同名会话发起 `session/new`」——**这条就是续答自己的 resume**，不是别的路径：

- `src/main/acp/handler-workflows.ts:150 resumeSession(request)` → `:170 runtime.resumeSession(request)`（ACP 客户端底层即 `session/new`，与假 agent 日志里的 `session.new` 对应）。
- 该流程内部另接 `interrupted-turn-continuation`（`handler-workflows.ts:205-206` 注入 `loadSession`；`interrupted-turn-continuation.ts:190` 读持久化会话）。
- 续答投递侧的会话查找在 `src/main/acp/prompt-turn-workflow.ts:156-157`（`activeSession(request.sessionId)`，找不到即抛）、`:198-216`（**续答过程中重取 activeSession，取不到就走各自的分支**）、`:430 activeSession()`。

⇒ **待定的那一半**：resume 之后 `activeSession(sessionId)` 指向的是**新**的会话对象，而续答回复是从**旧**会话对象发出的 update；需要确认「按会话 id 路由 update」的地方（`prompt-turn-workflow.ts:246` 传 `session: activeSession` 附近 + 渲染层按 sessionId 的归属判定）是否因为对象被替换而丢弃旧对象的更新。**下一步（唯一）**：在 `prompt-turn-workflow.ts:190-250` 打点，记录 `activeSession` 对象身份在续答前后的变化与 update 的丢弃点，然后按结果修「归属判定」而不是入口（入口已实测可用）。

### U13 ✅ 结案：真机复跑通过（该缺陷当前不可复现，非本轮修复）

- **真机证据（本轮）**：`npx playwright test e2e/certification/interrupted-turn-continuation.spec.ts --workers=1` → **1 passed (26.6s)**，其中 `:218` 断言**续答回复可见**（`CONTINUED_REPLY`）——即先前「agent 答了但应用没呈现」的缺陷当前不复现。
- **状态澄清**：spec 里**已无 `fixme`**，且本轮没有任何针对它的代码改动（构建产物来自本轮回退后的 main）。查提交史：该 spec 的续答断言由 `f0d9cef` 引入，其后 `f814707`/`1f51ac8`/`c4b5a15`/`af41a92` 是真正的修复（重挂会话、续答先挂载、中断态保留、夹具补回复日志），均已进入 **v1.71.0**（`72a33ca`）。⇒ 本排期文档「spec 保持 fixme 挂账」一句是**陈旧记录**，现予纠正：**U13 已在 v1.71.0 收口**（当时未回填结论）。
- **附带说明**：本轮侦察仍有效——`session/new` 的产生点确认为 `prompt-turn-workflow.ts:180-203` 的 force-load/reload 分支（`disconnectForReload` + `resumeAfterReload`），若将来复现同类「回复落在会话替换之前」，从这三处入手（`:156-157`/`:198-216`/`:246`）。
- **附属待办**：夹具改成「第一发正常作答、第二发挂住」以覆盖另一种时序 —— 现有 spec 已通过，故降级为**非阻塞改进项**。

### 数据根迁移 fail-closed 缺陷 —— 本轮侦察定位（未改代码）

**契约与其实现位置**

- 存储文档按**内容哈希命名**：`src/main/notebook/environment-state-tracker.ts:898-902` 注释写明「`checksum` addresses the stored document and is what readers re-hash to prove integrity」，配套 `:226 sha256()`、`:1142 inventoryChecksum()`、`:1100 targetDirectory()`（写到 `runtime/provenance/environment-inventory/<targetKey>/operations/<id>.json`）。
- 迁移前的校验：`src/main/storage/provenance-migration-validation.ts:566 validateProvenanceMigrationState`，由 `migration-service.ts:293` 在搬动前后调用。
- 旁证（同一「名字即哈希」纪律的其它落点）：`src/main/notebook/bundle-manifest.ts:64 SHA256_HEX = /^[0-9a-f]{64}$/i`（校验 manifest 的 sha256 字段）、`:107` 要求归档文件名必须是 `packArchiveFile(language, version)` 的规范名。

**缺陷本质（与排期先前记录一致）**：契约本身没错，但 ① **app 自己的旧版本曾产出过不满足该契约的文档**；② 校验器只有 fail-closed，**没有检测/修复路径**；③ 报错不指名 **项目/会话**，用户无从下手。

**修法（二选一，均已定位到落点）**

1. **降级为陈旧证据**：在 `provenance-migration-validation.ts` 把「名字 ≠ 内容哈希」这一类归为**可报告项**（warning + 在结果里逐条列出 **project/session + 文件路径**），不阻塞搬迁；真正的损坏（哈希与内容都不匹配且无法归属到已知目标）仍 fail-closed。
2. **提供隔离/修复入口**：把这类文档移入 `*.stale` 隔离区并记录，让迁移继续。

倾向 1（改动面更小、用户可感知、可加回归用例：构造一个「名≠哈希但内容完整」的文档 ⇒ 迁移应成功且结果里列出该条）。**实施需要完整门禁 + 真机验证迁移流程**，留给下一轮。

#### 更正（本轮读码后）：抱怨 ③ 已不存在，剩下的只有 ①/②

`provenance-migration-validation.ts:164-173` 的**实际代码**是：

```
const recordedDigest = await sha256File(manifestPath)
if (recordedDigest !== checksum) {
  // Fail closed either way, but name the entry and both digests: this run and the manifest it points
  // at disagree, and whoever repairs the root has to see which of the two is wrong.
  throw new Error(
    `Notebook Environment manifest checksum mismatch: ${checksum} ` +
      `(runtime/provenance/environment-manifests/${checksum}.json holds ${recordedDigest}), ` +
      `referenced by notebook run ${run.runId} in ${project.name}/${session.name}`
  )
}
```

⇒ 报错**已经**给出了：目标路径、文件实际摘要、与**引用它的 run + 项目/会话名**。先前记录的「错误不指名项目/会话」是**陈旧描述**，予以纠正。

⇒ 剩余缺陷只有：① 旧版本产出过这类名实不符的文档；② **没有修复路径，一律 fail-closed 挡住搬迁**。

**实施要点（下一轮，含 API 变更）**：`validateProvenanceMigrationState` 目前抛出即终止 ⇒ 要支持「降级为可报告项」，需把它的契约从「void / throw」改为「返回报告（含 `warnings: [{kind, project, session, runId, path, recordedDigest, expectedDigest}]`）」，由 `migration-service.ts:293` 收集并随迁移结果一起返回，最终呈现给用户；真正的损坏（无法归属到已知 run/文档者）仍 fail-closed。回归用例：构造 `名≠哈希但内容完整` 的清单 ⇒ 迁移**成功**且报告里列出该条；构造无法归属的损坏 ⇒ 仍**失败**。

#### 实施与验证记录（本轮，提交 `cd439ff`）

**已修**（`provenance-migration-validation.ts`）：

1. `collectEnvironmentManifests` 从「文件名集合」改为 **`Map<内容哈希 → 真实文件路径>`**，并对「文件名 ≠ 内容哈希」的清单输出点名告警；
2. 校验器改为**按内容哈希解析 + 用映射到的真实路径读取**（此前两步都依赖规范名 `${checksum}.json`，旧版数据必然落空）；
3. 真实损坏（引用指向的字节在任何名字下都不存在）**仍 fail-closed**。

**测试**：`provenance-migration-validation.test.ts` 新增两段——旧名字 + 内容完整 ⇒ `resolves` 且告警精确匹配 `<file> holds <contentHash>`；引用被替换为 corrupt 内容 ⇒ 仍 `rejects`。`src/main/storage` **259 passed**、`src/main/notebook` **1323 passed / 99 skipped**、typecheck 0 error、lint 0 error。

**真机（本轮）**：`e2e/certification/storage-migration.spec.ts --workers=1` → **3 passed (1.1m)**——含**本轮新增的真入口/真 UI 用例**「shows the stale-evidence note in the move dialog an older manifest would otherwise block」：侧栏 → 设置 → 存储 → 「Change location → Continue」露出目录编辑框 → 填目标 → 编辑器里的「Change location」→（会话在跑则先过「Interrupt and move」确认）→ 迁移完成后断言 `data-testid="stale-evidence-note"` **可见**、文案为「Older environment manifests were kept as-is and not re-validated.」+ 条数（`toHaveText(/not re-validated\.\s*\d+\s*$/)`）。⇒ 先前「本次修复的真机覆盖仍缺」**已补**。
**同时补的负向对照**：干净数据根（本构建自己写出）迁移后断言 `migration.staleEvidence === undefined` ⇒ 保证提示只在真有旧清单时出现，不会变成常驻文案。

**剩余（明确两项 · 均已完成 —— 本节为待办原文，结论见下）**：

1. **告警进迁移结果/UI**：现在只进日志。需把 `validateProvenanceMigrationState` 契约从 `Promise<void>` 改为**返回报告**（含 `warnings`），并让 `migration-service.ts` 的 DI 签名 `(root) => Promise<void>`（调用点 `:420/:423`、`:510`、`:636/:642`）与相关测试同步；最终呈现给用户。
2. **真机覆盖旧清单场景**：给 `storage-migration.spec.ts` 加一个「夹具数据根里放一份名≠内容哈希但内容完整的环境清单 + 引用它的 notebook run ⇒ 迁移成功完成」的用例。

**这两项的收口结论（后补）**：① **已实施**（提交 `3985923`、`a4b112e`，见下方「实施记录」）——主进程 `MigrationResult.staleEvidence` 非空才挂 + 渲染层镜像类型 + 弹窗 `data-testid="stale-evidence-note"`；② **已补**——`storage-migration.spec.ts` 现在有「桥接层」和「真入口/真 UI」两个旧清单用例 + 一条「干净根不报证据」的负向对照，真机 **3 passed**。⇒ 本模块**无遗留项**。

#### 收口项 ①的精确改动点（已侦察，未实施 —— 需干净上下文）

目标：把陈旧证据从「生产调用点已收集、只进日志」推进到「随迁移结果返回并可呈现」。

| 位置                                               | 现状                                                        | 需要改成                                                              |
| -------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `migration-service.ts:332` / `:349`                | `validateProvenanceState?: (root: string) => Promise<void>` | `=> Promise<StaleProvenanceEvidence[]>`（或返回 `{ staleEvidence }`） |
| `migration-service.ts:427`、`:514`、`:646`、`:647` | `await validateProvenanceState(root)`（丢弃返回值）         | 收集成数组                                                            |
| `migration-service.ts:272` `MigrationOutcome`      | 无该字段                                                    | 增 `staleEvidence?: StaleProvenanceEvidence[]`                        |
| `migration-service.ts` 返回 outcome 处             | —                                                           | 带上收集结果                                                          |
| 注入 `validateProvenanceState` 的既有测试          | fake 返回 `void`                                            | 同步改为返回数组（否则类型不过）                                      |
| 渲染层                                             | 无消费者                                                    | 呈现（迁移完成提示里列出「因旧版本证据跳过校验的条目」）              |

`StaleProvenanceEvidence` 类型与可选接收器已在 `provenance-migration-validation.ts` 就绪（提交 `c8c7570`），生产调用点也已收集，因此这里只是「把已有的数据接出去」。

**另注**：`src/shared/artifact-provenance.ts:291` 已有 `warnings?: string[]` 的历史口径，接出去时对齐命名，避免同一件事在两层用两个名字。

#### 实施记录：陈旧证据接出到结果 + 呈现（提交 `3985923`、`a4b112e`、待提交的重复渲染修复）

**主进程**：`MigrationResult`（`data-migration.ts:14`）增 `staleEvidence?: StaleProvenanceEvidence[]`（**非空才挂字段**，既有 `toEqual({ ok: true })` 断言零改动）；两个 DI 类型放宽为 `Promise<StaleProvenanceEvidence[] | void>`（注入 fake 不必改）；`commitDataRootSwitch` 收集两个根的校验结果并随 outcome 返回；`provenance-migration-validation.ts` 导出 `StaleProvenanceEvidence`。回归用例：注入只对目标根上报的 fake ⇒ `expect(result).toEqual({ ok: true, staleEvidence: [evidence] })`。

**渲染层**：`src/shared/storage.ts` 镜像同名字段与类型（renderer 不 import main-only 代码的既有约定）；`StorageMigrationModal` 在 `done` 阶段渲染 `data-testid="stale-evidence-note"`（文案 + 条数）；9 语键 `settings.moveStaleEvidenceNote` 由 `scripts/add-i18n-keys.py`（技能目录内）锚 `settings.moveDataTitle` 插入；渲染用例走完整流程后断言该节点存在且文案为「旧版清单按原样保留」+ 条数。

**顺带修复的真 bug**：`StorageMigrationModal` 的 `done` 阶段原有一句硬编码英文尾巴，而 `settings.restartToSwitch` 的字典值**已包含同一句** ⇒ 9 种语言下都会在译文后重复渲染一句英文。已删除 JSX 尾巴（字典值为完整句子）。

**门禁**：storage+notebook 1583 passed / settings+i18n+storage 894 passed / settings 587 passed；typecheck 0 error；lint 0 error。

### U33 结构性改造：设计定案（本轮侦察结论，未动代码）

**链路（45.4% 成本怎么来的）**

`ConversationPanel.tsx:615` → `<WorkspaceMessageScroller activeSession={activeSession} … />`：
`activeSession` 是**道具**，由 `ConversationPanel`（订阅会话 store）传下 ⇒ 每个 delta 触发 store 通知 ⇒ **面板重渲 → scroller 重渲 → 逐条 map 生成元素 → React 走完整条转录组件树**（memo 只让「重渲」变成「便宜地 bail out」，**走路本身仍要付**）。这与「slot 级只重渲流中那一个」并存：那是**渲染次数**，这是**提交成本**，两者不矛盾。

**现有仪器测不到目标**：`WorkspaceMessageScroller.interaction.test.tsx:369` 把 scroller 当**受控组件**渲染（`activeSession` 作为 prop 传入）⇒ 在这里数渲染次数只会数到**测试自己的**渲染；`:366` 的 `agentMarkdownRenderMock` 断言属于「已定稿槽位不重渲 AgentMarkdown」这一层，同样够不到「每个 delta 谁在重渲」。

**目标性质（可判定）**：一个流式 delta 到达后，**订阅方与列表容器零重渲，只有承载该消息正文的叶子组件重渲一次**。

**第一步必须是仪器（否则又是在假设上动手）**：写一个渲染计数用例，**渲染真实的订阅方**（`ConversationPanel` 或其等价 harness：真 store + 真 selector），用 React `<Profiler>` 分别记录 `ConversationPanel`／`WorkspaceMessageScroller`／叶子 三类组件的**每次 delta 的重渲次数**，先得到当前值（预期：面板与 scroller 每 delta 各 ≥1）。仪器的判据是「delta 次数 → 各类组件重渲次数」的映射，进 CI、确定性、秒级。

**第二步（按测量结果择一）**：

- 若面板每 delta 重渲 ⇒ 收窄其 selector（只订阅「消息 id 列表 + 修订结构」，不订阅逐 delta 变化的正文），或把正文读取下沉为**自订阅叶子**；
- 若 scroller 仍重渲 ⇒ 使其 `props` 在 delta 期间身份不变（修订结构只在**新修订**时变，正文不属于它），正文由叶子自订阅。

**验收（缺一不可）**：仪器断言「订阅方与列表容器 0 重渲 + 叶子 1 次」；真机 45 轮总量数字下降（`PERF_TURNS=45 npx playwright test e2e/perf/smoothness.spec.ts --workers=1`，基线 `task≈5162ms / 114.7ms 每轮`，须多次取噪声带）；最终文本**逐字一致**；真机仍在流；对话相关用例全绿。

**风险与不做的事**：不引入按帧节流（已证 0.65 提交/帧无空间）、不恢复写入侧合批（store 写入仅 0.5%）。若测量显示面板并未每 delta 重渲，则第一/第二步的结论作废，回到「谁在重渲」重新测量——**先量后改**。

#### U33 第一步（仪器）落点侦察结论

**不能用的 harness**：`ConversationPanel.interaction.test.tsx:105` 用 `vi.mock('./WorkspaceMessageScroller', …)` 把转录列表换成了 plain marker（该文件为「composer 摄入」而写，注释明说子区域被 stub）⇒ 在这里数渲染次数数的是替身，量不到真实转录。

**可用的 harness**：`src/renderer/src/pages/workspace/WorkspacePage.*.test.tsx`（8 个文件）——全仓**只有上面那一处** mock 了 `WorkspaceMessageScroller` ⇒ 这些页面级 harness 渲染的是**真面板 + 真 scroller + 真 store**，是唯一能承载该仪器的地方。

**仪器形状**（下一步照此实现）：

1. 在 `WorkspacePage.*.test.tsx` 之一（或新建同类文件）里用真 store 起一个含 ~40 条已定稿消息 + 1 条流式消息的会话；
2. 用 React `<Profiler id onRender>` 分别包住 `ConversationPanel`、`WorkspaceMessageScroller` 与叶子消息项，记录 `onRender` 调用次数；
3. 通过会话 store 的流式更新入口喂 K 个 delta（每 delta 一次 `act`）；
4. **先只做特征化**：断言「每 delta 的重渲次数 ≤ 当前实测值」，并在注释里写明目标是 **0（订阅方与列表容器）**；得到当前值后再实施 selector 收窄／叶子自订阅，然后把断言收紧到 0，最后跑真机 45 轮验收。

**注意**：`WorkspacePage` 渲染开销大（需预置多个 store），该用例应单文件、独立 `--maxWorkers=2` 跑；若首屏就超时，退而用「真面板 + 只 mock 与转录无关的子区域」的自建 harness，绝不再 mock scroller。

#### U33 仪器落点：现成 harness 全部不可用（已确证，需新建）

- `ConversationPanel.interaction.test.tsx:105` ⇒ `vi.mock('./WorkspaceMessageScroller')`（转录被换成 plain marker）；
- `WorkspacePage.*.test.tsx`（6+ 个文件，含 `customize-prefill` / `draft-preservation` / `edit-message` / `image-staging` / `notebook-hydration` / `pending-switch`）⇒ `vi.mock('./ConversationPanel', …)`，且用 `conversationProps` 捕获道具来驱动（为省开销刻意 mock 掉面板）。

⇒ **仓库里没有任何 harness 同时渲染真面板 + 真 scroller + 真 store**。仪器必须**新建一个面板级 harness**，最省的做法是照 `ConversationPanel.interaction.test.tsx` 复制其**完整道具清单**（该文件已把 `ConversationPanel` 的 30 余个必填道具备齐），**但删掉 `vi.mock('./WorkspaceMessageScroller')` 那一处**，再挂 `<Profiler>` 与 store 流式更新入口。

这样新文件就是「唯一渲染真实转录的 jsdom harness」，既承载 U33 仪器，也可复用于以后任何「转录渲染成本」的问题。

#### U33 结构性改造：实施落定（四判据达成）

**完整改动表、仪器坑、改前/改后数字与有意保留的代价见 `docs/evidence/2026-09-25-interaction-smoothness.md` 的「U33 结构性改造落地」一节。**要点：

- **机制**：不是「道具侧 memo」，而是**订阅侧冻结**——工作区对 `state.sessions` 的订阅改为 `useRenderSessions()`（只有流式正文变了就返回上一份快照，身份不变 ⇒ 页面不重渲），正文下沉为**自订阅叶子**（`WorkspaceMessageItem` 经 `selectLiveMessageContent` / `resolveMessageContent` 读自己的正文；容器的道具跨 delta 保持不变，正文不能再走道具），列表容器只把 `sessionId` 交给消息项。
- **为什么不用 memo**：实测 `<ConversationPanel>` 调用点有 **75 个道具、其中 7 处内联闭包 + ~40 个非 `useCallback` 的 handler** ⇒ 面板 memo 永远 bail 不掉，除非先做几十处 `useCallback` 化（大而无谓）。这条侦察结论使设计从「收窄面板 selector / 面板 memo」改为「冻结页面订阅 + 叶子自订阅」。
- **仪器判据**：`ConversationPanel.transcript-render.test.tsx` 断言 **panel 0 / scroller 0 / 叶子 1**。**`<Profiler>` 不能当判据**——它对该 bail out 的子树仍会触发 `onRender`（实测仍报 1）；判据换成「容器每次渲染都会新建的恒渲染子元素」探针。
- **真机**：同日同机交替构建 A/B（`557deaf` vs `8428602`），45 轮每轮 task **117.2–120.5 → 94.2–105.6 ms（约 −16%，两带不重叠）**，每轮 script 约 −22%；提交近似数不变（249–274 → 265–271）——少的是**每次提交背后的走路**，这与帧指标向来正常并不矛盾。
- **验收**：① 仪器 0/0/1 ✅ ② 真机 45 轮下降 ✅ ③ 文本逐字一致（`e2e/workspace-conversation.spec.ts` 的 `{ exact: true }` 断言，含重启后重载）✅ ④ 真机仍在流 + `npm run test:e2e:workspace` 8/8 + `npm run test:gate` 14426 passed / 0 failed ✅

**原「立案到下一版」项已在本轮补掉**（不留未认领项）：`previews/PreviewToolContent.tsx:141` 的 session 对象订阅（新仪器 `PreviewToolContent.stream-render.test.tsx` 量到 1 次/ chunk）→ 收窄为按字段订阅（`activePlanProjection` / `planHistoryProjections` / 会话是否存在 / 是否可批准）→ 复量 0 次/ chunk，「投影变化仍需重渲」的对照用例两种写法都过。A/B 与细节见 `docs/evidence/2026-09-25-interaction-smoothness.md` 的「相邻订阅方」一节。**当前无遗留的「仅剩 X 未落」项。**

#### U33 之后再次归因：app 侧已无值得动手的单点（已量，结论落档）

45 轮 profile（3 个流式回合 767ms 采样）+ 按**独占时间归属到 app 组件**的新分析（`scripts/perf-profile-by-component.py` 已入 skill）：最大的具名 app 组件是 `MessageTimestamp` **1.6%（≈4ms/轮）**，其次是 Radix 触发器 0.6% 与会话同步 0.6%；剩下 39.3% 不在任何组件内（事件/IPC/DOM）、13.6% 是 React 根/调度、5.8% 提交写 DOM。

⇒ 阈值判定：**U33 这条线在 app 组件层面到此为止**（继续抠组件低于仪器可辨别阈值）。若还要往下压每轮成本，下一层是「**结构性更新的传播面**」（工具活动/状态变化仍会走整条列表）与 **IPC 投递**，属另起一条线，需单独立案与仪器。明细见 `docs/evidence/2026-09-25-interaction-smoothness.md` 的「U33 之后再次归因」一节。

### 仪器保真度修正：夹具默认「一次发完」，把每块的成本全藏起来了

`e2e/fixtures/fake-opencode.mjs` 支持 `PURESCIENCE_E2E_STREAM_CHUNKS=<n>`（默认 1 = 旧行为，不影响任何既有用例）：把答复切成 n 块、块间 5ms 发回。既有 perf 数字（含本文件早前的 114.7ms/轮 基线）描述的是**投递**，不是**流式**——真机一回合的答复是几十块。同一改动在两种夹具下的收益差一倍以上（U33：**一次发完 −16% → 40 块/回合 −29.5%**，script 264.2 → 130.2ms/轮）。以后 perf 结论一律标清夹具块数。

### 保存回声收口（已落定）

渲染进程每次 `sessions:save-session` 都让主进程把**整份会话**广播回所有窗口（含发起窗口）：流式下一回合 19–29 次、每次 6–16KB。`saveLatestSession` 加 350ms 合并窗后实测 **29/19/26 → 2/1/1** 次、**178–374KB → 11–16KB**；真机 45 轮 323.6 → **308.2ms/轮**。强制写与 `flush()` 仍立即落盘，回合结束/退出/删除的持久性屏障不变。

### 每块一次的 `acp:state` 整份状态快照（已落定）

快照通道（含全量事件日志）此前每块广播一次，渲染端每块 `setState` + 全量事件重扫。加 150ms 最新值窗后：
`acp:state` **40/26/32 → 5/3/2 次/回合**、字节 294–941KB → **32–68KB**、过桥总字节 310–955KB → **62–109KB**；
真机 45 轮（40 块/回合）task **323.6 → 91.5ms/轮**、script **130.2 → 59.1ms/轮**、React 提交批次 1568 → 278。
逐字显示已用渲染端 MutationObserver 探针实测未受影响（38 次变更批次、长度逐步增长）。代价：快照类状态连续变动时最多滞后一个窗口（150ms）。仪器 `e2e/perf/ipc-traffic.spec.ts` 常驻。

### `session:updated` 不回送发起窗口（已落定）

写入的**返回值**里已有权威文档（渲染端在广播之前就 apply 了 invoke 的返回），发起窗口收到的回声被直接丢弃。投影（`renderer-broadcast.ts`）按 `originClientId` 跳过发起窗口——Electron 调用方在 `caller-context.ts` 里就是 `electron:<webContents.id>`，无需新增映射；其他窗口、远程与网页客户端照发。

实测（单窗口、40 块/回合）：`session:updated` **1–2 次/回合 → 0**，过桥总字节 62–109KB → **49–81KB/回合**（45 回合时回声单条曾达 242KB）。`session:created` 不跳过。验证：多窗口单测 3 条 + 真机 `test:e2e:workspace` 8/8（含重启重载、逐字一致）+ 过桥探针 ×0。

### 下一层立项（有数，未动）：`acp:state` 每条 209KB 的整份事件日志

来源 `runtime-coordinator.ts` 的 `MAX_EVENTS = 500` 截断：单条快照 ≈209KB、每回合 2–5 次 ⇒ 0.4–0.6MB/回合（45 回合下 0.4–0.8MB/回合）。裁这份数组会改变渲染端 `latestEvents` / `cleanEventLane` 的清理语义，属两侧契约改动，需单独立项 + 复用同一台探针做前后对照。明细见 `docs/evidence/2026-09-25-interaction-smoothness.md`。

### 过桥三项收口后的归因（已量）：剩下的在 React 渲染，最贵的是图标重渲

`ipc-delivery` 23.4% → **0.7%**；`react-render` + `react-commit` 合计 **37.9%**。最贵具名帧 = `lucide` 图标工厂（≈**19ms/轮**）+ 提交阶段写 SVG 属性（≈5ms/轮）。成因是 U33 让**消息项**整体自订阅正文 ⇒ 每块连图标与 chrome 一起重渲。

**下一单元（已做，A/B 中性，已回退）**：把内容订阅再下沉一层——消息项只收 `sessionId`/`messageId`，正文子组件自订阅 store。同口径 A/B：172.4 → 167.5ms/轮、1620 → 1608 批次、图标帧 57.7 → 58.0ms —— **中性**：图标重渲不在消息项 chrome 里，而在**正文子树内部**（`AgentMarkdown` 自身），搬订阅治不了，要动得进渲染器内部做记忆化。改动已回退（工作树 = `2443a58`）。

**同时确认一条测量纪律**：同一份代码跨时段量到 105.0 与 172.4ms/轮 ⇒ **帧/批次类指标只能同一次会话内成对 A/B**，跨时段绝对值不可比。

### 图标归因收口（已量，已落为常驻判据）

「图标重渲 ≈19ms/轮」经确定性计数查明：**转录的文本路径每块不重渲任何图标**（`markdown 1 / slot 0 / icon 0`，探针带活性自检）；真机那些图标帧来自每块也在变的其它区域（工具活动行 / 面板 chrome）。CPU 栈反查在这类问题上不可靠——组件名在 React 工作循环之上已丢失。

- 判据已进 CI：`ConversationPanel.transcript-render.test.tsx` 的精确断言含 `icons: {}`。
- **下一单元若要碰图标**，判据必须是「驱动活动事件的确定性计数探针」（给同一 harness 补喂活动更新），不能靠 profile 猜栈；先量出「哪一行活动更新重渲了哪些图标」，再决定改不改。

### 活动通道打穿了冻结容器（已量，已立项）

同一 harness 驱动 `upsertToolActivity`（流式工具事件的真实入口）的读数：**面板 1 / 滚动容器 1 / 槽 0 / 正文 0 / 图标 9**（9 个里只有 1 个是活动行自己的图标，另 8 个是面板 chrome 的 `Menu`/`Bell`/`PanelRight`/`ChevronRight`/`Plus`/`FileText`/`ScanEye`/`Square`）。创建与状态变更同价。

原因：文本通道靠订阅守住了（槽与正文都不重渲），**活动通道仍走 props**（`activeSession.activities` / `activityGroups`），冻结快照一因活动变化就重发 props ⇒ 面板 + 滚动容器 + 全部 chrome 图标跟着重渲。工具事件在流式回合里高频 ⇒ 这是真机图标开销的主要来源。

**下一单元（已立项，先量后改）**：活动数据移出冻结快照的比较，改由**活动行自订阅 store**；判据 = 上述 harness 的精确断言收紧到 `panel 0 / scroller ≤1 / 图标仅剩活动行自己那个`（基线值已写进断言，改动后必须同步下调）。

### 活动通道（已实现，确定性验收通过；真机量化待夹具升级）

- `IGNORED_SESSION_KEYS` += `activities` / `activityGroups`；新增 `activity-subscription.ts`（`selectLiveSessionActivities` / `selectLiveSessionActivityGroups`）；`WorkspaceMessageScroller` 自订阅并用记忆化的 `sessionForItems` 喂装配。
- 前置实测：投影数组在**文本块上引用稳定**、在活动更新时变化 ⇒ 裸订阅安全（否则会把文本通道收益打回去）。
- 读数：面板 **1 → 0**、图标 **9 → 2**（只剩活动行状态图标 + 分组 chevron），并带 DOM 存活验证（图标真的换）。
- **真机量化前置**：`fake-opencode.mjs` 的流式场景不发工具事件 ⇒ `smoothness` / `streaming-profile` 对活动通道不敏感。下一步要给夹具加一个「按 `PURESCIENCE_E2E_TOOL_EVENTS=<n>` 发工具活动事件」的开关，才能真机量化这条通道（同会话成对 A/B）。

### 夹具工具事件开关（已落地）+ 真机 A/B 结论

- `PURESCIENCE_E2E_TOOL_EVENTS=<n>`：把 n 条工具生命周期按 ACP 形状均匀插进文本流；默认 0 = 行为不变。真机验证到 `Fetched 3 pages` / `Used tool: ToolFetch` 活动组 ✓。
- 同会话成对 A/B（45 回合 × 40 块 × 每回合 6 条工具事件）：DOM 批次 1630 → 1635、每轮 task 252.3 → 294.3ms、图标帧占比 5.8% → 6.1% ⇒ **真机上分辨不出收益，本改动不声称真机提速**（证据是 harness 的确定性读数：面板 1→0、图标 9→2）。本机墙钟噪声 + 后跑偏慢的顺序效应，都记在 evidence 里。
- **有价值的真机信号**：每回合 6 条工具事件把每轮 task 从 ~185ms 推到 ~252ms（跨批次，方向性）⇒ 活动通道在真机上确实是显著成本，但成本主要在**列表容器自身重渲**（时间线装配），不在面板与 chrome。
- **下一单元（若要继续）**：让列表容器在活动更新时也不重渲（装配按结构记忆化，或活动项自订阅）；判据 = harness `scroller 1 → 0`。

### 长转录下的活动更新：一次只该重画一行（已实现并验收）

上一节把「活动更新不再重渲面板与无关 chrome」拿下后，本单元量的是**同一条通道在长转录里的规模效应**——时间线上行数一多，一次更新的代价会被行数放大。

**先量（确定性计数，harness）**：时间线上先落 12 行已完成活动，再更新其中一行 ⇒

| 读数 | 改前 |
| --- | --- |
| 面板 | 0 ✓（上一单元已拿下） |
| 列表容器 | 1 |
| 消息槽 / 正文 | 0 / 0 |
| **图标** | **`Check` ×12 + `ChevronRight` ×1 = 13** ✗ |

⇒ **12 行全部重画**（每行的状态图标都要重建一次），而真正变的只有 1 行。这正是 profile 里「lucide 图标工厂是最贵具名帧」在长转录下的放大形式：一条活动通道的更新，代价是 O(行数)。

**根因**：四个活动行/图标组件（`WorkspaceActivityIcon`、`WorkspaceToolActivityRow`、`WorkspaceWebSearchActivityRow`、`WorkspaceToolDetailsRow`）**都没有记忆化**，行对象的引用对未变行是稳定的（上一单元已验证），所以只差一个 bail-out 边界。

**改法**：四个组件各自 `memo` 包一层（叶子组件不吃回调，直接记忆化；两个带回调的行用「命名 view + `memo(view)`」写法，JSX 一行不动）。

**读数（同一 harness，改后）**：

| 读数 | 改前 | 改后 |
| --- | --- | --- |
| 12 行里一次更新重画的行数 | 12 | **1** |
| 图标（新活动到达） | 13 | **2**（`ChevronRight` + `LoaderCircle`） |
| 图标（随后状态落定为完成） | — | **2**（`ChevronRight` + `Check`） |
| 面板 / 消息槽 / 正文 | 0 / 0 / 0 | 0 / 0 / 0 |

harness 断言已收紧为 `{ ChevronRight: 1, LoaderCircle: 1 }` → `{ ChevronRight: 1, Check: 1 }` 两段精确值，并保留「活动内容必须在屏上」（`public data repositories`）作为**活性**证据——记忆化最常见的回归就是「行冻结不再更新」，两段图标读数正好把「新活动到达」与「旧行落定」的活性都钉住。

**关于「列表容器 1 → 0」**：不做。活动与消息交错，时间线装配必须随活动变化重算（这是真实工作，不是浪费）；把装配搬进子组件只会让子组件付同样的账，只省掉容器自身的一层 JSX。**没有真实收益的搬迁不做**——判据保留在「重画的行数」这一项上（已达 12 → 1）。

**真机 A/B（同会话，45 回合 × 40 块 × 每回合 6 条工具事件；改前 `dfce003`，改后 = 加 memo）**：

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| 每轮 task | 263.1ms | **255.0ms**（−3%，噪声带内） |
| 每轮 script | 164.6ms | 161.1ms |
| DOM 变更批次 | 1635 | 1634 |
| 图标帧（占采样比） | 128.8ms（7.2%） | 130.8ms（7.5%） |

**判读**：墙钟上仍**分辨不出**（−3% 不构成声明）。图标帧**平掉**这一点，我上一轮给的解释（"profiler 只采前 3 个回合、时间线还短"）**是错的**：`streaming-profile.spec.ts` 先跑满 `PERF_TURNS` 个回合再挂 profiler，采样时时间线是长的（45 回合 ≈ 270 条活动）。真正的问题是**归因不足**——`updateForwardRef` 子树里的图标帧没按调用方分辨过。⇒ 处置：两侧各归档当侧 bundle + profile，把图标帧按调用方拆开（见下节）；在拿到按调用方的读数之前，本单元**只**以确定性读数为证据（一次更新重画的行数 12 → 1），真机侧不作任何提速声明。

### 图标帧的三次配对（ABBA）：改动**在本机 profile 上分辨不出**

修正列号解析（CDP 的 `columnNumber` 是行内列，不是文件偏移）后，把「`updateForwardRef` 子树工作量 / 占采样窗比例」当作被测量，三次同会话配对：

| 配对 | 改前 | 改后 | 方向 |
| --- | --- | --- | --- |
| 第 1 次（无归档，顺序：改前→改后） | 128.8ms（7.2%） | 130.8ms（7.5%） | 平 |
| 第 2 次（两侧各存 bundle，顺序：**改后→改前**） | 137.3ms（8.1%） | 100.3ms（6.4%） | 改后更好 |
| 第 3 次（两侧各存 bundle，顺序：**改前→改后**） | 130.2ms（7.9%） | 150.3ms（8.8%） | 改后更差 |

⇒ **三次里两次方向相反**；且第 2、3 次唯一差别是**先后顺序**，读数就翻转（第二侧平均更贵）⇒ 本机的帧级指标**扛不住这个量级的变化**，图标占比在 6.4%–8.8% 之间随机漂。**第 2 次那个"−27%"是噪声，已撤回**（幸好在落档前做了换序复现）。本单元的真机结论：**分辨不出**；证据仍只有确定性读数（一次活动更新重画的行数 12 → 1）。

**方法论升级（已入 skill）**：帧级/占比类指标必须**ABBA 双向配对**（一轮改前先跑、一轮改后先跑），**两次同向**才允许写结论；顺带修掉两个会造假结论的解析坑——CDP 列号是行内列（当文件偏移切 bundle 会得到"零个图标帧"），以及 profile 必须与**同一次构建**的 bundle 一起归档（行号随构建漂移）。

**改动为何保留**：确定性收益成立（12 行只重画 1 行）且活性断言守住（新行到达 / 旧行落定都验过），真机上未观察到任何回退；只是它在本机可测的量级之下。

### 真机挂载普查：为什么这条改动的真机量级本来就小（决定性解释）

「确定性读数 12 → 1 行」与「真机测不出任何差异」之间的落差，不必再用"噪声"解释，实测就能说清：

**真机普查（12 个工具密集回合，每回合 6 条工具事件 = 72 条活动；探针已删）**：DOM 里同时挂载的活动行 **只有 6 行**（就是最新那回合的 6 行）——历史回合的活动行**不在 DOM 里**（转录里它们是折叠摘要 `N steps · Xms`，不是逐行）。⇒ 一次活动更新在真机上本来只波及 **~6 行**，记忆化把它压到 1 行，省下的是「每次更新约 5 次行重画」（按同一机制的推算，非实测）；而 harness 用的 12 行**展开**场景（12 → 1）比真机实际暴露面更大。

**教训（已入 skill）**：在按「每行成本」做优化前，**先数真机同时挂载多少行**——确定性 harness 的规模如果比真机大一个量级，就会把"正确的优化"误判成"应该很明显的收益"。这条落差本身就是结论：改动成立且无需回退，但真机收益小是**结构决定的**，不是测量失败。

**下一单元（已量并归档，见下节）**：`MessageTimestamp` 在 profile 里占 17–20ms/3 回合（每消息一个组件，随消息数放大）——**量过之后结论是"不是瓶颈"，零代码归档**。

### 交互普查（新仪器：CDP Performance **计数**）：打字是当前最贵的一处，且主要是编辑器固有开销

profile 回答"哪一帧"，但它的墙钟数受负载影响；**CDP `Performance.getMetrics` 给的是计数**（LayoutCount / RecalcStyleCount / Nodes / ScriptDuration / TaskDuration），不随负载漂移 ⇒ **对比不需要 ABBA 配对**。新仪器 `e2e/perf/interaction-metrics.spec.ts`（常驻，30 回合 × 6 工具事件的长会话上依次量：滚动 / 聚焦 / 逐键打字 / 流式中打字 / 一整个流式回合，并写出 `test-results/perf/typing.cpuprofile`）：

| 动作 | 读数（长会话，2200 DOM 元素 / 122 条目 / 6 行活动） |
| --- | --- |
| 滚动 14 步（回看老答案） | LayoutCount +17、TaskDuration **106ms**（≈7.6ms/步）⇒ 不卡 |
| 聚焦 composer | script 1ms ⇒ 干净 |
| **打字 57 字符** | LayoutCount +58（每键 1 次布局，便宜）、**ScriptDuration 453ms / TaskDuration 533ms** ⇒ **7.94ms script + 9.35ms task 每键** |
| 流式中打字 34 字符 | 149ms / 213ms ⇒ 4.4ms/字符 |
| 一个流式回合 | script 106ms / task 162ms |

**打字成本的构成（profile 归因，128 个字符的采样窗）**：React 渲染帧合计 ~109ms（`performWorkOnRoot` 46.7 / `commitMutationEffectsOnFiber` 37.3 / `reconcileChildren` 8.8 / `commitRoot` 7.7）、lucide 图标工厂 ~16ms、GC 26.6ms，另有应用在敲键时做的 `querySelectorAll` 11.6ms 等。

**为什么 React 从"根"渲染**：`draftDoc` 是 **`WorkspacePage` 的 `useState`**（`WorkspacePage.tsx:678`），每敲一键整页重渲；memo 化的子树会 bail out（harness 实测：敲键时 **scroller 0 / 消息槽 0 / markdown 0 / 时间戳 0** ✓ 转录没被拖下水），但 React 仍要自根而下走一遍（~0.85ms/字符）。

**结论（不夸大）**：可归因于应用渲染路径的只有 **~1.0–1.2ms/键（约 12–15%）**，其余是输入事件/contenteditable 编辑器/GC 的固有开销；8ms/键仍在 60fps 帧预算（16.7ms）内。⇒ **不为 15% 去重构页面状态归属**（把 `draftDoc` 下沉到 composer 区域或专用 store 的改法已写明，立案，低值）。若"卡"的体感仍在，更可能来自**流式期间的突发 work**（每轮 ~150ms 主线程），而不是打字或滚动本身。

**下一步（立案，未做）**：把流式 profile 里 60% 的 `other` 桶拆开——ipc-delivery 已降到 0.7%、react-render/commit 合计 ~38%，剩下的 60% 目前没有归属，是唯一还没认领的大块。

### `other` 桶已拆开：桶里没有剩余的应用侧杠杆（零代码归档）

对 45 回合 × 每回合 6 条工具事件的 profile（采样 1707ms）做桶内归因：

| 桶内构成 | 量 | 判读 |
| --- | --- | --- |
| `(program)` | **450ms（26%）** | V8/引擎自身（含布局、绘制、编译）——应用只能通过"更少更轻的 DOM 变更"间接影响 |
| `(idle)` | 239ms（14%） | 夹具 5ms/块的节奏留白，**不是应用工作** |
| `garbage collector` | 65ms（3.8%） | 分配压力（元素/props 创建） |
| lucide 图标工厂 | 44ms（2.6%） | 主要是新消息挂载时的图标 |
| Radix Slot / Context | 43ms（2.5%） | portal/context 开销 |
| `MessageTimestamp` | 26ms | 已证明是小组件帧吸收内联子帧（微基准 2µs/条） |
| `scrollTo` | 22ms | 流式自动滚动 ✓ 必要 |
| React 记账（`commitLayoutEffectOnFiber`/`updateCallback`/`updateMemo`/`cloneElement`/`setProp`） | ~60ms | 必要 |
| **`query` / `elementText` / `checkVisibility` / `querySelectorAll` 簇** | ~53ms | **见下：先怀疑后实测排除了应用侧** |

**一次被实测推翻的假设（留档）**：那簇 DOM 查询看着像 `useUnreadTaskViewSync` 里**逐条 mutation 记录**跑 `matches`/`querySelector(subtree)`/`closest` 的过滤逻辑（流式期间记录多、命中少 ⇒ 全扫）。→ **直接复刻该逻辑在真机计时**（临时探针：同配置 MutationObserver，10 个流式回合，删于测后）：**98 批 / 252 条记录 / 252 个不同节点 / 过滤总耗时 1ms ⇒ 0.1ms/轮** ⇒ 排除，且顺带证明"按批去重"不会有收益（252 条记录无重复节点）。
**真身**：`checkVisibility`/`elementText` 是 **Playwright 自己的页面内定位器工作**（`expect.poll(getByText(...).count())` 在页面里算可见性与取文本）⇒ **profile 窗口被测量工具本身污染了**。

**结论**：`other` 桶 = 引擎工作 + 夹具留白 + GC + 一条必要的细尾，**应用侧已无大杠杆**；本轮"流式逐层压"的收益也已在确定性口径上拿满（1 块 = 1 槽 + 1 次 markdown；1 次活动 = 1 次装配 + 1 行；面板/图标/时间戳均不再随事件重渲）。**归档零代码。** 若今后要再压，得先换夹具（例如不靠 Playwright 定位器轮询来探测完成）或直接看打包版本的 profile（dev/e2e 构建本身带额外开销）。

**方法论（已入 skill）**：① 怀疑某段逻辑是热点时，**在真机复刻它并直接计时**，别停在 profile 的调用链上；② **profile 窗口可能被测试工具本身污染**（Playwright 定位器会在页面里跑 `checkVisibility`/`elementText`）⇒ 归因到 DOM 查询簇前先排除它。

### 消息时间戳：量出不是瓶颈（审计归档，零代码）

上一节把 `MessageTimestamp`（profile self time 16.96–20.6ms/3 回合）立为"比活动行更值得看的一处"。本单元按纪律先量，结论是**这一项不需要改代码**：

**① 渲染时机（确定性探针：`Date.prototype.toISOString` 调用计数 = 一次时间戳渲染）**：

| 触发 | 时间戳渲染次数 |
| --- | --- |
| 挂载（40 条已落定消息） | **20**（用户消息的 `Sent` 各一次；本夹具的 agent 消息无终态时间） |
| 一次纯文本块 | **0** ✓ |
| 一次活动更新 | **0** ✓ |
| 宿主无数据变化的重渲 | **0** ✓ |

⇒ 时间戳**只在消息挂载时**渲染，三条热路径都不碰它。

**② 微基准（V8/ICU，与渲染器同引擎）**：label（`short`）**1µs/次**、title（`dateStyle: full, timeStyle: long`）**1µs/次**、`toISOString` **~0µs** ⇒ 单条消息 **≈2µs**，**200 条消息会话 ≈ 0.4ms**。V8 缓存了 ICU pattern，格式化本身便宜到可忽略。

**结论**：profile 里那 17–20ms 的 self time **不能**解释成 Intl 成本（微基准直接否掉）；更可能是小组件帧**吸收了被内联的子帧调用**后仍记为自身耗时。⇒ 无可改之处：既无重复渲染可省（三个热路径均为 0），格式化本身也无可优化（2µs/条）；任何"优化"都只能靠改功能（去掉 hover 的完整时间 tooltip）——**不做**。

**落档产物**：把探针留成**常驻守卫** `keeps message timestamps out of every hot path`（断言三条热路径恒为 0 + 挂载活性自检），守住的是「不再引入一条把时间戳拖进热路径的改动」，而不是"抠掉了一大笔开销"。

**教训（已入 skill）**：**profile 的 self time 不等于算法成本**——小框架会吸收被内联的子帧；先做微基准，再决定动不动代码。判断"是否重复渲染"要用确定性计数（挂载 / 每块 / 每活动 / 无关重渲四个数）。

### 广播事件日志裁到「未发送 + 重叠」（已落定，两侧对齐）

主进程广播快照时只带「上次广播之后 + 60 条重叠」的事件（拉取路径 `acp.getState` 仍全量）；渲染端可用集同步改为**累积**（`mergeLiveEvents`，上限 1000，空窗口不清空）——只改一侧会回退：45 轮 task 91.5 → **216.5ms/轮**（lane 被回收、ledger 丢失、重叠事件每份快照重新应用）。

实测：`acp:state` 单条 137.8→209.1KB（随会话变胖）→ **29.6–33.0KB 恒定**；过桥总字节 473–845KB → **103–130KB/回合**；真机 45 轮 task 105.0ms（同口径噪声带 94–106ms 内）。单测 10 条、`test:e2e:workspace` 8/8、全量门禁 14442 passed。
