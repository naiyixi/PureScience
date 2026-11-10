# 审批过期与「策略拒绝」分开：17 次超时里没人回答，而客户端读到的是「host not permitted」

> 单元范围：**出站审批（egress approval）的三种结局**。读数取自用户自己机器上打包版应用的主日志
> （`~/Library/Logs/PureScience/main.log` + `main.1.log`，2026-11-05 → 11-09），修复落在主进程。

## 一 读数（先量后改）

复跑配方（只读）：

```bash
python3 - <<'PY'
import json, collections
rows=[]
for p in ('main.log','main.1.log'):
    for line in open('/Users/totota/Library/Logs/PureScience/'+p, encoding='utf-8', errors='replace'):
        if '"egress approval' in line or '"egress decision' in line:
            d=json.loads(line); rows.append(d)
print(collections.Counter(d['msg'] for d in rows))
for d in sorted(rows, key=lambda d: d['t']):
    data=d.get('data') or {}
    print(d['t'], d['msg'], data.get('requestId'), data.get('host'), 'pending=', data.get('pending'))
PY
```

读数：

| 计数 | 值 |
| --- | --- |
| `egress approval requested` | **21** |
| `egress approval timed out` | **17** |
| `egress decision applied` | **4** |

两件事在这组数字里同时成立：

1. **17 次请求等满 60 秒后被拒**，而客户端读到的拒绝句是 `PureScience egress allowlist: host not permitted`
   —— 与「这个目的地根本不许去」逐字相同。可实际上用户被问过，只是没答（`requested` 那条同时记着
   `hasRenderer: true`）。用失败的读法，这 17 次会让下一次去申请一个用户从来没有拒绝过的权限。
2. **挂起表只增不减**：`pending` 从 11-05 的 **23** 一路涨到 11-09 的 **39**，中间 4 次真实决定才把它减下去，
   17 次超时一次都没减。根因读源码就能定死 —— 代理的超时分支只调 `onDenied()`，而运行时的
   `pendingDecisions` 只有在 `respondToEgressApproval()` 里被删；过期这条路**没有第二个出口**。
   每条滞留条目还牵着被挂起的响应对象（HTTP 的 `res` 或 CONNECT 的 `socket`），所以它不只是计数器错，
   还把已经结束的请求留在内存里。

## 二 交付

| 位置 | 改动 |
| --- | --- |
| `src/main/net/egress-proxy.ts` | 新增 `EgressApprovalRefusal = 'denied' \| 'expired' \| 'no-handler'`；`requireApproval` 的拒绝回调带上理由；超时分支调新增的 `onApprovalExpired(request)` 并在日志里写 `outcome: 'expired'`（行名 `egress approval timed out` 保持不变，既有 grep 配方仍能 join）；过期那条 403 的正文改成 `…: approval expired for <host> — no decision arrived within <n> s; ask the user to approve it again`，策略拒绝仍是原来那句（`POLICY_REFUSAL` 提成常量，一处真源） |
| `src/main/net/egress-runtime.ts` | 接 `onApprovalExpired`：从 `pendingDecisions` 删掉该条并记 `egress approval expired`（带 `released` 与删后 `pending`）；`EgressRuntimeOptions` 增可选 `approvalTimeoutMs`（测试缝，理由与代理里那个同一条：60 秒是**被测行为**，睡真一分钟的用例只会被跳过） |
| `src/main/net/egress-failure.ts` | `describeEgressFailure` 在家族循环**之前**认出过期句（否则 `allowlist` 那条通用规则先命中，动作句会继续写「去申请权限」）：家族仍是 `blocked`（用户可解），但 reason/action 换成「到点没人答，现在去请用户批准或加白名单」 |

判据：**过期是「有人被问过、没答」，不是「不许」**；两条路给的动作不同，所以句子必须不同。
时钟仍只有一个（代理的 deadline），运行时只是被通知，不再自己算一份会漂移的期限。

## 三 门禁（全部实跑，取自最后一次改动之后）

| 环 | 读数 |
| --- | --- |
| 定向 vitest（`egress.test.ts` + `egress-failure.test.ts`） | **2 files / 46 passed** |
| 受影响簇（`src/main/net` + `src/main/settings`） | **105 files / 1589 passed**（3 skipped），exit 0 |
| 双 typecheck（`--composite false`，堆 4096） | node **0**；web **0** |
| `eslint --no-cache`（本笔 5 文件） | **0 error**（1 条 prettier 换行警告，已 `prettier --write` 收掉） |

**变异自证**（两处一起变异）：把 `this.onApprovalExpired?.({ requestId, host })` 注释掉、并把
`refusalMessage` 短路成永远返回 `POLICY_REFUSAL` ⇒ 两条用例当场红
（`refuses a suspended request at the approval deadline…` 与 `releases a suspended approval at the deadline…`）；
还原后 46 例全绿。

## 四 边界（不许读成更强）与验收判据

- **没有做「无窗口就立即拒」**：审批卡也能被浏览器/远端客户端回答，而主进程的
  `hasRenderer` 只表示「处理器接上了」。改成按窗口数判定会把 Web 侧的审批一起关掉，属另一件事，未做。
  现在这一版的诚实表述是：**没人答时到点会拒，并且说出来是过期**。
- **卡片行为未改**（渲染层本来就在 deadline 上把卡标成过期并收起按钮）；本笔只改主进程与失败词汇。
- **真机验收判据（下一版装出去之后）**：
  1. 同机日志出现 `egress approval expired` 且随后 `requested` 行里的 `pending` **不再单调增长**；
  2. 笔记本/连接器那一侧读到的拒绝文字含 `approval expired`，不含「没人问过」的暗示；
  3. 过期之后立刻重试一次并且这次有人答 ⇒ 请求放行（同一 host 不需要重启应用）。
- 未取证：真窗口读数（本轮资源闸门：空闲页与 swap 未开）——本条证据是「真机日志读数 + 源码归因 + 全量类簇单测」。
