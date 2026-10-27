# A2A 互通：先证明它做不到，再把它做出来，最后用独立客户端验通

2026-10-27。这条排期分三步走完：**实测缺口 → 实现最小面 → 独立实现跑通**。

## 一、实测缺口（实现之前）

对着已认证的本机后端（`purescience url` 给带 token 的地址）：

- `GET /api/v1/agent-card` → 200，但它**不是 A2A AgentCard**：缺 `url`、`protocolVersion`、
  `preferredTransport`、`skills[]`、`defaultInputModes`/`defaultOutputModes`；
- A2A 的 `message/send`（JSON-RPC）在 `/`、`/a2a`、`/api/v1/a2a`、`/message/send` 四处 **全 404**，
  代码里只有注释没有路由。

所以当时 `interop.a2a: 'unverified'` 是**真话**，而且这条排期不是「差一次测试」而是「差一块功能」。

## 二、实现的最小面

- `src/main/web-service/a2a.ts`：
  - `buildA2AAgentCard()` —— A2A 形态的卡（`protocolVersion 0.2.3`、`url`、`preferredTransport: JSONRPC`、
    `capabilities{streaming:false, pushNotifications:false}`、`defaultInputModes/OutputModes`、
    把构建能力投影成 `skills[]`）；
  - `handleA2ARequest()` —— `message/send`（阻塞式，超时答 `working`）与 `tasks/get`；
  - 刻意**没有**实现 `message/stream`、`tasks/cancel`、push：卡里就写 `false`，让客户端能看出来而不是猜。
- 路由挂在 `/.well-known/agent-card.json`（GET）与 `/a2a`（POST），与其它端点共用同一个 token 闸门
  —— 未认证的对端连卡都读不到，这是有意的：给已配对的对端用，不是给公网。
- 不猜项目：消息里没有 `metadata.project` 时，只有「实例恰好只有一个项目」才用它，否则返回具名
  `-32602` 说明需要 `message.metadata.project`。
- 只有 `completed` 的 run 才带 artifact —— `working` 期间不把半截文本当结果发出去。

## 三、独立客户端跑通（这就是「另一个实现」）

`/tmp/a2a-client.mjs`：**另一个进程**，只用 `fetch` + JSON-RPC，不 import 本仓任何代码。

```
card.status=200 protocolVersion=0.2.3 url=http://127.0.0.1:44541
card.skills=15
card.streaming=false
task.id=c462c661-9320-4876-ba0c-306e01a30fd6 state=completed elapsedMs=29847
task.artifact.text="ok"
ROUNDTRIP OK
```

即：读卡（必备字段齐全）→ 发 `message/send` → 收到 `completed` 的 task 与文本 artifact。
**因此 `interop.a2a` 由 `unverified` 改为 `verified`**；`agent-card-route.test.ts` 现在会去读这份文件，
声明与读数必须同时存在，否则测试不放过。

## 仍未做（照实写明）

- `message/stream`（流式）、`tasks/cancel`、push notifications：卡里写 `false`，不是「支持」；
- 多项目实例必须显式给 `metadata.project`，没有「猜一个」的默认；
- 卡与 `/a2a` 都要 token：真正的跨机互通要先做配对授权，本次验证用的是本机 token。
