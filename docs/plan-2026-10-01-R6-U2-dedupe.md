# R6-U2 设计：内容寻址 + 硬链接去重（照着做即可）

依据：`docs/evidence/r6-storage-write-points.md`（写点与先例均已核实）。U2 是**实现片**，改存储层，
因此自带：跨卷回落、可中断、可回滚、可自证。**不做**：引用计数表（硬链接语义已保证存在性）。

## 1. 新模块（纯逻辑 + 真实文件操作，单测覆盖）

`src/main/storage/content-store.ts`

```
digestOfFile(path): Promise<string>            // 流式 sha256
installContent({ sourcePath, targetPath, sourceDigest? }): Promise<InstallOutcome>
  //  1) targetPath 已存在且摘要相同 → 'already-present'
  //  2) 库内已有同摘要内容       → link() 过去，'linked'
  //  3) 否则                     → copyFile() 过去，'copied'
  //  4) 跨卷 / 不支持硬链接（EXDEV / EPERM / ENOTSUP）→ 回落 copyFile，'copied-fallback'（必须显式上报，不得静默）
blobPathFor(storageRoot, digest)               // 摘要命名位置（不用存储根相对路径，避免与版本路径耦合）
```

`InstallOutcome` 是四态而非布尔：**"去重了" 与 "回落成复制" 必须能被区分**，否则空间报告会撒谎。

## 2. 写点接线（按风险从低到高）

| 序 | 写点 | 改动 | 为什么先做 |
|---|---|---|---|
| 1 | `src/main/uploads/storage-helpers.ts:107` `moveToUniqueUploadFile`（**已 link 优先**）与 `uploads/repository.ts:579`（仅 `preserveSource` 修复分支） | 发布不再需要改；改的是**"同一份内容第二次到达"**：入口处先 `digestOfFile`，命中库内同摘要 → 直接 `link` 到目标名（连暂存副本都不需要） | 改动面最小、语义最清晰：不改变已有链接行为，只把"同内容再来一份"从复制变成链接 |
| 2 | `src/main/artifacts/provenance-repository.ts:1559/1887` `copyFile(pendingFile.path, stagingContentPath)` | 同上；版本记录已有 `checksum` 字段语义，复用同一摘要口径 | 版本是不可变内容，天然适合内容寻址 |

**读路径不改**：所有读取方按路径读（`storageKey` 语义不变），因此去重对上层透明。

## 3. 一次性就地整理（可选、独立开关）

`src/main/storage/dedupe-sweep.ts`：扫描存储根下已知内容目录，按摘要把重复内容改为硬链接。
要求：可中断（分批）、先写清单再动、每批结束落一次进度、失败不删任何原始名字（只增链接再删重复名，
且删之前确认新名字可读且 inode 身份一致——复用 `hasSameFileIdentity`）。默认**不自动运行**。

## 4. 自证的空间报告

`spaceReport(storageRoot)`：按 inode 去重后累加 `st_size`（`nlink > 1` 只算一次），给出
`{ uniqueBytes, totalBytes, linkedFiles }`。验收即"整理前后各测一次"——数字必须来自真实磁盘，
不得由 `InstallOutcome` 计数推算。

## 5. 验收（真机）

1. 同一份文件上传两次 → 第二次 `InstallOutcome = 'linked'`，且两次落点的 inode 相同（`stat` 比对）；
2. 删除其中一个 → 另一个仍可读（内容不变），库内不出现悬挂；
3. 去重前后 `spaceReport` 的 `uniqueBytes` 差值 == 该文件大小（可复核的等式，不是估计）；
4. 模拟跨卷/不支持链接（临时目录）→ 结果是 `copied-fallback`，且如实上报"未去重"；
5. 旧数据（无摘要字段）读取不受影响。

## 5b. 端到端验收的可行路线（本轮探明）

- **HTTP 面不通**：`src/main/web-service/http-server.ts` 暴露 `/api/v1/...`（projects、sessions、readiness、
  runtimes、connectors、artifacts/replay、runs），**没有 uploads 路由** ⇒ headless 实例无法用脚本驱动上传。
- **可行路线（owner 层真流程）**：`src/main/uploads/repository.test.ts` 的夹具本身就是**真 sqlite + 真文件**
  （`createProjectDbClient` + `ensureProjectSchema`），因此可以在这个层面写"同一份内容走两次真实上传流程"的
  验收：断言最终落点是同一 inode、`.content/<摘要>` 存在、`measureSpace` 的数字与 `find` 实测一致。
- 更重的备选：驱动渲染器界面（真机窗口 + 文件选择）。代价高，仅在需要"用户视角"时做。

## 6. 回滚

U2 不删除任何既有名字；最坏情形是"去重没生效"（退化为原有复制行为）。就地整理片单独开关 + 进度落盘，
中断后可继续，不回退已有链接（链接本身不额外占空间）。
