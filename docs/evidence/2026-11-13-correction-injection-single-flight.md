# 修正注入按会话 single-flight：同一会话在飞时第二家不再撞上去

> 单元范围：**reviewer 的「一个主会话同一时刻只有一条修正回合在飞」这条不变量**。
> 上一轮（§三百二十一）只判「要不要给两族 error 加有界重试」，判为**不加**，并把真正缺的那一半
> 具名立案为「修正注入缺按会话 single-flight」。本轮把那条立案做成实现。

## 一 读数（判据来自上一轮，本轮不改读数）

真机语料 `~/Library/Logs/PureScience/main.log` 六份合计 87,654 行，修正注入族 20 行 error 全是 real，
按身份切开后 16 行集中在同一场 40 分钟事故（会话 `d8da1631…`，11-05 16:12→16:52），逐毫秒时间线：

```
10:49:33.975  注入（两条评审车道里的第一条）
10:49:33.985  prompt start len=1323      ← 第一条注入自己开出回合
10:49:40.688  第二次注入
10:49:40.690  被拒：An ACP prompt is already running for this session
```

⇒ 19/20 行是**两条评审车道各自注入修正时自撞**，1/20 是供应商流空闲超时。`2eaf5100` 的状态闸
（`fix-loop-active`）只挡「修正轮次期间的**新**自动复核」，挡不住「两条车道在闸门落地之前都已起来」。

## 二 交付

| 位置 | 改动 |
| --- | --- |
| `src/main/reviewer/correction.ts` | 新增模块级 `inFlightCorrections: Map<mainSessionId, Promise<'completed'｜'failed'>>` 与 `MAX_DEFERRAL_HOPS = 3`；`injectAuditorMessage` 返回 `CorrectionInjectionResult`（`injected` / `no-findings` / `deferred{waitedOn}`）。查槽与占槽之间**没有 await**（单线程下即原子）；等待的是**另一个回合同一条 promise**，对方的发送失败会释放槽位让本家接手 |
| `src/main/reviewer/orchestrator.ts` | 修正回合的落账口径：`injection.kind === 'deferred'` 记一条具名 info（带 `waitedOn` / `openCount`），**不当作失败**——继续走 Step C 等「那一回合写进持久会话的 agent 消息」，再照常做定向复评；Step C 等不到消息且本轮是 deferred 时，**不把自己的检查标成 `unaddressed`**，而是留成 `open` 并记一行具名 info |

**设计判据**：① **判据是资源，不是时序** —— 被占的资源是「主会话的那一个回合」，所以键取 `mainSessionId`，
与 `fixLoopAbortControllers` 用 `projectId\0mainSessionId` 的口径同源；② **输家要说得出为什么** ——
`deferred` 是三态具名值（`completed` / `failed` / `still-in-flight`），不是把 `sendPrompt` 的异常揉成一句
「修正失败」；③ **不因此改写别人的结论** —— 修正**确实发出去了**（另一条车道发的），所以这一家的检查不能
被落成「从未发送」，只能留在 `open` 等下一次评审判它。

## 三 门禁（全部实跑）

| 环 | 读数 |
| --- | --- |
| `npx vitest run src/main/reviewer` | **27 files / 319 passed**，exit 0（含新增 4 条） |
| 新增用例（`--reporter=verbose` 逐条确认跑过） | ① 并发第二家等待并报 `deferred{completed}`（只 1 条 prompt、无失败回报）② 第一家发送失败时第二家接手发出去（`call=2`、失败只报一次）③ 回合完成后槽位释放（连续两次都是 `injected`）④ **编排层**：另一条车道占着修正回合时，本家的检查留在 `open`、`onCorrectionPrompt` 一次都没触发、库里也是 `open` |
| `tsc --noEmit -p tsconfig.node.json --composite false` | 0（`NODE_OPTIONS=--max-old-space-size=8192`） |
| `tsc --noEmit -p tsconfig.web.json --composite false` | 0 |
| `npx eslint --no-cache <三文件>` | 0 error / 0 warning |

## 四 边界（不许读成更强）

1. **槽位跟着回合照旧**：一条修正回合若永远不返回（供应商流挂住），槽位就一直被占，后续车道会一直等到
   `MAX_DEFERRAL_HOPS` 后报 `still-in-flight` 并放弃。这与改动前「本家自己也挂住」是同一个失败面，没有新增
   形态，但也没有被修掉 —— 挂住的诊断仍在 `Stream idle timeout` 那一条上。
2. **残留竞态**：另一家的回合在本家「取快照（Step A）」与「查槽（Step B）」之间**恰好完成**时，本家既没赶上
   排队、也不会有新消息可等 ⇒ 落到现有 `correction-wait` 分支。这条分支现在把 `deferred` 写进 warn 行
   （可数、不再与「没人发过」同形），行为与改动前一致。
3. **没有真机窗口读数**：要造这条读数得让两条评审车道同时跑起来，而产品现在**按设计**不允许
   （`2eaf5100` 的状态闸 + 本轮的 single-flight）。本轮证据是「真编排器 + 真仓库 + 假 ACP」的集成用例
   与真机语料的历史读数，**没有**打包版窗口里的一次实跑。这条按仓库口径具名记在这里，不冒充已取证。

## 五 具名立案（本轮不动）

- **定稿证明拒绝的「该不该终态」仍缺证据**：需要带 `proofCause`（`7c64d0ca` 的 19 码闭集）的构建上复跑
  同一语料、按码分桶。上一轮那 20 行全部早于该字段，给不出是哪条规则拒的，不许猜。

## 六 顺手核对（不属于本单元，写在这里防重做）

同一份打包版语料里 `error` 家族第一名是 91 行 `uncaughtException: write EPIPE`（runId 同一个，11-09→11-13）。
`src/main/console-pipe-guard.ts`（`e031864e`）正是照同一批读数写的、已在 `index.ts:254` 接线、8 条用例全绿
⇒ 这 91 行来自修复之前的那个打包实例，不是缺口。下一轮别再为它立项。
