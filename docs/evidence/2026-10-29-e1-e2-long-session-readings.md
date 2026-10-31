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

## E3（排版）—— 正文阅读尺度 + 折叠摘要行 24px

用户问「怎么排版能让软件工作得更好」后落地的两项（第三项「每轮轮脊」未做，见末条）：

| 改动                                                                      | 位置                                             | 读数                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| 正文收窄到 68ch，表格/代码/图保持满列（`[&_table]:max-w-[56rem]` 等）     | `WorkspaceMessageItem.tsx` 包一层 `max-w-[68ch]` | 896px @15px ≈ 95 字符/行 → 68ch ≈ 640px               |
| 折叠摘要从卡片降级成一行：24px 高、无背景、hover 才提亮；展开时才长成卡片 | `WorkspaceActivityGroup.tsx`                     | 真机 `folded summary row height: 24px`（此前约 56px） |

真机读数（`e2e/certification/session-turn-readings-real-window.spec.ts`，**1 passed (31.9 s)**）：

```
[e1-e2] summary row: Fetched 2 pages · 2 steps · 4ms · usage not recorded
[layout] folded summary row height: 24px
[e2]    cost cell:    "usage not recorded"
[e1]    newest turn open → folded (0 rows) → open again (2 rows)
```

**未做**：「每轮一根 2px 轮脊」跨消息画一条连续轨 —— 它需要把一轮内的多个 transcript item 包进同一个容器，
属于结构性改动（现在是逐项 `MessageScrollerItem`），单独一步做，不塞进这次排版。

## E3 补：密度读数（以及一个把我自己的说法打掉的发现）

新增 `e2e/certification/session-density-reading.spec.ts`：四个带工具调用的真实回合，量视口、转录高度、
折叠行高度。HEAD 读数（**1 passed (17.9 s)**）：

```
[density] {"viewport":804,"transcriptHeight":570,"perTurn":143,"summaryRows":[24],"groups":1}
```

三点必须一起读，否则这个数会被误用：

1. **折叠行确实是 24px**（`summaryRows:[24]`），此前约 56px —— 这一条成立；
2. **`groups:1`**：四个回合只渲染出**一个**工具组（同 §补 那条：实时转录只带当前这次 run 的活动）。
   所以「每轮省 32px」只作用在 1/4 的回合上，一屏 804px ÷ 143px ≈ **5.6 轮** —— 和改之前几乎一样；
3. **正文收窄会增加高度**：同样文字 68ch 比 95 字符/行要多折几行。也就是说这次「可读性」的收益是
   **阅读舒适度**，不是「一屏更多内容」；后者要等第 2 条被解决才拿得到。

结论（不许粉饰）：**这次排版改动的密度收益，比原型图给人的印象小**。真正能提高一屏信息量的前提是
「每个已结束的回合都留下自己的摘要行」，而今天只有当前 run 的活动在视图里 —— 这与 E1 那条
「settled 组 vs 最新组」是同一个根因，应当作为一个单元一起解决（取样路径：重新加载后的转录，
或用持久化的 `activityGroups` 回填实时视图）。

## E4：活动列表合并（半程）——为什么一对一还取不到

诊断往下走了一层，结论与修法都更清楚了：

1. **`??` 丢掉了历史上半**：`WorkspaceMessageScroller` 里 `activities: liveActivities ?? activeSession.activities`
   在没有 live 列表时才回落到文档那份 —— 只要本轮有活动，之前所有回合的摘要行就整体消失。已改为
   `mergeActivityLists(文档, live)`（按 id 去重、文档在前），三条例用钉住（保持历史、不重复、单边/双空）。
2. **但只合并还不够**：真实窗口两轮仍然只有 **1** 个摘要行（`[e1-pair] groups=1`）。原因是**在跑着的会话里
   `activeSession.activities` 本身也是按 run 重算的**，历史活动只存在于 `conversationGraph` 里 ——
   渲染层那份扁平列表没有它们，合并没有东西可合。
3. **修法已经现成**：`resolveActiveConversationActivities(conversationGraph)` 就是 graph → 扁平活动/分组的投影，
   store 在切分支时已经在用（`session-store-message-graph-owner.ts:634-645`）。下一步是把它接到转录的取数处，
   与 live 列表合并 —— 这样每个结束的回合都留下自己的 24px 摘要行，E1 的「settled 折 / 最新开」也就有了两个对象。

本轮**没有**把这对读数写成红用例：`session-turn-readings-real-window.spec.ts` 末尾留的是说明而不是断言，
认证车道保持绿（1 passed）。

### E4 定论（同日，第四次取样）：写侧才是瓶颈

把三个可能的层都测了，只有最后一个给了答案：

| 取样                                                 | 读数                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| 实时扁平列表                                         | 两轮 → **1** 个摘要行                                                      |
| 与文档扁平列表合并                                   | 还是 1（在跑着的会话里 `activeSession.activities` 按 run 重算）            |
| 与 `resolveActiveConversationActivities(graph)` 合并 | 还是 1（渲染层内存里的 graph 也没有早先那轮）                              |
| **盘上的会话文档**                                   | `{"graphActivities":2,"graphGroups":0}` —— **两轮只留下 2 条活动、0 个组** |

⇒ **不是渲染层丢的，是写侧只保留当前这次 run**：盘上文档就只有最后一轮那 2 条活动，历史那轮从来没进过
`conversationGraph`。所以「每个已结束回合都留下自己的摘要行」要改在会话持久化/图同步那一侧
（`synchronizeActiveConversationActivities` 的输入就是 `session.activities`，而它是按 run 的）。

本轮据此**回退**了渲染层的 graph 投影（在写侧修好之前它只会白算一遍整张图），保留 `mergeActivityLists`
（形状正确、有用例、写侧修好后立刻生效）。取样用例留在
`e2e/certification/session-activity-persistence-probe.spec.ts`，它打印的那一行就是下一步的验收基线：
两个回合之后应当是 `graphActivities≥4`、`graphGroups≥1`，而今天读到的是 `2 / 0`。

### E4 再收窄：丢在 store，而且是「每轮替换」

再补一次取样（同一支探针，在**第一轮结束之后**也读一次渲染层自己的 store）：

```
[persist] after turn 1: [{"activities":2,"activityGroups":0}]
[persist] after turn 2: [{"activities":2,"activityGroups":0}]   ← 第二轮没有让 2 变成 4
[persist] renderer view: [{"activities":2,"activityGroups":0}]
[persist] 盘上文档:     {"graphActivities":2,"graphGroups":0}
```

⇒ 结论链完整了：**渲染层 store 在第二轮就把第一轮的活动替换掉**（不是追加），持久化只是忠实地存下了这份 2 条。
所以修点不在持久化、也不在转录投影，而在 **store 里写 `activities` 的那一处**。

`activityGroups` 一直是 0，另记一条：这次工具调用没有生成持久化的组（渲染时按相邻活动临时成组），
所以「每轮一个组」要等 store 先累积出活动、且组的创建路径被触达。

只碰 `activities` 的文件已经收窄到五个（`session-store-run-activity-helpers` / `-message-graph-helpers` /
`-persistence-owner` / `-message-graph-owner` / `-run-terminal-helpers`）。下一步的探针：在 store 每次写入
`activities` 时打一行（条数 + 触发来源），一次运行就能点名是谁replace了它 —— 不再靠读代码猜。

### E4 结案：根因在**夹具**，不在产品

第四次取样读到 `after turn 1: 2` / `after turn 2: 2`，我据此怀疑 store 每轮替换。真正的原因更简单：

```js
// e2e/fixtures/fake-opencode.mjs（改前）
const toolCallId = `e2e-${process.pid}-tool-${step.index}`
```

`process.pid` 与 `step.index` **跨回合不变** ⇒ 第二轮的工具调用带着和第一轮**完全相同**的 id，应用把它当作
「第一轮那两条的更新」，于是无论跑几轮，转录里永远只有一轮的活动。真实 agent 的 id 每次调用都不同，
所以这个夹具从来没暴露出「每个回合各自留档」这件事。改成把 `replyMessageId` 拼进 id 后：

```
after turn 1: activities=2
after turn 2: activities=4          ← 追加，而不是替换
盘上文档:      graphActivities=4
live tool-groups: 2                 ← 两个摘要行
```

于是 E1 的那对读数**第一次在真机窗口取到**（`session-turn-readings-real-window.spec.ts`，**2 passed (21.1 s)**）：

```
[e1-pair] groups=2
  [{expanded:"false", text:"Fetched 2 pages · 2 steps · 3ms · usage not recorded"},
   {expanded:"true",  text:"Fetched 2 pages · 2 steps · 1ms · usage not recorded"}]
```

密度也随之可测（`session-density-reading.spec.ts`，4 个回合）：

```
{"viewport":806,"transcriptHeight":572,"perTurn":143,"summaryRows":[24,24,24,24],"groups":4}
```

- **四个回合四条 24px 摘要行**（改前：只有一条，因为夹具 id 碰撞）；
- 一屏 806 ÷ 143 ≈ **5.6 轮**；
- 折叠行改前是卡片（约 56px，未单独测量）⇒ 四个回合会多占约 128px，同屏约 4.6 轮。这一栏是**由两个已测量量
  推算**的，不是直接读数，这里标明以免被当成实测。

⇒ 之前那句「密度收益比原型小」的结论**作废**：那条结论建立在「只有一轮活动」的假象上。修正后的结论是：
夹具修好之后，24px 折叠行对长会话是实打实的收益，而 E1/E2 的真机读数也齐了。
