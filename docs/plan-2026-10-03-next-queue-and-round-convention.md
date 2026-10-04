# 下一阶段队列与轮次约定（2026-10-03 起用；每轮开工前先读这一份）

> 本文件由用户与会话共同定稿，写给**自主执行器的每一轮**。两件事：**收口约定**（别把半成品留给下一轮）与
> **排序**（每轮都能有"完成项"落地，而不是几天都在同一片里打转）。

## 一、收口约定（硬要求，违反等于这轮白跑）

今晚实测账（三个片，三次都由人手补收尾）：

| 轮次          | 产出                | 收口                                                             |
| ------------- | ------------------- | ---------------------------------------------------------------- |
| 21:17         | U3 筛选面           | ✗ 留 **37** 个未提交文件                                         |
| 23:40 + 01:56 | U4 整片             | ✗ 两轮合计 **35** 文件仍未提交                                   |
| 10:27         | v1.80.0 落账 + 发版 | ⚠ 提交了，但**门禁未全绿就打 tag** ⇒ Release 失败，需删 tag 重建 |

**规则**：

1. **每轮结束前必须提交**（`git add <你改的文件> && git commit`）。能推就推（`HUSKY=0 git push origin main`）。
2. **确实提交不了**（例如门禁红、需求中途变了）时，**必须**在持久记事本里留下三行，让下一轮和用户都能看到：
   ```bash
   hermes cron notepad 2be4405e5dc6 set round-intent   "本轮打算做什么"
   hermes cron notepad 2be4405e5dc6 set round-outcome  "做到哪一步 / 卡在哪（要具体到文件与报错）"
   hermes cron notepad 2be4405e5dc6 set round-next     "下一轮该从哪里继续"
   ```
   读取：`hermes cron notepad 2be4405e5dc6 list`。
3. **不许在工作区不干净时打 tag 或发版**。发版前最低门禁：`npm run typecheck`、`eslint <改动路径>`、
   相关 `vitest`（含 `src/shared/renderer-contract-entry-coverage.test.ts`）**全绿**，且 `git status` 干净。
4. **发版窗口内不许有并发推送**：发版期间把别的活停住（用户的 cron 也应暂停），否则 `cancel-in-progress`
   会把 Release 作业腰斩。
5. **不要重跑单个 job 来救失败的 Release**：会产生同名重复产物，`publish` 聚合会报 `missing`。
   正确做法是**删 tag 重建**（该 tag 没有 Release 页时），或按 `docs/plan-2026-10-03-v1.80.0-release-recovery.md` 走。

## 二、排序（小件优先，大件靠后）

**原则**：一轮≈2 小时、能收口的活优先——每轮都留下一笔"已完成"，而不是几天滚同一片。

### A. 小件 / 取证

**归属与防重做（2026-10-03 定，专治"两个执行体做同一件事"）**：

- **A 段默认由会话（人 + 助手）负责**——它们要拍板、要真机读数、要动发布窗口；
  **执行器优先推进 B 段大件**（可无人值守、跨多轮），A 段没人动时才接手。
- 执行器**每轮开工前必须先看**下面的「已完成清单」+ `git log --oneline --since="3 days ago"`；
  **清单里已有的不许重做**。若 A 段某项目 **≥3 天无人动**，执行器可接手，并在提交信息里写明
  「接手 A 段第 N 项」。
- **会话完成某项后必须在本清单追加一行（项目 + 提交 sha）**——不追加，执行器无从得知，就会重做：
  这正是要避免的那笔浪费。

**已完成（别再重做）**：R2 U1/U2 实体与解析落库（`b4509920`）· 指标导入（`041146dd`）·
U3 筛选/统计面（`8b074459`）· 面板 DOM + 筛选控件读数（`c4ef3189`/`fc21385c`）·
U4 别名合并 + `displayName`（`f0b0e218`）· 导入侧真机读数（`d1a96860`）·
指标导入界面 9 语种 + 摘除 agent-only 登记（`ed9fc653`）· 主色对齐 `#4D6BFE`（`d202b18e`）·
清账（`2f8c3def`）· CI 堆上限加固（`341fc231`）·
**v1.80.0 发布**（`f690b85a` 首次 tag → 偶发用例修复后**重建 tag** `f2a97d87`，21 资产、正文 13,535 字节）·
**A1 v1.80.0 发布记录更正**（`0fabd2e6` + 格式 `d71a9331`：改为「已发布」实际结论，21 资产 / run `37099590863` 全绿 /
`sourceSha=f2a97d87…` / mac 未签名已披露）·
**A7 外部锁导入**（S1 能力 `cd2bd978` + S2/S3 通道与界面 `83a2cdbc` + 真机三缺陷修复 `9b0496f1`：`runtime:import-lock` 单通道 +
RuntimesPanel 导入对话框 + 9 语种 13 键 + 契约计数连锁 + 真机读数 `docs/evidence/2026-10-03-A7-external-lock-import.md`
——82 条真锁离线导入、conda-meta 逐条一致、0 下载、解释器真跑 `[3,12,13]`；坏 md5/缺件都具名失败不建环境）。
**A7 真窗口读数已取**（`9b0496f1`，`e2e/certification/lock-import.spec.ts` = passed）：界面原文
「Imported “lock-import-env” — 82 packages (82 from cache, 0 downloaded)」+ 失败路径具名原因上屏；
这一跑额外揪出并修掉三个单测漏掉的真缺陷（启动自检计数 344→345 导致应用 fail-fast、对话框页脚越界、
管理器丢 `this`）。
**⚠️ A7 仅剩一条读数（已立案，见 evidence §5.2）**：**下载路径**（`allowDownload:true` 从锁 URL 取包 + 校验后建成环境）未实测；
另记一条产品决策（具名环境不出现于 Settings→Runtimes 卡片列表，实测如此，未声称已覆盖）·
**D1.3 具名环境的列表/移除/用作运行时**（通道与面板 `d726882a` + 列表刷新修复与真窗口读数 `b7feabd4`：
A7 导入的环境不再是死路——服务端列表含它、面板「具名环境」分组显示它、二次确认移除后 `envs/<name>` 目录消失；
读数见 evidence §6。**仍未取**：在用内核时拒绝移除的真窗口读数，已立案）。
**S3 增量全文索引的 S1/S2 两片**（持久层 `6f4d579b` + 查询合流 `a2f9217d`：指纹计划 / 续跑单调 checkpoint（磁盘权威）/
存储上限具名拒绝 / 删目录即「空覆盖」；查询 = 索引 ∪ 现场有界扫描 ⇒ 索引只让命中变多，
coverage 报 indexed/pending/stale/capped。自测先红抓出真缺陷一条：原实现只接受「批次」不接受「计划」，
删除项从未被应用 ⇒ 删掉的文件会永远命中）。
**⚠️ S3 未接线、不对外承诺**：后台**填充**索引的 builder 与面板读数尚未落地 ⇒ 生产里索引恒为空、
coverage 只报 indexed:0。剩两片（S3 界面九语种 + S4 真机四条断言）已立案，见
`docs/plan-2026-10-03-S3-incremental-fulltext-index.md`。
（**2026-10-04 更正：本段已过时。** S1b 填充器/持有者/接线、S3 界面读数、S4 真机四条断言**全部落地**，
逐条 sha 与读数见下文 B.2 —— 读到这一段请直接按 B.2 的结论办事，不要按这里的「未接线」重做。）
**v1.80.1 发布**（tag `v1.80.1` → **`dd76c03d`**，发布页建于 2026-10-03T08:50:18Z、**21 资产**、`isDraft:false`；
`version.json` 4 平台条目各带 sha256、与 `SHA256SUMS.txt` 交叉 0 不符；正文**由我手写** 10,057 字符 /
12,265 字节，含 mac 未签名披露；`RELEASE-CERTIFICATION.json` 的 `sourceSha = dd76c03d…` 与 tag 提交逐字符一致；
首发 run `37110227561` 红在 build/Verify ⇒ 删 tag 重建，见下条）·
**S3-S1b 三片全部落地**（填充器 `ed58229b` + 持有者 `d06b51dd` + 生产接线 `dd9ff596`：查询读索引并对该项目
顺带推进一次 tick。**仍未做**：界面读数 9 语种 + 真机四条断言；且无「活跃项目」来源 ⇒ 不启定时器，
触发点是真实搜索）。
**S3 界面读数片落地**（`0b2b220a`：面板显示「已索引 x · 待更新 y · 索引更新于 z 分钟前」+ 真动作「立即索引」，
9 语种 6 键 + 渲染/钩子/main/映射共 13 条新用例。**不新增通道**——读数搭 `search:query` 响应的可选 `index` 块、
「立即索引」搭请求的 `refreshIndex` 标志（主进程等待一次 tick 再取读数）⇒ 零契约计数涟漪，
`check:web-api-map` 通过。S3 只剩 **S4 真机四条断言**未取）。
**v1.80.1 发版红修复**（`dd76c03d`：D1.3 的 handler 改名 `applyNamedEnvAsRuntime`（use* 前缀让 linter 正确地
判成「hook 在回调里调用」——改名不压规则）+ `refreshNamedEnvs` 改 `useCallback` 解身份抖动 +
S3-S2 用例补返回类型 + Web 可调用面计数 380→382。根因记牢：**只跑改动文件的 eslint 证明不了全仓 lint**，
而 CI 的 Verify 吃全仓；首发 tag `59b377d1` 的 run `37110227561` 三分半红在 build/Verify、下游
Build/notarize-mac/publish 全 skipped ⇒ **连发布页都没有**，同一批错误也把 Nightly 与 Windows Full Test 打红。
这条已写进本机开发技能的发版机制参考（`~/.hermes/skills/software-development/` 下的
`references/release-mechanics.md`，「Gates before tagging」小节；该技能目录名本身在本仓品牌扫描的禁用词表内，
故此处只写路径不写其名）。

1. ~~**`49b2c83c` 那份 v1.80.0 发布记录需按实际结论更正**~~ ✅ **已完成（会话，`0fabd2e6`）**——
   已按实际结论更正为「已发布」：21 资产、run `37099590863` 全绿、`sourceSha = f2a97d87…`、
   正文 13,535 字节、mac 未签名已披露，并写明首发 `f690b85a` 那次 run 是 failure、已删 tag 重建。
2. ~~**R2-U4 三种具名拒绝的真机读数**~~ ✅ **已复核并归档（会话，v1.81.0 的 V7）**：结论是这三条**不是"该取未取的读数"，而是"单窗口按当前 UI 合法到达不了的状态"**——`self-merge` 被 UI 在 store 之前挡住（本轮已读到 `confirmDisabled` 真值）；`alias-conflict` 需要"目标名已是别刊别名"，而别名一旦写成，按该名再导入会解析回原刊、造不出第二个刊；`source/target-not-found` 需要**第二个行为者**并发删并。三条现由 jsdom 驱动（`render.test.tsx:277/:349/:250`）+ 具名理由，从"未取"挂账移出。证据 `docs/evidence/2026-10-03-r2-u4-journal-alias-merge.md` §5。
3. ~~**同日多指标不许静默取一条**~~ ✅ **已交付（会话，v1.81.0 的 V11 / IC1）**：`selectClaimWithAlternatives()` + 面板并列打印 + 冲突徽标；真机读数 `docs/evidence/2026-10-03-journal-metric-conflict.md`（4 passed / 32.9s，**含原发现场景「别名合并」那一条也变成两个值**）。口径：合并后同一 kind+同年份有两条主张时，视图并列显示（各带 source）或显式标冲突；**不许静默挑一条**。
4. **egress 拦截卡"等满 60 秒"的端到端复现**：修复已完成（到点自动撤卡 + 应答失败不再静默），
   但"真窗口里等满 60 秒"的读数**未取**，做法同第 2 条。
5. ~~**`--primary-foreground` 对比度实测**~~ ✅ **已实测（会话，v1.81.0 的 V9 / IC4）：判定不达标**。真机读数：`--primary` 画成 `rgb(77,107,254)`、前景 `rgb(248,250,254)`、真实 CTA 16px/400 ⇒ 正文门槛 4.5，**实测 4.144:1**；**且前景色换纯白也只有 4.330:1**（该背景天花板）⇒ 原定「微调前景色」这条修法**不可行**，已改立**拍板项**（加深 `--primary` 到 `oklch(0.56 …)`=4.721:1，或接受并记录）。证据 `docs/evidence/2026-10-03-primary-contrast.md`。
6. ~~**`acp:state` 渲染器 ack**~~ ✅ **已定位并给出结论（会话，v1.81.0 的 V15）**：结论是**这条旧立案问错了问题**——通道是活的（`acp.onState` 三处订阅），ack 要解决的「渲染器把缺席当回收」已由 `runtime-event-live-set.ts` 的累积语义从另一侧解决；收益（该通道 52KB→15KB/三回合）改写成一条**有守卫的优化项**（守卫=`interrupted-turn-continuation.spec.ts`），不新做 ack 协议。
7. ~~**`timeoutMs` 含冷启动**~~ ✅ **已定位并给出结论（会话，v1.81.0 的 V10）：已修，且比老账要求更细**。**先更正老账的地址**——那两个文件**没被删，只是搬到了 `src/main/notebook/`**（老账按 `src/main/agents/` 找才误判"已不在树上"）。现址：`arm(budget)` 先按 `budget + startupGraceMs(30s)` 计时，循环回报开始时 `markStarted()` 换成纯语义预算；`executing` 分辨"超预算"与"根本没启动"并给具名原因；单测在 `kernel-executor.test.ts` 的 `describe('TimeoutController')`。
8. ~~**面板"确认前"中间态的 DOM 读数**（R2-U4 遗留）~~ ✅ **已取（会话，v1.81.0 的 V7）**：「只选一侧」`{target:"", label:"Choose a journal…", confirmDisabled:true, reportedResults:0}`、「两侧选齐未确认」`{source:"Nature Communications", target:"Nature", confirmDisabled:false, reportedResults:0}`、**`library before confirm: {journals:2, aliases:0}`** ⇒ 点亮 ≠ 写入。同批修掉 spec 里「一个格子只印一个数字」的过时注释。读数见 `docs/evidence/2026-10-03-r2-u4-journal-alias-merge.md` §4。
9. ~~**i18n 键控遗留**~~ ✅ **已交付（会话，v1.81.0 的 V14a/V14b，IC5 全闭）**：专才面板（`Built-in · Version`、`Full access`/`Selected capabilities`、`Up to …`、3 条删除失败文案）、专才编辑器 `Icon`/`Color`、技能上传 `Drop to upload`、存储迁移弹窗与存储面板全部改走 `t()`；另扫出并修掉 `SpecialistDeleteDetail.tsx` 同款三元式。新增 26 键 × 9 语（各 3528 键、覆盖率 100%、zh ≠ en）；断言 EN 文本的既有渲染测试未受影响（en 值逐字未变）。
   ⚠️ 这条只存在于**那份永不推送的本地档**里：不并进本队列就会被忘掉。

### B. 大件（每件需要多轮；排在 A 之后，单独立项推进）

1. ~~**A7 外部锁导入**~~ ✅ **已完成（会话）**：立项 `docs/plan-2026-10-03-A7-external-lock-import.md`；
   S1 `cd2bd978`、S2/S3 `83a2cdbc`；真机读数见 `docs/evidence/2026-10-03-A7-external-lock-import.md`。
   **遗留两条读数列案**：下载路径未实测、真窗口点动读数未取（该档 §3）。
2. ~~**S3 增量全文索引**~~ ✅ **已完成（含 S4 真机读数）**：S1 持久层 `6f4d579b`、S2 查询合流 `a2f9217d`、
   S1b 填充/持有/接线 `ed58229b`+`d06b51dd`+`dd9ff596`、S3 界面读数 `0b2b220a`、
   **S4 真机四条断言 `2ac54c6f`**（认证 spec `e2e/certification/search-index-coverage.spec.ts`；
   第四条的重建竞态修正 `10a14928`）。逐条读数见 `docs/evidence/2026-10-03-S3-incremental-fulltext-index.md`。
   **遗留两条（都不阻塞本队列，已具名）**：① 判据①的准确表述应为「首次搜索**不谎报覆盖**（宁可不说），
   一旦有测量则以 `pending` 给出」——**不改实现、只改口径**；② 可选项：面板在「索引已接但尚未测量」时
   显示一句「尚未测量」（属界面文案层，未做）。
3. ⛔ **M2 本地解析模型资产**：**顺延，卡在产品决定，不是代码缺口**。纪律 = **无已发布 SHA256 的权重不下载**，
   而目前**不存在任何一份「权重 + 发布方校验值」清单**。解锁前置（按顺序，缺一不可）：① 拍板权重的发布方与
   托管位置（我方 release 资产 / 作者方官方分发）② 产出随应用发布的 manifest
   （`id / revision / url / sha256(64 hex) / bytes / license`，离线可读）③ 之后 S1（资产目录 + 校验式获取 +
   拒绝路径）与 S2（接入解析）才有意义。现状核实与顺延结论见 `docs/plan-2026-10-03-M2-blocker-and-deferral.md`。
   **不加「假安装」按钮**（M1 的壳保持文案明示「计划中」）。

> **B 段剩下的活（S3 收口 + M2）与 A 段读数清账已排进 `docs/plan-2026-10-03-v1.81.0-queue.md`** —— 本队列只留「先做什么」的结论，
> 单元明细、验收与纪律以那份 v1.81.0 排期为准（防两处漂移，规矩同 D 段）。

### D. 入口层闭环（2026-10-03 全软件扫描新增；证据见 `docs/evidence/2026-10-03-entry-layer-and-interaction-closure-audit.md`）

> 通道级已确认不漏（449 条契约项 × 窗口调用点，真差 0）；下面全是**功能流层**的「能力已在、体验层缺一半」。
> 扫描共 52 条（P0 9 / P1 33 / P2 10）。
> **正式排期与发版号分配见 `docs/plan-2026-10-03-interaction-closure-schedule.md`**：D1 → **v1.82.0**、
> D2 → **v1.83.0**、D3 → **v1.84.0 ~ v1.90.0**（逐条单元号 **IC1–IC51** 在排期文件里，提交信息引用单元号即可；用 IC 前缀是为避开 09-23 那批已用过的 U1–U28）。
> 本段只保留「先做什么、为什么」的结论，**单元明细以排期文件为准**（防两处漂移）。
> **A 段由会话负责**（要拍板与真机读数），执行器在 A 段无人动时可接手。

**D1 → v1.82.0（优先，四条都是「后端全齐、只差一个挂载点」，单轮可收口）**

1. **计算任务产物清单**：`shared/compute.ts:328-332` 已有 `featured_files`/`left_on_remote`/`harvest_error`，
   渲染层只剩 `JobDetailModal.tsx:225-226` 一行**注释占位**（组件不存在）。补 `FeaturedOutputs` 面板 + 逐产物下载。
2. **通知到达点亮红点**：`notification-inbox-store.ts:76-97` 有 `listen()` 但**全渲染层无人调用**（`listen()` 全库 0 命中）。
   在 `App.tsx` 启动处调一次即可（照 `permission-grants-store` 的写法）。
3. ~~**A7 锁导入环境的删除 / 用作运行时**~~ ✅ **已完成（会话 `d726882a` + `b7feabd4`，即排期文件里的 IC8）**：
   新通道 `runtime:manage-named-environments`（`list`/`remove`）+ 面板「具名环境」分组；移除二次确认、
   **在用内核时拒绝且理由逐字上屏**；「用作笔记本运行时」走既有 `register→enable→select`（不新造后端）。
   真窗口读数：`serviceNamedEnvs=["lock-import-env"]` / `namedEnvRows=1` / `namedEnvRemoved=true dirGone=true`。
   **仍未取**：在用内核时拒绝移除的真窗口读数。
4. **产物用系统程序打开**：`artifacts:open-file` 后端 + preload 全齐，`artifacts.openFile` 渲染层 0 命中。
   在 `PreviewFileSurface` 头部加「用系统程序打开 / 在文件夹中显示」。

**D2 → v1.83.0（需要迁移或新 IPC 面，单独立项）**

5. **会话包随包证据落地**：`import-session.ts:79` 只读 `{ only: ['conversation.json'] }`，而 `import.ts:22-24` 把
   citations / review-findings / verifications 列为**强制**证据，导出侧确实写入 —— 导入侧全丢。
6. **导入会话的姿态可见**：侧车 `<id>.import.json` 只被主进程用来拒绝运行，窗口 0 命中 ⇒ 加只读 IPC + 会话横幅。
7. **存储迁移遗留副本的「完成 / 丢弃」**：`migration-service.ts:232` 的文案「Finish or discard that move」
   **指向一个不存在的按钮**——两个通道都要求活动弹窗的 `targetPath`。启动时按 marker 扫描并给出两个入口。

**D3 → v1.84.0 ~ v1.90.0（成批推进，按域；逐条发版号见排期文件）**

- 笔记本/运行时一批 6 条（窗口直装包、会话级运行时绑定、内核重启/关闭、遮罩取消、下载明细、`bundleSource`）；
- 自定义 MCP 一批 6 条（详情/逐工具权限、跳过审批、登出、可用性徽标、连接测试、批量启停）；
- 文献/期刊一批 6 条（附件历史、notes、`defaultKind`、`maxImpactFactor`、手工订正、逐行归属）；
- 文案与死面清理一批 10 条（核验面板 4 处硬编码英文、迁移弹窗英文、设置搜索缺 egress 关键词、
  `handoff.list/retry` 死面择一正本等）。

### C. 阻塞（不是排期问题，别花轮次）

- **K1a 技能市场只读纵切 / K3 市场全量交互**：卡在**官方技能目录不可达/未发布**（本机 jsDelivr 元数据 404、
  `raw.githubusercontent` 超时；协议根只有 `specialists[]`）⇒ 等目录上线那一版再做，**在目录可达前不要写没有消费者的代码**。

## 三、纪律（不变的那几条）

- 真实配置根 `~/.purescience-project` **只读**；一切写入落在 `/tmp` 的隔离根；收尾停进程、确认端口无监听、删临时目录、`git status` 干净。
- **缺失的测量不许当测量**：读数拿不到就写 `not reported` / 「未复核」，**绝不写 0、绝不编**。
- 单测不算实机；能取真机读数就取，取不到就**具名立案**。
- 禁用死的/无消费者的代码；「有代码没入口」会被 `renderer-contract-entry-coverage.test.ts` 挡住——
  要么接进窗口，要么在 `entry-layer-archived-surfaces.ts` 里写明它为什么只给 agent 用。

## 四、本轮追加（会话，2026-10-04）

**v1.84.0 进行中（会话负责）**：**IC11 导入会话的只读/来源姿态可见 ✅ 已落地**（新增 `sessions:import-posture`
只读通道 + `SessionImportPostureBanner`；真机 `e2e/certification/session-import-posture.spec.ts` **1 passed (31.9s)**，
含"重启进程后再读"与"同项目普通会话 0 横幅"两道关键断言；契约连锁 7 处计数、4 键 ×9 语）。
**IC12 迁移遗留副本的「完成/丢弃」 ✅ 已落地**（marker 即持久态 ⇒ 新增 `readStagedMoveAt` 从盘上解析，提交仍必须 `verified`；
弹窗新增 unfinished 段 = 完成/丢弃，`copying` 只出丢弃；面板不再禁用该入口；真机 `storage-migration-unfinished.spec.ts`
**2 passed (1.7m)**，重启后两条动作各走通一次，既有迁移 spec 3 passed 回归）。
**随带修掉一个我自己造成的红**：IC11 spec 抄了 IC10 的 `Bridge` 用法却没抄它的本地声明 ⇒ Playwright 不做类型检查、
`typecheck:node` 覆盖 `e2e/**`，所以那次提交带着 5 个 TS2304 推出去了（`faa68afe` 修）。

**IC16 工作区环境准备遮罩的 Cancel ✅ 真机读数已取（`1 passed (21.6s)`）**：替身 CDN（首次 manifest 500 造错误态 + Retry；其后合法 manifest + 滴包体）
→ 真界面走到遮罩 `preparing` 且 Cancel 在场（真遥测 63.8 KB/s · 24.0 KB / 16.0 MB · ~4m 17s）→ 点 Cancel → `provisioning:false` 且 `pythonReady:false`。
取证时抓到并修掉一个真缺陷（`deriveProvisionUi` 无法从进度推出 preparing；store 刻意不逐 tick 重读状态 ⇒ 真机里 Cancel 永不出现）+ 两条单测。
**同批新立案（未修，独立缺口）**：**主进程的 provision 进度广播未送达渲染端 store**——实测包体已下载到 2% / 39.8 KB/s / ETA 约 6m43s、持续整整一分钟，而工作区遮罩渲染为空；
只有一次 **status 重读**（例如打开设置面板）才让门控与 Cancel 出现。后果：用户从 Runtimes 面板起下载后回到工作区，可能长时间看不到任何门控/取消入口。
验收建议：工作区侧订阅或初始化时拉一次状态，让进度广播真正驱动 `preparing`（本轮修的推导已为它铺好路）。

**IC17 设置页下载明细（组件与单测已落，真机读数附一条缺口）**：设置页准备卡片改用共享 `DownloadProgressLine`（与工作区同源）；真机 `1 passed (40.1s)`：替身 CDN 让下载真跑，卡片百分比 1→7 逐格推进（活的），但 `hasSpeed=false` —— **同一批 tick 里的富字段 `download`（速度/大小/ETA）没有到达渲染端**，30 秒内始终缺席，而工作区那侧（IC16 读数）有。
验收建议：追这条字段在"主进程广播 → 渲染端 store"链路上是何时被丢的（候选：①广播的 `progress.download` 在某些路径没设；②store 的合并把它覆盖）。**这条与 IC16 立案的"进度广播未送达 store"很可能是同一族**——建议两件一起修，一次把"进度能到 + 富字段能到"都验掉；修好后把 IC17 的遥测那半纳入真机读数。

**IC14 会话级运行时绑定/切换 ✅ 真机读数已取（`1 passed (55.0s)`）**：预览里的会话运行时条列出应用启用的运行时、标出在用（含隐式默认）、首次 bind 其后 switch；真机上选中第二个受管环境再切回，条纹每次写后重读清单。取证中修掉一个真 UI 缺口（隐式默认未被标为在用）。
**同批立案（未修）**：①`runtime:set-environment-enabled` 在收到**运行时 id**（而非发现到的 envId）时让主进程崩在 `reading 'status'`——外来/不匹配的 id 应当**具名拒绝**（与本轮 IC13 的"不静默改指、按名拒绝"同一条原则）；②**带外**删除/移动解释器不会让活会话的绑定失效，直到有人重读清单（`missing` 的判定因此只会出现在重启或下一次重读之后）。

**IC13 窗口直装包 ✅ 真机读数已取（`1 passed (53.7s)`）**：包对话框可直装（含 pip 纯 pypi 包，真装后**环境自己能 import**）；四段"应用原话"读数齐（卸载 additive-only、命名环境具名拒绝、非加法式规格拒绝）。
取证中修掉三处产品问题 + 一处我自己的 UI 缺陷：①窗口只走 conda ⇒ 纯 pypi 包装不上（补 pip 开关，端到端字段本就存在）；②**静默改指**风险——准入的环境名只来自会话绑定、请求里的名字对它透明，所以点名别的环境的请求会被静默落到默认环境（现在按名具名拒绝，真机断言默认环境未被误改）；③身份比对过严（发现给 realpath、面板回传用户拿到的路径）⇒ 两处查找改为按解析后路径判等；④对话框动作状态跨环境残留（旧错误还会压住新提示）⇒ 收敛为单一 `openPackagesDialog`。
**立案（窗口这一侧的结构性边界）**：**窗口无法完成卸载** —— 准入 `package-admission.ts` 用 `binding?.source === 'managed' && binding.envName ? … : defaultEnvironment(language)` 解析目标环境，窗口没有会话 ⇒ 只到得了托管默认环境，而默认环境按设计 additive-only（`package-manager.ts:752`）。两条候选修法：㈠让准入在**无绑定时**接受一个受校验的环境名（需它自己的测试与安全评审，因为绑定驱动的解析是防 agent 越界的原意）；㈡把**命名环境纳入窗口可达面**（面板的命名环境行已有入口，但那条请求现在按名拒绝）。在此之前，对话框对非默认环境是**只读视图**，卸载按钮只在默认环境上出现且如实显示应用的规则。

**v1.83.0 已发布（2026-10-04）**：tag `v1.83.0` → 提交 `efc4b1fd`（自 `v1.82.0` 起 **37 笔**），
`release.yml` run **37189184119** 全绿（preflight / build×4 / `Verify` / `notarize-mac`（无 Apple 凭据 ⇒ 按设计标 UNSIGNED）/
**publish** / `windows-upgrade-smoke`）。发布页 **21 个资产** + `Latest`；`RELEASE-CERTIFICATION.json.sourceSha` 与 tag 提交
**逐字符一致**；`version.json` 四条目 host 全为 github.com、sha256 与 `SHA256SUMS.txt` 四条**全对（0 不符）**；
正文 = 脚本自 tag 树合成（成熟度块 + 本版 CHANGELOG 条目（含下列口径补正）+ mac 未签名披露）**非桩**（21,193 字节）；
`Publish npm package` 只认 `npm-v*` 标签 ⇒ 桌面 `v*` 不触发是设计如此，不是漏跑。
本条记数修正：tag **标注**里我写「35 笔」是错的（真数 37）；发布页正文不含计数，不为一个标注里的数字重跑 40 分钟 CI 并重传 21 个资产，故在此如实记正。

**第一次 tag 跑（run `37186656589`）红在 `Enforce platform certification`**：IC10 认证 spec 的
`expect(landed.skipped).toEqual([])` 把「对一条**非本 spec 自造**的 ambient 复核行做具名拒绝（`message-not-found`）」
读成了失败 ⇒ **断言口径缺陷，不是产品缺陷**（落地模块「没落地的行一律点名」是设计行为）。改法见 `efc4b1fd`
与证据档 §五；救济按收口约定「删 tag 重建」（**没有**重跑单个 job），重打 tag 后全绿。
同一次跑还新发现「**包内自洽**」缺口（见下条 v1.84.0 立案）。

**IC11 / IC12 未开工，已明确移出到 v1.84.0**（理由与落点写进 CHANGELOG 的「明确没做」段与排期档批次 3 表）——
不为凑齐出半截界面，也不让它们堵住发版。

**v1.84.0 新立案（本版打包认证跑新发现）**：**包内自洽**——导出的会话包可能带一条「引用的回合消息
不在包内转录里」的复核行（`release.yml` 第一次打包跑 `message-not-found` 具名拒绝即此）；接收端行为正确
（具名拒绝、零静默丢失），但导出侧应自洽：**复核行与它引用的回合消息成对进包，或该行不进包**。
验收=认证 spec 里加一条「包内自洽」断言（对包内的复核行逐条校验其回合消息在包内转录中），
并在导出侧补齐；见证据档 `docs/evidence/2026-10-04-ic10-session-package-import-evidence.md` §五。
同一处另记：e2e 假 agent 不产出复核结论 ⇒ 「复核结论（checks）落地」**只有单测覆盖**，真机读数未覆盖，
若 v1.84.0 要让该维度也有真机读数，需要给 spec 一个能产出结论的复核夹具（工作许可的 provider 桩）。
**发版窗口内执行器已暂停**（`hermes cron pause 2be4405e5dc6`，按收口约定第 4 条：发版期间不许并发推送），
发布完成、Release 页核对后恢复。

## 五、本轮追加（执行器，2026-10-04）

B 段已耗尽（S3/S4 全落地、M2 卡产品决定），A 段唯一开项（egress 60 秒窗口读数）归会话 ⇒ 按排期文件进入
**v1.84.0 批次 4**，本轮取 **IC16（工作区环境准备遮罩加 Cancel）**。

**先核审计口径，再动手**：`notebook-env:cancel` 通道、preload、store 的 `cancel(lang)`、主进程
`provisioner.cancel` **四层全都在**（设置页 Runtimes 卡片一直在用）——真缺口只是**工作区那层遮罩没有这个控件**：
首跑下载一开始，用户被挡在灰罩里，除等它跑完没有任何出口。⇒ 本单元不是新建后端，是补一个挂载点。

落地 `24dd3b6b`（3 文件 +132）：`EnvProvisionOverlay` 新增可选 `onCancel`，preparing 态渲染 Cancel；
`NotebookPreview` 按 `ui.scope` 传语言（python/r 可中止）。**复用 9 语字典已有的 `common.cancel`** ⇒ 零新键、零契约计数涟漪。
验证：新增 4 条用例（遮罩层 Cancel 存在与回调 / 无 handler 不画 / 挂载态点它真的带语言调 `notebookEnv.cancel` / upgrade 态不出）
+ 194 文件 2292 passed、双 typecheck exit 0、`eslint --no-cache .` 0 error。CI：`Nightly` + `Windows Full Test` 已触发（结论见本轮汇报）。

**刻意不出按钮的一种状态（防空壳）**：`scope='upgrade'` —— 附加式 upgrade 在运行时里既没有 abort controller，
`serializeProvisioner` 又会丢弃语言级 cancel ⇒ 出这个按钮就是个点了没反应的空壳。口径写进代码注释 + 测试
`offers no cancel while an additive upgrade holds the pane`。

**⏳ 真机读数未取（具名立案）**：本机此刻可用内存 ~90MB、swap 13.9G/15.36G（桌面版实例 + 十余个 agent 子进程在跑），
而本仓明令「跑真机 e2e 前必重建、禁裸跑 `electron-vite build`」⇒ 在这种内存压力下重建 + 起 Electron 取证不安全
（本机有 16G 堆把机器打崩的前例）。**取证配方（下一轮内存宽松时一次跑完）**：

1. 骨架复制 `e2e/certification/notebook-rerun.spec.ts`（provenance 夹具 → `kernel-notebook-pane` attach → `workspace-preview-toggle`），
   并按 `e2e/certification/lock-import.spec.ts` 的老规矩先 `process.env.PURESCIENCE_MICROMAMBA_BIN = <真 runtime 的 micromamba>`
   （隔离实例不自带 micromamba，不设这个 provisioner 直接拒）。
2. 设置页 Runtimes 点 python 卡的「Download and set up」——**必须走这条**：遮罩的 `ui` 由 store 的 `scope`/`status.provisioning` 派生，
   而直接从 `page.evaluate` 调 `api.notebookEnv.provision` 只让主进程开跑，store 不会把 `ui` 翻成 preparing。
3. 关设置 → 断言 `notebook-env-gate` 可见且 `notebook-env-cancel` 文案为 Cancel → 点它 →
   断言遮罩离开 preparing（落 error 分支带 Retry、具名原因是取消）、`api.notebookEnv.getStatus().provisioning === false`。
4. **只允许在跑绿之后提交该 spec**：`e2e/certification/**` 是发布认证作业的一部分，未跑过就进仓＝留一道从未通过的闸门。

**并发说明**：本轮开工时 `origin/main` 为 `9cd33a05`（`17:19` 由会话写入的 v1.83.0 发布记录）；执行器提交前先 `git fetch` 核对，
本轮的 `24dd3b6b` 落在它之上，无重写、无 force-push。

**下一轮第一步**：先看 `Nightly`/`Windows Full Test` 在 `24dd3b6b` 上的结论（红则先归因再动）；
内存宽松则按上面 1–4 补 IC16 真机读数；否则顺延到 v1.84.0 的下一条（IC13/IC14/IC15 任选一条，落点见排期文件批次 4 表）。

## 六、本轮追加（执行器，2026-10-04 19:35–19:55）——让位轮 + CI 归因

**本轮判定：让位，不改动工作区（零代码提交）。** 开工时的事实：

- `git status --short` 显示**桌面会话正在改的一批文件**（IC12 迁移遗留副本）：`storage/migration-service.ts`、
  `storage/command-owner.ts`、`shared/storage.ts`、`StorageMigrationModal.tsx`(+render 测试)、**9 语字典**、
  `session-import-posture.spec.ts`，外加新增的 `e2e/certification/storage-migration-unfinished.spec.ts`；
- 进程表里有**正在跑的** `playwright test e2e/certification/storage-migration-unfinished.spec.ts`（它还留下
  `test-results/electron/certification-storage-migr-…/test-failed-*.png`）⇒ 桌面会话此刻在跑真机 e2e；
- 本机 swap **16.7G / 17.4G**、可用内存 **< 1G**。

按共存红线（并行时只能有一个在改）＋ 本仓「跑真机 e2e 前必重建」的纪律：此刻任何重建/测试都会与它抢内存与端口，
且必然纠缠同一批文件（含 9 语字典）⇒ **本轮不落代码**，产物是下面这份 CI 归因（下一轮直接引用，不要再重查）。

**CI 归因（结论已定）**：

1. **上一单元 IC16（`24dd3b6b`）没有任何 CI 判决**：该 SHA 上 `Nightly`（`37198…`）与 `Windows Full Test`
   均为 **cancelled**（`2026-10-04T09:30:32Z` 创建，被 19:16 的 IC11 推送按 `cancel-in-progress` 顶掉）。
   **取消 ≠ 绿**（见 `references/ci-gates-and-discipline.md`）⇒ IC16 的 CI 结论只能由
   「**包含 `24dd3b6b` 的下一次绿色 `Nightly`**」代替给出（CI 跑整棵树而不是 diff）。
2. **当前 HEAD（`99f36bc4`）的 `Nightly` 是红的**（run **37198183869**），红在 `build / Verify` 的 **Typecheck** 步，
   全文只有一种错误：`e2e/certification/session-import-posture.spec.ts` **5 处 `TS2304: Cannot find name 'Bridge'`**
   （该 spec 是会话 IC11 的产物，缺一个本文件内的局部 `Bridge` 类型声明）。**同一 SHA 上没有别的 TS 错误**
   ⇒ 这次红是 IC11 spec 自身的类型缺口，**与 IC16 无关**。
3. **`Windows Full Test` 在同一 SHA 上是绿的（8/8 分片）**：它的分片只跑 vitest，不含 e2e 目录的 typecheck 作用域
   ⇒ 同一条缺陷只被 `Nightly` 抓到。**别把这条读成「两条车道互相矛盾」**。
4. **会话已在工作区里修掉了它**（未提交）：WIP 版加了 `import type { SessionPackageImportRecord }` + 文件内
   `type Bridge = { … }`。我核对过修法落点真实存在——`src/shared/session-package-import.ts:144` 导出该类型，
   `src/preload/index.ts:207/212/215` 三个方法（`exportPackage`/`importPackage`/`importPosture`）都在
   ⇒ 它把 typecheck 转绿后，第 2 条即消失。

**下一轮第一步（三选一，按当时事实判）**：
① `git log --oneline origin/main -3` + `git status --short`：会话若已提交推送 IC12 且树干净 ⇒ 取 v1.84.0 的
下一条（**IC15** 内核常驻「重启/关闭」 或 **IC13** 窗口直装包，落点见排期文件批次 4 表）；
② 树仍脏 / 桌面仍活跃 ⇒ 继续让位，只做只读取证，不落代码；
③ 内存宽松时优先补 **IC16 真机读数**（配方见 §五 1–4），并**顺带把「包含 `24dd3b6b` 的绿色 `Nightly`」记为 IC16 的 CI 证据**。

## 七、本轮追加（执行器，2026-10-04 21:38–22:0x）——让位轮 + 当前 HEAD 的红已完整归因（含逐条修法）

**本轮判定：让位（零代码提交）。** 依据 §六 的「下一轮第一步 ②」：开工时**树仍脏且桌面仍活跃**——
`git status --short` 是会话 IC13 未提交的那批（`notebook/runtime-selection-workflows.ts`、`RuntimesPanel.tsx`(+render 测试)、
`shared/notebook-runtime.ts`、9 语字典、新增 `e2e/certification/packages-mutation.spec.ts`），
`RuntimesPanel.tsx` 的 mtime 是 **21:44**，且进程表里有 **21:45 起跑、正在跑**的
`playwright test e2e/certification/packages-mutation.spec.ts`（`npm exec` → playwright → Electron 全链在），
本机 swap 12.0G/13.3G、空闲物理页 ≈72MB。按共存红线，此刻任何重建/测试都会与它抢资源，故不落代码。

**本轮产物 = 当前 HEAD 的红完整归因（下一轮**直接引用，不要再查**）。** 上一轮（§六）只知道「Nightly 红在 Verify」，
本轮把**红到哪条断言、由谁引入、怎么修**全部钉死：

- **HEAD = `e3bda25b`（= `origin/main`）**。`Nightly` run **37203794992** failure：**`build / Verify` 里
  `Lint` ✓、`Typecheck` ✓、`Test (with coverage)` ✗**（下游 `Build ${{matrix.name}}` 与 `publish` 全 skipped ⇒ 无产物、无发布页）；
  `Windows Full Test` run **37203794805**：**8 分片里 2/3/6/7/8 红、1/4/5 绿**。两车道同一 SHA 同因。
- **红 = 5 条断言、2 个根因。** （证据取法：`gh api repos/naiyixi/PureScience/check-runs/<job-id>/annotations`
  —— 一次拿到 `文件:行 + AssertionError 原文 + 期望/实收`，比拉 job 日志快得多；本轮拉日志在 CN 网 5 MB 就要 180 s 并超时。）

**根因 A（IC13 的 `b2edc984` 加了通道 `runtime:manage-packages`，但 4 处契约 pin 未跟 ⇒ 契约计数连锁只修了一半）**：
`b2edc984` 已改 `application-command-composition.test.ts`、`renderer-contract-catalog.test.ts`、
`renderer-surface-inventory.test.ts`、`preload/index.test.ts`，**漏了这 4 处**：

1. `src/main/notebook/runtime-ipc.test.ts:147` —— 「registers the exact runtime command surface」：14 → **15**，加入 `'runtime:manage-packages'`。
2. `src/main/web-service/http-server.test.ts:927` —— `localOnly(runtimeChannels)`：8 → **9**，把 `'runtime:manage-packages'` 插在
   `'runtime:manage-named-environments'` **之后**（字典序：`named` < `packages`）。
3. `src/shared/web-rpc-contract.test.ts:122` —— `runtime.*` 可调用面：14 → **15**，把 `'runtime.managePackages'` 插在
   `'runtime.manageNamedEnvironments'` **之后**。
4. `src/renderer/web/renderer-argument-shape-characterization.test.ts:202` —— Web 可调用面总计数 `toHaveLength(383)` → **384**
   （即本技能正文点名过的那一处「独立计数」；`expectedPaths` 侧无需改，它由目录派生）。

**根因 B（IC12 的 `70cf2046` 改了按钮文案＋加了 testid，但 `StoragePanel.render.test.tsx` 未跟 ⇒ 自 `70cf2046` 起一直红）**：
`src/renderer/src/pages/settings/StoragePanel.render.test.tsx:811` 断言 `expect(changeButton?.disabled).toBe(true)` 得到 `undefined`。
原因：用例第 808–810 行按**文案** `'Change location'` 找按钮，而组件 `StoragePanel.tsx:479` 在 `kind === 'invalid'` 时渲染的是
`t('common.continue')`（英文即 `Continue`）⇒ 找不到按钮。**修法（不弱化断言意图）**：改用组件**已经提供**的稳定锚点
`container.querySelector<HTMLButtonElement>('[data-testid="storage-change-location"]')`（该 testid 正是 `70cf2046` 为「稳定定位」加的），
「invalid 下动作不可用（disabled）」的意图逐字保留。**已核**：`StoragePanel.render.test.tsx` 的最后一次改动是 `1d97f9d4`（早于 `70cf2046`）
⇒ 是测试未随组件同步，不是新的产品缺陷。

**红的起点（已用 check-run 注解复核，不是推断）**：`StoragePanel.render.test.tsx:811` 在 `70cf2046` 与 `1e32bcac` 的 Verify 注解里
**同为该行**（`70cf2046` 起就红）；4 处 pin 是在 `b2edc984` 引入（该 SHA 的 run 被 `e3bda25b` 按 `cancel-in-progress` 顶掉 ⇒ **cancelled，无判决**），
在 `e3bda25b` 上完整暴露。**取消 ≠ 绿**。
**同批待确认（不当作现状）**：`70cf2046`/`1e32bcac` 的 Verify 注解里另有 mac update feed 的 arm64 缺失/不完整两条；
`e3bda25b` 的注解里**没有**它们（未跑到或被修），留作下一轮验证项，先别当缺陷改。

**下一轮第一步**：① 先 `git status --short` + `git log --oneline origin/main -3`；**树干净且桌面空闲** ⇒ **先修上面 5 条**
（4 处 pin + StoragePanel 用例；都与会话本轮改动的文件不重叠），跑这 5 个文件定向 vitest + 双 typecheck + `eslint --no-cache .`，
提交推送并盯 `Nightly`+`Windows Full Test` 双绿；② 仍脏/仍活跃 ⇒ 继续让位（只读取证），并优先补 §五 1–4 的 IC16 真机读数（内存宽松时）。
**⚠️ 防重做**：会话正在做的正是 IC13，它的下一笔提交前必然要跑 `src/main/notebook` / `src/renderer/src/pages/settings` / `src/shared`
这三处受影响套件——**这 5 条大概率会被会话自己修掉**。所以下一轮**先 `git log --oneline -5 origin/main` 与会话提交核对**：
若其中已含「runtime:manage-packages 的 pin 补齐」或「StoragePanel 用例改 testid」，**跳过、不要重做**（重做＝白烧词元）；
核对不到才修。修的时候也**只许加强断言**，不许把 pin 改成「只测存在性」那种更弱的写法。

## 八、本轮追加（执行器，2026-10-05 00:00–00:3x）——IC15 内核常驻「重启 / 关闭」已落地（真机读数具名立案）

**开工核对（防重做，按 §七 的判据）**：`origin/main` 已到 `88fad0b9`。§七 钉的那 5 条红**已被会话在 `9ed4f313` 修掉**
（4 处契约 pin + `StoragePanel.render.test.tsx` 改按 testid 定位），且该提交 **CI 双绿**：`Nightly` run `37207925081`
success、`Windows Full Test` run `37207924668` success ⇒ 按防重做判据**跳过、没有重做**。会话的 IC14（`660c20e3`）同样双绿
（`build / Verify` success、Windows 8/8 success）；`097226a1` 那一轮被 `cancel-in-progress` 顶掉 ⇒ **cancelled 无判决**（不是红）。

**本轮取 v1.84.0 的下一条 = IC15**（§六 ① 的指路）。开工时树干净、无在跑构建/真机进程（会话 23:58 收尾后空闲）。

**缺口核实（按「补缺口前先在代码里确认它真的缺」）**：`notebook:restart` / `notebook:shutdown` 两条通道 + preload +
主进程工作流**全都在** ⇒ 缺口只在渲染层：重启按钮的唯一挂载点是 **R 专用**的推荐横幅
（`restartRecommended` = 活动语言是 R 且该环境被标 `restartRecommended`），**python 内核与空闲的 R 内核在界面上没有
任何重启/关闭入口**。

**落地（`NotebookPreview.tsx` + 9 语 + 渲染用例；零新通道 ⇒ 零契约计数涟漪）**：

- 头部新增常驻控件组 `kernel-controls`：`kernel-restart-button` / `kernel-shutdown-button` + 回执 `notebook-kernel-notice`；
- **关闭**走既有 `notebook.shutdown`（与 agent 收起会话用的是同一条）；它回的是**回执不是状态快照** ⇒ 面板随后
  `loadNotebookState()` 重读会话真值（不把回执当快照）；
- **重启**沿用既有 `notebook.restart`（它本就顺带清该会话的 R 重启推荐，横幅语义不变）；
- 两个控件互相串行（任一在飞都禁用），在飞写入的排水归主进程（`withSessionTeardown` / `waitForWrites`）；
- **5 键 × 9 语**：`ws.notebookRestartKernel` / `notebookCloseKernel` / `notebookClosingKernel` / `notebookKernelRestarted` /
  `notebookKernelClosed`；zh ≠ en；zh-Hant 依既有译法用「核心」（与 `common.restartRKernel` 一致）；**未新增 pending 条目**；
- 3 条渲染用例：python 内核下 **R 横幅缺席**但两控件在且**不 disabled**（防空壳）、点关闭真的到主进程并**真重读**、
  点重启真的到主进程并给出回执。

**验证（本机）**：`NotebookPreview.gate.render.test.tsx` **26 passed**；`src/renderer/src/pages/workspace` +
`src/renderer/src/i18n` **165 文件 / 1827 passed**；`typecheck` node+web 绿（node 首跑撞本机堆崩，按本机既有做法
`NODE_OPTIONS=--max-old-space-size=4096` 复跑通过 ⇒ 是本机内存问题不是类型错误）；`eslint --no-cache .` **0 error**
（132 warnings；我引入的 2 条 prettier warning 已就地改掉）；`bash scripts/pre-push-checks.sh` 全通过。CI 结论见本轮汇报。

**⏳ 真机读数未取（具名立案）**：本机 swap **14.8 G / 15.36 G 已用尽**（空闲物理页 ~1 G），而本仓明令「跑真机 e2e 前必重建、
禁裸跑 `electron-vite build`」⇒ 此刻重建 + 起 Electron 不安全（本机有堆把机器打崩的前例）。**配方（下一轮内存宽松时一次
跑完）**：`e2e/certification/` 下开 `kernel-controls.spec.ts`：provenance 夹具 attach `kernel-notebook-pane` → 断言
`kernel-controls` 可见且两按钮不 disabled → 点 `kernel-shutdown-button` → 断言 `notebook-kernel-notice` 文案与
`api.notebook.state()` 的 `kernelStatus` 落回 `idle`；再点 `kernel-restart-button` → 断言回执与状态。
**只允许跑绿之后提交该 spec**（未跑过的 spec 进仓＝留一道从未通过的闸门）。

**下一轮第一步**：① 内存宽松 ⇒ 取上面那条真机读数（IC15 收口）；② 否则顺延 v1.84.0 的下一条（**IC17** 设置页下载明细 /
**IC18** 运行时来源可见，落点见排期文件批次 4 表）。
