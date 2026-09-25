# 交互流畅度实测（2026-09-25）

用户长期反馈「卡、不如对标产品流畅」，此前项目里**没有任何流畅度测量设施**。这份记录建立测量方法、给出基线、定位热点、并给出修复前后的对比数字。

## 测量方法

新增两个 **不进 CI 认证矩阵** 的 Playwright 用例（性能断言在共享 runner 上必然抖，而抖的断言会被关掉，比没有更糟）：

- `e2e/perf/smoothness.spec.ts` —— `npm run test:e2e:perf`，可用 `PERF_TURNS=<n>` 调负载。测四类与手感直接相关的量：
  - 渲染主线程**长任务**（`PerformanceObserver`，`longtask`）：超过 50ms 就是掉帧预算；
  - **帧间隔** p95 与**最大值**（最大值才是掉帧堆积的信号）；
  - **IPC 往返**百分位（`projects.list` 实测）；
  - 动作 → 可见耗时（⌘K 面板、切回重会话）。
- `e2e/perf/streaming-profile.spec.ts` —— 流式阶段用 CDP `Profiler` 采真实 CPU profile 到 `test-results/perf/streaming.cpuprofile`，用于**归因**而不是猜。

### 探针自身的两个坑（已修，记下来免得重踩）

1. `observe({ type: 'longtask', buffered: true })` 会把应用启动以来的历史长任务**重放进每个阶段** —— 第一版因此给四个不同交互报了同一个 `longest=136ms` 的假值。正确做法：观察器只装一次、不带 `buffered`，阶段间只清空数组。
2. 夹具 `app.configureFakeAgent()` **返回它导航后的页面**，丢掉返回值会在已关闭的句柄上 `evaluate`（报 `Target page, context or browser has been closed`，看着像应用崩了）。

## 基线（同一台机器、打包产物、`--workers=1`）

| 场景                | 10 轮会话                  | 45 轮会话（`PERF_TURNS=45`）                 |
| ------------------- | -------------------------- | -------------------------------------------- |
| IPC `projects.list` | p50=1ms p95=6ms            | p50=1ms p95=6ms                              |
| 流式回复            | 0 条长任务；帧间隔 18/19ms | **24 条 >50ms（最长 78ms）；帧间隔 35/99ms** |
| 输入框打字          | 0 条；18/19ms              | 0 条；19/50ms                                |
| 滚动记录            | 0 条；18/19ms              | 0 条；18/19ms                                |
| ⌘K 命令面板         | 44ms 出可见                | 71ms 出可见                                  |
| 切回重会话          | 57ms 出可见                | 129ms 出可见                                 |

结论：**小会话流畅**（无一条越过 50ms 预算、最大帧间隔 19ms）；**长会话里流式回复期间几乎每个任务都超预算**，帧间隔峰值 99ms —— 这就是「卡」，拐点在 10～45 轮之间。

## 归因（不是猜的）

45 轮下采集 CPU profile，按自身耗时排序（1884ms 采样）：

| 自身耗时占比 | 位置                                                                           |
| ------------ | ------------------------------------------------------------------------------ |
| 31.4%        | `(program)`（原生/布局绘制，不归 JS）                                          |
| **15.8%**    | **`MessageTimestamp`**（`WorkspaceMessageItem.tsx`）                           |
| 6.8%         | 匿名（打包产物内联）                                                           |
| 3.9%         | GC                                                                             |
| 其余         | React 提交/协调内部（`commitHostUpdate` / `updateProperties` / `beginWork` …） |

`MessageTimestamp` 是最大的具名热点。读源码即可见原因：它每次渲染都**新建** `Intl.DateTimeFormat`（`dateStyle: 'full', timeStyle: 'long'` 与短格式各一个），而构造 formatter 要编译语言数据、代价很高；这条路径在**每条消息 × 每个流式片段**都会跑。

## 修复

`WorkspaceMessageItem.tsx`：两个 formatter 改为**按语言缓存**复用（语言是缓存键 —— UI 语言运行时可切换），渲染路径不再构造 formatter。行为不变（同 locale、同 options、同输出）。

## 修复前后（45 轮，同一口径）

| 指标                  | 改前                | 改后                |
| --------------------- | ------------------- | ------------------- |
| 流式最长阻塞任务      | 78ms                | **56ms**            |
| 流式超 50ms 任务数    | 24 条               | **5 条**            |
| 流式帧间隔 p95 / 最大 | 35ms / **99ms**     | **18ms** / **51ms** |
| 打字最大帧间隔        | 50ms                | **18ms**            |
| ⌘K 出可见             | 71ms                | 60ms                |
| 切回重会话            | 129ms / 长任务 65ms | 109ms / 长任务 51ms |

**诚实的边界**：这是单组对照，存在运行间波动；但机制有 profile 佐证，且方向在所有读数上一致（长任务 24→5、最大帧间隔 99→51ms）。剩余的长任务来自渲染窗口内的 React 提交本身，未在本轮处理。

## 修复后再次归因（同一口径）

| 自身耗时占比 | 位置                                                                                                                                                                                                      | 改前      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 21.6%        | `(program)`（原生/布局绘制）                                                                                                                                                                              | 31.4%     |
| 14.5%        | `(idle)`                                                                                                                                                                                                  | 6.2%      |
| 10.5%        | 匿名（打包产物内联）                                                                                                                                                                                      | 6.8%      |
| 3.3%         | GC                                                                                                                                                                                                        | 3.9%      |
| **1.5%**     | **`MessageTimestamp`**                                                                                                                                                                                    | **15.8%** |
| 其余 1~3%    | React 提交/协调（`updateProperties` 3.0% / `commitHostUpdate` 2.4% / `updateFunctionComponent` 1.9% / `reconcileChildFibersImpl` 1.7% / `beginWork` 1.6% / `renderRootSync` 1.5% / `removeChild` 1.1% …） | 同类      |

采样 CPU 总量从 1884ms 降到 880ms。**结论：热点已从单一函数变成 React 提交/协调的聚合成本**——没有下一个「哪个函数最烫」的便宜答案了。

## 顺带做过并保留的实验：给消息项加 `memo`

`WorkspaceMessageItem` 现在是 memo 包装（对内改名 `WorkspaceMessageItemImpl`）。实测：

- **对流式阶段几乎无效**（仍 3~4 条 >50ms、峰值 50ms）：父层每次渲染都产生新身份的 prop（`artifacts` 数组、`runtimeIdentity` 对象），浅比较必然失败，memo 被抵掉。
- **对已定稿 transcript 有效**：切回重会话的长任务 51ms → **0ms**。

所以 memo 保留（无害且对切换场景有收益），而流式阶段要真正受益，得让已定稿消息的 prop 稳定 —— 注意 store 每个流式片段都会替换 session 对象，memo 的键必须取窄（例如 `message.artifacts` 与历史产物表），否则照样每次重算。

## 留下的下一步（有数据起点，非「半截」）

- 目标：把流式期间的 3~4 条 >50ms、峰值 50ms 继续压下去（45 轮会话）。
- 入口数据：本文件两份 profile 的对照 + `npm run test:e2e:perf` 的 `PERF_TURNS=45` 读数。
- 方向：稳定 prop 让 memo 生效（不是再加一层 memo），以及减少每片段的 DOM 变更量。

## 追加：把转录列表的二次方开销去掉（已改，含对照测数）

**前提已验证**：流式更新走 `messages.map((m) => m.id === streamingId ? { ...m, content } : m)`（`session-store-run-output-helpers.ts:198-213`）⇒ **已定稿消息保持对象身份**，所以「稳定 prop 让 memo 生效」在原理上可行。

**但 memo 仍会被抵掉**：scroller 的 `map` 体里每条消息、每次渲染都现算十来个值 —— `artifacts`（:792）、`messageNode`/`runtimeSegment`（:803/:806）、`synthesizedLegacyRuntime`/`runtimeIdentity`（:813/:816）、`revisions`（:825，**filter + sort 全图**）、`revisionIndex`（:838）、`activateRevision`（:841，新闭包）。稳定这些 prop 是一项独立的重构，不在本轮。

**其中一条是纯算法问题，已修**：`revisions` 原来在**每条消息里**都 filter+sort 一遍全图 ⇒ 整个列表每帧 O(N²·logN)。改成渲染时**一次性分组**（`revisionsByRootMessageId` useMemo），空值共用同一常量以免身份抖动。

- 门禁：typecheck 干净、lint 0 errors、workspace 簇 1644 passed。
- **45 轮复测（已补，`PERF_TURNS=45 npm run test:e2e:perf`，不带堆上限环境变量的构建）**：

| 指标（45 轮）         | formatter+memo 之后 | 去二次方之后    |
| --------------------- | ------------------- | --------------- |
| 流式最长阻塞任务      | 56ms                | 55ms            |
| 流式超 50ms 任务数    | 4 条                | **3 条**        |
| 流式帧间隔 p95 / 最大 | **33ms** / 51ms     | **18ms** / 51ms |
| 打字最大帧间隔        | 33ms                | **18ms**        |
| 切回重会话长任务      | 0ms                 | 0ms             |

读法：**帧间隔的改善是实的（p95 33→18ms，回到 60Hz 节奏）**；但 3 条 ~55ms 的最坏任务没动 —— 那部分就是下面说的 React 提交聚合成本，只能靠稳定 prop 让 memo 生效来消。单组对照，有运行间波动。

## 前置改造：修订分组的数组身份（已落，尚无独立测数）

**为什么先做这个**：转录列表的重渲成本要消掉，前提是能对「内容没变的消息槽」做身份相等的比较；而 `revisions` 这个数组过去在每个流式片段都被重建一次（图变了就要重分组），身份必然不同 ⇒ memo 永远失败。

**改法**：分组抽成纯函数 `groupRevisionsByRoot(messages, previous)`（`revision-groups.ts`）——内容逐元素相同（同一批实例、同一顺序）的桶直接把**上一个数组实例**还回去；成员变了才重建。scroller 用 `useRef` 保存上一次的分组结果传入。

**为什么这件事单独成立**：真实数据里已定稿消息在流式片段之间确实是**同一批实例**（`session-store-run-output-helpers.ts` 的更新是 `messages.map(m => m.id === streamingId ? {...m, content} : m)`），所以「逐元素同实例」在真实运行中成立，不是纸面假设。

**诚实边界**：这一步只是让 `revisions`/`revisionIndex` 稳定，**并不能单独提升流畅度**——消息槽还有 `artifacts`/`runtimeIdentity`/`activateRevision`（闭包）等每次渲染新建的入参，memo 仍然会被抵掉。单测钉住的是复用语义本身（同实例 ⇒ 还同一数组；成员变 ⇒ 重建），性能收益要等「把逐项派生值搬进被 memo 包住的那一层」落地后才有，届时用 `PERF_TURNS=45` 对照。

## 下一步的完整设计（**已按此执行过一遍，见文末负面结论：无效，已回退**）

**目标**：消掉 45 轮流式期间剩下的 3 条 ~55ms 最坏任务（React 提交/协调的聚合成本）。

**已确认的事实**（勿重复侦察）：

- 流式更新保持已定稿消息的**对象身份**（`session-store-run-output-helpers.ts`，`map` 只替换流式中那条）。
- `AgentMarkdown` **已经是 `memo`**（`AgentMarkdown.tsx:199`）⇒ 已定稿消息的 markdown 子树本来就不重渲；成本在 scroller 自己的逐项派生 + 提交阶段。
- 逐项派生值（`WorkspaceMessageScroller.tsx` 的 map 体）：`artifacts`(:792)、`jobsBeforeMessage`(:801，已是 memo)、`graph`(:802)、`messageNode`(:803)、`runtimeSegment`(:806)、`synthesizedLegacyRuntime`(:813)、`runtimeIdentity`(:816)、`revisionRootMessageId`(:824)、`revisions`(:825，**已稳定**)、`revisionIndex`(:838)、`activateRevision`(:841，**新闭包**)。

**执行步骤**：

1. 新增 `stable-identity.ts`：`stableArrayIdentity(cache, key, next)`（逐元素同实例 ⇒ 还旧数组）+ `stableObjectIdentity(cache, key, next)`（浅比较自身字段 ⇒ 还旧对象），各带单测（同/变两种情形）。
2. scroller 里用 `useRef(new Map())` 承接：把 `artifacts`、`runtimeIdentity` 过这两个函数；`messageNode`/`runtimeSegment` 同理（它们是 `graph`/`runtimeSegments` 里的**既有实例**，天然稳定，只要别在 map 体里重建）。
3. **闭包是最后一块**：`activateRevision` 不能靠缓存闭包（会捕获旧值 ⇒ 陈旧）。正解是把它提升为**一个稳定的 `useCallback`**，签名带上它需要的位置信息（`activateRevision(revisionIndex)`），把 `revisionIndex` 作为**独立标量 prop** 传给消息项——标量天然稳定，闭包只有一个。这一步会碰到消息项的 prop 形状，所以要同时跑它的簇测试。
4. 全绿后用 `PERF_TURNS=45 npm run test:e2e:perf` 对照本文表格；**没有对照数字就不算完成**。

**风险点**：memo 一旦生效，「本该更新的项没更新」会表现为陈旧 UI —— 必须跑 workspace 簇全量 + 认证套件里的对话/会话流用例，而不只是跑性能基线。

## 负面结论：props 打包缓存对这套指标没有可辨别的影响（已回退）

按上面的设计做完了第 2、3 步（`artifacts`/`runtimeIdentity` 走身份缓存 + 整份 props 连闭包按依赖元组缓存 + 共享空数组），门禁全绿（workspace 簇 1656 passed、typecheck/lint 干净），然后 `PERF_TURNS=45` 连跑：

|                    | 改动前（多跑）              | 改动后（含连跑复测） |
| ------------------ | --------------------------- | -------------------- |
| 流式最长任务       | 55–56ms                     | 59–61ms              |
| 流式超 50ms 任务数 | 3–4 条                      | 3 条 / 5 条          |
| 流式帧间隔 p95     | 18ms / 33ms（两态都出现过） | 19ms / 33ms          |
| 流式帧间隔最大     | 51ms                        | 50–52ms              |

**结论：两态完全重叠。** 判定为「这套指标对这一层不敏感，且/或父层传入的 handler 不稳定使 memo 依然不生效」，**不是**「已优化」。

**处置：回退**（不留没有实测支撑的复杂度）。留下的是这条判断本身：

- 长任务指标只抓得住**单个超 50ms 的任务**；45 个消息槽各做一点小渲染这种「分散成本」它天然看不见 ⇒ 想验证 memo 是否真的跳过，得**换仪器**（在开发构建里数渲染次数），而不是继续用这套帧指标。
- 在此之前，「稳定 prop」这条路**不能声称有效**；也**不应**再往这个方向堆未经验证的复杂度。

## 仪器建成：一个流式片段会重渲**全部** agent 槽位（已测出）

上面那条负面结论的补刀——先换仪器，再谈优化。仪器落在 `WorkspaceMessageScroller.interaction.test.tsx`（用例 `measures how many message slots one streaming chunk re-renders`），用现成的 markdown 渲染计数当探针：**确定性、进 CI、不受帧噪声影响**。

**实测（一个片段，4 条消息 + 1 条流式中）**：渲染的槽位是

```
['First answer', 'Second answer', 'partial more']
```

即 **已定稿的 agent 消息每次都被重渲**（用户气泡不计，它们不渲染 markdown）。这解释了长会话里「打字/滚动都跟手、唯独流式期发沉」的体感：**成本随会话长度线性增长**，而它分散在 N 个槽位之间，任何单个任务都跨不过 50ms 阈值 ⇒ **帧指标永远看不见**。

**这也回答了上一节的疑问**：那套 props 身份缓存方向是对的（问题真在「槽位整体重渲」），但当时既没有仪器、也没证明 memo 是否生效；现在有了**可判定的目标值**。

**目标值已写进断言**：这段期望应变成 `['partial more']`。改完这里即算完成，用帧指标确认不了。

## 修好了：一个流式片段现在只重渲流式中那一个槽位

有了仪器，「稳定 prop」这一步从盲改变成了红绿灯。定位过程（每一步都由仪器判定）：

1. 把 `artifacts`/`runtimeIdentity`/整份 props 连闭包按依赖元组缓存 ⇒ **仍然是 3 个槽位**，说明依赖元组每次片段都在变。
2. 仪器先抓到一个**测试自身的伪影**：我在 `Parent` 里内联传了 `vi.fn()`，每次渲染都是新函数。提成稳定引用后仍是 3 个槽位 ⇒ 真问题在组件内。
3. 查渲染层源码：`onPreviewArtifact`、`onPreviewUploadAttachment`、`onPreviewMentionArtifact`、`onOpenSkillMention`、`onOpenSessionMention` **全都在 `WorkspaceMessageScroller` 函数体里定义**，`showMentionNotice`（前两个的用户）同样是内联的 ⇒ 每次渲染都是新函数 ⇒ 槽位 prop 集合每帧变化 ⇒ 消息项的 `memo` 永远被抵掉。
4. 把这 6 个闭包改成 `useCallback`（依赖只含标量与会话 id）⇒ **仪器变绿：`['partial more']`**。

**结果**：一个流式片段只渲染流式中那个槽位，已定稿槽位被 `memo` 跳过。断言已固化为 `expect(renderedContents).toEqual(['partial more'])`，并注明回归时要往哪查（scroller 里按渲染重建的闭包）。

**回归测试**：workspace 簇 151 files / **1657 passed**；typecheck / lint 干净。

### 真机帧指标旁证：无变化（两个仪器测的不是同一件事）

干净重跑（45 轮）：`最长 62ms / 超 50ms 4 条 / 帧 p95 33ms / 峰值 50ms` —— **落回改动前的同一噪声带**。

这不是矛盾，是分工不同：

| 仪器                                                | 测什么                          | 结论                          |
| --------------------------------------------------- | ------------------------------- | ----------------------------- |
| 渲染计数（jsdom，确定性，进 CI）                    | 一个片段**碰了几个槽位**        | **3 → 1**，已定稿槽位不再重渲 |
| 帧指标（真机，噪声带 55–62ms / 3–5 条 / p95 18–33） | **单个**任务的时长 / 帧间隔峰值 | 不变                          |

读法：被消掉的是**沿会话长度线性增长的那部分总工作量**；峰值任务仍然是「流式中那一个槽位自己的渲染 + 提交」，所以长任务数与帧间隔峰值都不动。**要声称「体感变流畅」必须换一个能看见总工作量的真机口径**（例如按片段累计主线程占用、或用长会话下的输入延迟），帧指标做不到。

### 真机总量口径 A/B：修复在总量上量不出来（附原因）

新增总量仪器（`:96` 起）：用 CDP `Performance` 域的**累积**计数（`TaskDuration` / `ScriptDuration`，**不带 50ms 阈值**）取流式阶段的增量——这才是「沿会话长度增长的总工作量」。同机同口径 A/B（45 轮，脚本一次性跑完并还原）：

| 45 轮流式                | A 有闭包修复         | B 修复前（`9339ab8^`） |
| ------------------------ | -------------------- | ---------------------- |
| 主线程任务总量           | 5699ms（126.6ms/轮） | 5463ms（121.4ms/轮）   |
| 其中脚本执行             | 3756ms（83.5/轮）    | 3625ms（80.6/轮）      |
| 最长任务                 | 56ms                 | 55ms                   |
| 帧 p95 / 峰值            | 18 / 66ms            | 33 / 50ms              |
| 渲染槽位数（jsdom 仪器） | **1**                | **3**                  |

**结论：结构修复是真的（槽位 3→1，确定性可复现），但总量与峰值都量不出差异——差异量在噪声里。**

**原因（重要，别重复踩）**：jsdom 仪器里 `AgentMarkdown` 被 mock 掉了 ⇒ 等于**拆掉了它自身的 `memo`** ⇒ 已定稿槽位的重渲在那个环境里显得很贵。生产里 `AgentMarkdown` 是 `memo` 的（`AgentMarkdown.tsx:199`），已定稿槽位即使重渲，其 markdown 子树也**立刻 bail out** ⇒ 真实成本很小。所以：

- 「槽位 3→1」是**正确的结构改进**（少做无用的 bailout 比较与元素创建），**保留**；
- 但它**不是**那 127ms/轮的来源。真正的成本最大头是**流式中那一个槽位自己的 markdown 重渲**（每个片段都重新解析渲染一次），这才是下一个该动的杠杆。
- 教训：**用 mock 掉的重组件当探针时，探针会把「被 mock 组件自身的 memo 收益」一并算进成本**，从而高估这条路径的重要性。

## 流式落地的分段构成（renderer CPU profile，45 轮规格）

采样口径：`npx playwright test e2e/perf/streaming-profile.spec.ts --workers=1`，产物 `test-results/perf/streaming.cpuprofile`；按**采样归属**（每条 sample 计入其栈顶帧）聚合 self time，总计 **947ms**。

| 归属                                                                                                                                                                                        | self time | 占比      | 说明                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------- | ------------------------------------------ |
| `(program)`                                                                                                                                                                                 | 244.9ms   | **25.9%** | 浏览器内部（样式/布局/paint 等）           |
| `(idle)`                                                                                                                                                                                    | 85.5ms    | 9.0%      | 空闲                                       |
| React 渲染/提交（`beginWork`/`renderRootSync`/`updateFunctionComponent`/`commitBeforeMutationEffects`/`reconcileChildFibersImpl`/`renderWithHooks`/`propagateParentContextChanges` 等合计） | 88.8ms    | **9.4%**  | 归入 react-commit                          |
| `(garbage collector)`                                                                                                                                                                       | 38.5ms    | 4.1%      | GC                                         |
| `wrappedListener`                                                                                                                                                                           | 15.4ms    | 1.6%      | zustand 订阅者扇出                         |
| `MessageTimestamp`                                                                                                                                                                          | 12.9ms    | 1.4%      | 时间戳组件（修复后从 15.8% 降下来）        |
| `removeChild` / DOM 变动                                                                                                                                                                    | 8.3ms+    | ~1%       | DOM 增删                                   |
| 无名字的包内帧（`(anonymous)` × 5）                                                                                                                                                         | ~57ms     | ~6%       | 同包内联函数，需更细仪器                   |
| **markdown 解析/渲染**（remark/streamdown/shiki/mdast 等关键词）                                                                                                                            | **0.5ms** | **0.1%**  | ⚠️ 见下                                    |
| store 派生（`appendAgentMessageChunk`/分组等）                                                                                                                                              | 17.1ms    | 1.8%      | 投影与派生                                 |
| persistence（renderer 侧可见部分）                                                                                                                                                          | 3.6ms     | 0.4%      | 实际落盘在主进程，不在 renderer profile 内 |

**两条否定性结论（比数字更重要）**

1. **markdown 解析/渲染在 renderer 里几乎不花时间（0.1%）** ⇒ 先前「流式槽位自身 markdown 每片段重解析是 126.6ms/轮的大头」这一假设**不成立**（至少不以 JS 解析成本的形式存在）。
2. **也不存在单一热点**：最大可归属项是 React 渲染/提交（9.4%）与无名字的包内帧（~6%），其余散在 GC、DOM 增删、订阅扇出与引擎内部。⇒ 「找一个最烫的函数改掉」与「减少写入次数」两条捷径都不成立。

**下一步仪器（更高信号）**：在**开发构建**里给一次流式落地打 `performance.mark/measure` 分段——① store `set` 前后、② 订阅者通知完、③ 顶层 `<Profiler onRender>` 的 React commit 时长、④ 主进程侧 `saveSessionInOrder` 落盘（IPC 时间戳回传）。四段都拿到数之后，才决定在「渲染侧按帧节流」与「增量渲染」之间选哪个，也才知道该不该回到「写入侧」但换一种切法。

## U33 决策用归属：按调用链分桶（45 轮真机 profile，非 self-time）

方法：把每条采样沿 `parent` 链上溯，归到**最近的已知根**（React 渲染 / React 提交 / store 写入 / IPC 投递 / markdown / 定时器回调）。产物仍是 `PERF_TURNS=45 npx playwright test e2e/perf/streaming-profile.spec.ts --workers=1`。总采样 **901ms**。

| 桶                        | 时间        | 占比      | 桶内主要帧                                                                                         |
| ------------------------- | ----------- | --------- | -------------------------------------------------------------------------------------------------- |
| other（引擎内部/空闲/GC） | 448.0ms     | 49.7%     | `(program)` 201 · `(idle)` 102 · GC 34 · `query` 10                                                |
| **React 渲染**            | **295.6ms** | **32.8%** | `renderWithHooks` 49 · `updateFunctionComponent` 39 · `beginWork` 17 · **`MessageTimestamp` 15**   |
| **React 提交**            | **113.3ms** | **12.6%** | `commitHostUpdate` 28 · `updateProperties` 27 · `commitBeforeMutationEffects` 12 · `removeChild` 8 |
| IPC 投递                  | 33.4ms      | 3.7%      | `wrappedListener` 26 · `synchronizeActiveConversationMessages` 3                                   |
| 定时器回调                | 6.3ms       | 0.7%      | `elementsFromPoint` · `synchronizeActiveConversationActivities`                                    |
| **store 写入**            | **4.4ms**   | **0.5%**  | `mergeDurableUploadProjection` 2 · `setState` 1                                                    |
| markdown 解析             | ~0          | ~0%       | 关键词零命中                                                                                       |

**结论（可据此选方案）**

1. **流式期成本 45.4% 在 React 渲染+提交**（32.8% + 12.6%），**store 写入只占 0.5%**、markdown 解析≈0、IPC 3.7%。⇒ 成本取决于「**每次 delta 让多少组件重渲染 + React 写多少 DOM 属性**」，与「写了几次 store」「解析了多少 markdown」都无关。
2. 因此正确杠杆是**渲染侧按帧节流**（让 React 每帧最多提交一次，而不是每个 delta 一次），而不是把更多内容攒进一次写入。
3. **这也解释了写入侧合批为何 2.2× 变差**：当时的接线在**每个非文本事件**（工具活动/状态变化，流式期非常密集）都会 flush ⇒ 实际**增加**了 React 提交次数 ✗，同时每次内容更大 ⇒ 双输。⇒ 「合批」这个想法本身没错，错的是**触发策略**；若回到写入侧，必须按**帧**（rAF）触发而不是按事件触发——但那本质上就是「渲染侧按帧节流」，所以直接做 2 即可。
4. `MessageTimestamp` 仍是**具名组件里最贵的**（15ms）：修复（formatter 按语言缓存）把 self 从 15.8% 降到 1.4%，但它是每个 delta 都会重渲染的槽位之一，属于第 2 条要覆盖的对象。

**U33 下一版方案（有据）**：让「流中内容」以 **rAF 节流**进入 React（`useSyncExternalStore` + 帧对齐快照，或对消息列表的订阅做帧对齐批量通知），保证流式期 React 提交次数 ≈ 帧数而非 delta 数；判定仍用同一仪器与 45 轮总量，另加「最终文本逐字一致 + 真机仍在流 + 对话相关用例全绿」。

## U33 判定：渲染侧按帧节流**不成立**（先量后做，方案当场作废）

给性能探针加了「DOM 变更批次数 ≈ React 提交次数」的计数（与已有的 rAF 帧计数同源，按相位重置；`e2e/perf/smoothness.spec.ts` 的 `PROBE`）。45 轮真机结果：

| 相位         | 提交近似数 | 帧数 | 提交/帧  |
| ------------ | ---------- | ---- | -------- |
| 流式 45 轮   | **267**    | 411  | **0.65** |
| 打字进输入框 | 51         | 130  | 0.39     |
| 滚动转录     | 0          | 49   | 0.00     |

**结论**：流式期的 React 提交**比帧还稀疏**（0.65 < 1）⇒ 「每帧最多提交一次」的节流**无空间可省**，最多省掉 ~35% 且会引入延迟与正确性风险 ⇒ **「渲染侧按帧节流」这条路否决**。

与前面的归属合起来看：45.4% 花在 React 渲染+提交上，但提交**并不频繁** ⇒ 成本在**每次提交有多贵**（一次提交要把整条转录的组件树走一遍：`renderWithHooks` 49ms、`updateFunctionComponent` 39ms、`beginWork` 17ms、`updateProperties` 27ms、`commitHostUpdate` 28ms），而不是「提交了多少次」。⇒ **正确的问题变成「一次 delta 提交时，到底有多少组件真的重渲染了（而不是 bail out）」**——渲染计数仪器（jsdom，`WorkspaceMessageScroller.interaction.test.tsx`）正是为此存在的，下一步把它扩展到真实提交路径上。

**同时记录一处数据矛盾（不掩盖）**：本轮回退后的基线读数为 `task=5162ms / 114.7ms 每轮`，而先前"接线版"读数为 `12554ms / 279.0ms 每轮`（同一仪器、同一规格）。两次相差 2.4×，但按今天的基线看，接线版当时**可能**叠加了机器负载或陈旧构建，因此「合批导致 2.2× 变差」这一结论**证据强度不足**，不应作为路线否决的唯一依据；写入侧合批的真正否决理由改为：store 写入只占 0.5%，**该路线即使成立也无收益可图**（这条与负载无关）。

## U33 定位：流式提交里真正跑起来的应用组件（45 轮 profile，self time）

从同一份 profile 里剔除 React 内部帧与浏览器帧，剩下的应用侧帧：

| 帧                                                                          | self          | 判读                                                                            |
| --------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------- |
| **`MessageTimestamp`**                                                      | **14.1ms**    | 应用侧最贵；formatter 缓存已把它从 15.8% 压到 1.4%，但它仍然每个 delta 都走一遍 |
| `renderRootSync` / `commitBeforeMutationEffects`                            | 13.3 / 11.5ms | React 内部（列表提交）                                                          |
| `reconcileChildren` + `reconcileChildrenArray` + `reconcileChildFibersImpl` | ~20ms 合计    | 列表协调（~90 条消息，属预期）                                                  |
| **`react_production.cloneElement`**                                         | **7.5ms**     | ⚠️ 渲染路径里有人 `cloneElement`——按条触发，属于可去掉的重复工作                |
| **`TooltipTrigger2`**                                                       | **5.9ms**     | ⚠️ 每条消息一个 tooltip 触发器，跟着列表一起重渲染                              |
| **`WorkspaceMessageItemImpl`**                                              | **3.1ms**     | 消息项本身                                                                      |
| `MessageScrollerItem`                                                       | 2.4ms         | 滚动项包装                                                                      |
| `synchronizeActiveConversationMessages` / `…Activities`                     | 2.1 / 2.0ms   | 订阅同步                                                                        |
| `sameOwnFields`                                                             | 1.8ms         | 比较函数                                                                        |

**由此得到三个具体、低风险的改动目标**（都不涉及节流，也不需要改写入侧）：

1. **`cloneElement`（7.5ms）**：找到热路径上的克隆点（多半在消息项/tooltip 包装里），改成直接构造元素或提前 hoist。
2. **`TooltipTrigger2`（5.9ms）**：每条消息的 tooltip 触发器不应随列表重渲染——按需创建（仅悬停/聚焦时）或提到列表外。
3. **`MessageTimestamp`（14.1ms）**：formatter 已缓存，剩下的是组件本身的重渲染——用稳定 props + `memo` 让它在内容未变时 bail out（同一槽位在流式期间只有它自己该重渲染）。

判定口径不变：同一仪器（45 轮总量 + 提交计数 + 帧指标）+ 最终文本逐字一致 + 真机仍在流 + 对话相关用例全绿。

## U33 目标 ①/② 同源：`cloneElement` 来自 Radix tooltip，且**每个按钮各带一个 Provider**

- 全仓 `src/renderer/src` 里**第一方零处 `cloneElement`** ⇒ profile 里的 `react_production.cloneElement`（7.5ms）来自 **Radix `TooltipTrigger asChild`**（Radix 用它把事件 props 注进子元素），即目标 ① 与 ②（`TooltipTrigger2` 5.9ms）是同一件事。
- 源头定位：`pages/workspace/WorkspaceMessageItem.tsx:457-472` 的 `UserMessageActionTooltip` **自带 `TooltipProvider` + `Tooltip` + `TooltipTrigger asChild`**；该 helper 在本文件有 **11 处用法**（`:1022/1036/1115/1137/1176/1190/1214` 等），而其中一组外面（`:1020`）**又套了一层 Provider** ⇒ 同一屏内 Radix context 层数是「用法数 + 1」，与 `propagateParentContextChanges`（2.8ms）和两处 `commitHostUpdate` 吻合。
- `components/ui/tooltip.tsx` 只是 Radix 原语直出（**不含 Provider**）⇒ 这些显式 Provider 不是冗余样例，去掉会改变「同组 tooltip 共享 200ms 延迟」的行为，必须保留语义。

**修法（已定，实施要在能跑完整门禁的环境里做）**：把「每个用法一个 Provider」收敛为「**每个消息项（更好：每个列表）一个 Provider**」——即从 `UserMessageActionTooltip` 里删掉 `TooltipProvider`，在消息项/转录根各放一个；语义（同组共享 delay）不变，Radix context 层数与 `cloneElement` 触发次数从「用法数」降到「1」。判定同上（同仪器 + 45 轮总量 + 用例全绿）。

## U33 目标①/②实施结果：结构改进成立，**性能量不出**（如实记录）

改动：`WorkspaceMessageItem.tsx` 的 `UserMessageActionTooltip` 不再自带 `TooltipProvider`，改为**每个动作簇一个**（用户动作簇与修订导航簇原本已有；**agent 动作簇原本一个都没有**，本次补上）。语义不变（同簇共享 200ms 延迟），Radix context 层数与 `cloneElement` 触发次数从「用法数（本文件 11 处）」降到「每簇 1」。

**门禁**：typecheck 0 error、lint 0 error、workspace 簇 **1657 passed**。

**复测（45 轮，同一仪器）**：

| 指标               | 改动前           | 改动后               | 判读                                  |
| ------------------ | ---------------- | -------------------- | ------------------------------------- |
| 主线程 task / 每轮 | 5162ms / 114.7ms | 5336ms / **118.6ms** | 噪声带内（历史观测 114.7–126.6 皆有） |
| 提交近似数         | 267              | 273                  | 噪声                                  |
| 帧 p95 / max       | 18 / 51ms        | 18 / 50ms            | 持平                                  |

**结论**：该目标绝对量约 13ms/901ms ≈ **1.4%**，**低于仪器可辨别阈值**（噪声带约 ±10%）。因此本次改动按「结构正确、量不出体感」保留，**不声称性能收益**——与 `9339ab8`（闭包稳定化）同类。若要在这条线上继续，必须挑**量级足够大**的目标：`MessageTimestamp`（14.1ms）与列表 reconcile（~20ms）属同一量级，加起来仍只有 ~4%；**真正的量级问题是「一次提交要走完整条转录」本身**，需要结构性方案（例如流式期间只让「流中那一条」进入重渲染路径，把已定稿部分移出协调范围），而不是逐个组件抠毫秒。

## U33 结构性改造落地：一个流式片段只重渲正文那一条（订阅方与列表容器 0 重渲）

上面最后一行就是本节的立案理由。现在做完了，且**这次量得出来**——因为它动的不是几毫秒，而是「每个 delta 走完整条转录组件树」这件事本身。

### 改动（结构性，非抠毫秒）

| 位置                              | 改动                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `use-render-sessions.ts`（新）    | 工作区对 `state.sessions` 的订阅改为 `useSyncExternalStore` + 每实例 ref 快照：**只有流式正文变了**就返回上一份快照（身份不变）⇒ 页面不再每 delta 重渲                                        |
| `transcript-render-identity.ts`（新） | `carriesSameTranscriptStructure` / `carriesSameSessionListStructure`：own-key 枚举比较，忽略 session `updatedAt` / `messages` / `branchSwitchBlocked`，以及**流中那条消息**的 `content`/`eventIds`/`updatedAt`；未知差异一律判为「需要重渲」（安全方向：漏判只是少一次优化，不会显示旧内容） |
| `message-content-subscription.ts`（新） | `selectLiveMessageContent`（从 store 取该消息正文）+ `resolveMessageContent`（store 值不是「渲染时正文的延续」时保留渲染时的正文）                                                     |
| `WorkspaceMessageItem.tsx`       | 正文改由**自订阅叶子**从 store 读（容器道具跨 delta 保持不变，正文不能再走道具）；5 处 `message.content` 读取点全部改走它                                                          |
| `WorkspaceMessageScroller.tsx`    | 把 `sessionId`（**不是正文**）交给消息项；比较器换用共享的 `carriesSameTranscriptStructure`（原 `areSessionsEqualForTranscript` 只忽略 `branchSwitchBlocked`）                    |
| `WorkspacePage.tsx`               | `state.sessions` → `useRenderSessions()`；转录之外**读正文**的入口（导出 / 产物下载 / 打包导出）改为从 store 解析活会话，避免导出中途的旧快照                                     |

### 仪器（新建面板级 harness，进 CI、确定性、秒级）

`src/renderer/src/pages/workspace/ConversationPanel.transcript-render.test.tsx` —— 真 store + 真面板 + 真 scroller（照 `ConversationPanel.interaction.test.tsx` 的道具清单，**删掉它那处 `vi.mock('./WorkspaceMessageScroller')`**），40 条已定稿消息 + 一整轮流式，经 store 真实入口喂 delta。

**仪器坑（写下来给后来人）**：`<Profiler>` 对**已 bail out 的子树仍会触发 `onRender`**（实测 bail-out 时仍报 1）⇒ 它不能当「谁重渲了」的判据。改用**渲染探针**：给容器挂一个它每次渲染都会新建的子元素（面板 = 恒渲染的 `TrimmedHistoryNotice`，列表容器 = `MessageScrollerProvider` 替身，叶子 = 喂给 `AgentMarkdown` 的正文），「子元素被重新渲染过」即「容器的 body 跑过」。`<Profiler>` 的数仍在输出里并列，作为反面对照。

### 改前 / 改后（同一 jsdom 仪器，单位 = 每个 delta 的重渲次数）

| 组件                    | 改前 | 改后 | 说明                                                     |
| ----------------------- | ---- | ---- | -------------------------------------------------------- |
| `ConversationPanel`     | 1    | **0** | 页面订阅不再因正文变化而重渲                                 |
| `WorkspaceMessageScroller` | 1 | **0** | 列表容器连「逐条 map 生成元素」都不再发生                    |
| 正文叶子                | 1    | **1** | 正是要保留的那一次（每个 chunk 只重渲流中那一条的正文）        |
| `slot` 重渲名单          | `['reply-streaming']` | `[]` | 槽位由自订阅驱动，不再由容器道具驱动 |

### 真机 45 轮（同日同机 A/B，`557deaf`（改前）与 `8428602`（改后）交替构建，同一仪器）

| 运行 | 构建 | 主线程 task / 45 轮 | 每轮 task | 每轮 script | 提交近似数 |
| ---- | ---- | ------------------- | --------- | ----------- | ---------- |
| 1    | 改前 | 5276ms              | 117.2ms   | 76.9ms      | 269        |
| 2    | 改前 | 5423ms              | 120.5ms   | 79.4ms      | 274        |
| 3    | 改后 | 4508ms              | **100.2ms** | 61.0ms    | 265        |
| 4    | 改后 | 4241ms              | **94.2ms**  | 57.3ms    | 249        |
| 5    | 改后 | 4751ms              | **105.6ms** | 64.8ms    | 271        |

**判读**：改前带 117.2–120.5（均值 118.9），改后带 94.2–105.6（均值 100.0）——**两带不重叠**，每轮 task **约 −16%**、每轮 script（JS 执行）**约 −22%**。历史基线 114.7 / 118.6 / 126.6 全在改前带内 ⇒ 差值来自本次改动，不是机器抖动。提交数几乎不变（249–274 ⇒ 265–271）：**提交还是那么多，但每次提交背后的工作少了一整条转录树的走路**——这与帧指标（p95 18ms，本来就正常）不矛盾，也解释了为什么以前在帧指标上量不出来。

### 有意保留的代价（写清楚，别当成 bug）

1. 经 `useRenderSessions` 读到的会话在**正文之外**最多一个 delta 陈旧：会话 `updatedAt`（侧栏相对时间、`SessionInfoCard` 的「更新于」）在流式期间滞后到上一次结构性变化。结构性字段（标题/状态/审批/产物）照旧即时。
2. **读正文的入口必须取活数据**：已改的是导出 / 产物下载 / 打包导出。
3. `resolveMessageContent` 的延续守卫：store 里的值若**不是**渲染时正文的前缀（隔离面/代际不同的快照/被回撤的 chunk），保留渲染时的正文 ⇒ 最坏是「一帧旧文本」，等下一次结构性变化刷新，不会出现与周围转录矛盾的画面。

### 判定（计划里的四条验收）

| 验收项                                          | 结果                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| ① 仪器断言「订阅方与列表容器 0 重渲 + 叶子 1 次」 | ✅ 断言已收紧到 `panel 0 / scroller 0 / slots [] / markdown ['partial more']` |
| ② 真机 45 轮总量下降                             | ✅ 同日 A/B：117.2–120.5 → 94.2–105.6 ms/轮（−16%），两带不重叠             |
| ③ 最终文本逐字一致                               | ✅ `e2e/workspace-conversation.spec.ts` 用 `{ exact: true }` 断言用户消息与答复全文，含改消息、修订切换与**重启后**从持久化重载 |
| ④ 真机仍在流 + 对话相关用例全绿                   | ✅ 45 轮流式跑通（每轮都等到了完整答复）、`npm run test:e2e:workspace` 8/8、`npm run test:gate` 14426 passed / 0 failed |

**④ 的加强证据（一次性真机探针，跑完已删）**：仓库现有 e2e 都只断言「回合结束后答复在屏」，而**回合结束本身是结构性变化**——就算正文订阅断了，结束那一刻道具重铸、正文照样会出现。所以另写了一个探针用 fixture 的中断回合（投递部分答复后**永不结束**）：在 `Cancel run` 仍在屏（回合确实在飞）时读转录 DOM，得到
`"…Continue the interrupted turn fixture.Sent Sep 25, 11:10 PMPart of the answer arrived before the app went down."`
⇒ 部分答复在**流式期间**就在屏上，正文订阅这条链路在真机上是通的（探针 26.1s 通过，随后删除）。

**顺带修掉的既有红**：`e2e/launch-environment.spec.ts:14` 仍断言 `PURESCIENCE_E2E_STORAGE_ROOT` 为 `undefined`，而 fixture 自 `3335d23` 起**每次启动都设置它**（注释写明「Set it for every run」）⇒ 陈旧断言，与本次改动无关，一并更正。

### 相邻订阅方：plan 预览也曾每 delta 重渲（已一并收窄，先量后改）

`previews/PreviewToolContent.tsx` 原本 `useSessionStore((state) => state.sessions.find(...))` 拿的是**整个 Session 对象** ⇒ chunk 换对象就重渲，连带重跑整块 plan 投影的渲染。仪器 `PreviewToolContent.stream-render.test.tsx`（jsdom + 真 store + 计数探针 = 该组件每次渲染都会新建的 `PlanPreviewSurface`）：

| | 一个 chunk 引起的 plan 面重渲 |
| --- | --- |
| 收窄前（选 Session 对象） | **1** |
| 收窄后（各字段单独选：`activePlanProjection` / `planHistoryProjections` / session 是否存在 / 是否可批准） | **0** |

同一 fixture 下 A/B（把组件 `git stash` 回旧写法再跑一次）得到 1 vs 0；「投影本身变化 ⇒ 重渲一次」的对照用例两种写法都过（说明收窄没有把该响应的情况一起冻掉）。

**测量中发现的既有行为（只记录，未改）**：`projectAgentMessageChunk` 会把 `status` 从 `waiting-plan-approval` 改成 `running`（只保留 `waiting-permission`）⇒ 若某个 chunk 真的落在「等计划批准」期间，批准按钮会消失。实测这条路径在本仓不可达（等批准时 agent 不再发 chunk），故不作为本次改动的一部分。

### U33 之后再次归因（45 轮规格，3 个流式回合采样 767ms，当前构建）

仪器：`PERF_TURNS=45 npx playwright test e2e/perf/streaming-profile.spec.ts --workers=1`（跑前 unload launch agent），分析用 `perf-profile-buckets.py`（分桶）+ `perf-profile-by-component.py`（**按独占时间归属到 app 组件**，新脚本：React 内部帧的 self time 是所有组件的总和，直接看 self time 无法定位组件）。

| 归属                                   | 独占时间      | 占比  | 读法                                                                 |
| -------------------------------------- | ------------- | ----- | -------------------------------------------------------------------- |
| （不在任何组件内）                      | 301.2ms       | 39.3% | 流式阶段的事件/IPC 投递、DOM、浏览器内部 —— 已不是「某个组件」的问题    |
| `performSyncWorkOnRoot` 等 React 根/调度 | 92.4 + 11.2ms | 13.6% | React 自己的 commit/reconcile 机制，量随「一次提交里有多少组件要走」而定 |
| `commitMutationEffectsOnFiber`          | 44.6ms        | 5.8%  | 提交阶段写 DOM                                                        |
| `wrappedListener`                       | 28.9ms        | 3.8%  | IPC 监听器投递                                                        |
| **`MessageTimestamp`**                  | **12.5ms**    | **1.6%** | **本轮之后最大的具名 app 组件**（≈4ms/轮，远低于可辨别阈值）           |
| `TooltipTrigger2`                       | 4.9ms         | 0.6%  | Radix 触发器（Provider 层数已在早前一轮收敛）                          |
| `synchronizeActiveConversationMessages` | 4.9ms         | 0.6%  | 会话同步                                                              |

**判读**：U33 之后**没有单个值得动手的 app 侧目标** —— 最大的具名组件 1.6%、约 4ms/轮，低于「量得出来」的门槛（早前 `MessageTimestamp` 一类已在 −1.4% 量级的实验里被证过不可辨识）。剩下的两块是 React 自身的提交机械（随**结构性**更新 —— 工具活动/状态变化 —— 走的组件数量而定）与 IPC 投递，都属「另起一条线」的量级，不是继续抠组件能拿到的。

**跑这台仪器时注意（别去优化它们）**：`query` / `elementText` / `checkVisibility` / `isElementHiddenForAria` / `querySelectorAll` 这几帧是 **Playwright 自己**在轮询定位器（`getByText` 等），不是应用开销 —— 夹具用真实文本等待答复时它们必然出现在 profile 里。

**同时确认**：本轮修完后真机 45 轮为 **104.9ms/轮**（第 4 次运行），仍在改后带内（94.2–105.6）。

## 下一层：一次流式回合到底往渲染进程发了多少东西（先量，未改）

U33 之后 app 组件层面已无单点可抠，于是换仪器量**每回合的 IPC 内容量**：探针挂到主进程，包住每个 window 的 `webContents.send`，按频道统计次数与字节数（`e2e/certification/echo-probe.spec.ts`，临时文件，读完即删；夹具用 `PURESCIENCE_E2E_STREAM_CHUNKS=40` 让一回合的答复分 40 块流回，这才是真机流式的样子——默认夹具一次性发整段答复，把每块的成本全藏起来了）。

一回合 = 40 块，可见正文≈0.7KB：

| 频道            | 次数/回合 | 单条字节      | 回合合计    | 读法                                                    |
| --------------- | --------- | ------------- | ----------- | ------------------------------------------------------- |
| **`acp:state`** | 40/26/32  | **7.5→30KB**  | **294KB→941KB** | 每块一次，且**随转录增长**：整份状态快照，不是增量        |
| `acp:event`     | 33/24/28  | ≈400B         | 10–13KB     | 事件通道本来就是薄的                                     |
| `session:updated` | 29/19/26 → **2/1/1** | 6–16KB | 178–374KB → **11–16KB** | 见下：本轮已收（保存回声）                    |

### 本轮已收：保存回声（19–29 次/回合 → 1–2 次/回合）

渲染进程每块都存一次会话，主进程存完就把**整份会话**广播回所有窗口（`session:updated`，`{session, originClientId}` 里带的是整份 `PersistedChatSession`），发起窗口自己刚写过也要收一遍。改前占 3 回合采样里 `wrappedListener`（Electron preload 桥）233ms + 监听器本体 197ms ≈ **23%**，是当时最大的 app 侧桶。

改法（`session-persistence.ts` 的 `saveLatestSession`）：队列原本只合并「上一笔还在飞」的快照，而本地写比 chunk 间隔快得多，所以几乎每块都写出去了。现在给每个 target 加**350ms 合并窗**：窗内到达的新快照替换待写快照（最新状态胜，调用方共享同一次写的 promise），窗外的第一笔照旧立即写（改标题、回合第一块、恢复会话都有即时写回）；显式写与 `flush()` 先释放待写项而不是丢弃它（丢弃会挂住调用方 promise 并丢掉最新状态）。强制路径（回合结束/退出/删除）走 `saveSession`，不经过这里，所以持久性屏障不受影响。

**实测（40 块/回合）**：回声 29/19/26 → **2/1/1**，回声字节 178/198/374KB → **13.6/10.9/16.3KB**；真机 45 轮 `task` 323.6 → **308.2ms/轮**（script 130.2 → 120.3ms）。

**诚实读法**：本轮拿到的是「**浪费掉的工作**」的大头（每回合十几到二十几次整份会话往返，每次 6–16KB），但流畅度指标只动了 ≈−4.8% —— 因为剩下的大头是**合法的每块投递**：`acp:state` 每块一次、单条 7.5–30KB、回合合计 294–941KB，是同一转录的**整份快照**。它才是 `wrappedListener` 那 23% 的主要来源。

### 本轮已收：每块一次的 `acp:state` 整份状态快照

`acp:state` 是**整份运行时状态**（含 `events` 全量事件日志、权限表、在飞标记），每次状态变化就广播一次——流式下等于**每块一次**，且随转录线性变胖。渲染端拿到它就 `setState`（`useAcpRuntime`），而 `useWorkspaceAgentRuntime` 的 effect 依赖 `runtime.state.events`，于是**每块都要把整段事件日志再走一遍**。所以同一份状态在每块上花了三遍：过桥反序列化、React 重渲、全量事件重扫。

改法（`src/main/latest-snapshot-broadcast.ts`，接法与既有的 `acp:event` 准入闸并列）：快照通道加 **150ms 最新值窗**——窗外第一笔立即发（连接、权限、回合结束这类孤立变化不吃延迟），窗内只保留最新快照并在窗尾发一次。**安全性来自通道语义**：快照是「整份覆盖」，且带着**完整**事件日志，所以被折叠掉的中间快照没有任何信息是最后一份没有的。

| 40 块/回合                 | 改前                              | 改后              |
| -------------------------- | --------------------------------- | ----------------- |
| `acp:state` 次数            | 40 / 26 / 32                      | **5 / 3 / 2**     |
| `acp:state` 字节            | 294 / 494 / 941KB                 | **32 / 66 / 68KB** |
| **过桥总字节/回合**         | **310 / 505 / 955KB**             | **62 / 86 / 109KB** |
| 真机 45 轮 task             | 323.6ms/轮                        | **91.5ms/轮**     |
| 真机 45 轮 script           | 130.2ms/轮                        | **59.1ms/轮**     |
| React 提交批次              | 1568（≈35/轮）                    | **278（≈6.2/轮）** |

提交批次降到 6/轮正是证据：**每块一次的快照 `setState` 引发的重渲消失了**，剩下的 6 次是文本自己按块到达后被渲染端合并的提交（`acp:event` 仍是 31–33 条/回合，速率未变）。

**渐进显示未受影响（已实测）**：临时探针（从渲染端挂 MutationObserver 记录每次 DOM 变更时的正文长度）量到 38 次变更批次、长度逐步增长（367→369→359→361→363…，中间态 ≥2）——本次改动没有靠「攒到最后一起上屏」换性能。注意：用 Playwright 轮询量渐进性是**测不出来**的，它的第一次查询就已经看到完整答复（那正是第一版探针误判的原因）。

**代价**：快照类状态在连续变动时最多滞后一个窗口（150ms）；文本不走这条通道，逐字感不受影响（已实测）。

**新增常驻仪器**：`e2e/perf/ipc-traffic.spec.ts`（主进程侧统计每条频道的次数与字节，默认 40 块/回合；不进认证矩阵，理由同其他 perf spec）。
