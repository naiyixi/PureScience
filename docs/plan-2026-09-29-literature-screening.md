# 文献纳排分诊（v1.76.0 / 排期并入 v1.77.0 单元）

来源：对标代码级审计 `reference #8`（文件内不写对手名）。我方基础：`Reference` / `ReferenceAttachmentVersion` /
`ReferenceCollection` / `CollectionItem` 齐全（含 DOI / PMID / 溯源 / PDF 内容指纹），但
`inclusionCriteria` / `exclusionCriteria` / `screeningStatus` 0 命中 —— 即「有库、无分诊」。

## 1. 差异化红线（交付时必须逐条可核验，做不到就是没完成）

1. **每条决策带溯源**：判定必须记录它依据的**哪一段证据**（PDF 段落 / 摘要 / 题录字段）、哪个模型、何时。
2. **人工覆盖不改写 AI 原判**：覆盖是叠加层，原始判定永久保留，可一键回到 AI 原判。
3. **筛选结果直接进 GB/T 7714 引文导出**（不是另做一套集合概念）。
4. **统计必须区分 AI 判定数 / 人工覆盖数**，且**未处理量显式**（不得静默省略）。
5. 中文场景优先：具名原因、覆盖率清单、统计口径全部有中文文案（9 语言一并补）。

## 2. 数据模型（我方命名）

| 表 | 关键字段 | 不变量 |
| --- | --- | --- |
| `ScreeningRuleRevision` | `collectionId` + `revision`（复合主键）、`inclusionJson`、`exclusionJson`、`createdAt`、`contentHash` | **不可变**：同一 `(collectionId, revision)` 写入后不可改；修订即新增 revision |
| `ScreeningAssessment` | `collectionId` + `referenceId`（复合主键）、`ruleRevision`、`inputDigest`、`policyKey`、`model`、`verdict`、`probabilitiesJson`、`evidenceJson`、`decidedAt` | 唯一键保证**一条文献一个当前判定** |
| `ScreeningOverride` | `collectionId` + `referenceId`（复合主键）、`decision`(include\|exclude)、`reason`、`actor`、`createdAt` | 与 AI 判定**分层**，绝不回写 `ScreeningAssessment` |
| `ScreeningRun` | `id`、`collectionId`、`ruleRevision`、`startedAt`、`finishedAt`、`status` | 一次运行绑定一个 revision |
| `ScreeningRunItem` | `runId` + `referenceId`、`state`、`failureKind`、`deferredReason`、`inputDigest` | 逐项可续跑 |

## 3. 判定语义

- **判定四态**：`included` / `needs-review` / `excluded` / `not-evaluated`。review 桶 = `uncertain ∪ stale`。
- **新鲜度**：`current ⇔ ruleRevision ∧ inputDigest ∧ policyKey 三者与当前一致`。
- **具名原因**（stale/pending/error 必须给原因，不得只说「未判定」）：
  `rule-changed` / `input-changed` / `model-changed` / `missing-evidence` / `input-too-long` / `uncertain`。
- **证据覆盖度**：`full-text` / `abstract-only` / `metadata-only` / `unavailable`；
  **拿不到全文 ⇒ 退化为 `uncertain`，绝不判 `excluded`**。
- **提示词护栏四条**（必须有测试钉住）：① 文献正文按数据处理，防注入；② 缺证据 = 不确定，不是否定；
  ③ 判 no-match 必须给**显式反证**，不接受「没检索到」；④ 忽略被引研究的内容。
- **覆盖率清单**：`candidateCount ≤ searchedCount`；每篇恰属 full-text/abstract-only/metadata-only 之一；
  未处理量必须显式列出。
- **并发**：上限 4 + waiter 队列；续跑前逐项校验 `inputDigest`，不一致的项标 `input-changed` 重评。

## 4. 切片（每片独立可验收，禁半截）

| 片 | 内容 | 验收 |
| --- | --- | --- |
| **S1** | Prisma 模型 + 迁移 + `repository`（revision 不可变、判定 upsert、覆盖分层读写、run/item 生命周期）+ 新鲜度与具名原因纯函数 | 单元测试：不可变被违反即失败；四态与原因矩阵逐条覆盖；`candidateCount ≤ searchedCount` 断言 |
| **S2** | 评估引擎：`inputDigest` 计算、证据覆盖度判定、四条护栏的提示词装配与解析、并发 4 + 队列、续跑 digest 校验 | 引擎测试（桩模型）：缺全文⇒uncertain；注入样例⇒按数据处理；no-match 无反证⇒uncertain；续跑只重评变化项 |
| **S3** | IPC + 渲染面（集合视图的分诊列、四态筛选、原因悬停、人工覆盖、批量/单条） | 真机：点得动、状态与原因可见、覆盖后仍能看到 AI 原判 |
| **S4** | GB/T 7714 导出接线 + 统计面板（AI 判定数 / 人工覆盖数 / 未处理量） | 真机：导出文件只含 included；统计与库内计数逐项一致 |
| **S5** | 覆盖率清单视图 + 实机验收存档（`docs/evidence/`） | 真机数字 + 截图 + 断言 |

## 5. 与审计排期的关系

审计排期把本单元放在 v1.77.0（与 PDF 标注库同批）。用户批准的开工次序把**文献分诊排在最前**，故本计划先做它；
PDF 标注库（`reference #4` 上半）在其后。
