# 审查提交里那个「要人抄 64 位哈希」的字段：41 次拒绝、一次审查 87 秒重试六次

日期：2026-10-20 · 单元：审查 `submit_findings` 的 locator 指针（`contentHash` 改为可选，恒由冻结块填充）
来源：本机真实运行日志（打包版用户实例，只读取证）

## 一 读数（先把账摊开）

日志：`~/Library/Logs/PureScience/main.log`（JSONL）。窗口 = 2026-10-17T00:00Z 起的 14,587 行。

| 读数 | 值 |
| --- | --- |
| `reviewer:mcp / submit_findings locator out of scope` | **41**（2026-10-17T15:05Z → 10-18T17:18Z，约 26 小时） |
| 其中「content hash 不匹配」 | **41 / 41**（没有一条是 blockIndex 越界） |
| 分布在几个审查运行里 | **4**（`c7fb5a3d…` 23 次、`b866e3dc…` 9、`13971f84…` 5、`5d1fedcd…` 4） |
| 提交上来的「哈希」是什么形状 | 15 个 UUID（块/消息 id）、8 个 `call_…`（工具调用 id）、8 个空串、2 个「真哈希但不是这个块的」、其余是 `artifact:<uuid>`、`message-1792…`、`x`、`unknown`，还有一句中文正文 |
| 一次审查为这个字段付出的时间 | `b866e3dc`：15:05:12 → 15:06:39，**6 次 submit_findings 全被拒**，第 7 次（15:06:39）才通过，随后 `review complete` ⇒ 约 **87 秒**、6 个完整 MCP 往返与模型回合花在同一个字段上 |

两条样本（原文逐字）：

```
Locator content hash does not match frozen block 0: 47221407-a941-4ef9-97ac-194c480def32
Locator content hash does not match frozen block 87: call_03_lKb3kDln8Tibyzf5cLEi3515
```

## 二 为什么这不是「模型不听话」，而是我们的契约在量错东西

`mapChecksToScope`（`src/main/reviewer/mcp-server.ts`）本来就做了这件事：用 `blockRef.blockIndex` 在**冻结的**
`scope.blocks` 里找到那个块，再把 blockRef 的 `sourceId` 从块本身重建（注释原话：hallucinated/stale id 不可能被存下）。
也就是说，落库的那条 `locator.contentHash` **一直来自冻结块，而不是模型抄上来的那串**。

那这串抄写校验量到了什么？只量到「模型会不会逐字抄 64 位十六进制」。它证明不了「模型读过这个块」——`read_turn`
本来就把每个块连同它的 `contentHash` 一起返回，抄对了不需要读过任何东西；真正在读证据上把关的是另外两道门：
`validateReviewerEvidenceAccess` 要求先 `read_turn`、活动块还要求读过它自己的执行日志、`artifactVersionId` 要求读过那个版本。

同一条路径上还有一个**已经按这个口径处理过**的先例：`sourceFindingId`（纠正环的跟踪字段）在首轮审查里会被
显式丢弃，注释写着「so a valid assessment is not lost to a non-semantic tracking mistake」。`contentHash` 属同一类
指针字段，却把整份评估判死。

**保留的那一半**：模型真送了一串哈希、但**不是这个块的**（上面那 2 次真 64-hex）——那说明调用方钉的是另一个
scope，必须拒绝。所以严格比较没有删，只是把「没送」与「送错了」分开。

## 三 改了什么（3 个文件）

| 文件 | 改动 |
| --- | --- |
| `src/main/reviewer/mcp-server.ts` | `checkLocatorSchema.contentHash` → `.optional()`（工具描述写明「省略即可，blockIndex 足够；真要送就必须是 read_turn 报的那串」）。`mapChecksToScope`：省略时用冻结块的哈希填上（落库永远带 pin）；**送错时仍然拒绝，且拒绝句现在点名「收到什么 / 期望什么 / 可以不送」** |
| `src/main/reviewer/rubric.ts` | 审查员说明书里 locator 那三行改成「blockIndex 就够，别抄哈希；送了就必须逐字来自 read_turn」 |
| `src/main/reviewer/mcp-server.test.ts` | 新增 5 条：省略即接受且 pin 来自冻结块、拒绝句点名期望值、MCP schema 接受无哈希的 locator，外加两条**走真实 MCP HTTP 端点**的端到端用例（省略 → `onSubmit` 收到的 locator 是 `{blockRef:{messageId:'msg-2',blockIndex:0}, contentHash:'real-hash-msg-2'}`；送 `47221407-…` → `isError:true` 且正文含 `expected real-hash-msg-2`、`or omit contentHash`，`onSubmit` 未被调用） |

## 四 读数（全部实跑）

| 项 | 读数 |
| --- | --- |
| `mcp-server.test.ts` + `rubric.test.ts` | **57 passed**（2 文件） |
| 审查员整簇 `src/main/reviewer` | **24 文件 / 286 passed**（改前 281 ⇒ +5 即本轮新增） |
| 变异证明 A（`.optional()` 改回必填） | `1 failed / 31 passed`，红在 `lets the MCP schema accept a locator without contentHash`；已还原（逐字相同） |
| 变异证明 B（pin 改回用模型送的值：`suppliedHash ?? ''`） | `1 failed / 31 passed`，红在 `accepts a locator that omits contentHash and pins the frozen block hash itself`；已还原 |
| 真实协议用例 | 2 条 `ReviewerMcpServer HTTP transport` 用例通过（真监听、真 `initialize`、真 `tools/call`） |
| 双 typecheck | 见 §五（本机 5 条红，全部在 `src/main/references/repository.ts`，**与本轮改动无关**，逐条归因在下） |
| lint（全仓 `--no-cache`） | 见 §五 |

## 五 本机环境事实（不是本轮引入的，但会误导读数）

`tsc`（node 与 web 两套）在本机都报 **5 条错，全部落在 `src/main/references/repository.ts`**，形如
`must be missing the following properties … citedAt, citedSessionId`。判据三条：

1. `git stash` 把本轮三个文件全部移开后，**同一条命令、同一个读数**（`5` 条、`exit 2`）⇒ 与本轮改动无关；
2. `grep -c citedAt node_modules/.prisma/client/index.d.ts` ⇒ **0**，而 `prisma/schema.prisma` 里有 `citedAt`（:513）
   ⇒ 本机共享给多个工作树的**生成客户端比 schema 旧**（主工作树停在另一条分支，那份 schema 没有这两列）；
3. 主工作树与远端在 `prisma/schema.prisma` 上的差量正是这两列 ⇒ CI 的 `prisma generate` 会用带列的那份，红不会出现在 CI。

⇒ **本轮不据此改产品代码**；三处改动文件在这两套 `typecheck` 里**一条错都没有**。本机的可信判据是
「同读数在干净提交上复现」（第 1 条），以及「错误集合只含一个与本批不相交的文件」。

## 六 边界（不许读成更强）

- **没有真机窗口读数**：本单元是主进程 MCP 面，不需要窗口；本机此刻空闲物理页 ~4.5k（≈72 MB）、打包版实例正在跑，
  内存闸门关着。证据是「真实 MCP HTTP 端点 + 真 `tools/call`」，**不是窗口**，也不是一次真实模型审查。
- **模型侧的行为改变没有直接读数**：这次改的是「契约不再要求抄哈希」+ 说明书；下一次打包版跑真实审查时，
  `reviewer:mcp / submit_findings locator out of scope` 这条日志应当显著下降（现在 41 次/26 小时）。这一条**尚未取**，
  解封条件 = 下一次打包版或 dev 实例能起。
- **不放松任何证据门**：`read_turn` 必读、活动块执行日志必读、`artifactVersionId` 必读三道门原样保留；
  落库的 `contentHash` 仍然始终存在，`isTurnScopeStale` 的比较逻辑一行未动。
- 本单元**不占版本号**（是修复，不是运行时能力变更；是否随下一版发布由该版清单决定）。
