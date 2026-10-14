# 批 C（v2.2.0「数据面加宽」）五件已落地能力的独立复算与读源审计（执行器，2026-10-14）

> 本档只记**我自己重新取了一遍**的读数、我读源看到的事实、以及我**没能**取证的部分。
> 会话在队列档里记下的读数一律**当线索**，不当证据：本档里的每个值都附我发出的那条请求。
> 全部请求在 2026-10-14 13:0x–13:2x（CST）从本机发出；读数落在 `/tmp` 的临时文件里，未进仓。

---

## 一 本轮开工时的现场（为什么做这一遍）

| 事实 | 读数 |
| --- | --- |
| 批 C 六件的状态 | **五件已落地并推上 main**（C1 `967091cc`、C3 `cd0cc41f`、C4 `04b1f599`、C5 `aea0439f`、C6 `84ae5f4f`，11:40–12:17）；**C2（文献库整页全选）未提交、正在会话手里** |
| 会话在制的路径（`git status --short`） | `src/renderer/src/components/references/ReferencesLibraryDialog.tsx` + 9 个 i18n 字典 —— **不是我的**，按并发纪律让路：不碰、不 stash、不替它提交 |
| 内存闸门 | 空闲物理页 **4,448** ≈ **72 MB**（page 16 KB）；swap **7,728 / 9,216 MB** 已用（余 1,488 MB）。占用者按 RSS：长期驻留的无关桌面应用（1,116 MB）· Hermes 渲染进程（845 MB）· 常驻 dev 实例（807 MB + 390 MB）· 另一个工作应用（682 MB）⇒ **本轮不起任何实例、不跑 `build:e2e` / Playwright** |

**本轮的形状**：对已落地的五件做**独立复算**（我自己发请求）+ **读源审计**（对着批 C 每条差异化红线逐条给 `file:line`）+ 在隔离工作树里对当前位点跑一次发版就绪门禁（给发版窗口预留读数）。

---

## 二 独立复算：我自己发的请求与原始读数

| 件 | 我发出的请求 | 我读到的原始值 | 与会话记录的读数 |
| --- | --- | --- | --- |
| **C1** Ensembl 群体 LD | `GET https://rest.ensembl.org/ld/homo_sapiens/rs699/1000GENOMES:phase_3:CEU?r2=1` | **8 对**；首对 `{variation1:"rs699", variation2:"rs2478543", r2:"1.000000", d_prime:"1.000000", population_name:"1000GENOMES:phase_3:CEU"}` —— 两个统计量都是**源自己格式化的字符串**（六位小数），工具原样引用 | 一致（8 对 / 首对 r²=1.000000） |
| **C1** 面板清单（判「未知面板」的依据） | `GET https://rest.ensembl.org/info/variation/populations/homo_sapiens?filter=LD` | **30 个面板**；`1000GENOMES:phase_3:CEU` 的 `description`="Utah residents with Northern and Western European ancestry"、**`size`=99** | 一致（30 个可选名 + size 99） |
| **C3** ChEMBL assay 详情 | `GET https://www.ebi.ac.uk/chembl/api/data/assay/CHEMBL4880040.json` | `assay_type="B"`、`confidence_score=9`、`relationship_type="D"`、`bao_label="single protein format"`、`assay_organism="Homo sapiens"` | 一致 |
| **C3** 该 assay 的真总数（截断判据的来源） | `GET …/activity.json?assay_chembl_id=CHEMBL4880040&limit=1` | `page_meta.total_count`=**249**（`limit=1` ⇒ 本页 1 行） | 一致（count 1/total 249/truncated true 的同口径） |
| **C4** ClinVar 逐提交（SCV）证据 | `esearch(db=clinvar, term=VCV005007684)` ⇒ uid `5007684` ⇒ `efetch(db=clinvar, id=5007684, rettype=vcv, is_variationid=1)` | 归档属性 `Accession="VCV000017677"`、`VariationID="17677"`、`VariationName="NM_007294.4(BRCA1):c.5266dup (p.Gln1756fs)"`、**`NumberOfSubmissions=101`**、**`NumberOfSubmitters=92`**；XML 里 `<ClinicalAssertion ` 出现 **101 次**、`<RecordStatus>` 出现 **102 次**（= 1 条文档级 + 101 条逐提交级）、文档级值为 `current` | 一致（提交 101 / 提交者 92）。**并额外证到**：这份 XML **并没有只回一部分提交**（101 条全在）⇒ 工具用「申报数 > 返回行数」判 `truncated` 是够的，不会把不完整当完整、也不会把完整当截断 |
| **C5** ENCORI miRNA-靶基因表 | `GET https://rnasysu.com/encori/api/miRNATarget/?assembly=hg38&geneType=mRNA&miRNA=all&clipExpNum=1&degraExpNum=0&pancancerNum=0&target=TP53` | HTTP **200**；正文 = **2 行 `#` 引用行** + **25 列表头** + **188 数据行**；表头**逐名**与描述符里的 `ENCORI_MIRNA_TARGET_COLUMNS` 相同（含 `cellline/tissue`）；**错列行 0 行** | 一致（形状与列名；`absent_columns` 在真数据上应为空） |
| **C6** PDC 研究目录 | `POST https://pdc.cancer.gov/graphql`，`{ uiStudySummary { study_id study_name disease_type primary_site } }` | **277 个研究**；首条 `28f0e1de-c04b-4281-981d-865a5885245e / Academia Sinica BRCA - Phosphoproteome / Breast Invasive Carcinoma;Not Reported / Breast;Not Reported`；缺 `study_id`/`study_name` 的行 **0** | 一致（277，首条逐字相同） |
| **C6** 单研究文件清单 | 同上，`filesPerStudy(study_id, offset:0, limit:600)` + `filesCountPerStudy(study_id)` | `files_count`=**600**、返回 **600 行**；**600/600 行的 `file_size` 都是纯数字串**（0 行不可解析）；三者求和 = **1,505,997,340,728 字节**（≈1.5 TB，与「这类研究动辄 TB 级」相符）；`offset+rows == total` ⇒ `truncated` 应为 **false** | 一致（600 就是真文件数，不是上限） |

**这一节的结论**：五件的**源侧形状与关键数字**在我这里逐项复现；没有一条是「只有会话见过」的。

---

## 三 读源审计：批 C 每条差异化红线的落点

| 件 | 红线（批 C 勘查里的原话） | 我读到的落点 |
| --- | --- | --- |
| C1 | 成对 LD 必须回**明确的人群面板与样本量**；缺面板就具名拒答；不许把 r² 当因果/显著性 | `genomes-ensembl.ts`：`listLdPopulations()` 取源自己的 `?filter=LD` 清单并带 `description`/`size`；结果里 `population: {name, description, size}`；两个统计量**原样引用**（`ldPair` 只搬运，不重标度、不判读）。拒答分支：源对「未知面板」与「未知变异」回**同一个 400** ⇒ 代码**去问源自己的面板清单**再判是哪一个（`unknown-population` 附全部可选名 / `unknown-variant`），源码注释逐字写明「不猜」 |
| C3 | 非 `^CHEMBL[0-9]+$` 的输入**一个请求都不发** | `chembl.ts:1033` `/^CHEMBL[0-9]+$/` ⇒ `invalid-assay-id`（在**任何 fetch 之前**返回）；`unknown-assay` 由源的真答案决定（不返回空记录）；总数用源的 `page_meta.total_count`，返回列表带 `truncated` |
| C4 | SCV 级详情必须**逐条可引用**；缺失的提交**具名列出**，不许静默少几条 | `variants-clinvar.ts:14/16` `VCV_RE` / `RSID_RE` ⇒ 非这两种形态**零请求**拒答（`invalid-variant`）；`submissionRow()` **只取自己文档化的字段**，未知元素忽略而不是并进行；`truncated` 由归档属性 `NumberOfSubmissions` 决定，`number_of_submissions`/`number_of_submitters` 照抄归档 |
| C5 | 来源可答性**先测后接**；不能答的输入具名拒绝、一个请求都不发 | `rna-encori.ts:84/91/98`：缺 target ⇒ `target-required`；非 `hg38`/`mm10` ⇒ `unsupported-assembly`；非五类 geneType ⇒ `unsupported-gene-type`（三条都在 fetch 之前）。**宕机诚实性**：源在库不可用时**回 HTTP 200 + 一段 PHP 告警**，`notATable` 判定把它具名成 `source-unreadable` 并引用源原话，而不是把告警解析成 0 行（那会把一次故障读成「没有互作」） |
| C6 | GraphQL 的 `errors` 具名抛出，**绝不当成「没有数据」**；只看字节数、不下载文件 | `proteomics-pdc.ts:25` `graphQlError()` ⇒ `{error:'graphql-error', message:<服务原话>}`；`UUID_RE` 前置形态检查（非 UUID ⇒ `invalid-study-id`、零请求，并说明要的是 `pdc_studies` 给的 UUID）；`bytes_of_returned_rows` 明确是**本次返回行**之和，`total_files` 来自 `filesCountPerStudy` |

**一处我读到、但不判为缺陷**（记下来给下一批参考）：`get_bioactivity` 新增的 `assay_chembl_id` 参数**不做形态校验**——与本文件既有 `molecule_chembl_id` / `target_chembl_id` 是**同一写法**（交给源自己过滤，传非 id 得 0 行）。批 C 的「非 id 零请求」政策落在**新工具 `get_assay`** 上。若要把这一族统一收紧，那是**跨工具**的行为变更（会同时改动既有工具），需与批 C 的话术一起评估 ⇒ **不在本轮擅动**，在此具名。

---

## 四 我这一轮跑过的门禁与用例（命令与汇总行原文）

| 环 | 命令 | 读数 |
| --- | --- | --- |
| 连接器侧的计数钉子 + 五个描述符用例 | `npx vitest run src/main/connectors/readme-connector-count.test.ts src/main/connectors/descriptors/{proteomics-pdc,rna-encori,variants-clinvar,genomes-ensembl,chembl}.test.ts --maxWorkers=1` | **6 文件 / 68 条全过**，`Duration 1.05s`，exit 0 —— 其中 `readme-connector-count` 是**读源测试**：它同时读两份 README 与注册表，所以「连接器 30 / 工具 279」这两个数字不是我抄的，是它核的 |
| 独立点数（自证，不是判据） | 按描述符目录数 `id:` 行 | **279**（与该轮位点上两份 README 的 `30 connectors (279 tools)` 相符；判据以那条读源测试为准。该数随后随新增连接器抬到 **31 / 282**，本行是**当日读数、不是现值**） |
| 发版就绪门禁（技能自带 `release-gate.sh`，**隔离工作树**、被测提交 `23292e8b`） | `bash …/release-gate.sh 23292e8b` | 见 `## 五` |

---

## 五 发版就绪门禁读数（隔离工作树，被测提交 `23292e8b`）

> 技能自带的 `release-gate.sh 23292e8b`：建**隔离工作树**（`/tmp/ps-release-gate`，软链 `node_modules`）→ 逐环自证 `[ring] cwd=/tmp/ps-release-gate version=2.1.0` → 每环全文落 `/tmp/release-gate-23292e8b-<环名>.log`。共享树里会话那 10 个在制路径**一个字节都没进这棵树**。

| 环 | 汇总行原文 | 判定 |
| --- | --- | --- |
| `eslint --no-cache .` | `✖ 120 problems (0 errors, 120 warnings)` | **OK**（0 error；120 warning 与 v2.1.0 发版那一次相同） |
| `typecheck:node` | 日志里只有 npm 横幅、`tsc` 零输出 | **OK**（且无 `error TS`） |
| `typecheck:web` | 同上 | **OK** |
| `vitest run --maxWorkers=4` | `Test Files 1293 passed | 16 skipped (1309)` ／ `Tests 16581 passed | 207 skipped (16788)` ／ `Duration 357.73s` | **OK**（文件数与条数都比 v2.1.0 那次多 —— 1307→1309 文件、16766→16788 条，与批 C 新增的 spec 相符） |
| `repo-checks`（仓规五查） | `[pre-push] 全部通过。` | **OK** |

```
=== 发版就绪门禁汇总（23292e8b4939c22b5b199434b577334bef92fe4f）===
eslint|OK
typecheck:node|OK
typecheck:web|OK
vitest|OK
repo-checks|OK
```

⇒ **当前位点上，v2.2.0 的四文件之外没有阻塞**：只差 C2 落地，然后走发版八步（先冻结并发、再改四文件、在**要打 tag 的那个提交**上复跑一次门禁）。

---

## 六 本轮**没有**取证的部分（具名，不许当已取）

1. **C2「文献库整页全选」的窗口读数** —— 它的改动**尚未提交**（会话在制），本轮按并发纪律让路 ⇒ 未取。它是批 C 的最后一件，也是 v2.2.0 发版前唯一还差读数的那一件。
2. **五件的「界面上走一遍」读数** —— 本轮没有启动任何实例（内存闸门见 §一）：我取到的是**端点级复算** + 描述符用例。工具**经应用**（agent → MCP → 连接器引擎）那一段由描述符用例与引擎的共享路径覆盖，**窗口那一层未取**；会话在 C5/C6 里记的「走工具自己的代码路径」读数我没有复跑（无法在不重建实例的前提下复跑）。
3. **打包态的复核** —— 属发版后动作，本轮未做。
