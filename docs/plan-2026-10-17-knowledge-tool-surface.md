# v2.6.0 A1-wire 其二：让 agent 真正能查知识库 —— 施工图（五处，缺一处即半截）

> 状态：**其一已上 main**（`e32a922b`：词法端口 + 模块工厂，`src/main/knowledge` 26 passed，含 4 例真实临时库端到端）。
> 本文只写"还差什么、照哪个模板写、哪里会被门禁挡住"，不重复其一。

## 为什么不是"加一个文件"

工具面对模型可见，靠的是一整套契约。以既有的 PDF 工具面为模板，一个 MCP 服务器由这五件事共同成立：

| # | 组成 | 模板位置（照抄） |
| --- | --- | --- |
| 1 | 主进程 RPC 通道 | `src/main/notebook/local-rpc-server.ts`：方法白名单（`'pdfFigures'` 在 306 行附近）+ 处理分支（`if (method === 'pdfFigures')` 在 1862 行附近） |
| 2 | stdio 服务器进程 | `src/main/settings/pdf-mcp-server.ts`：`server.registerTool(name, zodSchema, handler)`；handler 返回 `{ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }`，**不跑业务**，而是 `callXxxRpc(environment, '<channel>', payload)` 回主进程 |
| 3 | 进程入口分支 | `src/main/mcp-server-args.ts`（常量）+ `src/main/index.ts:67` 的 `process.argv.includes(<ARG>)` 分支；spawn 时注入 `ELECTRON_RUN_AS_NODE=1`、`PURESCIENCE_<X>_RPC_ENDPOINT/TOKEN/SESSION_ID/PROJECT_ID` |
| 4 | 应用自有服务闭集 | `src/main/agent-framework/app-mcp-names.ts:17` 的 `APP_MCP_SERVERS`（`canonicalName` / `openCodeName` / `tools[]` / `legacyNames?`）—— 名字**只用于身份**，框架会把 `-` 折成 `_`，所以一律用无连字符写法 |
| 5 | 身份与权限目录 | 与 4 成对的记忆权限目录（`PRE_REGISTERED_PERMISSION_IDENTITIES`），有 `contains the closed N-identity` 用例钉着总数 |

## 三个工具（名字与语义）

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `knowledge_search` | `{ text, limit? }` | 检索响应：`status`、`mode`（`lexical`/`hybrid`）、`degradation`（未配置 / 失败 / 空）、`coverage{indexed,pending}`、`results[]`（每行 `matchedBy`、`score`、`sha256`、`locator`） |
| `knowledge_register_source` | `{ kind: 'file'\|'folder'\|'url', path?/url? }` | 登记后的源列表（含 `fingerprint{value,bytes}`） |
| `knowledge_list_sources` | `{}` | `overview{ sources, unreadable }` |

工具描述里必须写清两件事，否则模型会误读：**`pending>0` 不等于"知识库里没有"**（那是"没看过"），**`lexical` 不等于"只做了字面匹配就够了"**（它同时说明语义源没接上或失败）。

## 施工顺序（一次做完再走闸）

1. `src/main/knowledge/knowledge-rpc.ts`：`createKnowledgeRpcModule({ root, roots, urlReader?, semantic?, verifier? })` → `{ search, registerSource, listSources }`，内部就是 `createKnowledgeModule` 的三个包装（不新增业务逻辑）。
2. `local-rpc-server.ts`：白名单 + 三个分支（`knowledgeSearch` / `knowledgeRegisterSource` / `knowledgeListSources`），参数校验与既有的 `pdf*` 分支同风格；**根的来源**沿用该服务器已有的 project 根解析，不要自己拼路径。
3. `src/main/knowledge/knowledge-mcp-server.ts`：照 `pdf-mcp-server.ts` 写工具注册 + `createKnowledgeMcpServerConfig`（env 前缀用 `PURESCIENCE_KNOWLEDGE_RPC_*`）。
4. `mcp-server-args.ts` + `index.ts`：加 `KNOWLEDGE_MCP_SERVER_ARG = '--purescience-knowledge-mcp'` 与分支。
5. `app-mcp-names.ts` + 身份目录：加
   `{ canonicalName: 'purescience_knowledge', openCodeName: 'purescience_knowledge', legacyNames: ['purescience-knowledge'], tools: ['knowledge_search', 'knowledge_register_source', 'knowledge_list_sources'] }`，并同步身份目录与计数。

## 会被哪些门禁挡住（提前知道就不必返工）

- **闭集计数**：`contains the closed N-identity v1 bootstrap inventory` 与「不得暴露 reviewer 内部工具」两条；改名/新增服务时只动常量值，别顺手扩大闭集。
- **契约面六张**（若同时开 IPC 给渲染层）：契约目录、preload、`web-api-map.generated.ts`、应用命令注册、运行时 DDL（若涉表）、各处计数（目录 / invoke / 参数形状 / 表面清单 / preload 请求数 / 应用命令本地与远端计数）。
- **推送闸**：`in_flight=0` 才推（在飞的是执行器的 Nightly 也要等）；闸跑全量期间**不要在同一工作树再提交**（vitest 收集是快照）；闸后新增的测试文件要自己补一次 `tsc`。
- **tsc 堆**：`tsc -p tsconfig.node.json` 默认 2 GB 会 Abort，用 `NODE_OPTIONS=--max-old-space-size=6144`。

## 验收（真机读数，缺一不算完成）

1. 在真实项目里登记一个文件 → `knowledge_search` 命中 → 返回行的 `sha256` 等于该行原文的 sha256（外部可复算）；
2. 停掉/不配语义源 → `mode: 'lexical'` + `degradation: 'semantic-source-unconfigured'`；配了但让它抛错 → `'semantic-source-failed'` 且仍有词法结果；
3. 登记一个不存在的路径 → 返回具名拒绝（`source-not-found`），不是空列表；
4. 模型真的一次调用（真机会话，不是单测）→ 工具出现在工具表里、被调用、结果进了对话。
