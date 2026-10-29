# E1 / E2 — 长会话可读性：折叠契约与每轮读数

日期 2026-10-29 22:2x CST｜仓库 `/Users/totota/purescience`｜分支 `main`

## E1（settled 折叠 + 工具组摘要）—— 审计归档：代码已覆盖，本轮补用例

计划档「现状：无」已经过期。实测：

- 相邻工具活动本来就合成**一组可折叠的摘要行**（`WorkspaceActivityGroup`），摘要行给
  「标题 · N steps · 耗时」，点开显示逐条工具行；
- 默认展开状态由 `resolveActivityGroupExpansion({ override, isNewestTurn, activities })` 决定
  （`workspace-tool-activity-groups.ts:336`）：
  `override ?? (isNewestTurn || activities.some(isActive))`
  ⇒ **settled 且不是最新一轮 ⇒ 自己折起来**；最新一轮与正在跑的工具保持展开；用户的手动开关优先。

所以 E1 的目标「折叠后的摘要行可展开」在代码层面已成立，本轮**没有改行为**，只补了缺失的回归用例：

- `workspace-tool-activity-groups.test.ts` › `resolveActivityGroupExpansion`：三条（settled 非最新 ⇒ 折；
  最新 / 运行中 ⇒ 开；override 双向优先）；
- 真实渲染器的既有证据（`WorkspaceMessageScroller.render.test.tsx`）：settled 组的标题与步数在，
  组内明细不渲染（`aria-expanded="false"` 且断言 `not.toContain('Live typhoon updates')`）。

## E2（每轮成本/耗时归因）—— 本轮实现

摘要行原来只说得清「几步、多久」，说不出一轮花了多少 —— 成本只在设置里的用量面板。

改动：

| 位置                       | 内容                                                                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkspaceActivityGroup`   | 摘要行右侧新增 token 总量（`input + cache + output`），量级写法与写作区的上下文计量一致（`1.2k` / `25k` / `512`）                                                                |
| `WorkspaceMessageScroller` | 每一组活动的读数取自**它那一轮**的 agent 消息：按时间找该组之后最近的 agent 消息，找不到再取之前最近的；不假设「下一项就是回复」（活动组与消息共用时间戳，回复还可能被拆成多条） |
| 三种输入分开               | 有 `turnUsage` → 数字；有 `turnUsageUnavailable` → 「未记录用量」；该轮没有任何读数 → 整段不出现（不写 0，也不写 unknown）                                                       |
| i18n                       | `toolActivity.turnTokens` / `toolActivity.turnTokensUnavailable`，9 种语言同步；es 与英文同形被多语言门禁拦下，改成 `tokens usados`                                              |

验证：

- `WorkspaceMessageScroller.render.test.tsx` 用真实渲染器 + 真实 store 投影跑三种输入：
  1. `turnUsage {input:1200, cache:0, output:45}` → 摘要行显示 `1k`；
  2. `turnUsageUnavailable` → 摘要行不含任何数字，只有「未记录用量」；
  3. 该轮无读数 → `tool-group-turn-tokens` 元素不存在。
- workspace 一带 1954 条用例、typecheck（node+web）全绿；Windows Full Test success。

⚠️ 未做真机截图验收：e2e 的确定性 fake agent 不产生工具调用，因此真实窗口里没有工具组可看。
要让 E2 有真机读数，需要给 fake agent 加一个「产生一次工具调用」的脚本分支 —— 列入下一步，
在此之前不声称 E2 已在真机窗口验证。
