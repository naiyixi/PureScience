# 未读任务的落库被一次事务超时整盘丢掉（真机读数 + 批量事务）

> 单元范围：**`UnreadTaskSession` 这张表的写入形状**。读数取自用户自己机器上打包版应用的主日志
> （`~/Library/Logs/PureScience/main.log`，13,176 行，窗口 2026-10-29 14:42Z → 2026-11-01 13:54Z）。
> 本笔只改 `src/main/notifications/**`。

## 一 读数（本次改动之前）

### 1.1 故障本身：两次，同一行

`unread task state failed` 共 **2** 条，两条都是 Prisma 的交互式事务过期：

| 时间（Z） | 层次 | 原话（节选） |
| --- | --- | --- |
| 2026-10-29T17:39:10.501Z | warn / main | `Invalid transaction.unreadTaskSession.findMany() invocation in …/out/main/unread-task-repository-YmavVEWF.js:66:56 … Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction` |
| 2026-11-01T01:15:58.401Z | warn / main | 同上，同一个方法、同一行 |

产物里的 `:66` 即 `reconcile()` 里那条 `findMany` —— **第一条查询还没发出去，事务就已经过期**。
调用方（`src/main/index.ts` 的 `onError`）只做 `log.warn('unread task state failed', error)`，内存态与落库态就此分叉：
下次启动 `restore()` 读回旧那一盘，用户已经读过的会话重启后徽标又会亮。

### 1.2 为什么会过期：一次停摆 + 一个 N 次 await 的回调

- Prisma 给**交互式事务回调** 5 s 预算；回调里每多一次 `await`，就多一次「等事件循环回来」的机会。
- 同一份日志里 `event loop stalled` **1,390** 条（11-01 单日 1,260 条；`lateMs` 最大 268,736 ms；
  典型窗口 `windowMs 1,845 / lateMs 1,345`），与之重合的机器状态：`loadAvg1m ≈ 71`、`freeMemMb ≈ 60`。
- 旧实现在回调里对**每一条缺失会话**各发一条 `create`，而快照上限是 `MAX_UNREAD_TASK_SESSIONS = 1000`
  ⇒ 最坏 1,000 次 `await` 挤在同一个 5 s 预算里。这不是「慢」，是结构上注定会撞。

### 1.3 复跑配方（只读）

```bash
python3 - <<'PY'
import json
rows=[json.loads(l) for l in open('/Users/totota/Library/Logs/PureScience/main.log',encoding='utf-8') if l.strip()]
print('unread task state failed', sum(1 for r in rows if r.get('msg')=='unread task state failed'))
print('event loop stalled', sum(1 for r in rows if r.get('msg')=='event loop stalled'))
for r in rows:
    if r.get('msg')=='unread task state failed':
        print(r['t'], (r.get('data') or {}).get('message','')[:120].replace('\n',' '))
PY
```

## 二 交付

| 文件 | 改动 |
| --- | --- |
| `src/main/notifications/unread-task-repository.ts` | `reconcile()`：读 → 算差 → **一次批量事务**（`$transaction([...])`，数组形态）；删除仍按 400 分块，新增改 `createMany`（同样分块）。`reconcileSessionCatalog()` 同形改造 |
| 同上 | `UnreadTaskReconcileError`：消息带 `desired/existing/created/deleted` 与原错因（`cause` 保留），经 `onError` 落到 `unread task state failed` 那一行 |
| `src/main/notifications/unread-task-repository.test.ts` | +2 例（真 SQLite 项目库）：600 条快照 ⇒ `$transaction` 只调 1 次、参数是数组、长度 2、`load()` 逐条等于快照顺序；触发器拒收 ⇒ 抛具名错、消息含四个数、整盘回滚 |

语句数：旧 `1 + N`（N = 缺失条数）→ 新 `≤ ceil(删除/400) + ceil(新增/400)`（本机典型 2）。

## 三 门禁（全部实跑）

| 环 | 读数 |
| --- | --- |
| `src/main/notifications` 整目录 | 11 文件 / 169 例全绿 |
| 变异自证 | 改回「交互式事务 + 逐条 `create`」⇒「一次批量事务」那条当场红（`$transaction` 参数不是数组） |
| `eslint --no-cache`（本笔 2 文件） | 0 error / 0 warning |
| 双 typecheck（`--composite false`） | 本笔 0 错（余 4 条全在并行会话在制的 `src/main/references/screening-service.ts`，未去改） |

## 四 边界

1. **没有「超时不再发生」的真机读数**：本机此刻跑的是打包版 v2.21.1，本笔代码要等下一次装包才在真实会话里跑。
   证据是结构性（事务里没有回调、语句数常数级）+ 两条确定性用例；新读数出现前不写「已消除」。
2. **没动「事件循环为什么停」**：绝大多数 stall 与同机并发跑认证/打包的机器状态重合，归因在机器侧。
3. **`save()` 仍是整盘快照语义**（未去抖、未增量）；「保留行 + 新增行交错时按 id 而非按快照排序」是**既有**行为，本笔没动也未声称修掉。
