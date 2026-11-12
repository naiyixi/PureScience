# 两族打包版错误：该不该加「有界重试」——先判，不先动实现（2026-11-12）

> 问题来源：上一轮把榜首那 2,670 条 error 判成夹具之后，打包版日志里还挂着两族各 20 行的 error：
> `[Auditor] correction sendPrompt failed` 与 `artifact finalization attempt failed`。本轮只回答一件事：
> **这两族要不要各加一个有界重试**。结论：**两族都不加**，理由见下（各有具名读数，不是感觉）。
>
> 本轮交付的仪器：`npm run diag:log-attribution -- --recurrence` 会把「同一个身份被撞了几次」直接算出来，
> 以后同类问题一条命令就有读数，不必再手工 grep 时间线。

## 一 语料与仪器

| 项 | 读数 |
| --- | --- |
| 语料 | 6 份 `main*.log`（打包版 3 + 开发版 3），**87,654 行**结构化记录（上一轮同一语料是 87,547 ⇒ 日志在长） |
| 本族归属 | 两族 **全部是 `real`**（打包版实例，非认证夹具）——与上一轮那 2,670 条恰成反面 |
| 仪器 | `scripts/log-corpus-attribution.mjs` 新增 `--recurrence`：按 `scope` + `msg` + **一个身份**
（`claimId` > `reviewId` > `artifactRunId` > `sessionId` > `mainSessionId` > `appSessionId`）聚合，只列
「撞过不止一次」的身份，带行数、时间跨度、`attempt` 范围（缺了就不写、不填 0）与归属切分 |
| 自检 | `--selftest` 增四条：同一 `claimId` 三行 ⇒ 一个 cluster 且 `attempt 1→3`；另一 `claimId` 仅一行 ⇒ 不列出；无身份的两行既不成簇也不并进别簇；`identityOf({host})` 必须 `undefined` |

## 二 第一族：`[Auditor] correction sendPrompt failed`（20 行，全 real）

按身份切开后是**两个会话、两种形状**：

| 身份 | 行数 | 时间跨度 | 形状 |
| --- | --- | --- | --- |
| `mainSessionId=d8da1631…0156` | 16 | 2026-11-05 16:12:16 → 16:52:08（40 分钟一场） | 两条评审车道同场 |
| `mainSessionId=38588c34…ad7a` | 4 | 2026-11-07 16:26:44（1 行，`Stream idle timeout`）+ 11-09 10:49 / 11:05 / 11:07（3 行 `already running`） | 3 次自撞 + 1 次供应商流中断 |

**「谁在占着会话」有确定答案，不是用户**。11-09 那一场逐毫秒时间线（同一份 `main.log`）：

```
10:49:33.975 reviewer:correction   injecting [Auditor] message into main session
10:49:33.985 acp-prompt-turn-workflow prompt start  len=1323      ← 这一次注入自己开出的回合
10:49:40.688 reviewer:correction   injecting [Auditor] message into main session
10:49:40.690 reviewer:correction   correction sendPrompt failed  "An ACP prompt is already running"
```

第二条注入与第一条相隔 6.7 s，而第一条开出的修正回合要到 `10:50:36` 才 `prompt stopped`。
11:05 与 11:07 两场是同一形状（`11:05:20.945` 注入 → `11:05:20.954` prompt start →
`11:05:39.356` 第二次注入被拒）。⇒ **19/20 行是两条评审车道各自注入修正时自撞**，
**1/20 行**（11-07 16:26:44）是供应商流空闲超时，属 `send-failed`，与该碰撞无关。

### 判：不加有界重试

1. **重试会把「少一条修正」换成「多一条修正」**：被拒的那次注入，其目标会话上正在跑的正是另一条车道的
   `[Auditor]` 回合。等它结束再发，用户会话里就出现两条内容高度重叠的修正指令，代理会照着两份清单各改一遍。
2. **这 19 行的成因已被单独修掉**（`2eaf5100`，2026-11-10）：`fix-loop-active` 是**状态闸**而不是计时闸——
   一条修正车道持有该会话时，自动复核直接不启动（同一条注释里写着现场读数：两条评审各 143 次工具调用，
   随后重复车道注入被同一个报错拒掉、它的检查被标成未处理）。**打包版这 20 行来自 11-09 及更早的构建**，
   闸门在本轮语料里还没有机会表现。
3. **剩下那 1 行更不该重试**：`Stream idle timeout` 是供应商侧的流中断，重试等于把一次昂贵的评审回合
   再打一遍；该族的修法是超时与重连，不是把失败当瞬时抖动重发。

### 具名立案（不在本轮动实现）

- **缺口**：闸门只挡「自动复核的启动」，挡不住「两条车道在闸门落地之前就已经都起来了」。
  两条车道的修正注入目前**没有按会话的 single-flight**。
- **落点**：`src/main/reviewer/correction.ts`（注入入口）与 `src/main/reviewer/orchestrator.ts:805`（调用点）；
  已有的失败分类在 `classifyCorrectionFailure`，已有 `CorrectionFailureReason` 三种值。
- **验收判据**：同一条主会话上两条车道并发修正时，第二家**不发 prompt**、不写 `error` 行，
  而是落一条具名结果（例如「另一条修正回合正在进行」），并且它的检查**不因此被标成未处理**。

## 三 第二族：`artifact finalization attempt failed`（20 行，全 real，`failureKind: invalid-proof`）

按 `claimId` 切开，20 行只属于**三次认领**：

| `claimId` | 行数 | `attempt` 范围 | 时间跨度 |
| --- | --- | --- | --- |
| `artifact-claim-1793897553264-38` | **15** | 1 → 15 | 2026-11-06 03:30:44 → 11-07 16:02:44（36.5 小时） |
| `artifact-claim-1793807815085-31` | 3 | 1 → 3 | 2026-11-04 15:56:57 → 16:47:23 |
| `artifact-claim-1793807368207-30` | 2 | 1 → 2 | 2026-11-04 15:49:29 → 15:54:34 |

`attempt` 由 `ArtifactRunRegistry.noteFinalizeAttempt`（`src/main/artifacts/run-registry.ts:100`）按认领计数，
**同一个认领已经被重试了 15 次**——这一次不是「没有重试」，是「重试了 15 次仍被同一条证明规则拒」。

### 判：不加有界重试

1. **它已经在重试**：每一回合的产物事件都会再调一次定稿（`ipc.ts:495` 起），`attempt` 一路加到 15。
   再加一层重试只是把 15 变成 15×N，代价乘上去、结论不变。
2. **`invalid-proof` 是确定性拒绝**，代码自己的注释就写着「terminal proof rejection is not retryable」
   （`src/main/artifacts/ipc.ts:606` 附近）。对确定性拒绝做重试，等于把一次真拒绝伪装成抖动。
3. **不能为了「少几行 error」就把它判成终态**：本仓有过相反的先例——产物定稿会因为「Prompt 锚点后到」
   而被合法地救回来（`c481d17d` / `fcc2bb4b` / `cb047dd2` / `56976108`）。把 `invalid-proof` 一刀切成
   终态，会让那些本来能自愈的认领永久停在 `.pending`。

### 缺口在「说不出是哪条规则」，而这一条已经补了

`7c64d0ca` 把 `proofCause`（19 个原因码的闭集）加进了同一行失败记录——**在此之前，这 15 行只能看到一个
`invalid-proof`**。本轮语料里的 20 行全部来自该字段落地之前的构建，所以**这三次认领到底被哪条规则拒的，
本轮给不出答案**：这是具名缺口，不是可以靠推理补齐的格子。

- **下一轮取数判据**：在带 `proofCause` 的构建上复跑同一份语料，按 `proofCause` 分桶；
  若某一码在同一认领上重复出现且时间跨度超过一小时，那才是「该不该把它当终态」的可判证据。
- **旁证**：这三次认领都发生在 11-04/11-06/11-07，同一进程内（`attempt` 连续增长 ⇒ 认领未丢）；
  失败行里 `durableFinalizationCompleted:false` / `compatibilityPublicationCompleted:false` 说明
  拒绝发生在**证明提交阶段**，兼容字节一步都没走 —— 即没有半份产物被发出去。

## 四 边界

- **本轮没有一行运行时代码改动**：改的是分析侧仪器（一个可选 flag + 自检），以及把两个判断落成文字。
  不声称产品变快、不声称这 40 行 error 会消失。
- **`--recurrence` 的口径**：「重复」= 同一 `scope` + 同一 `msg` + 同一身份字段值出现 > 1 次。它**不做因果推断**：
  两次重复可能是两条车道（第一节），也可能是同一条车道的 15 次重试（第三节），仪器只给「撞了几次、跨多久、`attempt` 到哪」。
- **身份字段的顺序是判断题**：`claimId` 优先于 `sessionId`（一次认领的重试要能分开于同一会话里别的事故）；
  反过来，没有 `claimId` 的族会落到会话级，那时同一会话的两种不同失败**确实会分开**（`msg` 参与 key）。

## 五 复跑配方

```bash
npm run diag:log-attribution -- --recurrence            # 两版实例分开，带重复尝试段
npm run diag:log-attribution -- --recurrence --json     # 机读
node scripts/log-corpus-attribution.mjs --selftest      # 自检（含本次新增的四条）
```
