# 更新下载：连接被重置也重下一次（2026-11-23）

## 一 为什么要做这一条（真机日志现取）

装机版（`/Applications/PureScience.app` = **2.33.2**）自带的日志 `~/Library/Logs/PureScience/`，三份轮转文件逐行解析
（只取 `operation` 名含 `update-download` 的记录）：

| 文件 | started | completed | failed | cancelled |
| --- | --- | --- | --- | --- |
| `main.log` | 2 | 1 | 0 | 1 |
| `main.1.log` | 8 | 4 | **3** | 1 |
| `main.2.log` | 0 | 0 | 0 | 0 |

三次失败（2026-11-21，当时装的是 2.32.0）：

| UTC | `errorCategory` | `durationMs` | `phases` | 字节数 |
| --- | --- | --- | --- | --- |
| 09:00:51 | `network` | 2,283,340（38 分） | `transfer=1ms` | 无（该版不记） |
| 10:02:52 | **`connection-reset`** | 3,185,058（53 分） | `transfer=1ms` | 无 |
| 10:18:33 | `network` | 634,509（10 分） | `transfer=1ms` | 无 |

五次成功：49.9 s / 22.1 s / 28.3 s / 27.9 s / 26.7 s。

两个结论：

1. **两条 `network` 是停滞**（38 分与 10 分、一个字节都没记），已由上一单元（`6e72311a`）的 60 s 停滞看门狗 + 重下覆盖；
2. **`connection-reset` 是看门狗看不见的一类**：失败以「错误」到达而不是「静默」，所以「60 秒没有新字节」判不到它。
   它在三例失败里占 **1/3** —— 有这个占比才值得花一次重下，这条单元就是它。

## 二 改了什么

`src/main/update/electron-updater-strategy.ts`：

| 位置 | 内容 |
| --- | --- |
| `RETRYABLE_TRANSFER_FAILURES`（新，导出） | 闭集 `connection-reset` / `network-changed` / `network-timeout`；`isRetryableTransferFailure()` 只判这三类 |
| `download()` 的 catch 分支 | 非停滞失败、且还有名额、且分类落在上表 ⇒ 打一行 `warn`（`attempt` / `attempts` / `errorCategory` / 已下字节 / 总字节 / 距上一个字节多久）后换新 token 重下；名额与停滞共用同一个 `downloadAttempts`（默认 2） |
| 同一 catch 的收尾 `operation.fail` | 名额被花过（`attempts > 1 && attempt > 1`）时补 `attempts` / `attemptsUsed` |

**判据复用而不是另造一份**：分类来自 `diagnosticErrorFields()`——日志行里那个 `errorCategory` 就是它写的，
重试判据读的是同一个函数，所以「日志说 `connection-reset`」与「代码因此重下」不可能各说各话。

**刻意不重试的两类**（写在常量上方的注释里）：`dns` / `connection-refused`（0 ms 后的重启救不了一个不可达的 feed），
以及兜底类 `network`——分类器把 `ECONNREFUSED` / `ENETUNREACH` 也归进它，重试它等于把配置类失败当 socket 死亡重试。
`certificate`、`request`、`system`、校验和一类同样不动：再下一次只会得到同样的字节。

## 三 读数（本机实跑）

| 环 | 读数 |
| --- | --- |
| `vitest src/main/update/electron-updater-strategy.test.ts` | **54 passed**（新增 2 例，改写 1 例） |
| `vitest src/main/update src/main/net` | **20 files / 264 passed** |
| `eslint --no-cache` 两个改动文件 | **0 error**（1 warning 是 HEAD 上早就有的 prettier 折行，位于 1698 行，本轮未碰） |
| 变异 ①：`RETRYABLE_TRANSFER_FAILURES` 置空 | **2 例红**（两条新用例：重下成功那条与名额用完那条），还原后 54 全绿 |
| 变异 ②：收尾行去掉 `attempts` / `attemptsUsed` | **1 例红**（名额那条），还原后全绿 |

改写的那一例：原来的 `does not restart a transfer that failed for a reason other than a stall` 用的错误串是
`new Error('read ECONNRESET')`——**没有 `net::` 前缀、也没有 `code`**，分类器给的是 `error`，所以它其实**没在测**
「连接重置不重下」，而是碰巧因为分类不出来才通过。改成真正的字节级失败（`sha512 checksum mismatch`），并改名
`does not restart a transfer whose failure a second attempt cannot fix`，断言本意（失败原因原样上屏、只下一次）不变。

## 四 边界（具名的「没验到」）

1. **没有打包版读数**：这条路径只有装机版走。真机判据——下一次更新时日志出现
   `update download failed mid-transfer; restarting the transfer` 且带 `errorCategory: "connection-reset"`，
   随后同一次下载 `outcome: 'completed'`；或两次都失败时失败行带 `attempts: 2` / `attemptsUsed: 2`。
2. **重下仍然从 0 开始**（electron-updater 失败即删 temp，见上一单元 §一）；界面照旧写「从头开始」。
3. **`ECONNRESET`（Node 原生 code）落在兜底类 `network` 上，不重试**——这是有意的：它与 `ECONNREFUSED` /
   `ENETUNREACH` 同类，重试等于把配置失败当瞬时故障。将来若要重试，应先让分类器把它们分开（改共享分类器，
   影响面远超本单元）。
4. **Windows 无对等读数**（逻辑与平台无关，读数只在 macOS 取到）。
