# R2 指标导入片 —— 真机读数（2026-10-02，v1.79.0 发布后）

本片是 `JournalMetric` 的**第一个真实生产方**（依据 `docs/plan-2026-10-02-R2-U1-U2-execution.md` §5.1：
先做指标导入，再做 U3 筛选面）。单测只证明分支写得对；这份文档记的是**运行中的应用**在**真实 RPC 通道**上的读数。

## 一、方法（可复现）

```bash
mkdir -p /tmp/psq8-root /tmp/psq8/data
printf '{"dataRoot": "/tmp/psq8/data"}\n' > /tmp/psq8-root/settings.json
PURESCIENCE_STORAGE_ROOT=/tmp/psq8-root PURESCIENCE_WEB_PORT=44199 npm run dev:headless
# 夹具与探针：/tmp/psq8/{table.csv,table-zh.csv,probe.py}（探针留存为 docs/evidence/2026-10-02-r2-journal-metric-import-probe.py）
python3 probe.py http://127.0.0.1:44199 /tmp/psq8-root/web-token <mode>
```

- 走**应用自身通道**：`POST /rpc/references:import-journal-metrics`（`Authorization: Bearer <web-token>`），
  与界面点同一个应用命令，不点界面、不改用户配置。
- **`dataRoot` 必须显式钉住**（`settings.json` 里绝对路径）：只设 `PURESCIENCE_STORAGE_ROOT` 时数据根仍会落到用户的真实 `~/PureScience-DEV`。
- 原始输出全文：`docs/evidence/2026-10-02-r2-journal-metric-import-raw.txt`（9 段，逐字）。

## 二、主用例：一张 11 行的"出版商指标表"

夹具 `table.csv`：7 列（`ISSN,Journal,Kind,Value,Year,Source,Note`），正例 5 行、负例各 1 行、故意重 1 行、故意缺字段 1 行。

读数（`main.out.txt`）：

```
{"imported":5,"skipped":6,"journalsCreated":3,"outcomeCount":11,
 "reasons":["imported","duplicate","imported","imported","no-year","no-source","no-value",
            "imported","malformed-row","name-missing","imported"]}
```

| 行 | 结果 | 读数 |
| --- | --- | --- |
| 2 | imported | `by-issn`，`created=True`（ISSN `0028-0836` → Nature） |
| 3 | duplicate | `metric … already records impact-factor 64.8 (2023, Journal Citation Reports)` |
| 4 | imported | `jcr-quartile Q1 2023`，`created=False`（同一期刊第二条指标） |
| 5 | imported | `by-issn`，`created=True`（Nature Communications，**未**与 Nature 合并） |
| 6 | no-year | `year null is not a four-digit year` |
| 7 | no-source | `no source: a number whose source is unknown cannot be checked or cited` |
| 8 | no-value | `no value: a blank cell is a missing measurement, not a zero` |
| 9 | imported | `by-normalized-name`（该行 ISSN 为 `1234-567X`，见 §六边界） |
| 10 | malformed-row | `the table has 7 columns but this line has 3 fields` |
| 11 | name-missing | `neither an ISSN nor a journal name: a metric belongs to a journal, not to a row` |
| 12 | imported | `by-normalized-name`，`created=True`（名字唯一的期刊） |

**每行恰好一条结果、按序、零静默丢弃**：11 行 ⇒ 11 条 outcome。

### 幂等：同一张表再导一次

读数（`rerun.out.txt`）：`{"imported":0,"skipped":11,"journalsCreated":0}`，6 条 `duplicate` ＋ 4 条原来就具名的原因（`no-year`/`no-source`/`no-value`/`name-missing`/`malformed-row`）逐条保留。
⇒ 重复导入不会把 U3 的统计翻倍，且**原来的具名原因不会被"重复"吃掉**。

### append-only：改指标＝新增一行

读数（`append.out.txt`）：同一期刊＋同一 `kind`＋同一 `year`＋同一 `source`、**不同 value** ⇒ `imported:1`。
库里该组合下**三行并存**（`nature` / `impact-factor` / 2023 / Journal Citation Reports）：

| id | value | 来源 |
| --- | --- | --- |
| `cmur0enbf0001wfqr2izzo0yj` | 64.8 | 主用例第 2 行 |
| `cmur0enbk0005wfqrdw25qfto` | 1.0 | 主用例第 9 行 |
| `cmur0ex0p0008wfqrnv91rchq` | 99.9 | append 那次 |

第一条的 id 与主用例读数**逐字符相同** ⇒ 旧行未被 UPDATE。

## 三、真机发现的缺陷：中文刊名被归一化成空串（已修）

**读数（修前）**：`table-zh.csv`（表头 `期刊名称,指标类型,指标值,年份,数据来源`，两行）⇒
`{"imported":0,"skipped":2,"reasons":["name-missing","name-missing"]}`，
detail 均为 `upsertByNormalizedName requires a usable venue name`。

**机制（本机复算，非推断）**：`normalizeJournalName` 当时是 `replace(/[^a-z0-9]+/g, ' ')`（只留 ASCII）：

```
"中华医学杂志"        => ""
"中国科学：生命科学"  => ""
```

⇒ 任何非拉丁刊名归一化后都是空串，于是**永远无法登记、无法匹配**。
这是本片的自相矛盾：解析层明确映射了 `期刊名称`/`刊名` 表头（`COLUMN_ALIASES.journalName`），
但存储层拒收这些行 —— 对一个中文医学文献为主场景的产品，这条路是断的。

**修复**：`src/shared/journal-identity.ts` 改为 `replace(/[^\p{L}\p{N}]+/gu, ' ')`（任意文种的字母/数字都保留；
全角/半角标点都成为词边界）。拉丁与变音符行为**逐字不变**（同文件既有断言：`Nature`/`J. Biol. Chem.`/`München Medical Weekly` 三条仍绿）。

**读数（修后）**：同一个 `table-zh.csv` ⇒ `{"imported":2,"skipped":0,"journalsCreated":1}`，
两行 `by-normalized-name`，落到**同一个**期刊 `中国科学 生命科学`；库内该期刊两条指标 `cas-partition 二区` / `cas-top 是`（2024，中科院文献情报中心）。

**迁移风险为零（已核）**：用户真实库 `~/.purescience-project/purescience.db` **根本没有 `Journal` 表**
（`select count(*) from sqlite_master where name='Journal'` ⇒ `0`，mtime 仍为 10-01 20:25）⇒ 不存在用旧规则写下的行。

## 四、十个结果面逐一在真机走过

| 用例 | 读数 | 原文 |
| --- | --- | --- |
| 正常入库 | `imported` ＋ `journalId`/`journalMatch`/`journalCreated` | `main.out.txt` |
| 重复行 | `duplicate` ＋已存在 metric 的 id | `main.out.txt` 第 3 行 |
| 值缺失 | `no-value` | `main.out.txt` 第 8 行 |
| 年份缺失 | `no-year` | `main.out.txt` 第 6 行 |
| 来源缺失 | `no-source` | `main.out.txt` 第 7 行 |
| kind 缺失 | `no-kind` | `nokind.out.txt` |
| ISSN 形状非法 | `bad-issn`（`1234-567`，修复未被"修好"） | `badissn.out.txt` |
| 名字缺失 | `name-missing` | `main.out.txt` 第 11 行 |
| 名字歧义 | `name-ambiguous`（`journal "Nature" matches more than one journal`） | `ambiguous.out.txt` |
| 字段数不符 | `malformed-row` | `main.out.txt` 第 10 行 |

**请求级失败（不伪装成"导入了 0 行"）**：表头只有 `ISSN,Journal,Value` ⇒ HTTP 500
`handler_error`：`Journal metric import table is missing required column(s): year, source, kind (or defaultKind). Headers found: ISSN | Journal | Value`（`badheader.out.txt`）。

## 五、隔离证明

| 位置 | 读数 |
| --- | --- |
| 真实配置根 `~/.purescience-project/purescience.db` | **无 `Journal` 表**（0），mtime `Oct 1 20:25:15`（本次未写） |
| 真实数据根 `~/PureScience-DEV/.pdfs` | **18**（开工前基线同为 18） |
| 隔离库 `/tmp/psq8-root/purescience.db` | 本次全部工作在此：`Journal` 5 行、`JournalMetric` 8 行、`Reference` 0 行，mtime 本次 |

> 5 个期刊 = 导入建立的 4 个（Nature / Nature Communications / Journal of Test Metrics / 中国科学 生命科学）＋ 为测 `name-ambiguous` 直接 seed 的 1 个（`seed-second-nature`，`issn` 为 NULL —— SQLite 唯一索引对多行 NULL 不冲突，与设计相符）。

## 六、边界与没做（具名，不假装）

- **ISSN 只校验形状，不校验校验位**：`1234-567X` 形状合法（7 位数字＋数字或 X）⇒ 被接受；
  代码注释即如此声明，本片**未改**（要改它=改既有标识符规则，应独立立项）。
  后果实测：该行 ISSN 查无期刊 ⇒ 回落**精确归一化名**匹配，最终落到 Nature（`main.out.txt` 第 9 行）。
  **"ISSN 查无此刊"本身不会拦住一行**，这是本片实测到的既有行为，记录在案。
- **`name-ambiguous` 无法只靠导入达到**：库里需已存在两个 `normalizedName` 相同的期刊（本次为直接 seed）。
  按当前解析顺序（先 ISSN、后精确名），导入路径本身造不出这个状态。
- **无界面**：本片只做通道与数据（UI 属 R2-U3，显示指标时**必须**带年份与来源）。
- **未做**：CSV 引号内的换行（多行字段）未测；XLSX/PDF 表不属本片；`Reference` 行数为 0 ⇒ 本片**没有**验证"引用解析落库"那条路径（那是 U1+U2 的范围，验收在 `docs/evidence/2026-10-02-r2-journal-entity.md`）。

## 七、门禁

- `src/shared` + `src/main/references` 定向 vitest：**1139 例全绿 / 104 文件**（含本片新增的中文归一等 6 条回归断言）。
- `npm run typecheck`（node ＋ web）：**0 error**；`eslint`（改动文件）**exit 0**。
- 全量 vitest 读数见提交信息与队列文档收尾记录。
