# F1 真机读数：外部 MCP 客户端的写入面与权限门（2026-10-31）

单元：F1 第二片（写入 + 权限门）。施工单：`docs/plan-2026-10-30-f1-external-mcp.md` §9。
第一片的只读读数在 `docs/evidence/2026-10-30-f1-external-mcp.md`。本档只记**本机实跑**的数字；
没跑到的项在 §四 具名列出，不用推断补齐。

## 一 取证方式

- 认证用例：`e2e/certification/external-mcp-client.spec.ts` 的第二支用例（新增）。外部客户端仍是
  **独立进程**里的真实 CLI + SDK stdio 客户端；应用仍是 e2e 夹具起的真 Electron 应用（隔离
  `--user-data-dir` + 隔离配置根）。
- 卡的答法用**产品自己的 CLI**：`purescience permissions` 列出待答卡，`purescience approve <id>
  --cancel` / `--option <optionId>` 作答 —— 这也是 headless 服务下唯一能点的那条路。
- **CLI 需要应用发布它在听哪里**（`web-service.json` + `web-token` 写在配置根；`purescience start`
  总会发布）。本轮 e2e 在重启时给了 `PURESCIENCE_WEB_PORT=0`（绑临时端口），因此这一条路是**真**跑通的，
  不是构造出来的：CLI 自己发现端口与令牌，没有把地址或凭据传给它。变量在重启返回后立刻删除。
- 重启后把目标会话在窗口里重新打开一次 —— 卡只对**当前正在看的会话**渲染（`session-permissions.ts`
  的行为），这也是 reader 真实的操作顺序。
- 前置：`npm run build:e2e`。命令：`npx playwright test e2e/certification/external-mcp-client.spec.ts
  --workers=1` → **2 passed (18.3s)**（用例 1 = 第一片只读 7.5s，用例 2 = 本片写入 10.1s）。

## 二 读数（同一次运行，逐条）

| 判据 | 读数 |
| --- | --- |
| `tools/list` | `["archive_session","list_project_files","list_projects","list_sessions","read_session"]` —— 五个，与 `surface.ts` 登记表逐条相同（名字、`description`、`inputSchema` 三者都比） |
| 卡（声明取消的那次） | `{"requestId":"64e2c1eb…","sessionId":"e2e-session-1","toolCallId":"833308df…","title":"An outside MCP client asks to archive “First question”","providerToolName":"PureScience","rawInput":{"sessionId":"e2e-session-1","projectId":"cmvvufpus0000jtoa0zhbtgg7","archived":true},"isMcp":true,"mcpIdentity":"purescience_external/archive_session","options":[{"optionId":"64e2c1eb…:approve","name":"Approve","kind":"allow_once","scope":"once"},{"optionId":"64e2c1eb…:decline","name":"Decline","kind":"reject_once"}]}` |
| 取消后的答复 | `{"error":{"code":"not-approved","message":"\"archive_session\" changes data, and the app's user did not approve this call. Nothing was changed."}}`（`isError: true`）；紧接着 `list_sessions` 里该会话**没有** `archived` 字段 ⇒ 数据一个字节没动 |
| 批准后的答复 | `{"sessionId":"e2e-session-1","projectId":"cmvvufpus0000jtoa0zhbtgg7","archived":true,"archivedAt":1793417440535}` |
| 写入效果可读回 | 同一客户端再调 `list_sessions`，该行出现 `archived`（ISO 串）⇒ 写作者自己看得见自己的写（没有这个字段，归档完再列表会**一模一样**） |
| broker 侧审计 | `permission decision { sessionId: 'e2e-session-1', toolCallId: '833308df…', decision: 'card', isMcp: true, rawInput: 'present', tool: 'purescience_external/archive_session' }` 与同形的第二条（`toolCallId: '0ff4608e…'`）—— **两条**，即每问一次一张卡，且判词是 `card`（外部客户端永远拿不到按 profile 自动放行） |
| 服务侧审计 | `external mcp call { toolCallId: '833308df…', tool: 'archive_session', ... risk: 'write', outcome: 'refused', code: 'not-approved', decision: 'declined', durationMs: 298 }` 与 `external mcp call { toolCallId: '0ff4608e…', tool: 'archive_session', ... risk: 'write', outcome: 'ok', decision: 'approved', durationMs: 264 }` |
| 两本账能配对 | 两条 `permission decision` 的 `toolCallId` 集合与两条 `external mcp call` 的 `toolCallId` 集合**逐个相同**（取消的那次是 `833308df…`，批准的那次是 `0ff4608e…`）—— 这是「事后能审」的机器判据 |
| 卡上写的是解析后的目标 | `rawInput` 带 `projectId`（`archive_session` 的入参只有 `sessionId`）：卡描述的是**将要发生的事**，不是客户端敲的那串字 |

## 三 为什么这些读数只有真机给得出

- 单测里的 `requestApproval` 是**桩**：它证明分支，不证明「外部进程的写会走到本应用真正的卡上、并由用户的
  答复决定是否发生」。本档的两列（取消 ⇒ 未发生，批准 ⇒ 发生且可读回）是同一份代码的两次真跑。
- 归档请求是 `sessions:update-archive`，要求 `{projectId, sessionId, archived, expectedArchivedAt}` 四件齐；
  目标行取自 `sessions:list-catalog`（本片规划档 §9.1 第 3 条的实测约束），本轮返回值与写入结果一致，
  没有出现「请求自己凑错」这一类失败。

## 四 没做的（具名）

1. **窗口内直接点卡**：本片用 CLI 作答（那也是 headless 唯一的路）。窗口里同一张卡渲染成 Approve/Decline
   两条按钮的读数本轮**没有取**；它在渲染层已有独立用例覆盖按钮语义，但「外部调用产生的卡在窗口里长什么样」
   仍属未取证。
2. **打包态**：读数取自 dev 构建（`build:e2e`）。打包产物是否带 `mcp` 动词与这套门，要等下一个版本装机后才验。
3. **第二件写**：本片只有「归档一个会话」这一件写。跑笔记本、派发回合、改产物各自需要一条提权论证，没有并进来。
4. **CLI 与窗口服务的耦合**：`purescience permissions` 依赖应用发布 `web-service.json`。纯窗口启动（没有
   `--serve` / `PURESCIENCE_WEB_PORT`）时不发布，CLI 报 `daemon_unavailable` —— 那时只能用窗口作答。
   这是设计使然，但它是外部模型第一次撞到时最可能读不懂的一处，已写进工具 `description` 与
   `packages/purescience/CLI.md`。
