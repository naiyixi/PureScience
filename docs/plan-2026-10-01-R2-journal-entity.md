# R2 切片：期刊成为一等实体（与在飞的文献筛选共用一次迁移）

## 1. 现状（核实，file:line）

- `prisma/schema.prisma:477` `model Reference` 里，期刊信息只有 **`venue String?`**（自由文本）加上
  `publisher` / `volume` / `issue` / `pages` / `year`。全库搜 `journal|Journal` 只命中注释与 CSS 样式名，
  **没有期刊模型、没有 ISSN、没有任何分区/影响因子类属性**。
- 在飞计划 `docs/plan-2026-09-29-literature-screening.md` S1 明确要加 Prisma 模型 + 迁移，模型为
  `ScreeningRuleRevision` / `ScreeningAssessment` / `ScreeningOverride` / `ScreeningRun` / `ScreeningRunItem`
  ——**与期刊无命名冲突**，所以两边合成**一次**迁移是可行的（这正是 v1.78.0 切片文档里 R2 的理由）。

## 2. 实体设计（两条表，不是一条）

**`Journal`**：`id`、`normalizedName`、`issn`、`issnL`、`eissn`、`publisher`、`homepage?`、`createdAt`、`updatedAt`
（`issn` 唯一索引，允许为空：无法解析 ISSN 时不得伪造一个）。

**`JournalMetric`**（**单独一张表**，而非在 `Journal` 上加列）：
`journalId`、`kind`（`impact-factor` | `jcr-quartile` | `cas-partition` | `cas-top` | `acceptance-rate` …）、
`value`、`year`、`source`、`fetchedAt`、`note?`。

**为什么指标必须独立成表**：影响因子与分区**逐年变化**，一个不写年份、不写来源的数字不是事实。
独立成表 ⇒ 天然是**按年的历史序列**，界面永远能同时显示"哪一年、哪个来源"；把指标做成 `Journal` 上的列，
就等于把某一年某一来源的数字伪装成期刊的固有属性。

**`Reference` 增列**：`journalId String?`（可空 + 索引）。可空是关键——既有行不动，`venue` 保留原样，
未解析成功时界面按旧路径显示文本，**不需要回填**（回填会把解析失败悄悄变成"没有期刊"）。

## 3. 切片顺序与验收

| 片 | 内容 | 验收（真机/真文件） |
|---|---|---|
| **R2-U1** | 与筛选 S1 合并的**一次**迁移 + `JournalRepository`（按 ISSN upsert；无 ISSN 时按规范化名称；**导入即记录**用了哪条规则） + 指标 append-only | 迁移在真实库上跑通；同一 ISSN 两次 upsert 只出一行；指标写入后不可改（改为新增） |
| **R2-U2** | 引用落库/导入时解析 venue → `journalId`：先用 ISSN（OpenAlex/PubMed 已带），再精确规范化名称；失败要**具名原因**（`no-issn` / `name-not-exact` / `ambiguous`） | 真库：解析成功者 `journalId` 非空；失败者留空且原因可达；**绝不静默模糊合并** |
| **R2-U3** | 筛选/统计面：按分区与影响因子筛选，**指标旁必须显示年份与来源**；缺失显示"未知"，绝不显示 0 或空白 | 真机：按"一区"筛选结果正确；对无指标期刊显示"未知"；同期刊多年指标能区分年份 |
| **R2-U4** | 别名与更名（同一期刊的多种写法）：**只做精确规范化匹配 + 用户显式合并**，不做模糊自动合并 | 真机：显式合并生效；未合并的近似名不会被自动吞并 |

## 4. 与既有纪律的一致性

- **"缺一个测量就不能当成测量"**：无 ISSN 不编 ISSN；无指标显示"未知"而非 0；指标无年份/来源不落库。
- **不做会撒谎的聪明事**：按名称模糊合并期刊会制造假事实（两个不同期刊被并成一个），因此只允许精确规范化
  匹配与用户显式合并——与 K2「缺失许可证显示 unknown 而非空白」同一口径。
- **一次迁移**：R2-U1 与筛选 S1 合批，减少对真实库的迁移次数（真实数据根上有历史数据，每次迁移都要可回滚）。

## 5. 本片交付

侦察结论 + 实体设计（含"指标为何独立成表"）+ 四片顺序与验收 + 纪律口径。**未写任何实现代码**：
R2-U1 是迁移，须与筛选 S1 合批执行，单独动库会把两次迁移变成两次风险。

## 6. 依赖判定（2026-10-02 复核）：S1 **已落地** ⇒ 本片的前提变了，但本版仍不做

按队列 Q4 的要求先查依赖，结论是**依赖已解除**（不是"未落地"那一支）：

| 事实 | 证据（可复核） |
| --- | --- |
| 筛选 S1 的五个模型已在模式里 | `prisma/schema.prisma:657` `ScreeningRuleRevision`、`:674` `ScreeningAssessment`、`:695` `ScreeningOverride`、`:710` `ScreeningRun`、`:725` `ScreeningRunItem` |
| 表与索引已在**运行期 DDL** 里落库（本仓没有 `prisma/migrations/`，迁移=启动时 `CREATE TABLE IF NOT EXISTS` 序列） | 定义 `src/main/projects/prisma-client.ts:766-822`（五张表 + 六条索引）；执行 `:1107-1112` |
| 真机验收已存档 | `docs/evidence/2026-09-29-literature-screening.md`（S3/S4/S5 e2e、真机 DOM 覆盖率清单、导出回执） |
| R2 这一侧**一行实现都没有** | 全库 grep `model Journal` / `journalId` / `issn` / `JournalMetric` / `JournalRepository` ⇒ **零命中** |

**由此必须改写的前提**：本文第 3、4 节把"与筛选 S1 **合批一次迁移**"当作 R2-U1 的形态与理由，
而那次迁移**已经发生**——所以 R2-U1 现在只能是**独立的一次迁移**，第 4 节那条"一次迁移"的收益不复存在。
（这正是队列要求"若未落地就不要单独动库"的镜像情形：落地之后，合批的理由消失，独立迁移要按独立迁移的风险重估。）

**本版（v1.79.0）不做的理由（具名）**：R2 是 U1–U4 四片连成的一条能力（实体+迁移 → 解析落库 → 筛选统计面 → 别名合并），
而本版范围已被 R4 两片（U3 旋转、U4 拒绝理由）与 A 系列占满；在同一个版本里塞进半条 R2，
产出就是"有表没入口"的空壳（本仓明令禁止）。**立案到下一版**：依赖不再是阻塞项，
下一版开工即可直接从 R2-U1 起（迁移独立评估），无需再等任何前置。

