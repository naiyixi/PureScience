# 自动复核在修正回合期间又起了一份（真机读数 + 主进程归属闸）

> 单元范围：**reviewer 的「一个回合只该有一份复核」这条不变量**。读数取自用户自己机器上打包版应用的主日志
> （`~/Library/Logs/PureScience/main.log`，2026-10-29 → 11-01），修复落在主进程的唯一入口。

## 一 读数与复跑

数据源：`~/Library/Logs/PureScience/main.log`（JSONL，10,052 行）。复跑配方（只读，不改任何状态）：

```bash
python3 - <<'PY'
import json, datetime
rows=[json.loads(l) for l in open('/Users/totota/Library/Logs/PureScience/main.log',encoding='utf-8') if l.strip()]
t=lambda r: datetime.datetime.fromisoformat(r['t'].replace('Z','+00:00'))
corr=[r for r in rows if (r.get('msg') or '').startswith('[Auditor] correction turn complete')]
trig=[r for r in rows if (r.get('msg') or '')=='review triggered']
loops=[r for r in rows if (r.get('msg') or '').startswith('fix loop: running re-review')]
print('修正回合完成', len(corr), '| 复核触发', len(trig), '| 修正轮次的定向复评', len(loops))
print('其中 2 秒内又起了一份复核的轮次',
      sum(1 for c in corr if any(0 <= (t(x)-t(c)).total_seconds() <= 2 for x in trig)))
PY
```

读数（本轮实跑）：

| 量 | 值 |
| --- | --- |
| `[Auditor] correction turn complete` | **11** |
| `review triggered`（全部会话，含 4 条 e2e 夹具会话） | 17 |
| `fix loop: running re-review`（修正轮次自己的定向复评） | 11 |
| **修正回合结束后 2 秒内又起了一份自动复核的轮次** | **10 / 11** |
| 同一批区块 3 秒内拿到**相反结论**的配对 | **1**（`10:01:36 flagged / 5 条` ↔ `10:01:38 pass / 4 条`） |

一条典型时间线（同一会话，原字段照抄）：

```
09:49:16.021  acp                prompt stopped                      {sessionId: 58c30736…, stopReason: end_turn}
09:49:16.052  reviewer:correction [Auditor] correction turn complete
09:49:16.277  reviewer:ipc        review triggered                   {turnMessageId: message-…-19}   ← 自动复核
09:49:16.570  reviewer:orchestrator review created                  {reviewId: cmvxnejxz001b, blocks: 12}
09:49:16.586  reviewer:orchestrator fix loop: running re-review      {round: 0}
09:49:16.617  reviewer:orchestrator scoped re-review created         {reviewId: cmvxnejzz001c, blocks: 12}
```

⇒ 修正回合的 stop 一落地，主进程起了**第二份**复核；340 毫秒后修正轮次自己的定向复评也起来了。两份复核的
区块数相同（12），是同一批内容的两个独立 reviewer 会话（两个 reviewer MCP 服务器端口相邻），各自付一次模型与
出网成本。上面那条相反结论的配对就是这种并发的后果：同一批区块 1.4 秒内先被判 `flagged`、再被判 `pass`。

## 二 为什么渲染层的一次性抑制接不住

抑制链路本来是存在的：修正提示**发出之前**，主进程广播 `reviewer:suppress-next-auto-review`，渲染层把该会话
标记为「跳过下一次自动复核」（一次性，用过即清）。它挡不住本轮这 10 次，因为它是**「下一次调用」**而不是
**「那个回合」**：

- 自动复核的触发不是同步的 —— 先是 100 ms 的落定定时器，进入后还有最多 4 次 `started:false` 重试（每次间隔
  400 ms）。**排在前一个回合名下的触发可能晚到**，它一到就把一次性标志吃掉；于是修正回合自己的 stop 再触发时，
  标志已经没了。
- 反过来也一样：标志还在时被吃掉的若是修正回合的触发，它就静默变成了「这个回合没被复核」，而日志里两者同形。

实测形状：该会话 09:45:00 有一个用户回合结束，**直到 09:49:16 才出现它的复核**（4 分 16 秒后，正好落在修正回合
的 stop 之后），并且与修正轮次的定向复评并发。哪一条早退吃掉了 09:45 那次触发，**在此之前没有任何具名记录**
（渲染层三条早退都不留痕），这一条已单独立案，见 §五。

## 三 交付

| 位置 | 改动 |
| --- | --- |
| `src/main/reviewer/ipc.ts` | `triggerReview` 在最前面加**归属闸**：`origin === 'auto'` 且该会话的修正轮次仍在跑（`fixLoopAbortControllers` 里有它的键）⇒ 不启动，返回 `{started:false, reason:'fix-loop-active'}`，并写一行具名日志 `auto review skipped: the fix loop owns this session`（带 `sessionId` / `turnMessageId`） |
| `src/shared/reviewer.ts` | `ReviewRunNotStartedReason` 增加 `'fix-loop-active'`，并在该联合的类型注释里写明「永不重试」的理由（修正轮次自己的定向复评就是答案）与「手动复核不受影响」 |
| `src/main/reviewer/ipc.test.ts` | 一条新用例：轮次结束 → 复核启动 → 修正轮次开幕 ⇒ 自动请求被拒（`fix-loop-active`，且 `runReview` 调用数不变）；手动请求照常启动；轮次收尾后同一自动请求恢复启动 |

**三条设计判据**：① **判据是状态不是时序** —— 修正轮次的生命周期已经有权威来源（`fixLoopAbortControllers`
的增删就挂在 `onFixLoopStart` / `onFixLoopEnd` 上），用它比再算一遍时序可靠；② **闸放在唯一入口** —— 主进程是
所有入口（窗口、Web 面、CLI）的唯一汇点，渲染层的一次性标志只留作第一道早退，不再是唯一防线；③ **拒绝要有名字** ——
`started:false` 若是静默的，就与「没有回合」同形，所以给了具名 reason + 具名日志行。

## 四 门禁（全部实跑）

| 环 | 读数 |
| --- | --- |
| 定向：`src/main/reviewer`（整目录） | **27 文件 / 308 passed**（含新用例；`ipc.test.ts` 35 例） |
| 变异自证 | 把闸的条件短路成 `false && …` ⇒ 新用例当场红（`expected { started: true } to deeply equal { started: false, … }`），改回后 35 例全绿 |
| 双 typecheck（`--composite false`） | 本笔 **0 错**；两边各余 **4 条全在并行会话在制的 `screening-service.ts`**（`TS6133`×3 / `TS2564`×1），未去改 |
| `eslint --no-cache`（本笔 3 文件） | **0 error / 0 warning** |

## 五 边界（不许读成更强）与具名未办

1. **没有真机读数证明「不再起第二份」**：本机跑着 dev 常驻实例（`build:e2e` 会抢 `out/`），本轮不起打包实例。
   本笔的证据是「确定性用例 + 上面的现场归因」；下一次真实修正回合的主日志里应出现
   `auto review skipped: the fix loop owns this session`，届时以它为读数。
2. **「用户回合 09:45:00 没有被复核、直到 09:49:16 才补上」这条没有修**：渲染层 `triggerAutoReview` 的四条早退
   （`session` 不在、`autoReviewEnabled === false`、两次组装不出请求、一次性抑制）**全都不留痕**，所以无法回指是
   哪一条。渲染层没有写进主日志的通道（`diagnostics:renderer-failure` 是失败通道，不为这种事滥用）⇒ 这一条要么
   在渲染层加一条可上报的具名读数，要么把决策整体上移到主进程。**已具名立案，不在本笔范围。**
3. **闸只管自动路径**：手动「请求复核 / 重跑」在修正轮次里仍然可以启动（用户明确要求时应当能跑），这是有意的，
   不是漏网。
4. **并发第二份复核若来自别的入口（Web 面）**，本闸同样生效（主进程唯一入口），但本轮**没有**在 Web 面上取证。
