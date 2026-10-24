# 出网隧道：客户端中途消失会抛到进程级，并把目标侧连接留成僵尸

日期：2026-10-24 · 单元：队列档 §两百二十四（队列约定 B 段已耗尽后的自拟单元）
· 提交范围：`src/main/net/egress-proxy.ts`（`handleConnect` 生命周期 + 一条新日志字段）＋
`src/main/net/egress.test.ts`（两种客户端终结形态各一条用例）

## 1 问题提法（先有读数，再动手）

打包版 v2.16.0 的真机日志（`~/Library/Logs/PureScience/main.log` 与两份轮转，**22,284** 条 JSON，
窗口 `2026-10-23T10:59:43Z → 2026-10-24T01:57:52Z`；当前实例 `runId 189d5c74`，起始
`12:42:55.978Z`）里有两条**进程级** `uncaughtException`，都紧跟在同一条隧道失败之后：

| 时间（UTC）                | 记录                                                                                                                                                     | 帧                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `13:08:11.026Z`            | `egress tunnel target failed` `{host: api.anthropic.com, port: 443, family: reset, code: EPIPE, error: "This socket has been ended by the other party"}` | —                                                   |
| `13:08:11.119Z`（+93 ms）  | `uncaughtException` `{errorCategory: system, message: "write after end"}`                                                                                | `_write (writable:491:11)`                          |
| `13:08:15.093Z`（+4.07 s） | `uncaughtException` `{errorCategory: system, message: "write EPIPE"}`                                                                                    | `afterWriteDispatched (stream_base_commons:159:15)` |

两条都不是「网络抖动」的必然产物：`uncaughtException` 是**我们这一侧有流错误没人接**的形状。读源后判据是清楚的：

- `handleConnect` 拿到的 `socket` 是 node HTTP 服务器在 `connect` 事件里交给我们的裸 `Duplex`，
  **我们从未给它挂 `'error'`**；目标侧 `targetConn` 有监听，客户端这头没有。
- 隧道建立后的收尾不是单一出口：`refuseTargetFailure()` 写一句 `HTTP/1.1 502 …`（对一个已经在跑 TLS 的
  隧道＝协议垃圾）后 `socket.destroy()`，而两条 `pipe()` 仍然武装着；「谁先退、谁还在写」全靠时序。

## 2 本地复现（临时探针，跑完即删）

用真 socket 对（临时文件 `src/main/net/__probe-egress.test.ts`，**未提交**）跑三种客户端终结形态，
把「逃到进程级」的错误与「目标侧连接有没有关」都打成一行读数：

| 场景                                                             | 逃到进程级的错误      | 目标侧连接                                   |
| ---------------------------------------------------------------- | --------------------- | -------------------------------------------- |
| A 隧道已建立，**客户端 reset**（TLS 客户端取消请求就是这个形状） | **`read ECONNRESET`** | **永不关闭**（目标的 server 无法 `close()`） |
| B 目标先 FIN 再消失，客户端继续灌数据                            | 无                    | 正常关闭                                     |
| C 客户端半关（`end()`），目标继续写                              | 无                    | 正常关闭                                     |

⇒ 真机上那两条 `uncaughtException` 的成因在 A：**客户端这头没有 `error` 监听**（`read ECONNRESET` 直接
冒到进程级），而收尾路径没有把目标侧连接关掉（僵尸 socket 一直挂到进程退出）。

## 3 改法

`handleConnect` 改成「一个 `teardown()` 拥有所有出口」：

| 位置                  | 改动                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `teardown()`          | 只生效一次（`settled`）；**先 `unpipe` 两侧再 `destroy`**，所以任何一处收尾之后都不可能有写入落在已结束的流上；整体 `try/catch`，诊断不许抛回服务器的 connect 处理器                   |
| `socket.on('error')`  | 新增，具名（`egress tunnel client aborted`，带 `family`/`code`/`established`）—— 这一行以前是**进程级异常**，现在是一次可数的读数                                                      |
| 目标侧 `error` 分支   | 分相位：**未建立** ⇒ 照旧给客户端一句可读的 502（原有行为与用例不变）；**已建立** ⇒ 不再往 TLS 流里写 HTTP 状态行，只落同名日志并多一个 `phase: 'established'` 字段，然后 `teardown()` |
| 目标侧 `connect` 分支 | `settled                                                                                                                                                                               |     | socket.destroyed`时直接`destroy()` 这条目标侧连接（客户端早已走掉时，不建立一条没人的隧道） |
| `deny()`              | 写 403 后走同一个 `teardown()`                                                                                                                                                         |

`refuseTargetFailure()` 拆出 `reportTargetFailure()`（只记日志那一半），日志**消息名与 `family`/`code`
字段全部不变** —— 既有的日志 grep 配方与历史读数仍可跨这次改动拼接。

## 4 门禁（全部实跑，取自最后一次改动之后）

| 环                                           | 读数                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `src/main/net/egress.test.ts`                | **30 passed**（原 28 + 新增两种终结形态各 1）                        |
| `src/main/net` 整域                          | **8 files / 91 passed**，exit 0                                      |
| 变异 ①：删掉 `socket.on('error')`            | 恰红：`expected [ Error: read ECONNRESET { … } ] to deeply equal []` |
| 变异 ②：整份 `egress-proxy.ts` 回退到 HEAD   | 恰红：`expected 'timeout' to be 'closed'`（目标侧连接一直没关）      |
| `eslint --no-cache` + `prettier --check`     | 见提交前的读数（本文件与用例两处）                                   |
| 双 typecheck（`--composite false`，堆 8192） | 见提交前读数                                                         |

## 5 边界（不许读成更强）

1. **`write after end` 那一帧本地没有原样复现**。修法不是「猜那一帧」，而是让「收尾之后任何写入」在结构上
   不可能发生（单一 `settled` 出口 + 先 `unpipe` 再 `destroy`），并把客户端错误从「进程级异常」变成一条
   具名日志。真机上它的成因未单独证明，按同一族（隧道两端的流错误没人接）处理。
2. **已建立隧道的语义有一处行为变化**：以前目标在隧道建立后失败，我们会往 TLS 流里塞一句
   `HTTP/1.1 502 …`（客户端只会看到协议垃圾）；现在直接关闭连接。这是「让客户端的报错更真」，不是放宽。
   未建立时的 502 行为**一个字节未改**（既有用例 `names the reason a tunnel target failed …` 仍要求
   502 + 具名家族 + `ECONNREFUSED`）。
3. **新日志行还没有真机样本**：`egress tunnel client aborted` 与 `phase: 'established'` 都要等下一次
   「客户端中途取消」才会在日志里出现；旧日志不会回溯出新行。
4. 只有一条结束路径被本条覆盖：**客户端消失**与**目标侧失败**。隧道在**正常**用完后的收尾仍由两条
   `pipe()` 的 end 传播负责，本条未改。
5. 不占版本号（无用户可见文案、无窗口读数，属主进程稳定性修复）。
