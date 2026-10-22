# 后台复查会话：把「想一下」当成越权工具拒掉，整轮复查就没了

日期：2026-10-23 · 单元：复查会话权限策略的一条错误拒绝 · 提交范围：`src/main/acp/reviewer-session-owner.ts`
（判定抽成纯函数 + 新增一条 `think` 规则 + 拒绝行补 `toolKind`）+ 一套 18 条的判定用例

## 1 为什么会去看这条通道

上一轮把 `notebook:state` 的 1.2 秒切成三段后，结论是「这段代码自己的活只占几十毫秒，绝大多数时间不是它在跑」。
按纪律，下一刀不该再在 notebook 里找，而要从**真机日志里谁在占主线程/谁在挡路**取数。于是把两份真机日志按
`level/scope/msg` 聚合了一遍（只读），本机两份现役日志分别是：

| 日志 | 记录数 | 分布 | 窗口 |
|---|---|---|---|
| `~/Library/Logs/PureScience/main.log`（打包版 **v2.15.3**） | 2,927 | 全部 `warn`，且**全部**是 `event loop stalled` | 2026-10-23 当天 |
| `~/Library/Logs/PureScience (DEV)/main.log`（dev 实例） | 11,039 | info 9,321 / warn 1,649 / error 61 / debug 8 | 2026-10-21 16:09 → 10-22 20:01 UTC |

打包版那一份先排除掉一条**已知**结论：它没有 `lateMs` 字段 ⇒ 跑的是 §两百零三 修复**之前**的代码
（修复提交 `0e6d47cf` 落在 `v2.15.3` 那个发布提交 `6f03a1a4` 之后 23 分钟）⇒ 那 2,927 条是旧构建的洪水，
不是新缺陷、也不该再修一遍。（顺带一条可核对的账：13,424 条停滞记录里 `cpu-bound-in-process` 6,708 /
`process-not-scheduled` 6,716，刚好一半一半。）

DEV 那一份才有产品行为。按条数排下来，第二条就是本单元：

| 条数 | level | scope | msg |
|---|---|---|---|
| 428 | warn | application-commands | application command handler was slow |
| 399 | warn | diagnostics | event loop stalled |
| **289** | warn | acp | **OpenCode permission context wait timed out** |
| 110 | warn | acp | agent stderr |
| 102 | warn | ipc | ipc handler was slow |
| **16** | warn | acp | **rejecting non-reviewer tool requested by background reviewer** |
| **15** | **error** | reviewer:orchestrator | **review protocol incomplete** |

## 2 读数：16 次拒绝，15 次整轮复查作废，且是**逐条对得上**的

`rejecting non-reviewer tool requested by background reviewer` 一共 16 条，`tool` 字段只有两个值：
`think` 9 条、`execute` 7 条。

把 `review protocol incomplete`（error，正文是「Reviewer stopped without calling submit_findings; N tool
call(s) were also rejected by the permission gate」）与拒绝行按时间配对：

```
incomplete events with a preceding rejection within 10s: 15 / 15
  04:33:21 incomplete ← rejection at 04:33:20 kind=think   Δ=1.68s
  05:18:16 incomplete ← rejection at 05:18:15 kind=think   Δ=0.52s
  05:20:23 incomplete ← rejection at 05:20:23 kind=execute Δ=0.36s
  05:26:21 incomplete ← rejection at 05:26:20 kind=execute Δ=0.41s
  08:03:31 incomplete ← rejection at 08:03:31 kind=think   Δ=0.45s
  08:34:54 incomplete ← rejection at 08:34:54 kind=execute Δ=0.67s
  16:35:36 incomplete ← rejection at 16:35:34 kind=execute Δ=2.12s
  16:56:20 incomplete ← rejection at 16:56:20 kind=execute Δ=0.20s
  16:59:22 incomplete ← rejection at 16:59:22 kind=think   Δ=0.18s
  17:23:49 incomplete ← rejection at 17:23:48 kind=think   Δ=0.43s
  17:25:42 incomplete ← rejection at 17:25:41 kind=think   Δ=0.23s
  19:45:02 incomplete ← rejection at 19:45:02 kind=execute Δ=0.44s
  19:47:58 incomplete ← rejection at 19:47:57 kind=think   Δ=0.33s
  19:52:29 incomplete ← rejection at 19:52:29 kind=think   Δ=0.35s
  20:01:39 incomplete ← rejection at 20:01:39 kind=execute Δ=0.24s

rejections NOT followed by an incomplete event within 10s: 0
```

**两个方向都闭合**：每一轮「没有提交 findings」前面 2.1 秒内都有一次拒绝；每一次拒绝后面都跟着一轮作废。
这不是相关，是一次**一条链**：复查会话要用的原生工具被判越权 → 拒绝 → 这个 harness 就此收手 → 那轮的
`checks` 一条都没有，复查行落成 `lifecycle='error'`。

## 3 为什么 `think` 这一半不该拒

ACP 的 `ToolKind` 枚举里有 `think`，语义是**模型自己的推理步骤**：没有文件系统、没有网络、没有进程能力。
它不读用户数据，也不改任何东西 —— 拒绝它保护不了任何东西，代价却是读者那一轮的复查整个没了。

`execute` 是另一件事（那是 shell），必须继续拒；`read`（读文件）、`fetch`（出网）同理。
所以修法不是「把原生工具都放行」，而是**只给这一个 kind 开口**：

- 新增 `REVIEWER_PURE_REASONING_TOOL_KINDS = new Set(['think'])`，且**只在**判定为「不是复查自己的 MCP 工具」
  之后才看它（复查 MCP 工具优先，走原来那条带作用域检查的分支）；
- 命中时走 allow（优先 `allow_once`，与原来同一取法），并打**自己的一句** info：`approving reviewer reasoning
  step` / `rule: 'reviewer-pure-reasoning-step'` —— 它不是 scope-bounded 的批准，混进原来那句会让读数谎称
  发生过一次作用域内批准；
- **没有 allow 选项就 cancel**（fail-closed），不猜一个选项。

## 4 交付

| 位置 | 改动 |
|---|---|
| `src/main/acp/reviewer-session-owner.ts` | 判定抽成两个纯函数：`classifyReviewerToolCall`（三态：`reviewer-mcp` / `pure-reasoning` / `foreign`）与 `decideReviewerPermission`（`allow` 带 rule / `reject` 带选项 / `cancel`），外加 `permissionDecisionResponse` 把判定映射成 ACP 响应。`resolvePermission` 只剩「取上下文 → 判定 → 记日志/计数 → 响应」这四步，原来的身份识别逻辑**逐字搬进**纯函数，行为对 `reviewer-mcp` 与 `foreign` 不变 |
| 同上，拒绝行 | 补 `toolKind`。原来的 `tool: toolName ?? kind` 有两种含义（工具名 / ACP kind）而日志里看不出是哪一种，`think` 恰好两者都可能（OpenCode 有一个叫 think 的工具，ACP 也有一个 think 的 kind）—— 这正是下一段「边界」要盯的那一格 |
| `src/main/acp/reviewer-session-owner.permission-decision.test.ts`（新） | 18 条：三条身份识别路径（opencode 标题 / claude `_meta` / codex 标题）、`think` → `pure-reasoning`、**七种其它 kind 逐个仍 foreign**（`execute`/`read`/`fetch`/`edit`/`search`/`switch_mode`/`other`）、MCP 分支优先于 kind、两个 MCP 服务时不认、无 allow 选项即 cancel、响应映射三种形态 |

## 5 门禁（全部实跑，取自最后一次改动之后）

| 环 | 读数 |
|---|---|
| 新增用例 | **1 file / 18 passed** |
| `src/main/acp` 全簇 | **89 files / 1,445 passed**，exit 0（77.5 s） |
| `src/main/reviewer` 全簇 | **26 files / 298 passed**，exit 0（54.9 s） |
| `tsc --noEmit -p tsconfig.node.json --composite false` | **exit 0** |
| `tsc --noEmit -p tsconfig.web.json --composite false` | **exit 0** |
| `eslint --no-cache`（本笔 2 文件） | **0 problems** |
| `prettier --check`（本笔 2 文件） | 全过 |

**两条变异各自只红该红的那几条**：① 把 `REVIEWER_PURE_REASONING_TOOL_KINDS` 换成空集（＝回到改动前）⇒
**3 条**红（`think` 分类、`think` 放行、`think` 无 allow 选项时 cancel），其余 12 条绿；
② 把 `execute` 也塞进白名单 ⇒ **4 条**红（「七种 kind 逐个仍 foreign」、拒绝 shell、无 reject 选项、
选项优先级），审查边界那几条仍绿。

**tsc 抓到一条 vitest 看不见的错**：`permissionDecisionResponse` 里 `decision.optionId` 在
`outcome: 'reject'`（可选字段）与 `'allow'`（必填）的分支上没被收窄 ⇒ `TS2322`，而 vitest 18 条全绿。
收窄写成显式 `if (decision.outcome === 'reject') { const optionId = decision.optionId; … }`，不用 `as`。

## 6 边界（不许读成更强）

1. **只覆盖 kind 为 `think` 的那一半**。那 9 条里 `tool: think` **不能**从这一份日志判定是「ACP kind 为 think」
   还是「工具名叫 think、kind 为空」—— 拒绝行原来只有一个字段，两种形状同形。本次修法按 ACP kind 生效
   （`execute` 那条只能是 kind：OpenCode 的 shell 工具叫 bash 不叫 execute，所以那个字段里确实出现 kind），
   **但这是一条推断，不是这条日志的直接证明**。
   **判据已经埋好**：下一次真机出现拒绝时，新加的 `toolKind` 字段会自证 —— 若 `toolKind` 为空而 `tool: think`，
   说明那 9 条是工具名、本修复没覆盖它们，本条必须重开（届时把规则改到「名称 + 无 rawInput 里的路径/命令」那一侧，
   而不是放宽到按名称一律放行）。
2. **`execute` 那 7 条仍然会作废整轮复查**，这是**设计**：后台复查会话不许有 shell。它们的正确出路不是放宽，
   而是「没有 findings 时怎么收场」——见 §7 的下一单元。
3. **没有真机窗口读数**：本条的证据是**生产日志的既有读数 + 纯函数用例**，不是一次窗口里点出来的。
   内存闸门未解（现取：空闲物理页 3,871 ≈ 63 MB、`swap used 15,321 MB / 16,384 MB`、load 10.6），
   起不了打包态/窗口实例 ⇒ 不声称任何窗口读数。
4. **`resolvePermission` 这个适配层仍无端到端用例**：要构造 `ReviewerSessionOwner` 的活动会话得先在
   `create()` 里拉起一个 ACP agent，代价远超本单元。判定与响应映射都已是纯函数并被钉住；剩下的
   「记日志 + 计数」两件事按代码可读，**具名记为覆盖边界**。
5. **不占版本号**：没有新的用户可见能力，只是让一条本就该被批准的调用不再被拒。版本位点仍是 `2.15.3`，
   本条会随下一次发版出去（这也是它到用户手里之前**不可能**有窗口读数的原因之一）。
6. **另一边的那 289 条 1 秒等待不在本条内**：`OpenCode permission context wait timed out` 里 184 条是
   复查会话自己的 MCP 调用（超时后 1 ms 就被应用自动批准 ⇒ 那 1 秒是纯延迟），105 条是别的工具。
   它是**独立的**一个单元（判据：等的是「谁将要读这些入参」），已在计划档具名，不混进本条。

## 7 取数脚本（可复跑）

三个脚本都只读日志、落在 `/tmp`（不入仓）：按 `(level, scope, msg)` 聚合、按 `toolCallId` 展开单条签名、
把拒绝行与作废行按时间配对。关键的一条是**先看配对再下结论**：只有 `review protocol incomplete` 的条数时，
它读起来像「复查偶尔失败」；配上拒绝行才看出是 15/15。
