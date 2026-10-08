# 证据：IEDB 免疫表位连接器（先证协议，再写描述符）— 2026-10-08

新增 `src/main/connectors/descriptors/immune-epitopes.ts`（2 个工具）+ 该文件测试 + 注册表/目录接线 +
两份 README 的公开计数。**本档记「真机跑到什么」**，分三块：真实事实 / 本轮观测值 / 服务不报什么。

## 一、真实事实（先真实调用拿到的形状，不是照抄文档）

| 事实 | 观测（原始） |
| --- | --- |
| 端点与形状 | `GET https://query-api.iedb.org/{epitope_search,tcell_search,bcell_search,antigen_search}?limit=N` ⇒ 200、`application/json`；**响应是裸数组、没有 envelope** |
| 过滤语法 | PostgREST 风格 `列=eq.值`：`epitope_search?linear_sequence=eq.VTGPVAQLY` ⇒ 1 行；`tcell_search?structure_iri=eq.IEDB_EPITOPE:31803` ⇒ 该表位自己的行（用**我们发去的**输入校验：返回行的 `linear_sequence` 与我们过滤的那条一致） |
| 分页要 `order` | `?limit=1&offset=5` ⇒ **400**，原文：`Query string appears to include an offset parameter without an order parameter. Please resubmit the query with an order parameter to ensure consistent paging.`；补上 `order=structure_id.asc` ⇒ 200。`skip=` 不支持（PGRST100） |
| 未知列 = 整通拒绝 | `?nonexistent_col=eq.x` ⇒ **400** `{"code":"42703","message":"column epitope_search.nonexistent_col does not exist"}` |
| **跨族列名也会被拒**（本轮真机抓到的两处产品级错） | `tcell_search` 的 select 里带 `bcell_id` ⇒ 400 `column tcell_search.bcell_id does not exist`；`bcell_search` 的 select 里带 `mhc_restriction` ⇒ 400 `column bcell_search.mhc_restriction does not exist`。**mock 的请求形状测试全绿也发现不了**，只有真机跑一次会红 |
| 两族的列集 | 用真实响应比对：`tcell_search` **86** 列、`bcell_search` **85** 列；**tcell 独有** `tcell_id`/`tcell_iri`/`mhc_restriction`，**bcell 独有** `bcell_id`/`bcell_iri` |
| 服务文本里夹 HTML | `assay_description` 实测形如 `multimer/tetramer<br/>qualitative binding<br/><strong>Positive</strong>` |

## 二、本轮观测值（真机探针：一次性 spec，跑完即删；读数落 `/tmp/immune-epitopes-probe.json`）

| 工具 | 读数 |
| --- | --- |
| `iedb_search_epitopes`（按序列） | `KLEDLERDL` ⇒ **1 条**（`IEDB_EPITOPE:31803`，`structure_type: Linear peptide`，`sequence === 'KLEDLERDL'`，断言过） |
| `iedb_search_assays`（按 IRI，`kind: "both"`，max_rows 20） | `IEDB_EPITOPE:31803` ⇒ **t-cell 5 行 / b-cell 0 行**；`truncated` 两族都 `false` |
| 截断是真读数 | 同一次查询 `max_rows: 1` ⇒ `n_retrieved.tcell = 1` 且 **`truncated.tcell = true`** —— 服务不报总数，所以这个布尔来自「多要一行」 |
| 单条证据的字段 | 第 0 行：`IEDB_ASSAY:29`，`method = "multimer/tetramer · qualitative binding · Positive"`（**HTML 已剥掉**），`citation = {pubmed_id: 15448372, journal: "J Gen Virol", title: "Identification of novel HLA-A*0201-restricted CD8+ T-cell ep…"}`, `mhc = {class: "I", restriction: "HLA-A*02:01", allele_resolution: "2 chain", allele_evidence: "MHC binding assay"}` |
| **不把缺失说成阴性** | b-cell 那一族 0 行时，`notes` 逐字含：`No curated b-cell assay evidence matched this exact query. This is NOT evidence of absence…` —— 且只点名**空了的那一族** |
| 坏输入不发请求 | 探针断言：非法字符/超长/空序列**都在发请求之前**具名拒绝（`urls` 为空） |
| 坏列会响亮失败 | 直接打服务的坏列 URL ⇒ 抛 `HTTP 400`（不会变成「没有证据」） |

## 三、服务不报什么（因此工具里不许假装有）

1. **不报总数** ⇒ `truncated` 由「多要一行」得出，工具**不印 total**（印了就是编的）。
2. **不回声生效的过滤条件** ⇒ 工具自己把 `filtered_by` 印出来（清单短到底是家族小还是查询窄，读者要能分辨）。
3. **没有「阴性证据」这个概念** ⇒ 库里只存已发表且被审定的测定；空结果只能读作「本查询没有已审定证据」，
   工具与目录 `useWhen` 都**明写它不是「无免疫反应」**。
4. **两族列集不同** ⇒ select 列表按族生成（t-cell 带 `mhc_restriction`，b-cell 不带），并把这两处 42703 写成了回归用例。
5. **服务方给的散文带 HTML** ⇒ 归一化后再上屏，并在 `notes` 里说明做过归一化。

## 四、门禁与计数

- `vitest run src/main/connectors` ⇒ **81 文件 / 910 passed | 50 skipped，零失败**（本单元新增 15 条）。
- 公开计数两处**同批改掉**：两份 README 的 `26 connectors (269 tools: …)` ⇒ **`27 connectors (271 tools: … IEDB, …)`**；
  `readme-connector-count.test.ts` 由红转绿（它直接读注册表与两份 README 比对），`check-readme-sync.mjs` 绿。
- `typecheck:node` 净；触碰文件 `eslint` **0 problem**。
