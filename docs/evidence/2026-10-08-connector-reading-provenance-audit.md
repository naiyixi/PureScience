# 批次 ②（溯源）第一步核实：既有 provenance 覆盖到哪一层（2026-10-08）

**结论：部分覆盖 —— 产物/执行侧已覆盖（强），连接器读数侧零覆盖。**
按仓规「部分覆盖 ⇒ 扩展既有实现，绝不并行新建第二套」，下一步是**在既有帧里扩一层**，不是另起一套。

## 一、已覆盖（产物/执行侧，file:line）

| 能力 | 落点 | 说明 |
| --- | --- | --- |
| 产物版本身份 / 血缘 / 证据 | `src/shared/artifact-provenance.ts` | `ArtifactVersionIdentity`、`ArtifactLineageProvenance`、`ArtifactVersionEvidence`、写入侧 `writeRequestChecksum` |
| 密封复现配方（逐文件 sha256） | `src/shared/reproducibility.ts` | `ReproducibilityRecipeFile { filename, sha256, sizeBytes }`；`buildSealedReproducibilityRecipe()` |
| **缺失具名**（本批要沿用的口径） | 同上 `ReproducibilityGapReason` | **15 条具名缺口**：`artifact-content-unavailable`、`no-re-execution-evidence`、`reproduction-not-hashed`… —— 缺什么就点什么是哪一条 |
| 「没比过」不得读成「一致」 | 同上 `compareReproducedFile()` / `ReproducibilityFileOutcome` | 判据写在模块头：**用户自报的字节相同只报 `bytes-match`**；上界截断报 `not-compared`；不完整配方不给部分credit |
| 复现重执行计划 | `src/shared/reproducibility-reexecution.ts` | `ReproducibilityReexecutionRefusal` + `planRecipeReexecution()` |
| 产物 sha256 单一来源 | `src/shared/ro-crate.ts:40` | `RO_CRATE_SHA256_TERM_IRI` |
| 既有的 sha256 **格式**词汇 | `src/shared/permission-grants.ts:10` | `EXACT_PERMISSION_QUALIFIER_PATTERN = /^sha256:v1:[a-f0-9]{64}$/` —— 全仓唯一共享的指纹写法 |
| **最接近的既有帧：指纹 + 已发布配方 + 校验判决** | `src/shared/search-evidence.ts` | 头注释逐字："a captured line carries a fingerprint computed from the block as it is stored, and **the recipe is published here: anyone holding the block can recompute it**"；`SEARCH_EVIDENCE_HASH_RECIPE = 'purescience-search-evidence-v1'`（**配方是常量、可外部复算**）、`SearchEvidenceVerificationResult`（校验判决）、`SearchEvidenceReason`（拒绝理由）；且刻意 **"Nothing here touches node:crypto — this module is shared with the renderer, which never hashes."**。生产消费方：`GlobalSearchDialog.tsx`、`HumanEvidenceSection.tsx`、`review-evidence.ts` |
| 重放/校验词汇 | `src/shared/artifact-replay.ts`、`replay-verification.ts` | `reproduced`/`differs` 与 `intact`/`changed` 分开，**"not checked" 从不读成 match** |

## 二、缺口（连接器读数侧，file:line）

| 事实 | 落点 |
| --- | --- |
| 连接器调用**只返回解析后的值**：URL、入参、响应字节一概不落 | `src/main/connectors/engine.ts:61-76`（`call()` 末尾 `return descriptor.parse(raw, args)`） |
| 工具活动记录里**没有服务/请求/指纹字段** | `src/shared/session-persistence.ts:222-242`（`PersistedToolActivity` 只有 `rawInput` / `rawOutput` / `toolContent`，无 URL、无 sha256、无字节数） |
| 无共享 sha256 助手，主进程内有 **4 份局部实现** | `src/main/artifacts/code-reconstruction.ts:121`、`provenance-message-snapshot.ts:42`、`provenance-repository.ts:483`、`mcp-server.ts:432` |

⇒ 批次 ② 的四条差异化点里，①②③④ 在**连接器读数**这一侧**一条都没有**；在产物侧 ②（可离线复算）与 ④（缺失明说）已经成立。

## 三、下一步形状（不新建第二套）

1. **复用的帧不是 `permission-grants` 的格式串，而是 `search-evidence.ts` 的整套帧**（先按源码核过再定，别照文档里写的旧结论动手）：**指纹 + 已发布的可复算配方常量 + 校验判决 + 具名拒绝理由**，且共享层不碰 `node:crypto`（摘要只在主进程算，共享层只持有配方与判决）。新配方的常量名沿用 `purescience-<域>-v1` 形态。
2. **扩展点**：`engine.ts` —— 必须落在 **`makeContext()` 的四个 fetch 包装**上，不是 `call()` 的 `url()/parse()` 分支：`engine.ts:70` 显示 `run()` 型 descriptor（现代连接器几乎全是，如 `pubmed.search_articles`）**根本不经 `url()/parse()`**，只在 `call()` 上挂钩会漏掉它们，做出一个"看起来覆盖全、实际只覆盖一半"的指纹。
3. **判据（可写成断言）**：
   - 每条读数带 `{ service, tool, request: { method, url(脱敏) }, response: { status, bytes, sha256 } }`；
   - 指纹可由**任何人离线复算**（给同一份响应字节 + 已发布配方，逐字符相同）；
   - 产物 ↔ 读数引用链**可遍历**（从产物版本能查到生成它的读数指纹）；
   - **缺指纹时明说没记**（具名 `not-recorded`，**不填 0、不填 unknown**）。
4. **已核实的爆炸半径（这条决定单元怎么切）**：读数要送到调用方，只有两条自然出口 ——
   ① **agent 看到的工具返回值**：`local-rpc-server.ts:1730` 的 `mcpCall` 直接 `return this.connectorService.call(...)`，而该结果形状被 **7+ 套件**钉住（含 `src/main/notebook/e2e.certification.test.ts` 这支认证 spec）；
   ② **持久的工具活动记录**：`session-persistence.ts:222-242`（还牵动恢复与投影）。
   ⇒ 两者都不是"顺手加一个字段"，**必须先声明形状再动手**；且 `ConnectorServiceDeps` 目前**没有 logger/telemetry 缝**（`service.ts:27-45`），所以也没有"只记日志、不碰契约"的第三条轻路。
5. **不做**：不给没有读数的能力造指纹字段（沿用 G3 先例）；不碰 `src/main/connectors/descriptors/**` 与 `catalog.ts`/`registry.ts`（同批自主执行器正在那片在编）。
