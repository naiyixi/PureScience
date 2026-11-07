# 剖析榜上的四个「应用热点」其实是量具自己 —— 等待模式对照读数（2026-11-07）

> 判据问题：`e2e/perf/profile-turns.spec.ts` 的函数自我耗时榜，在 80 回合那次读数里出现了
> `isElementHiddenForAria` / `elementText` / `querySelectorAll` / `query` / `normalizeWhiteSpace`
> 一簇「像有人在整篇文档上算可访问名」的帧，并据此写下「下一步要定位是谁在调用」。
> 本轮不改产品代码，先用**同一场景、同一提交、只换等待模式**的两读数把这一簇归位。

## 一 方法

- 提交：`68a3a8b9`（本轮未改产品代码，只改量具：见 §四）。
- 构建：隔离工作树 `/private/tmp/ps-r297`，`NODE_OPTIONS=--max-old-space-size=8192 npm run build:e2e` → `built in 39.12s`。
- 场景：`PERF_TURNS=40`，一次预热回合不计入；两读数**背靠背**跑在同一台机器、同一份产物上。
- 差别只有一个：回合之间等答复的方式。
  - `PERF_WAIT=text`（旧的缺省）：`getByText('Deterministic reply').count()` 轮询 —— 文本定位器在**页面内**
    解析、比对文本、判可见性，这些工作落在渲染主线程上，也就是落在被测窗口里。
  - `PERF_WAIT=selector`（本轮改成的新缺省）：只数 `[data-slot="assistant-message-body"]` 的节点个数。
- 机器负载（必须与读数一起看，否则绝对值会被误读）：`load averages 6.02`、交换区
  `used 10.28G / 11.26G`、空闲页 3 567（≈56 MB）⇒ **绝对毫秒在本机不可比**，可比的只有
  「同一对读数里的占比」与「0 与非 0」。

## 二 读数（两次运行，各 `1 passed`，18.6 s / 14.6 s）

分母是**活跃时间**（采样总时长减掉 `(idle)`）：

| 帧 | `wait=selector`（应用侧） | `wait=text`（旧的缺省） |
| --- | --- | --- |
| `elementText` | **0.0 ms · 0.0%** | 68.4 ms · 2.6% |
| `query` | 9.1 ms · 0.4% | 45.5 ms · 1.7% |
| `normalizeWhiteSpace` | **0.0 ms · 0.0%** | 32.6 ms · 1.2% |
| `shouldSkipForTextMatching` | **0.0 ms · 0.0%** | 25.7 ms · 1.0% |
| `isElementHiddenForAria` | 0.0 ms · 0.0% | 0.0 ms · 0.0% |
| `querySelectorAll` | 37.7 ms · 1.7% | 42.0 ms · 1.6% |
| `propagateContextChanges` | 54.2 ms · 2.4% | 54.7 ms · 2.1% |
| `removeChild` | 75.6 ms · 3.4% | 62.5 ms · 2.4% |
| `commitHostUpdate` | 31.4 ms · 1.4% | 41.9 ms · 1.6% |
| `updateProperties` | 36.3 ms · 1.6% | 27.1 ms · 1.0% |
| 采样 / 活跃 | 9 458 ms / 2 233 ms | 6 707 ms / 2 626 ms |

四项（`elementText` + `query` + `normalizeWhiteSpace` + `shouldSkipForTextMatching`）合计：
**`selector` 9.1 ms / 0.4%，`text` 172.2 ms / 6.6%**。

同一提交上，改动前那次缺省模式的读数（同一场景）是
`elementText 74.3` / `query 50.5` / `normalizeWhiteSpace 47.4` / `shouldSkipForTextMatching 28.3`，
合计 **200.5 ms / 活跃 2 609 ms = 7.7%**（74.3 + 50.5 + 47.4 + 28.3）—— 与上表同向、量级一致。

## 三 结论（三条，都能被上面两列各自否掉）

1. **这一簇是量具，不是产品。** 只把等待方式换掉，四个帧里三个从「榜上第 4–7 位」直接掉到 **0.0 ms**，
   `query` 只剩 9.1 ms。它们来自文本定位器在页面内的文本/可见性计算
   （`dom-accessibility-api` 那条路径），不是应用在算可访问名。
2. **`isElementHiddenForAria` 在本场景根本没复现**：两列都是 0.0 ms，包括被污染的那一列。所以立项档里
   把它与 `elementText` 并列写成同一个方向，是把两次不同场景的读数拼在一起了 —— 撤回该方向。
3. **`querySelectorAll` 在「干净」那一列仍有 1.7%**，那是**结构性等待自己**每 200 ms 数的
   `document.querySelectorAll` ⇒ 量具在干净模式里也不是零成本，引用这一列时同样要说明。

**因此：** 剩下的是应用自己的活，且**没有单点热点** —— `(program)` 777.7 ms（占活跃 **34.8%**，
V8 + 布局绘制）、`removeChild` 3.4%、`propagateContextChanges` 2.4%、`updateProperties` + `commitHostUpdate` 3.0%、
`renderWithHooks` 1.8%。这与本仓既有结论一致（增长在「每回合重算的单价」，不在「次数」），
也解释了为什么 P1-c（`revisions` 那一位）预期收益很小：渲染次数中位已降到 2，再挪一位 map 改不了
`removeChild`/`(program)` 这两项。**P1-c 不做**，理由记在立项档；要动就得先有「哪一段可归因」的读数，
而本轮证明现有的榜在没有等待模式标注时不可用于归因。

## 四 量具改动（`e2e/perf/profile-turns.spec.ts`）

1. **缺省改成结构性等待**（`PERF_WAIT=text` 仍可复现旧模式）。理由写在文件头：自耗时榜会被读成
   「应用在这里花时间」，而这个工具此前会把量具自己的帧放进榜里。
2. **每次读数都打印 `[profile] wait=<模式> turns=<n>`**：读数从此带着模式走，不能被单独引用。
3. **新增 `[watch]` 十行**：把上面这些帧按名字打印「毫秒 + 占活跃时间的百分比」，两模式可直接对比，
   不再依赖「是否进得了前 20」这种截断判据。

## 五 边界（不许读成更强）

- **绝对毫秒不可比**：本机 load 6.02、交换区用掉 10.28 G。本轮只主张**同批两列之间的差**与
  「0 与非 0」，不主张「每回合成本是 X 毫秒」。
- **没有实时性结论**：40 回合、单句回复语料（body 占 7%）仍是**下界**，富语料的绝对量见
  `2026-11-07-row-node-budget-rich-corpus.md`。
- **没有改任何产品代码**：本轮不声称流畅度改善，只把「下一步查什么」从一条错的线索上挪开。
- `isElementHiddenForAria` 在别的场景（角色/名称定位的 spec）可能真的出现，本轮**只否掉它在本场景**。
