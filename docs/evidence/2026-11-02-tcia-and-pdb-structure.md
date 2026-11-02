# TCIA 与 PDB 结构相似：CI 实机读数（本机网络到不了源站）

> 2026-11-02。这两个连接器的源站从本机不可达：TCIA 的 `services.` / `nbia.` 与 http 变体全部 `000`
> （DNS 正常解析到 144.30.169.13），`search.foldseek.com` 间歇性 `000`。所以读数由 CI 上的实机探针产生
> （`connector-probe.yml` + `scripts/probe-connectors.mjs`，与 `live-probes.test.ts` 同源），并把服务原话打进日志。

## TCIA（`cancer-imaging`，三个工具）

runner（ubuntu-latest）实测：

```
LIVE tcia_collections {"n_collections":5,"fields":["Collection"],
  "collections":[{"Collection":"4D-Lung"},{"Collection":"A091105"},{"Collection":"ACNS0332"},
                 {"Collection":"ACRIN-6698"},{"Collection":"ACRIN-Contralateral-Breast-MR"}]}
LIVE tcia_patient_studies 4D-Lung {"n_patients":3,
  "fields":["Collection","PatientId","PatientName","PatientSex","Phantom","SpeciesCode","SpeciesDescription"]}
LIVE tcia_series_search 4D-Lung {"n_series":3,
  "fields":["BodyPartExamined","Collection","CollectionURI","DateReleased","FileSize","ImageCount",
            "LicenseName","LicenseURI","Manufacturer","ManufacturerModelName", …]}
```

读数说明：记录按服务原样透传（`fields` 列出实际见过的键，字段集随部署变化过）；`ImageCount` / `FileSize` /
`LicenseName` 都在序列记录里，所以「有哪些扫描、多大、什么许可」可以直接回答；本工具不下载像素。

## PDB 结构相似（`structure-similarity`，一个工具）

三轮实验把 payload 与端点钉死（每一轮都是一次 CI 运行，不是猜）：

| 尝试 | 服务原话 |
| --- | --- |
| multipart 字段 `database` | `400 Key: 'JobRequest.Job.Database' Error:Field validation for 'Database' failed on the 'required' tag` |
| 字段 `database[]` | **200** `{"id":"BBRMB9P…","status":"PENDING"}` |
| `/api/result/<id>` / `?format=json` / `.json` | 全部 `404 page not found` |
| `/api/ticket/<id>` | 200，只有 `{id,status}` |
| **`/api/result/<id>/0`** | **200**，主体 `{"type":"structuresearch","queries":[…],"mode":"3diaa","results":[{"db":"afdb50","alignments":[[…]]}]}` |

最终读数（1CBS 作为查询，afdb50 + pdb100）：**`status=COMPLETE, hits=1000`**，首条
`AF-A0A9X9LGA4-F1-model_v6 Cytosolic fatty-acid binding proteins domain-containing protein (Fragment)`，
`seqId=95.6`、`alnLength=137`、`qStartPos=1`、`dbStartPos=43`。

两个解析错误是实测暴露的、不是读文档能发现的：`alignments` 是 **二维**（每个库一组 × 每次查询一组），
读浅一层会在一千条命中的搜索上报 0；字段名是 `eval` / `alnLength` / `seqId`，不是 `evalue` / `alnLen`。

## 边界

- 两条读数都来自 CI runner，**不是本机**：本机到这两个源站不通，这一点写在 CHANGELOG 的「未做」里；
- FoldSeek 的搜索是异步的：`incomplete` 分支在「没等到 COMPLETE」时如实返回 ticket，不假装是全部结果；
- TCIA 只取元数据（`getCollectionValues` / `getPatient` / `getSeries`），没有任何像素下载路径。
