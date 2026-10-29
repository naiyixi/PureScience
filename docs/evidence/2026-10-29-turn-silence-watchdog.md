# 回合静默看门狗：把「思考中永不结束」变成有界失败（2026-10-29）

## 0 修的是什么

事故形态（同日，见 `2026-10-29-incident-refusal-and-missing-turn-watchdog.md`）：
运行时接受了 prompt 之后一个事件都没有，会话停在 `running`，界面持续「思考中」15 分钟以上。

根因不是网络，也不是缺日志，而是**没有任何回合级的时间边界**：全仓 `turnTimeout / promptTimeout /
idleTimeout` 在 `src/main/acp` 与 `src/main/tasks` 下零命中。回合一旦派发，只等运行时给事件。

## 1 判据：事件级静默，不是请求级超时

| 形态                                       | 判定                                      |
| ------------------------------------------ | ----------------------------------------- |
| 长回合持续流式输出（思考、工具调用、文本） | **健康**，无论跑多久都不切断              |
| 运行时接受后**一个事件都没有**             | 挂起，停掉并说明原因                      |
| 用户主动取消                               | 走既有取消路径，看门狗不参与（已 disarm） |

阈值 **10 分钟**零事件。理由是实测量级：正常回合在秒级到分钟级有事件；10 分钟全静默在健康回合上未见。

## 2 实现

| 件                                                                               | 位置                                                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 看门狗（按 session 注册，时钟/定时器可注入，只触发一次，`silentForMs()` 供日志） | `src/main/acp/turn-silence-watchdog.ts`                                   |
| arm / disarm（回合边界，finally 里先 disarm 再进 finalizer）                     | `src/main/acp/prompt-turn-workflow.ts` 的 `executeTurn`                   |
| touch（每个入站 provider 通知重置计时，放在 projection 之前）                    | `src/main/acp/runtime-prompt-composition.ts` 的 `routeNotification`       |
| 具名中止（不标记为「用户取消」，而是失败 + 原因）                                | `AcpSessionInteractionOwner.abortActivePrompt(sessionId, reason)`（新增） |

停掉时用户看到的文本（经既有 finalizer 的失败路径）：

> The runtime accepted this prompt and then produced no events for 10 minutes, so the turn was stopped.
> The backend is likely hung — switch backend or send the request again.

日志行：`prompt turn went silent; stopping it { silentForMs, timeoutMs, ...diagnosticContext }`。

为什么 `abortActivePrompt` 单开一个方法而不是复用 `cancelPrompt`：后者会把这次交互标记为「用户取消」，
于是 finalizer 里「已取消 = 正常收尾」的分支会把一次挂起写成 cancelled —— 那是把缺陷伪装成用户操作。

## 3 验证

| 层                                                 | 结果                                                                                                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 看门狗用例（新增 `turn-silence-watchdog.test.ts`） | 5 例：满 10 分钟才触发且只触发一次；每次事件重置（连续 6 次 9 分钟间隔仍在跑）；已结束的回合永不触发；同 session 再 arm 替换上一轮；`silentForMs` 读数正确 |
| `src/main/acp` 全目录                              | 见提交时的套件读数（下面补）                                                                                                                               |
| `tsc -p tsconfig.node.json`                        | 见提交时读数                                                                                                                                               |

**未验证（如实记）**：10 分钟真机挂起路径**没有**做端到端复现。复现需要真让运行时沉默 10 分钟（codebuddy
是现成的挂起源），成本是 10 分钟机器时间；本轮只到「单测 + 接线 + 类型检查」。要在真机确认，做法是：
用隔离配置根把框架设成 codebuddy → 发一条 prompt → 观察到 10 分钟时出现 aborted + 上述文本，日志出现
`prompt turn went silent`。

## 4 边界

- 看门狗只覆盖「派发之后」。派发前卡住（准备阶段、权限等待）由既有交互取消计时器负责，两者边界不重叠：
  `waiting-permission` 期间用户没有回复不会被判为静默（该状态不进入本看门狗）。
- 看门狗不改变回合结果的语义：超时回合是 **failed**，不是 cancelled，因此「重试」按钮与错误展示沿用既有路径。
