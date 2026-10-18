# 审查落库不再按默认 5 秒预算跑，也不再按 Finding 条数发语句

日期：2026-10-19 · 执行器单元 · 代码提交见 `git log --grep="审查落库"`

## 一 真机证据（不是推断）

取数窗口：本机已装应用的 `~/Library/Logs/PureScience/main.log`（`2026-10-15T16:04:29Z` → `2026-10-18T20:39:11Z`）。

| 时间（UTC） | scope | 原文 |
| --- | --- | --- |
| 2026-10-18T02:31:18.139Z | `reviewer:orchestrator` | `review persistence failed` → `Invalid tx.review.update() invocation … Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 6692 ms passed since the start of the transaction.` |
| 2026-10-18T02:36:01.524Z | `reviewer:ipc` | `runReview threw unexpectedly` → `Transaction API error: Unable to start a transaction in the given time.` |
| 2026-10-18T02:36:09.572Z | `notifications` | 同一条 5000 ms 的 P2028（`6,494 ms`，`A commit cannot be executed on an expired transaction`） |
| 2026-10-18T02:36:09.577Z | `acp` | 同上（`inbox record failed`） |

计数（`main.log` + `main.1.log`）：`review persistence failed` **1** 次、`Unable to start a transaction` **1** 次、带 `code:"P2028"` 的行 **2** 次（落在 `acp` / `notifications`，是同一次阻塞的连带）。

含义：一次审查要花掉几分钟模型时间，落库却用客户端的默认 5 秒预算；超时后这次审查的判决整段丢掉（`updateReview(lifecycle:'error')` 只是补一行错误态，判决本身不再有）。启动事务那一步用的是默认 `maxWait`（2 s），排队久一点就直接抛，`runReview` 连 `onStarted` 都没到。

## 二 根因（读源）

1. `ReviewRepository` 的 8 个写路径全部用 `client.$transaction(fn)`，没有第二参数 ⇒ 走 Prisma 默认 `timeout: 5000 / maxWait: 2000`。
2. `commitScopedSubmission` 对每条 `sourceFindingId` 逐一 `findUnique`（finding → review → disposition）+ 逐一 `finding.update` + 逐一 `create` + 逐一 `touchReview`，一次提交是 **~4N+1 条语句**。项目库是单连接（`connection_limit=1`），事务内的每条语句都要在这一个连接上排队 ⇒ N 越大，越容易超过 5 秒。
3. 这与「审查要花多久」无关，是**写入预算比被包住的工作还短**。

## 三 交付（`src/main/reviewer/repository.ts`）

| # | 改动 | 为什么这样改 |
| --- | --- | --- |
| ① | 新增 `REVIEW_TRANSACTION_OPTIONS = { timeout: 30_000, maxWait: 10_000 }`，8 处 `client.$transaction(` 统一改走 `runTransaction(client, fn)` | 预算按「被包住的工作」量：现场实测 6.7 s 已越界，30 s 是有界的上限而不是无限等；`maxWait` 抬到 10 s 让排队变成等待而不是当场失败 |
| ② | 单次重试**只**给「事务根本没起来」（`Unable to start a transaction`，什么都没执行 ⇒ 重试安全）；`Transaction already closed`（可能已提交）**不重试**，照旧上抛由调用方记错误态 | 区分「没执行」与「执行到一半过期」，后者重试会造成重复写入 |
| ③ | `commitScopedSubmission` 的追踪分支改成批量：`finding.findMany({id:{in}})` + `review.findMany({id:{in}})` + `disposition.findMany({id:{in}})` 各一次；写入按「同类效果」合并成 `finding.updateMany`（仍开放 / 已解决各一条）+ `reviewFindingDisposition.createMany` + `review.updateMany`（touch 源 review） | 语句数从 ~4N+1 降到固定 7 条；提交时间不再随 Finding 条数增长 |
| ④ | 三条新用例：预算必须显式（遍历所有 `$transaction` 的第二参数）；三条追踪 Finding 的提交语句形状固定（且不再出现 `finding.findUnique` / `reviewFindingDisposition.findUnique` / 逐条 `finding.update`）；「没起来」重试一次、「过期中途」不重试 | 让这两件事**只能**以现在的形状成立，改回去就红 |

## 四 门禁读数（全部实跑，数字取自最后一次改动之后）

| 项 | 读数 |
| --- | --- |
| 本文件 `src/main/reviewer/repository.test.ts` | **30 passed**（27 条既有 + 3 条新增），exit 0 |
| review 模块整目录 | `npx vitest run src/main/reviewer` ⇒ **23 文件 / 267 passed**，exit 0 |
| 类型检查（node / web） | `tsc --noEmit -p tsconfig.node.json --composite false` ⇒ exit 0；`-p tsconfig.web.json` ⇒ exit 0 |
| lint（改动面） | `npx eslint --no-cache` 两个文件 ⇒ **0 problem**（新增块先有 14 条 prettier warning，`--fix` 后同一 hunk 内消化，`git diff` 只有一个纯新增 hunk） |
| **反向门** | 用 `git show <上一提交>:src/main/reviewer/repository.ts` 换回旧实现再跑新增的两条 ⇒ **两条都红**：`expected undefined to deeply equal { timeout: 30000, maxWait: 10000 }`、`expected [ 'review.findUnique', …(20) ] to not include 'finding.findUnique'`。换回新实现后 30 passed |

既有 27 条集成用例（真 SQLite：回滚、跨回合拒绝、disposition 事件复用、sequence 递增、reflagCount 只动目标行）在批量改写后**全绿**，这是「语义没被批量写坏」的证据。

## 五 边界（不许读成更强）

- **没有改变「审查判决最终能不能落库」的全部风险**：事务预算与语句数都收敛了，但单连接排队仍在（读池是独立设计项，见队列档 P0-10③），数据库被别处长时间占住时仍可能等到 30 s 上限。
- **面板那句话没改**：`ReviewerCard.tsx:365` 本来就把 `review.errorMessage` 原样上屏（`lifecycle==='error'` 时），所以「审查没落库要说得出来」这一半属**架构已覆盖**；但上屏的是 Prisma 原文（`Transaction API error: … 5000 ms`），不是给人看的句子——要做成九语人话需要新的文案键与渲染层映射，本轮**未做**，具名留给下一轮。
- **没有加索引**：`Finding.reviewId` 没有索引，但本机库 `Finding` 只有 801 行、`Review` 149 行（副本实测），全表扫可忽略 ⇒ 不为此写迁移。若将来单项目 Finding 上万，再按读数决定。
- **`reviewer:get-for-session` 最长 203 s 与本单元无关**：那条是读侧逐条重算 scope（`flagStaleReviews` 顺序解析 artifact 摘要），根因未取到真机对照，**不在本单元内**，未做。
- 本单元不占版本号（纯运行时缺陷修复、无界面变化，按仓规不抬补丁号）。
