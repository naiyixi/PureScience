# 后台复查「被拒后收手」的一次有界补救：问一次，把已经想出来的结论捞回来

日期：2026-10-23 · 单元：复查被权限闸门拒掉一次之后整轮作废（§两百一十六 §四 3 具名的下一单元）
· 提交范围：`src/main/reviewer/orchestrator.ts`（一次有界追问 + 失败消息分两态）＋ 两份用例

## 1 为什么要做这一刀

`docs/plan-2026-10-03-next-queue-and-round-convention.md` §两百一十六 已经把因果钉住了：后台复查请求一个
越权工具 → 权限闸门拒绝 → 模型收手结束本轮 → 那轮 `checks` 为空 → 复查行落 `lifecycle='error'`。
那一条修的只是「`think`（纯推理步骤）不该被当成越权」，`execute`（shell）**仍然按设计拒绝**，所以
「拒绝之后怎么收场」这件事一直悬着：整轮复查被丢弃，模型已经读过的冻结轮次、已经推理出的结论一个都没到读者手里。

本轮开工时把同一份真机日志（只读）重新聚了一遍，确认这条通道还在、且不是偶发：

| 读数 | 值 |
|---|---|
| 日志 | `~/Library/Logs/PureScience (DEV)/main.log`，**13,497** 条 |
| 窗口 | 2026-10-21T15:51:11Z → 2026-10-23T08:43:56Z |
| `review triggered` / `reviewer session started` | 103 / 102 |
| `review complete` | 87 |
| `review protocol incomplete`（error） | **15** |
| `rejecting non-reviewer tool requested by background reviewer` | **16**（`think` 9 / `execute` 7） |
| 追问行（`one follow-up sent`） | **0**（旧构建，本单元之前不存在这条路径） |

把 15 条作废按 `runId` 与拒绝行配对：**15/15** 在同一 `runId` 内**先有拒绝、后有作废**，间隔
min 0.2 s / **中位 0.4 s** / max 2.1 s。也就是说这不是「模型自己没话说」，而是**一次拒绝足以结束一轮复查**。

## 2 交付

| 位置 | 改动 |
|---|---|
| `src/main/reviewer/orchestrator.ts` | 新增 `driveReviewerWithFollowUp`：先照旧 `driveReviewerToStop`，**只有** `stopReason === 'end_turn'` 且此刻还没 `submit_findings` 时，才发**一次**追问并再驱动一轮；追问预算 = 常规预算 / 4（`REVIEWER_FOLLOW_UP_BUDGET_DIVISOR`），不重开全量预算 |
| 同上 | 追问文本 `EMPTY_TURN_FOLLOW_UP_PROMPT` 点名「被拒的调用不能重试、别重复」并把可用出路逐个写出（读冻结轮次/读产物/查执行日志/取外部来源），并要求「无法核验的条目记具名原因，而不是沉默收手」 |
| 同上 | `incompleteReviewMessage(rejectedToolCalls, nudged)` 分两态：追问过仍为空 ⇒「…and one follow-up turn produced none either」，让「问过一次还是没成」不再与「一次沉默」同形 |
| 同上 | 两条路径都接上：常规复查（`runReviewWithSession`）与修复回路里的定向重审（`runScopedReview`），后者同样把 `nudged` 写进 `scoped re-review protocol incomplete` 的日志与消息 |
| 同上 | 两条具名日志：`reviewer ended its turn without submit_findings; one follow-up sent`（带 `followUpBudget`）与 `reviewer follow-up finished`（带 `stopReason` / `submitted`） |
| `src/main/reviewer/orchestrator.test.ts` | 假 agent 增两个开关（`emitRejectedToolCallOnPrompt` / `simulateFindingsFromPrompt`），新增 2 条用例：① 第 1 轮被拒、第 2 轮提交 ⇒ `lifecycle='complete'`、`outcome='pass'`、`checks` 1 条、`errorMessage` 为空，且**只有 1 个 reviewer 会话**；② 两轮都沉默 ⇒ `lifecycle='error'` 且消息同时含「one follow-up turn produced none either」与「rejected by the permission gate」 |
| `src/main/reviewer/orchestrator-prompt-prefix.test.ts` | 三处 `promptSink.toHaveLength(1)` 按新契约改成 2，并**加**断言（只紧不放）：第 2 轮不含 rubric 前缀、带「ended without calling submit_findings」 |

## 3 真机读数顺手抓到的一条缺陷（已修）

dev 实例日志里出现两条这样的记录（2026-10-23T05:42:15Z / 06:00:03Z）：

```json
{"msg":"reviewer session stopped","data":{"reviewId":"…","stopReason":{"stopReason":"end_turn","nudged":false},"nudged":false}}
```

`stopReason` 被写成了**对象**，因为改动中途把 `driveReviewerWithFollowUp` 的返回值整体赋给了名为
`stopReason` 的变量。单测与 tsc 都不会报（结构上合法），只有真机日志读起来才知道这一行在撒谎。
已改为 `const drive = await …`，日志写 `drive.stopReason`。这两条也是**新代码确实在真机跑过**的读证：
两次常规复查照常 `nudged:false`、照常提交，没有被追问打扰。

## 4 门禁（全部实跑，取自最后一次改动之后）

| 环 | 读数 |
|---|---|
| `src/main/reviewer` | **26 files / 300 passed**，exit 0 |
| `src/main/reviewer` + `src/main/settings/claude-install.test.ts` | **27 files / 331 passed**，exit 0 |
| 双 typecheck（`--composite false`，堆 8192） | node **0**；web **0** |
| `eslint --no-cache`（本单元 3 文件） | **0 problems** |
| `prettier --check`（本单元 3 文件） | 全过 |
| 变异（把追问整段关掉：`driveReviewerToStop` 之后直接 return） | 新增 2 条**同时红**（`2 failed | 14 skipped`）；恢复后 26 files / 300 passed |

## 5 边界（不许读成更强）

1. **只对 `end_turn` 生效**：超时、更新上限、工具预算停这几种已经抛错走失败路径；**取消不追问**（不与被取消的调用争辩）。
2. **最多一次**，预算 = 常规的 1/4；不做循环、不做指数增长的重试。
3. **不改闸门规则**：`execute`/shell 仍拒；本单元只改「被拒之后怎么收场」。
4. **追问分支本身没有真机触发过**（它由模型行为触发，不能从界面点出来）：真机证据只到「新代码在两次正常复查里跑过、结局未被改变」。判据已埋好——下次出现「拒绝后收手」时日志应依次出现
   `reviewer ended its turn without submit_findings; one follow-up sent` 与 `reviewer follow-up finished`，
   再按这两行计数复核。
5. 无新的用户可见文案、无窗口读数 ⇒ 不占版本号。
