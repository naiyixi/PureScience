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
| 重放/校验词汇 | `src/shared/artifact-replay.ts`、`replay-verification.ts` | `reproduced`/`differs` 与 `intact`/`changed` 分开，**"not checked" 从不读成 match** |

## 二、缺口（连接器读数侧，file:line）

| 事实 | 落点 |
| --- | --- |
| 连接器调用**只返回解析后的值**：URL、入参、响应字节一概不落 | `src/main/connectors/engine.ts:61-76`（`call()` 末尾 `return descriptor.parse(raw, args)`） |
| 工具活动记录里**没有服务/请求/指纹字段** | `src/shared/session-persistence.ts:222-242`（`PersistedToolActivity` 只有 `rawInput` / `rawOutput` / `toolContent`，无 URL、无 sha256、无字节数） |
| 无共享 sha256 助手，主进程内有 **4 份局部实现** | `src/main/artifacts/code-reconstruction.ts:121`、`provenance-message-snapshot.ts:42`、`provenance-repository.ts:483`、`mcp-server.ts:432` |

⇒ 批次 ② 的四条差异化点里，①②③④ 在**连接器读数**这一侧**一条都没有**；在产物侧 ②（可离线复算）与 ④（缺失明说）已经成立。

## 三、下一步形状（不新建第二套）

1. **单一来源**：新增的指纹一律走 `sha256:v1:<64 hex>` 这一既有格式，且**只加一份共享助手**（放在 `src/shared/`），不再添第 5 份局部 `createHash('sha256')`；主进程那 4 份**本批不动**（收敛它们属另一个单元，避免把本批撑成重构）。
2. **扩展点**：`engine.ts` 的 `call()` —— 它是所有连接器读数的**唯一咽喉**，在这里取 `descriptor.connector` + `descriptor.id` + 实际请求 URL（经既有 `redactUrl` 脱敏）+ 响应体字节，算出指纹；**接线落在返回信封上**（不是模块里躺着）。
3. **判据（可写成断言）**：
   - 每条读数带 `{ service, tool, request, response: { sha256, bytes } }`；
   - 指纹可由**任何人离线复算**（给同一份响应字节，`sha256:v1:` 前缀后逐字符相同）；
   - 产物 ↔ 读数引用链**可遍历**（从产物版本能查到生成它的读数指纹）；
   - **缺指纹时明说没记**（沿用 `ReproducibilityGapReason` 的写法：具名 `not-recorded`，**不填 0、不填 unknown**）。
4. **预先声明的风险**：`call()` 是所有连接器的咽喉 ⇒ 改返回信封会撞**连接器目录的契约 pin 与各 descriptor 的用例**。动之前先数落点——用**本技能自带的** `find-contract-pins.sh`（在该技能的 `scripts/` 下，**仓库里没有这份脚本**，按仓库路径调用会立刻 `No such file or directory`）；形状选择要**可加不可改**（新增可选字段而非改既有语义），并把「无指纹」与「指纹为空」在类型上分开。
5. **不做**：不给没有读数的能力造指纹字段（沿用 G3 先例：为不存在的能力加 UI/字段不成立）；不碰 `src/main/connectors/descriptors/**` 与 `catalog.ts`/`registry.ts`（同批自主执行器正在那片在编）。
