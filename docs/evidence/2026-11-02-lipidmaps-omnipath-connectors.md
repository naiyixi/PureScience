# v2.21.2 连接器：LIPID MAPS 与 OmniPath（两个已实机验证，两个受阻）

> 时间：2026-11-02。每条读数都来自本机对真实服务的调用（`npm` 之外的 `fetch`，与工具运行时同一个 `ToolContext`）。

## 一 交付了什么

### 1 `lipid-maps` 连接器（1 个工具）

`lipidmaps_compound_lookup(input_type, input)` —— 按标识符精确查一个脂质。

**实测（`input_type: "pubchem_cid"`, `input: "5997"`）**：

```json
{
  "source": "LIPID MAPS (LMSD)",
  "input_type": "pubchem_cid",
  "input": "5997",
  "n_results": 1,
  "compounds": [
    {
      "lm_id": "LMST01010001",
      "name": "Cholesterol",
      "systematic_name": "cholest-5-en-3beta-ol",
      "formula": "C27H46O",
      "exact_mass": "386.354866",
      "smiles": "[C@]12(CC=C3C[C@@H](O)CC[C@]3(C)…"
    }
  ]
}
```

**一条必须写下来的边界**：这个 API **没有名称检索**。`compound/name/cholesterol/all` 的答复是

> This input item does not exist<br> Choose from: 'formula','regno','inchi_key','lm_id','pubchem_cid','hmdb_id','kegg_id','chebi_id','smiles','abbrev','abbrev_chains'

所以工具把 `name` 作为**具名拒绝**（`unsupported-input-type`）处理，并把 11 种合法标识符写进 `input_type` 的枚举与报错里 —— 名字要先经 PubChem 之类换成标识符。竞品把这一条说成「by identifier or name」，我们按实测写。

### 2 `omnipath` 连接器（3 个工具）

| 工具                        | 实测（本机，2026-11-02）                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `omnipath_interactions`     | `partners=TP53, limit=2` → `n_interactions: 2`，首条 `P04637(TP53) → Q9BRQ8(AIFM2)`，`is_directed: true`、`is_stimulation: true`、`consensus_stimulation: true` |
| `omnipath_annotations`      | `proteins=TP53` → `{uniprot: P04637, source: PROGENy, label: "pathway", value: "PI3K", record_id: 101217}`                                                      |
| `omnipath_enzyme_substrate` | `enzymes=CDK1` → `{enzyme: P06493, substrate: O15392, residue_type: "T", residue_offset: 34, modification: "phosphorylation"}`                                  |

两条实测出来的服务行为，都被写进了实现而不是留给用户猜：

1. **`entities` 不是参数**（服务答 `Unknown argument: entities`）；过滤器是 `partners` / `proteins` / `enzymes`+`substrates`。
2. **`/annotations` 不接受 `organisms`**（答 `Unknown argument: organisms`），而 `/interactions` 与 `/enzsub` 接受。
   第一版实现把 `organisms` 发给了三个端点，annotations 因此被**整条拒绝**——这是实机探针抓到的，不是读代码发现的。
   现在 annotations 不发该参数，并在结果里写明 `organismFilterApplied: false`，不假装过滤过。

服务把参数错误答成 **HTTP 200 + `[["Something is not entirely good: …"]]`**，所以实现按响应形状判定拒绝（`argument-rejected`），不按状态码。

## 二 登记与文档同步

- `registry.ts` 注册两组工具；`catalog.ts` 新增两条连接器元数据（`domain: structures` / `genomics`）。
- 计数守卫 `readme-connector-count.test.ts` 当场变红（31→33 连接器、282→286 工具），已按注册表实测改到 README.md / README.en.md / ROADMAP.md；该守卫 4/4 通过。

## 三 另外两个（TCIA / PDB 结构相似）—— 未交付，原因写在这里

| 目标                                            | 实测                                                                                                                                                                               | 结论                                                                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **TCIA**（`services.cancerimagingarchive.net`） | `curl` 三次全部 `000`（connect-timeout 8 / 15 / 20 s，DNS 正常解析到 `144.30.169.13`）                                                                                             | 本机网络到该主机不通，**无法实机验证**，因此没有把它写成「已交付」                                                          |
| **PDB 结构相似**                                | RCSB Search v2：`service: "structure"` 与 `pairwise`/`structsim`/`seqmotif` 五个变体全部 `400 JSON schema validation failed`；`full_text` 同构造返回 200（说明请求机制本身是对的） | RCSB 公开 v2 查询面没有可用的结构相似服务；FoldSeek 的 `api/ticket` 要求**文件上传**（`q=@file`），且本轮多次试探返回空/400 |

这两个不定为「已完成」。下一步二选一：

1. 走代理/换网络复测 TCIA，成功后按 LIPID MAPS 同样方式交付（工具 + 实机读数）；
2. PDB 结构相似改走 FoldSeek 的完整流程（取 `files.rcsb.org` 的坐标 → 上传 → 轮询 ticket → 解析），需要单独一轮把它跑通再交付。
