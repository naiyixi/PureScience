# app-owned 回合的 Prompt 锚点覆盖面审计（2026-11-10）

## 一 这份档回答什么

前两轮把「没有用户动作的回合」的产物归属修到两条路上（`c481d17d` 进程内继承、`fcc2bb4b` 投递回合从持久图取回）。
台账留下的下一格是：**跨重启后，除了投递以外的 app-owned 回合还有没有漏网的入口**。本档按代码把每个入口列全，
逐条判「它的锚点从哪来」，并把剩下那条真的取不到锚点的路径改成**具名失败**而不是静默失败。

## 二 入口清单（生产代码，`grep -rn "suppressUserMessage" src/ --include=*.ts`，排除测试）

| 入口 | 位置 | 锚点来源 | 重启后是否仍可用 |
| --- | --- | --- | --- |
| 后台投递回合 | `src/main/ipc.ts:1820` → `background-delivery/owner.ts:216` `promptAnchorFor` | 投递结果写入**之后**从会话图解析（`resolveInheritablePromptContext`） | ✅ 用持久图，不依赖进程内表 |
| 中断回合续跑 | `src/main/acp/interrupted-turn-continuation.ts:71` `resolveProvenanceContext` | 从 `session.conversationGraph` 取 `getActiveConversationContext(promptMessageId)` | ✅ 持久图；context-reset 时改挂目标 Runtime Segment |
| 筛选 / 受限推理 / 产物代码重建 / handoff 续写 / reviewer | `screening-model-runner.ts:220`、`restricted-inference-runner.ts:264`、`artifact-code-reconstruction-runner.ts:300`、`handoff-continuity-owner.ts:128`、reviewer 驱动 | 派发处继承本进程最近一条用户 Prompt（`runtime-coordinator.ts:714`） | ⚠️ 进程内；这些入口都由**正在进行的回合**触发，重启后不会自己发起 |
| 兜底 | `runtime-coordinator.ts:736` | 铸 `prompt-<uuid>`，每会话一条具名 `warn`（`consequence: 'prompt-not-owned'`） | 终态，且**已具名**——不属于「静默丢产物」 |

**判决**：`fcc2bb4b` 之后，重启后能自己发起的两条路径（投递、中断续跑）都从持久图取锚点；其余入口
要么在进程内（有表可用），要么落在具名兜底上。台账 §299 §四 ③ 那条「按即将使用的 Segment 取锚点」**不需要立**：
投递的锚点是在结果写入**之后**才解析的，写入本身会把新 Segment 开在该 Frame 末尾，因此解析到的 Segment 就是
下一条消息要落的那个；真正跨了 Segment 的情形（会话换了模型/框架）按产权证明的语义本来就**不该**被认领，
强行认领会把「证明」放宽成「猜」。

## 三 本轮的实改：无图会话的重启续跑改成具名失败

`resolveProvenanceContext` 在 `session.conversationGraph` 缺失时原来直接返回裸 `{ promptMessageId }`：
这个 id 在产权证明里永远找不到对应节点 ⇒ 产物以 `prompt-not-owned` 被**终态**拒，而日志里一行都没有。
对会话图之前的旧会话（重启后续跑一条中断回合）这是唯一可达的落点。

改法（`src/main/acp/interrupted-turn-continuation.ts`）：同一条分支上补一条 `warn`，带 `sessionId`、
`promptMessageId` 与 `consequence: 'prompt-not-owned'`。判据与投递侧一致——**自动失败必须与它响应的那条请求同级落日志**，
否则「没有图」与「图里没有这条 Prompt」在日志里同形。
行为不变（返回值一字未改）：这不是放宽证明，只是让拒绝可被读到。

## 四 用例

`src/main/acp/interrupted-turn-continuation.test.ts`（新建，2 例）：

1. 无图会话 → 续跑请求的 `provenanceContext` 仍是裸 id（**证明没有偷偷放宽**），且 `warn` 带上具名 `consequence`；
2. 有图会话 → 四条身份取自图中活跃 Branch / 最新 Segment，且**不**产生那条 warn（证明 warn 不是无条件打印）。

## 五 边界（不许读成更强）

- 本档是**代码审计 + 一条可观测性修复**，没有真机窗口读数：要证「界面上看到续跑回合的产物被定稿」需要一次
  隔离数据根的 Electron 回合，而本机 `vm_stat` 空闲页 7,703 × 16 KB ≈ 120 MB、swap 已用 7,568 / 9,216 MB，
  起窗会把机器拖进抖动。本格记**未取证**，取证配方与判据写在台账 §299 §四 ②。
- 进程内继承那条（`runtime-coordinator.ts:714`）仍不跨重启；本轮确认它的四个调用方都不会在重启后自己发起，
  所以没有把它改成异步持久图读取——那会让派发处多一次 DB 读并牵动组合根（连锁 3 文件 vs 1 文件），
  与 §298 的既有结论一致。
