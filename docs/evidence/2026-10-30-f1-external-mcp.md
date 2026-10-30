# F1 真机读数：外部 MCP 客户端经 CLI 读本机（2026-10-30）

单元：F1「CLI 对外 MCP」第一片（只读）。施工单：`docs/plan-2026-10-30-f1-external-mcp.md`。
本档只记**本机实跑**的数字；没有跑到的项具名列出，不用推断补齐。

## 一 取证方式

- 认证用例：`e2e/certification/external-mcp-client.spec.ts`（新增）。它用**独立进程**跑真实 CLI
  （`node packages/purescience/cli.mjs mcp --config-root <隔离配置根>`），并以 SDK 的 **stdio 客户端**
  说 MCP —— 不是 mock 客户端，也不是在应用进程内直接调函数。
- 应用侧：e2e 夹具起的真 Electron 应用（隔离 `--user-data-dir` + 隔离配置根），先跑一个真回合
  （夹具 agent 的确定性回复），磁盘上因此真有一份会话文档。
- 前置：`npm run build:e2e`（e2e 读的是 e2e 产物）。
- 命令与读数：`npx playwright test e2e/certification/external-mcp-client.spec.ts --workers=1`
  → **1 passed (7.8s)**（同一天连跑两次都通过：先 1.2m 的双用例批里通过，再单独 7.8s 通过）。

## 二 盘上读法（本轮修掉的一处假红）

spec 起初自己拼读盘：`JSON.parse(doc).session.messages.length`。读数恒为 **0**，看起来像「回合没落盘」。
真因是**写侧不写扁平数组**：`createSessionFile` 在 `conversationGraph` 存在时无条件丢掉 `messages`
（注释写明「the reader rebuilds it」），文件里 `session` 的键是
`id/projectId/title/description/cwd/status/permissionProfile/…/conversationGraph/…`，**没有 `messages`**。
正解是不手搓读法，改用应用自己的读模型 `normalizeSessionFile()`（`src/shared/session-persistence.ts`），
它会把 graph 投影回 `messages`。修好后同一次改动即通过。

顺带一条实测时序：轮询的**第一次**扫盘读到 `messageCount: 1`（只有提问），几十毫秒后到 2 ⇒ 回复上屏早于
文档落盘，取数必须等，不能采一次。

## 三 读数（同一次运行，逐条）

| 判据 | 读数 |
| --- | --- |
| 监听 | `external MCP server started { transport: 'tcp', host: '127.0.0.1', port: 63607, tools: 4 }` ⇒ 只绑环回 |
| `tools/list` | `["list_project_files","list_projects","list_sessions","read_session"]`，与 `surface.ts` 登记表**逐条相同**（名字、`description`、`inputSchema` 三者都比） |
| `list_projects` | `{"count":1,"projects":[{"id":"cmvum8gy7…","name":"External MCP","description":""}]}` |
| `list_sessions` | 一条：`{"id":"e2e-session-1","projectId":"cmvum8gy7…","title":"First question","status":"idle","messageCount":2,"updatedAt":"2026-10-30T06:53:15.379Z"}` |
| `read_session` | `messageCount 2 / messagesReturned 2 / truncated false`；两条正文分别是 `First question` 与 `Deterministic reply: …`；id 与 projectId 与**盘上文档**逐字相同（读法见 §二） |
| `list_project_files` | `{"projectId":"cmvum8gy7…","count":0,"files":[]}`（本回合没产出文件 ⇒ 空表是实数，不是缺席） |
| 拒绝路径 | `read_session(sessionId: "no-such-session")` ⇒ `isError: true`，`{"error":{"code":"session-not-found","message":"No session has id \"no-such-session\". Call list_sessions for the ids this machine holds."}}` |
| 审计行 | 同一轮主日志 **5** 条 `external mcp call`，每条带 `toolCallId` / `tool` / `risk: 'read'` / `outcome` / `durationMs`：4 条 `ok`（`list_projects` 1 ms、`list_sessions` 2 ms、`read_session` 1 ms、`list_project_files` 2 ms），1 条 `refused` + `code: 'session-not-found'`（1 ms） |
| 客户端身份 | 5 条同一 `clientId`（`6c546d7f…`）= 一个外部进程一条租约；`toolCallId` 各不相同 ⇒ 事后能逐条配对 |
| 停止 | 退出时 `external MCP server stopped { transport: 'tcp', listening: false, port: 63607 }`，发现文件随之撤除 |

## 四 没做的（具名）

1. **写入类工具**：不在第一片。`dispatchToolCall` 对 `risk !== 'read'` 一律 fail-closed 拒
   （`permission-gate-not-wired`），所以「先有写工具再补门」这条路被关住了；写入要另开一片并逐条写提权论证。
2. **窗口内弹卡与 `permission decision` 行**：本轮所有工具都是只读，不经过权限门，因此 broker 那行本轮
   **不会**出现 —— 这不是缺陷，是这一片的边界；它要等第一个写入工具才有读数（届时判据是 broker 那行与
   本档的 `external mcp call` 共享同一个 `toolCallId`）。
3. **远端 profile 拒绝**：`external:*` 命令不进远端集，由契约目录与计数门钉住（单测层），本档未在真机上
   用远端 profile 复跑一次。
4. **打包态**：本轮读数取自 dev 构建（`build:e2e`）。打包产物的 CLI 是否带 `mcp` 动词，要等下一个版本装机后
   才验；本档不声称已验。
