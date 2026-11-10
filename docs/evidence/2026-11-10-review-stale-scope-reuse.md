# 打开复核面板时的陈旧判定：同一回合的复核只重算一次

日期：2026-11-10（执行器单元）
相关：`src/main/reviewer/stale-reviews.ts`、`src/main/reviewer/ipc.ts`、`docs/plan-2026-10-03-next-queue-and-round-convention.md` §三百零五

## 一 起因：慢 IPC 分桶

真机日志 `~/Library/Logs/PureScience/main.{log,1.log,2.log}`（2026-11-04 → 11-10）里
`ipc handler was slow` 共 **4,920** 条。按通道分桶（`n / med / p90 / p99 / max`，毫秒）：

| 通道 | n | med | p90 | p99 | max | 其中「本进程在算」 |
| --- | --- | --- | --- | --- | --- | --- |
| `sessions:save-session` | 3,776 | 108 | 580 | 12,181 | 181,067 | 2,586 |
| `notebook:state` | 164 | 86 | 269 | 1,578 | 1,617 | 93 |
| `reviewer:get-for-session` | 161 | 213 | 1,983 | 42,027 | 71,275 | 104 |
| `sessions:import-posture` | 102 | 183 | 995 | 2,854 | 3,908 | 54 |
| `notebook:list-runtimes` | 101 | 1,262 | 5,838 | 5,848 | 5,851 | 2 |
| `artifacts:read-preview` | 83 | 125 | 990 | 8,240 | 8,241 | 56 |

两条边角结论先钉住，免得下一轮重查：

- **三条 16 分钟量级不是缺陷读数**：`network:check-connectivity` 的 980 s / 972 s / 428 s 三次
  全是 `cpuShare` 0.001 的 `no-cpu-in-process`，时间戳落在夜里，`pmset -g log` 显示当晚每 **943–944 s**
  一次「Sleep Service Back to Sleep」⇒ 那是**机器睡了**，方法与既有 `cpuShare` 词汇已能读出，不改代码。
- **`acp:send-prompt` 的 10 分钟中位不是慢**：那是回合本身的工作量（24 次、cpu 平均 15 万 ms），
  阈值对它是噪声，属已知口径，本单元不动。

## 二 缺口：`reviewer:get-for-session` 的 flag 段按「每条复核一次」重算

同一份日志里它自己的分段行（`review load segments`，共 73 条，阈值 250 ms）：

| 段 | med | p90 | max | 合计 |
| --- | --- | --- | --- | --- |
| `reviewsQueryMs` | 193 | 2,085 | 27,183 | 79,684 |
| `sessionLoadMs` | 78 | 638 | 15,711 | 61,314 |
| `flagMs` | 319 | 2,311 | 52,162 | 145,104 |

最坏一条（2026-11-09T11:02:17Z，61 条复核）：`totalMs` 71,274、`flagMs` 52,162、`heldMs` 46,480。

`flagMs` 是「为每条已完成复核重算一次当前回合范围」——`stale-reviews.ts` 逐条调用
`resolveTurnScopeWithArtifactDigests`，而后者**每次都会把该回合的每个产物整文件流式哈希一遍**
（`artifact-digest.ts`，并发 4），并对每个版本号做一次数据库解析。

真机数据（**打包版库 `~/.purescience/purescience.db` 只读查询**，585 条 `Review`、235 个会话）：

| 会话 | 完成复核 | 不同的 (turn, branch) | 产物引用 | 去重后引用 |
| --- | --- | --- | --- | --- |
| `d8da1631` | 60 | **33** | 58 | 54 |
| `58c30736` | 19 | **9** | 48 | 45 |
| `6327318c` | 18 | **7** | 40 | 29 |
| `38588c34` | 15 | **8** | 38 | 38 |
| `73129ced` | 12 | **6** | 17 | 17 |

即：一个会话里**多条复核落在同一个回合上**（修复环的重复核就是这样，它的 `scope` 记的是修正回合，
行却挂在原回合下），于是 60 条复核被重算 60 次，而真正不同的输入只有 33 组。

## 三 交付

- `stale-reviews.ts`：`flagStaleReviews` 内建一张 `Map<key, Promise<TurnScope>>`，
  key = `scope.turnMessageId \0 scope.messageBranchId`（**读的是存储范围里的那两个字段**，
  不是行上的 `turnMessageId`）⇒ 同一回合的复核共用一次重算。失败的 promise **留在表里**：
  同样的输入再算一次会同样失败，共用它的每条复核都照旧 `stale: true`（fail-closed 不变）。
- 新增可选出参 `StaleReviewScopeStats { scopeComputations, scopeReuses }`，由 `ipc.ts` 的
  `getForSession` 传入，并**只在那条慢行上**（`totalMs >= 250`）带上这两个字段——
  下一次读数就能看见「N 条复核花了几次重算」，不必再从复核清单反推。
- 不打开新的跨调用缓存：文件的当前字节必须真的重读，否则「外部改了内容」就看不出来了。

## 四 判据与自证

| 环 | 读数 |
| --- | --- |
| 定向 vitest（`flag-stale-reviews` / `ipc`） | **2 files / 45 passed** |
| reviewer 整个目录 | **27 files / 315 passed**，exit 0 |
| `tsc --noEmit -p tsconfig.node.json --composite false` | exit 0 |
| `eslint --no-cache`（本笔 4 文件） | 0 error / 0 warning |

新增三条用例：同一回合的两条复核只解析一次版本、只哈希一次；
不同回合仍各算一次；**共用的一次重算失败时，共用它的每条复核都 `stale: true`**。

**变异自证**：把 `scopeByTurn.get(key)` 短路成永远 `undefined`（即去掉复用）⇒
`recomputes one scope for reviews of the same turn…` 与
`fails closed on every review sharing a turn…` 两条当场红（2 failed / 8 passed），还原后 10 条全绿。

## 五 边界（不许读成更强）

1. **没有真机 UI 读数**：资源闸门未开（`vm_stat` 空闲页 3,816 ≈ 62 MB、swap 9.2 G 用 7.7 G），
   且慢读数发生在**打包版**上。本笔证据 = 真机日志的分桶与分段 + 打包版库的真实复核形状 + 单测。
   下一版装出去后的判据：新的 `review load segments` 行里出现 `scopeComputations < reviews`
   （`scopeReuses > 0`），且同一会话的 `flagMs` 同比例下降。
2. **收益是按去重比例预计的，不是实测**：`d8da1631` 上重算次数 60 → 33（−45%），
   `58c30736` 上 19 → 9（−53%）；实际省下的毫秒取决于该回合产物的大小，未测。
3. **`reviewsQueryMs` 与 `sessionLoadMs` 占的另外一半没动**：它们分别是项目库（单连接）查询与会话文档解析，
   属不同根因，另案。
4. **顺序仍是一条一条**（不改成并行）：注释里写明并行会乘上产物哈希的并发，长发复核历史的会话会打空文件句柄。
