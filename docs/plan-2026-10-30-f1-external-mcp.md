# 施工单：F1 — CLI 对外 MCP（走同一权限门 + 审计）

> 2026-10-30 由自主执行器（cron `2be4405e5dc6`）开工前勘察后写成。所有 file:line 与数字都是本机当下实测，
> 施工时**重读一遍**（并行执行器一直在加通道，计数会漂）。
> 队列出处：`docs/plan-2026-10-28-two-releases.md` §四 F1 —— 「应用内 14 工具；CLI 无 ⇒ 外部客户端调用在
> `permission decision` 留痕」。

## 0 一句话目标

外部 MCP 客户端（Claude Desktop 一类）配置一条 `purescience` 命令，就能调用本应用的能力；**每一次调用都过应用
自己的权限门，并在主日志里留下 `permission decision` 行**——而不是绕开权限、以「人」的身份直接改数据。

## 1 缺口证据（已证，不要重查）

| 证据 | 读数 |
| --- | --- |
| `packages/purescience/cli.mjs:981-989` | 动词只有 `init / doctor / start / stop / status / url / rollback-to-0.7.3` + 任务族（`project/session/package/artifacts/run/permissions/approve/...`）——**没有 `mcp`** |
| `src/main/mcp-server-args.ts` + 各 `*-mcp-server.ts` | 现有的 stdio MCP 服务器**全部由 agent 框架 spawn**，身份靠 argv 分支 + 进程内注入的 env（`PURESCIENCE_REVIEWER_MCP_SOCKET_PATH`/`..._TOKEN`，见 `src/main/reviewer/mcp-stdio-proxy.ts:31-32,46-47`）⇒ 外部客户端**拿不到**这套 env，也就接不进来 |
| `src/main/caller-context.ts:47-72,76-88` | 主体只有三种形状：Electron/Web 都是 `principalKind: 'human'`（Web 的 `?? 'human'` 在 69 行），headless 任务是 `'automation'`（82 行）—— **没有「外部 MCP 客户端」这一主体**，所以今天的 CLI/Web 通道**不经过**权限门；另注意 `canSatisfyHumanApproval`（91 行起）会把 human 当成「能替人批」，新主体绝不能落进这里 |
| `src/main/acp/permission-broker.ts:369-382` | 审计的正本在这里：`recordPermissionDecision()` 打 `permission decision`（第 375 行），字段 `decision ∈ {automatic, remembered-grant, session-grant, card}` + `isMcp` + `tool` 身份；**这就是验收要的那一行**，不要新造第二套词表 |

⇒ 缺口不是「没有 MCP 协议实现」，而是**没有一条给外部客户端用的、受权限门约束的入口**。

## 2 可复用的三块（别重写协议）

1. **传输**：`src/main/local-rpc-transport.ts` —— 环回 TCP（Windows 用命名管道）、`listenForLocalRpc` /
   `fetchOverSocket` / `fetchLocalRpc`，已带日志字段 `localRpcServerLogFields`。
2. **stdio 形制**：`src/main/reviewer/mcp-stdio-proxy.ts` —— 一个 60 行的「stdio ↔ 环回 HTTP」代理：下游
   `Server` + `ListToolsRequestSchema` / `CallToolRequestSchema` 直接转发到另一侧的 `Client`。F1 的 stdio 侧就是这个形状。
3. **审计**：`recordPermissionDecision()`（上面 §1 那一行）。**复用**，不要新建 `external call` 之类的第二种痕迹。

## 3 设计选择（为什么不直接把 Web RPC 转给外部客户端）

- **否决方案 B（CLI 直接把 web RPC 暴露成 MCP）**：`createWebCallerContext` 把调用者当 `human`，于是**任何**
  外部客户端都能不经权限门改数据。这与 F1 的目标句（「走同一权限门」）直接矛盾，且事后无法用日志证明「是谁批准的」。
  代价看起来最小（只改 CLI），但它把产品最核心的一条不变量撤掉了。
- **采用方案 A（新主体 `external-mcp` + 复用 broker 门）**：
  - `caller-context.ts` 加一个主体 `'external-mcp'`，`isHumanPrincipal()` 对它是 false ⇒ 既有的
    「只有 human 可直接放行」判断天然把它挡住（先读该函数的全部消费方，别让新值落进「可用/可采纳」的分支）；
  - 外部调用命中需要授权的工具时，走 **同一个** `AcpPermissionRequest` 路径：应用在跑 ⇒ 窗口弹卡；
    应用无窗（headless）⇒ CLI `permissions` 列卡、`approve` 批（这两个动词**已存在**，`cli.mjs:846-860`）；
    无人应答 ⇒ 既有 fail-closed 自动拒绝，并落 `decision` 行；
  - 拒绝句要带「这个动作会做什么」（沿用 broker 的写法），不返回空成功。

## 4 任务面（第一片只放**只读**工具）

第一片只暴露只读、可解释的工具（会话列表/读会话、产物列表/读、能力面 `capabilities`、`permissions` 只读视图）。
**写入类（notebook 执行、产物写、会话改）不在第一片**：它们的拒绝语义要逐条论证（见技能里那三条「提权论证」），
留到第二片，且在施工单里先写清「谁批准的、批准了什么」。

## 5 施工顺序（六步，缺一步就是半截）

1. `src/main/external-mcp/` 新模块：`surface.ts`（工具登记表 = 纯数据：`{id, description, input, returns, risk}`）
   + `server.ts`（`listenForLocalRpc` 起环回服务，bearer token 校验收口）。
2. **权限门接线**：命中 `risk !== 'read'` 的调用 → 构造 `AcpPermissionRequest`（`isMcp: true`、`mcpIdentity` 用
   `purescience_external/<tool>`），走 broker；**门在动作之前**（不是动作之后补记）。
3. **审计**：broker 已有的 `recordPermissionDecision` 直接生效；另在 `external-mcp` 自己那层打一行
   `external mcp call`（`tool`、`decision`、`durationMs`），两行**共享同一个 `toolCallId`**，否则事后配不上对。
4. **token 与发现**：外部客户端启动的是 CLI 进程，拿不到应用注入的 env ⇒ token 从配置根的 `web-token` 读
   （与 CLI 现有 `client.mjs` 同一来源），端点从 CLI 已有的 `url` 解析；**只认真环回地址**，不接受环境变量指定的远端。
5. **CLI 动词**：`purescience mcp`（stdio，长期驻留）；`--help` 列出它会暴露哪些工具与各自风险等级。
   三种退出码：正常 0 / 应用未运行 3 / 配置缺 token 4（具名，不与「工具被拒」混淆）。
6. **计数与目录**：这是**新开一条对外通道**，按技能 `references/contract-surfaces.md` B 节五处 + B2 十二面逐条勾；
   契约目录里 `external:*` 一律 `LOCAL`/`rejecting-stub`（远端面必须拒），并同步
   `LOCAL_WEB_COMMAND_COUNT`（当下 **373**）/ `REMOTE_WEB_COMMAND_COUNT`（当下 **238**）与各处 pin。

## 6 验收（真机，不许用 mock 客户端代替）

1. **真外部客户端**：写一个独立 Node 进程用 `@modelcontextprotocol/sdk` 的 stdio client 连 `purescience mcp`，
   `listTools` 拿到的工具数与登记表逐条相同；调一个只读工具拿到真数据（会话 id 与磁盘上的一致）。
2. **审计留痕**：同一调用之后，主日志里出现 `permission decision` 行，`tool` 身份是外部那一支，
   `decision` 是四值之一（不是自造的第五值）。
3. **拒绝路径**：对需要授权的工具，无人应答时必须以具名拒绝结束，且**日志里有那一行**；
   CLI `permissions` 能看到该卡、`approve --cancel` 能拒掉。
4. **远端面**：远端 profile 调同一条命令 → 拒（计数里属 rejected 集）。
5. 读数（工具数 / 耗时 / decision 分布）落 `docs/evidence/<日期>-f1-external-mcp.md`。

## 7 边界（不许读成更强）

- 第一片**只读**；写入类要另开一片并逐条写提权论证。
- 不新增第二套审计词表；`permission decision` 是唯一正本。
- 不把 token 写进任何日志或命令输出；不接受远端地址。
- 占用的不是版本号本身 —— F1 属 v2.21.0 范围项，落地后计入该版 CHANGELOG。

## 8 下一轮第一步

按 §5 第 1 步建 `surface.ts`（纯数据 + 一条「登记表里每个工具都在 server 侧有处理器」的成对用例），
再按 §5 第 5 步把 CLI 动词接上（先只做 `listTools` + 一个只读工具），拿 §6 第 1 条的真客户端读数；
权限门（§5 第 2 步）在读数之后再接，这样每一步都有可交付的观察面。

## 9 第二片（写入 + 权限门）的施工判据 —— 2026-10-31 勘察，**未开工**

> 结论先说：第二片不是「照 §5 第 2 步接一条门」那么小。本轮（cron 执行器 05:0x–07:0x）把它勘察到
> **可直接照着写**的程度就收手，没有留下半截代码（工作树里那两份在制件属并行会话，未碰）。
> 下面每一条都带 file:line，动手前重读一遍即可。

### 9.1 四条实测约束（决定形状，不是喜好）

| # | 约束 | 读数 |
| --- | --- | --- |
| 1 | **卡的可见性按当前会话过滤** | `src/renderer/src/pages/workspace/session-permissions.ts:5-11` 只保留 `request.sessionId === activeSessionId` ⇒ 把外部调用的卡挂在用户没在看的会话上，卡永远不出现（死控件）。无窗口时靠 CLI：`packages/purescience/cli.mjs:862-876` 的 `permissions` / `approve --option|--cancel` |
| 2 | **`acp:send-prompt` 不能当第一件写** | `src/main/acp/prompt-turn-workflow.ts:166-168` 要求会话已附着；force-load 只在 skill reload 分支（:196-210）⇒ 外部客户端对没打开的会话发提示必然失败 |
| 3 | **`sessions:update-archive` 的请求要自己凑齐** | 形状 `{projectId, sessionId, archived, expectedArchivedAt}`（`src/shared/session-persistence.ts:2058-2063`）。**不要**用 `read-document` + `save-session` 走整份文档往返：投影丢掉 `activities`/`conversationGraph`，回写会损坏文档。正解是从 `sessions:list-catalog` 的行取（`SessionCatalogSummary` 用 `...rest` 投影，带 `projectId` 与 `archivedAt`，`src/shared/session-catalog-summary.ts:20-46`） |
| 4 | **审计行已经存在，别造第二套** | `enqueuePermissionRequest` 无条件 `recordPermissionDecision(request, 'card')`（`src/main/acp/permission-broker.ts:1120-1132`）⇒ 只要 request 带 `isMcp: true` + `mcpIdentity`，`permission decision` 行与 `tool` 字段自动出现（`isMcp`/`tool` 的落点见 :369-382） |

### 9.2 接线路径（`startExternalMcpServer` 拿不到 ACP 运行时）

组合根 `src/main/index.ts:610-613` 调用 `startExternalMcpServer({ commands, configRoot })`，那里**没有** runtime。
端口要从组合对象透出：`dependencies.acp.runtime` 就是 coordinator（`src/main/ipc.ts:4002` 的 `acp: { runtime, … }`），
而 `AcpApplicationCommandRuntime` 是 coordinator 的 `Pick<>`（`src/main/acp/application-commands.ts:132-147`）
⇒ 把 `requestAppApproval` 加进这个 Pick，组合里 expose 一个 `externalApproval`，index.ts 传进去。
**不要**在 index.ts 里另开一条直达 broker 的路（那就是第二套审批语义）。

### 9.3 九处改动清单（缺一处＝半截）

1. `src/main/external-mcp/surface.ts`：`ExternalMcpToolRisk = 'read' | 'write'`；新增 `archive_session{sessionId}`
   （risk `write`，command `sessions:update-archive`）；`EXTERNAL_MCP_COMMAND_COUNT` 4→5（`application-command-composition.ts:405` 的清点会挡住漏改）。
2. `src/main/external-mcp/server.ts`：`options.requestApproval` 端口；`risk === 'write'` 时**先过门再 invoke**
   （现有 `externalMcpRiskGate` 的 fail-closed 分支就是给它留的位置，:218-234）；拒绝码具名
   `not-approved` / `approval-unavailable`，句子要说清「会做什么、什么都没改」；`external mcp call` 行加 `decision`，
   与 broker 那行**共享同一个 `toolCallId`**（否则事后配不上对）。
3. `src/main/acp/permission-broker.ts`：`requestAppApproval` 增加可选 `external?: { tool: string; toolCallId: string }`
   ⇒ 设 `isMcp: true`、`mcpIdentity: 'purescience_external/<tool>'`、`toolCallId`。**必须走 `requestAppApproval`**
   （永远一张卡），**不走** `requestPermission` —— 后者按会话 profile 自动放行，等于把外部客户端塞进 agent 的自动批准。
4. `src/main/acp/runtime.ts:1169-1176` + `src/main/acp/permission-context.ts:573-580` + `src/main/acp/runtime-coordinator.ts:766-773`：三处签名同步透传。
5. `src/main/application-command-composition.ts`：`AcpApplicationCommandRuntime` 的 Pick 加 `requestAppApproval`；
   组合对象 expose `externalApproval`；`ApplicationCommandComposition` 类型加该字段（:112-120）。
6. `src/main/ipc.ts`：`applicationCommands: Pick<…>` 白名单（:526 附近）加 `externalApproval`。
7. `src/main/index.ts`：`startExternalMcpServer({ commands, configRoot, requestApproval: applicationCommands.externalApproval })`。
8. 用例：`surface.test.ts` 登记表↔白名单成对（含新增工具的 risk）；`server.test.ts` 三条——无端口 ⇒ `approval-unavailable`
   且**没有 invoke**；端口答拒 ⇒ `not-approved` 且**没有 invoke**；端口答批 ⇒ invoke 一次、返回体是真结果；
   `permission-broker.test.ts` 一条——外部身份的 request 走进 `permission decision`（`isMcp: true` + `tool`）。
9. `e2e/certification/external-mcp-client.spec.ts` 追加：`archive_session` → `node packages/purescience/cli.mjs permissions --config-root <root>`
   看到那张卡 → `approve <requestId> --option <optionId>` → 工具返回、`list_sessions` 不再列出该会话、
   主日志出现 `permission decision`（`isMcp` 真、`tool`=`purescience_external/archive_session`、`toolCallId` 与
   `external mcp call` 同一）；再走一次 `approve <requestId> --cancel` ⇒ 具名拒绝、会话仍在。

### 9.4 要写进证据档的限制（不许读成更强）

- 卡的落点是**目标会话**：会话必须在窗口里打开（或 headless 下用 CLI 批）；目标会话未附着 ⇒ `approval-unavailable`
  具名拒且不动数据。这是 fail-closed 不是缺陷，但**必须**同时写进工具 `description` 与 `packages/purescience/CLI.md`，
  否则外部模型的第一次调用就会撞上一个它读不懂的失败。
- 第一件写只到「归档一个会话」；写入类的其余动作（跑笔记本、派发回合、改产物）各自要一条提权论证，不并进这一片。
