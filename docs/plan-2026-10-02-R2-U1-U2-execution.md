# R2-U1+U2 执行清单（下一版开工用；本轮只写计划，未动库、未写实现）

> 依据：`docs/plan-2026-10-01-R2-journal-entity.md`（实体设计与 U1–U4 验收）＋ 本文件记录的**落地机制**（下面每条都带 file:line，读自当前 HEAD）。
> **为什么 U1 不能单独交**：U1 只产出实体与迁移，没有任何读取方 ⇒ 就是本仓明令禁止的「有表没入口」。U1+U2 才是**一条能力**（实体 → 解析落库）。

## 0. 本仓的「迁移」是什么（读自代码，不是猜）

- **没有 `prisma/migrations/`**：迁移＝启动时的**运行期 DDL**，全部是 `CREATE TABLE/INDEX IF NOT EXISTS`；
- 定义处：`src/main/projects/prisma-client.ts:766-822`（`Screening*` 五张表 + 七条索引，写法可直接照抄）——**本轮亲自读过**；
- 执行处：同文件 `:1107-1112`（按序列执行）——**引自既有计划表，开工时先复核这一处行号**（本轮未逐行读）；新增语句必须挂到同一序列里，否则建表不生效；
- 两条写进注释的前提：**只用逻辑外键**（无关系约束）、DDL 与 `prisma migrate diff` 生成物**逐字节一致**；
- 现有 DDL 全是「纯新增表」，因此**天然可重复执行**。

## 1. U1：实体 + 迁移 + Repository

### 1.1 `prisma/schema.prisma`
- 新增 `model Journal`：`id`、`normalizedName`、`issn?`（**唯一索引，允许为空**——解析不出 ISSN 时不得伪造）、`issnL?`、`eissn?`、`publisher`、`homepage?`、`createdAt`、`updatedAt`。
- 新增 `model JournalMetric`：`journalId`、`kind`（`impact-factor` | `jcr-quartile` | `cas-partition` | `cas-top` | `acceptance-rate` …）、`value`、`year`、`source`、`fetchedAt`、`note?`。**指标独立成表**（逐年变化 + 来源可追溯；做成 `Journal` 的列＝把某年某来源的数字伪装成固有属性）。
- `model Reference`（`:477` 一带）增 `journalId String?`（可空 + 索引）——**既有行不动、不回填**（回填会把「解析失败」悄悄变成「没有期刊」）。
- 风格照 `ScreeningRuleRevision`（`:657-667`）：字段行内注释写清「为什么」，`@@id`/`@@index` 用复合键表达不变式。

### 1.2 `src/main/projects/prisma-client.ts`
- 新增 `JOURNAL_TABLE_DDL` / `JOURNAL_METRIC_TABLE_DDL`（照 `SCREENING_*_TABLE_DDL` 的写法，`DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`）；
- 新增索引 DDL 数组：`Journal.issn` **唯一**（`CREATE UNIQUE INDEX IF NOT EXISTS`，注意 SQLite 对 NULL 的语义：多行 NULL 不冲突 ⇒ 允许「无 ISSN」的期刊共存）、`Journal.normalizedName`、`JournalMetric(journalId, kind, year)`、`Reference(journalId)`；
- 挂进 `:1107-1112` 的执行序列。

### 1.3 ⚠️ 本仓**从未做过**的一件事：给既有表加列 ⇒ 要新写一个「幂等加列」helper
`Reference.journalId` 不能靠 `CREATE TABLE IF NOT EXISTS` 落地。SQLite 的 `ALTER TABLE ADD COLUMN` **不幂等**（列已存在即报错），所以必须：
1. 先读 `PRAGMA table_info("Reference")`（或 `sqlite_master`）判断列是否存在；
2. 只在缺失时执行 `ALTER TABLE "Reference" ADD COLUMN "journalId" TEXT`；
3. 该 helper 必须**可重复执行且不抛错**，并配一条用例：连跑两次结果相同、第二次不改任何东西。
   （这正是「真实数据根上有历史数据，每次迁移都要可回滚」那条风险的落点。）

### 1.4 `JournalRepository`（新建，位置照 `src/main/references/repository.ts` 的邻居与命名）
- `upsertByIssn(issn, fields)`：**ISSN 唯一**；同一 ISSN 两次 upsert 只出一行（验收 ①）。
- 无 ISSN 时 `upsertByNormalizedName(name)`：**只做精确规范化**（大小写/标点/空白归一），**绝不模糊合并**。
- `appendMetric({ journalId, kind, value, year, source })`：**append-only**——改指标＝新增一行，不 UPDATE（验收 ②）；`year`/`source` 缺失 ⇒ **拒绝落库**（不是落 0、不是落空串）。
- 导入时**记录用了哪条规则**（`by-issn` / `by-normalized-name` / 未解析 + 具名原因），与 `Screening*` 的「每条判定留证据」同口径。

## 2. U2：解析落库（真正的消费方）

- 消费点：`src/main/references/repository.ts:237`（`client.reference.create({…})`）——引用落库处接解析器，写 `journalId`。
- 解析顺序：**先 ISSN**（OpenAlex 记录自带 `source{issn…}`；PubMed 同理），**再精确规范化名称**。
- 失败**必须具名**：`no-issn` / `name-not-exact` / `ambiguous`（同规范化名多行时**不合并**，留空并报 `ambiguous`）。
- 界面/导出沿用旧路径：`journalId` 为空时按 `venue` 文本显示，**不回填、不伪造**。
- 与 OpenAlex 连接器里既有的 venue 解析（`src/main/connectors/descriptors/literature-openalex.ts:403-425`）**不是同一件事**：那里解析的是**检索过滤用的 S-id**，不会落库；不要复用成落库路径，但可以借用它的「精确 ID 优先」口径。

## 3. 验收（真机/真文件，逐条）

| 判据 | 怎么取 |
| --- | --- |
| 迁移在真实库上跑通 | 隔离实例（`PURESCIENCE_STORAGE_ROOT=/tmp/<新>`）建库后跑 DDL 序列；**再加一次**运行验证幂等（第二次不改任何东西）。
| 幂等加列 | 上面 1.3 的用例 + 在**已存在数据的库**上跑一次（带若干既有 `Reference` 行）。 |
| 同一 ISSN 两次 upsert 只出一行 | 直接对该库查询计数（不是看接口返回值就完事）。 |
| 指标 append-only | 先写一条、再「改」一次 ⇒ 库里是**两行**，旧行逐字未变。 |
| 解析失败留空且原因可达 | 真库：成功者 `journalId` 非空；失败者留空 + 具名原因可读。 |
| **绝不静默模糊合并** | 造两个近似名（如 `Nature` / `Nature Communications`）⇒ 不同行、不吞并。 |

**纪律提醒**：真实配置根 `~/.purescience-project` 只读；所有写入落在 `/tmp` 的隔离根；凭据不入库、不入文档、不入提交。

## 4. 明确不做（本轮与下一版都不做）

- **不做模糊自动合并**（R2-U4 只做精确规范化 + 用户显式合并）；
- **不回填**既有 `Reference.venue`；
- **不给缺失指标显示 0 或空白**（R2-U3：显示「未知」并带上年份与来源）；
- 不在 U1 单独交付（见文首）。
