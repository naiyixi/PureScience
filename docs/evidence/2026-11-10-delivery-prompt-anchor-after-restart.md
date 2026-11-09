# 后台投递回合在重启之后仍有一个可被证明拥有的 Prompt（2026-11-10）

> 本轮单位：`2be4405e5dc6` 自主执行器。承接 §297（根因定死：被抑制的 Prompt 从不进图）与 §298
> （写侧修复：同一进程内继承「本会话最近一条用户 Prompt」），补上它具名留下的那一格：
> **跨重启**的 app-owned 回合进程内表为空，锚点取不到。

## 一 缺口（用产品自己的两条路径对上，不靠推测）

| 事实 | 位置 |
| --- | --- |
| 后台投递由主进程写进会话：结果本身作为一条 `role: 'user'` 的**真实用户消息**落盘 | `src/main/background-delivery/owner.ts` `deliverClaimed()` |
| 写完立刻起一个回合处理它，而该回合是 app-owned（`suppressUserMessage: true`），所以它自己**不再**发用户消息 | `src/main/ipc.ts` 的 `startTurn` 闭包 |
| 产物定稿的归属证明要求 anchor 是一个 `complete` 的用户 Prompt，且与回复同 Frame / 同 Branch / 同 Runtime Segment、排在回复之前 | `src/main/artifacts/provenance-repository.ts` `validateDurableMessageOwnership()` |
| 派发处只从**进程内**表继承锚点；重启后该表为空 ⇒ 铸一枚 `prompt-<uuid>` ⇒ `prompt-not-owned`（终态，重试无解） | `src/main/acp/runtime-coordinator.ts`（§298 的前一笔） |

关键一点：**被投递的那条结果消息本身就是一个合法的、durable 的 Prompt**。缺的只是「有人去图上把它找出来」——
不是要放宽证明，也不是要给 app-owned 回合新造一种身份。

## 二 交付（2 个产品文件 + 3 个测试文件）

1. `src/shared/conversation-graph.ts` 新增 `resolveInheritablePromptContext(graph)`：在**活跃 Frame 的活跃
   Branch** 上从后往前找第一条满足 `role==='user'`、`status==='complete'`、`introducedOnBranchId===活跃
   Branch`、`runtimeSegmentId===该 Frame 最新 Segment` 的消息，用既有的 `getActiveConversationContext()`
   产出四条身份。**找不到就返回 `undefined`** —— 一个会被证明拒绝的锚点比没有更糟（那个拒绝是终态）。
2. `src/main/background-delivery/owner.ts`：`startTurn` 的入参多一个可选 `provenanceContext`，由
   `promptAnchorFor(session)` 在**结果写入之后**从会话图上解析（与 `deliverClaimed` 用的是同一份
   `materializeSessionConversationGraph`，不新造第二套图）。图材料化失败 = 无锚点，不让一次投递因为
   「读不到锚点」而失败。
3. `src/main/ipc.ts`：把锚点透传给 `runtime.sendPrompt`，并落一条具名日志（有锚点 `info` /
   没有锚点 `warn` 且带 `consequence: 'prompt-not-owned'`）—— 一次真机读数就能把「入参没到」与
   「到了没生效」分开。

## 三 读数（全部实跑）

| 环 | 读数 |
| --- | --- |
| `vitest run src/shared/conversation-graph.test.ts` | 11 passed（其中 5 条新增：本会话最近 Prompt / 跳过未完成 / 跨 Segment 拒绝 / 父 Branch 引入拒绝 / 无用户 Prompt） |
| `vitest run src/main/background-delivery` | 4 文件 34 passed；`owner.integration.test.ts` 11 passed（新增 1 条：投递回合拿到**那条结果消息**的四条身份，真 SQLite + 真会话文件） |
| `vitest run src/main/artifacts/provenance-repository.test.ts -t "delivered result"` | 1 passed —— **证明级**：同一个 run 上，铸出来的 `prompt-<uuid>` 被真实证明以 `prompt does not match the declared durable ownership` 拒掉，而投递消息的锚点定稿成功（1 个版本） |
| `vitest run src/main/acp src/main/background-delivery src/main/artifacts src/shared/session-persistence src/shared/conversation-graph.test.ts --maxWorkers=4` | 120 文件 / **1879 passed**，exit 0 |
| `tsc --noEmit -p tsconfig.node.json --composite false` / `web` | 各自 exit 0 |
| `eslint --no-cache`（本批 6 个文件） | 0 errors / 0 warnings |

## 四 边界（不许读成更强）

- **仍未取真机窗口读数**：本轮 `vm_stat` 空闲页 3,874 × 16 KB ≈ 62 MB、swap 7,236 / 8,192 MB 已用，
  本机还跑着一个 dev 无头实例 ⇒ 不起 Electron。要证「重启后的投递回合产物真的定稿」需要一次隔离数据根
  的实机回合（造一次投递 → 读版本行五条身份），这一格仍记**未取证**。
- 本轮证到的是「**锚点满足真实证明**」（证明级用例）+「**投递路径确实把它交出去**」（集成用例），
  不是「界面上看到了定稿的产物」。
- 仍是终态的那种情形已具名：若投递时活跃 Segment 与最近一条用户 Prompt 不同（例如重启后模型换了，
  采纳阶段新开一个 Segment 且已落盘），本函数返回 `undefined`，该回合的产物仍会以 `prompt-not-owned` 被拒；
  这条不做「猜一个更接近的锚点」的处理。
- 进程内继承（§298）保留：筛查/受限推理/产物代码重建这些在同进程里派的 app-owned 回合仍走它。
