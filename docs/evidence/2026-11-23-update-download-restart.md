# 更新下载停滞：应用自己重下一次，并如实说「从头开始」

2026-11-23。上一单元（`docs/evidence/2026-11-22-update-download-stall.md`）让停滞在 60 秒具名判停，
但判停之后仍然是 `status.state = 'error'`：用户得自己发现错误、自己再点一次。本单元补的就是那一步 ——
在一次下载里给两个传输名额，并把「重下」与「续传」在界面上分开说。

## 一 缺口（读代码读出来的，不是推断）

| 事实 | 证据 |
| --- | --- |
| in-place 更新路径从不发 `reconnecting`，`attempt` 恒为 0 | `electron-updater-strategy.ts` 的 `download-progress` 处理器里写死 `attempt: 0`（旧注释还写着「electron-updater 自己会重试」，实际它不会） |
| 真正会重试/续传的是装机包下载那条路 | `src/main/net/resilient-download.ts`：`.part` 文件 + Range 续传 + 退避重试，重试前发 `reconnecting`（`attempt` 是已花掉的重试次数） |
| 重下只能从头开始，不能续传 | `node_modules/electron-updater/out/AppUpdater.js` 的 `executeDownload`：传输失败走 `removeFileIfAny()`，temp 文件被删；只有 differential（blockmap）那支会复用**旧版本**的包，不是这次的半成品 |

⇒ 界面上直接复用「resuming」会说谎。这是本单元唯一一处改共享词汇的理由。

## 二 修法

| 落点 | 内容 |
| --- | --- |
| `electron-updater-strategy.ts` | 新增 `downloadAttempts`（默认 2，可注入）：一次 `download()` 内按名额循环；停滞且还有名额 ⇒ 换新 token 重下 |
| 同上 | 停滞处理器改为「由本次尝试决定含义」：还有名额时只打一行 `warn`（`attempt`/`attempts`/`stalledMs`/已下字节/总字节），不写 error 状态；最后一次才 `setStatus(error)` + 诊断 `failed`（`reason:'stalled'` + `attempts` + `attemptsUsed`） |
| 同上 | 诊断相位：首次 `transfer`，重下 `transfer-restart`（相位时长与开始偏移都由既有仪器给出） |
| 同上 | 非停滞错误（`ECONNRESET` 一类）不重试；用户取消语义不变（状态回 `available`，不报停滞） |
| `src/shared/download-progress.ts` | `DownloadPhase` 增加 `restarting`；文案 `Connection lost, restarting from the beginning… (attempt N)` —— 与 `reconnecting`（真的续传）分开 |
| `DownloadProgressLine.tsx` | `restarting` 与 `reconnecting` 一样保持脉动，不把进度条冻在旧位置 |

## 三 读数

### 3.1 单测（`src/main/update/electron-updater-strategy.test.ts`）

| 用例 | 断言 |
| --- | --- |
| 停滞一次后重下成功 | 第二次 `downloadUpdate` 真的被调用；广播里有 `restarting`（`transferred: 0`、`attempt: 1`）；状态 `ready`；诊断里没有任何 `outcome: 'failed'`；warn 行带 `attempt:1 / attempts:2 / downloadedBytes:122000000 / totalBytes:296000000` |
| 名额用完才报错 | `downloadUpdate` 两次；状态 `error`；失败行 `reason:'stalled'`、`attempts:2`、`attemptsUsed:2` |
| 非停滞失败不重试 | `ECONNRESET` 一次即报错，`downloadUpdate` 只 1 次，广播里没有 `restarting` |
| 重下期间用户取消 | 状态回 `available`、`error` 为空、第二个 token 被取消 |

既有两条停滞用例（判停具名 / 慢速不误杀）改成 `downloadAttempts: 1`：它们守的是**最后一次尝试**的文案与字节数，断言本意未变。

### 3.2 真 socket（`electron-updater-stall-socket.test.ts`，真计时器 + 真 HTTP）

| 场景 | 读数 |
| --- | --- |
| 服务端发 1 MB 后永久静默 | 两次尝试各判停一次，状态 `error`，失败行 `downloadedBytes = 1048576`、`errorCategory: 'timeout'`，总耗时 ≥ 2 个停滞窗口 |
| 首试静默、次试给全量 | **两次真实 HTTP 请求**（`artifactRequests = 2`）；广播里 `restarting`（`attempt: 1`）；状态 `ready`；耗时 ≥ 1 个停滞窗口 |

第一例证明「名额用完仍具名报错」，第二例证明「重下真的发生、并且第二次能拿到完整字节」。

### 3.3 变异（改一处、跑一遍、还原）

| 变异 | 结果 |
| --- | --- |
| `DEFAULT_DOWNLOAD_ATTEMPTS` 改 1 | **4 例红**（重下成功 / 名额用完 / 取消 / 真 socket 重下） |
| 重下时的相位改回 `reconnecting` | **2 例红**（两条重下用例的相位断言） |

### 3.4 门禁（隔离工作树 `/tmp/psr-retry`，只含 `6e72311a`）

| 环 | 读数 |
| --- | --- |
| `npx eslint --no-cache .`（全仓，无缓存） | **0 errors / 101 warnings**（warning 全是 prettier 漂移，`--fix` 可修） |
| `npm run typecheck:node`（`NODE_OPTIONS=--max-old-space-size=8192`） | **EXIT 0，0 个 error** |
| `npm run typecheck:web` | **EXIT 0，0 个 error** |
| 定向（update / net / download-progress / 更新对话框 / 更新 store） | **24 files / 302 passed** |
| 全量 `npx vitest run --maxWorkers=4` | **1550 files**：1516 passed / 3 failed / 31 skipped；**19,323 例**：19,086 passed / 8 failed / 229 skipped |
| 那 8 例的归属 | 3 个文件全在 `src/main/references/**` 与 `src/main/projects/prisma-client.test.ts`，断言原句是 `Reference runtime DDL is missing Prisma columns: expected [ 'edition' ]` —— 共享 `node_modules` 的 Prisma client 是按**会话在制**的 `prisma/schema.prisma`（新增 `Reference.edition`）生成的，本提交的 schema 没有这一列。**在基础提交 `f3875d03` 上同样 8 例红**（独立工作树 `/tmp/psr-base`：3 files failed / 8 failed / 23 passed）⇒ 基线红，不是本提交引入 |

注：共享工作树里 `npm run typecheck:node` 会另外红两条 `provider-env.test.ts` 的 `TS6133` —— 同样是会话在制文件（未使用的 import），在本提交的隔离工作树里不存在。

## 四 边界（没有验到的，具名）

1. **没有打包版读数**：这条路径只有装机版走（`app-update.yml` 指向自建镜像），本机造不出一次真实的镜像停滞。
   真 socket 用例证明的是「真停住的流 + 真计时器 + 真策略类 + 两个名额」这条链，**不是**打包版对镜像的行为。
   下一次真机判据：装机版日志里出现 `update download stalled; restarting the transfer` 且随后同一次下载
   `outcome: 'completed'`；或出现一次 `failed` 且行内带 `attempts`/`attemptsUsed`。
2. **没有做 Range 续传**：electron-updater 拥有这次 HTTP 传输，接管它才能保留半成品（见 §一第三行）。
   本单元只做「有界重下」，代价是第二次从 0 开始；界面上写的就是这句实话。
3. **`ECONNRESET` 不自动重试**：只对停滞重下。真机日志里另有一次 `connection-reset` 失败，那一条要不要也重下
   是另一个取舍（重下同样从 0 开始），本轮没有决定，也没有测。
4. **Windows 无对等读数**：逻辑与平台无关，读数只在 macOS 上取到。
