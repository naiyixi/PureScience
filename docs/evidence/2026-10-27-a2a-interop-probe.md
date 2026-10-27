# A2A 互通的实机检查：卡在、协议面不在

2026-10-27，对着**已认证的本机后端**（`purescience status` → PID/port 44100，`purescience url` 给出带 token 的
地址）做检查。这是「另一台机器上的实现能读这张卡并跑通 message/send」这一步能做到的最大程度。

## 1. 卡片能读，但它不是 A2A AgentCard

`GET /api/v1/agent-card?token=…` → 200，内容：

```json
{ "schema": …, "name": "PureScience (DEV)", "version": "2.18.3", "platform": …,
  "capabilities": [ … 15 项 … ],
  "interop": { "a2a": "unverified", "acp": "primary" } }
```

按 A2A 规范的 AgentCard 必备字段对照：

| 必备字段                                       | 本卡 | 说明                                                          |
| ---------------------------------------------- | ---- | ------------------------------------------------------------- |
| `name` / `version`                             | ✅   | 有                                                            |
| `description`                                  | ❌   | 无                                                            |
| **`url`**（对端要连的端点）                    | ❌   | 无 —— 对端读完卡也无处可发                                    |
| `protocolVersion` / `preferredTransport`       | ❌   | 无                                                            |
| `capabilities.streaming` / `pushNotifications` | ❌   | 本卡的 `capabilities` 是「能挂什么」的列表，不是 A2A 的能力位 |
| `defaultInputModes` / `defaultOutputModes`     | ❌   | 无                                                            |
| `skills[]`                                     | ❌   | 无                                                            |

也就是说：这是**PureScience 自己的能力声明**，不是可被 A2A 客户端直接消费的 AgentCard。

## 2. 没有 JSON-RPC 端点

对四处候选路径发 A2A 的 `message/send`（JSON-RPC 2.0）：

```
/             404
/a2a          404
/api/v1/a2a   404  {"error":{"code":"not_found","message":"Task API endpoint not found."}}
/message/send 404
```

代码侧一致：`src/main` 里只有注释提到 `message/send`，没有实现（`grep` 无路由）。

## 结论

`interop.a2a: 'unverified'` **是对的，而且必须保持**。把它改成 `verified` 不是跑一次测试的事，而是要先有：

1. 一份真正的 A2A AgentCard（含 `url` / `protocolVersion` / `preferredTransport` / `skills[]` / 输入输出模式）；
2. 一个 JSON-RPC 的 `message/send`（以及流式 `message/stream`）端点，并且它要通过既有的 token/配对授权；
3. 然后是「另一个实现读卡 → 发消息 → 收到任务状态」的往返测试。

这三条在这台机器上一条都不成立，所以这条排期**不是「差一次测试」，是「差一块功能」**（属 v2.19 的范围，
不在本轮的诊断/性能工作里）。
