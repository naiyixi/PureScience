# 事故与两个产品缺陷：codebuddy 拒绝 + 无回合看门狗（2026-10-29）

## 0 一句话

用户 12:00 起连发三次请求「没反应」、第四次出现「思考中」后 15 分钟无结果。
根因不是网络或模型：**应用当时被切到了 codebuddy 框架**（运行时立刻 `refusal` 拒绝，界面无任何提示；第四次则
prompt 已派发但运行时再无事件，且产品没有回合看门狗）。框架为何被切成 codebuddy —— 是我 01:15 跑 C1 真机探针时
写进了**真实配置根**，探针的持久化副作用没有被隔离。已修正并回滚。

## 1 证据链（全部来自本机日志/设置/会话文件）

| 时间（CST）                               | 事实                                                                                                                                                | 出处                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 01:17                                     | `~/.purescience/settings.json` 的 `agentFrameworkId` 被写成 `codebuddy`                                                                             | 文件 mtime + 内容；备份 `settings.json.bak-121836`                  |
| 11:57:12                                  | 应用启动时读取 `framework selection { stored: "codebuddy", resolved: … }`                                                                           | `~/Library/Logs/PureScience/main.log`                               |
| 12:00:25 / 12:01:03 / 12:01:26 / 12:01:47 | 四次 `prompt stopped`，`stopReason: "refusal"`                                                                                                      | 同上，`scope: acp`                                                  |
| 12:01:46                                  | `createSession … framework: "codebuddy" … connected`（会话本身是通的）                                                                              | 同上                                                                |
| 12:02:04                                  | `prompt start`，`textLength: 259`（第四次）—— 此后**无任何** acp 事件                                                                               | 同上，`scope: acp-prompt-turn-workflow`                             |
| 12:02–12:18                               | 只剩 `reviewer:ipc` / `ipc handler was slow` 的周期性告警，**没有**该回合的完成/失败                                                                | 同上                                                                |
| 12:18+                                    | 会话文件：`status: "running"`、`activeRun: { promptMessageId: message-1793246524665-5, startedAt: 1793246524665 }`、`agentFrameworkId: "codebuddy"` | `~/.purescience/sessions/cmvqz6o7h0000jtkkng66lo9z/66835d26-….json` |
| 12:19:33                                  | 回滚后重启：`framework selection { stored: "claude-code" }`                                                                                         | main.log                                                            |

## 2 缺陷一：运行时拒绝在界面上等于「没反应」

`stopReason: "refusal"` 只写进日志，没有成为一条用户可读的结果。三次请求在用户看来就是点了没动静 ——
而真相是运行时明确拒绝了。判据：任何 `prompt stopped` 都必须落成会话里可见的一条（含 stopReason 与框架名），
不允许只存在于日志。

## 3 缺陷二：没有回合看门狗（这是「思考中」永不结束的结构原因）

全仓搜 `turnTimeout` / `promptTimeout` / `idleTimeout` 在 `src/main/acp` 与 `src/main/tasks` 下**零命中**：
回合一旦派发，只等运行时给事件；运行时沉默就永远等下去。已发生的形态就是 15 分钟无事件、界面持续「思考中」。

修法（待实施，方案已定）：

- 在 ACP 事件入口（`agent-connection-adapter` 的会话更新出口）挂一个**静默计时器**：回合开始启动，
  每个入站事件重置；连续 **10 分钟**零事件即判定为挂起；
- 判定后走既有取消路径停掉该回合，把这条消息落成 `status: 'error'` 并附具名原因
  （「运行时 10 分钟没有任何事件」+ 框架名 + 最后事件类型），同时清 `activeRun`；
- 计时器阈值与时钟可注入，用例覆盖：正常事件重置、超时判定、判定后不再重复触发、用户主动取消时不触发。

> 注：重启后的恢复逻辑**已经是好的** —— `normalizeSessionAfterRestore` 会把 `running` 还原成
> `error` + `resumeRecovery`（`isSessionInterrupted` 覆盖 running）。所以「重启能恢复、运行中不能自救」
> 正是缺看门狗的表现，不必再改恢复路径。

## 4 已修的根因：探针污染真实配置

`scripts/probe-framework-binaries.sh` 会调用 `settings:set-agent-framework`，那是**持久化**写入。
初版直接指向 `~/.purescience`，于是跑完探针把用户正在用的应用切成了 codebuddy。

已改为**自带配置根**：`mktemp -d` 新建一个根，从真实根只**拷** `settings.json` 与 `web-token`，
`PURESCIENCE_CONFIG_ROOT`/`STORAGE_ROOT` 全部指向临时根，退出时删除。复跑验证：

```
probe_config_root=/var/folders/…/ps-probe-root-ZnD0Iq (真实根 /Users/totota/.purescience 只读)
claude-code … path=/opt/homebrew/bin/claude
opencode    … path=/opt/homebrew/bin/opencode
codex       found=False path=None      ← 隔离根下确实没有托管 adapter，如实缺席而非借用别人的路径
codebuddy   … path=/Users/totota/.local/bin/codebuddy
resolved=3 distinct_paths=3  ok
真实设置 agentFrameworkId = claude-code（未被改动）
```

判据也随之改成两条硬条件：任两框架不得共用同一路径；`distinct_paths == resolved`；`resolved >= 3`。

## 5 现状与待办

- 应用已恢复 `claude-code` 并在 12:19:33 重新启动；那个挂起的会话按既有恢复逻辑会显示为「中断，可重试」。
- 待办 1（缺陷一）：`refusal` 落成可见结果。
- 待办 2（缺陷二）：回合看门狗（10 分钟零事件）。
- 待办 3：`codebuddy` 为什么拒绝 —— 只知道它连上并建了会话（`framework: codebuddy … connected`），
  随后 `stopReason: refusal`；没有更细的原因记录。要定位得在 ACP 层把拒绝的原始原因（含运行时文本）落一条日志，
  这属于待办 1 的同一处改动。
