# 立项：transcript 渲染架构（props → 订阅化 + markdown 结果复用）

> 立项依据：40 回合每回合主线程成本已从 94.2 ms 降到 74.4 ms（回调跳板，commit `4a369a9e`），但
> **80 回合仍有 103.5 ms/回合且随会话长度继续上升**；两次机会主义补丁（收窄渲染窗口、
> `subsequentTurns` 只给 user 行）实测都更差或无效，已 `git checkout --` 还原。
> 结论：剩余斜率不是调参问题，需要一次性把渲染契约改对。

## 一 现状读数（全部可复算，见证据档）

数据来源：`docs/evidence/2026-11-05-perf-baseline-scroll-vs-streaming.md` §六–§二十。

| 口径          | 10 回合 | 40 回合 | 80 回合                |
| ------------- | ------- | ------- | ---------------------- |
| 每回合 task   | 59.9 ms | 74.4 ms | **103.5 ms**           |
| 每回合 script | 34.7 ms | 41.6 ms | **61.0 ms**            |
| 最长单任务    | 0 ms    | 0 ms    | 0 ms（无 >50 ms 任务） |
| 帧 p95        | 19 ms   | 18 ms   | 18 ms                  |

增长斜率 ∝ 行数 ⇒ 一场会话的总成本随长度二次增长。**这就是「越聊越卡」的来源。**

## 二 已排除的假说（不要再试）

| 假说                           | 实测                                                                                                         | 处置     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------- |
| 浏览器没跳过屏幕外的行         | `content-visibility:auto` + `contain-intrinsic-size` 早已在沉淀行上（`message-scroller.tsx:79`，有测试断言） | 已排除   |
| 收窄渲染窗口即可省             | padding 60→8：40 回合 74.4→97.3 ms、80 回合 103.5→**199.0 ms**，最长任务 122 ms                              | 已还原   |
| `subsequentTurns` 只给需要的行 | 103.5→102.0 ms，落在噪声内                                                                                   | 已还原   |
| 没有窗口化                     | **有**：`boundedRenderWindow` + 96px 骨架，阈值 150 / padding 60                                             | 前提纠正 |

关键教训：**卸载一行再挂回来的成本，高于让这一行常驻**——因为正文走 `streamdown`，重挂要从头解析
markdown。虚拟化的收益前提是「行便宜」或「重挂不频繁」，当前两条都不成立。

## 三 剩余斜率的机制（探针读数，非推断）

逐槽 props 复用判定失败时按位记录，40 回合：

```
16=3280  canBranchInNewSession      ≈ 2×槽位/回合
 4=1680  revisions                  ≈ 1×槽位/回合
 6=1640  subsequentTurns            ≈ 1×槽位/回合
 0=40    item.message               = 1/回合（稳）
```

**每回合一到，这三项对每一行都换身份 ⇒ 全表重渲一次。** 它们都不是行自己算出来的，是从上层顺着
props 灌下来的；而其中两项（能否分支、后面还有几轮）只在一个极小的交互点上需要。

## 四 不变量（任何阶段都不可破）

1. **流式文字逐增量可见**：不允许为了省成本把增量攒起来再显示（那是拍板项，不在本立项内）。
2. **交互必须用最新上下文**：编辑、分支、修订切换只能打到用户此刻看着的那个会话；禁止用「从依赖里
   拿掉回调」换稳定，必须让引用真正稳定或读 `getState()`。
3. **滚动手感**：粘底、向上翻历史、`scrollToMessage` 定位、run-marks rail 跳转，四项行为不变。
4. **文本必须可查**：`Cmd+F` 命中沉淀很久的消息。
5. **跨行复制**：跨越 3 条以上消息的选区能复制完整文本。
6. **无障碍**：占位骨架不得被读屏当成内容（`aria-hidden`），但真实行必须保持可读。

## 五 设计

### 5.1 P1：三项 props 订阅化（目标：斜率归零）

| 依赖                               | 现状                                                              | 改法                                                                                         | 为什么安全                                                   |
| ---------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `canBranchInNewSession`            | 布尔，`canSendMessage && status==='idle'`，每回合翻转，灌进每一行 | 建 `TranscriptCapabilitiesContext`，**只有那个分支按钮组件订阅**；行 props 不再含布尔        | context 变更只重渲消费者，不重渲祖先行                       |
| `subsequentTurns`                  | 裸数字，新回合 +1，灌进每一行                                     | 从渲染期属性改为**点击时读取**：`countUserTurnsAfter(sessionId, messageId)` 现算             | 值只在确认对话框里用；点击发生在渲染之后，取到的必然是最新值 |
| `revisions` / `revisionNavigation` | map 每回合重建，命中行数组换身份                                  | 改为行内 zustand selector 订阅 `(sessionId, revisionRootId)`，返回稳定引用；无修订的行不订阅 | 选择器返回同一引用时 zustand 不触发重渲                      |

**判据**：探针输出里 16/4/6 **归零或只剩「本回合新出现的行」**；40 与 80 回合的每回合 task 差距
缩到 10% 以内（当前 40→80 是 +39%）。

### 5.2 P2：让重挂变便宜（目标：为 P3 铺路）

先量一件事，再决定做法：**单行重挂到底贵在哪**。用 CDP 剖析一次「窗口抖动」采样，看
`streamdown` 解析、markdown 语法树、React commit 各占多少。

- 若解析占大头 → 在 `AgentMarkdown` 外挂 **LRU（key = 内容哈希 + isAnimating）**，缓存解析产物，
  重挂时直接复用；上限按条数与字符数双限，切会话时不清（同会话内复用价值最高）。
- 若 commit 占大头 → 缓存无效，改走「不卸载」路线：行常驻、仅内部重计算，等于放弃虚拟化。

**判据**：P2 落地后，把窗口 padding 临时调回 8 再测 80 回合，**不得劣于 103.5 ms**；向上翻历史
无白屏、无位置跳动。

### 5.3 P3：窗口策略回归（P2 成功才做）

只有 P2 读数达标，才重新调 `BOUNDED_RENDER_ITEM_THRESHOLD` / `BOUNDED_RENDER_WINDOW_PADDING`，
按 80 回合读数与手验结果取一组值，并且**保留一键回退到 padding 60 的路径**。

## 六 风险矩阵

| 风险             | 触发场景                                   | 兜底                                                 |
| ---------------- | ------------------------------------------ | ---------------------------------------------------- |
| 分支按钮状态滞后 | status 由 running→idle 时按钮未刷新        | 按钮订阅 context；真机验一次「回合结束后立刻可分支」 |
| 轮数提示错       | 编辑 60 回合前的消息，确认框显示的后续轮数 | 点击时现算；真机验与计数一致                         |
| 修订切换失效     | 有修订的行不再拿 props                     | 行内 selector 订阅；真机验「上一版/下一版」按钮      |
| 记忆增长         | markdown LRU 无上限                        | 双限（条数 + 字符）+ 命中率日志                      |
| 卸载导致位置跳动 | P3 调窗口                                  | 实测高度缓存；不达标就回 padding 60                  |

## 七 真机验证清单（每阶段都要过）

- [ ] `PERF_TURNS=10/40/80 npx playwright test e2e/perf/smoothness.spec.ts` 三次读数，仪器须自证 `usable`
- [ ] `PERF_TURNS=40 npx playwright test e2e/perf/profile-turns.spec.ts`：函数榜与探针 churn 一起看
- [ ] 向上翻 30 屏后回到顶部，再滚回底部：位置与内容一致（新增 spec）
- [ ] 点 run-marks rail 跳到第 1 轮：落点正确
- [ ] 重开重会话：位置与内容一致（现有读数 97 ms，不得变差）
- [ ] 手验 `Cmd+F` 命中 60 回合前的关键词
- [ ] 手验跨 3 条消息复制，粘贴文本完整
- [ ] 手验编辑第 1 条消息：确认框轮数与实际一致
- [ ] 手验回合结束后立刻点分支按钮：可用
- [ ] 全量 unit + `typecheck:web` + `eslint` 0 error

## 八 明确不做

- 不改 `streamdown` 库内部实现；
- 不做流式增量合并（属观感取舍，需单独拍板）；
- 不改消息滚动库的滚动/锚定逻辑。

## 九 第一步（下一个动作）

1. 把之前临时用过的**渲染计数探针与非门禁剖析**固化成可复跑的工具（`e2e/perf/` 下，不进门禁），
   作为本立项的回归护栏——没有计数就无法判断「斜率是否归零」。
2. P1 只做 `canBranchInNewSession` 一项，量一次；通过再动第二项。三项一起改会失去归因能力。

## 十 回归护栏已就位（本立项第一步，已交付）

`e2e/perf/render-count.spec.ts` + `src/renderer/src/lib/perf/render-counter.ts`：计数在组件里，桶由
perf spec 安装；没人安装时是一次属性查找加空判断，生产环境永远是空转。它一次跑出两张表：

```
PERF_TURNS=40 npx playwright test e2e/perf/render-count.spec.ts --reporter=line
[render-count] 40 turns: rows=82 total=4835 median=52 max=159
[render-count] props churn by tuple index: 16=3280 4=1680 6=1640 0=40 2=40
```

- **渲染计数**：中位 52（回调跳板之前的同一口径是 226）—— 说明「每个增量全表重渲」已止住，
  现在一次渲染事件只影响一部分行；
- **props 漂移**：与临时探针读数**逐位一致**，说明固化成工具后没有失真，可以当判据。

这组数就是 P1 的验收基线：**16/4/6 三项必须归零（或只剩本回合新出现的行）**，否则 P1 不算完成。

## 十一 P1-a 已落地：`canBranchInNewSession` 改走 context（读数）

改法：新增 `TranscriptCapabilitiesContext`（`transcript-capabilities-context.ts` 放 context 与 hook，
`transcript-capabilities.tsx` 只放 Provider，避免 react-refresh 报错），把「能否在新会话分支」从行 props
移到 context；分支按钮抽成 `BranchInNewSessionButton` 自己订阅——capability 翻转只重渲这个小按钮。

### 读数（同机同 spec）

| 口径                  | 改前                                 | 改后                                        |
| --------------------- | ------------------------------------ | ------------------------------------------- |
| props 漂移（40 回合） | `16=3280 4=1680 6=1640 0=40 2=40`    | **`4=1680 6=1640 0=40 2=40`**（位 16 归零） |
| 渲染计数（40 回合）   | rows=82 total=4835 median=52 max=159 | rows=82 **total=2906 median=29** max=106    |
| 40 回合 每回合 task   | 74.4 ms                              | **60.4 ms**                                 |
| 40 回合 每回合 script | 41.6 ms                              | **32.8 ms**                                 |
| 80 回合 每回合 task   | 103.5 ms                             | **86.3 ms**                                 |
| 80 回合 每回合 script | 61.0 ms                              | **48.8 ms**                                 |

只挪一个布尔，40 回合 task 再降 19%、80 回合再降 17%。斜率仍在（60.4 → 86.3 = +43%），因为位 4/6
两项还没动。

### 一个没验成的地方，如实写

本来想用真窗口验证「回合结束后分支按钮可用」，写了 e2e 读按钮 disabled 状态——**基线代码同样失败**
（假 agent 会话里 `canSendMessage` 为 false，按钮在改动前就是 disabled）。这说明该 e2e 无法区分改动前后，
不能当选据；已删除该 spec，改为 `transcript-capabilities.test.tsx` 三条契约测试：默认关闭、provider 传值、
**capability 翻转时只重渲消费者、不重渲旁边 memo 过的「沉淀行」**（第三条正是这次改动的目的）。

真正需要真机确认的那一步（真实模型会话里回合结束按钮变可用）留给 P1 全部完成后的整机验证，记录在此。

## 十二 P1-b 已落地：`subsequentTurns` 移出渲染期（读数）

改法：新增 `countUserTurnsAfter(sessionId, messageId)`（`session-store.ts`），行的编辑确认在**点击时**从
store 现算后续 user 轮数；确认框用点击瞬间捕获的值。同时删掉 scroller 每次渲染都为**全部消息**重建的
`subsequentTurnCountByMessageMap`（那本身是每次渲染一趟 O(行数)）。

### 读数（同机同 spec）

| 口径                  | P1-a                      | P1-b                                                   |
| --------------------- | ------------------------- | ------------------------------------------------------ |
| props 漂移（40 回合） | `4=1680 6=1640 0=40 2=40` | **`4=1680 0=40 2=40`**（位 6 归零）                    |
| 渲染计数（40 回合）   | total 2906 median 29      | **total 2288 median 2** max=120                        |
| 40 回合 每回合 task   | 60.4 ms                   | **59.3 ms**（script 31.5）                             |
| 80 回合 每回合 task   | 86.3 ms                   | **81.2 ms**（script 44.0）；另一次同 spec 跑出 98.0 ms |

中位渲染次数从 29 掉到 **2** —— 说明「沉淀行每回合重渲」这条路径已经断掉。但**每回合成 wall-clock 只降了
1.8%（40 回合）/ 5.9%（80 回合）**，且 80 回合有一次 98.0 ms 的落后样本。结论要诚实：**行的重渲不再是
成本主项，剩余成本在别处**，P1-c 不足以把它压到 10% 以内。

### 80 回合采样剖析（新读数，指向下一次要查的地方）

```
sampled 11362ms across 7639 samples
idle 4614.8 · program 1461.0 · GC 269.7
removeChild 194.1 · commitHostUpdate 171.1 · elementText 142.8 · updateProperties 135.0
querySelectorAll 133.4 · propagateContextChanges 120.9 · query 101.6
isElementHiddenForAria 98.2 · renderWithHooks 96.7 · normalizeWhiteSpace 87.5 ms
```

比 P1 之前那版榜（`removeChild 205`、`commitHostUpdate 559`）已经降下来，但出现了一批**与无障碍/文本提取
相关**的原生函数：`isElementHiddenForAria`、`elementText`、`querySelectorAll`、`query`、
`normalizeWhiteSpace`。它们不是行渲染，更像「每回合有人在整篇文档上做可访问名/文本计算」。这是下一步的
排查方向，不能靠猜，要先定位是谁在调用。
