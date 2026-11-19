# CJK 基准的延迟门改成确定性切分门（2026-11-19）

## 一、读数是哪来的

`118de549` 的 Nightly（run `44442409165`，作业 `build / Verify (lint + typecheck + test + package)` = failure）
**只有一个失败点**：

```
FAIL unit src/shared/global-search-cjk-bench.test.ts > … > latency >
     answers a query over 2,000 documents inside 20ms at the 95th percentile
AssertionError: expected 62.31595799999923 to be less than 60
```

同一份代码在本机（安静时）是 **21–22 ms**；CI runner 上是 **62.3 ms**。阈值 60 与实测只差 2 ms ——
按仓库自己的性能口径（`references/perf-gates.md` §1–§2），**贴线的墙钟阈值等于埋一个必炸的 flake**，
而墙钟本身"不能当门禁"：宿主负载能让同一版差 2 倍以上。

同一处还有一条**仪器自述漂移**：用例标题写 `inside 20ms`，断言却是 `< 60`。两者都保留了很久，
读日志的人无从判断哪一个是判据。

## 二、改法（换了判据，不是放宽）

`src/shared/global-search-cjk-bench.test.ts`：

1. **新增确定性门 `cost shape`**：对 2/3/4/5/8/12 字的 CJK 词，断言
   `cjkSplitsOf(term).length === max(0, len-3)`、`cjkPartsOf(term).length === max(0, len-1)`。
   这是「两半都在」规则唯一会膨胀的地方 —— 每个切分是一次全文扫描；切分数量随字长**线性**，
   才保证一条查询是"几次扫描"而不是"组合数"。改成「所有子串对」的写法会通过本文件全部召回用例，
   却把扫描次数变成词长的平方；这条门是本机与 runner 上**同一个数**。
2. **延迟改为读数 + 天花板**：打印 `[cjk-bench] p95=…ms limit=300ms`，断言 `< 300`
   （最差观测值 62.3 ms 的约 5 倍）。
3. **标题与断言对齐**：`stays inside a degraded-box budget over 2,000 documents`。

## 三、门禁与读数（全部实跑，取最后一次改动之后）

在**隔离工作树**（`git worktree add /tmp/ps-gate-cjk 70fe3282`，软链 `node_modules`）里跑，
只把我改的两个文件拷进去 —— 共享树里当时有别的会话的未提交在制品，不能算进读数：

| 环 | 命令 | 读数 |
| --- | --- | --- |
| 用例 | `npx vitest run src/shared/global-search-cjk-bench.test.ts` | **5 passed (5)**，`[cjk-bench] p95=42.1ms limit=300ms` |
| eslint | `npx eslint --no-cache <该文件>` | exit 0 |
| 类型（node） | `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:node` | exit 0 |
| 类型（web） | `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:web` | exit 0 |

本机三次取样的 P95：21.2 / 22.8 / 42.1 ms（第三次是本机同时在跑别的负载，恰好说明为什么它不能当门禁）。

## 四、边界（不许读成更强）

- 这条确定性门**只证算法形状**（切分线性、不组组合），不证明"快"。真实体感性能仍归
  `npm run test:e2e:perf`（故意不进 CI，见 `references/perf-gates.md` §3）与 Nightly 的预算断言。
- 300 ms 天花板只拦**病态**回归（十余倍量级），拦不住 2–3 倍的退步；那类退步要看打印出来的读数，
  不是看红灯。
- 没有调整工作量、没有把文件移出 unit 组、没有加超时。400/300/300 条召回归仍全扫 2,000 篇文档
  （该文件整体约 18–26 s），若 unit 组因此变慢，另立单元，不在这里顺手改。
