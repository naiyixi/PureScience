# 交互闭环补齐：排期与发版号分配（2026-10-03 定稿）

> 依据：`docs/evidence/2026-10-03-entry-layer-and-interaction-closure-audit.md`（52 条，P0 9 / P1 33 / P2 10）
> 与 `docs/competitive-tracking/2026-10-03-v035-window-delta.md`（对手 v0.35.0 窗口 4 项差距）。
> 口径沿用 v1.69 那一版：**一批 = 一个版本边界**；批次内每个单元独立走「实现 → 相关簇绿 → 双 typecheck + eslint →
> 提交 → 推送 → 盯 CI → 进下一单元」；批次走完再走完整发版流程（CHANGELOG + 双语 README 横幅 + 全量门禁 + tag + Release）。
> 每条验收都是**实机可验**（真入口、真执行、真数据）；单元测试只作回归网，不作完成证据。
> **纯文档 / 测试 / 读数改动不占版本号**（写进 CHANGELOG 的「明确没做、已立案的」或并入相邻版本的小节）。

## 0. 版本号现状（先定号，避免撞号）

| 版本       | 状态                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| v1.80.0    | **已发布**（2026-10-03，tag `f2a97d87`，run 37099590863，21 资产）                                                 |
| v1.81.0    | **已被占用**：`docs/plan-2026-10-02-R2-U4-journal-alias-merge.md:124` 立案「同日同类多指标不静默取一条」接 v1.81.0 |
| v1.82.0 起 | 本排期连续分配（见下表），**未开工前不许提前写进 CHANGELOG**                                                       |

## 1. 排期总览

| 批次 | 版本         | 主题                              | 单元 | 条数           | 退出条件（一句话）                                                |
| ---- | ------------ | --------------------------------- | ---- | -------------- | ----------------------------------------------------------------- |
| 1    | **v1.81.0**  | 已立案收口 + 硬编码文案清账       | 5    | 4 + 1 合并清账 | 4 条读数落档；硬编码英文 grep 归零；9 语 `translation-quality` 绿 |
| 2    | **v1.82.0**  | 挂载点四条（后端全齐、只差接线）  | 4    | 4              | 真窗口四条读数：产物面板可见、红点亮、A7 环境可删、产物可外部打开 |
| 3    | **v1.83.0**  | 数据不丢与退路                    | 3    | 3              | 跨实例导入后**证据表真的有行**；迁移遗留副本两个入口都能走通      |
| 4    | **v1.84.0**  | 笔记本 / 运行时闭环               | 6    | 6              | 六条各自真机读数（含窗口直装包真的装上并回读）                    |
| 5    | **v1.85.0**  | 自定义 MCP / 连接器闭环           | 6    | 6              | 自定义服务器「增删改查 + 权限 + 探测」六向齐                      |
| 6    | **v1.86.0**  | 文献 / 期刊闭环                   | 6    | 6              | 附件历史可见、notes 可读写、整表指标可导入                        |
| 7    | **v1.87.0**  | 出网 / 存储 / 视觉 / 诊断的可核性 | 8    | 8              | 每一条失败路径都有具名错误或可回读的明细                          |
| 8    | **v1.88.0**  | 算力与引擎                        | 4    | 4              | 任务可取消；needs-attention 有全局入口；引擎面板能下权重          |
| 9    | **v1.89.0**  | 记忆溯源与审查明细                | 3    | 3              | 徽标有真实生产者；RO-Crate 失败说得清哪条 MUST 没过               |
| 10   | **v1.90.0**  | 拍板项与死面清理                  | 6    | 6              | 六条各自「建入口」或「归档并写明」二选一有结论                    |
| —    | **v1.91.0+** | 对标大件（另立批次，见 §4）       | 5    | —              | 各自单独立项                                                      |

**合计 51 个单元（v1.81.0–v1.90.0，覆盖 52 条审计项 + 5 条既有立案 + 6 条 i18n 遗留）+ 5 个对标批次单元（v1.91.0 起，各自立项）。**

## 2. 逐批次单元表

### 批次 1 · v1.81.0 —— 已立案收口 + 硬编码文案清账

| 单元 | 内容                                                                                                                                                                                                                                                              | 落点                                                                                                                                                                                                                                                     | 实机验收                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| IC1  | 同日同类多指标**并列显示或标冲突**，不静默取一条（已立案）                                                                                                                                                                                                        | `shared/journal-metrics-overview.ts:119-140`（`selectLatestClaim`/`cellOf`）、`JournalMetricsPanel.tsx`                                                                                                                                                  | 合并前后同一 cell 必须看到**两个值**或冲突标记                                      |
| IC2  | R2-U4 三种具名拒绝的**面板级中间态 DOM** 读数                                                                                                                                                                                                                     | `docs/evidence/2026-10-03-r2-u4-journal-alias-merge.md` §3 遗留                                                                                                                                                                                          | 选择候选、确认之前那一步的 DOM 读数落档                                             |
| IC3  | egress 拦截卡「**等满 60 秒**」端到端复现                                                                                                                                                                                                                         | `EgressApprovalCard.tsx`、`egress-runtime.ts`                                                                                                                                                                                                            | 真窗口等满 60s：卡片自动撤、应答失败不静默                                          |
| IC4  | `--primary-foreground` 对比度实测                                                                                                                                                                                                                                 | `#4D6BFE` 上的白字，按实际字号/字重                                                                                                                                                                                                                      | 对比度数值落档；不达标才微调前景色                                                  |
| IC5  | 硬编码英文清账（**一次做完**）：核验面板 4 处、产物溯源 `Source`、项目文件 Retry、迁移弹窗 Cancel/Close/Elapsed/Don't quit/Browse…/Checking…、存储面板、**i18n 键控遗留**（专才面空态卡/Built-in/自定义组标题/ZIP 子界面拼句/作者编辑器、连接器导入、技能上传×3） | `VerificationChecklistPanel.tsx:51-55,119,122,145`、`ReviewerCard.tsx:100`、`ArtifactProvenancePanel.tsx:1290`、`ProjectFilesView.tsx:1869`、`StorageMigrationModal.tsx:262,298,304,308,396,412`、`StoragePanel.tsx:309,369,461`、`SpecialistsPanel.tsx` | `search_files` 三类硬编码模式归零；9 语字典 zh≠en；`translation-quality.test.ts` 绿 |

> IC5 把审计 P2-1/P2-2/P2-3/P2-4 与队列 A 段第 9 条**合并成一次**做——同一口径（新 UI 文案必须 9 语言）分四次做就是四倍的契约连锁。

### 批次 2 · v1.82.0 —— 挂载点四条（**最优先**：只差接线，单轮可收口）

| 单元                                                                           | 内容                                                                                                                                                                                                                                                                                  | 落点                                                                                        | 实机验收                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IC6                                                                            | 任务产物面板：featured outputs / 留在远端 / 收割失败                                                                                                                                                                                                                                  | `JobDetailModal.tsx:225-226`（现有注释占位）；数据已在 `shared/compute.ts:328-332`          | 跑一个真任务，详情里列出产物并能逐条下载/定位                                                                                                                                                                                                                                                      |
| IC7                                                                            | 通知到达点亮红点                                                                                                                                                                                                                                                                      | `App.tsx` 启动处调 `notification-inbox-store.listen()`（照 `permission-grants-store` 写法） | 后台任务完成 → 铃铛红点**自己**亮，不用点开才刷                                                                                                                                                                                                                                                    |
| ~~IC8~~ ✅ **已完成（会话 `d726882a` + 列表刷新修复与真窗口读数 `b7feabd4`）** | A7 锁导入命名环境的**删除**与**用作运行时** —— 已交付：新通道 `runtime:manage-named-environments`（`list`/`remove`）+ 面板独立「具名环境」分组；移除二次确认，**在用内核时拒绝且理由逐字上屏**（不改写成更友好的话）；「用作笔记本运行时」走既有 `register→enable→select`，不新造后端 | `RuntimesPanel.tsx`、`runtime-application-commands.ts`、`environment-management.ts`         | 真窗口读数：`serviceNamedEnvs=["lock-import-env"]` / `namedEnvRows=1` / `namedEnvRemoved=true dirGone=true`（`e2e/certification/lock-import.spec.ts` 2 passed；证据 `docs/evidence/2026-10-03-A7-external-lock-import.md` §6）。**仍未取**：在用内核时拒绝移除的真窗口读数（需活的 notebook 内核） |
| IC9                                                                            | 产物用系统程序打开 / 在文件夹中显示                                                                                                                                                                                                                                                   | `PreviewFileSurface.tsx` 头部或右键菜单 → `artifacts.openFile`                              | 真机点一次，系统程序打开的是该版本文件                                                                                                                                                                                                                                                             |

> **IC6 已落地（`FeaturedOutputs`）**：`JobDetailModal.tsx:225` 那行注释掉的占位换成真组件；
> 重点产出 / 留在远端（每条带自己的原因）/ 计数大于清单时**明说少了多少** / 收割失败原话 +
> `remote_workdir` 并排给出。渲染测试 14 passed、i18n 42 passed、typecheck 0、eslint 0。
> **真机「已收割」读数立案**：应用只有 `ssh:<alias>` provider，本机无远程主机 ⇒ 真窗口里一个真收割过的
> 作业上取数需要环境；证据 `docs/evidence/2026-10-04-ic6-featured-outputs.md`。
>
> **IC9 已落地（`5fe6d1eb`）**：产物预览面加「用系统程序打开 / 在文件夹中显示」两个显式按钮，
> 拒绝按 handler 原话上屏；真机 `artifact-open-actions.spec.ts` **1 passed (13.3s)**（两控件均可见、
> 点击后无具名拒绝）。证据 `docs/evidence/2026-10-04-ic9-artifact-open-actions.md`。
>
> **IC9 真缺陷已修（2026-10-04）**：打包态 macos runner 确定性报
> `local-fs:reveal → Local path must be absolute.`（**上面那次本机「无具名拒绝」是假绿**）——
> 「在文件夹中显示」把预览项的**版本定位符**当文件系统路径交给了 `localFs.reveal`。
> 修法照搬本仓成对先例（`logs:open-file` / `logs:reveal-in-folder`）：抽出**唯一**解析函数
> `resolveOsHandoffPath`，`openFile` 与新增 `revealFile` 共用；新增 LOCAL 命令
> `artifacts:reveal-file` + 计数连锁六处全改；渲染层改走 `window.api.artifacts.revealFile`。
> 守卫是加强不是放松——渲染测试断言 `localFs.reveal` **从未被调用**，主进程断言 OS 拿到 `realpath`、存储外路径被拒。
> 修复后真机 1 passed (12.4s)。证据同上档 §六。
>
> **IC10 已落地（`04761221` + 本批真机读数）**：导入侧不再只读 `conversation.json`——
> `session-package/import-evidence.ts` 把引用 / 复核 / 审查结论 / 人工附证真正写成接收方的行
> （7 个具名跳过码、发送方本机指针一律不携带、人工附证指纹在本机对导入转录**重新派生**）。
> 真机读数：`e2e/certification/session-package-import-evidence.spec.ts` **1 passed (16.2s)**，
> 接收方（新建空项目）四维与发送方真源**逐项相等**（引用 1 / 复核 2 / 验证 1、`skipped:[]`），
> 钉子带本机可复算指纹。**诚实说明**：`reviewFindings` 两侧都是 0（e2e 假 agent 不产复核结论）
> ⇒「复核结论（checks）落地」只有单测覆盖，本机读数未覆盖，不算已实测。
> 证据 `docs/evidence/2026-10-04-ic10-session-package-import-evidence.md`。
>
> **IC7 接线已落地（`dba7d15a`）**：`App.tsx` 启动处订阅一次 `notification-inbox-store.listen()`
> （内部走既有的 `notifications.onChanged` / `getSnapshot`，**零新通道**）；`App.test.tsx` 40 passed、
> 契约四件套 91 passed。**真机读数已取（2026-10-04）**：`e2e/certification/notification-arrival.spec.ts`
> **1 passed (33.5s)** —— 假 agent 一个回合走完，铃铛的可访问名从 `Messages, no unread messages` 变成
> `Messages, 1 unread`，**全程未点击铃铛**（被验的正是那个订阅，手动刷新不算）。
>
> **IC53 的 S3 认证 spec 第四条已改（`10a14928`）**：原断言「删掉索引目录后 `indexed` 变 0」是**竞态**
> （tick 由查询驱动，删完随即被重建；同一行断言在一版上读 0、下一版读 3）⇒ 改钉删除真落盘、
> `indexed+pending === 语料`、索引被重建回磁盘、语料仍可搜到。本机真机 1 passed (43.0s)。
> 这是 CI 认证作业（P0）那次红的唯一原因；视觉回归那一条是 workflow 明示的**非门禁**项。

### 批次 3 · v1.83.0 —— 数据不丢与退路

| 单元 | 内容                                                                  | 落点                                                                                          | 实机验收                                                       |
| ---- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| IC10 | 会话包**随包证据落库**（citations / review-findings / verifications） | `session-package/import-session.ts:79`（现只读 `conversation.json`）、`import.ts:22-24`       | 跨实例导入后接收方**引用/复核/验证表真的有行**，条数与包内一致 |
| IC11 | 导入会话的**只读 / 来源姿态**可见                                     | 侧车 `<id>.import.json`（`shared/session-package-import.ts:97-113`）→ 新增只读 IPC + 会话横幅 | ✅ **已落地（2026-10-04，v1.84.0 批次）**：新增 `sessions:import-posture`（读的是**运行守卫同一个**记录读取器，不造第二个"imported"概念）+ 组件 `SessionImportPostureBanner` 接进 `WorkspacePage`（按会话 id 绑定，切会话不留残影）；4 键 ×9 语；契约连锁 7 处计数（21 files / 201 tests 绿）。真机 `e2e/certification/session-import-posture.spec.ts` **1 passed (31.9s)**：**重启进程**后打开导入会话，横幅逐项等于记录字段（`Imported from <源项目>/<源会话> (app 1.83.0)` / `Exported 2026-10-04T11:15:46.084Z` / `Not verified on this machine`）+ 只读徽标；**同项目普通会话作负向对照**（横幅 0 命中） |
| IC12 | 迁移遗留副本的「**完成 / 丢弃**」                                     | `storage/migration-service.ts:225-233` 文案指向的动作                                         | ✅ **已落地（2026-10-04，v1.84.0 批次）**：marker 自带 `source/target/token/status` ⇒ 新增 `readStagedMoveAt` 从盘上解析，两个处理器改为「内存优先、否则读盘」，提交仍必须 `verified`（未完成副本具名拒绝）；`DataRootInspection.unfinishedMove` 携带状态（**不加枚举值**，避免值集漂移）；迁移弹窗新增 `unfinished` 段（`verified` ⇒ 完成/丢弃；`copying` ⇒ 只出丢弃）+ 面板不再禁用入口；4 键 ×9 语。**真机 `e2e/certification/storage-migration-unfinished.spec.ts` 2 passed (1.7m)**：用应用自己的 `migrate` 造未提交 marker → **重启** → 走真界面（设置→存储→文件夹栏→Continue→弹窗）→ 完成（读盘：新根出现 `workspaces`、marker 消失，且事前断言 marker 存在以免空洞）／丢弃（目标恢复 `kind:'move'`、marker 消失）。既有 `storage-migration.spec.ts` 3 passed 回归。**两处只有真机能暴露的缺口**：① 面板 `canChangeLocation = kind === 'move'` 把带 marker 的目录当死胡同、**禁用了唯一入口**（渲染测试与主进程测试都测不到）；② 面板自己重述的 `inspection` 局部类型**丢了新字段**（已改成复用 `DataRootInspection`） |

### 批次 4 · v1.84.0 —— 笔记本 / 运行时闭环（6 条）

| 单元 | 内容                                                        | 落点                                                                   |
| ---- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| IC13 | 窗口**直装 / 卸载包** ✅ **已落地且真机读数已取（2026-10-04）**：包对话框可直装（**含 pip 纯 pypi 包**）；**卸载在窗口这一侧结构性不可用**（见右栏与队列档，已立案）。 | `package-manager.ts:553,1115`；`RuntimesPanel.tsx:459-477,679-721`；新增 `runtime:manage-packages`（LOCAL，随附应用命令）、`RuntimePackageMutation{Result}`（共享层单一定义，主进程 `InstallResult` 改为别名） | **真机 `e2e/certification/packages-mutation.spec.ts` 1 passed (53.7s)**：lock-import 那套离线夹具（本机 micromamba + curated pack + `.env-ready`）在隔离实例建出受管环境，本地 `file://` simple 索引现搓合规 wheel ⇒ 窗口真装 pypi 包且**环境自己的解释器能 import** ✅；同时四段"应用原话"读数：卸载被 additive-only 规则拒、命名环境被**具名拒绝且默认环境未被误改**、非加法式规格被规则拒。取证中修掉四处（见队列档 §新立案）：pip 开关、静默改指防护、realpath 身份比对、对话框动作状态跨环境残留。**立案**：窗口无法完成卸载（准入只认会话绑定 ⇒ 窗口只到得了托管默认环境，而它按设计 additive-only）；命名环境不在窗口可达面。渲染测试 39 passed。 |
| IC14 | **会话级运行时绑定/切换** + 不可用原因 ✅ **已落地且真机读数已取（2026-10-04）**：预览里有了会话运行时条（列出启用运行时、标出在用、首次 bind 其后 switch、不可跑者禁用并给原因） | `runtime-binding.ts:59,151-169,207,225`；`NotebookPreview.tsx:640-665`；新增 `notebook:list-runtimes` / `bind-runtime` / `switch-runtime`（三通道复用既有 `NotebookRuntimeBindingOwner` 的 list/bind/switch，并同时注册为应用命令）、共享类型 `NotebookRuntimeBindingRequest` | **真机 `e2e/certification/notebook-runtime-binding.spec.ts` 1 passed (55.0s)**：隔离实例离线建出两个受管环境（`default-python` 与 `default-python-2`）⇒ 条纹列出 `conda: default-python · in use` 与 `conda: default-python-2` ⇒ 面板选中第二个（真重绑）⇒ 再切回第一个；每次写后条纹重读清单，`in use` 的移动是应用答案的呈现。**读数暴露并修掉一个真 UI 缺口**：会话尚无显式绑定时 listing 的 `bound` 全 false ⇒ 用户看不到在用哪个；`list` 现在"显式绑定优先，否则把该语言的受管默认标为在用"（名字或 `/envs/<name>/` 前缀识别），`runtime-service.test.ts` 184 passed。渲染测试 2 条。**原因上屏按诚实原则收窄**（真机不硬造），由渲染测试 + owner 单测覆盖；同批立案见队列档 |
| IC15 | 内核**常驻**「重启 / 关闭」（现在重启只在 R 装卸后出现） ✅ **已落地且真机读数已取（2026-10-05）**：实现由自主执行器落（`354741a5`，两条既有通道 + 常驻控件 `kernel-controls`/`kernel-restart-button`/`kernel-shutdown-button` + 回执 `notebook-kernel-notice` + 5 键 ×9 语 + 3 条渲染用例） | `notebook/ipc.ts:48,51`；`NotebookPreview.tsx:816-832`（新增常驻控件组与 `handleShutdown`，关闭走既有 `notebook.shutdown`、回执后 `loadNotebookState()` 重读真值） | **真机 `e2e/certification/kernel-controls.spec.ts` 1 passed (42.0s)**（本轮补，因渲染用例不算验收）：python 内核下两控件在场且 **enabled**、R 专用横幅缺席（正是本单元补的缺口——此前 python 内核无任何入口；enabled 是防空壳断言）→ 重启断言应用回执 `Kernel restarted` 且之后再跑 python cell 仍成功 → 关闭断言**另一句**回执 `Kernel closed`（证明界面报告的是这次动作而非留旧行）且之后能重新起内核。夹具配套：python 场景回执按 prompt 区分（#2/#3） |
| IC16 | **工作区环境准备遮罩加 Cancel** ✅ **已落地且真机读数已取（2026-10-04）**：preparing 态出 Cancel，接 store 的 `cancel(scope)`；`scope='upgrade'` 刻意不出按钮（附加式 upgrade 在运行时里既没有 abort controller、也会被 serialize 包装层丢弃语言级 cancel ⇒ 宁可不出，也不出点了没反应的按钮） | `EnvProvisionOverlay.tsx`（新增可选 `onCancel`）、`NotebookPreview.tsx:456-466,721-728`；复用 9 语字典已有的 `common.cancel` ⇒ 零新键、零契约计数涟漪 | **真机 `e2e/certification/env-provision-cancel.spec.ts` 1 passed (21.6s)**：替身 CDN（首次 manifest 500 ⇒ 错误态带 Retry；其后合法 manifest + 8KB/200ms 滴 16MB 包体 ⇒ 事件与进度都真）→ 真界面（设置→Runtimes→Download and set up→关设置）→ 遮罩报错带 Retry → 点 Retry → 遮罩 `preparing` 且 **Cancel 在场**（真遥测 `63.8 KB/s · 24.0 KB / 16.0 MB · ~4m 17s`）→ 点 Cancel → 断言 `provisioning:false` 且 `pythonReady:false`、面板仍如实说未就绪。**取证时抓到并修掉一个真缺陷**：`deriveProvisionUi` 只在 `status.provisioning` 为真时才给 preparing，而 store 为避开 React #185 写风暴刻意不逐 tick 重读状态 ⇒ 运行途中该标志恒为 stale-false ⇒ ui 停在 `ready` ⇒ 遮罩返回 null ⇒ **真机里 Cancel 永不出现**（单元测试把 `provisioning:true` 手动塞进 store，从未走过真实运行）。修法=进度 tick 本身即"有运行在飞"的证据 + 两条单测。**同批立案（未修）**：主进程的 provision **进度广播未送达渲染端 store**（实测包体已下到 2% / 39.8 KB/s / ETA 约 6m43s 持续一分钟，遮罩仍渲染为空；只有一次 status 重读——打开一次设置面板——才让门控与 Cancel 出现） |
| IC17 | 设置页下载明细（速度/ETA/续传，与工作区同源） ✅ **组件与单测已落 + 真机读数已取（2026-10-05，附一条如实记录的缺口）**：设置页准备卡片改用共享 `DownloadProgressLine` + `formatProgressLine`（与工作区横幅、更新对话框同一组件同一格式化器） | `shared/download-progress.ts`；`components/DownloadProgressLine.tsx`；`RuntimesPanel.tsx` 准备卡片段（原先只渲染 message + 裸进度条） | **真机 `e2e/certification/settings-download-detail.spec.ts` 1 passed (40.1s)**：替身 CDN（首次 manifest 500 ⇒ 卡片报错 ⇒ Retry 真走到滴包）⇒ 设置页卡片是活的，百分比 1→7 逐格推进（7 个不同采样）。渲染测试断言页面文本包含 `formatProgressLine` 自己的输出 + 续传态（40 passed）。**同批立案（未修）**：同一批 tick 里的富字段 `download`（速度/大小/ETA）没有到达渲染端（`hasSpeed=false`，30 秒内始终缺席），而工作区那侧在 IC16 读数里有 ⇒ 设置页目前只能显示粗百分比；修好后 IC17 的遥测那半才能纳入真机读数 |
| IC18 | 运行时来源（official / override）可见 ✅ **已落地且真机读数已取（2026-10-05）**：应用受管卡片上有一行来源（official / override + URL），2 键 ×9 语 | `shared/notebook-env.ts:35`（`ProvisionStatus.bundleSource`）；`RuntimesPanel.tsx` 受管卡片段；`environment-lifecycle-workflows.ts` 兜底状态（修复见右栏） | **真机 `e2e/certification/runtime-source-visibility.spec.ts` 1 passed (15.6s)**：应用指向本地覆盖地址 ⇒ 面板读到 `Runtime source: override (http://127.0.0.1:41999)`，且**无需先下载**（来源在面板已加载的状态里）。**读数钉出并修掉一个真缺口**：没跑过任何 provision 时状态走「无 provisioner 的兜底路径」（`createUnavailableLifecycle`）而该路径没有 `bundleSource` ⇒ 恰恰在用户最需要它（下载之前）时看不到；兜底状态现在也上报来源（环境变量解析；注释里写明"经 provisioner 选项配置的覆盖在此路径不可见"的局限）。渲染测试 3 态（无 status 不显示 / override 显 URL / official 不显 override），41 passed |

### 批次 5 · v1.85.0 —— 自定义 MCP / 连接器闭环（6 条）

| 单元 | 内容                                                                               | 落点                                                                                              |
| ---- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| IC19 | 自定义服务器**详情 + 逐工具权限**（`getConnectorDetail` 现对自定义 id 直接 throw） | `connector-settings.ts:172-194`；`ConnectorsPanel.tsx:705-771`                                    |
| IC20 | 自定义服务器「**跳过审批**」开关                                                   | `connector-settings.ts:249-253`；`ConnectorDetailView.tsx:117-131` 的 `CustomServerView` 无该字段 |
| IC21 | 自定义服务器**登出 / 撤销登录**                                                    | `connector-settings.ts:480-494`；`ConnectorsPanel.tsx:738-759`                                    |
| IC22 | **可用性徽标**（unavailable / unauthenticated）并禁用对应开关                      | `connector-settings.ts:534-572`                                                                   |
| IC23 | **连接测试**（探活 + 工具清单预览）                                                | `mcp-client-manager.ts:136-160`                                                                   |
| IC24 | **批量启停**纳入自定义服务器                                                       | `ConnectorsPanel.tsx:399-409,608-662`                                                             |

### 批次 6 · v1.86.0 —— 文献 / 期刊闭环（6 条）

| 单元 | 内容                                                   | 落点                                                                           |
| ---- | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| IC25 | 文献**附件历史**（被替换 PDF 可回看）                  | `references/repository.ts:181-206` 已返回 `pdfVersions`                        |
| IC26 | 文献 **notes** 可读写（现无 IPC、窗口不显示）          | `references/repository.ts:404-419`；`references/ipc.ts`                        |
| IC27 | 期刊指标**整表同一指标**导入（`defaultKind`）          | `journal-metrics.ts:44-45,283-284`；`JournalMetricsImport.tsx:56-58`           |
| IC28 | 期刊指标**上限**筛选（`maxImpactFactor`）              | `journal-metrics-overview.ts:51-52,160-165`；`JournalMetricsPanel.tsx:317-326` |
| IC29 | 指标**手工订正 + 单刊 claim 历史**（append-only）      | `journal-repository.ts:308-345,371-385`（`appendMetric`/`listMetrics` 无 IPC） |
| IC30 | 导入**逐行归属**反馈（归到哪刊、按什么匹配、是否新建） | `journal-metrics.ts:76-100`；`JournalMetricsImport.tsx:120-132`                |

### 批次 7 · v1.87.0 —— 出网 / 存储 / 视觉 / 诊断的可核性（8 条）

| 单元 | 内容                                                            | 落点                                                              |
| ---- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| IC31 | egress 读失败有错误态+重试；写失败回滚或并入写入协调器          | `NetworkPanel.tsx:326-344`                                        |
| IC32 | egress 接管时手动代理**显式禁用并说明**                         | `proxy-runtime.ts:3-4`；`NetworkPanel.tsx:507-528`                |
| IC33 | 出网审批卡**剩余有效期** + 超时具名解释                         | `shared/egress.ts:133-139`；`EgressApprovalCard.tsx`              |
| IC34 | 存储信息读取失败的错误态 + 重试                                 | `StoragePanel.tsx:115-117`                                        |
| IC35 | 迁移 `staleEvidence` **明细展开**（path/runId/project/session） | `shared/storage.ts:65-78`；`StorageMigrationModal.tsx:330-342`    |
| IC36 | **视觉转译证据**只读面（哪张图由哪个模型转译成什么）            | `vision/vision-evidence-repository.ts:50-73` 只写不读             |
| IC37 | 支持包导出回读**体积与脱敏条数**                                | `support-bundle.ts:52-57`；`GeneralPanel.tsx:103-115`             |
| IC38 | 远程访问关闭态仍显示已保存的公网地址（只读+复制+失效说明）      | `shared/remote-access.ts:53-54`；`RemoteControlPanel.tsx:432-465` |

### 批次 8 · v1.88.0 —— 算力与引擎（4 条）

| 单元 | 内容                                                              | 落点                                                                                                     |
| ---- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| IC39 | **取消**排队/运行中的远程任务（现只有 poller 超时内部 kill）      | `compute/ipc.ts`、`job-poller.ts:566-575`；`JobDetailModal.tsx`                                          |
| IC40 | 后台交付 **needs-attention 全局可见**（inbox 通知或全局交付视图） | `background-delivery.ts:26-45`；`JobDeliveryLedger.tsx:88-123`                                           |
| IC41 | 按会话清除完成通知（IPC+store 已有，**无人调用**）                | `notification-inbox-ipc.ts:26-29`；`notification-inbox-store.ts:11,67-74`                                |
| IC42 | **引擎面板**：可用性矩阵 + 权重下载同意门与进度                   | `engines/alphafold-lookup.ts:61`、`model-weight-cache.ts:48`、`shared/engine-catalog.ts:152`（现零入口） |

### 批次 9 · v1.89.0 —— 记忆溯源与审查明细（3 条）

| 单元 | 内容                                                                                                                          | 落点                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| IC43 | 记忆溯源**补生产者**：写 `supersededBy`（取代链）与 `lastSurfacedAt`（recall 注入时回写）；面板给「本会话回忆自记忆」只读列表 | `shared/settings.ts:450-452`（现只声明 + 持久化校验，零写入方）；`memory-recall.ts:27` |
| IC44 | 记忆笔记**搜索/过滤**（文案已承诺 searchable）                                                                                | `MemoryPanel.tsx`；`i18n/en.ts:746`                                                    |
| IC45 | RO-Crate 失败**说得清哪条 MUST 没过** + 拒收清单展开                                                                          | `shared/ro-crate.ts:636-1032`；`RoCrateExportDialog.tsx:105-132`                       |

### 批次 10 · v1.90.0 —— 拍板项与死面清理（6 条）

> 这一批的性质是 v1.73「建入口或归档」的翻版：**二选一给出结论**，不许留「有面没人用 / 有文案没功能」。

| 单元 | 内容                                                                                              | 需拍板的问题                                   |
| ---- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| IC46 | `handoff.list` / `handoff.retry` **择一正本**（UI 现全走 `specialist.*`，该面为死面且未登记归档） | 迁 UI 到 handoff 面，还是删面并从 catalog 移除 |
| IC47 | 通知**单条删除 / 清空**                                                                           | 做，还是把 `deleteSessions` 登记为内部清理     |
| IC48 | **RO-Crate 导入**与外部 crate 校验（`validateRoCrate` 可复用但从未用于外来 crate）                | 立项做互操作，还是明确只做导出                 |
| IC49 | 期刊**合并可撤销**（现无解绑别名/拆分入口）                                                       | 做撤销，还是在 UI 明写「合并不可逆」           |
| IC50 | 技能**导入版分叉为个人技能**                                                                      | 做分叉，还是明写「导入版只读」                 |
| IC51 | 设置搜索补 **egress / 白名单 / 域名** 关键词                                                      | 可直接做（无争议），随本批扫尾                 |

## 3. 关键路径与依赖

```
v1.81.0（IC1–IC5，已立案收口 + 文案清账）← **必须先做**：v1.81.0 这个号已对外立案
（`plan-2026-10-02-R2-U4-journal-alias-merge.md:124`），挪号就要改那份文件；本批体量小，可当天收口
v1.82.0（IC6–IC9，挂载点四条）← 紧随其后，四条互不依赖、单轮可收口、用户当轮可见
   └─ IC8 依赖 A7 已完成（✅ v1.80.0）
v1.83.0（数据不丢）
   ├─ IC10/IC11 共用一次会话包读侧改动 ⇒ 同一版本边界内做，别拆两版
   └─ IC12 的 marker 场景需要一次「造崩溃」的真机复现，先写夹具再改代码
v1.84.0 IC13（窗口直装包）除 IC19 外无依赖，但**必须走安装授权校验**（不是绕过它）
v1.85.0 IC19 会让 `getConnectorDetail` 支持自定义 id ⇒ IC20/IC22/IC23 都建在它上面，IC19 先落
v1.86.0 IC27/IC28/IC29/IC30 共用 `journal-metrics*` 契约 ⇒ 一次改契约，四次验收
v1.88.0 IC42（引擎）是新通道组（engine:*），需要契约 + 生成式 API 映射 + 9 语，**单独立项文件**
v1.89.0 IC43 若决定不做生产者，则必须**同时删掉字段与徽标与 9 语翻译**（不留空壳）
```

## 4. 对标驱动的批次（另立，不与上面抢版本号）

| 项   | 来源                                                                               | 建议落点                                                                                                                                               | 前置                      |
| ---- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| IC52 | 对手 #3140 会话级重放 + 讨论录制步骤                                               | 新批次，复用 `replay-runner` / `WriteAuditPanel` / `RunMarksRail`；先做「只读重放视图 + 对某一步提问」，**不做整会话确定性复现**（对手自己也列为未做） | 单独立项文件              |
| IC53 | S3 增量全文索引（既有 B 段）                                                       | 索引 + 失效策略 + 验收                                                                                                                                 | —                         |
| IC54 | M2 本地解析模型资产（既有 B 段）                                                   | **无已发布 SHA256 的权重不下载**                                                                                                                       | IC42 的权重同意门先有形态 |
| IC55 | 连接器补件第二/三批（reference #10 + PDB 序列 / GEO 矩阵 / Cellosaurus / Monarch） | 并入下一个连接器批，一次铺完再验收                                                                                                                     | —                         |
| IC56 | Windows 交付面（标题栏菜单 #3201 + 代码签名 reference #9）                         | **等证书与主体拍板**；两项一起做，避免零散改平台代码                                                                                                   | 证书                      |

## 5. 发版号分配规则（写死，防撞号与提前写 CHANGELOG）

1. **一批 = 一个版本号**；批次内不许跨版本混做，也不许一版只塞半条。
2. 版本号在**批次开工时**才写进 `package.json` 与 CHANGELOG 草稿；**未开工的版本号不出现在任何已发布文档里**。
3. 纯文档 / 测试 / 读数改动**不占号**（归入相邻版本的「明确没做、已立案的」或直接落档）。
4. 批次内某单元被证明是「审计归档」（面窄低值、架构已覆盖）⇒ 按 v1.72 那版口径**落档即算完成**，但要写明结论，不许默默丢掉。
5. 发版窗口内**停止并发推送**（`cancel-in-progress` 会把 Release 腰斩）；打 tag 前门禁必须全绿且 `git status` 干净。
6. 版本号与主题的对应关系一旦发布**不改**；后续修正只能在新版本里写「更正」。

## 6. 与既有队列的关系（防两个执行体撞车）

- 本排期**接管** `docs/plan-2026-10-03-next-queue-and-round-convention.md` 的 **D 段**（那 52 条的正式排期就是本文件）。
- 该文件的 **A 段**：第 1 条已完成；第 2 条 → IC2；第 3 条 → IC1；第 4 条 → IC3；第 5 条 → IC4；第 9 条 → IC5；
  第 6 条（`acp:state` ack）与第 7 条（`timeoutMs` 定位）**保持独立挂账，未分配版本号**（先定位再评，不凭旧账断言）。
- 该文件的 **B 段**：第 2/3 条 → IC53 / IC54。
- 该文件的 **C 段**（官方目录不可达）：维持阻塞，不动。
