# 入口层与交互闭环审计（全软件扫描，2026-10-03）

> 触发：用户要求「整体软件扫描一遍，找出能力本体存在或半存在、入口/交互层缺失的地方」。
> 方法：先做**通道级**全量对账（主进程注册通道 × 契约目录 × 窗口调用点），再由 6 个域并行审计「功能流层」闭环。
> 口径：能力存在须给 `file:line`；缺失须给可复现 grep（含 `→ 0`）；`src/shared/entry-layer-archived-surfaces.ts` 已登记的 agent-only 面不计缺口。
> 复核：标 ✅ 的行为本会话亲自复跑过的 grep（复核命令见 §4）；未标者为域审计给出、锚点齐备但未二次复跑。

---

## 0. 通道级对账结论（先说结论：这一层已经不漏了）

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 主进程注册通道 vs 契约目录 | 9 条疑似「未被目录声明」，逐条核对后**全部**在目录里（分组正则在多行条目上漏匹配所致），真差 0 | `grep -n "runtime:set-environment-enabled\|file:save-managed\|compute:session:status" src/shared/renderer-contract-catalog.ts` |
| 契约目录 449 项 vs 窗口真实调用点 | 47 项「无 `<x>.member(` 形态调用」，其中 11 项已在归档表；其余 36 项逐条复核后**全部是解构写法**（`const f = window.api?.cap?.member`）造成的误判 | `grep -rn "probeAvailability\|checkConnectivity\|listKinds" src/renderer/src` 均命中解构行 |
| 窗口全库（除测试与 9 语字典）成员名零命中 | **仅 1 条**：`settings.setUiLanguage`，而它由 `i18n/index.tsx:81` 调用（被字典排除规则误伤）⇒ 真差 0 | `python3 复核脚本`（见 §4） |
| 渲染层孤儿文件（无生产 import） | 8 个，全部是 worker / 测试夹具 / 动态加载入口 | `components/Versions.tsx`、`previews/tiff-preview-worker.ts` 等 |
| 设置面板 vs 导航 id | 20 个 `SettingsPanelId` 与 20 个面板组件一一对应，无「有面板无入口」 | `settings-navigation.ts:3-23` |
| 既有守卫 | `renderer-contract-entry-coverage.test.ts` 5 passed（含归档表双向诚实性） | 复跑通过 |

**结论**：v1.69–v1.74 那一轮入口层治理把**通道级**缺口清干净了。本轮的 54 条缺口全部在**功能流层**——IPC 通、preload 通、能力通，缺的是「用户看得见 / 点得到 / 闭环得起来」的那一半。

---

## 1. P0：能力已在、用户却「走不到 / 看不见 / 没退路」（9 条）

| # | 能力 | 主进程/shared 锚点 | 体验层现状 | 缺口 | 复核 |
| --- | --- | --- | --- | --- | --- |
| P0-1 | 计算任务产物清单（featured / 留在远端 / 收割失败） | `src/shared/compute.ts:328-332`；`compute/job-notifier.ts:193-196` | `JobDetailModal.tsx:225-226` 仅一行**注释占位**，组件不存在 | 任务跑完看不到产生了哪些文件、哪些留在远端 | ✅ `FeatureOutputs\|featured_files\|left_on_remote` → 0 |
| P0-2 | 取消排队中/运行中的远程任务 | `compute/ipc.ts` 无 cancel 通道；`job-poller.ts:566-575` 仅超时内部 kill | 无按钮 | 任务跑飞只能等 timeout，用户无法中止 | ✅ `cancelJob\|jobs:cancel` → 0 |
| P0-3 | 通知到达实时点亮未读红点 | `notifications:changed` 事件 + `notification-inbox-controller.ts:119` | `notification-inbox-store.ts:76-97` 有 `listen()`，**全渲染层无人调用**；铃铛只在自己被点开时 `refresh()` | 新通知到达时红点不亮，用户不知道去点 | ✅ `listen()` → 0 |
| P0-4 | 会话包随包证据（citations / review-findings / verifications） | `session-package/import.ts:22-24` 列为**强制**证据；`export.ts:90-92` 确实写入 | `import-session.ts:79` 只读 `{ only: ['conversation.json'] }` | 只落对话、丢弃全部随包证据，接收方拿到的会话没有任何证据 | ✅ 唯一 `only:` 命中即该行 |
| P0-5 | 导入会话的「只读 / 来源」姿态 | `session-package-import.ts:97-113`（侧车 `<id>.import.json`）；`main/ipc.ts:2146-2147` | 渲染层 0 命中，会话在侧栏与普通会话无异 | 用户只能发一条消息被拒才知道是只读，看不到来源会话/导出版本/发送方声明 | — |
| P0-6 | 产物用系统程序打开 / 在文件夹中定位 | `artifacts/ipc.ts:246-259,532`（`shell.openPath` + provenance 解析） | `PreviewFileSurface.tsx` 只有 compare/edit/provenance | 后端 + 通道 + preload 全齐，窗口零调用点 | ✅ `artifacts.openFile` → 0 |
| P0-7 | 崩溃后遗留的迁移暂存副本「完成 / 丢弃」 | `storage/migration-service.ts:225-233`；`storage:commit-and-relaunch` / `discard-migrated-copy` 均需 `targetPath` | `StoragePanel.tsx:226-228` 只把该目录判 invalid 并显示「Finish or discard that move」 | **文案指向一个不存在的按钮**：重启后无人能触发，用户被卡死 | — |
| P0-8 | 命名环境（含 A7 锁导入环境）的删除与「用作运行时」 | `notebook/environment-management.ts:70-115`（create/list/remove） | `RuntimesPanel.tsx:604-724` agent-created 卡只有启用开关 + 只读包列表；`:338` 注释自陈「belongs to the agent's own binding flow」 | **A7 刚导入的环境对用户是死路**：删不掉、也选不了 | ✅ `manageEnvironments\|removeEnvironment\|EnvironmentInfo` → 0 |
| P0-9 | 引擎层（AlphaFold 查询 / 权重按需下载 + 同意门 / 可用性） | `engines/alphafold-lookup.ts:61`、`engines/model-weight-cache.ts:48`、`shared/engine-catalog.ts:152` | 渲染层零引用，只被投影进 compute 技能文档 | 权重下载的 consent 门在窗口侧**无处授予**；引擎可用性用户不可见 | ✅ 四个符号 → 0 |

---

## 2. P1：半截——闭环缺一半、或结果被丢弃（26 条）

### 2.1 笔记本 / 运行时（域 2）

| # | 能力 | 缺口 | 锚点 | 复核 |
| --- | --- | --- | --- | --- |
| P1-1 | 窗口直装 / 卸载包 | 「允许安装包」开关给了许可，窗口**没有任何安装/卸载动作**——单向许可 | `package-manager.ts:553/:1115`；`RuntimesPanel.tsx:459-477,679-721` | ✅ `installPackages\|managePackages` → 0 |
| P1-2 | 会话级运行时绑定/切换 | 主进程有完整 bind/switch + 不可用原因，仅经 notebook MCP 给 agent；窗口 env 选择器只按已出现过的环境名过滤 | `runtime-binding.ts:59,151-169,207,225`；`NotebookPreview.tsx:640-665` | ✅ `bindRuntime\|switchRuntime` → 0 |
| P1-3 | 通用内核重启 / 关闭 | 无主动重启（只在 R 装卸后条件出现）；关闭内核无按钮 | `notebook/ipc.ts:48,51`；`NotebookPreview.tsx:816-832` | — |
| P1-4 | 工作区环境准备遮罩的取消 | 遮罩只有 Retry，主进程与 store 都有 `cancel(lang)` | `env-ipc.ts:27`；`EnvProvisionOverlay.tsx:55-64` | — |
| P1-5 | 设置页下载明细 | 同一条 provision 事件流，工作区有速度/ETA/续传，设置页只有百分比 | `shared/download-progress.ts`；`RuntimesPanel.tsx:809,919-935` | — |
| P1-6 | 运行时来源（官方源 vs 覆盖源） | 主进程回传 `bundleSource`，窗口从不显示 | `shared/notebook-env.ts:35`；`provisioner.ts:765,1786-1800` | ✅ `bundleSource` → 0 |

### 2.2 专才 / 技能 / 连接器（域 3）

| # | 能力 | 缺口 | 锚点 | 复核 |
| --- | --- | --- | --- | --- |
| P1-7 | 自定义 MCP 服务器详情 + 逐工具权限 | 「查」只到 list；`getConnectorDetail` 对自定义 id 直接 throw | `connector-settings.ts:172-194`；`ConnectorsPanel.tsx:705-771` | — |
| P1-8 | 自定义服务器「跳过审批」 | 策略层支持，窗口 0 入口（开关只在内置详情页） | `connector-settings.ts:249-253`；`ConnectorDetailView.tsx:117-131` | ✅ `autoAllow` 9 命中全在内置详情页 + store slice |
| P1-9 | 自定义服务器登出 / 撤销登录 | 只有「登录」，token 清不掉，只能删整台服务器 | `connector-settings.ts:480-494`；`ConnectorsPanel.tsx:738-759` | — |
| P1-10 | 自定义服务器可用性徽标 | 主进程投影 `unavailable`/`unauthenticated`，列表不显示，开关点了会被快照回弹 | `connector-settings.ts:534-572` | — |
| P1-11 | 自定义服务器连接测试 | 无探活/工具清单预览，只能盲目保存再开 | `mcp-client-manager.ts:136-160` | ✅ `listTools` → 0 |
| P1-12 | 自定义服务器批量启停 | 批量只作用内置连接器 | `ConnectorsPanel.tsx:399-409,608-662` | — |

### 2.3 文献 / 期刊 / 筛选 / RO-Crate（域 1）

| # | 能力 | 缺口 | 锚点 | 复核 |
| --- | --- | --- | --- | --- |
| P1-13 | 文献附件历史（被替换 PDF） | list 已返回 `pdfVersions`（上限 20），窗口 0 渲染 | `references/repository.ts:181-206` | ✅ `pdfVersions` → 0 |
| P1-14 | 文献备注 notes | store 能写、导入时写，**无 IPC handler、窗口不显示不可编辑** | `references/repository.ts:404-419` | — |
| P1-15 | 期刊指标「整表同一指标」导入 | shared 支持 `defaultKind`，窗口只发 `{format,text}`，这类表**整表失败** | `journal-metrics.ts:44-45,283-284` | ✅ `defaultKind` → 0 |
| P1-16 | 期刊指标上限筛选 | 过滤支持 `maxImpactFactor`，窗口只暴露下限 | `journal-metrics-overview.ts:51-52,160-165` | ✅ `maxImpactFactor` → 0 |
| P1-17 | 期刊指标手工订正 + 单刊历史 | `appendMetric`/`listMetrics` 无 IPC、无入口，错值只能重导整表 | `journal-repository.ts:308-345,371-385` | ✅ `appendMetric` 在渲染层 → 0 |
| P1-18 | 期刊指标逐行归属反馈 | 界面只显示 line/kind/value/year，不显示归到哪刊、按什么匹配 | `journal-metrics.ts:76-100`；`JournalMetricsImport.tsx:120-132` | — |
| P1-19 | 筛选逐条失败/暂停原因 | 快照只带聚合计数，逐条 `failureKind`/`deferredReason` 不过桥，无「仅重试失败项」 | `references-screening.ts:66-71,147-154` | ✅ 三符号 → 0 |
| P1-20 | 筛选 AI 概率分布 | `ScreeningProbabilities` 随条目过桥，窗口从不展示 | `references-screening.ts:94-98,229` | ✅ `probabilities` → 0 |
| P1-21 | RO-Crate 断言明细与拒收清单 | 结果带 `assertions[]` 与 `refused[]`（含四值 reason），对话框只渲染计数 | `shared/ro-crate.ts:636-1032`；`RoCrateExportDialog.tsx:105-132` | — |

### 2.4 算力 / 通知 / 交付（域 4）

| # | 能力 | 缺口 | 锚点 | 复核 |
| --- | --- | --- | --- | --- |
| P1-22 | 按会话清除完成通知 | IPC + store 方法齐备，无任何消费者 | `notification-inbox-ipc.ts:26-29`；`notification-inbox-store.ts:11,67-74` | — |
| P1-23 | 后台交付 needs-attention 可见性 | 只在对应任务详情弹窗内可见，无通知、无全局交付视图 | `background-delivery.ts:26-45`；`JobDeliveryLedger.tsx:88-123` | — |

### 2.5 产物 / 记忆（域 5）

| # | 能力 | 缺口 | 锚点 | 复核 |
| --- | --- | --- | --- | --- |
| P1-24 | 记忆溯源字段 `supersededBy` / `lastSurfacedAt` | **有 UI、有 9 语翻译、无生产者**：徽标永远不可能出现；recall 注入后不落 `lastSurfacedAt` | `shared/settings.ts:450-452`；`MemoryPanel.tsx:538-551` | ✅ 仅声明 + 持久化校验，零写入方 |
| P1-25 | 记忆笔记搜索 | 面板文案承诺 searchable，无任何检索控件 | `MemoryPanel.tsx`；`i18n/en.ts:746` | — |

### 2.6 设置 / 存储 / 出网 / 视觉（域 6）

| # | 能力 | 缺口 | 锚点 | 复核 |
| --- | --- | --- | --- | --- |
| P1-26 | 出网白名单读写失败回读 | 读失败永久 Loading；写失败乐观保留不报错不回滚，也不进写入协调器 | `NetworkPanel.tsx:326-344` | — |
| P1-27 | egress 开启时手动代理被静默忽略 | 代理区照常可编辑可保存，无「已由白名单接管」提示 | `proxy-runtime.ts:3-4`；`NetworkPanel.tsx:507-528` | — |
| P1-28 | 存储信息读取失败无错误态 | `getInfo().then(setInfo)` 无 catch ⇒ 数据位置卡永久「加载中」 | `StoragePanel.tsx:115-117` | — |
| P1-29 | 迁移陈旧证据（staleEvidence）明细 | 类型带 path/runId/project/session，UI 只显示条数，无查看/重校验动作 | `shared/storage.ts:65-78`；`StorageMigrationModal.tsx:330-342` | ✅ 3 命中全为 `.length` |
| P1-30 | 视觉转译证据（visionEvidence） | 只写不读：用户看不到哪张图由哪个模型转译成了什么 | `vision/vision-evidence-repository.ts:50-73` | ✅ `visionEvidence` 在 shared/renderer → 0 |
| P1-31 | 远程访问关闭态的公网地址 | `remoteItPublicUrl` 从不渲染，关掉就再也看不到 | `shared/remote-access.ts:53-54`；`RemoteControlPanel.tsx:432-465` | ✅ → 0 |
| P1-32 | 出网审批卡剩余有效期 | 请求带 `expiresInSec`，卡片不显示倒计时，超时凭空消失无解释 | `shared/egress.ts:133-139`；`EgressApprovalCard.tsx:11-78` | — |
| P1-33 | 支持包导出结果回读 | 只回显保存路径，忽略 `bytes` 与 `redactions`（脱敏条数） | `support-bundle.ts:52-57`；`GeneralPanel.tsx:103-115` | — |

---

## 3. P2：文案 / 多语言 / 可发现性 / 死面清理（19 条）

| # | 项 | 缺口 | 锚点 |
| --- | --- | --- | --- |
| P2-1 | 核验清单面板硬编码英文 | `'open/resolved/unaddressed'`、`'Reopen'`、`'re-flagged ×N'`、`'assessed ×N'`（9 语用户看到英文状态词） | `VerificationChecklistPanel.tsx:51-55,119,122,145`；`ReviewerCard.tsx:100` |
| P2-2 | 产物溯源 `Source` 表头 | 同表其它表头已 i18n，唯此硬编码 | `ArtifactProvenancePanel.tsx:1290` |
| P2-3 | 项目文件索引修复按钮 | `'Retrying...' / 'Retry'` 漏网（U6 清过同类） | `ProjectFilesView.tsx:1869` |
| P2-4 | 存储迁移弹窗文案 | Cancel / Elapsed / Don't quit / Data moved / Browse… / Checking… 硬编码英文——**最危险的操作里是英文** | `StorageMigrationModal.tsx:262,298,304,308,396,412`；`StoragePanel.tsx:309,369,461` |
| P2-5 | 设置搜索缺「出网/白名单」关键词 | 按 egress/出网/白名单 搜设置搜不到入口 | `SettingsPage.tsx:247-258`；`settings-panel-search.ts:10-17` |
| P2-6 | `handoff.list` / `handoff.retry` 为死面 | main 已安装，渲染层 0 调用（UI 全走 `specialist.*`）；`list/retry` 未登记归档，靠守卫宽松匹配漏过 | `agents/handoff-lifecycle-ipc.ts:30-35`；`grep -rn "api.handoff" src/renderer/src` → 0 |
| P2-7 | 通知单条删除 / 清空 | 只能标已读；`deleteSessions` 为内部清理，无 IPC | `notification-inbox-repository.ts:237-251` |
| P2-8 | RO-Crate 导入 / 外部 crate 校验 | 只有单向导出；`validateRoCrate` 可复用但从未用于外部 crate | `ro-crate/ipc.ts:229-232` |
| P2-9 | 期刊合并不可撤销 | 合并会迁移并删源行，无解绑别名/拆分入口，误合并无法回退 | `journal-repository.ts:271-282,409-413` |
| P2-10 | 技能导入版不可编辑、无分叉 | 编辑仅 `source==='personal'`；导入技能只能删或重导覆盖 | `skill-catalog.ts:320-328`；`SkillsPanel.tsx:808-814` |

---

## 4. 复核命令（本会话亲跑）

```bash
# 通道级：契约目录条目 × 窗口调用点 → 只剩 1 条误伤
python3 /Users/totota/.hermes/cache/scratch/comp/audit-residue.py      # → settings.setUiLanguage（实由 i18n/index.tsx:81 调用）

# 既有守卫
npx vitest run src/shared/renderer-contract-entry-coverage.test.ts     # → 5 passed

# P0/P1 关键断言（全部 0 命中才判缺口）
for p in pdfVersions defaultKind maxImpactFactor appendMetric installPackages \
         downloadModelWeights bindRuntime listTools featured_files cancelJob \
         "listen()" "artifacts.openFile" remoteItPublicUrl visionEvidence bundleSource; do
  printf '%-24s %s\n' "$p" "$(grep -rn "$p" src/renderer/src --include=*.ts --include=*.tsx | grep -vc '\.test\.')"
done
# autoAllow（9）与 supersededBy/lastSurfacedAt（11）与 staleEvidence（3）逐条看过：命中全在「内置详情页 / 声明+持久化校验 / 只取 .length」，与缺口判定一致。
```

---

## 5. 未复核项与诚实边界

- 域审计给出的 54 条中，本会话**亲自复跑 17 条**（§1–§3 标 ✅ 者）；其余 37 条锚点齐备（均含 `file:line`），但**未二次复跑**——按纪律不写成「已验证」。
- 「能力存在」一侧的判定来自域审计的 `file:line` 引用，未逐条打开复核。
- 反例（明确不计入缺口）：`NetworkPanel.tsx:39-40` 注释仍称出网白名单「intentionally not built here」，与已实现事实不符，属**注释漂移**，非用户可感知缺口。
- 已知既有挂账不重复报：按会话诊断包导出（域审计确认仍只支持整机）、官方技能/专才目录不可达、A7 下载路径与真窗口点动两条读数。

---

## 6. 建议排序（并入既有队列，不新开平行计划）

1. **先做 P0-1 / P0-3 / P0-8 / P0-6**：四条都是「后端全齐、只差一个挂载点」，单轮可收口，且立刻可被用户感知（任务产物、通知红点、A7 环境删除、产物系统打开）。
2. **再做 P0-4 / P0-5 / P0-7**：涉及数据落库（随包证据）与用户退路（迁移遗留副本），需要迁移或 IPC 面，单独立项。
3. **P1 按域成批**：笔记本/运行时一批（P1-1…P1-6）、自定义 MCP 一批（P1-7…P1-12）、文献/期刊一批（P1-13…P1-18）。
4. **P2 作为「文案与死面清理」一批**，与下一个发版窗口合并，零散改动能一次走完门禁。
