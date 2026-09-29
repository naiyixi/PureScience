# RO-Crate 1.1 导出：从本机真实产物到可互操作研究对象（2026-09-30）

对标审计四项缺口中的最后一项（前序三项：文献分诊、文档标注层、序列与结构工具）。目标不是"再写一个 JSON 导出"，而是让**别的工具能读懂**：`ro-crate-metadata.json` 按 RO-Crate 1.1 的必需实体与引用规则成形，且 crate 里每个内容文件都能回溯到应用自己那条不可变、带 sha256 的产物版本记录。

## 一、先探现状（不重造）

| 已有机制                                       | 位置                                                                                                                            | 本次如何复用                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 产物不可变版本 + 校验和 + 生成者/环境/输入证据 | `src/shared/artifact-provenance.ts:294`（`ArtifactVersionEvidence`）                                                            | crate 的唯一内容来源；`sha256`/`size_bytes`/`created_at`/`producer`/`environment`/`inputs` 逐字段映射 |
| 版本定位符（跨数据根迁移后仍可解析）           | `src/shared/artifact-provenance.ts:120`（`createArtifactVersionLocator`）                                                       | 直接写进 crate 的 `File.identifier` 与 `CreateAction.identifier`，**不新造身份编码**                  |
| 项目文件（上传/产物）投影，带 `checksum`       | `src/shared/project-files.ts:11`（`ProjectFileItem`）                                                                           | 第二个内容来源，同样要求记录过校验和                                                                  |
| 产物持久化落盘位置                             | `src/main/artifacts/storage-layout.ts:1`（`ARTIFACTS_DIR`/`SAFE_SEGMENT_PATTERN`）                                              | 读取器复用同一常量与同一段名校验规则                                                                  |
| 发布版本的 durable 布局                        | `src/main/artifacts/provenance-repository.ts:1937`起（`.provenance/<artifactId>/versions/<versionId>/{content,evidence.json}`） | 导出读取器的读法与之逐字对应；**留在 `.staging/versions/` 的未发布版本永不出现在 crate 里**           |
| 导出既有范式（目录+清单+逐条 sha256+notes）    | `src/main/session-package/export.ts:60`起                                                                                       | 复用"每个条目带 sha256、不完整要具名"的口径                                                           |

探明结论：**仓库里此前没有任何 ro-crate 实现**（`git grep -i ro.crate` 只命中 `CHANGELOG.md:69` 与本仓计划文档 `docs/plan-2026-09-29-sequence-structure-tools.md:39`，两者都只是把它列为待办）。因此本次是新建，但内容语义全部接在既有的「不可变版本 + sha256 + 生成方式」之上。

## 二、交付的文件

| 文件                                                | 作用                                                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/ro-crate.ts`                            | 纯函数：常量、从既有证据类型到 crate 记录的适配、`buildRoCrateMetadata`、`validateRoCrate`（30 条断言）、路径/`@id` 规范化 |
| `src/shared/ro-crate.test.ts`                       | 14 条构建/断言单元测试（含 9 条负例）                                                                                      |
| `src/main/ro-crate/export.ts`                       | 主进程导出器：读 durable provenance、逐字节复验、写 `ro-crate-metadata.json` + `files/**`、写完后自校验                    |
| `src/main/ro-crate/export-test-fixtures.ts`         | 按应用真实落盘格式造版本夹具（不是手搓对象图）                                                                             |
| `src/main/ro-crate/export.test.ts`                  | 8 条真文件系统测试：真导出、篡改拒收、`.staging` 不导出、缺 content、空项目、路径逃逸                                      |
| `src/main/ro-crate/evidence.capture.test.ts`        | 默认跳过的**真机取证**入口（读本机真实数据根，把结果写进 `docs/evidence/`）                                                |
| `src/shared/ro-crate-evidence.test.ts`              | 常驻断言测试：把已提交的 evidence 重新校验一遍（无网络、无真实数据根）                                                     |
| `docs/evidence/2026-09-30-ro-crate-metadata.json`   | 真机导出的 `ro-crate-metadata.json` 原件（15 个 File、43 个实体）                                                          |
| `docs/evidence/2026-09-30-ro-crate-validation.json` | 同一次导出的取证报告：文件清单（cratePath/会话/产物/版本/字节数/sha256）、跳过项、30 条断言逐条结果                        |

## 三、真机证据怎么来的

本机 dev 数据根 `~/PureScience-DEV` 下有一个真实项目（`cmt377xqh0000wfi5zv5w67mg`，4 个会话、15 个已发布产物版本），导出命令：

```bash
PURESCIENCE_RO_CRATE_EVIDENCE=1 \
PURESCIENCE_RO_CRATE_PROJECT=cmt377xqh0000wfi5zv5w67mg \
npx vitest run src/main/ro-crate/evidence.capture.test.ts
```

```
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  182ms
```

生成结果（`docs/evidence/2026-09-30-ro-crate-validation.json` 摘要，非编造，逐字段取自该次运行）：

- `source.storageRoot = ~/PureScience-DEV`，`publishedVersionCount = 15`
- `skipped = []`（没有任何版本因校验和不符/缺内容被拒）
- `validation = { ok: true, passed: 30, failed: 0 }`
- `@graph` 实体类型分布：`Dataset`×1、`File`×15、`CreateAction`×15、`SoftwareApplication`×5、`CreativeWork`×6、`Organization`×1

内容文件本身**没有提交**（那是研究数据），提交的是元数据 + 该次运行逐文件测得的 `sizeBytes`/`sha256` 与版本身份。

## 四、规格要求 → 哪条断言（逐条）

断言集在 `src/shared/ro-crate.ts` 的 `validateRoCrate`，分三级：`spec-must`（规格必需）、`spec-should`（规格建议）、`export-contract`（本导出自加的、比规格更严的溯源契约）。真机那次 30/30 全过。

| 断言 id                                   | 级别            | 对应规格要求（RO-Crate 1.1）                                                             |
| ----------------------------------------- | --------------- | ---------------------------------------------------------------------------------------- |
| `graph-flattened-entries`                 | spec-must       | §Structure：`@graph` 是扁平 JSON-LD，每个实体是可寻址对象                                |
| `no-duplicate-entity-ids`                 | spec-must       | §Contextual Entities：`@graph` **MUST NOT** 出现两个相同 `@id`                           |
| `context-references-ro-crate-profile`     | spec-should     | §Structure：`@context` SHOULD 以引用方式使用 `https://w3id.org/ro/crate/1.1/context`     |
| `metadata-file-descriptor-present`        | spec-must       | §Structure：有效图 MUST 描述 Metadata File Descriptor 与 Root Data Entity                |
| `metadata-descriptor-id`                  | spec-must       | §Root Data Entity：描述符 `@id` MUST 是 `ro-crate-metadata.json`                         |
| `metadata-descriptor-type`                | spec-must       | 同上：描述符 `@type` MUST 是 `CreativeWork`                                              |
| `metadata-descriptor-about-root`          | spec-must       | 同上：描述符 MUST 有 `about` 指向 Root Data Entity                                       |
| `metadata-descriptor-conforms-to-profile` | spec-should     | 同上：`conformsTo` SHOULD 是 `https://w3id.org/ro/crate/` 开头的版本化永久链接           |
| `root-data-entity-present`                | spec-must       | §Structure：有效图 MUST 描述 Root Data Entity                                            |
| `root-data-entity-is-dataset`             | spec-must       | §Root Data Entity：`@type` MUST 是 `Dataset`                                             |
| `root-data-entity-id-slashed`             | spec-must       | 同上：`@id` MUST 以 `/` 结尾（SHOULD 为 `./`）                                           |
| `root-date-published-iso8601`             | spec-must       | 同上：`datePublished` MUST 是 ISO 8601 字符串                                            |
| `root-name-and-description`               | spec-should     | 同上：`name`/`description` SHOULD 足以消歧                                               |
| `root-license-described`                  | spec-should     | 同上：`license` SHOULD 指向本文件内被描述的实体                                          |
| `file-entities-typed-file`                | spec-must       | §Data Entities：文件实体 MUST 以 `File` 作为 `@type` 值                                  |
| `files-linked-from-root`                  | spec-must       | 同上：数据实体 MUST 经 `hasPart`（直接或间接）从 Root Data Entity 链到                   |
| `data-entities-are-payload-or-web`        | spec-must       | 同上：数据实体 MUST 是 crate 根内的载荷或 Web 资源                                       |
| `file-content-size-and-format`            | spec-should     | 同上：`contentSize`/`encodingFormat` SHOULD 描述编码                                     |
| `references-resolve`                      | spec-should     | §Contextual Entities：被引用的实体 SHOULD 在同一元数据文件内被描述（**无悬挂引用**）     |
| `contextual-entities-linked`              | spec-should     | 同上：文件内的上下文实体 SHOULD 至少被另一个实体引用                                     |
| `create-action-complete`                  | spec-should     | §Provenance：CreateAction SHOULD 有 `name`，并把文件挂在 `result`、软件挂在 `instrument` |
| `software-application-named`              | spec-should     | 同上：创建文件的软件 SHOULD 是带 `version` 的 `SoftwareApplication`                      |
| `crate-describes-at-least-one-payload`    | export-contract | 本导出：crate 必须至少描述一个载荷、一个动作、一个软件                                   |
| `file-sha256-recorded`                    | export-contract | 本导出：每个 File 必须带 64 位十六进制 `sha256`                                          |
| `file-sha256-matches-copied-bytes`        | export-contract | 本导出：`sha256` 必须等于**落盘副本**重新哈希的结果                                      |
| `file-content-size-matches-copied-bytes`  | export-contract | 本导出：`contentSize` 必须等于落盘副本的真实字节数                                       |
| `every-payload-described`                 | export-contract | 本导出：crate 里不允许存在没有实体描述的副本                                             |
| `no-payload-without-action`               | export-contract | 本导出：每个 File 必须是一个 CreateAction 的 `result`                                    |
| `file-provenance-names-stored-version`    | export-contract | 本导出：动作必须写明来自哪条已存版本                                                     |
| `file-names-stored-version`               | export-contract | 本导出：File 自身的 `identifier` 必须写出版本定位符                                      |

## 五、可追溯性长什么样

真机 crate 里第一个文件的实体（原样摘录，未改一个字符）：

```json
{
  "@id": "files/ad_cure_conclusion_2026.md",
  "@type": "File",
  "name": "ad_cure_conclusion_2026.md",
  "identifier": "artifact-version:cmt377xqh0000wfi5zv5w67mg/c3fd83c6-760b-4e2a-b7c7-d1cd0a49db5a/e6b676ff-b631-4a38-b8b3-d7e10d56985c/e41d2512-3e5d-4bd8-a727-b49bd98d471e",
  "encodingFormat": "text/markdown",
  "contentSize": "4881",
  "sha256": "ca40d5a8287d4795f09eeb1bb26850640e4b6a4361c8fbad43baf73cb3e60811",
  "datePublished": "2026-08-21T17:09:29.870Z",
  "prov:wasGeneratedBy": { "@id": "#create-ad_cure_conclusion_2026.md" },
  "wasDerivedFrom": { "@id": "./" }
}
```

- `@id` 同时就是 crate 内路径 ⇒ 实体 id 与文件路径不可能漂移（断言 `entity-id`/`every-payload-described` 双向兜住）。
- `identifier` 是应用自己的版本定位符，指向 `~/PureScience-DEV/artifacts/<project>/<session>/.provenance/<artifact>/versions/<version>/content`；`sha256` 就是那条版本记录里的 `checksum`（由**副本字节**重算后比对，不是抄写）。
- `prov:wasGeneratedBy` → `CreateAction`（`instrument` = 应用 + 内核/agent，`result` = 该文件），用 `prov:` 前缀（1.1 上下文里已定义 `prov` = `http://www.w3.org/ns/prov#`）与规格自带的 `CreateAction` 口径表达生成方式。

## 六、必须说明的三处取舍（诚实项）

1. **`sha256` 在 1.1 上下文里不存在。** 1.1 的 JSON-LD 上下文没有 `sha256` 词项（RO-Crate 1.2/1.3 才把它映射到 `http://schema.org/sha256`）。因此本 crate 的 `@context` 是**数组**：第一项仍是以引用方式使用的 1.1 上下文，第二项把 `sha256` 声明为 1.2+ 采用的那个 IRI。断言 `context-references-ro-crate-profile` 只要求数组含 1.1 上下文 URI——严格校验器若要求 `@context` 恰为单一字符串，这一点会被判为偏差。
2. **没有 `Person` 实体。** 应用记录的是自动化执行者（`agent_name`），没有人类作者字段；把 agent 写成 `Person` 就是编造，所以它被建模为 `SoftwareApplication`。`buildRoCrateMetadata` 支持 `creators`（`Person`/`Organization`），真机那次只给了 `publisher`（`Organization`，取自 `package.json` 的 author）。
3. **内容文件未提交，且只做了一处文本脱敏。** 提交的是元数据与逐文件 sha256/字节数（真实测量值）；唯一的改动是把本机家目录（`/Users/<user>`）替换为 `~`——因为应用记录的 recipe 里含绝对路径。哈希、字节数、版本身份、时间戳一个字符未改，取舍后 crate 仍 30/30 通过（取证测试自己复验了这一点）。字节级断言（`file-sha256-matches-copied-bytes` 等）在常驻测试里改用取证报告记录的摘要复核，等于信任那次运行；要完全独立复核需重跑取证命令。

## 七、复现与门禁

```bash
# 1) 常驻（无网络、无真实数据根，CI 可跑）
npx vitest run src/shared/ro-crate.test.ts src/shared/ro-crate-evidence.test.ts src/main/ro-crate/export.test.ts

# 2) 重新取证（读本机真实数据根，覆写 docs/evidence 两个文件）
PURESCIENCE_RO_CRATE_EVIDENCE=1 PURESCIENCE_RO_CRATE_PROJECT=<projectId> \
  npx vitest run src/main/ro-crate/evidence.capture.test.ts
```

```bash
$ npx vitest run src/shared/ro-crate.test.ts src/shared/ro-crate-evidence.test.ts src/main/ro-crate/export.test.ts src/main/ro-crate/evidence.capture.test.ts
 Test Files  3 passed | 1 skipped (4)
      Tests  36 passed | 1 skipped (37)
```
