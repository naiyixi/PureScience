# Windows 车道闸门的第一份读数（2026-11-24）

发版前置闸门要的是「最近三趟真的打印过读数的 Nightly，windows 作业都报 passed」。这份记录是**第一份**，
以及它前后那串「一份读数都没有」的成因。

## 一、读数本身

| 项 | 值 |
| --- | --- |
| run | `45207617763`（`Nightly`，`push`，head `6491120d`） |
| 作业 | `build / Build windows-x64`，id `137829414000`，`completed / success` |
| 日志逐字 | `2026-11-23T17:23:25.8058784Z electron P0 reading: passed` |
| 同一作业里的 P0 | `125 passed (59.9m)` |
| 同一 run 的 Verify | `build / Verify (lint + typecheck + test + package)` `completed / success` |
| 仓里自己的仪器 | `node scripts/windows-gate-streak.mjs --limit 10` ⇒ `windows gate streak: 1/3`，`credited: 45207617763` |

**读日志时的一处坑**：同一段日志里先出现的是脚本体自己那行 `echo "electron P0 reading: $electron_p0"`，
再上面还有 `electron_p0=not-applicable`（赋初值那一段）。那是 GitHub 把整个脚本打进 `##[group]Run` 的形状，
照第一处匹配读会把 `$electron_p0` 或 `not-applicable` 当答案。真读数只有一处，带时间戳、值是一个状态。
仪器里 `readingOf()` 的注释写的正是这条，取的是「最后一个值是 `passed`/`failed` 的匹配」。

## 二、此前七趟为什么一份读数都没有

不是 P0 又红了，而是 **windows 作业根本没起来**：那七趟的 `Verify` 要么红在 `Typecheck`（`a9747ecd` /
`1c657141` / `45185889448` 那几趟），要么被后一笔 push 取消。`6491120d`（把 RO-Crate profile 那四条文案补进
七份译本）落地后 `Verify` 转 success ⇒ 同一趟 run 的 windows 作业就跑起来了。这一环不需要新代码。

## 三、同一 run 里 `Build macos-x64` 的红：基础设施，不是产品缺陷

`137829413886` 判 `failure`，但同一份 API 读数是：`startedAt = null`、`completedAt = null`，日志下载返回
`BlobNotFound`（HTTP 404），步骤表停在 `Build & package` `in_progress`、其后每一步 `pending`。
同 run 的 windows 与 linux 两个作业都 success。形状是「runner 没有把日志落下来」，不是构建失败。

**它不影响闸门**：判据单位是 windows 作业自己那行读数，不是整趟 run 的 conclusion ——
一趟 run 因为别的平台偶发红而失败，不是 Windows 的证据（脚本头注释，2026-11-22 拍板）。

## 四、第二份读数怎么来的（本轮起的派发）

`gh workflow run nightly.yml --ref main` ⇒ run `45228614662` @ `6491120d`，`event = workflow_dispatch`。
`nightly.yml` 的并发组按事件分（`nightly-${{ github.event_name }}`，`cancel-in-progress: true`）⇒
派发那一趟与会话每十几分钟一笔的 push 车道**互不取消**；两趟派发之间才会互相取消，所以一次只起一趟。
**派发这条路不需要冻结推送**。

## 五、发版其余前置：只剩「四件套落定」这一步

`release.yml` 的 `release-preflight` 只有三步：tag 与 `package.json` 对齐、tag 提交在 main 上、windows 三连读数。
前两步用 2.33.5 的现状核过：`git show HEAD:package.json` 的 `version` = `2.33.5`，HEAD 在 main 上。
`git tag -l 'v2.33.5'` 与 `git ls-remote --tags origin` 里都没有 `v2.33.5`（上一轮按恢复规程删掉、无页可丢），
`gh release list` 的 Latest 仍是 v2.33.4。

`CHANGELOG.md` / `README.md` / `README.en.md` 三份此刻都在会话的工作树里改动中 ⇒ 本轮不打 tag，
否则打出来的横幅与它下一笔不一致，等于发布一个过期自陈。

## 六、边界

1. 三份读数目前都会落在**同一个提交**（`6491120d`）上，它们是三趟独立运行，量的是稳定性，不是三个版本。
2. 本文件不声称 mac/linux 那两条车道的情况，也不把 macos-x64 的 404 日志读成「构建坏了」。
3. 镜像工作流的仓库变量（`CDN_BASE_URL` / `S3_PREFIX`）仍未配置，与本闸门无关，别混读。
