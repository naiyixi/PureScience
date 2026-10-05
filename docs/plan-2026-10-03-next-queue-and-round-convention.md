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

**IC18 运行时来源可见 ✅ 真机读数已取（`1 passed (15.6s)`）**：应用受管卡片显示 official / override + URL（无需先下载）。读数钉出并修掉一个真缺口：没跑过 provision 时状态走「无 provisioner 的兜底路径」而该路径没有 `bundleSource` ⇒ 恰在下载之前看不到来源；兜底状态现在也上报（环境变量解析，注释写明局限）。

**批次 4（交互收口 v1.84）状态**：IC11 ✅ IC12 ✅ IC13 ✅ IC14 ✅ IC15 ✅ IC16 ✅ IC17 ✅（组件+单测+读数，遥测那半待进度管线修好） IC18 ✅ —— 八项全部落地且各有真机读数。本批读数的净收益：**六个单元的真机取证各抓出单元测试看不见的真缺陷并当批修掉**（IC12 面板入口/类型吞字段、IC13 四处、IC14 隐式默认未标在用、IC16 推导恒为 stale-false、IC18 兜底无来源），另有三条如实立案（IC13 窗口无法卸载的结构性边界、IC14 启用通道对运行时 id 会崩 + 带外移除不失效活绑定、IC16/IC17 的进度投递与富字段缺失——建议这两条一起修）。

**批次 5（v1.85 自定义 MCP/连接器闭环）状态 ✅ 六条全部落地且各有真机读数（2026-10-05）**：IC19 详情+逐工具权限、IC20 跳过审批、IC21 登出/撤销登录、IC22 可用性徽标、IC23 连接测试、IC24 批量启停纳入自定义服务器。本批读数的净收益同前批：**六条里五条各抓出单元测试看不见的真缺陷并当批修掉**——IC19 复用只走内置目录的投影会让自定义分支必然抛（**我自己的单测在提交前抓到**）、IC20 开关读回恒为关（死控件）、IC21 根本没有登出通道、IC23 服务器起不来会让它自己的详情页报错、IC24 批量路径在 jsdom 里从未被测试（第一条渲染测试即暴露）。另有两条实测事实入档：主进程载入会**丢弃**缺 url/command 的记录（可达的不可用态是**路由冲突**）、路由冲突时**两侧都标不可用**。

**IC24 批量启停纳入自定义服务器 ✅ 真机读数已取（`1 passed (6.7s)`）**：按钮读作「Enable all 29」；批量启用后 `Probe MCP: true`、两条同名冲突的 `Broken Probe: false`，结果列表按名给出「Unavailable」。

**IC23 连接测试 ✅ 真机读数已取（`1 passed (5.4s)`）**：真 stdio 夹具 ⇒ `ok :: "The server answered with 2 tools."`；指向不存在命令 ⇒ `failed :: "The server did not answer: spawn … ENOENT"`。

**IC17 设置页下载明细（组件与单测已落，真机读数附一条缺口）**：设置页准备卡片改用共享 `DownloadProgressLine`（与工作区同源）；真机 `1 passed (40.1s)`：替身 CDN 让下载真跑，卡片百分比 1→7 逐格推进（活的），但 `hasSpeed=false` —— **同一批 tick 里的富字段 `download`（速度/大小/ETA）没有到达渲染端**，30 秒内始终缺席，而工作区那侧（IC16 读数）有。
验收建议：追这条字段在"主进程广播 → 渲染端 store"链路上是何时被丢的（候选：①广播的 `progress.download` 在某些路径没设；②store 的合并把它覆盖）。**这条与 IC16 立案的"进度广播未送达 store"很可能是同一族**——建议两件一起修，一次把"进度能到 + 富字段能到"都验掉；修好后把 IC17 的遥测那半纳入真机读数。

**进度管线：已证与未证（2026-10-05，诚实的边界）**
- **已证**：①设置页卡片是活的（百分比 1→7 逐格推进，7 个不同采样）；②同一批 tick 里的富字段 `download`（速度/大小/ETA）**没有**到达渲染端（`hasSpeed=false`，30 秒内始终缺席），而工作区那侧（IC16 读数）有；③在广播唯一咽喉点 `broadcastNotebookEnvProgress` 打的探针**在 Playwright 日志里一行都没有**——但 `[ic16-cdn]` 那类行都是 spec 进程打的，**主进程 stdout 是否进日志未经验证** ⇒ 因此"发送侧没发"**不成立为结论**（不可判定）。
- **下一步该怎么做**：先验证主进程日志能否进 Playwright 输出（否则一切发送侧探针都读不到），再用一条**能落到盘上**的诊断（例如把 `hasDownload` 计数写进实例内的临时文件）复测一次；拿到"发/没发"的定性后，①修发送侧或②修 store 合并，然后才谈把 IC17 的遥测那半纳入读数。

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

## 九、本轮追加（执行器，2026-10-05 02:27–02:5x）——让位轮 + 批次 6 前置缺口核实（只读）

**本轮判定：让位（零代码提交）。** 开工时 `git status --short` 是**会话 IC21（自定义服务器登出/撤销登录）正在改的 22 个文件**：
`connector-settings.ts`、`settings/ipc.ts`、`settings/service.ts`、`settings/workflows/connectors.ts`、`main/ipc.ts`、`preload/index.ts`、
`preload/renderer-api.d.ts`、`ConnectorsPanel.tsx`、`settings-connectors-slice.ts`(+测试)、**9 语字典全 9 份**、
`shared/renderer-contract-catalog.ts`、`shared/web-api-map.generated.ts`；`ConnectorsPanel.tsx` 的 mtime 是 **02:26:44**、
`preload/index.ts` 是 **02:26**（查证时刻 02:28）⇒ 会话此刻在写。**它的触面与任何新通道的契约连锁完全相同**
（目录 / web-api-map / renderer-api.d.ts / 9 语字典）⇒ 此刻落代码必与它撞同一批文件，按共存红线**不动工作区**。

**⚠️ §八 第一步 ① 已闭，别再重做**：IC15 的真机读数**会话已经取到**——`e2e/certification/kernel-controls.spec.ts`
**1 passed (42.0s)**（排期档 IC15 行：两控件在场且 enabled、R 横幅缺席、重启/关闭各一句回执且之后内核能重起）。
IC17 / IC18 的真机读数也均已取（`settings-download-detail.spec.ts` 40.1s / `runtime-source-visibility.spec.ts` 15.6s）。
⇒ §八 的「内存宽松后取 IC15 读数」作废；**执行器不要再碰这三个单元**。

**CI 现状（02:27 按完整 40 位 SHA 查，读数即结论，不许外推）**：

- **HEAD `5891db00` 不带任何 run**：它是纯 `docs/**`（只改排期档一行），两条车道都有 `paths:` 过滤 ⇒ **不触发是设计如此**，不是「没跑」也不是「漏跑」。
- 最近一笔**有判决**的是 `55ea560c`：`Windows Full Test` **37220222466 success**；`Nightly` 37220222576 **cancelled**（**取消 ≠ 绿**）。
- **IC19 `2170e77b` 两条车道都是 cancelled**（`Nightly` 37224149219 / `Windows Full Test` 37224148998，被 3 分钟后 IC20 的推送按
  `cancel-in-progress` 顶掉）⇒ **无判决**；它的 CI 证据只能由「包含它的下一次绿色 Nightly」代替给出（CI 跑整棵树）。
- **IC20 `3fed6d74`**：`Nightly` **37224346334** 与 `Windows Full Test` **37224346166** 在 02:27 查时仍是 **in_progress**
  （18:24:52Z 起跑）⇒ 本轮**取不到判决**，下一轮开工第一步按完整 SHA 重查，红了先归因再谈别的。

**本机环境读数 + 一次清理（不改仓库）**：开工时 swap **13.9 G / 15.36 G 已用**、空闲物理页 5,881（≈92 MB）⇒ 仍不具备
「重建 + 起 Electron」的安全余量（本机有堆把机器打崩的前例），故继续**不取真机读数**。清理：进程表里有两枚**孤儿 e2e Electron**
（PID 35600 起于 19:42、PID 38138 起于 19:52，**PPID 已是 1** ⇒ 其 Playwright 运行器早已退出、测试早已结束；其中一枚的临时
profile 目录也已随之消失），两枚各常驻 ~13 MB 且不在跑任何测试 ⇒ 已 `kill`，并删掉唯一的遗留 profile
`…/T/purescience-electron-e2e-Dp158l`。清理后空闲页 **5,881 → 9,587**（≈92 MB → ≈152 MB）、swap 前端占用未降（13.9 G→14.1 G，波动级）。

**本轮产物 = 批次 6（v1.86.0 文献 / 期刊闭环，IC25–IC30）的前置缺口核实：逐条对着当前源码核，供下一位实现者直接照做（省掉一次审计）。**

| 单元 | 缺口的真伪（实测） | 证据（file:line） | 是否要新通道 |
| --- | --- | --- | --- |
| IC25 附件历史 | **真缺口，但只在渲染层**：`pdfVersions` 全库只有 shared 类型、主进程 list 填充与主进程测试三处**消费者**，渲染层 0 命中 | `shared/references.ts:79`；`main/references/repository.ts:200-205`；面板只印当前附件 `ReferencesLibraryDialog.tsx:1180-1195`（数据来自 `references.list`，:255/:270） | **否**（数据已在 list 响应里） |
| IC26 文献 notes 读写 | **写侧无通道**：`updateReference({notes})` 的**唯一调用点是合并路径** | `main/references/repository.ts:405`；`main/references/service.ts:434`；preload 的 `references` 面 `preload/index.ts:656-700+` **无 notes 方法** | **是（1 条）**：连锁 = 目录 / preload 测试 / web-api-map / renderer-argument-shape 计数 / entry-coverage。**读半边零代码**（`shared/references.ts:76 notes` 已在 list 响应里） |
| IC27 整表同一指标 | **纯 UI 缺口**：共享解析器本就收 `defaultKind` 并在缺列时用它填 `kind` | `shared/journal-metrics.ts:45,277,283-284,339,363`；对话框只传 `{format,text}`（`JournalMetricsImport.tsx:63`） | **否**（入参已含） |
| IC28 指标上限筛选 | **真缺口**：共享筛选支持上限，但 renderer 里 `maxImpactFactor` **0 命中** | `shared/journal-metrics-overview.ts:52,219,234`；面板只有下限 `JournalMetricsPanel.tsx:275,347-354,409-416` | **否** |
| IC29 手工订正 + 单刊 claim 历史 | **写侧真缺口**（`appendMetric` 唯一调用点是导入）；**读侧已覆盖** | 写：`journal-repository.ts:308`、唯一调用 `journal-metric-import.ts:135`；读：`references.listJournalMetrics` 一次返回「journals + every claim」，面板在其上内存筛选（`preload/index.ts:686-688`） | 写侧**要**（1 条）；读侧**零代码归档候选**（差的是按刊展示，不是数据） |
| IC30 逐行归属 | **纯 UI 缺口**：outcome 本就带匹配规则与「是否新建」两个字段，对话框没印 | `shared/journal-metrics.ts:88,91`；产生点 `journal-metric-import.ts:98-99`；对话框已导入行只印 `line/kind/value/year`（`JournalMetricsImport.tsx:118-125`） | **否** |

**建议顺序（零新通道者优先，回归面小、本机可取证）**：IC28 → IC27 → IC30 → IC25（实现前先核 `ReferenceAttachmentVersion`
是否带可下载的托管文件 id，「回看旧版」是否有真动作可做）→ IC26（加通道，连锁全修）→ IC29 写侧。
**待核（我没核，留给实现者第一步）**：IC25 的 `ReferenceAttachmentVersion` 字段是否含可取的托管文件 id。

**下一轮第一步**：① `git fetch -q origin && git log --oneline origin/main -3 && git status --short` ——
树干净且桌面空闲 ⇒ 按上面顺序取 **IC28**（UI-only，1 键 ×9 语 + 渲染用例 + 若有真机余量补读数）；
仍脏 / 仍活跃 ⇒ 继续让位（只读取证）；② 按**完整 40 位 SHA** 重查 `3fed6d74` 两条 run 的判决，红则先归因（读作业级注解）再动手。

## 十、本轮追加（执行器，2026-10-05 04:55–05:1x）——IC28 期刊指标「上限」筛选已落地（真机读数具名立案）

**开工核对（防重做）**：`origin/main` = HEAD = `c8dc6f27`（= tag `v1.84.0`；Release 页 **21 资产**、
`isDraft:false`、`isPrerelease:false`，tag 提交与 HEAD **逐字符一致**）；`git status --short` **空**；
无在跑 `electron-vite` / `playwright` / `vitest` 进程（`ps` 只看到用户在跑的应用与 agent 子进程）；
上一次提交 03:21、距今约 1.5 h ⇒ 按 §九「下一轮第一步 ①」取 **IC28**。

**§九 第一步 ② 已闭（读数即结论）**：`3fed6d74`（IC20）→ `Windows Full Test` **37224346166 success**、
`Nightly` **37224346334 cancelled**（被 3 分钟后的推送按 `cancel-in-progress` 顶掉）⇒ **Nightly 无判决（取消 ≠ 绿）**；
它的 CI 证据只能由「包含它的下一次绿色 `Nightly`」代替给出（CI 跑整棵树而不是 diff）。**别把 cancelled 写成绿，也别为它重跑。**

**缺口核实（对着当前源码、按机制名 grep）**：共享筛选 `withinBounds`（`src/shared/journal-metrics-overview.ts:217-222`）
**早已同时处理下限与上限**，filter 类型也带 `maxImpactFactor`（`:52`）；`grep -rn "maxImpactFactor" src/renderer` **0 命中**
⇒ 缺口**只在渲染层**：面板只渲染了下限输入。**本单元不新建后端**，是补一个挂载点 + 一条文案。

**落地（`JournalMetricsPanel.tsx` + 9 语 + 共享/渲染用例；零新通道 ⇒ 零契约计数涟漪）**：

- 面板新增 `maxImpactFactor` 状态 + 上限输入（`aria-label` 用新键，与下限同形）+ 接进 `filter` 的 `useMemo`（依赖数组同步补齐）；
- **1 键 × 9 语**：`references.journalMetrics.filter.maxImpactFactor`（en `Impact factor ≤` / zh `影响因子 ≤` /
  zh-Hant `影響因子 ≤` / ja `インパクトファクター ≤` / ko `임팩트 팩터 ≤` / fr `Facteur d’impact ≤` /
  de `Impact-Faktor ≤` / es `Factor de impacto ≤` / ru `Импакт-фактор ≤`；zh ≠ en、繁体门禁过）；**未新增 pending 条目**；
- 共享层 **+2 用例**：上限**含边界**（值恰等于上限仍在）、下限+上限**同用**成一条区间（四桶仍等于总数，两端都记 outside the bounds）；
- 面板 **+2 渲染用例**（**真渲染 `JournalMetricsPanel` 容器**、stub `window.api.references.listJournalMetrics`）：
  ①上限 `30` 真的把两条收窄成 Nature Communications 一条，且计数行印出 `1 of 2 journals match` / `1 fall outside the bounds`；
  ②下限 `5` + 上限 `20` 同用只留 `16.6` 那条。**这类用例是必须的**——只测纯函数会在「面板根本没把新界接进 filter」时照样全绿。

**验证（本机，全部实跑）**：定向 vitest（`src/shared` + `src/renderer/src/components/references` + `src/renderer/src/i18n`）
**109 文件 / 1228 passed**；**全量 vitest `1201 passed | 16 skipped`（15639 passed | 196 skipped，400.8 s，exit 0）**；
`npm run typecheck`（node + web）**双绿**；`eslint --no-cache .` **0 error / 123 warning**（回到既有基线——我引入的那条
prettier warning 已就地改掉）；`bash scripts/pre-push-checks.sh` 全通过。

**⏳ 真机读数未取（具名立案）**：开工时 swap **14.2 G / 15.36 G 已用**、空闲物理页 5,229（≈85 MB）⇒ 仍不具备
「重建 + 起 Electron」的安全余量（本机有堆把机器打崩的前例），故**未改 `e2e/certification/**`**（未跑过的 spec 进仓＝留一道从未通过的闸门）。
**配方（下一轮内存宽松时一次跑完，只允许跑绿后提交该 spec）**：在既有 `e2e/certification/journal-metrics-panel.spec.ts`
第一条用例的过滤器读数段之后接三条：①`await dialog.getByLabel('Impact factor ≤').fill('30')` ⇒ 断言 tbody 只剩 1 行、含 `16.6`、
不含 `64.8`，计数行含 `1 of 2`；②清空上限、下限填 `5`、上限填 `20` ⇒ 只剩 `16.6`；③清空两者后回到 2 行。
（英文界面标签即 `Impact factor ≤`；该 spec 已用 `getByLabel('Impact factor ≥')` 定位下限，同一套取法。）

**CI 结论（双绿，按完整 40 位 SHA `e2ce9966…` 查）**：`Windows Full Test` run **37234788587 success**；
`Nightly` run **37234788865 success**（`build / Verify`＝lint + typecheck + test + package **success**、四平台 build 全 success、`publish` success）。

**下一轮第一步**：① `git fetch -q origin && git log --oneline origin/main -3 && git status --short`——树干净且桌面空闲 ⇒ 按 §九 顺序取
**IC27**（整表同一指标，纯 UI，`defaultKind` 入参已在，`JournalMetricsImport.tsx:63`）；仍脏 / 仍活跃 ⇒ 继续让位（只读取证）；
② 内存宽松时取本单元真机读数（上面配方）；③ 盯本单元推送后 `Nightly` + `Windows Full Test` 双绿（红了先读作业级注解归因）。

## 十一、本轮追加（执行器，2026-10-05 07:4x–08:0x）——IC27 期刊指标「整表同一指标」已落地（真机读数具名立案）

**开工核对（防重做）**：`HEAD = origin/main = 75009f9a`（IC28 的 docs 落档提交）；`git status --short` **空**；
无在跑 `electron-vite` / `playwright` / `vitest` 进程（上一提交 06:55 左右，距今约 1 h）⇒ 按 §十「下一轮第一步 ①」取 **IC27**。
**CI 核对（读数即结论）**：`75009f9a` 是纯 `docs/**` ⇒ 两条车道都有 `paths:` 过滤、**0 条 run**（设计如此，不是漏跑）；
上一笔有判决的 `e2ce9966`（IC28）＝ `Nightly` **37234788865 success** + `Windows Full Test` **37234788587 success**（双绿，与 §十 一致）。

**缺口核实（对着当前源码、按机制名 grep）**：共享请求类型带 `defaultKind`（`shared/journal-metrics.ts:45`），解析器在
缺 kind 列时用它填 `kind`（`:283-284` 的缺列判据、`:363` 的 `pick('kind') || defaultKind`），**并且单元格里的值永远优先**；
而 `grep -rn "defaultKind" src/renderer` **0 命中** ⇒ 缺口**只在渲染层**：表格没有指标列时，窗口无话可说，只能去改文件加一列。
**本单元不新建后端、零新通道 ⇒ 零契约计数涟漪。**

**落地（3 改 2 新，零新通道）**：

- 新增 `journal-metric-kind-labels.ts`：把面板里那份「五种已知指标 → 文案键」映射**搬成单一来源**，面板与会话表单都引它
  ——两份列表会让面板给一个表单提示不出来的指标加标签（或反过来），且不会有人发现；同时导出 `JOURNAL_METRIC_KINDS`（**store 自己的
  token**，不是译文）。
- `JournalMetricsImport.tsx`：新增受控输入 `[data-slot="journal-metrics-import-default-kind"]`（`aria-label` 用新键）+
  `<datalist>` 提示那五种 token（文案复用既有 5 条 `kind.*` 键，**不新增译文**）+ 一行说明；提交时
  **空值不发 `defaultKind`**（用 `toStrictEqual` 钉住「键不存在」，避免「我试过」被读成「我说没有」）；未知指标仍然允许手输。
- **2 键 × 9 语**：`references.journalMetrics.import.defaultKind` / `…defaultKindHint`（en / zh / zh-Hant / ja / ko / fr / de / es / ru；
  zh ≠ en、繁体门禁过、**未新增 pending 条目**）；i18n 覆盖 **3594 键 × 9 语 = 100.0%**。
- 用例：**新建 `JournalMetricsImport.render.test.tsx`**（该类此前**没有任何测试**，正是「表单根本没把值送出去也照样全绿」的形状）——
  ①五种建议=store 的 token 且 `list` 真挂在输入上；②填 `cas-partition` + 无 kind 列的表 ⇒ 请求**逐字**带该值且面板重读；
  ③留空 / 只输空白 ⇒ `toStrictEqual` 断言**没有这个键**。共享层 **+1 用例**：混列表（一格有值、一格空、一格另一种）⇒
  有值的格胜出、空的那格才用表级值（补上原用例**标题承诺却从未测**的语义）。

**验证（本机，全部实跑）**：定向 vitest（`src/shared/journal-metrics.test.ts` + `src/renderer/src/components/references` + `src/renderer/src/i18n`）
**7 文件 / 102 passed**；**全量 vitest `1202 passed | 16 skipped`（15643 passed | 196 skipped，363.9 s，exit 0）**；
`npm run typecheck`（node + web）**双绿**（先修掉我自己的 `Mock<…>` 类型缺口——`ReturnType<typeof vi.fn>` 让 `onImported` 不再可赋值）；
`eslint --no-cache .` **0 error / 123 warning**（既有基线）；`bash scripts/pre-push-checks.sh` **全过**（exit 0）。

**⏳ 真机读数未取（具名立案）**：开工时 swap **13.2 G / 14.3 G 已用**、空闲物理页 4,617（≈72 MB）⇒ 仍不具备「重建 + 起 Electron」的安全余量，
故**未改 `e2e/certification/**`**（未跑过的 spec 进仓＝留一道从未通过的闸门）。
**配方（下一轮内存宽松时一次跑完，只允许跑绿后提交该 spec）**：在 `journal-metrics-panel.spec.ts` 的
`the import entry stores the good row and names the refused one` 之后接一条：①同一路径打开面板；②贴一张**没有 kind 列**的表
（`journal,issn,value,year,source`，两行）；③**先不填**新输入就点 Import ⇒ 断言 `[data-slot="journal-metrics-import-error"]`
印出 store 自己那句点名 `kind (or defaultKind)` 的话（这是本单元之前的真实处境，现在成了上屏的具名拒绝）；④填
`getByLabel('Metric kind for tables without one')` = `impact-factor` 再点 ⇒ 断言 imported 行含 `impact-factor 64.8 (2023)`、
skipped 为 0、且上方表格出现表头 `Impact factor`（新列按该指标建起来）。

**下一轮第一步**：① `git fetch -q origin && git log --oneline origin/main -3 && git status --short`——树干净且桌面空闲 ⇒ 按 §九 顺序取
**IC30**（逐行归属：outcome 本就带匹配规则与「是否新建」两字段，对话框没印，纯 UI）；仍脏 / 仍活跃 ⇒ 继续让位（只读取证）；
② 内存宽松时取 IC27（上面配方）+ IC28（§十 配方）真机读数；③ 按**完整 40 位 SHA** 看本轮推送的 `Nightly` + `Windows Full Test`，红了先读作业级注解归因。

## 十二、本轮追加（执行器，2026-10-05 10:27–11:0x）——IC30 导入逐行归属反馈已落地（真机读数具名立案）

**开工核对（防重做）**：`HEAD = origin/main = 1aceb41e`（IC27 提交）；`git status --short` **空**；无在跑 `electron-vite` / `playwright` / `vitest` 进程。
B 段已全部收口（A7 ✅ / S3 ✅ / M2 ⛔ 卡产品决定）⇒ 按 §十一「下一轮第一步 ①」取 **IC30**。

**CI 核对（闭掉 §十一 遗留项 2）**：`1aceb41e` 按完整 40 位 SHA 复查 —— `Nightly` **37246004460 success**、
`Windows Full Test` **37246004268（attempt 2）success** ⇒ **双绿**。首跑 failure 确系负载抖动（隔离复跑本机绿
60 passed / 6.22 s），rerun 后通过，未当回归处理。

**缺口核实（对着当前源码、按机制名 grep）**：outcome 的 imported 分支带 `journalMatch`
（`by-issn` / `by-normalized-name` / `by-alias`）与 `journalCreated`（`shared/journal-metrics.ts` 的
`JournalMetricImportOutcome`），而 `grep -rn "journalMatch\|journalCreated" src/renderer` **0 命中**
（只被主进程与主进程用例读到）⇒ 缺口**只在该表单的报告区**：读者只能看到「line N: kind value (year)」，
哪行进了哪本刊、按哪条规则认出来、哪行新建了刊物，全不可见。**纯渲染层 ⇒ 零新通道、零契约计数涟漪。**

**落地（3 改 + 9 语）**：

- `JournalMetricsImport.tsx`：imported 行下新增 `[data-slot="journal-metrics-import-attribution"]` 一行 ——
  `{journal} · {match}`（新建时追加 ` · new journal identity`）。刊名取自面板已持有的 id→name 列表；
  **库尚未重读到新建刊物时回落到 store 自己的 `journalId`**（绝不给一个编造的名字）。`MATCH_KEYS` 以 store 的
  `journalMatch` 联合为键 ⇒ 将来多一条解析规则会编译不过，而不是把裸 token 印上屏。
- `JournalMetricsPanel.tsx`：把既有的 `mergeChoices`（id→name）传给表单（与合并控件同一来源，不新造映射）。
- **5 键 × 9 语**（`import.attribution` / `import.created` / `import.match.byIssn|byNormalizedName|byAlias`；
  zh ≠ en、繁体门禁过、**未新增 pending 条目**）；覆盖 **3599 键 × 9 语 = 100.0%**。
- 用例：`JournalMetricsImport.render.test.tsx` **+1 条**——三条 outcome 覆盖三种匹配规则、`journalCreated` 标记、
  以及「刊名不在列表里 ⇒ 回落 id」。

**验证（本机，全部实跑）**：定向 vitest（references 组件 + i18n + `shared/journal-metrics.test.ts`）
**7 文件 / 103 passed**；**全量 vitest 1202 passed | 16 skipped（15644 passed | 196 skipped，439.8 s，exit 0）**；
**双 typecheck 绿**（tsc 在默认 2 GB 堆上撞 `Ineffective mark-compacts … heap out of memory` ⇒ 与 CI 同用
`NODE_OPTIONS=--max-old-space-size=3072` 通过；这是本机内存吃紧下的**工具进程堆上限**，不是代码缺陷）；
`eslint --no-cache .` **0 error / 123 warning**（既有基线）；`bash scripts/pre-push-checks.sh` **全过**（exit 0）。

**提交 `796757bf`**（12 文件，+174/−12），已推送，`HEAD == origin/main`。

**CI（收尾时已取到终态，双绿）**：`796757bf` 按完整 40 位 SHA —— `Nightly` **37256857057 success**
（Resolve matrix / Verify / 四平台 build / **publish** 全绿）、`Windows Full Test` **37256856740 success**
⇒ **双绿**。（本节的 docs 落档提交 `9a6438b4` 是纯 `docs/**` ⇒ `paths:` 过滤下 0 条 run，设计如此，不是漏跑。）

**⏳ 真机读数未取（具名立案）**：开工时 swap **14.1 G / 15.36 G 已用**、空闲物理页一度只剩 ~4k
⇒ 不具备「重建 + 起 Electron」的安全余量，故**未改 `e2e/certification/**`**（未跑过的 spec 进仓＝留一道从未通过的闸门）。
**配方（下一轮内存宽松时一次跑完，只允许跑绿后提交该 spec）**：在 `journal-metrics-panel.spec.ts` 那条导入用例后接一条 ——
①贴一张**同一指标、多行、其中一行是库里没有的新刊**的表并导入；②断言 imported 区出现
`[data-slot="journal-metrics-import-attribution"]`，既有刊那行含刊名 + 对应匹配文案（`by-issn` 行含 `matched by ISSN`）；
③新刊那行含 `new journal identity`，且**面板重读后刊名不再是 id**。

**下一轮第一步**：① `git fetch -q origin && git log --oneline origin/main -3 && git status --short`——树干净且无
dev/build/test 进程 ⇒ 按 §十一 的顺序取 **IC25**（文献附件历史，**只做「列出附件历史」半边**——数据已在 list 响应里，
纯 UI；「回看旧版」要新通道或一条路径来源，先别落一个点不动的按钮）；② 内存宽松时取 **IC27 / IC28 / IC30**
真机读数（配方见 §十一、§十、本节）；③ 按完整 40 位 SHA 看 `796757bf` 的 `Nightly` + `Windows Full Test`。

## 十三、本轮追加（执行器，2026-10-05 13:43–14:0x）——旁路只读取证：批次 7 前置缺口核实 + 三笔提交的 CI 判决

**本轮判定：旁路（不对工作区落任何代码、不改 `e2e/certification/**`）。** 开工时的事实：

- `HEAD = origin/main = 159066e9`；`git status --short` 是**桌面会话正在改的 18 个已跟踪文件 + 1 个新文件**：
  `src/main/references/{application-commands.ts,ipc.ts}`、`src/preload/{index.ts,renderer-api.d.ts}`、
  `src/renderer/src/components/references/{JournalMetricsPanel.tsx,JournalClaimEditor.tsx}`、9 语字典全 9 份、
  `src/shared/{renderer-contract-catalog.ts,web-api-map.generated.ts}`，另有两张 `docs/evidence/*.png` 被重写；
  最新 mtime **13:42:40**（查证时刻 13:43）⇒ 会话此刻在写**批次 6 的最后一条**（新增期刊指标主张的写入通道，
  按触面判断为 IC29；未逐字核会话意图）。它的触面与任何新通道的契约连锁**完全相同**（目录 / 生成的 API 映射 /
  前载类型 / 9 语字典）⇒ 此刻落代码必与它撞同一批文件，按共存红线**不动工作区**。
- 本机 swap **13.6 G / 14.3 G 已用**、空闲物理页 4,291（≈67 MB）⇒ 仍不具备「重建 + 起 Electron」的安全余量。
- 卫生复核：**无**孤儿 e2e Electron 进程、**无**遗留 `purescience-electron-e2e-*` 临时根（两处都逐条核过）。

**批次 6 现状（会话已完成的三笔，别再重做）**：IC25 `c7fcea3f`、IC26 `a8ea33d7`、IC28 真机读数 `159066e9`
三笔各带认证 spec（`reference-attachment-history.spec.ts` +96 行 / `reference-notes.spec.ts` +83 行 /
`journal-metrics-panel.spec.ts` +40 行）；加上此前 IC27 `1aceb41e`、IC30 `796757bf`，批次 6 只剩会话在做的 IC29。

**CI 判决（按完整 40 位 SHA 查；取消 ≠ 绿）**：

| 提交                | Nightly              | Windows Full Test    |
| ------------------- | -------------------- | -------------------- |
| `c7fcea3f`（IC25）  | 37267562535 cancelled | 37267562108 **success** |
| `a8ea33d7`（IC26）  | 37268607426 cancelled | 37268607106 cancelled |
| `159066e9`（IC28 读数）| 37268817932 in_progress | 37268817667 in_progress（查证时）|

⇒ 前两笔都被后续推送按 `cancel-in-progress` 顶掉，**无判决**；它们的 CI 证据只能由「包含它们各自的下一次
绿色 `Nightly`」代替给出（CI 跑整棵树而不是 diff）。第三笔查证时未出判决，下一轮按完整 SHA 复查。

**发布位点（台账，供用户与下一轮核对）**：`gh release list` 的 Latest = **v1.84.0**（2026-10-04T20:05Z），
`package.json` 版本 = `1.84.0`，README 首屏横幅 = v1.84.0（三者一致）。而**批次 5（对应 v1.85.0）与批次 6
（对应 v1.86.0）的代码都已落地、都还没发布** ⇒ 眼下欠**两个版本边界**，且这两个边界都不可能靠一次发布补完
（一批 = 一个版本号）。建议：IC29 收口后按 v1.85.0（批次 5：自定义服务器闭环六条）→ v1.86.0（批次 6：
文献/期刊闭环六条）两次走完发版流程；若决定合并成一次，需按「版本号取自实际已发布位点」的口径在 CHANGELOG
里写明合并理由，别照批次标签连抬两个号又只发一次。

**本轮产物 = 批次 7（v1.87.0：出网 / 存储 / 视觉 / 诊断的可核性，IC31–IC38）逐条对着当前源码核过的前置缺口表**
（分类方式同 §九，供实现者直接照做，省掉一次审计）：

| 单元 | 缺口的真伪（本轮实测） | 证据（file:line） | 要新通道？ | 成本与判据建议 |
| --- | --- | --- | --- | --- |
| IC31 egress 读/写错误态 | **真缺口（纯 UI）**：读 `getEgress().then()` **无 catch、无错误态、无重试** ⇒ 失败时 `loaded` 恒 false，面板**永久停在 Loading**；写 `setEgress().catch(() => undefined)` **静默吞错**且乐观值不回滚 ⇒ 用户看到的值可能没落盘 | `NetworkPanel.tsx:326-336`（读）、`:338-344`（写） | 否 | 1 键 ×9 语；渲染用例：stub 拒绝一次 → 出错误态 + 重试；写拒绝 → 值回到已保存态 |
| IC32 egress 接管时手动代理 | **真缺口（纯 UI）**：`ProxySection` 只读 `getProxy()`，**全程不读 egress 状态**（文件里 egress 引用全在 `EgressSection`），而它自己的注释写明「egress 开启时手动代理不生效」⇒ 控件照常可编辑可保存、写进去的值不生效，**页面上没有一个字说明** | `NetworkPanel.tsx:503-507`（注释即契约）、`:508-528`（只取 proxy） | 否（egress 读取通道已有） | 1–2 键 ×9 语；渲染用例：egress on ⇒ 控件 disabled + 说明在场；off ⇒ 恢复 |
| IC33 审批卡剩余有效期 | **真缺口（纯 UI）**：`expiresInSec` 主进程已发，渲染层只拿它做**到期退休的定时器**，卡片自身**不印剩余时间**，到点**无声消失**（用户只看到对话像卡住） | `shared/egress.ts:133-139`；`EgressApprovalCard.tsx:1-83`（通篇无 expiresInSec）；`WorkspacePage.tsx:1215,1240` | 否 | 2 键 ×9 语（剩余秒数 + 超时具名解释）；渲染用例断言倒计时与「已超时」文案 |
| IC34 存储信息读失败 | **真缺口（纯 UI，后果比预期重）**：`getInfo().then(setInfo)` **无 catch** ⇒ 失败后 `info` 恒 null，而那一段的分支是 **Loading**，且「改变位置」入口被 `info !== null` 关掉 ⇒ 一次读失败让**整段数据位置（含迁移唯一入口）永久不可达且不说原因** | `StoragePanel.tsx:117-119`；`:336-344`（门与 Loading 分支） | 否 | 1 键 ×9 语 + 重试；渲染用例：stub 拒绝 → 错误态 + 重试按钮，重试成功 → 恢复可操作 |
| IC35 迁移 staleEvidence 明细 | **真缺口（纯 UI）**：`StaleProvenanceEvidence` 已带 kind/path/recordedDigest/expectedDigest/runId/project/session，弹窗**只印条数** | `shared/storage.ts:66-78`；`StorageMigrationModal.tsx:395-407`（只印 length） | 否 | 明细展开 + 1 键 ×9 语；渲染用例喂两条 evidence，断言 path/runId 在场 |
| IC36 视觉转译证据只读面 | **真缺口（要新通道）**：`visionEvidence` 的消费者**全在主进程**（`image-input-compatibility-owner.ts`、`runtime-composition.ts`、`prisma-client.ts` + 仓储自身），渲染层 / preload / 契约目录 **0 命中**（目录里只有 `settings:set-vision-model`）⇒ 用户看不到「哪张图由哪个模型转译成什么」 | `main/vision/vision-evidence-repository.ts:37-95`；`shared/renderer-contract-catalog.ts:423` | **是（新通道组）** | 本批最大件：契约连锁全修（目录 / preload / 两份 Web 面 / inventory / entry-coverage）+ 9 语 + 真机读数；建议排在本批最后并单独立项 |
| IC37 支持包体积与脱敏条数 | **真缺口（纯 UI）**：`ExportSupportBundleResult` 已带 `bytes` / `redactions`（主进程写入结果即有这两个数），面板只用 `path` | `shared/diagnostics.ts:63-69`；`GeneralPanel.tsx:105-114`；`diagnostics/support-bundle-ipc.ts:13` | 否 | 1 键 ×9 语（两个数写进成功文案）；渲染用例断言两个数逐字上屏 |
| IC38 远程访问关闭态的公网地址 | **真缺口（纯 UI）**：快照字段的注释明写「saved … including while locally disabled」，主进程照发，而渲染层**只在 `enabled && accessUrl` 时显示链接**（该字段只在一处渲染测试里出现过） | `shared/remote-access.ts:53-54`；`main/remote-access/service.ts:150`；`RemoteControlPanel.tsx:432-484` | 否 | 关闭态给只读地址 + 复制 + 「关掉后该地址不可达」的如实说明；2 键 ×9 语 |

**建议顺序（零新通道优先，回归面小、本机可取证）**：IC31 → IC34 → IC37 → IC35 → IC33 → IC32 → IC38 → IC36（单独立项）。
**一句提醒**：以上分类是**当前源码**的实测结论；实现前若源码已动，以当时的 `file:line` 复核为准（会话在推时尤其如此）。

**下一轮第一步**：① `git fetch -q origin && git log --oneline origin/main -3 && git status --short`——树干净且无
dev/build/test 进程 ⇒ 按排期进入**批次 7（v1.87.0）**、先取 **IC31**（零新通道）；仍脏 / 仍活跃 ⇒ 继续旁路取证
（只读，不改树）；② 按完整 40 位 SHA 复查 `159066e9` 与 IC29 的 CI；③ 内存宽松时补 **IC27 / IC28 / IC30**
真机读数（配方见 §十一、§十、§十二）。

## 十四、本轮追加（发版窗口，2026-10-05 14:0x–）——v1.85.0 发版 + 批次 6 读数的可证部分已取

**发版**：窗口内 `hermes cron pause 2be4405e5dc6` 已生效（核对完 Release 页再 resume）。**v1.85.0 = 文献 / 期刊闭环（批次 6，IC25–IC30）**：版本号取自**实际已发布位点**（`gh release list` 的 Latest=v1.84.0、`package.json`=1.84.0）⇒ 按「一批=一版」但**不照批次标签连抬号**的口径，只抬到 **1.85.0**。

**读数补齐（§十三 的 ③）**：
- **IC27 + IC30 的存储 / 数据契约已取真读数**（新增 `e2e/certification/journal-import-attribution.spec.ts`）：没有指标列的表配上 `defaultKind` ⇒ `{"imported":1,"skipped":0,"journalsCreated":1,"first":{"kind":"impact-factor","value":"7.3","year":2024,"journalMatch":"by-issn","journalCreated":true,"line":2}}`，store 回读 `[{"kind":"impact-factor","value":"7.3"}]`。`1 passed (5.2s)` + 1 skipped。
- **IC28** 的读数已由 §十 落地（`4 passed (35.1s)`，含上限 20 留 16.6 筛 64.8 的正向断言）。

**立案（未修，落点已写明）**：**IC30（连带 IC27）的窗口渲染那半 —— 实测有缺陷**：主字段确已填、Import 按钮确可用、点击确落地、渲染进程无报错，而四个结果节点（`journal-metrics-import-summary` / `-error` / `-imported` / `-attribution`）**始终不存在**，面板文本停在 `Import metrics Paste a publisher table (CSV/TSV)… Import`；代码确在运行包里（`out/renderer/assets/index-lwOwGRux.js` 含 `journal-metrics-import-attribution` 与 `defaultKind`），**不是陈旧构建**；两条旁证排除探针自身的错（同一段文本经桥接导入成功、点击后主字段仍在 ⇒ 组件没有重挂载丢状态）。**后续从这里起步：窗口对那次点击的处理**。spec 以 `test.fixme` 挂起 + 文件头写全证据（本仓「红 spec 不落树」的合规写法）。三处已同步记录：CHANGELOG v1.85.0 的「明确没做」段、排期档 IC30 行、本段。

**给执行器的两条定位教训**（写读数时会咬人）：① 对话框里与**头按钮同名**的按钮会让 `getByRole` 命中两个 ⇒ 30 秒超时，改 `.locator('visible=true').first()`；② 按 **placeholder** 抓控件可能落到相邻的**建议输入**上（本例的指标选择器是 input+datalist）——症状是「按钮点了没反应」，真因是主字段仍为空、处理器按守卫**静默返回**。这两条与 §十三 的读数是同一类：**现象与真因隔着一层，先让读数具名到元素与值**。

**发版结果（本轮收尾）**：**v1.85.0 已发布** ✅ —— Release 页 `draft=false`、非预发布、**21 资产**、**Latest**；`Release` / `Nightly` / `Windows Full Test` **三条全绿**；正文 21,339 字符（成熟度自陈 + 批次 6 六条 + 质量与证据口径 + 明确没做）。执行器已 `resume`（发版窗口结束）。**版本号说明**：本档原写「批次 6 = v1.86.0」，实际按「版本号取自上一个**已发布**位点」的口径发布为 **v1.85.0**（v1.84.0 的正文已含批次 5 ⇒ 批次 6 是 tag 以来唯一未发布内容，不连抬两个号）。

**本轮给后续轮次的第四条坑（本会话咬人三次）**：**Electron 的 e2e 跑的是 `build:e2e` 的产物**，只跑 `build:web` 会让读数落在陈旧渲染包上——表现为「改动没生效」或「定位器超时」这类**假红**。另：**设置页视觉基准要与发布版本解耦**——`v{version} · {releaseCode}` 那一行在打包态与未打包构建里取值不同，spec 只藏按钮与 `<p>` 会漏掉它本身（CI 因此差 6020 像素、1.0%、重试复现，而本机因取到旧值反而"通过"）。

## 十五、本轮追加（执行器，2026-10-05 17:33–18:0x）——批次 7 开工：IC31 egress 读/写错误态已落地（真机读数具名立案）

**开工核对（防重做）**：`HEAD = origin/main = cb8befa6`（**17:32:51**，发版收尾的 docs 提交，我开工时它刚落地 30 秒）。`git status --short` **只有 2 个文件**：
`docs/evidence/2026-10-03-{journal-metric-conflict,primary-brand-blue}.png`，mtime **15:23:34/44** —— 由 `e2e/certification/journal-metrics-panel.spec.ts:165/632` 自己重跑刷新的截图，
**不是本轮产物、我没有提交也没有动它**（会话在 14:26 的 `9b1e367e` 提交过同一对截图的更早一次刷新；这次刷新发生在 15:23 的发布车道修复跑里）。
进程表无 `electron-vite` / `playwright` / `vitest`；本机 swap **10.06 G / 11.26 G 已用**、空闲物理页 35,481（≈581 MB）⇒ 仍不足以跑 `build:e2e`（8 GB 堆）+ 起 Electron，
故**未改 `e2e/certification/**`**（未跑过的 spec 进仓＝留一道从未通过的闸门）。
**CI 核对（读数即结论）**：`cb8befa6` 是纯 `docs/**`（2 个 plan 文档）⇒ 两条车道都有 `paths:` 过滤、**0 条 run**（设计如此，不是漏跑）；
上一笔带代码的 `ecf8ef71`（= tag `v1.85.0` 的提交）三车道**全绿**：`Nightly` **37285007658 success**、`Windows Full Test` **37285007125 success**、`Release` **37285031894 success**。
`159066e9`（IC28 读数）与 `ebb37e1f`（IC29）两条**都是 cancelled**（被后续推送按 `cancel-in-progress` 顶掉）⇒ **无判决，取消 ≠ 绿**；它们的 CI 证据由「包含它们的下一次绿色 `Nightly`」即 `ecf8ef71` 这一次代替给出（CI 跑整棵树而不是 diff；`ecf8ef71` 的祖先含两者）。

**发布位点核验（不靠"看列表"）**：`gh release view v1.85.0 --json name,tagName,isDraft,isPrerelease,assets` ⇒ `draft=false`、`isPrerelease=false`、**21 资产**（mac arm64/x64 的 dmg+zip+blockmap、linux AppImage+deb、win-x64 setup.exe+zip、`SHA256SUMS.txt`、`RELEASE-CERTIFICATION.json`、`version.json`、`latest*.yml`、`arm64-mac.yml`/`x64-mac.yml`），标记 **Latest**；tag `v1.85.0` → 提交 **`ecf8ef71`**，与发布 run 的 `head_sha` 逐字符一致。

**版本号台账更正（已改档，防下一轮照旧标签取号）**：`docs/plan-2026-10-03-interaction-closure-schedule.md` 的总览表原按批次标签写（批次 4/5/6/7 = v1.84/1.85/1.86/1.87），而实际位点是**批次 4 + 批次 5 同版发布为 v1.84.0**、**批次 6 = v1.85.0**（已发布）⇒ 批次 7 起全部**顺延一号**：批次 7 = **v1.86.0**（下一版）、8 = v1.87.0、9 = v1.88.0、10 = v1.89.0、对标批次 = v1.90.0+。表格、四个批次小节标题与依赖草图共 17 处已按此改正，并在总览表下加了一条「版本号列是排期标签、不是发版承诺」的口径说明。

**本轮取 v1.86.0（批次 7）的 IC31**（§十三 建议顺序的第一条，零新通道）。

**缺口核实（对着当前源码、按机制名核；§十三 的结论仍成立）**：`EgressSection`（`NetworkPanel.tsx:320` 起）——读 `getEgress().then()` **无 catch**（失败即 `loaded` 恒 false ⇒ 永久停在 Loading，无原因无出口），写 `setEgress(next).catch(() => undefined)` **静默吞错**且**乐观值不回滚**（用户看到的值可能根本没落盘）。两条都是真缺口，且都只在渲染层 ⇒ **零新通道、零契约计数涟漪**。

**落地（1 改源码 + 2 键 × 9 语 + 6 条渲染用例，`NetworkPanel.tsx` + `NetworkPanel.render.test.tsx`）**：

- 读侧改为三态 `loadState: 'loading' | 'ready' | 'error'`：失败渲染**具名错误 + `role="alert"` + 重试按钮**（`data-slot="egress-load-error"` / `egress-retry-load`，复用既有 `common.retry`，不新增键），重试真的重新取一次（用例断言 `getEgress` 被调用 2 次且错误节点消失、开关回来）。
- 写侧加 `persisted` ref（最近一次被主进程确认的值）：拒绝时**回滚到它**并显示 `data-slot="egress-save-error"`（`role="alert"`），下一次成功的保存清掉提示。乐观更新保留（点一下开关必须立刻动），但不再可能停在未落盘的值上。
- 抽了 `EMPTY_EGRESS_SETTINGS` 常量（原先两处字面量）。
- **2 键 × 9 语**：`settings.egressLoadFailed` / `settings.egressSaveFailed`（zh 与 en 不同形、zh-Hant 纯繁体、未新增 pending 条目；i18n 覆盖 **3618 键 × 9 语 = 100.0%**）。
- 用例放在**新开的 `describe('NetworkPanel egress error states')`**，故意排在文件**最前**：既有那条代理用例用了 `void act(async …)`（未 await），会留下跨用例的 act 作用域 —— 我第一次把新用例追加在文件末尾时**两条全红**（渲染根本没跑到 ready，`querySelector` 全 null，1–3 ms 失败），移到前面即全绿。这条已写进用例注释，供后人别再踩。

**自查抓到我自己的一条红（重要）**：第一版把 `setLoadState('loading')` 放在 `load()` 里由 `useEffect` 调用 ⇒ eslint 报 **1 error**（`react-hooks` 的「Calling setState synchronously within an effect can trigger cascading renders」）⇒ **CI 的 Verify 会红**。修法：`load()` 不再置 loading（初态本就是 loading），只有**重试按钮的事件处理器**里置 loading（`retry()`）。**教训**：全仓 `eslint --no-cache .` 必须在提交前跑（`npm run lint` 的缓存 + 只跑改动文件都会漏掉这条 error）。

**验证（本机，全部实跑）**：定向 vitest（`src/renderer/src/pages/settings` + `src/renderer/src/i18n` + `src/renderer/web`）**67 文件 / 714 passed**；
`node scripts/i18n-coverage.mjs` 九语 **3618 键 / 100.0%**；`typecheck` node + web **双绿**（用 `NODE_OPTIONS=--max-old-space-size=3072`，本机内存吃紧下的工具进程堆上限）；`eslint --no-cache .` （修完上面那条 error 后）**0 error / 118 warning**。
`bash scripts/pre-push-checks.sh` **全过**（品牌扫描 / README 版本 / CHANGELOG / 双语同步）。
**CI 判决（实测，取消 ≠ 绿）**：本轮推送 `dc34bfd5` 的两条车道（`Nightly` 37291995233 / `Windows Full Test` 37291994731，17:44 排队）**在 17:54 被会话的 `24730be1` 推送按 `cancel-in-progress` 顶掉**（`completed/cancelled`）⇒ **无判决**；IC31 的 CI 证据只能由「包含它的最新绿色 `Nightly`」给出（CI 跑整棵树而不是 diff），即 `24730be1`（37293071065 / 37293070554）或其后继。**不要再为 `dc34bfd5` 重跑。**

**⚠️ 并发实测（本轮咬到一次）**：会话在**同一棵工作树**里工作 —— 我 17:44 推送 `dc34bfd5` 后，会话 17:54 推了 `24730be1 feat(settings): IC34 存储信息读失败有具名错误与重试（真机读数已取）`（含 `e2e/certification/storage-info-read-failure.spec.ts` 103 行 + 排期档行），**恰好是我 §十三 计划里的下一条**；随后会话继续在飞 **IC37**（`GeneralPanel.tsx` 的支持包体积/脱敏条数 + 新键 `settings.supportBundleDetail`，树此刻脏）。⇒ **IC34 与 IC37 都不要重做**（防重做规则）。

**⏳ 真机读数未取（具名立案）**：本机 swap **10.06 G / 11.26 G 已用**、空闲物理页 35,481（≈581 MB）——比 §十三 记的 ~67 MB 宽松，但仍不足以跑 `build:e2e`（8 GB 堆）+ Electron（本机有堆把机器打崩的前例），故**未改 `e2e/certification/**`**。
**配方（下一轮内存宽松时一次跑完，只允许跑绿后提交该 spec）**：在 `e2e/certification/` 开 `egress-error-states.spec.ts` —— 骨架照 `network-panel.spec.ts`（若不存在则照 `settings-download-detail.spec.ts` 的设置页骨架）：
① 打开设置 → 网络页，断言 `[data-slot="egress-section"]` 与主开关在场（这是**当前**的正常路径读数，用来对照）；
② 让读失败只能用**替身**方式——渲染层的 `getEgress` 走主进程通道，真机上无法让它拒绝，因此这条要**如实写明：真机只读覆盖"正常路径 + 重试按钮在场"这一半**，写失败的**回滚**那半由渲染用例覆盖（jsdom），**不许把 jsdom 写成真机**；
③ 若要做真机失败读数，可行路径是**在隔离实例里改配置根让它读到坏设置**（例如把 `settings.json` 的 egress 段写成非法形状，看主进程是否拒绝并让渲染端走 error 分支）——需先探针确认主进程对该形状的行为（拒绝 vs 兜底），**探针先行，别先写断言**。

**下一轮第一步**：① `git fetch -q origin && git log --oneline origin/main -3 && git status --short`，**先按提交把会话已完成的单元划掉**（2026-10-05 17:54 实测：**IC34 已由会话 `24730be1` 落地并带真机读数**；会话当时在飞 **IC37**）⇒ **这两个都不要再做**；
② 树干净（除那 2 张非我产生的 evidence PNG）且无 dev/build/test 进程 ⇒ 按 §十三 顺序取**下一个未被认领的单元 = IC35**（迁移 `staleEvidence` 明细展开；`shared/storage.ts:66-78` 已带 kind/path/两个 digest/runId/project/session，弹窗只印条数 ⇒ 纯 UI、零新通道）；仍脏 / 仍活跃（**大概率如此——会话正在推 IC37 的收尾**）⇒ 继续旁路取证（只读，不改树，可顺手核 IC32/IC33/IC38 的缺口是否仍成立）；
③ 按**完整 40 位 SHA** 复查 CI：`dc34bfd5` 两条车道**已被取消、无判决**（见上），改查 `24730be1`（Nightly 37293071065 / Windows 37293070554）及其后继的终态；红了先读**作业级注解**归因，不要重跑单个 job；
④ 内存宽松时补 **IC27 / IC28 / IC30** 真机读数（配方见 §十一、§十、§十二）。
