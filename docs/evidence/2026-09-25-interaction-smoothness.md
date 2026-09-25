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
