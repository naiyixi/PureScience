# 外部客户端看进度与定时任务（MCP）

这两个工具走的是 `purescience mcp` 那条桥（需要 app 在跑），因为「现在有没有活儿在跑」「定时任务还活着吗」都是 app 的状态，不在文件里。

## 工具

| 工具               | 入参                                     | 返回                                                                                                                                                                                    |
| ------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_activity` | `project`、`limit?`（默认 25，上限 200） | `total`、`running`、`returned`、`truncated`、`sessions[{id, title, status, messageCount, updatedAt}]`，按最近更新排序                                                                   |
| `list_schedules`   | 无                                       | `total`、`enabled`、`paused`、`schedules[{id, sessionId, label, instruction, everyMinutes, enabled, nextDue, lastFireAt, lastOkAt, tickCount, missedTicks, pausedReason, lastResults}]` |

## 为什么值得单独有两个工具

- **沉默 ≠ 完成**。客户端轮询 `session_activity` 看 `running` 计数，而不是靠「没新消息就以为跑完了」。`running: 0` 是明确的「手上没有在跑的轮次」。
- **停掉的定时任务长得像空闲的定时任务**。`list_schedules` 把 `enabled`、`pausedReason`、`missedTicks`、`lastOkAt` 一起返回，所以「连续失败被自动暂停」和「本来就没到点」在数据上能分开。

## 状态取值

`session_activity` 的 `status` 是 app 自己会话列表里的那个状态，不额外加工：

| status    | 含义                   |
| --------- | ---------------------- |
| `running` | 有轮次在跑             |
| `idle`    | 空闲（上一轮正常收尾） |
| `error`   | 上一轮出错收尾         |

`list_schedules` 的 `pausedReason` 为 `null` 表示启用中；非空表示被暂停的原因（例如连续失败触发的自动暂停）。

## 边界（如实写）

- **`running` 需要在有可用模型凭证的实例上才看得到**。凭证不可用时轮次会在建连阶段直接落 `error`，客户端看到的是 `idle → error → idle`，看不到 `running` 这一刻。映射本身有单测（catalog 报 `running` → 工具如实上报 `running: 1`，且不混入别的项目）。
- 没有 `list_runs`：task run 的列表没有对外命令，新开通道会让启动清单认证失败，所以进度按**会话**粒度给，而不是按 run 粒度。
- 两个都是只读：没有「取消任务」「暂停定时任务」这类写工具。要停请用界面，或先做出一条能批的写路径再说。
