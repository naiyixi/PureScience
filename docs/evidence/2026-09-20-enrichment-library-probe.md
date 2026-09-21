# 证据：库式基因集富集连接器（2026-09-20）

被测对象：`src/main/connectors/descriptors/genes-enrichr.ts` 的工具 `gene_set_enrichment_libraries`
（已接线进 `genes` 连接器，见 `src/main/connectors/registry.ts`）。

## 真实服务核实（不是假设）

| 事实 | 核实方式与结果 |
|---|---|
| 提交基因列表必须用 **multipart/form-data** | urlencoded 与 JSON body 均 **HTTP 400**（返回 HTML 错误页）；`-F "list=<file>"` **HTTP 200**，返回 `{"shortId":"1ccc3298563e933dad6369f85bb7c020","userListId":138206260}` |
| 成功响应是 JSON 但 **content-type 标成 text/html** | `enrich` 返回 `content-type: text/html`，正文为 JSON ⇒ 客户端**必须按文本读再解析**，不能依赖 `response.json()` |
| `enrich` 的结构 | 对象按 library 名键控，值为**行数组**，每行 9 项：`[rank, term, pValue, zScore, combinedScore, overlappingGenes[], adjustedPValue, oldPValue, oldAdjustedPValue]` |
| 服务**不报**集合大小 | 返回字段里没有 term size / query size / background size ⇒ **尾概率无法在本地复算** |

## 描述符真机跑（一次性探针，跑完即删，未提交）

输入：`genes = [TP53, BRCA1, EGFR, MYC, PTEN]`，`libraries = [GO_Biological_Process_2023]`，其余默认。

```json
{"counts":{"returned":432,"kept":50,"filtered":40,"malformedRows":0,"truncated":342,"librariesFailed":0},
 "perLibrary":[{"library":"GO_Biological_Process_2023","returned":432,"kept":50}],
 "firstTerm":{"term":"Positive Regulation Of miRNA Transcription (GO:1902895)","rank":1,
   "pValue":9.228228599930086e-8,"adjustedPValue":0.00002974490276413773,
   "zScore":748.3125,"combinedScore":12121.475400639456,"overlap":3,
   "overlapGenes":["MYC","TP53","EGFR"],
   "recomputed":false,
   "recomputeReason":"the service reports no set sizes, so this p-value cannot be recomputed locally"}}
```

要点：
- **本地唯一能做的核验真的做了**：服务回报的重叠基因 `MYC/TP53/EGFR` 全部在提交列表内；若出现陌生基因，描述符会**整通失败并具名**（不是记一条 library 级错误继续）——因为那意味着这个 userListId 的答案不属于我们。
- **绝不冒充复算**：每条 term 都带 `recomputed:false` 与原因；服务方给的校正 p 值按其本来归属呈现。
- 过滤与截断**计数不静默丢弃**：40 条被 alpha/最小重叠过滤、342 条被每库上限截断，都写进 `counts` 与 `summary.notes`。

## 单元测试

`src/main/connectors/descriptors/genes-enrichr.test.ts` 7 用例：multipart 形状与列表内容、text/html 里读 JSON、
陌生基因**整通失败**、缺 library 键具名报错、单库失败不影响其他库、过滤/截断计数、缺 userListId 具名报错、
空基因输入拒绝。`npx vitest run src/main/connectors` 全绿（65 文件 / 776 用例）。
