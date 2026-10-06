# IC52 段 1：卡片重放小节的真机读数（2026-10-06）

## 真实事实（这次跑的是什么）

- 被测对象：`src/renderer/src/pages/workspace/SessionInfoCard.tsx` 的只读「重放步骤」小节（提交 `88d92039`），步骤来自 `src/shared/session-replay-steps.ts` 的纯函数 `buildSessionReplay`，输入是应用自己写的会话文档（`sessions.readDocument`）。
- 取证方式：`e2e/certification/session-replay-steps.spec.ts`，隔离工作树 `git worktree add /tmp/ps-ic52 88d92039` + `npm run build:e2e` + `npx playwright test … --workers=1`。
- 走的是**真入口**：`completeOnboarding` → `configureFakeAgent` → `createProject` → `sendPrompt`（文件里已证的提示对 `Create a table PDF fixture.` / `Table PDF ready for session`）→ 点标题栏的会话标题按钮（`ConversationPanel.tsx:561` 的 `h1 > button`）展开信息卡。

## 本轮观测值

```
[ic52] the card lists 1 step(s): ["prompt"]
 1 passed (15.4s)
```

- 卡片上出现 `[data-slot="session-replay-steps"]`，列表里 **1 步**，kind 为 `prompt`。
- 断言成立：`kinds[0] === 'prompt'`、提示步恰好 1 条（列表来自会话自身记录，不是编造）；小节内 `button/input/select/textarea` 计数为 **0**（只读是断言出来的）。
- 同批的渲染套件 `SessionInfoCard.render.test.tsx` **10 passed**，其中两条正是真机这次证不到的：工具步（含 `providerToolName` 显示）与「未挂在任何提示上」的措辞，以及「读不到就不显示小节」。

## 本轮**没**证到什么（具名）

1. **工具步**：夹具 agent 只回文本、**不产生工具活动** ⇒ 本次读数里没有 `tool` 步。工具步的证据在渲染套件（用的是会话文档形状的夹具，不是真机文档）。
2. **写审计 / 运行标记 / 产物引用三项的展示**：**尚未实现** —— 立项 §5 判据②要求「工具调用 / 写审计 / 运行标记 / 产物引用四项里至少三项可读」，当前只有工具调用一项可读 ⇒ **该判据未满足**，IC52 段 1 不算完成。
3. **对某一步提问**（段 2）与空态/只读守卫的成批收口（段 3）未开始。
4. 「Windows 车道上的行为」与本单元无关；本读数在 macOS 上取得。

## 清理

- 隔离工作树 `/tmp/ps-ic52` 用完即删（`git worktree remove --force`）；`test-results/` 属构建产物，不入库。

## 段 2（对某一步提问）的读数（2026-10-06，第二批）

**真实事实**：同一条 spec 其后追加了提问流程；本轮在**新建立**的隔离工作树（`165509b5`）里 `build:e2e` 后重跑。

**本轮观测值**：

```
[ic52] the card lists 1 step(s): ["prompt"]
[ic52] the answer says: "message-1791285972208-1 · from promptMessageId"
[ic52] a question the step record cannot answer is said, not answered
 1 passed (9.1s)
```

- 选中那一步、问「which prompt does this step belong to?」⇒ 答案同时给出**值**（该步的提示消息 id）与**出处字段**（`promptMessageId`）⇒「每句带出处」在真机上成立。
- 再问「is this statistically significant?」⇒ 走到「这一步自己的记录答不了这个问题。」的具名路径，而不是一句看起来合理的废话。

**一项方法学更正（本轮踩到，值得留档）**：真机取证必须**新建**工作树，**不要复用旧路径**——我复用了上一轮的工作树，其 `out/` 仍是旧构建，于是跑出「ask 小节不存在」的**假红**；判据是 `out/` 的构建时间与当次提交对不上，不是产品问题。

**本轮没证到什么**：与本文件上一节相同（夹具 agent 不产生工具活动 ⇒ 工具步的三角度由渲染套件承担）；提问的键盘可达性不在本单元判据内，未测。
