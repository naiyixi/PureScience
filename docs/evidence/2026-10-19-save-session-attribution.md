# `sessions:save-session` 的 118.9 秒：不是保存在干活，是一次进程级冻结（附分段与并发读数）

取数日期 2026-10-19。仓库 `naiyixi/PureScience`，基点 `f4a5eba8`（origin/main）。
读数来自**应用自己写的日志**（打包版 `~/Library/Logs/PureScience/main{,.1,.2}.log` + 开发版
`~/Library/Logs/PureScience (DEV)/main.log`，共 67,321 条 JSON 记录），不是推断，也不含自造数据。

## 1. 口径

保存路径每完成一次就判断一次耗时（`SLOW_SESSION_SAVE_THRESHOLD_MS = 200`，
`src/main/session-persistence/coordinator.ts:48`），超过阈值写一条
`session save was slow`，带七段：

| 段 | 含义 |
| --- | --- |
| `queuedMs` | 等会话写入的次序锁 |
| `authorityMs` | 读权威会话（库 + 会话文档） |
| `prepareMs` | 准备落盘的那份数据 |
| `writeMs` | `repository.saveSession` —— JSON 变durable |
| `provenanceMs` | `captureFinalizedMessages` |
| `fileIndexMs` | `fileIndex.syncSession` |
| `aftermathMs` | `writeMs` 之后的一切（旧读数仍可比） |

## 2. 分布（n = 563 条慢记录）

| 段 | 中位 | p90 | 最大 |
| --- | --- | --- | --- |
| queued | 0 ms | 169 ms | 66,668 ms |
| authority | 66 ms | 420 ms | 42,168 ms |
| prepare | 7 ms | 54 ms | 3,786 ms |
| write | 72 ms | 411 ms | 67,082 ms |
| provenance | 10 ms | 166 ms | 6,219 ms |
| fileIndex | 94 ms | 672 ms | 15,039 ms |
| aftermath | 179 ms | 1,050 ms | 20,157 ms |
| **total** | **404 ms** | **2,772 ms** | **113,919 ms** |

两件先摆明的事：

1. **绝大多数「慢保存」不是缺陷**。阈值是 200 ms，中位 404 ms —— 一次 0.4 s 的自动保存在用户看来
   没有任何异常。真正值得管的只有尾部：p99 **23.1 s**，最大 **113.9 s**。
2. 会话通道那条 `118,871 ms` 的记录（`sessions:save-session` 的 `ipc handler was slow`）与
   `totalMs = 113,919 ms` 的 `session save was slow` 是**同一次保存**，差的 4.95 s 是 IPC 层自身开销。
   上一轮把它当成「118.9 s 的通道耗时」是对的，但它只有一个实例，不是两次。

## 3. 最长那条的分段：每一段都涨了同一个倍数

`2026-10-18T02:42:53.847Z`：

```
queued 8,545 | authority 42,168 | prepare 8 | write 46,152
provenance 5,600 | fileIndex 11,446 | aftermath 17,046 | total 113,919
```

与本文件 §2 的中位数相比：authority **639×**、write **641×**、fileIndex 122×、aftermath 95×。
**没有任何一段是「唯一的问题」**：读权威会话（中位 66 ms）与写 JSON（中位 72 ms）涨得一模一样。
这是被外部因素整体拉伸的形状，不是某一步的实现问题。

若单独去看 write，46 s 写一份会话文件（该会话文档量级为 MB）在任何正常磁盘上都不可能；
它只能是「写请求发出去之后，进程没拿到 CPU / 没拿到磁盘」。

## 4. 同一个 150 秒窗口里，别的通道也一起停住了

`02:42:40 → 02:45:10`（44 条记录）：

| 时刻 | 通道 | 读数 |
| --- | --- | --- |
| 02:42:42 | `artifacts:read-preview` ×2 | 46,131 / 46,142 ms |
| 02:42:42 | `artifact version resolve` ×5 | 每条 `queryMs` ≈ 7,258 ms，**`dbCanaryMs` 7,235–7,290 ms** |
| 02:42:53 | `sessions:save-session` | 118,871 ms（本文件 §3） |
| 02:43:48 | `artifact version resolve` ×2 | `readMs` 38,309 ms，**`readEventLoopMaxMs` 12,046 ms** |
| 02:44:15 | `notebook:state` ×3 | 76,051 / 76,237 / 76,622 ms |
| 02:44:15 | `reviewer:get-for-session` | 203,180 ms（§一百九十 已单独归因：它在等这些） |

`dbCanaryMs` 是读路径自己跑的一次 `SELECT 1`：**连 `SELECT 1` 都要 7.2 秒**。
`readEventLoopMaxMs` 7,260–12,046 ms 说明**事件循环本身也停了**。
两者同时发生 ⇒ 停的不是数据库、也不是某条查询，而是**整个进程（很可能连同机器）**。

## 5. 两条被读数否掉的假设

1. **「单连接被长事务占住」**（项目库 `connection_limit=1`，长事务会挡住所有人）：不成立。
   全部日志里带事务超时原文的记录只有 **3 条**（`02:31:18`–`02:36:09`），
   而 canary ≥ 3 s 的尖峰有 **12 条、落在 5 个不同的秒上（02:29:57–02:43:48）**
   —— **0 / 12** 的尖峰前后 15 秒内出现过事务超时。少一个持有者解释不了这些停顿。
2. **「保存的实现里有一步很贵」**：不成立（§3 的等比放大）。

## 6. 仍未知，以及要判它需要什么

canary 尖峰一共只有 **5 个秒**、全在 `2026-10-18` 的 14 分钟里；563 条慢保存中只有 **50 条（8.9%）**
前 120 秒内出现过 ≥3 s 的 canary。也就是说：

- 这 14 分钟的冻结解释了最长的那几条，**解释不了另外 91% 的「慢」**（那些是中位 404 ms 的正常尾）。
- 冻结的**成因**（我们自己的长同步块 vs 操作系统级停顿：换页/磁盘）现有读数**区分不了**：
  Node 的事件循环延迟计时器与 `SELECT 1` 都按墙钟计，进程被换页停住与代码同步阻塞同形。
- 想要一次定因，需要两样现有日志里没有的东西：① **事件循环延迟看门狗**（延迟 > 500 ms 时采一次
  同步栈，直接点名是哪个函数）；② **同一时刻的机器侧读数**（`vm_stat` 空闲页 / `vm.swapusage` / 磁盘压力）。
  这一轮没有取机器侧对照：同期没有第二个持续写日志的进程（同期 DEV 实例没在跑，日志 0 条），
  这一格**姓「未取」不姓「没有」**。

## 7. 本轮为什么不动代码

- 本单元的结论是**证伪**：118.9 s 不在保存的实现里，动保存路径只会把 92% 的正常尾也一起改坏。
- 缺的是仪器、不是修法。凭现有读数去"优化"会把一次机器级停顿写成一次代码缺陷，
  而下一轮再遇到同样的形状时会因为「上次已经改过」而更难判。
- 因此本轮只交付这份读数，并把「看门狗 + 机器侧对照」立成下一单元（判据：同一窗口内
  watchdog 采到的同步栈能点名一个函数，或机器侧读数显示空闲页耗尽 ⇒ 二者必居其一才动手）。
