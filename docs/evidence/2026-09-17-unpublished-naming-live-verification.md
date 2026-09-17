# 现场核验：26 条滞留产物版本被具名 `unpublished`（2026-09-17）

数据根：`~/.purescience-project/purescience.db`（真实 DB，3 个真实项目）
产物存储根：`~/PureScience-DEV`（**判字节必须在根上量**）
代码版本：`481f6d4`（含 `fe55071` 具名 + `23670a2` 具名跳过计数 + `481f6d4` 约束漂移修复）

## 一、核验过程中发现的真缺陷（当场修掉）

第一次触发启动协调时，**启动那一趟直接失败**（`startupCleanupEligible: true`，`reconcile-derived-state`，550ms，`errorCategory: 'object'`），日志只给了 `ambiguous-turn-message=4`、**没有任何具名**。

量出的原因：现场 DB 的约束还是旧的三值 ——

```
ArtifactVersion_state_check" CHECK ("state" IN ('staging', 'pending', 'finalized'))
```

而 `src/main/projects/sqlite-schema-migrations.ts` 的 `ensureSqliteCheckConstraints` **只在"约束名缺失"时重建表**：名字在、值集旧 ⇒ 永不重建 ⇒ 写入 `'unpublished'` 撞约束 ⇒ 整趟协调失败。

修复（`481f6d4`）：约束存在但**描述一个值集**（`IN (...)`）且**缺了任一已声明值** ⇒ 判为陈旧并重建；无值集的检查（如 `length("filename") > 0`）不动，避免每次打开都白重建。测试按**现场同一形状**构造（旧约束 + 一行数据），断言"修复前写入被拒、修复后写入通过"。

## 二、修复后的现场核验（同一台机、同一份真实数据）

```
=== BEFORE ===
finalized|445
pending|26

=== AFTER ===
finalized|445
unpublished|26          ← 26 条全部具名，pending 归零

约束（迁移已落到真实 DB）：
state" IN ('staging', 'pending', 'finalized', 'unpublished')

启动那一趟（startupCleanupEligible: true）：
  operation: 'session-hydration'
  phase: 'reconcile-derived-state'
  status: 'ready'
  sessionCount: 60
  warningCount: 0
  degradedReconciliationCount: 0
  unpublishedArtifactVersionCount: 26
  finalizationSkips: 'ambiguous-turn-message=4'
  outcome: 'completed'        ← 不再 failed
```

`finalizationSkips: 'ambiguous-turn-message=4'` = **4 个 run**（即那 26 条版本）被按设计拒绝猜测的原因：意图没指名终止消息。这是**诊断结论的现场复现**，不是推断。

## 三、承诺兑现：行与字节都保留

抽 3 条（跨 2 个项目、3 个 run）逐个到存储根上量：

```
0dd74a4d-…  ml_force_field_survey.md      artifact-run-1787073703757-2  present 12639 bytes
6214250f-…  mlff_ranked_table.csv        artifact-run-1787074124809-4  present 18016 bytes
fbba6586-…  module1-5_executive_report.md artifact-run-1788967918178-5  present 10419 bytes
```

具名**没有删行、没有删字节**，只是把"卡在 pending、界面上看不见"改成"如实标注为未发布、内容仍在磁盘"。

## 四、触发机制（记下来，省得下次又踩）

启动协调**不是应用一起来就自动跑**，它由**该进程首个"重"请求**触发：

- `purescience project list` / `artifacts list`（轻量读取）→ **不触发**（进程启动后先跑轻量读取，会消耗掉"首载即启动边界"的资格，重载随后只以非启动身份运行 ⇒ 不具名，只报计数）；
- `purescience run …`（真实回合，走 Task API 载入会话目录）→ **触发**，且这一趟带 `startupCleanupEligible: true`。

## 五、诚实边界

- 本次核验覆盖的是**数据层与启动协调**：DB 状态、约束、日志计数、磁盘字节。
- **界面呈现未在这次现场核验里复验**（"已生成但未发布"分区 + 9 语言文案由渲染层测试覆盖：`ProjectFilesView.test.tsx` + i18n 用例 119/119 绿），未在真机窗口里肉眼确认。
- 探针项目 `cmu4ymgsd0000wfzgg7g611tg`、`cmu4ytbgv0001wfzg1bjl62nl` 已删除，核验后 `REMAINING_PROBES` 为空。
