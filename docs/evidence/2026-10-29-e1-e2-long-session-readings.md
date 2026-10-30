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

所以 E1 的目标「折叠后的摘要行可展开」在代码层面已成立，本轮**没有改行为**，只补了缺失的回归用例。
（补充：旧一轮不折叠只在**夹具排序错**时出现 —— transcript 的主序是 `createdAt`（见 `createConversationItems`），
不是 `sortIndex`；用 sortIndex 造夹具会让两轮的工具并成一组、旧组看起来「没折」，那是夹具 bug。
`WorkspaceMessageScroller.render.test.tsx` 的 `settled-turn collapse (E1)` 三条用例按 createdAt 排，
断言 `aria-expanded` 依次是 `['false','true']`、折叠组不渲染明细、运行中的组永不折叠。）

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

## 真机尝试（2026-10-30，未成 —— 具名立案）

夹具**已经**能在 `PURESCIENCE_E2E_TOOL_EVENTS=<n>` 下吐工具调用生命周期，所以本轮写了两版认证用例去取读数，
两版都拿不到 E1 要的那一对（settled 组折 / 最新组开），原因逐条如下（都是**用例的假设错**，不是产品行为）：

1. **回复文案**：夹具对任何未特判的提示回同一句固定文本
   （`Deterministic reply: Summarize the deterministic fixture.`，见 `e2e/fixtures/fake-opencode.mjs`），
   **不回显提示**。用例里写 `Deterministic reply: ${prompt}` 的版本会一直等一句没人会说的话。
2. **分组**：两轮各带 2 次工具调用，但真实窗口里只渲染出**一个** `[data-testid="tool-group"]`
   （122 次轮询恒为 1，期望 2）。也就是说这两轮的活动被并进了同一组，于是「较早一轮折起来 / 最新一轮展开」
   这个对比**在这个夹具下根本没有两个对象可比**。要造出两个可比的组，夹具需要能按轮把活动分开
   （例如只在一轮吐工具事件，或加一轮「无工具」的纯文本回合把两组隔开）。

### 补：立案已兑现一半（2026-10-30 夜）

上面那条「两轮被并进同一组」的诊断**只对了一半**，实测把它纠正了：

- 渲染层的规则已经用一条独立用例钉住（`src/renderer/src/pages/workspace/activity-group-timestamp-order.test.ts`）：
  活动项按**自己的时间戳**排序，因此「两轮各带时间戳」⇒ 两个组，「时间戳相同」⇒ 并成一组；
- 真实窗口读到的却是**一个组、2 steps**（不是并成 4 steps）⇒ 合并的前提不成立。真正的解释是：
  **实时转录只带当前这一次 run 的工具活动**，两轮里只有最后一轮的活动在视图里；要拿到两个组的对比，
  得看**重新加载后的转录**（活动从会话文档回来）。这一点两次尝试（renderer reload / 应用 restart）
  都停在夹具层：reload 丢会话选择、restart 后会话不自动打开，用例在「回复数=2」这一步就红了。

于是这一轮交付的是**能断言的那部分**，并且已经进认证车道：
`e2e/certification/session-turn-readings-real-window.spec.ts` → **1 passed (11.8 s)**，读数：

```
[e1-e2] summary row: Fetched 2 pages · 2 steps · 1ms · usage not recorded
[e2]    cost cell:    "usage not recorded"
[e1]    newest turn open → folded (0 rows) → open again (2 rows), on a real window
```

- **E2 缺的那半边补齐了（缺席分支的真机读数）**：夹具不上报用量，摘要行显示「usage not recorded」，
  **不是 0** —— 这正是 E2 三种输入里的第三种，此前只有渲染层用例；
- **E1 的折叠控制**在真窗口里得到读数：最新一轮默认展开（规则如此），点一下折起（0 行），再点回来（2 行）；
- **仍未取的**：settled 组 vs 最新组这一**对**读数（需要「重新加载后的转录」这条取样路径，见上）。

结论（保持原判）：E1/E2 的真机读数**不是**这轮能取到的，也不该用一版「凑到绿」的用例冒充。
下一步（立案）：先给夹具加「按轮控制工具事件」的能力，再写一支只断言「settled 组折、最新组开、点开后明细回来」
的认证用例；在那之前本单元的真机那半边一栏记为未取。
两版草稿已从工作区移除（未提交），避免把一条红用例留进认证车道。
