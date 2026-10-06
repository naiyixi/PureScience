# IC55a — 5 connector tools: real-service probe（Pathway Commons / Bgee / cBioPortal SV / openFDA FAERS / Cellosaurus）

本轮（2026-10）先对**真实服务**逐一跑通并记录形状，再写描述符；探针结果落 `/tmp/ic55a-live.json`。
无真机一次性探针文件残留（probe 已删除，`git status --short` 只剩预期改动）。

## 一、真实事实（协议层，本轮 HTTP 证明）

| 服务 | 端点 | 真实响应（本轮 curl / probe） | 记录下的形状 |
|---|---|---|---|
| Pathway Commons | `GET https://www.pathwaycommons.org/pc2/search` | `200 application/json`（`q=TP53&type=Pathway&limit=2`，39080 B，~0.95 s） | `{ numHits, maxHitsPerPage:100, searchHit:[{uri,biopaxClass,name,dataSource,organism,pathway,numParticipants,numProcesses}], pageNo, comment, version, providers, empty }` |
| Pathway Commons | 同上，坏 `type` | `400 application/json` `{"error":"Bad Request","path":"/pc2/search"}` | 未知 type 走 HTTP 400 → 描述符在本地白名单里**具名拒绝**，不下发 |
| Pathway Commons | 同上，`limit=1000` | `200`，但只回 100 条（`maxHitsPerPage=100`） | 服务**静默封顶 100** → 描述符对 `limit>100` **拒绝**（不夹紧） |
| Bgee | `GET https://www.bgee.org/api/index.php?page=gene&action=expression&gene_id=…&species_id=…&display_type=json` | `200 application/json;charset=UTF-8`（74902 B，~2.7 s） | `{ code,status,message,data:{requestedCallType,requestedDataTypes,requestedConditionParameters,calls:[{condition:{anatEntity|cellType},expressionScore:{expressionScore,expressionScoreConfidence},fdr,dataTypesWithData,expressionState,expressionQuality,clusterIndex}],gene:{geneId,name,species}} }` |
| Bgee | 缺 `species_id` | `400`，`message:"Invalid species ID argument: null"` | species 必填 → 描述符发送前校验 |
| Bgee | 未知 gene | `404` | 映射为具名「not in Bgee for species …」 |
| Bgee | `/api/gene/...`、`/api/search/gene` | `404`（新路径不可用） | 只用 `/api/index.php`；gene search 动作 `page=gene&action=search` 真实可用（本轮验证） |
| cBioPortal | `GET https://www.cbioportal.org/api/genes/{symbol}` + `/studies/{id}/molecular-profiles` + `POST /api/structural-variant/fetch` | `200 application/json`（SV fetch for IGF2 = 7213 B） | `molecularAlterationType:"STRUCTURAL_VARIANT"`，profile datatype `SV`；SV 行 `{sampleId,patientId,site1HugoSymbol,site1EntrezGeneId,site2HugoSymbol,site2EntrezGeneId,eventInfo,svStatus,site1/2Chromosome,Position,ncbiBuild}` |
| cBioPortal | `GET /api/structuralvariant-counts/fetch`（StudyViewFilter） | `200`（一研究 79381 B） | 也验证可用（未采用：返回整研究全部融合，体积大） |
| openFDA | `GET https://api.fda.gov/drug/event.json` | `200 application/json;charset=utf-8`（单条报告 117646 B） | `{ meta:{results:{total,skip,limit},last_updated}, results:[{safetyreportid,receivedate,serious,occurcountry,patient:{patientsex,patientonsetage,patientonsetageunit,reaction:[{reactionmeddrapt,reactionoutcome}],drug:[{medicinalproduct,drugcharacterization,openfda}]}}] }` |
| openFDA | `serious` 字段类型 | `serious:"1"`/`serious:"2"`（**字符串**），也有数字形式 | 描述符用 `Number()` 归一化后再判 1=serious |
| openFDA | 零命中 | `404 {"error":{"code":"NOT_FOUND","message":"No matches found!"}}` | 映射为 total 0 / events []（不报错） |
| openFDA | `serious:1` / `serious:2` / `receivedate:[…]` / `occurcountry:"US"` / `patient.reaction.reactionmeddrapt:"…"` | 均 `200` | 语义词经真实查询确认（`serious:1` 命中记录的 `seriousnessdeath=1`） |
| Cellosaurus | `GET /cell-line/{acc}?format=json` 与 `GET /search/cell-line?q=…&format=json&rows=…` | `200 application/json`（HeLa 记录 850976 B；KB 搜索 70833 B） | `{ Cellosaurus:{ "cell-line-list":[ {accession-list,name-list,category,species-list,disease-list,str-list:{marker-list:[{id,conflict,marker-data-list:[{marker-alleles}]}]},comment-list,child-list,reference-list,…} ], "publication-list":[…] } }` |
| Cellosaurus | 未知 accession | `404 {"code":404,"message":"Item not found, ac: …"}` | 映射为 `{found:false}`（不误读为「无命中」） |
| Cellosaurus | `.txt` 后缀路径 | `404` | 只支持 `?format=json` |

## 二、本轮观测值（来自 `/tmp/ic55a-live.json`）

- **Pathway Commons** `TP53 / Pathway / organism=9606`: `version=14`, `total=151`, 本页回 100, `service_comment="Search 'TP53' in Pathway; ds: null; org.: [9606]"`；首条 `identifier="reactome:R-HSA-9723905"`（源 `uri=http://bioregistry.io/reactome:R-HSA-9723905`），`data_sources=["reactome"]`, `organism_taxids=["9606"]`, `num_participants=1302`, 4 个 `parent_pathways`。
- **Bgee** `ENSG00000141510 / 9606`: `total_calls=145`，`counts_by_state={expressed:145}`；首条条件 `UBERON:0003053 ventricular zone`，`expression_score="95.11"`（字符串），`score_confidence="high"`，`fdr="<= 1.00e-14"`，`quality="gold"`，`data_types=["RNA-Seq"]`。跨物种：`ENSMUSG00000059552 / 10090` 也 `200` 且有 calls。
- **cBioPortal SV** `IGF2 / acc_tcga_pan_can_atlas_2018`: `molecular_profile_id=acc_tcga_pan_can_atlas_2018_structural_variants`, `total_events=6`, `altered_sample_count=3`, `distinct_fusions=6`（ARAP1/CLUH/DNAJC4/GALNT2/MAMSTR/NKAIN4-IGF2 各 1）；首条 `TCGA-PK-A5H9-01`，`site1=ARAP1(116985)` `site2=IGF2(3481)`，`sv_status=SOMATIC`，`ncbi_build=GRCh37`。
- **openFDA FAERS** `ASPIRIN + NAUSEA`: `total=31948`（真实报告数），把 harmonic `serious` 字符串归一后首条 `serious=false, seriousness_code=2`，`patient.sex="male"`，`n_drugs=20`, `n_reactions=11`。
- **Cellosaurus** `CVCL_0372 (KB)`: `is_problematic=true`，`problematic_annotations=[{category:"Problematic cell line", value:"Contaminated. Shown to be a HeLa derivative …"}]`，`str_profile={n_markers:18, conflicting_markers:[{id:"D13S317", alleles:"12,13.3"}]}`，`n_children=14`。

## 三、服务不报什么（据此如实标注，不假装已核验）

- **Bgee**：返回 `expression_score`/`fdr`，但**不报 term/query/background 规模** ⇒ 尾概率无法本地复算；描述符明写这三个数「是服务方数字，未本地复算」（`note` 字段）。
- **openFDA FAERS**：只报**报告条数**，**没有暴露分母** ⇒ 不是发生率；描述符 `note` 明写，且不把这些计数当 incidence。
- **openFDA**：单条报告的药物/反应列表可很长（本轮 `n_drugs=20`）；每药的 `openfda` 调和块可达数百品牌名（ASPIRIN 178 个品牌）——该块**非本报告数据**，描述符有意省略（在 `returns` 中说明）。
- **Cellosaurus 搜索**：`/search/cell-line` **不报命中总数**（envelope 只有 `cell-line-list`/`publication-list`）⇒ `n_returned` 只是本页行数，`note` 明写，不冒充总数。
- **cBioPortal**：`/structural-variant/fetch` **不在 body 报总数**（总量只在读不到的头部）⇒ `total_events`/`distinct_fusions` 是「本轮取回行」的本地聚合，不是服务声明的总数。
- **Pathway Commons**：`numHits` 是真实命中总数；但一个页面硬封顶 100，超出必须翻页（`truncated` 标明）。
- **未验证项**：openFDA **器械**（`device/510k.json` 等）本轮只做过一次探针（`200`），**未**接入工具；本次 openFDA 的「扩面」落在**不良事件（FAERS）**这一面。

## 四、对标差异化点（§9，每个工具至少一条）

1. **Pathway Commons `search_pathway_commons`**：把服务内部 URI（`http://bioregistry.io/reactome:R-HSA-…`、`pc14:reactome`、`bioregistry.io/ncbitaxon:9606`）**翻译成读者可查的 `prefix:id` / 纯 taxon id**（`reactome:R-HSA-…`、`9606`），并把生效的**服务端过滤条件**（type/organism/datasource + 服务方 `comment`）随结果上屏。
2. **Bgee `bgee_gene_expression`**：**发送前判输入形态**——只收 Ensembl gene id，裸 symbol 具名拒绝（否则服务回 404，会被读成「该基因不在 Bgee」，是假话）；species 必填并具名；服务分数字段口径在 `note` 说明「未本地复算」。
3. **cBioPortal `cbioportal_structural_variants_in_gene`**：新增基线**完全没有的融合/结构变异层**；两侧基因同时给 **Hugo 符号 + Entrez id**（翻译），并回显实际生效的 `molecular_profile_id`（服务端过滤条件上屏），缺 SV 数据时具名列出该研究的可用 alteration types。
4. **openFDA `search_drug_adverse_events`**：把 `serious` **字符串码归一化**后给布尔 + 原码；`raw_search` 覆盖、日期区间 AND 上屏（`search` 表达式随结果返回）；`note` 明写「无暴露分母、非发生率」——不把服务没有的分母假装出来。
5. **Cellosaurus `get_cellosaurus_cell_line`**：把埋进 `comment-list`/`str-list` 的**质量信号结构化**（`is_problematic` + annotated、STR 冲突标记），并把 `name ↔ CVCL 号`翻译互认；accession 与 name 两条路径**模式具名**，未知 accession 返回 `found:false` 而非空搜索。

## 五、验收读数（本轮）

- `npx vitest run src/main/connectors` → **1 failed | 74 passed (75 files)**；**1 failed | 871 passed | 50 skipped (922 tests)**。唯一失败是 `readme-connector-count.test.ts`：registry 现为 **262 tools**，README 仍写 257（**README 计数由父代理统一改，本轮按指令不动 README**）。
- 新增 5 工具 + 5 测试文件；`LIVE_API=1` 跑 5 个测试文件：**5 passed | 36 passed**（真实 HTTP 走通）。
- `npx tsc --noEmit -p tsconfig.node.json --composite false` → 无错。
- `npx eslint --no-cache src/main/connectors` → **0 errors**（59 warnings 全为既有文件的 prettier 格式，均非本轮引入）。
