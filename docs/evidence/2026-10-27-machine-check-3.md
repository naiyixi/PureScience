# 机检③：1/4 → 3/4（claude-code 与 codex 拿到读数，codebuddy 仍缺）

排期定义：「4 个 runtime 各 1 会话契约命中可查」。此前只有 opencode 通过，阻塞理由是「沙盒实例拿不到
钥匙串凭据（`Authentication required`）」。

## 方法（按排期单上的解封条件）

停掉 dev 无头与 GUI 实例，用**打包版**（`/Applications/PureScience.app`，2.18.4）+ **真实配置根**
（`~/.purescience`）起无头实例，token 取 `~/.purescience/web-token`（对 44511 实测 200），再用
`purescience run --port <port> --config-root <root>` 建会话。

## 读数

| runtime         | 会话                                | `agentFrameworkId`                                     | `sessionCapabilities.servers` | 回合                                          |
| --------------- | ----------------------------------- | ------------------------------------------------------ | ----------------------------- | --------------------------------------------- |
| opencode        | —                                   | （此前已通过，`declared=28 session=read readings=28`） | —                             | —                                             |
| **claude-code** | `483ebdff` / `41bb0b11` / `bf75ddd` | **claude-code**                                        | **14**                        | prompt 答出 `ok`，1–2 轮带 `turnUsage`        |
| **codex**       | `01a17d43`                          | **codex**                                              | **14**                        | prompt 答出 `ok`，1 轮带 `turnUsage`          |
| codebuddy       | **缺**                              | 会话被记成 `claude-code`                               | 14                            | prompt 答出 `ok`，但**不是 codebuddy 的会话** |

**旧阻塞已解除**：打包版无头实例能读到钥匙串凭据——claude-code 与 codex 都在无头实例里完成了真实回合，
不再出现 `Authentication required`。

## codebuddy 为什么还缺（如实记，不猜成因）

把 `settings.json` 的 `agentFrameworkId` 改成 `codebuddy` 后起实例、再 `purescience run`：命令返回 0、
打印 `Session created` 与 `ok`，但落盘的会话 `agentFrameworkId` 是 **claude-code**，且 `codebuddy` 的日志里
出现 `framework: 'claude-code'`。也就是说这次运行**静默用了默认框架**。

已排除的两条路：`StartTaskRunRequest` 没有 framework 字段（只有 project/prompt/sessionId/permissionProfile/
skillIds/modelId），`PURESCIENCE_AGENT_FRAMEWORK` 对 CLI 驱动的运行不生效（三次不同取值都产出 claude-code
会话）。**没有**继续断定具体成因（是选择被忽略、还是 codebuddy 不可用后回退），因为手上没有那条日志。

## 补记（同日，codebuddy 的根因缩小到一处并修了一半）

`session-persistence.ts` 的 `AGENT_FRAMEWORK_IDS` 是 `AgentFrameworkId` 联合类型的**子集**
（缺 `codebuddy`），于是 codebuddy 会话落盘时框架 id 被丢弃、读回成默认的 claude-code。已补上并加用例
（四值逐个 round-trip），会话可以正确记录了。

但补完之后**读数仍出 claude-code**：`purescience ready` 显示 `CodeBuddy 2.174.0 is ready`
（`/opt/homebrew/bin/codebuddy`），不是「运行时不可用」；而探针实例的日志里解析结果是
`framework: 'claude-code'`——也就是说设置里的 `agentFrameworkId=codebuddy` 在**解析阶段**就没被采纳。
这一步没有再往下断定（缺那条决策日志），如实留在这里。

## 结论

机检③ **3/4**（opencode、claude-code、codex），codebuddy 缺一次可归因的读数。下一步只有两条路：

1. 在 GUI 里把框架切成 codebuddy（有选择界面），再跑一次并读会话文档；
2. 给 `StartTaskRunRequest` 加 framework 字段（这是功能改动，不是测量改动）。
