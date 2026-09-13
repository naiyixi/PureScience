# 交接单：自进化剩余三项（C4 → C1 → C3）

> 依据：`docs/update-plan-2026-09-12-dev-defects-and-self-evolution.md` §6（全部实测证据与结论）。
> 本单只写**可执行的下一步 + 验收口径 + 已知坑**；结论只认"实测 + 对照判据"，不接受类比与推断。
> 基线：`25e4aaa`（本轮最后提交）；本轮最后一个**代码**提交 `b2344f2`（技能信任徽标 + 9 语言 + 台账引擎）。

## 0. 通用纪律（全部来自本轮真实教训，违反过的都记在这里）

1. **先量后切**；**零样本就延后**，不造无法验证的解析器（→ 技能 `references/real-data-signal-checks.md`）。
2. **不许把"我不会取"写成"没有"**：动手前先核实字段名与口径（本轮 `contextUsage` vs `turnUsage` 就错了一次）。
3. **测试期望值一律用平台 API 生成**（`join`/`isAbsolute`/`homedir`），别写死 POSIX 字面量——Windows shard 才会暴露。
4. **绝不把脱敏输出回写文件**：`patch` 是模糊匹配，`Bearer ***` 会把真实值静默改写（→ `references/error-message-forensics.md`）。
5. **每步验收**：本地相关簇绿 + `lint`/`typecheck` 干净 → 实机或真实数据证据 → 推送后 **CI 双绿**（`python3 ci_watch.py <sha>`；`cancelled` = 被取代，不是红）。
6. **禁空壳**：面板/功能必须有真数据；无数据要**显式标注**，宁可不做也不做假的。
7. **自己的断言也要复验**：本轮我写过一条"main 本来就掌握技能名"，随后被自己的复核查否并公开更正。

## 1. C4 ✅ 已完成（2026-09-13，提交 `32424e6`）：工具定义的成本列

**结果**：产品侧仪表化已落地并实机验证——`AcpContextUsageBreakdown.sections`（可选、按 server 命名、上限 64、零值不计、消毒器收口）
随会话持久化。真实会话 `4fe38e37` 实测：`mcp = 3865` 聚合，6 节合计 **2253+626+354+349+283 = 3865（精确吻合）**；
改动前会话无 `sections`（即改造前后对比）。**判读**：应用自有 MCP 定义总 3865（notebook 2253 / 58%），
同会话 `other = 30,945`、`system = 4,583` → **大头不在 MCP 定义面，本项到此为止，不再造仪表化**。
预算守卫（选项 B）**仅部分覆盖**（只有 notebook 被钉在 ≤3,200 cl100k），已在文档如实标注。

以下为开工时的原始指令与已有实测，保留备查。

**已有实测（可直接引用）**

- 上下文中 `tools` 占 `used` 的 **≈62%**（59 会话：中位 **115,006**、最大 **818,272**；其余 other 43,721 / mcp 32,826 / system 4,042 / messages 2,962 / skills 53）。
- 使用侧（57 个有活动的会话，应用自有 MCP 调用数 / 出现会话数）：
  `notebook` 1873/55、`artifacts` 409/44、`figure` 99/36、`context-summary` 26/25、`host-query` 10/7、
  `plan` 45/**1**、`pdf` 14/**3**、`skills` 6/**3**、`endpoints` 3/**3**、`memory` 2/**2**、`annotations` 1/**1**。
- **成本侧缺**：应用不记录交给提供方的工具定义载荷；提供方只按 `tools` 一个合计上报。
  **两个替代品已否**（勿再尝试）：`registerTool(` 源码计数（漏循环/分段注册，notebook 只数到 1）、
  "仓库长字符串字节数"（把错误消息/类型/通道映射算入，榜首荒唐）。

**目标**：拿到 **per-server 定义尺寸**，与上面的使用数并列，才决定裁谁、裁多少。

**实现选项（A 产品侧 / B 测试侧，任选其一或都做）**

- **A（产品侧，能直接产出"改造前后对比"）**：在会话组装工具面处，按 server 序列化**自身定义载荷**（工具名 + description + inputSchema），
  把尺寸写进 `contextUsage.breakdown.categories`（与既有 `tools/mcp/system/messages/skills` 并列）。
- **B（测试侧预算守卫，防增长）**：对每个 `create<Name>McpServer(deps)` 构建 server，枚举其注册工具，
  序列化 `description + inputSchema` 求和并断言预算。**注意**：`notebook`/`artifacts` 依赖最重、需补夹件；
  **若只覆盖小 server，必须在结论里标注"部分覆盖"，不得宣称"成本已量清"**。

**验收**：①同一真实会话在改造前后的 `breakdown.tools` 数值对比；②预算测试钉住不再增长；③瘦身候选的取舍写明理由（低频≠无用）。

**禁止**：只测小 server 就下"裁谁"的结论；把源码计数/字节近似当成本列。

## 2. C1（第二）：让技能调用带上名字，排行才有数据

**已有实测**

- claude 路径：提供方原生 `Skill` 活动 **81 条**，**无 title、无 rawInput、无 locations、`toolKind:'other'`**；
  对照：其他工具（`Bash` 195、`Read` 192、`WebSearch` 190、`Edit` 312、`notebook_execute` 1001…）**都带** title + rawInput
  → 不是投影丢字段，而是**源头无名**。
- codex 路径**有** `CodexSkillActivityProjector`（`src/main/acp/codex-skill-activity.ts`）：按"指向 `<skillsRoot>/<name>/SKILL.md` 的单次 read"
  识别并改写为 `Loaded skill: <name>`；claude 侧无等价投影，且其事件连 locations 都没有。
- **台账引擎已就绪**：`src/shared/skill-usage.ts`（`skillUsagesFromActivities` / `summarizeSkillUsage`，4 条单测通过），拿到名字即可产出排行。
- 信任侧已交付：技能面板可见 `Unverified/Verified/Rejected` + 失败模式 + 悬停显示复现证据（提交 `b32f4ca`）。

**目标**：让"本轮用了哪个技能"落进可持久化的记录；随后台账立即有真数据。

**实现选项**

- **A ✅ spike 通过（2026-09-13，真实会话实测）——结论：走 A**

  **实测结果（会话 `e055db44-5247-4fcb-9e2a-195c94ac883e`，改动后构建）**：
  1. provisioning 落地：`settings.json` 出现 `hooks.PostToolUse = [{matcher:"Skill", hooks:[{type:"command",
     command:'node "…/claude/hooks/skill-usage-capture.cjs" || true'}]}]`；
  2. agent 真加载了技能（界面 `Loaded skill: mcp-genes`，296ms）；
  3. **采集到名字**：`{"toolName":"Skill","toolInput":{"skill":"mcp-genes"},"sessionId":"e055db44-…","cwd":"…/workspaces/ad6619d2-…"}`。
  4. **归属键现成**：`sessionId` = 应用会话 id（与持久化会话 `id` 一致），`cwd` 亦一致 → 不需要猜。
  5. **风险缓解被真机验证**：该回合正常完成，钩子运行未阻断工具调用。

  **另一处复核（重要）**：持久化的活动**仍然无名**（`providerToolName: 'Skill'`、`title: 'Tool activity'`，无 rawInput）——
  界面上的 `Loaded skill: mcp-genes` 不来自持久化活动。所以**采集文件是唯一名字来源**，C1 的消费端必须读它。

  **已落地（本片）**：`src/main/settings/skill-usage-hook.ts`（采集脚本由源码生成、写入 `<configDir>/hooks/`；
  settings 条目按"模块自有先剪除再重加"管理；命令带平台化成功守卫 `|| true` / `|| exit /b 0`）+
  `claude-config-provision.ts` 接线 + 测试（17 项：含**真实 node 执行**脚本，验证正常输入记一行、**垃圾输入仍 exit 0**）。

  **下一片（消费端，尚未落地——不得当成已完成）**：读采集 JSONL（需**有界**：按 sessionId 归属、按时间落轮次、上限/轮转）→
  产出排行数据 → 接既有台账/面板；历史 119 会话仍无名，必须显式标注。

  | 事实 | 出处 |
  |---|---|
  | 适配器把调用方 `options.hooks` 合并进 SDK 钩子 | `node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js:4040`（`...userProvidedOptions?.hooks`，`PostToolUse` 数组拼接） |
  | 适配器**官方文档**把 `hooks` 列为受支持透传项 | 同包 `dist/acp-agent.d.ts:409-426`：`hooks (merged with ACP's hooks)` |
  | 应用已持有该 options 通道 | `src/main/agent-framework/claude-code.ts:67-79`（`meta.claudeCode.options` ← `ctx.sessionOptions`） |
  | 应用还自持一份 Claude `settings.json` 路径 | `src/main/settings/backend-resolver.ts:886`（`settings: join(appConfigDir,'settings.json')`），目录来自 `agent-runtime-manager.ts:691` `getAppClaudeConfigDir(storageRoot)` |
  | 钩子事件与 JSON 形态在 SDK 类型中存在 | `@anthropic-ai/claude-agent-sdk/sdk.d.ts:809`（`HookCallbackMatcher`）、`:816`（`PostToolUse`）、`:4919+`（`{type:'command'}`）；`HookCallback.hooks` 本体是**进程内函数**，故**跨 ACP JSON 边界应走 `type:'command'` 的命令钩子或 settings.json**，不要试图传函数 |

  **拟实现（下一步）**：在应用自有的 claude 配置里加 `PostToolUse` matcher（目标工具 `Skill`），命令钩子把 stdin 的 `{tool_name, tool_input}` 追加写入项目侧 JSONL；
  应用读取该 JSONL，把 `tool_input` 里的技能名写进活动/轮次元数据 → `skillUsagesFromActivities`（`src/shared/skill-usage.ts`，已就绪）立即产出排行。

  **落点（已读代码确认）**：`src/main/settings/claude-config-provision.ts:62-101` 的 `writeAppSettings`——它**读取并合并**现有 `<configDir>/settings.json`
  （当前键：permissions/disableBundledSkills/availableModels/modelOverrides），并按"模块自有条目先剪除再重加"的方式管理 `permissions.deny`
  （`MANAGED_BUILTIN_TOOLS`）。新增 hooks 应**照抄这个模式**：模块自有、可剪除、不影响第三方条目。
  （该文件第 18 行注释提到"notebook audit hook"，但**仓库里没有对应实现或 spec**——`grep` 无命中，即**无先例可抄，这是第一处钩子**。）

  **spike 的现实约束（2026-09-13 实测）**：**裸 CLI 路线不可用**——`claude -p` 独立运行时未被登录（`Not logged in · Please run /login`），
  应用是在 spawn 时用 env 注入 provider 凭据（`buildProviderEnv`）。`executeClaudeProbe` 虽用应用凭据跑 claude，但参数在 manager 内写死（`['-p','ok']`），
  **不经 IPC 暴露自定义参数**，无法借它跑自定义 prompt。→ **验证只能走应用自身的 provisioning 路径（改代码 + 重建 DEV + 跑一次真实会话）**。

  **风险（必须在实现时处理）**：`PostToolUse` 钩子**失败会阻断工具调用**。因此采集脚本必须**任何情况下都 exit 0**、stdout 输出 `{}`，
  且**不得抛异常**（采集不到就静默放弃）；否则会把用户的正常工具调用弄坏。这也是本项需要拍板后再动的原因：**它落在 agent 的工具调用路径上**。

- **B（兜底，仍保留）**：若 spike 证明 `Skill` 的钩子输入里没有名字，则放弃 C1 排行，只保留信任侧（已在排期文档登记为可接受收口方式）。

**验收**：新会话出现带名的技能记录（如 `Loaded skill: <name>`）→ 用 `skillUsagesFromActivities` 派生非空 → 面板可点开看证据；
**历史 119 个会话仍无名，必须显式标注**（不得把新数据说成回溯覆盖）。本轮已复核：87 条原生 `Skill` 活动里 81 条确实无 `rawInput`/`title`，
另 6 条带载荷的是**应用自有 MCP 工具**（`mcp__purescience-skills__skill_list/skill_eval/create_skill`），**不是**原生 `Skill`，不改变结论。

**禁止**：建空面板；用"调用过技能"的次数冒充"用了哪个技能"；把函数型钩子塞进 JSON 边界。

## 3. C3（第三）：完整监督通道

**已有（B3 交付）**：策略内核 `shared/supervisor-signals.ts`（4 类信号 / 每类一次 / 超预算降级）、
台账进审计请求（`ReviewRunRequest.supervisor`）、审计员系统提示注入 `<supervisor_signals>`、修正轮继承、主日志留痕
（提交 `0321347`/`158f95c`/`f2e092a`；真实数据回放抓到并修掉"心跳快照被当作连续失败"的假阳性）。

**未做**：应用层 **steer / abort**；worker→supervisor 事件从事件流派生；具体框架接线。
**范围**：steer 复用 `sendPrompt` 的排队语义（当前轮先跑完）、abort 复用 `cancelPrompt`；先从事件流派生 worker 事件；先接 Claude Code + delegate worker。
**验收**：fixture 事件流确定性测试 + 实机长任务出现**带证据句柄**的 steer 且进追溯报告。
**禁止**：引入常驻第三个模型会话（PILOT 教训：只在难任务给信号，Easy 上受助 0.0%）。

**⚠️ 前置：实机验收通道——已勘明，且我先前的结论是错的（2026-09-13 更正）**

- **裸 RPC 通道实际可用**：`create-session → save-session → resume-session → send-prompt` **真的会跑一个真实 agent 回合**。
  证据：本轮探针的 prompt（要求"同一工具失败三次"）在日志里产生了
  `prompt start { textLength: 114 }` → **三次** `tool call failed { tool: 'purescience-notebook/notebook_bind_runtime' }` → `prompt stopped { end_turn }`。
- **我此前判定"未产出回合"是验证方法错误**：我按**会话文件**（`sessions/<pid>/<sid>.json`）找 agent 消息，
  而 **headless RPC 会话不经渲染端 store，故不落盘**（D10 的机制）。**正确证据源是主日志**（`~/purescience/logs/headless.out.log`）。
  教训：**"没找到"不等于"没发生"**——先确认证据源是否覆盖那条通路。
- **UI 通道：驱动配方已验证（2026-09-13）**

  ```text
  新项目 → 对话框 input[type=text] → 点「创建」
  → composer = div[role="textbox"][contenteditable=true]（aria-label「询问任何内容」）
  → 键入 → 按 Escape（关掉「↑↓ 历史」弹层；实测弹层元素 15 个）
  → 点 button[aria-label="发送消息"]
  ```

  **Escape 是关键步**：加上它之后日志出现 `prompt start { sessionId, textLength: 76 }` 等派发记录；
  不加它则**连续三次无派发**（输入框持有全文、发送按钮被点、但日志无 `prompt start`）——
  「有历史后 Enter 被弹层吞掉」的假设由此证实。
- **审计链路在真实 UI 会话里已跑通**：同一次会话日志出现
  `[reviewer:ipc] review triggered { sessionId: … }` → `[reviewer:orchestrator] runReview started { sessionId: … }`，
  即**渲染端 → main → reviewer 全链路可用**（B3 台账走的就是这条链）。
- **B3 仍缺的实机证据：只差"一个真正连败三次的回合"**。已尝试四次（同一条曾在线 RPC 通道上产生过 3 次失败的 prompt）：
  失败调用数分别是 **0 / 1 / 1 / 0**——两次 agent 直接作答未调用工具（回合 1 秒 `end_turn`），两次只失败 1 次（未按"即使失败也继续"执行）。
  → 无三次连败即无唤醒、**按设计静默**（`logSupervisorLedger` 仅在有唤醒/降级时记录）——**这不是缺陷，是策略要求未被满足**；
  **缺口性质已确定为"LLM 行为不稳定"，不是基础设施**。触发要点（下一轮可直接用）：让 agent **连续三次调用同一个失败工具**
  （如把运行时指定为不存在的路径），措辞需明确"每次都必须真的发出调用、即使失败也继续"。
- **审计链路实测（作用域正确，可作实机证据）**：最后一次会话 `d811e611` 按**条目块内匹配 sessionId** 计数得
  `myReviews=2`（`[reviewer:ipc] review triggered` + `[reviewer:orchestrator] runReview started`，同属该会话）
  → **渲染端 → main → reviewer 在真实 UI 会话中确证可用**；同次 `myFailures=0`、`ledgerLines=0`（无失败→无唤醒，符合设计）。
- **取证教训（本轮犯过两次，务必照做）**：按会话取证时，必须**把 sessionId 匹配在日志条目的块内**
  （多行条目的 id 在缩进行上），不能写"某 id 首次出现之后的所有行"——后者会把后续所有会话的行都算进来
  （本轮一度读出 `reviews=154` 这种明显失真的数）。

## 4. 现状锚点（开工前先核对）

- **运行中的应用**：`http://127.0.0.1:44100`（token 在 `~/.purescience-project/web-token`）；重启 = `pkill -f "electron-vite dev"` 后等 `/api/bootstrap` 返回 401。
- **可复用探针**：`docs/evidence/2026-09-13-skill-trust-gate-probe.py`（门控，11 断言）；`/tmp/d13_probe.py`（删除守卫）。
- **数据源**：会话记录 `~/.purescience-project/sessions/**/*.json`（`activities` / `messages[].turnUsage` / `contextUsage.breakdown`）；
  应用库 `~/.purescience-project/purescience.db`（`Review` / `Finding` / `NotificationInboxItem` / `Project`）。
- **技能引用**：`references/real-data-signal-checks.md`、`references/error-message-forensics.md`、`references/ci-watch-loop-and-lint-gates.md`、`references/web-rpc-api.md`。
