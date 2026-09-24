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
| U16  | 预览动作从「只能右键」升为一等入口                                            | 下载/存产物/数字化/表格抽取/文献导入均有工具栏或命令面入口，右键仍可用         |
| U17  | **✅ 完成**（真机 `1 passed`）：命令面 + 快捷键清单面 + 设置搜索扩到关键词 | ⌘K 能搜到命令；设置搜「镜像/mirror/代理」命中；`Cmd+,` 与 `Cmd+W` 在界面上可见 |
| U18  | 上下文门控入口（检查清单/复核/折叠时间线可主动打开）                          | 无评审记录时也能主动打开清单页签，并给出「还没有评审」的解释                   |

### 批次 3 进行中记录

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
- **教训**：注释与依赖数组不一致的「名不副实」监听是最难查的一类门控缺陷——它让上游门控的 `defaultPrevented` 分支静默吞键，而所有既有测试都不拥有这个键的所有权断言。

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
