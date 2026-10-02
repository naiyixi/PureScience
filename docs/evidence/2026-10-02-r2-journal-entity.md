# R2-U1+U2 真库验收：期刊成为一等实体 + 引用解析落库（2026-10-02）

> 交付：`prisma/schema.prisma`（`Journal` / `JournalMetric` / `Reference.journalId`+`journalMatch`）、
> `src/main/projects/prisma-client.ts`（两张表 + 四索引 + 两条**加列**，接进启动时的 DDL 序列）、
> `src/main/references/journal-repository.ts`（实体仓储 + 保守解析器）、
> `src/main/references/repository.ts`（`createReference` 内解析并落 `journalId`/`journalMatch`）、
> `src/main/references/service.ts`（OpenAlex `issn_l` / PubMed `issn` 作为 ISSN 的真实来源）、
> `src/shared/references.ts`（`CreateReferenceInput.issn?`）。
> **未做**：R2-U3（筛选/统计面）与 R2-U4（别名与显式合并）——本片到「引用知道自己属于哪本期刊」为止。

## 1. 真库验收（隔离根 `/tmp/psqB-root`，端口 44206，**两次启动**）

脚本：`/tmp/psqB-run/{run.sh,accept.py}`（phase1 = 全新库；phase2 = 停掉再起，DDL 序列**第二次**执行）。

### 1.1 全新库（phase1）

| 读数 | 原文 |
| --- | --- |
| 表 | `Journal table: True | JournalMetric table: True` |
| `Reference` 新列 | `Reference.journalId: True | Reference.journalMatch: True` |
| 索引 | `['sqlite_autoindex_Journal_1', 'sqlite_autoindex_JournalMetric_1', 'Journal_issn_key', 'Journal_normalizedName_idx', 'JournalMetric_journalId_kind_year_idx', 'Reference_journalId_idx']` |
| 预注册期刊 | `[('j-nature', '0028-0836', 'by-issn')]` |

**走应用自己的 RPC（`references:add`）写两条引用**——不是直接插库：

| 输入 | 落库原文 |
| --- | --- |
| `title="Linked paper"`, `venue="Nature"`, `issn="0028-0836"` | `('Linked paper', 'Nature', 'j-nature', 'by-issn', 'manual')` |
| `title="Unlinked paper"`, `venue="Some Unknown Venue"`（无 ISSN、名字无精确匹配） | `('Unlinked paper', 'Some Unknown Venue', None, 'no-issn', 'manual')` |

⇒ 识别成功者**挂上实体并记下用了哪条规则**；失败者**留空并具名原因**，且**没有**为裸名造出一个期刊实体。

脚本自判：`{"tables created": true, "columns added": true, "index present": true, "linked reference carries the journal id": true, "linked reference names the rule": true, "unlinked reference stays null": true, "unlinked reference names why": true}`

### 1.2 重启后（phase2）：加列路径的幂等性

这是本片真正有风险的一处：`ALTER TABLE … ADD COLUMN` 不幂等，而这台机器上的库**已经有那两列和两条真实数据**。

| 读数 | 原文 |
| --- | --- |
| 第二次启动 | 正常起来（`instance up (boot 2)`），无报错 |
| 启动日志里与加列/期刊表相关的行 | **零命中**（`grep -iE "journalId\|journalMatch\|addColumn\|duplicate column\|Journal" dev-2.log` 无输出） |
| 表 / 列 / 索引 | 与 1.1 **一致**（列仍在、索引仍在、没有重复创建） |
| 两条引用 | **逐字未动**：`('Linked paper','Nature','j-nature','by-issn','manual')`、`('Unlinked paper','Some Unknown Venue',None,'no-issn','manual')` |
| 期刊行 | 未动：`[('j-nature', 'nature', '0028-0836')]` |

⇒ 加列走的是**既有的** `addColumnIfMissing`（`prisma-client.ts:959` 起：`hasTable` 守卫 + `hasTableColumn` 前置判定 +
失败后**重读后置条件**而非解析引擎错误串）。我原计划里写的「本仓从未做过、要新写一个」是**错的**，
实现时被编译器以「重复声明」拦下 —— 计划文档 §1.3 已按事实更正。

## 2. 语义单测（`src/main/references/journal-repository.test.ts`，13 例）

钉住的是「若破了会静默污染库」的两条：**不确定的身份必须保持不确定**、**指标更正＝新增行**。
- 规范化只折叠大小写/标点/空白/变音符；`Nature` ≠ `Nature Communications`、`Cell Stem Cell` ≠ `Stem Cell`（**不做模糊**）。
- ISSN 只接受 8 位合法值（`0028-0836` ≡ `00280836`）；`0028-083` 这类**修不出来的一律不修**，退回名字路径。
- 一个规范化名命中多行 ⇒ `ambiguous` 且**拒绝挑一个**（不合并）。
- 无标识符可匹配 ⇒ `no-issn`；有标识符但未注册 ⇒ `name-not-exact`；两者都**不留 journalId、不造实体**。
- `upsertByIssn` 同一 ISSN 两次只出一行、`createdVia` 保持 `by-issn`；`appendMetric` 追加不覆盖、
  拒绝无年份/无来源/无值，非数字值（`Q1`）不伪造数字镜像。
