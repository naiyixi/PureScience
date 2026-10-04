# 开发技能瘦身：盘点与可执行计划（2026-10-04）

> 技能目录名本身在本仓品牌扫描的禁用词表内 ⇒ 本文件**只写路径与结论、不写其名**（与队列档同一口径）。


**为什么做**：技能本体 **99,997 字符**（162,432 字节）——距 `skill_manage` 的 **100,000 字符上限只差 3 个字符**，
所以"把新教训写进本体"这一步会被拒（上一轮就发生过，只能退而挂指针）。references 侧同时有 **307 个文件 / 3.35 MB**，
被判定为"像 per-session 日志"，会稀释"该读哪一份"的判断。

**本文件是计划，不是执行记录**；盘点数字取自只读命令（`wc -c` / `ls -S` / 前缀直方图），未改动技能。

## 1. 本体（SKILL.md）的第一刀：抽出最大一节，保住内容

| 事实 | 数字 |
| --- | --- |
| 本体现状 | 99,997 字符（上限 100,000） |
| 最大一节 | `## 每轮都生效的硬规矩`（第 66 行 → 下一个标题在第 200 行）≈ **134 行**，占本体的大头 |
| 其余标题 | `Local layout`(200) / `Run`(212) / `First-run setup`(226) / `Persistent service`(249) / `Push fork`(253) / `de-branding`(268) / `modifications landed/PORT PENDING`(300) / `OOM corrected fix`(311) / `docking`(335) / `Web RPC API`(348) / `notifications`(364) |

**做法**：把那节的"叙述与例子"移进 `references/per-round-hard-rules.md`，本体只留**可勾选清单**
（每条一句祈使句 + 一个指针）。目标：本体降到 **~85k 字符**，重新留出加教训的空间；被移走的字**不丢**，
只是从"每轮必加载"变成"需要时加载"。

**验收**：本体字符数 < 90,000；`skill_view` 仍能一次读到硬规矩的清单与指针；新教训可写回本体（试写一句再删）。

## 2. references 侧的合并簇（按文件名前缀统计，只读）

| 簇 | 现有文件数（示例） | 合并目标 |
| --- | --- | --- |
| i18n / 本地化 | `i18n-sweep-*`×7、`i18n-localization-*`×3、`i18n-copy-*`×2、`i18n-batch-*`×2、`i18n-keys-wave`、`i18n-sweep-wave`、`settings-zh-*`×6 | **1 份** `i18n-and-localization.md`（+ 1 份 dated 归档） |
| 发布 / 资产 / CI-CDN | `release-and-*`×6、`release-mechanics.md`(72KB)、`release-publishing.md`(20KB)、`release-asset-*`×2、`ui-release-lessons-2026-09`、`2026-09-i18n-ci-release-cdn-ops.md`(33KB) | **1 份** `release-and-distribution.md` |
| CI / 门禁 / 监视 | `ci-watch-loop-and-lint-gates.md`(32KB)、`ci-gates-and-measurement-discipline.md`(31KB)、`ci-monitoring-and-push-discipline.md`(30KB)、`ci-budget-contract-and-watcher-2026-09.md`、`pr-gate-*`×2 | **1 份** `ci-gates-and-discipline.md` |
| 入口层 | `entry-layer-*`×6（含 `entry-layer-audit.md` 33KB、`entry-layer-wiring.md` 32KB） | **1 份** `entry-layer.md` |
| 会话 | `session-forensics*`×2、`session-summary-*`×2、`session-package-*`×3、`session-inspection`、`per-session-*`×2、`two-tier-session-catalog`、`long-session-sidechat` | **2 份**：`session-lifecycle.md`、`session-forensics-and-packages.md` |
| 带日期的（16 个） | `debrand-2026-08`、`fork-work-2026-08`、`update-plan-2026-09-*`×2、`inline-recipes-archive-2026-09.md`(73KB) 等 | **1 份** `archive-2026-08-09.md`（或按主题并进上面各份） |

**预期**：307 → 约 **140–160** 份；被标"像 per-session 日志"的名字随之消失（合并后按主题命名）。

## 3. 执行顺序（都要在**不属于自主执行器的窗口**里做）

1. ~~**本体抽出**（第 1 节）~~ ✅ **已完成（2026-10-04）**：`references/per-round-hard-rules-detail.md`
   （58,716 字符，含目录，**原文未改、只挪位置**）；SKILL.md 该节现在是「三条编号硬规矩 + 一页清单（17 行）+ 指针」。
   **实测数字：本体 99,997 → 47,606 字符**；references 307 → 308。
   **验收（计划里定的那条）**：用 `skill_manage` 往正文写一条新教训——**成功**（上一轮同样的操作因超 100,000 上限被拒），
   写进去的是本轮实测教训「改核心路径后要跑整个模块目录的单测，不是只跑改动文件」（把"拒在飞"改成直接 `shutdown()` 时，
   只有 `runtime-service.test.ts` 的一条持久化顺序用例抓到它）。
   内容保全抽查：从被移段落里取 5 个特征串，SKILL.md 命中 0（除清单里我重写的总结行），detail 文件命中 1–2。
2. **合并 1 个簇试点**（建议 i18n 簇：数量最多、主题最清晰），确认"合并后仍可检索/不丢内容"的手法（保留原文串联 + 顶部索引）。
3. 其余簇按上表推进；**每簇一次提交**，每次报告"合并前后文件数 / 字符数"。
4. 收尾：在 SKILL.md 里加一条"references 按主题分簇、命名不带日期"的简短约定，防回退。

## 4. 风险与红线

- **不与自主执行器同改技能**：它每轮会读该技能、并可能在本体里追加教训 ⇒ 它跑的时候我只读不写。
- **合并 ≠ 删内容**：一份合并文件必须把各原文按小节串起来（保留可检索的原文措辞），只去掉重复的铺垫与过期的流程叙述。
- **不把"待验证"的东西写成规矩**：合并时若两处说法冲突，以**最近一次真机读数**为准，并在文件里注明哪一条被取代。

## 5. 执行记录（2026-10-04）：一次自删事故、二级恢复、以及最终读数

**这一节是执行记录**（第 1–4 节是计划），含一次真实数据损失与它换来的三条规矩。

### 5.1 合并结果

| 簇 | 合并前 | 合并后 | 内容 |
| --- | --- | --- | --- |
| settings / 应用级 zh 清扫 | 6 份 | **1 份** `settings-zh-sweep.md`（42,746 字节，6 个小节齐全） | 全保 |
| i18n 清扫 playbook | 22 份 + 目标自身 | **1 份** `i18n-sweep-playbook.md`（133,664 字节 / 90,093 字符，22 个小节齐全） | 源 88,358 字符 → 90,093 字符（+1.9% 小节标题开销），措辞未改 |
| references 总数 | **308** | **280** | −28 份 |

### 5.2 事故：合并器把"目标文件"当源删了

第一版合并脚本的目标名 `i18n-sweep-playbook.md` **同时出现在该簇的源列表里**（它本来就是这簇的一员）。
脚本先写目标、再逐份删源 ⇒ **把它刚写出的合并件连源一起删掉**（24 份、99,501 字符），而 `os.remove` 不进废纸篓。

### 5.3 恢复：22/24，两份永久丢失（已具名）

- **二级安全网救回 22 份、逐份按合并前记下的 H1 校验通过**：
  `~/.hermes/skills/.curator_backups/<ts>/skills.tar.gz`（整棵技能树快照，最新为 **2026-09-13**）。
- **永久丢失 2 份**（建于 9-13 之后 ⇒ 不在任何备份；`~/.hermes/state.db` 的 `messages` 与会话 dump 里也没有它们的写入调用/读取结果）：
  `i18n-copy-migration.md`（12,430 字节，"把可见文案迁进 9 语字典（渲染层文案归位）"）与
  `i18n-copy-cleanup.md`（5,190 字节，"i18n 与文案清账（把硬编码英文改成 9 语键）"）。
  同主题的**幸存**文件仍在（`i18n-sweep-playbook.md` 各小节、`i18n-and-release-pitfalls-2026-08.md`、
  `release-contract-i18n-recipes.md`、`multilang-coverage-remediation.md`、`terminology-cleanup.md`），
  但这两份的**独有内容不可找回**——记为本次成本。
- 恢复判据：抽出后逐份比对**合并前记下的 H1**（24 份的标题在丢失前已打印并留档），不一致的不写回。

### 5.4 三条新规矩（已写进技能 `references/skill-file-budget.md`，防复发）

1. **合并前先把源复制到树外**（持久位置 `~/.hermes/skill-merges/<日期>/<簇>/`——**不要只放 scratch**：scratch 闲置 24h 会被清理，事故当天的那份副本正是放在 scratch 里才需要立刻另存）——树外副本是唯一能立刻回滚的东西。
2. **合并器绝不许删"目标文件"自身**：写完**先验证**（目标在盘且 ≥ 源字符数×0.95）**再**逐份删源，且每份都做 `abspath(src) != abspath(target)` 判断。
3. **候选提取不许按"最大"取**：`skill_view` 的结果含 SKILL.md 正文 + **全量文件清单** ⇒ 每个 references 名都能命中它，按长度取最大必把 SKILL.md 当正文、把真候选挤掉；判据要用**该文件自己的标题行**。

### 5.5 分批推进结果（每批都是：树外备份 + 记 H1 清单 → 合并 → 验证目标在盘且小节齐全 → 才删源）

| 批次 | 簇 | 源份数 | 落点 | 落点字节 | references 总数 |
| --- | --- | --- | --- | --- | --- |
| 0 | i18n 清扫 playbook + settings zh | 22 + 6 | 2 份（`i18n-sweep-playbook.md` 133,664 / `settings-zh-sweep.md` 42,746） | 见左 | 308 → 280 |
| 1 | 发布 / CI / CDN（含 `release-mechanics.md` 本体） | 26 | 5 份（`release-mechanics.md` 130,289 · `release-publishing.md` 67,089 · `ci-gates-and-discipline.md` 84,405（新）· `ci-monitoring-and-push-discipline.md` 72,893 · `pr-gate-diagnosis.md` 21,182） | 见左 | 280 → 255 |
| 2 | 入口层 / 会话 / 带日期的会话沉淀 | 28 | 4 份（`entry-layer-audit.md` 101,540 · `session-forensics-and-packages.md` 46,845（新）· `session-lifecycle-and-controls.md` 33,685（新）· `archive-2026-08-09-session-logs.md` 134,972（新）） | 见左 | 255 → 230 |
| — | **合计** | **82 份并入 11 个主题落点** | — | — | **308 → 230（净 −78）** |

- 每批的**源副本 + H1 清单**在 `~/.hermes/skill-merges/2026-10-04/`（3 个批次目录 + 2 份批次定义 JSON，共 82 份源副本 / 1.0 MB；scratch 下的同名副本只是工作区，**持久件在这里**）。
- 校验口径：合并后逐份 grep `^## <源名>$`，**每批 0 缺失**才算通过；落点文件必须在盘且 ≥ 源字符数×0.95。
- 逐份 H1 与"是否在盘"的抽查同时确认了：**目标名在源列表里时不会再自删**（批次 1 与 2 都各有 3 个目标名本身在源列表内，均正常保留）。

### 5.6 后续（本项未完成的部分）

references 仍余 **230 份**（计划目标是 140–160）。按前缀看还剩这些成簇的机会（示例）：
`runtime-*`×6、`artifact-*`×8、`settings-*`×6、`renderer-*`×5、`v014x-*`×6、`agent-framework-*`×3、
`ipc-channel-*`×3、`mcp-*`×5、`xai-oauth-*`×2、`website-content-*`×2、`performance-*`×3，
以及**两簇前缀本身就在本仓禁用词表内**的同主题文件（外部参考产品同步、对照基准产品研究各一簇）——
此处**不复述其字面**（照本仓「词表只存在于 `scripts/brand-patterns.sh`、读它不要复述」的口径）。
**每一簇都按 5.4 的三条规矩做**（树外备份 → 验证后删源 → 标题校验），批次定义写成 JSON 留档。
