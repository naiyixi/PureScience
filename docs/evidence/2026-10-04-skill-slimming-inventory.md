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
