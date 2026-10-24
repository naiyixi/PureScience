# 把会话的 MCP 传输切到 HTTP（14 个子进程 → 0）

> 目标单元，未开工。前置读数与结论见 `docs/bench-runs/2026-10-25-mcp-readiness-per-server.md`。
> 现状：`claude-code` 仍走 stdio，14 个能力各起一个 Electron-as-node 子进程。

## 为什么做

真机读数（安装版，load≈14）：

| 事实 | 数 |
|---|---|
| 单个子进程引导（Electron-as-node） | 123 ms |
| 单个子进程到模块就绪 | 305 ms（其中 ~180 ms 是 MCP SDK + 服务模块，压不动） |
| 14 个并发 burst（真实会话探针） | 中位 2,635 ms / 最大 2,729 ms |
| 代理侧就绪预算（我们自己 patch 的 `MCP_STARTUP_TIMEOUT_MS`） | 10,000 ms |

生产里一次会话有 **11/14 一起超时**，随后靠 `createSession` 重试掩盖。本机安静时仍有 3–4 倍余量，
说明超时发生在系统争抢/主进程忙碌时——**把 14 个子进程变成 0 个**才是根治。

## 已经就绪的部分（不要重做）

- `AgentMcpHttpHost`（`src/main/acp/mcp-http-host.ts`）已存在：token 鉴权、`/mcp/<kind>/<routingId>`
  路由、每请求构一个 stateless server + `StreamableHTTPServerTransport`。
- `runtime-composition.ts` 已无条件 `new AgentMcpHttpHost()` 并传给 capability owner。
- `resolveMcpTransport()`（`src/main/acp/mcp-transport-choice.ts`）+ 框架能力位 `acceptsHttpMcp?` 已落地：
  未声明 = 旧规则（http 只在吃不下 stdio 时用），所以现有四个框架行为一字未变。
- `claude-code.ts` 里的翻转注释已写明判据：**十类都接上之后再翻**。

## 缺什么（实测：切过去只有 count 4）

`buildHttpServers()` 只实现了四类：`artifact` / `notebook` / `skill-import` / `plan`。
宿主 `SERVER_KINDS` 同样只有这四个。其余**十类**需要接：

`memory`、`context-summary`、`routine`、`goal`、`endpoint`、`annotation`、`pdf`、`knowledge`、
`figure`、`query`（host-query）。

## 每类的接法（照既有先例，三步）

先例：`plan` 已经有 `createPlanMcpServerForEnvironment(environment)` —— 即「用环境直接造 server，
不绑定 stdio 传输」。其余九类目前只有 `run<X>McpServer(environment)`（内部造 handler 后接
`StdioServerTransport`），所以：

1. **模块侧**：把 `run<X>McpServer` 里造 handler 的那段抽成
   `create<X>McpServerForEnvironment(environment): ModelContextProtocolServer`，`run` 改为
   `await create...(env).connect(new StdioServerTransport())`。导出走文件末尾的 `export { }` 子句，
   **不要**再写 `export const`（本仓踩过重复导出的编译错）。
2. **宿主侧**（`mcp-http-host.ts`）：`SERVER_KINDS` 加 kind 字符串、`SessionEntry` 加字段、
   加 `register<X>(routingId, environment)`、`buildServer` 加一个分支返回
   `create<X>McpServerForEnvironment(entry.<x>)`。
3. **owner 侧**（`session-capability-owner.ts` 的 `buildHttpServers`）：照 artifact 那段抄 ——
   用已有的 `build<X>Environment(...)` 拿环境、`canPublishHttpRoute(request)` 成立才
   `host.register<X>(routingId, env)` 并 push `{ type:'http', name, url: host.urlFor(kind, routingId),
   headers:[authHeader] }`。

⚠️ 有两个能力不是「环境 → RPC」形状，接线前先读它们的 stdio run：
`query`（host-query）与 `figure` 的 handler 可能需要额外协作者（如数据库客户端 / 规则引擎）。
读到需要注入时，注入点放在 host 的构造参数里（`runtime-composition.ts` 已经在那儿），
**不要**让它们自己去 resolve。

## 验收判据（缺一不可）

1. 单测：`npx vitest run src/main/acp src/main/agent-framework`，并为 host 增加一条
   「十四类都注册后 `urlFor` 都能给出 URL、未知 kind 仍 404」的用例。
2. 真机（隔离实例，不需要模型）：
   `session capabilities built` 必须是 `transport:"http"` 且 **`count:14`**，
   `servers` 字段列出全部 14 个名字，且**日志里没有** `[mcp-readiness] Timed out`。
3. 就绪时间：同一会话的探针（`PURESCIENCE_MCP_READINESS_PROBE=1`）此时**没有 stdio 服务可测**，
   所以改用「会话建立到 `session capabilities built` 的墙钟」作为对照，并写明这是另一口径。
4. 真正调通工具（需要模型）：留到装机的发版验收里做一次真实工具调用（memory 存一条 / plan 读一次），
   未做之前不许写「已切换」。
5. 回退面：`acceptsHttpMcp` 拿掉即回到 stdio，一行；把这条写进提交信息。

## 风险

- 每请求造 server 意味着工具调用不再有子进程隔离：某个能力崩在宿主进程里会连带主进程。
  现状 stdio 模式下崩溃只死一个子进程。**这一点必须在提交信息里具名**，并考虑给 host 的
  `handleRequest` 加 per-request try/catch（已有）与错误隔离（现在会 `log.error` 后回 500，够用但要点名）。
- 十个能力里 `pdf` / `figure` / `query` 的参数校验分支最复杂，先做它们中的 `query` 作为探路，
  跑通再批量。
- 任何一类接错，症状是「该工具消失」而不是报错——所以验收第 2 条必须逐个点名 14 个 server 名。
