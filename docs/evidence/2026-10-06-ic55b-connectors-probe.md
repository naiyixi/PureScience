# IC55b 连接器真机探针（CELLxGENE Discover / Alliance / MaveDB / Metabolomics Workbench / Monarch / GEO 矩阵）

本轮为 PureScience「组学与表型」面新增 7 个连接器工具。所有映射都**先对真实服务跑通、拿到形状后才写描述符**。
本节记三块：**真实事实**（服务实际怎么回）、**本轮观测值**（这次跑到的数字/形状）、**服务不报什么**（不许假装的部分）。

一次性探针 `src/main/connectors/descriptors/zzz-live-ic55b.spec.ts`（`LIVE_API=1 npx vitest run … --maxWorkers=2`，7 通过）把结果写入 `/tmp/ic55b-live.json`，跑完已 `rm`，`git status --short` 复核工作区只剩预期改动。

## 真实事实（raw curl，落盘再读）

| 服务 | 端点 | HTTP 证据 |
|---|---|---|
| CELLxGENE Discover | `GET https://api.cellxgene.cziscience.com/curation/v1/collections?visibility=PUBLIC` | `http=200 type=application/json size=3171289` |
| CELLxGENE Discover | `GET …/curation/v1/collections/{uuid}` | `http=200 application/json size=21606`（datasets 带 `cell_count` 等富字段；catalogue 里的 datasets 只是预览，无 title/cell_count） |
| Alliance | `GET https://www.alliancegenome.org/api/search?q=BRCA1&category=gene_search_result&limit=2` | `http=200 application/json size=16092`；响应 `{total:136, aggregations:[…], results:[…]}` |
| Alliance | `GET /api/gene/HGNC:1100` | `http=200 size=46199`（`gene.primaryExternalId="HGNC:1100"`）；注意 `NCBIGene:672` 直接 `400 No gene found` |
| MaveDB | `POST https://api.mavedb.org/api/v1/score-sets/search` body `{"targets":["BRCA1"],"limit":3}` | `http=200 application/json`；`{scoreSets:[…], numScoreSets:7}` |
| MaveDB | `GET /api/v1/score-sets/?urns=urn:mavedb:00000001-a-1[,…]` | `http=200`，逗号分隔有效；不带 `urns` 的 GET 回 `422`（字段必填）；`GET …/score-sets/search` 回 `404`（只认 POST） |
| Metabolomics Workbench | `GET https://www.metabolomicsworkbench.org/rest/study/study_title/cancer/summary` | `http=200 application/json size=184089`（对象按行号 `"1","2",…` 键控） |
| Metabolomics Workbench | `GET /rest/study/study_id/ST000001/summary` | `http=200 application/json size=524`（**单个对象**，非行号键控） |
| Monarch | `GET https://api.monarchinitiative.org/v3/api/association?subject=MONDO:0007947&category=biolink:DiseaseToPhenotypicFeatureAssociation&limit=2` | `http=200 application/json size=22086`；`category` 是**固定枚举**（`biolink:GeneToDiseaseAssociation` 被 `422` 拒） |
| Monarch | `GET /v3/api/search?q=Marfan&limit=3` | `http=200 application/json size=5593` |
| GEO FTP | `GET https://ftp.ncbi.nlm.nih.gov/geo/series/GSE131nnn/GSE131907/matrix/` | `http=200 text/html size=603`（Apache 目录索引） |
| GEO FTP | `GET …/GSE131907/suppl/` | `http=200 text/html size=1392` |
| GEO FTP | `HEAD …/matrix/GSE131907_series_matrix.txt.gz` | `http=200 type=application/x-gzip`，`Content-Length: 6300`，`Accept-Ranges: bytes` |
| GEO FTP | `GET …/GSE131907/suppl/filelist.txt` | `http=404`（该 series 无此文件；目录索引本身即发现来源） |

## 本轮观测值（`/tmp/ic55b-live.json`，走实际工具）

- **CELLxGENE Discover `discover_list_collections`** `query=lung, limit=3`：`total_collections=397, total_matched=40`；首条 `3a5dbf8a-…` "Bronchopulmonary Dysplasia"，`n_datasets=1`，`tissues=["middle lobe of right lung"]`。
  `discover_get_collection`（同上 id）：`n_datasets=1`，dataset `d68a8b48-…` `cell_count=271381`、`primary_cell_count=255204`、`feature_count=35477`、`mean_genes_per_cell≈1392.69`（均服务方声明）。
- **Alliance `alliance_search_genes`** `query=BRCA1, limit=3`：`total=136`；首条 `curie=RGD:2218`（大鼠），`species="Rattus norvegicus"`，`so_term_name="protein_coding_gene"`，22 个 disease、8 个 cross_reference（`UniProtKB:G3V8S5` …）。
- **Monarch `monarch_phenotype_associations`** `subject=MONDO:0007947, limit=3`：`total=181`；首条 `subject=MONDO:0017309`(neonatal Marfan) → `object=HP:0000768`(Pectus carinatum)，`has_evidence=["ECO:0000304"]`，`frequency_qualifier=HP:0040281`，`primary_knowledge_source=infores:orphanet`。
- **MaveDB `mavedb_search_score_sets`** `targets=['BRCA1'], limit=3`：`mode=search, num_score_sets=7`；首条 `urn:mavedb:00000081-a-1`，`num_variants=1061`，靶基因 `BRCA1` → `UniProt P38398`；`mavedb_url=…/#/score-set/urn:mavedb:00000081-a-1/`。
- **Metabolomics Workbench `metabolomics_workbench_search_studies`** `input=study_title, value=cancer, limit=3`：`count=310`；首条 `ST005221`（Homo sapiens / Johns Hopkins University / CE-MS / 37 samples）。
- **GEO `geo_discover_matrix_files`** `accessions=['GSE131907']`：`n_found=1`；`matrix.present=true, n_files=1`（`GSE131907_series_matrix.txt.gz`, 声明 `6.2K`, 约 6349 B）；`supplementary.present=true, n_files=6`（xlsx/pdf→document、`*matrix*`→processed_matrix）；`total_declared_bytes_approx≈5.02 GB`；`downloaded=false`。

## 服务不报什么 / 明确的未验证

- **CELLxGENE Discover**：无服务端检索、无"总量"字段——`query` 是客户端过滤，因此 `total_collections`/`total_matched` 是**本次拉到的目录内**计数；`cell_count` 是**服务方声明**（`cell_count_source:"service_declared"`），本工具不复算。catalogue 列表里的 dataset 只有预览字段（无 title/cell_count），要富字段须取 collection 详情。
- **Alliance**：搜索结果里的数字 `id` 是内部主键，工具只把 `curie`（如 `RGD:2218`）作为读者可查标识并给出 `alliance_url`；`species` 过滤是客户端做的，已在 `species_filter` 具名。
- **MaveDB**：只返回 score-set **元数据与 `numVariants`**，**不含逐变异打分**（`scores_included:false`）；`numScoreSets` 是服务方总数，但**未验证**其分页顺序稳定性。URN 的网页版 URL 形如 `https://www.mavedb.org/#/score-set/{urn}/`（SPA，未逐条人工点击核对）。
- **Metabolomics Workbench**：服务**不报独立总数**，`count` 即它返回的行数；行结构随 `input` 变（title/institute/last_name 给完整摘要，metabolite_id/kegg_id/refmet_name 给 `{refmet_name,kegg_id,study_id}`）。观测到一处服务端怪癖：标题检索下 `study_url` 会把**查询词**回填进 URL（`ST005221` → `…?StudyID=CANCER`），即该字段不可当作 study 主键使用——**已如实透传、未做纠正**。
- **Monarch**：只给 ECO 码不给 ECO 名称；`category` 必须落在服务枚举内（本工具限定 5 个表型类；`GeneToDiseaseAssociation` 一类会被 422 拒，故未纳入）。
- **GEO**：目录索引的 size 是 Apache **人类可读**值（K/M/G，本工具按 K=1024 换算为 `declared_size_bytes_approx`，**非**精确字节），GEO 不提供逐文件 md5；**未验证**项：`GeoListing` 的字节数没有与 `Content-Length` 逐文件对齐（本工具走 `ToolContext`，没有 HEAD/Range 传输，故预检基于"目录索引声明"而非 HEAD，`downloaded:false` 明示）。
