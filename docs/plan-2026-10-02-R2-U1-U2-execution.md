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

### 1.3 给既有表加列：**复用既有 helper**（我原先写的「本仓从未做过、要新写一个」是**错的**）

`Reference.journalId` 不能靠 `CREATE TABLE IF NOT EXISTS` 落地，SQLite 的 `ALTER TABLE ADD COLUMN` 也不幂等。
但**不需要新写**：本仓已有 `addColumnIfMissing`（`src/main/projects/prisma-client.ts:959` 起），而且比我先写的更严谨——
它有 `hasTable` 守卫（缺表直接跳过）、`hasTableColumn` 前置判定，且**失败后重读后置条件**而不是解析引擎错误串
（注释写明：不解释 engine-specific error string，只证明后置条件）。实现时编译器直接报「重复声明」把我拦下，
这正是该有的形状。**用法**：`addColumnIfMissing(client, 'Reference', 'journalId', 'ALTER TABLE … ADD COLUMN … TEXT')`，
索引在加列之后创建。

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

## 5. 下一片的**真实**顺序：先做指标导入，再做筛选面（U3 的前提核查，2026-10-02）

**核查结论（有证据）**：`JournalMetric` **没有任何生产方** —— 全库 grep `appendMetric|journalMetric` 除
`journal-repository.ts`（本片新建）与其测试外**零命中**。所以：

- 如果先做 U3 的**显示/筛选面**，那个面在真机上**只会显示「未知」**：库里永远没有指标行，而这看起来像
  「筛选功能有 bug」而不是「数据还没进来」——正是本仓最忌讳的那类假象。
- ⇒ **下一片必须是「指标导入」**（给出 `appendMetric` 的第一个真实生产方），**然后**才是 U3 的筛选/统计面。

### 5.1 指标导入片（建议下一片）

| 面 | 内容 | 验收（真机/真文件） |
| --- | --- | --- |
| 数据形状 | 一行 = `{ issn? , journalName? , kind , value , year , source }`；**year 与 source 必填**（无年份无来源的数字不是事实） | 缺 year/source 的行**进不了库**且给出具名原因 |
| 写入 | 复用 `JournalRepository`：有 ISSN 走 `upsertByIssn`、只有名字走 `upsertByNormalizedName`；值一律走 `appendMetric`（append-only） | 同一 ISSN 两次导入只出一行期刊；改指标＝**新增行** |
| 报告 | 导入**逐行给结果**：`imported` / 具名跳过原因（`no-value`、`no-year`、`no-source`、`bad-issn`、`name-ambiguous`、`name-missing`）——**不静默丢行**（与 R3「未捕获必须带具名原因」同口径） | 真机：正例入库、反例逐条具名，**零静默丢弃** |
| 入口 | 新增应用命令 `references:import-journal-metrics`（本仓命令模式：owner `Pick` + `defineApplicationCommand` + handler map），并跑 `npm run gen:web-api-map` 保持生成物同步 | 通过真实 RPC 导入一次并回读库 |
| 界面 | 本片**不做**界面：UI 属 U3（显示指标时**必须**带上年份与来源；缺失显示「未知」而非 0/空白） | — |

### 5.1 执行结果（2026-10-02 夜，真机已过）

- **代码**：`src/shared/journal-metrics.ts`（行契约 + 九种具名跳过原因 + CSV/TSV 解析、中文表头别名）、
  `src/shared/journal-identity.ts`（标识符规则上移 shared，导入侧才能在调仓储前判定）、
  `src/main/references/journal-metric-import.ts`（owner：逐行校验 → 解析期刊 → 查重 → `appendMetric`；非判定类异常一律上抛）、
  `JournalRepository.findMetric`（查重，防重复导入把 U3 统计翻倍）、应用命令 `references:import-journal-metrics`
  ＋ 预加载桥 ＋ 渲染契约目录 ＋ `npm run gen:web-api-map` 生成物同步。
- **真机读数**（隔离实例 44199 / `/tmp/psq8-root`，走真实 RPC `POST /rpc/references:import-journal-metrics`）：
  十个结果面逐条走到；主用例 11 行 ⇒ 11 条 outcome（5 入库 / 6 具名跳过，零静默丢弃）；同表重导 `imported:0`（幂等，
  原有具名原因逐条保留）；改值 `imported:1` 且旧行 id 逐字符未变（append-only）；缺列的表**点名缺哪列**而不是"导入了 0 行"。
  全文 `docs/evidence/2026-10-02-r2-journal-metric-import.md` ＋ 逐字原文 `…-raw.txt` ＋ 夹具/探针。
- **真机发现的缺陷（本片修掉）**：中文刊名被归一化成空串 —— `normalizeJournalName` 只保留 `[a-z0-9]`，
  `中国科学：生命科学` ⇒ `""` ⇒ 任何非拉丁刊名永远无法登记/匹配，于是解析层明确映射了 `期刊名称`/`刊名` 的中文表头**一行也导不进**
  （修前读数：2 行全 `name-missing`）。修为 `[^\p{L}\p{N}]+`（保留任意文种的字母/数字；拉丁与变音符行为逐字不变）；
  修后同一张表 `imported:2`、两行落到同一个期刊 `中国科学 生命科学`。用户真实库**没有 `Journal` 表** ⇒ 零迁移风险（已核）。
- **边界（具名，未做）**：ISSN 只校验形状、不校验校验位（`1234-567X` 形状合法故被接受，本片未改——改它属既有标识符规则，应独立立项）；
  该行 ISSN 查无期刊时会按**精确归一化名**回落（实测落到 Nature）⇒ "ISSN 查无此刊"本身不拦行；
  `name-ambiguous` 需库内已存在重名期刊，导入路径自身造不出该状态（本次为直接 seed）；
  CSV 引号内换行未测；无界面（U3）。

### 5.2 之后仍未做（立案，避免无人认领）

- **R2-U3**：按分区/影响因子筛选的统计面 + 「未知」口径 + 9 语种文案；依赖 5.1 提供真实数据。
- **R2-U4**：别名与更名——**只做精确规范化匹配 + 用户显式合并**，不做模糊自动合并。
- **A7 外部锁导入**：前提（Q1–Q3 收口）已满足，理由只剩容量/排期；需新通道 + `gen:web-api-map` + 一次真实环境构建验收。

## 6. 明确不做（本片交付）

- **不做模糊自动合并**（R2-U4 只做精确规范化 + 用户显式合并）；
- **不回填**既有 `Reference.venue`；
- **不给缺失指标显示 0 或空白**（R2-U3：显示「未知」并带上年份与来源）；
- 不在 U1 单独交付（见文首）。
