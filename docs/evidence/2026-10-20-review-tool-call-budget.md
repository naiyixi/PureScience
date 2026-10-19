# 审查成本上限：一次审查最多 300 次工具调用，超了就说清楚「没有结论」

取数日期 2026-10-20（执行器轮次）。仓库 `naiyixi/PureScience`，基点 `5b0ebd49`（origin/main，本地 `ps-wd3` 隔离工作树）。
来源：会话的真机审计档（`docs/plan-2026-10-19-runtime-audit-and-fixes.md` 在它那条未推的分支上，此处按**只读引用**）
§5 第 4 条「审查成本上限」。

## 1 缺口是什么形状

审查回合已有的两道闸都**不管成本**：

| 既有闸 | 值 | 它拦什么 | 它不拦什么 |
| --- | --- | --- | --- |
| `DEFAULT_REVIEWER_TIMEOUT_MS` | 900 000 ms | 挂住不动的会话 | 一直有进展、但一直烧调用的会话（每来一次更新就把窗口往后推不完，墙钟最终会到，但那是一条 15 分钟的等待） |
| `DEFAULT_REVIEWER_MAX_UPDATES` | 1000 | 帧级疯转（同一调用反复刷状态也算帧） | **成本**：1000 帧可以是 12 次调用，也可以是 900 次调用 |

也就是说：一个「每次调用都很便宜、但一秒钟能发起好几次」的审查回合，在面板上表现为**正常跑着**，
直到墙钟到点才以 `reviewer session timed out before stopping` 收场 —— 而那句错误对读者没有信息量：
它说不出「已经花了多少次调用」「为什么没有结论」。

## 2 先量后定（这一步改掉了上一轮汇报里的一个数）

不照「审计里说见过 200 次」直接抄一个上限，先量**打包版真实库**（`~/.purescience/purescience.db`，只读打开）：

| 读数 | 值 |
| --- | --- |
| 有工具调用的 Review 条数 | **151**（库内 Review 共 154 条：148 complete / 5 error / 1 running） |
| 单次审查的工具调用数 | min **2**、median **25**、p90 **90**、p99 **164**、max **202** |
| 超过 240 的 | **0** 条；超过 300 的 **0** 条 |
| 最重那次（202 次）的构成 | **186 次 `query_execution_log`**（一次只查一个 activity）+ 7 次 `submit_findings` + 5 次 `read_artifact` + 3 次 `read_turn` + 1 次 `read_turn_history` |
| 每次调用耗时（96 条 ≥20 次调用且时长可信的审查） | median **5.22 s**、p90 **10.38 s**、max **21.42 s** |
| 整次审查耗时 | median **264 s**、p90 **412 s**、max **856 s** |

**计数的口径**：取自 `Review.reviewerLog` 里 `kind = 'tool'` 的条目数 —— 捕获日志里一次调用落一条
（`tool_call_update` 是同一个条目收尾，不另起一条）。这是**调用**的代理量，不是帧数；也正是新代码
**故意不依赖**的那个量（见 §3：计数器在 drive 循环里，没有 `onUpdate` 也成立）。

### 2.1 具名更正（上一轮汇报里的数字是错的）

上一轮我写的是「每次调用 **1.5–3 s**，900 s 因此仍可放行 **300–600** 次」。这一轮按行时长重算，
**中位是 5.22 s**：900 s 在**中位节奏下只放得行 ~170 次**。结论随之改变，不是「墙钟太松」，
而是**两道闸管的是两种形状**：

- 慢审查（中位 5.2 s/次）：墙钟先到，本预算**永不生效** —— 151 条实测里没有一条会被它停下，这正是想要的。
- 便宜调用的疯转（最重那次 202 次 / 313 s ≈ **1.55 s/次**）：预算在 ~7.5 分钟处停下（墙钟的一半），
  并且**带着原因**停下。

所以 300 = 实测最大值 202 的 **1.48 倍**：对诚实的深审查留足余量，对便宜调用的疯转提前一半时间收口。
代码注释里写的就是这组实测数（不是「1.5–3 s」那句旧话，已就地改掉）。

## 3 交付（4 处代码 + 2 个用例文件）

| # | 文件 | 内容 |
| --- | --- | --- |
| ① | `src/main/reviewer/orchestrator.ts` | `DEFAULT_REVIEWER_MAX_TOOL_CALLS = 300`（注释带 §2 的实测分布与「本预算不拦慢审查」的边界）；`driveReviewerToStop` 按 **distinct `toolCallId`** 计工具调用（同一 id 的 `tool_call_update` 只算收尾；无 id 的调用照计；流式 chunk 不计），到上限抛 `reviewer session exceeded tool-call budget (N) — review stopped without a verdict. …`；80%（240）处 `warn` 一次；正常停下打一行 `reviewer drive stopped {stopReason, toolCalls, toolBudget}` |
| ② | `src/main/reviewer/orchestrator.ts` 接线 | `reviewerMaxToolCalls` 沿 **`RunReviewOptions` → `runFixLoop` → `runScopedReview` → 两处 `driveReviewerToStop`** 共 10 个点接齐 |
| ③ | `src/renderer/src/lib/reviewer-error-copy.ts` | 新增第八族 **`budget`**（`needles: ['exceeded tool-call budget', 'tool-call budget']`），并保留「persistence 判定先于 timeout」的既有顺序契约 |
| ④ | `src/renderer/src/i18n/*.ts`（9 语言） | `reviewer.error.budget` + `reviewer.errorShort.budget` 共 18 行；用本技能自带的 `scripts/add-i18n-keys.py` 写入（九文件齐平预检 + 写后自证），zh / zh-Hant 值均不等于 en |
| ⑤ | `src/main/reviewer/orchestrator-tool-budget.test.ts`（新） | 7 条：到上限即停、消息带面板匹配短语、未超预算照常返回 stopReason、同一调用的 update 不自耗预算、无 id 调用照计、流式 chunk 不计、缺省走 300 |
| ⑥ | `src/main/reviewer/orchestrator.test.ts`（改） | 1 条**集成**用例：`runReview({ reviewerMaxToolCalls: 2 })` 走完整编排（真 ACP 夹具、真 SQLite），断言 Review 行 `lifecycle='error'`、`errorMessage` 含 `exceeded tool-call budget (2)`、`checks` 为空，并**回读库里那一行**再断言一次 |

**为什么一定要这条集成用例**：单元用例直接驱 `driveReviewerToStop`，只证明「函数会停」。
本仓有过的教训是「一个参数沿每一层签名都接上了、却没走到真正的循环」（已建但无人调用的同族形状）。
集成用例证明的是**这个旋钮真的被 `runReview` 消费**、并且停止原因**真的到了读者眼前**。

## 4 读数（全部实跑）

| 项 | 读数 |
| --- | --- |
| `orchestrator-tool-budget.test.ts`（7 条） | **7 passed** |
| `orchestrator.test.ts`（既有 13 + 新增 1） | **14 passed** |
| 反向门 ①：把 `reviewerMaxToolCalls` 的两处 drive 传参摘成 `undefined` | `orchestrator.test.ts` **1 failed / 13 passed**，红的恰是那条集成用例（不接线的旋钮 = 等于没有旋钮） |
| 反向门 ②：整个 `orchestrator.ts` 换回基点 `5b0ebd49` | `orchestrator-tool-budget.test.ts` **3 failed / 4 passed**（三条「必须有预算」的用例红） |
| 受影响簇 `src/main/reviewer` | **24 files / 277 passed**，exit 0 |
| i18n + 卡片簇 | **6 files / 122 passed** |
| 双 typecheck | `tsc -p tsconfig.node.json --composite false` **exit 0**；`-p tsconfig.web.json --composite false` **exit 0** |
| lint | `npx eslint --no-cache .`：本笔新增/改动文件 **0 error**（全仓 warning 数为既有基线） |
| 全量 vitest `--maxWorkers=4` | 三次：`1346 files / 17206 passed` exit 0（连跑两次）；换用与 `origin/main` 同 schema 重新生成的本地 Prisma 客户端后 **1 failed / 17205 passed**，红在与本批无关的 `SessionPlanSurfaces.test.tsx`，**单文件隔离复跑 3 遍 21/21 全绿** ⇒ 按负载抖动记档（当时 load ~15、机器上另有一条全量在跑），最终判决以上 CI 为准 |

### 4.1 真进程探针（生产代码 esbuild 打包后由真 `node` 跑，五种脚本化会话）

| 场景 | 读数 |
| --- | --- |
| 失控 + 预算 300 | `threw`、**恰在第 300 次**停下、240 处 `warn` 一次、消息与面板匹配短语逐字一致 |
| 失控 + **不给选项**（验生产缺省） | 同样 **300** 停下 ⇒ 缺省值真的生效，不是只活在用例里 |
| 一个调用刷 500 次状态 | `resolved`、`toolCalls: 1` ⇒ 同一调用收尾不自耗预算 |
| 299 次后正常结束（预算 300） | `resolved`、`stopReason: "end_turn"`、`toolCalls: 299` |
| 4 万条流式 chunk（预算 2） | `resolved`、`toolCalls: 0` ⇒ chunk 不误计 |

探针脚本是本轮临时件（`/tmp` 下，不进仓）：它把 `orchestrator.ts` 单独打包成 CJS，喂一个**假的
DrivableSession**（按脚本吐出 `tool_call` / `tool_call_update` / chunk / stop），读返回值与抛出的消息。
它证明的是**drive 循环本体**在真进程里的行为，不经过 Electron。

## 5 边界（不许读成更强）

1. **预算停不等于「审查失败」**，而是「这一轮没有结论」。所以面板显示的是 `budget` 那一族的文案，
   也就是「没有结论，请重跑或缩小本轮」，而不是「系统坏了」。
2. **它不限制修正轮数**。`fixLoopMaxRounds`（缺省 3）管的是整轮循环次数，预算管的是**单次** review
   会话里的工具调用；两者的乘积才是极端情形的上界，本轮没有合并成一个总预算（合并会改变既有
   `maxRounds` 的语义，属独立一条）。
3. **240 的 warn 只用于现场判读**「300 是不是太紧」，它不改变行为、不上界面。
4. **真实审查回合打到 300 的读数取不到** —— `blocked-by`：本机内存闸门（空闲物理页 ~5.2k ≈ 82 MB、
   swap 12.1/13.3 GB）。解封条件：下一次 dev 或打包实例能起。因此「真机上一次审查真的在第 300 次停下」
   这一格**标为未取**，不许拿 §4.1 的真进程探针顶替（那两者是不同层：探针证 drive 循环，真机证整条编排 + 面板）。
5. **分布基线会漂**：§2 的 151 条来自本机打包版库。将来审查行为变化（例如新增一个「逐 activity 查」的
   连接器工具）会抬高 p99 —— 那正是 240 那条 warn 存在的意义，届时按现场读数调，不按本条改。

## 6 下一步

- 真机那一格（§5·4）在内存闸门放开后补：起一个隔离实例，让审查回合跑到预算，读面板文案与库里的 `errorMessage`。
- 同一族的第二件事（未开工）：把「审查一次花了多少调用」做成一行的**只读展示**（现在只在日志里）。
  它需要先确认渲染端有消费方，否则就是空壳字段——按本仓纪律不在没有入口的情况下先造。
