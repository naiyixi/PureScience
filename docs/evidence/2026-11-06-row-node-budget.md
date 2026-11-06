# 每行 DOM 节点数的读数（2026-11-06）

> 上一笔（`83636513`）的结论是：长会话变贵不在「做了多少次」——`rows/commit` 恒 0.28、`rowRendersPerTurn`
> 恒 3.00，40 与 160 回合一样——而在「每次做多贵」，代价正比于文档里的元素总量。那条结论把下一步写成
> 「唯一剩下的杠杆是每行更少的 DOM 节点，收益要用元素计数（`domNodes` / 每行节点数）证明再动手」。
> 本档就是先把那把尺子做出来、并取到第一份读数：**只改仪器，不改产品**。

## 一 仪器（`e2e/perf/render-count.spec.ts` 末尾新增两行读数）

- `[row-nodes]`：行数、节点总数、**每行中位节点数**（并拆成 `body` / `chrome`），外加全局标签前八名。
- `[row-nodes-slots]`：节点按**最近的 `data-slot` 祖先**归桶，用来回答「这些节点挂在哪个控件上」。
- 两处口径细节（都是实测踩出来的）：
  1. **只数最外层行**。同一个消息 id 同时挂在滚动库包装层与行根上（`c8bd323e` 的发现），裸
     `[data-message-id]` 选择器会把每个节点数两遍：第一版读数 `rows=168 total=4564`，去重后是
     `rows=84 total=2614`，同一份页面差 1.7 倍。
  2. `body` = `assistant-message-body` / `user-message-bubble` 子树内的元素；`chrome` = 行的其余部分。

跑法：`npm run build:e2e && PERF_TURNS=40 npx playwright test e2e/perf/render-count.spec.ts --reporter=line`
（160 档把 `PERF_TURNS=160`）。计数**不随宿主负载变化**，所以两档可以直接比。

## 二 读数（本机，同一个 e2e 产物 `a06a4ac2`，两次运行）

| 回合 | 行数 | 节点总数 | 每行中位 | body | chrome | CDP `RecalcStyleCount` / `Duration` | `TaskDuration`（同批次对照） |
| ---- | ---- | -------- | -------- | ---- | ------ | ----------------------------------- | ---------------------------- |
| 40   | 84   | 2,614    | **31**   | 3    | 28     | 25 / 14 ms                          | 113 ms                       |
| 160  | 324  | 10,102   | **31**   | 3    | 28     | 26 / 16 ms                          | 214 ms                       |

`[row-nodes-slots]`（160 档，324 行）：`message-scroller-item=3298`、`user-message-actions=1458`、
`assistant-message-actions=810`、`branch-in-new-session=810`、`assistant-message-body=648`、
`turn-token-usage-icon=648`、`user-message-bubble=486`、`assistant-message-bookmark=486`。
标签前四名：`div=3183`、`path=1868`、`svg=1258`、`span=1220`（图标一个 = `svg` + `path`，实测每行约 3.9 个）。

两条结论：

> **2026-11-07 更正**：下文的 `median=31 (body=3 chrome=28)` 是对**混合行**取中位（agent 行与用户行混在一起），
> 31 既不是 agent 行也不是用户行 —— 当时 agent 行是 45（body 3 / chrome 42）、用户行是 19。
> 富 markdown 语料重取见 `2026-11-07-row-node-budget-rich-corpus.md`：agent 行 **152（body 110 / chrome 42）**，
> body 占 **72%**。所以下面「chrome 占 90%」是**单句语料的性质**，不是产品性质。

1. **每行节点数是常数（31），不随会话变长**。长会话变贵的机制因此确认是「行数线性增长 × 单价」，不是
   「每行越来越胖」——这排除了「行内某个列表/历史累积」这一类猜测。
2. **在本夹具语料里，28/31 是 chrome**，其中 `lucide` 图标（`svg`+`path`+`circle`/`rect`）约占 12 个/行。

## 三 边界（不许读成更强）

- **夹具的回复是一段短纯文本**（`AgentMarkdown` 只产 3 个元素），所以 `body=3` 是**下界**、chrome 占比 90%
  是**上界**。真实会话里的代码块/表格会让 body 显著变大，chrome 的占比随之下降。要判断「哪一半值得动」，
  下一步得让夹具产一份富 markdown 回复——**本轮没做，具名未办**。
- 本档**没有改任何产品代码，也没有声称变快**：读数只是把下一步的判据（节点数）立起来。虚拟化已在
  `83636513` 用同一套计数证伪（阈值 150→24 后 80 回合 103.5 → 199.0 ms），`content-visibility` 早已开着。
- `TaskDuration` 一行是**同批次的相对对照**，不是预算判决：本机当时宿主 load 6.1–17.1、swap 占用高，绝对值
  在不同日子能差两倍以上（`2026-11-04-perf-baseline.md` §0 的 n≥3 中位数口径仍然适用）。
