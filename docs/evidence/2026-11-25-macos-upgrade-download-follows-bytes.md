# macOS 升级演练的下载：按「还在动」判，不按「等了多久」判

## 一 现象（现取读数）

v2.33.6 的 macOS Upgrade Smoke 在 `release: published` 车道起跑后，x64 半场（run `45521816671`，job `138895353020`）
在 `Drive the upgrade` 红，日志最后一行逐字：

```
[mac-upgrade] Error: Timed out after 900000 ms (900 s): update.download — after 900s the app reported
{"state":"downloading","latest":"2.33.6","totalBytes":312507252,"current":"2.33.5","applyKind":"restart",
 "progress":97,"downloadedBytes":303103964}
```

同一天 00:34Z 的 arm64 半场（run `45519152395`，job `138886340992`）是 **success**，18 分 28 秒跑完
（00:34:51 → 00:53:19）⇒ 升级机制本身可用，红的是**这一次传输的速率**：312,507,252 字节里已到 303,103,964（97 %），
平均约 **337 KB/s**，900 秒不够。

## 二 定因：一份墙钟预算分不出「慢」和「死」

旧实现只有 `DOWNLOAD_TIMEOUT_MS = 900_000` 一个常量，包在 `withTimeout(...)` 外面。它同时承担两件事：

- 判「传输死了」（该红）；
- 判「传输慢」（不该红，镜像速率不归本仓控制）。

两件事共用一个数字，结果就是：镜像慢到 337 KB/s 时，一个**还在前进**的传输被按「死了」处理。上一轮（`13fe02db` 前的
`v2.33.5` 那趟，run `45351488221`）也红在同一处，当时修的是**报错文案**（让超时消息带字节与进度，见
`scripts/macos-upgrade-certification.test.ts` 的「a timeout names the budget it used」一组）——文案对了，
判据还是墙钟，所以同一个红换了个说法又来一次。

## 三 改法

| 文件 | 内容 |
| --- | --- |
| `scripts/macos-upgrade-certification.mjs` | 新增纯函数 `downloadWatchStep(watch, sample, now, {stallMs, ceilingMs})`：只有**字节**算进度（`downloadedBytes` 单调递增才复位静默计时器），三个判决分别是 `wait` / `stalled`（`DOWNLOAD_STALL_MS = 180_000`，三分钟没有一个新字节）/ `ceiling`（`DOWNLOAD_TIMEOUT_MS` 由 900 s 抬到 **1_800_000**，30 分钟仍在动但没跑完，消息点名这是镜像速率而不是挂住）。新增 `awaitDownloadWithProgress({download, readStatus, ...})` 取代「`setInterval` 观察 + `withTimeout` 判死」那对组合：观察与判决在同一条循环里，进度才能真的延长等待；`readStatus` 抛错既不算进度也不提前结束，天花板仍然兜底。 |
| `.github/workflows/macos-upgrade-smoke.yml` | drill 作业 `timeout-minutes: 90 → 120`：内层等待上限从 15 分钟变成 30 分钟，外层数字必须继续压在上面（否则回来的又是 runner 的钟）。 |
| `scripts/macos-upgrade-certification.test.ts` | 9 条新用例：三档判决各自可分辨（还在动 / 静默 / 只有在动但跑不完）、重启后字节变少**不算**进度、读不到状态既不推进也不提前结束、以及 `awaitDownloadWithProgress` 的三条（正常返回 / 传输 120 ms 而静默预算只有 60 ms 仍必须成功——这正是本轮那个红的形状 / 状态不动时带字节拒绝）。常量关系另钉一条：`stall < ceiling`、`stall > 检查超时`、`ceiling > 900 s`。 |
| `scripts/ci/macos-upgrade-smoke-workflow.test.ts` | 一条：drill 作业的 `timeout-minutes` 必须大于脚本里**读出来**的 `DOWNLOAD_TIMEOUT_MS` 加 45 分钟（数字从脚本里取，不手抄）。 |

## 四 读数（本机隔离工作树 `/tmp/ps-dlwatch`，基于 `origin/main` `42bb03f6`）

| 判据 | 读数 |
| --- | --- |
| 两支相关套件 | `scripts/macos-upgrade-certification.test.ts` + `scripts/ci/macos-upgrade-smoke-workflow.test.ts` = **2 files / 48 passed** |
| 新用例确实跑了 | `--reporter=verbose` 逐条命中 9 条（`the download wait follows bytes, not the clock` ×5、`awaitDownloadWithProgress` ×3、`separates a stall from a ceiling` ×1） |
| 变异 ①：把 `advanced` 写死 `false`（退回「不看进度」） | **5 failed / 34 passed**——`advanced` 恒假 ⇒ 静默计时器从不复位 |
| 变异 ②：天花板乘 1000（等于永不触发） | **1 failed / 38 passed**——`names a ceiling as the mirror rate, not a hang` |
| 还原后 | **39 passed** |

## 五 边界（具名）

1. **还没有新的真机升级读数**：本轮的判据只到「本机两支套件绿 + 变异能红」。真正的读数要等下一次
   `release: published`（下一次发版）那趟 drill：判据是 `Upgrade macOS app in place (x64)` 在 >900 s 的传输下仍给出
   `macOS upgrade reading:`，或（若真挂住）红在 `made no progress for 180 s` 并点名字节。
2. **337 KB/s 是 runner 到镜像那一段的速率**，本仓不测也不控制它；天花板 30 分钟是按这一次的速率留 ~1.7 倍余量，
   不是承诺镜像一定够快。若下一次仍撞天花板，那条消息会明确写「这是镜像速率」而不是墙钟。
3. **arm64 半场没有新读数**：同一改法对两个架构都生效（矩阵同一份脚本），但 00:34Z 那趟成功的是旧判据。
4. 本轮没有改动 `scripts/macos-update-cache-drill.mjs`（另一条演练线，自带预算），也没有改工作流触发方式。
