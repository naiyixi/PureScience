# 更新下载「下不动」时不再无限等：60 秒判停，失败行自带「下了多少」

2026-11-22。本单元的缺陷不是被推断出来的，是从装机版自己的日志里数出来的；修复的读数是真 socket
（本机 127.0.0.1）上一条真的停住的响应，加上三处变异。

## 一 缺陷读数（装机版 2.32.0，字段日志现取）

`~/Library/Logs/PureScience/main.log`，2026-11-21 的三次 `update-download`：

| 时刻（UTC） | durationMs | phases | errorCategory | 有字节数吗 |
| --- | --- | --- | --- | --- |
| 09:00:51 | **2,283,340**（38 分 3 秒） | `transfer=1ms` | `network` | 没有 |
| 10:02:52 | **3,185,058**（53 分 5 秒） | `transfer=2ms` | `connection-reset` | 没有 |
| 10:18:33 | **634,509**（10 分 35 秒） | `transfer=1ms` | `network` | 没有 |

三点读出来的东西：

1. **`phases` 里的数字是相位开始时刻的偏移，不是相位时长**（`operation.ts:160` 记的是
   `readNow() - startedAt`）。所以 `transfer=1ms` 只是说「传输在操作开始 1 ms 后就开始了」，
   它一个字都没说传输跑了多久 —— 而 `durationMs` 说的是整段 38 分钟。同一行里这两个数字放在一起，
   读者很容易把 1 ms 读成「传输几乎没花时间」。
2. **整行没有一个字节数**：下载到了 1% 还是 99% 在日志里完全不可知。死连接与慢下载同形。
3. **失败要等 socket 自己报错**：electron-updater 自己的 HTTP 下载没有停滞预算（只有查询那一段在
   `a0bfa30a` 加了 20 s 预算），所以一条被掐断的流会让对话框一直停在 `downloading`，直到 TCP 层
   超时 —— 实测 38 分钟、53 分钟。

对照：**安装包下载那条路早就有这套**（`src/main/net/resilient-download.ts`：60 s 无字节判停滞 +
Range 续传 + 重试）。装了 2.32.0 的用户走的是原地更新（electron-updater），恰好是没有这套的那条。

## 二 修法

| 落点 | 内容 |
| --- | --- |
| `src/main/net/resilient-download.ts` | `DEFAULT_DOWNLOAD_STALL_MS = 60_000` 改成**导出**，内部改用它 —— 同一个「停滞」不许有两个字面量 |
| `electron-updater-strategy.ts` | 传输开始起看门狗；**每来一个进度事件就重置窗口**（量的是「距上一个字节」而不是总时长，慢但在动的 296 MB 不该被杀）；连续 `downloadStallMs`（默认取上面那个常量）无字节 ⇒ 判停滞 |
| 同上 | 停滞时**先写状态与诊断行、再 `token.cancel()`**：状态里是一句人话，诊断行带 `reason:'stalled'`、`stalledMs`、`downloadedBytes`、`totalBytes`；`code='ETIMEDOUT'` 让分类器给 `errorCategory:'timeout'`（不给 code 会落成 `object`，那是兜底而不是类别） |
| 同上 | 因其它原因失败的传输补上进度后缀与同样的两个字节数：`read ECONNRESET (stopped at 4.1 KB of 9.8 KB)` |
| 同上 | 用户主动取消先解除看门狗：取消不是停滞，状态照旧回 `available` |

## 三 读数

### 3.1 真 socket（一条真的停住的响应）

`src/main/update/electron-updater-stall-socket.test.ts`：本机 HTTP 服务声明 `content-length: 5 MB`、
发 1 MB 后**永久静音**（不 end、不再写），策略用 2 s 预算，走真 `fetch` + 真计时器。

```
status: {"state":"error","totalBytes":5242880,"downloadedBytes":1048576,"progress":20,
         "error":"The update download received no data for 2 s — it had reached 1.0 MB of 5.0 MB (20%).
                  Nothing was installed; retry when the connection is back."}
elapsed: 2037 ms
diagnostic: {"operation":"update-download","outcome":"failed","reason":"stalled","stalledMs":2000,
             "downloadedBytes":1048576,"totalBytes":5242880,"errorCategory":"timeout","durationMs":2016}
socket aborted: true
```

⇒ 判停用掉的是**真的** 2.0 秒（不是假时钟），字节数是 socket 上真的收到过的 1,048,576，连接是被
我们自己的 token 中止的。

### 3.2 单测（4 例）与变异

| 用例 | 断言 |
| --- | --- |
| 停住的传输被具名 | 状态句含「60 s」「41%」「282.3 MB」「Nothing was installed」；诊断行 `reason:stalled` + 两个字节数 + `errorCategory:timeout`；token 被取消 |
| 慢但在动的传输不误杀 | 59 s 静音 → 来一个字节 → 再 59 s 仍 `downloading`；再静音 60 s 才判停 |
| 用户取消 ≠ 停滞 | 取消后状态 `available`、无 `error`，且再等 120 s 也不会冒出停滞错误 |
| 其它失败的进度后缀 | `read ECONNRESET (stopped at 4.1 KB of 9.8 KB)` + 诊断行两个字节数 |

变异（改一处、跑一遍、再改回，均用 `/tmp` 备份还原）：

| 变异 | 结果 |
| --- | --- |
| 看门狗回调直接 return | **2 例红**（具名判停 / 慢速不误杀） |
| 进度事件不再重置窗口 | **1 例红**（慢速不误杀 —— 正是这条守的东西） |
| `withDownloadProgress` 原样返回 | **1 例红**（进度后缀） |

### 3.3 门禁

| 环 | 读数 |
| --- | --- |
| 隔离工作树 `/tmp/psr-stall`（只含 `8fd96b46`）`npm run typecheck:node` | **EXIT=0** |
| 同工作树 `npm run typecheck:web` | **EXIT=0** |
| 同工作树 `vitest run src/main/update src/main/net` | **20 files / 257 passed** |
| `npx eslint --no-cache`（4 个改动文件） | **0 error**（1 warning 是 HEAD 上就有的 prettier 漂移，用 `git show HEAD:` 复验同样告警） |
| `bash scripts/pre-push-checks.sh` | 全绿（敏感词零命中、4 个新增文件 lint 通过） |

## 四 边界（没验到的，具名）

1. **没有在打包版上复现那 38 分钟**：那条路径只有装机版走，本机没有能把 GitHub 掐住 38 分钟的手段。
   真 socket 用例证明的是「真的停住的流 + 真计时器 + 真类」这条链，**不是**「打包版对 GitHub 的行为」。
   下一次真机判据：装机版日志里出现 `"reason":"stalled"` 且带 `downloadedBytes`/`totalBytes`，或出现一次
   在 ≤60 s 内结束的 `update-download` 失败。
2. **没有加续传/自动重试**：electron-updater 自己拥有这次 HTTP 传输，本轮没去接管它。停滞后的下一次
   点击是否从零开始，本轮**没有测量**（不写「会续传」，也不写「不会」）。
3. **没有改 `operation.ts` 的相位语义**：`phases` 记的是开始偏移、`totalPhaseMs` 是最后一个偏移 ——
   这是全仓共用的诊断仪器，改动面远超本单元；本轮只在更新这条路上用显式字段补上「下了多少」，
   仪器本身的语义另立（未开工）。
4. **Windows 无对等读数**：判停逻辑与平台无关，但本次只在 macOS 上取到读数。
