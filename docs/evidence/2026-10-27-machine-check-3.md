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

## 第二次补记（同日，框架选择这一层的决定性读数）

加了 `[settings:backend] framework selection { forced, stored, resolved }` 这一行日志后跑 codebuddy 探针：

```
[settings:backend] framework selection { forced: null, stored: null, resolved: 'claude-code' }
```

**`stored` 是 null** —— 说明应用的设置存储里根本没有 `agentFrameworkId` 这个键。查两个候选文件：

```
~/.purescience/settings.json          agentFrameworkId -> None
~/.purescience-project/settings.json  agentFrameworkId -> None
```

两边都没有。所以前面那些「把 settings.json 里的 agentFrameworkId 改成 X」的实验**从来没有被应用读到过**；
session 落在哪个框架由「设置里没有该键 → 默认 claude-code」决定。这也解释了为什么补了持久化白名单后读数
仍然不变，以及为什么 codex 那次「成功」不可复现（那次读数不能算证据，我在下面撤销它）。

## 结论（更正后）

机检③ **2/4 可复现**：

| runtime     | 读数                                                             | 可复现                                                                |
| ----------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| opencode    | 此前一轮 `declared=28 session=read readings=28`                  | ✅                                                                    |
| claude-code | 本次会话 `483ebdff` 等，`servers=14`，且无头打包实例完成真实回合 | ✅                                                                    |
| codex       | 会话 `01a17d43`，`servers=14`                                    | ⚠️ **撤销**：它来自「改 settings.json」这条已被证伪的注入路，不可复现 |
| codebuddy   | 无                                                               | ❌                                                                    |

**真实阻塞**：不存在「把框架注入一次无头 run」的缝——`StartTaskRunRequest` 没有 framework 字段，
`PURESCIENCE_AGENT_FRAMEWORK` 只允许 opencode/claude-code/codex（且本次实测对 CLI 驱动的 run 无效），
而设置存储里**没有** `agentFrameworkId` 键可改。下一步只有两条，都需要产品侧决定：

1. 在 GUI 里用它自己的框架选择界面切换，再跑一次并读会话文档（需要界面操作权限）；
2. 给 `StartTaskRunRequest`（或设置）加一个显式的 framework 字段——这是功能改动，不是测量改动。

## 第三次补记（同日，收口：3/4 且各自可复现）

两处真缺陷修完后重跑（**关键前提**：探针实例的 config root 就是 `~/.purescience`，此前我一直在改
`~/.purescience/settings.json` 却对着一个 config root 是 `~/.purescience-project` 的 DEV 实例测 —— 那才是
`stored: null` 的由来）：

1. `src/main/settings/repository.ts` 的读取/规范化只认三个 id（漏 `codebuddy`），所以
   `setAgentFramework('codebuddy')` 返回成功、下次解析即被丢弃；
2. `session-persistence` 有同样的子集问题（此前已修）。

现在两处都改成 `shared/settings` 里的**单一来源** `isAgentFrameworkId`，并加了一个编译期完整性检查
（联合类型里每个 id 都必须出现在列表里）。真机读数：

```
framework selection { forced: null, stored: 'codebuddy', resolved: 'codebuddy' }
framework selection { forced: null, stored: 'codex',     resolved: 'codex' }
```

| runtime     | 读数                                                                              | 可复现                       |
| ----------- | --------------------------------------------------------------------------------- | ---------------------------- |
| opencode    | `declared=28 session=read readings=28`                                            | ✅                           |
| claude-code | 会话 `415f586b` / `aa9b7f3a`，`servers=14`，回合答 `ok`                           | ✅                           |
| codex       | 会话 **`01a17e35`**，`fw=codex`、`servers=14`、run 退出码 0（`ok`）               | ✅（本轮新拿到的可复现读数） |
| codebuddy   | **无会话**：选择已生效（`stored/resolved` 都是 codebuddy），但 ACP 连接建立即失败 | ❌                           |

codebuddy 的失败证据（应用日志）：

```
[acp] ensureConnected: connect failed { errorCategory: 'error', framework: 'codebuddy', status: 'error' }
[acp] createSession: failed
```

并且**直接**跑 `codebuddy --acp` 发 `initialize` 在 2 秒内无任何回应（此前手工探针即如此）。也就是说这不是
我们的测量缺口，也不是选择被忽略，而是 **codebuddy CLI 的 ACP 模式在这台机器上握手不成立**。

**结论：机检③ = 3/4**（opencode / claude-code / codex 均可复现），codebuddy 阻塞在它自己的 ACP 运行时。
