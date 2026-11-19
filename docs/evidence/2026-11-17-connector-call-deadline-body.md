# 连接器调用的截止时间：它原来只管握手，不管正文（2026-11-17）

## 一 缺陷（读码得出，不是猜）

`src/main/connectors/engine.ts` 的 `doFetch` 有一段注释，写着「截止时间即使传输层忽略 abort 也要赢：
一次卡住的请求必须立刻失败并给出清楚解释，绝不挂到进程级超时」。但代码把 `clearTimeout(timer)` 放在
`finally` 里，而那个 `finally` 在 `fetch` 一返回就执行了 —— **正文读取（`readBody(res)` → `arrayBuffer()`）
发生在定时器已经被清掉之后**。于是最常见的一种半死连接（服务器回了响应头，然后正文再也不来）没有任何
截止时间，与注释承诺的正好相反。

同一处还有两个可观测性问题：

1. **一次连接器超时在任何地方都不留痕**：那句话只发给 agent，随回合消失。三份真机日志（13,730 条 warn/error）
   里 `Request timed out after` 命中 **0 条** —— 不是没发生过，而是从来没被记下来，因此这一族失败**无法取读数**。
2. 失败句不区分「握手没等到」与「正文没等到」，而这两件事对读者的下一步不同（源慢 vs 源卡死）。

## 二 修法

| 位置                                          | 改动                                                                                                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/connectors/engine.ts`               | 定时器跨过正文读取（正文与同一个 `deadline` promise 竞速，abort 经 controller 传到 body 流）；每一处退出路径显式 `clearTimeout`，重试前的退避睡眠不再持有定时器（否则空转的 deadline 会无人竞速地 reject） |
| 同上                                          | 句子分阶段：`deadline reached while waiting for the response headers` / `… the response body`                                                                                                              |
| 同上                                          | 命中截止时间时打一行 `warn`：`connector call deadline reached {connector, tool, host, phase, budgetMs}` —— 这一族的读数从此可数                                                                            |
| `src/main/connectors/engine-deadline.test.ts` | 5 条用例：正文卡住、握手卡住、日志行只打一次且字段齐全、非截止时间的正文错误仍带出网原因、正文正常时读数照旧                                                                                               |

## 三 变异证明（证明这条用例真的在守）

把正文读取改回旧形状（先 `clearTimeout` 再 `readBody`）后重跑新用例：**2 failed | 3 passed**，
两条红的耗时分别是 **60,026 ms / 60,012 ms**（用例自身的超时），即旧实现下这条请求**永不返回**。
还原后 **24 passed（2 文件）**。

## 四 真网络读数（真实 HTTP，走产品自己的模块）

把 `engine.ts` 用 esbuild 打成 ESM 后由 node 直接跑（不是替身；字节与卡顿都来自真实站点）：

```
PROBE control     ok     budget=30000ms elapsed=1777ms bytes=1236      sha=sha256:e2cc53384b277…
PROBE stalled-body failed budget=3000ms  elapsed=3017ms  body-phase    # httpbin 回响应头后正文按 10 s 滴流
PROBE large-file  ok     budget=30000ms  elapsed=7452ms bytes=4973076   sha=sha256:0be5a3b6523de…
```

- **第二行是本片的读数**：真实站点先回响应头、正文滴流，预算 3 s ⇒ 3,017 ms 就结束，句子点名
  `waiting for the response body`，并带上「重试或提高该源的超时；重复超时说明这条路慢或被挡」。
  同一请求在旧代码下按变异测试的形状是**不返回**的。
- **第三行是反面对照**：4.97 MB 的真文件 7.45 s 传完，30 s 预算下**不误判为卡死**，读数与摘要照常记录
  —— 预算按「一次请求」量，不是按「一次握手」量。
- 日志侧同一次运行里 `connector call deadline reached` **恰好 1 行**，字段为
  `{connector: 'probe', tool: 'stalled-body', host: 'httpbin.org', phase: 'body', budgetMs: 3000}`。

## 五 门禁（本机实跑）

| 环                                    | 读数                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `npx vitest run src/main/connectors`  | **91 passed / 1 skipped（92 文件）；1,025 passed / 55 skipped（1,080 例）**，exit 0 |
| 定向（本笔两文件）                    | **24 passed**，exit 0                                                               |
| 变异                                  | 旧形状下 **2 failed**（60 s 超时即「挂住」的实证）                                  |
| `npx eslint --no-cache`（本笔两文件） | **0 problem**（无输出，exit 0）                                                     |
| `npm run typecheck:node`              | **0 诊断**，exit 0                                                                  |
| `npm run typecheck:web`               | **0 诊断**，exit 0                                                                  |

## 六 边界（不许读成更强）

1. **没有窗口读数**：这是主进程里的出网边界，没有新增界面、没有新增通道 ⇒ 按纪律具名。
   装机版上要看到这行日志，得等下一次发版（当前装机为 2.27.0）。
2. **正文阶段的非超时失败仍不重试**：它现在带出网原因（不再是一句 `terminated`），但「半截正文要不要重试」
   是另一个决定（重试会重复读取已被服务端计入的请求），本片不动。
3. **预算仍是每工具一个默认值（30 s）**：`descriptor.run` 那条逃生通道里的计算时间不在预算内（它的
   `ctx.fetch*` 在）。要不要给个别源声明更大的预算，需要先有「哪个源真的需要」的读数 —— 今天没有。
4. **`httpbin.org` 是第三方**：它的滴流行为随时可能变；本片用它只证明「正文阶段会被截止」，不构成对该站的依赖。
