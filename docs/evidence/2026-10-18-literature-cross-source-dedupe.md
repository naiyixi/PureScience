# 多源文献检索的跨源去重：真网络读数（2026-10-18）

> 目的：文献综述工具（`literature_review_search`）把 arXiv 与 OpenAlex 的结果**直接拼接**，
> 同一篇论文两边都有时会被数两次 —— `total_records` 偏高，读者在列表里还会看到两行同一篇。
> 本档记录的是**判定规则、改动面、真网络读数与边界**，读数全部可复跑。

## 一 改动面

| 位置 | 内容 |
| --- | --- |
| `src/main/connectors/descriptors/literature-dedupe.ts`（新） | 判定规则本体：`bareDoiKey` / `titleKey` / `recordYear` / `dedupeLiteratureRecords`。规则逐条写在文件头。 |
| `src/main/connectors/descriptors/literature-review.ts`（改） | 合并后跑折叠；返回新增 `records_before_dedupe` 与 `dedupe {removed, byDoi, byTitle}`；`total_records` 改为**折叠后**的行数（恒等于 `records.length`）；`description` / `returns` 同步写清口径。 |
| `literature-dedupe.test.ts`（新） | 14 条：DOI 规范化（`https://doi.org/` / `doi:` / 大小写）、两侧 DOI 不同不合并、年份不兼容不合并、短标题不合并、中文标题（Han ≥ 6 字）、保留行带 `also_in`、计数自洽。 |
| `literature-review.test.ts`（改） | 集成一条：两源各有同一篇时只出一行，`before − after = removed = byDoi + byTitle`。 |

## 二 判定规则（为什么是这四条）

1. **两侧都有 DOI ⇒ 按 DOI 判同一**。这是唯一强身份。
2. **两侧 DOI 不同 ⇒ 一律不合并**，即使标题相同。真数据里同标题不同物很多：
   `Faculty Opinions recommendation of …` 系列、出版社 `Supplementary Data` 记录、勘误与其正文。
   首版没有这一条，实跑当场把这类记录误并进来（见 §四）。
3. **无 DOI ⇒ 规范化标题全等 + 年份兼容**（相等，或一侧未知）才合并。规范化 = 去变音符、
   小写、非字母数字折叠成单空格（Unicode 感知，中文标题也能键出来）。
4. **短标题不合并**：拉丁 < 12 字符、汉字 < 6 字（`Editorial` / `Correction` / `综述` 这类）。
   **不做**作者表、摘要、模糊相似度 —— 误并会从答案里删掉一篇真论文，读者无法察觉；
   漏并只多一行重复，读者看得见。所以规则只往「保守」一侧偏。

折叠后保留**先出现的那一行**，其余来源以 `also_in: [{source, id}]` 挂上去（读者能看出另一源也有），
若被折掉的那行带 DOI 而保留行没有，DOI 被搬过去。

## 三 真网络读数（生产描述符 + 真 `fetch`，非替身）

取数方式：把生产描述符 `LITERATURE_REVIEW_TOOLS[0].run` 用一份「`fetchJson`/`fetchText` 直通 `fetch`」
的 `ToolContext` 调用，`queries` = 下面 7 条、`max_per_source` = 50（工具硬上限）⇒ 7 × 两源 × 50 = **700 行输入**。
探针脚本是 scratch 里的临时文件（不入库），读数 2026-10-18 00:47 取。

| query | before | after | removed | byDoi | byTitle | arXiv | OpenAlex |
| --- | --- | --- | --- | --- | --- | --- | --- |
| attention is all you need | 100 | 100 | 0 | 0 | 0 | 50 ok | 50 ok |
| alphafold protein structure prediction | 100 | 99 | 1 | 0 | 1 | 50 ok | 50 ok |
| CRISPR base editing | 100 | 100 | 0 | 0 | 0 | 50 ok | 50 ok |
| diffusion models image generation | 100 | 98 | 2 | 0 | 2 | 50 ok | 50 ok |
| large language model agents | 50 | 49 | 1 | 0 | 1 | **0 error** | 50 ok |
| single cell RNA sequencing batch effect | 100 | 99 | 1 | 0 | 1 | 50 ok | 50 ok |
| quantum error correction surface code | 100 | 94 | **6** | **6** | 0 | 50 ok | 50 ok |
| **合计** | **650** | **639** | **11** | **6** | **5** | | |

逐条折掉的（探针原样输出，摘 6 条）：

- `arxiv:2410.14898`（Proteins with alternative folds reveal blind spots …）↔ OpenAlex `W4404088173`（byTitle）
- `arxiv:2402.05210` ↔ `W4403069997`、`arxiv:2209.07162` ↔ `W4312749295`（byTitle，医学影像生成）
- `arxiv:1605.04492` ↔ `W2963132013`（byTitle，单细胞 cell-cycle）
- 量子纠错那 6 条全部 **byDoi**，例如 `arxiv:2211.08468`（`10.22331/q-2023-07-25-1065`）↔ `W4385239514`

**同一批 query 的另一次读数（00:1x，两源都 ok）**：`large language model agents` 那次是 **100 → 99**，
本档 §三 的 00:47 那次 arXiv 报了 `error`（该源限流）⇒ 同一 query 两次的 `before` 不同（100 vs 50），
这是**源的不稳定**，不是折叠规则的行为差异。两次的 `removed` 都是 1。

## 四 读数据时抓到的两处真问题（已修，都只有真数据能抓）

1. **首版对中文标题按 12 字符卡** ⇒ 中文标题永远不合并（汉字信息密度不同）。改为「拉丁 ≥ 12 或汉字 ≥ 6」，
   并补一条中文标题用例。
2. **首版对「同标题、不同 DOI」也合并** ⇒ 真数据里把 `Faculty Opinions recommendation of …` 系列、
   出版社 `Supplementary Data` 记录与正文误并。加「两侧 DOI 不同一律不合并」后，同一批 query 的误并
   全部消失，只剩真跨源重复。这条单测里造不出来（得见过真数据才会想到），所以它同时被写进文件头。

## 五 边界（不许读成更强）

- 这批 query 的折叠率很低：**700 行里 11 行（1.6%）**。arXiv 与 OpenAlex 的 top-50 排序差异大，
  **这条特性是防重复的守卫，不是显著提效** —— 不要拿它当性能/成本收益来宣传。
- 折叠率最高的那组（量子纠错 6%）来自该领域 arXiv 预印本被 OpenAlex 收录且带 DOI 的结构性事实，
  别的领域不保证复现。
- 本档读数是**描述符 + 真网络**：它证明合并规则、计数口径与真源返回形状对得上；
  **不证明**「agent 回合里模型会按新口径解读返回」。后者要靠真机会话，本条未取（见 §六）。
- `also_in` 只带 `{source, id}`，不带被折掉那行的标题 —— 后者会与保留行重复；需要完整记录时仍可分别检索。

## 六 具名未办

1. **真实 agent 回合的读数未取**：第四把知识工具那次用的是真机会话；本条要等本版发布后的实例上跑一次
   `literature_review_search`，读模型是否按 `records_before_dedupe`/`dedupe` 解释结果。`blocked-by`：无外部门，
   但需要起一次隔离实例（本轮内存闸门与发版窗口都不允许）。
2. **同源内重复也被折叠**（如两次读到的 OpenAlex 两个 `W…` id 同标题）：当前按同一套规则处理，
   有利（列表更干净）也有一个语义问题 —— `also_in` 里会出现同源条目。未改口径，仅在档里点名。
