# 两级目录：调用点审计（谁在整库读内容）

- 日期：2026-09-18
- 触发：启动 hydration 已改为列表层（摘要），需要确认**没有别的路径在渲染/计算"非选中会话"的内容** —— 那些路径现在会读到空
- 方法：不按字段数数（`conversationGraph` 42 / `activities` 28 / `eventIds` 12 处里绝大多数是按 id 定位、只动目标会话），而是找**"遍历所有会话并读取内容字段"**的位置，这才是本设计真正的判据

## 一、真发现（1 处，会导致用户可见错误）

**`src/renderer/src/pages/settings/token-usage-analytics.ts`** —— `buildTokenUsageAnalytics(sessions, …)` 里三处 `for (const session of sessions)` 遍历**全部会话**，读取：

- `:161` `session.conversationGraph`（消息与 `turnUsage`）
- `:208` `session.conversationGraph?.frames`
- `:212` `session.conversationGraph?.messages`（`turnUsage` / `agentFrameId`）
- `:268` 判断 `if (session.conversationGraph) continue`（无图会话的兜底分支）

数据来源链：`TokenUsagePanel.tsx:110` 调 `buildTokenUsageAnalytics(sessions, …)`，`sessions` 是其 **prop**（`:24`/`:78`），由设置页传入 ⇒ 改摘要后**用量会全部算成 0**。

**后果**：不是崩溃，是**静默错数**（最坏的一类）。**当前 HEAD 上这是一个真缺陷**，必须在宣称特性完成前修掉。

**修法（已定，未实施）**：这个视图**合法地需要全部会话的内容**，所以它属于"按需取全量"的调用方 —— 打开该面板时按需取（沿用 `sessions.loadAll()`，范围只限这个页面，与改前行为一致），或在主进程侧做聚合。二者都符合两级目录的设计；**不能**接受让汇总基于摘要。

## 二、判定为安全的（逐类说明，不是"没看"）

| 位置 | 为什么安全 |
|---|---|
| `stores/session-store-*-owner.ts` 的 `sessions.map` / `find` | 全部**按 id 定位**后只替换目标会话；遍历本身只做 id 比较，不读内容 |
| `navigation-store.ts:91/173` | 只读 `lastReadAt`/id 等**元数据** |
| `WorkspaceActivityGroup.tsx` · `workspace-conversation-items.ts` · `WorkspaceMessageScroller.tsx`（读 `activities`） | 渲染的是**当前选中会话**（由工作区页面作为 prop 传入），而选中会话正是被按需读全的那个 |
| `lib/acp/workspace-events.ts`（`activities`/`eventIds`） | 事件只作用于**当前运行中的会话** |
| `pages/workspace/context-window-trend.ts`（`conversationGraph`） | 只算当前选中会话 |
| 全局搜索命中 | 命中数据由主进程**从磁盘**构建，不经 store |

## 三、审计结论

- **需要修**：1 处（设置页用量汇总）—— 记入"完成前必修"；
- **安全**：其余全部，理由如上；
- 这次审计再次印证：判据是"**是否遍历整库并读内容**"，而不是"某个字段被引用了几次"——按后者数数会把 82 处引用误报成风险。
