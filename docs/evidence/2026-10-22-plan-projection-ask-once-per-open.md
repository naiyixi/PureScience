# 「这个会话有计划吗」每次打开只问一次

日期：2026-10-22 · 单元：渲染层重复读取（`acp:get-plan-projection`）· 提交见文末

## 1 现象：一条读通道被问了 726 次，中位 3.8 秒

开发实例的主进程日志（`logs/headless.out.log`，慢通道上报阈值 50 ms）里按通道聚合。
**读的时候必须先把两类行分开**：本文件里 `acp:get-plan-projection` 有 **726 条 `ipc handler was slow`**（≥50 ms）
和 **26 条 `ipc handler rejected`**（`Cannot read runtime context for a missing Session`，都是亚毫秒级）。
下面的分布**只统计前者**（n 与慢行数逐个相等，可自证）：

```
channel = acp:get-plan-projection   (ipc handler was slow)
n = 726        median = 3,819 ms      p95 = 121,600 ms      max = 125,341 ms
sum = 13,396,660 ms ≈ 3.7 小时
```

只看总行数会把 26 条亚毫秒的拒绝行混进中位数里、把 3.8 秒读成几百毫秒。命令（先按行的种类分块，只在 `was slow` 块里取该通道；可就地复跑）：

```bash
awk '/ipc handler was slow/{slow=1; ch=0; next} /ipc handler rejected/{slow=0; next}
     slow && /channel:/{if ($0 ~ /get-plan-projection/) ch=1; next}
     slow && /durationMs:/{if (ch) print $2; slow=0}' logs/headless.out.log \
  | sort -n | awk '{a[NR]=$1; s+=$1} END {printf "n=%d median=%.0f p95=%.0f max=%.0f sum=%.0f\n", NR, a[int((NR+1)/2)], a[int(NR*0.95)], a[NR], s}'
```

它是除「保存会话」「notebook 状态」之外被调用次数最多的读通道。这个数字要分两半读，**一半是次数、一半是单次成本**：

- **次数**：本单元治的那一半。同一个问题在一次「打开某个会话」里被问了不止一次。
- **单次成本**：主进程每回答一次都要进全局持久化队列（读与写同一条 FIFO）、把整份会话 JSON 读出来解析。
  这一半**不在本单元**，见 §5。

## 2 根因：effect 的依赖是整个 `activeSession` 对象

修复前的形状（`WorkspacePage.tsx`）：

```ts
useEffect(() => {
  if (!activeSession || activeSession.activePlanProjection || !getPlanProjection) return
  void getPlanProjection(activeSession.projectId, activeSession.id).then(/* … */)
}, [activeSession, setActivePlanProjection])
```

`activeSession` 由 `useRenderSessions()` 给出，**每一次工具活动、每一条流式 delta、每一次状态迁移都会换一次身份**。
于是同一次「打开」里，effect 会跟着对象身份再跑一遍，而答案并没有变。

全树的生产消费方只有两处，读的时候别把它们混成一处：

| 位置 | 什么时候问 |
|---|---|
| `WorkspacePage.tsx` 这个 effect | 每打开一个还没有计划的会话（**无用户动作**，本单元治的就是它） |
| `session-plan/respond-to-session-plan.ts:45` | 用户对计划做出决定之后刷一次（一次决定一次，合理） |

更隐蔽的一条：**修复路线自己会触发一次重问**。这一半读通道同时承担一个兜底——
当会话状态是 `waiting-plan-approval` 而主进程说「没有计划」时，把卡住的状态解开（`finishRun`）。
`finishRun` 改状态 ⇒ `activeSession` 换身份 ⇒ effect 再跑一遍 ⇒ 又去问同一个问题。
也就是说**每一次成功的修复都会换来一次无用的重问**，而重问的那一次答案必然与刚拿到的相同。

顺带记录一条被证伪的假设：本轮开始时以为「每个流式 delta 都会问一次」。**不成立** ——
页面走 `useRenderSessions()`（按设计不随 chunk 重渲），流式文本的更新不触发这个 effect。
真正多出来的是上面那条修复路径的重问，以及任何一次让 `activeSession` 换身份的状态迁移。

## 3 修法：按「打开」记一本账

`WorkspacePage.tsx` 新增 `planAskLedger`（`useRef`），记录**当前这次打开**是哪个会话、问过哪些状态：

- effect 的依赖收窄为 `planAskSessionId / planAskProjectId / planAskStatus / planAskHasPlan` 四个**值**，
  不再是整个对象；对象换身份但四个值不变时 effect 不再跑。
- 账本按会话 id 重置：**切走再切回来算一次新的打开**，仍会问一次（不把「只问一次」做成「问过就永远不问」）。
- 状态**真的迁移**时（进入等批准）仍会再问一次 —— 兜底修复路线原样保留，这是它有意义的唯一情形。

## 4 变异证明（每条只红对应的一条用例）

| 变异 | 结果 |
|---|---|
| 去掉账本去重（每次都问） | 只红「打开只问一次」：`expected 3 to be 2` —— 多出来的那一次正是修复路径自己触发的重问 |
| 账本不随「打开」重置 | 只红「切走再切回来算新的一次打开」 |

用例文件 `WorkspacePage.plan-projection-ask.test.tsx`（4 条）：

1. 打开一个没有计划的会话 ⇒ 只问一次；
2. 五次真写入的工具活动（先断言 store 对象确实换了身份且 `activities` 增加，否则这条是假绿）⇒ 不再问；
3. 状态真的迁移到等批准 ⇒ 仍再问一次，且 main 说没有计划时把卡住的状态解开；
4. 切走再切回来 ⇒ 算新的一次打开，会再问。

## 5 边界（不许读成更强）

1. **没有真机窗口读数**：`blocked-by` = 内存闸门（本轮开工时空闲物理页 4,903 ≈ 76 MB、
   `swap used 12,857 MB / 14,336 MB`）。本单元的证据是**生产日志的既有读数 + 渲染层用例**，不是窗口读数。
   解封判据（**写清楚是哪种读数**）：`build:e2e` → 打开一个还没有计划的会话 → 看该通道的慢行条数。
   ⚠️ 这条判据有个**仪器缺口**：慢行只带 `channel / surface / durationMs / errorCategory`，**不带会话 id**,
   所以不能用日志把「一次打开」切开。要么按「同一时间窗内该通道的条数」比前后（需要一段安静窗口），
   要么先在慢行里补一个可归属的字段再取窗口读数。**记为可观测性缺口，不用推测值冒充。**
2. **单次 3.8 秒那一半没治**：主进程侧的排队与整份 JSON 解析仍在。**具名立案**：
   下一单元应做「用既有侧车/摘要回答这一个问题，或让这条读不排在别人多秒的写后面」，
   `blocked-by` = 需要一台不抖的机器上一次分段读数（读的排队时间 vs 解析时间）。
3. **同一通道上另有 26 条拒绝**（`Cannot read runtime context for a missing Session`，亚毫秒）——
   那是「页面在问一个主进程已经不认识的会话」，与次数无关、本单元未改；**单独记一笔**，不在本单元。
4. 只改渲染层，**不新增通道、不动契约计数**：零新键、零 pin 变化。
