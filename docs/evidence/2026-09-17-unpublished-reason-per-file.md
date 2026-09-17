# 未发布原因：从"两句一起说"到逐条具名并回填（2026-09-17）

## 一、做了什么

1. **持久化原因**：`ArtifactVersion.stateReason`（**增量加列** `ALTER TABLE … ADD COLUMN "stateReason" TEXT`，既有库保留全部行；Prisma 模型同步 + `prisma generate`）。
2. **写入**：启动协调具名时**按 run 分组**写入两种原因之一：
   - `no-publication-intent` —— 该次运行结束时**没有写下发布意图**；
   - `ambiguous-turn-message` —— 意图在，但那个回合**无法归属到单独一条回复**，发布环节**拒绝猜**。
3. **读取**：`listUnpublishedProjectVersions` 把原因带到文件项（`ArtifactFile.publicationReason`）。
4. **界面**：文件视图「已生成但未发布」**逐条**显示该文件的原因，**9 语言**各两条新文案；**没有原因的行只显示分区总说明**——"原因缺失"**不**被渲染成两种原因之一。
5. **回填**：列存在之前已具名的行没有原因。启动协调（**只在启动**，活进程不碰）按**同一判据**补齐：有发布意图 marker ⇒ `ambiguous-turn-message`；完全没有 ⇒ `no-publication-intent`。

## 二、真机核验（真实数据根、真实 DB）

```
触发前： (null) | 26
触发后： ambiguous-turn-message | 26

抽样：
  ml_force_field_survey.md        artifact-run-1787073703757-2  ambiguous-turn-message
  mlff_ranked_table.csv           artifact-run-1787074124809-4  ambiguous-turn-message
  module1-5_executive_report.md   artifact-run-1788967918178-5  ambiguous-turn-message
```

26 条**全部**得到 `ambiguous-turn-message`，与早前实测一致（26/26 都有发布意图 marker ⇒ 属于"意图在、但回合无法归属"那一类，而不是"从未写下意图"）。回填是**按证据**做的，不是猜：判据与具名本身用的判据相同。

## 三、测试

- `provenance-repository.test.ts`：新增用例 —— 两行已具名的版本（一行**留有意图**、一行**没有**），活进程 pass **不动它们**、启动 pass 分别填上两种原因；全文件 **37/37 绿**。
- `ProjectFilesView.test.tsx`：两种原因**各渲染自己的句子**、且**不出现**另一句；文件视图 + i18n 合批 **120/120 绿**。
- `artifacts + projects + 文件视图 + i18n` 全量 **434 passed**；`typecheck:node`/`typecheck:web`/eslint 清白。

## 四、过程中两处必须说清的

- **`internal_error` 是瞬时故障**：核验时触发用的那次 `run` 返回 `{"code":"internal_error"}`，日志显示冷启动后首次回合的 MCP `purescience-artifacts` 服务 "Connection closed" + `createSession: failed`。**同一项目重试立即成功**（`completed`，输出"收到。"）⇒ 判为冷启动首次回合的瞬时故障，**不是**本次列改动引起；已如实记在这里，不当作"通过"糊过去。
- **回填只发生在启动**：活进程内不动任何行（与具名同一门控）。这是刻意的——在跑的回合可能稍后才写下意图。

## 五、提交

`b87391c`（原因持久化 + 逐条 UI + 9 语言）· `fe0cd48`（启动回填 + 测试）。
