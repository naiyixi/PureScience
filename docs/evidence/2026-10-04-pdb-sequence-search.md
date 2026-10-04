# PDB 自由序列搜索（`pdb_search_by_sequence`）—— 证据（2026-10-04）

## 缺口

竞品窗口（2026-10-03→04，尾巴 17 提交）里有 `feat(connectors): add PDB protein sequence search`（#3250）。
我方现状：`src/main/connectors/descriptors/structures-pdb.ts` 有 4 个工具
（`pdb_search_structures` / `pdb_get_structures` / `pdb_get_entities` / `pdb_get_ligands`），
但搜索工具的入参只有 `text` / `organism` / `taxonomy_id` / **`uniprot_accession`** /
`experimental_method` / `max_resolution_angstrom` / `ligand_comp_id` / `include_computed_models` /
`max_rows`——**没有自由序列输入**。手里只有一条序列（设计变体、构造体、论文里抄来的一段链）就搜不了。

## 交付

新增第 5 个工具 `pdb_search_by_sequence`（挂在我们已有的 `structures` 连接器上 ⇒ **连接器数 26 不变、
工具数 256 → 257**，两份 README 同步改、逐字节一致）。

### 四条**优于**对标的点（不是平齐）

1. **每条命中给 `polymer_entity_id` + `pdb_id` + `identity`**：接口返回的是聚合物实体号（`11SY_2`），
   工具把实体号**与读者真正会去查的条目号（`11SY`）一起给出**，并说明 `identity` 就是 0–1 的序列一致性。
2. **提交前先判形态，具名拒绝**：序列先归一化（FASTA 头行、折行、空白都算正常输入），再按声明类型
   校验（蛋白 20 字母表 + `B/Z/X/U/O` 歧义码；核酸用 IUPAC 码），不符就**指名出错字符与位置**并拒绝。
   ——**理由**：把坏序列发给服务，服务回的是「无命中」，那读起来是「你的序列不在 PDB 里」，
   是一句**假话**；两者必须分开。
3. **把生效的阈值随结果上屏**（`filters:{identity_cutoff, evalue_cutoff}`）：过滤发生在服务端，
   所以「清单短」既可能是家族小、也可能是查询窄——**不写阈值就分不出来**。下面的实调用读数就是这条的证明。
4. **`total_count` / `n_retrieved` / `truncated` 照本仓体例报**（被截断就说被截断），
   且 `identity_cutoff` / `evalue_cutoff` 越界**具名拒绝而不是静默夹紧**（夹紧会在调用者以为换了别的查询时
   偷偷改变结果集）。

## 真机读数

### 单元（假宿主，`structures-pdb.test.ts`）

`npx vitest run src/main/connectors/descriptors/structures-pdb.test.ts` → **23 passed**（原有 17 + 新增 6）：
POST 形态（`service:"sequence"`、`scoring_strategy:"sequence"`、`return_type:"polymer_entity"`）、
实体号→条目号映射、FASTA 归一化（头行数上报）、**坏字符具名拒绝且一次都没发出去**、
空序列拒绝、阈值越界拒绝、204 空命中读作 `total_count: 0`。

### 实调（真 RCSB，用工具自身的代码路径跑）

```
[live-seq] {"sequence_length":76,"sequence_type":"protein","sequence_header_lines_stripped":0,
 "filters":{"identity_cutoff":1,"evalue_cutoff":1},"total_count":1163,"n_retrieved":3,
 "truncated":true,"max_rows":3,
 "records":[{"polymer_entity_id":"11SY_2","pdb_id":"11SY","identity":1},
            {"polymer_entity_id":"11TA_2","pdb_id":"11TA","identity":1},
            {"polymer_entity_id":"1AAR_1","pdb_id":"1AAR","identity":1}]}
```

请求形态（先手工确认过接口）：

```
POST https://search.rcsb.org/rcsbsearch/v2/query   (Content-Type: application/json)
{"query":{"type":"terminal","service":"sequence","parameters":{
   "evalue_cutoff":1,"identity_cutoff":0.9,"sequence_type":"protein","value":"<序列>"}},
 "return_type":"polymer_entity","request_options":{"paginate":{"start":0,"rows":3},
   "scoring_strategy":"sequence"}}
→ {"total_count":1689,"result_set":[{"identifier":"11SY_2","score":1.0}, …]}
```

**同一条泛素序列**（76 aa）：`identity_cutoff: 1` ⇒ `total_count: 1163`；
`identity_cutoff: 0.9` ⇒ `total_count: 1689`。⇒ 差异化点 3 是**实测**出来的必要性，
不是设计上的好听话：阈值不随结果上屏，读者无法区分「家族小」与「查询窄」。

## 未做（明确）

- **不返回比对**（对齐区间、逐位差异）：接口只给每条命中的一致性打分，没有回传比对；
  要出比对得另取实体序列自己算，那是另一个单元，本轮**不做也不假装**（工具描述里已写明
  「only the identity the service scores each hit with」）。
- **坐标文件仍不下载**（沿用本连接器一贯口径：metadata only）。
- 公开数字从「26 connectors (256 tools…)」改为 257，两份 README 同步；发布时随下一版 CHANGELOG 公布。
