# macOS 原地升级：从「没有演练」到一条能分辨失败的判据

- 日期：2026-11-22
- 结论（第 1 趟）：`macOS upgrade reading: passed from=2.33.0 to=2.33.1 relaunched="2.33.1"`（run `44983043496`）
- 结论（第 2 趟，另一对版本、一次通过）：`passed from=2.33.1 to=2.33.2 relaunched="2.33.2"`（run `44998687478`）
- 结论（第 3 趟，重复同一对）：`passed from=2.33.1 to=2.33.2 relaunched="2.33.2"`（run `45001891993`）
- **中间有一次红（`45001026264`），红的不是演练路径，是我的参数**：我把 `--next-version` 传成了 `v2.33.2`，
  而 feed 答的是 `2.33.2`（不带 v），于是断言说 `The feed did not offer v2.33.2` —— 同一行的 payload 里
  明明写着 `latest: 2.33.2`。修：参数归一化（去首尾空白与 v），不一致时把「参数」与「feed 答了什么」
  两侧原文同时打出来，并抽成纯函数 + 两条用例。第 3 趟**故意还传 `v2.33.2`**，一次通过 —— 归一化是在
  CI 上被证明的，不只是在单测里。
- 诚实计数：**4 次 dispatch，3 次绿**；那 1 次红是操作失误而非路径不稳，但它确实不是「连续 3 趟」。
- 演练脚本：`scripts/macos-upgrade-certification.mjs`（5 条单测在 `scripts/macos-upgrade-certification.test.ts`）
- 工作流：`.github/workflows/macos-upgrade-smoke.yml`（**dispatch only，未接进 `release.yml`**）

## 为什么要做

v2.33.1 发布说明里「原地更新不可用 → 用 v2.33.1」这句话，当时只有包级证据支撑：包被公证并 staple、更新源 feed 的 `sha512` 与磁盘字节一致。**没有一条证据说明一个装着 2.33.0 的应用，点更新之后真的会变成 2.33.1。** Windows 车道有 `windows-upgrade-smoke`，macOS 没有等价物，这个缺口写在发布正文里当作已知未做项。

## 演练怎么判

不采信「进程退出了」「日志里有字样」，四步都落在应用自己的证词与磁盘上：

| 步骤 | 判据 | 加证据前会出现的误判 |
| --- | --- | --- |
| 起点 | `update.getAppInfo()` 自报版本 == `previous_tag` | 拿一份根本不是上一版的包去演练 |
| 检查 | `check()` 必须 `available` 且 `latest == next_version` | 报 `up-to-date` 也能「通过」—— 那什么都没证明 |
| 下载 | `download()` 必须到 `ready` | 只发起下载就宣布成功 |
| 换包 | **同一路径的 bundle** 被 `plutil -extract CFBundleShortVersionString` 读出 `next_version` | 「应用退出了」被读成「换好了」 |
| 重启 | 清掉 Squirrel 自己拉起的副本后全新启动，自报版本 == `next_version` | 第二份副本交棒退出，被读成「启动即崩」或「启动成功」 |
| Gatekeeper | `spctl -a -vv --type exec` 给 `accepted`；`codesign --verify --deep --strict` 通过 | 只看签名不看是否被接受 |

## 一路上被这条判据改掉的东西

**它们几乎都不是产品的问题，是我自己的读数在说假话。**

1. **`macos-14` 已退役。** 两趟 dispatch 都是 `completed/cancelled`、`steps=0`、没有 runner，看起来像「有东西在取消我的运行」。真正的原因只写在 run 的 annotation 里：`The configuration 'macos-14-arm64-us-default' is not supported`。`build.yml` 早在 2026-10-31 就换到 `macos-15` 并写了原因。
2. **`| tee` 让 step 悬一小时。** 被拉起的应用继承了 stdout，node 退出后管道另一端仍有进程，`tee` 等不到 EOF。改成 `node … > log 2>&1` 再 `cat` —— 代价是所有行共享 `cat` 那一刻的时间戳，**行内时间戳不再能用来算耗时**，我因此把「2 分钟超时」误读成「10 毫秒超时」。
3. **私有 `HOME` 把网络栈弄哑了。** 为了不跟本机已装的副本抢单实例锁，演练给应用一个私有 `HOME`。结果是：应用自己的检查更新停在 `phase=query-provider`、`elapsedMs=0`，两分钟一行没有；换成真实 `HOME` 后同一脚本 `check()` 秒回 `available`、`download()` 到 `ready`。同一份包、同一套代码，差别只有 `HOME`。CI 上没有第二个实例要避让，所以工作流默认 `--keep-home`。
4. **`apply()` 之后立刻 `close()` 会把换包抢掉。** 应用日志显示 `application-shutdown trigger=update … result=completed`，磁盘四分钟后仍是 `2.33.0`。改成等应用**自己**退出（最多 60s）再兜底关闭，换包立刻落地。
5. **`spctl` 把裁定写在 stderr。** 只读 stdout 时 `Gatekeeper:` 后面是空字符串 —— 空字符串分不清「accepted」和「没有任何输出」。
6. **Squirrel 换完包会自己把应用拉起来。** 我再去启动就成了第二实例、交棒退出，Playwright 只看到 `Target page … has been closed`，与崩溃同形。而且我第一次「清场」用的 `otherInstance()` 语义是「本机**别的**副本」，它有意把本 bundle 过滤掉 —— 查错了对象。现在按 bundle 路径清场并等到进程归零。

## 顺带修掉的一个真产品缺陷

`electron-updater` 自己没有超时。一个不回答的 provider 会让 `check()` 永远 pending，窗口永远 `checking`，用户既看不到失败也点不了重试 —— 这正是第 3 条里那种「看起来像挂起」的形态，只不过对用户是真的。

`electron-updater-strategy.ts` 现在把 provider 查询与 20 秒预算赛跑，超时即 `status = error` 并写明 `The update check did not answer within 20000 ms`；超时不走 GitHub 兜底（同一个不回答的请求只会再花一个预算）。两条用例钉住：永不返回 → 预算内具名失败且只查一次；预算内慢返回 → 仍 `available`。

## 第 2 趟：换一对版本，脚本没有再改一行就过了

`44998687478`（`previous_tag=v2.33.1` / `next_version=2.33.2`）是发布 v2.33.2 之后立刻跑的，读数与第 1 趟同形：

```
status before check: {"state":"checking","current":"2.33.1"}
check()    -> available, latest 2.33.2
download() -> ready
apply()    -> applying
app quit on its own: true
on disk    -> 2.33.2 (was 2.33.1, check saw 2.33.1)
relaunched -> {"version":"2.33.2"}
Gatekeeper -> accepted      codesign --verify --deep --strict: ok
macOS upgrade reading: passed from=2.33.1 to=2.33.2 relaunched="2.33.2"
```

意义不在「又绿一次」，而在**一次通过**：第 1 趟花了五轮才把六处读数谎话改干净，第 2 趟换了一对版本、脚本
一行没动就过了 —— 说明这些修正修的是**判据**，不是把某个特定版本的数据凑对。

## 第 4 趟：Intel 上的一半，第一次真的有人跑

`45002891087`（`arch=x64`、`previous_tag=v2.33.1` / `next_version=v2.33.2`）在 **`macos-15-intel`**（X64 主机）上：

```
architecture: bundle x86_64 on host x86_64
check()     -> available, latest 2.33.2
download()  -> ready
apply()     -> applying
app quit on its own: true
on disk now: 2.33.2 (was 2.33.1, check saw 2.33.1)
relaunched  -> {"version":"2.33.2"}
Gatekeeper  -> accepted
macOS upgrade reading: passed from=2.33.1 to=2.33.2 relaunched="2.33.2"
```

**这一趟推翻了我自己写下的一条**：我曾在路线图里把 x64 记成「没有 runner 可用」。实际上 `macos-13` 于
2025-12-04 退役后，GitHub 从 2025-09 起提供 `macos-15-intel`（X64，可用至约 2027）—— x64 不是做不到，是
没人做。

**为什么要断言宿主与包的架构一致**：x86_64 包在 arm64 runner 上经 Rosetta 也能启动、也能换成包，但那不是
Intel 用户经历的升级（Squirrel 的搬包与重启在转译下走的是另一条路）。脚本用 `lipo -archs` 读包、`uname -m`
读宿主，不一致具名拒绝；正常路径把这一对读数打出来，让「在哪台机器上证明的」留在证据里。

## 第 5、6 趟：把「用户数据还在」变成判据，以及一条判据如何在 CI 上假装通过

换包换对了、应用起来了，用户的数据可能已经不在了 —— 而此前六条判据没有一条会看这件事。

**第 5 趟（`45029022118`）第一次加数据标记，读数就暴露了这条判据是废的**：

```
macOS upgrade reading: passed from=2.33.1 to=2.33.2 relaunched="2.33.2" data=skipped (real HOME)
```

`--keep-home` 让 `userData` 指向真实用户的 `~/Library/Application Support`，我为不写用户目录就跳过了 ——
一条**永远读 `skipped`** 的判据，旁边还挂着 `passed`，比没有更坏。

改法是两个标记、两个问题：

| 标记 | 落在哪 | 什么时候种 |
| --- | --- | --- |
| storage root | drill 自己的目录（`$RUNNER_TEMP/upgrade/storage`） | **无条件**。它代表每次启动都要打开的那个库 |
| userData | 打包应用自己的状态目录 | 要 `--seed-user-data` 显式要：runner 上那是可丢弃的 `/Users/runner`，工作站上那是人的目录 |

**第 5 趟的第二遍（`45029743779`）**仍是 `userData:skipped` —— 原因不是逻辑而是死代码：

```yaml
extra_args:
  default: '--keep-home'                                          # input 自己声明了 default
EXTRA_ARGS: ${{ inputs.extra_args || '--keep-home --seed-user-data' }}   # 这半边永不执行
```

声明了 `default` 的 input **永远不是空**，`||` 回落是死代码（`ffe23a6d` 把默认值挪到 input 上）。这和先前
踩过的「`if:` 里看不到 `$GITHUB_ENV`」是同一类：**看着有兜底，实际兜底不执行**。

**第 6 趟（`45030290794`）** 正向读数：

```
[mac-upgrade] user-data marker: seeded at …/upgrade/home/Library/Application Support/PureScience/drill-marker.json
[mac-upgrade] storage-root marker: seeded at …/upgrade/storage/drill-marker.json
[mac-upgrade] user data after the swap: userData:kept storage:kept
```

**然后是反向对照（`45031036722`，`sabotage=both`）—— 这一趟必须红**：

```
[mac-upgrade] sabotage (both): removed userData (…/drill-marker.json)
[mac-upgrade] user data after the swap: userData:lost storage:lost
macOS upgrade reading: failed from=2.33.1 to=2.33.2 relaunched="2.33.2" data=userData:lost storage:lost
```

它是红的，而且红在数据那一栏而不是版本那一栏 —— 所以 `kept` 现在是一个**能分辨 `lost`** 的读数，不是一个
恰好总为真的字符串。

## 反向对照的隔离实验：只删一个标记，读数只红在那个标记上

`45031036722` 一次删了两个标记（`sabotage=both`），它证明「会红」，但**证明不了两个标记各自都在被读** ——
万一只删 userData 时读数仍然是绿的，那就说明 `storage:lost` 在替 userData 那一格代言。补一趟隔离实验：

```
[mac-upgrade] sabotage (user-data): removed userData (…/drill-marker.json)
[mac-upgrade] user data after the swap: userData:lost storage:kept
macOS upgrade reading: failed from=2.33.1 to=2.33.2 relaunched="2.33.2" data=userData:lost storage:kept
```

（`45031488471`，`-f sabotage=user-data`，arm64。）只删 userData ⇒ `userData:lost` 而 storage 仍是 `kept`；
同一趟里 `on disk now: 2.33.2`、`relaunched 2.33.2`、`Gatekeeper: accepted` 全部照旧通过 ⇒ 红只可能来自
数据那一格。三条合起来（正常 `45030290794` / 双删 `45031036722` / 单删 `45031488471`）才说明两个标记各读各的。

**这条判据仍然只是代理指标**：它证明目录与文件内容在换包之后还在，不证明那个 SQLite 库能打开、能读、
schema 与旧版本兼容 —— 后半句见下面「没有证明的事」第三条。

## 第 7 趟：tag 通道第一次自己跑，红在时序而不是换包

`45037339833`（推 `v2.33.3` 带起来的，双架构、无人工参数）在 `Drilling v2.33.2 -> 2.33.3` 之后立刻红：

```
[mac-upgrade] Error: The feed already says we are current (2.33.2); the drill needs an older app than 2.33.3
```

归因：**打 tag 的同一秒 Release 才开始构建**，GitHub feed 的最新版本仍然是 2.33.2。演练去问「有没有
2.33.3」，答案当然是「你已经是最新的」—— 这条报文本身是对的，错的是我让演练在 release 还没发布完时提问。

修法（把等待变成演练的职责，而不是让人记住先等发布）：

- `up-to-date` 且 feed 版本**落后**目标 → 每 60 秒重问一次，预算 45 分钟（`PURESCIENCE_DRILL_FEED_WAIT_MS`），
  每次轮询都打一行「镜像还说 X，在等 Y，已等 N 秒」—— 卡住要读起来像卡住；
- feed 版本比目标**更新**（重跑旧 tag）→ **立刻**失败，因为等待改不了方向；
- 方向判断抽成 `feedWaitDecision`，6 条用例钉住 `wait` / `ahead` / `proceed` 三种答案。

同一趟还暴露了第二个问题：feed 断言原来把两件事合成一件判 ——「这个 build 会去问镜像」和「镜像已经供这一版」。
tag 时前者成立、后者必然不成立（镜像靠 cron 同步）。现在拆开：前者在 tag 时判，后者由同步之后单独一次
`-f require_feed_version=true` 判。

## 第 8 趟：镜像 feed 真的供了这一版（`45049362271`）

`v2.33.3` 发布完、镜像 `v2.33.3/` 落下 `.complete` 之后跑的一次，带 `require_feed_version=true`：

```
[mac-upgrade] Drilling v2.33.2 -> 2.33.3
[mac-upgrade] check() -> {"state":"available","latest":"2.33.3", ...}
[mac-upgrade] on disk now: 2.33.3 (was 2.33.2, check saw 2.33.2)
[mac-upgrade] Gatekeeper: .../previous/PureScience.app: accepted
[mac-upgrade] user data after the swap: userData:kept storage:kept
[mac-upgrade] update feed: offers 2.33.3
macOS upgrade reading: passed from=2.33.2 to=2.33.3 relaunched="2.33.3"   data=userData:kept storage:kept feed=offers 2.33.3
```

`feed=offers 2.33.3` 是这一格的关键读数：它在换包之后，从**已安装的 bundle** 里读 `app-update.yml`，
拿到 `provider: generic` 与 `https://purescience.work/download/feed/`，再去镜像问它供哪一版。也就是说
「这个包会不会去问镜像」和「镜像供的是不是这一版」两件事同时为真 —— 前者由仓库的 `electron-builder.yml`
决定，后者由服务器的 cron 决定，**两者都能单独坏掉**，所以分开读、分开判。

顺带核过 feed 的五个资产：大小**以 feed 文件自己声明的 `size` 为准**（我第一次比对了记忆里的数字，报了一次
假 MISMATCH —— 判据要从源文件读）：

| 资产 | 声明 | HTTP `Content-Length` |
| --- | --- | --- |
| mac-arm64.zip | 295882103 | 295882103 |
| mac-x64.zip | 312383616 | 312383616 |
| win-x64-setup.exe | 244845588 | 244845588 |
| AppImage | 318374697 | 318374697 |
| deb | 242418184 | 242418184 |

~~**这一趟没有证明的事**：这次换包的**下载**仍走 GitHub~~ → **已由第 9 趟的 `45110776730` 补上**：被升级的
2.33.3 那个包的 `app-update.yml` 已经指着镜像，`download()` 回来 `downloadedBytes: 295904957`，与镜像 feed 里
`mac-arm64.zip` 自己声明的 `size` **逐字节相同** ⇒ 这是第一次**从镜像下载并完成换包**的读数。

## 第 9 趟：等待本身放错了地方 —— 45 分钟预算 vs tag→资产 80 分钟 + 一趟镜像同步

推 `v2.33.4` 带起来的 `45090413547` 又是一次红，而这一次红把「预算取多少」这个问题变成了「预算该住在
哪个进程里」：

| 时刻（UTC） | 事件 | 来源 |
| --- | --- | --- |
| `00:43` | tag 推送，演练与 Release 同时开始 | run `45090413547` 的 `createdAt` |
| `00:43:15` / `00:43:25` | 两个架构的 job 起来 | 同上 |
| `01:30:59` / `01:32:27` | 两个架构先后放弃（`the feed still says 2.33.3 … 2709s`） | 同上 |
| `02:03` | Release 的 `publish` 落资产 | run `45090413522` |
| `03:11:13` | 镜像 `latest-mac.yml` / `latest.yml` 的 `last-modified` | `curl -sI https://purescience.work/download/feed/latest-mac.yml` |

也就是说：**演练等待的目标（镜像供出这一版）出现在打 tag 之后约 150 分钟**，而它手里的预算是 45 分钟。
任何短于这 150 分钟的预算都必然在一条健康的发版上变红；而把 45 调大只是让两个 macOS runner 干等
（macOS runner 的计费是 ubuntu 的十倍）。

**修法：把等待搬到一个便宜且只需要干等的进程里。** `macos-upgrade-smoke.yml` 拆成两个作业：

- `readiness`（`ubuntu-latest`，`timeout-minutes: 280`）：先做原来那步版本解析（所以「有没有东西可测」仍然
  由仓库自己的 release 列表回答），再轮询镜像的 `latest-mac.yml`，直到它同时满足 **`version: <下一版>`** 与
  **两个 mac zip 都在**（tag 通道一次等待服务两个架构）。预算 240 分钟；每 60 秒打一行「镜像还说 X，已等 N 秒」。
- `drill`（原样在 macOS 上跑）：`needs: readiness`，版本从 `needs.readiness.outputs` 取 —— 不再自己解析一次，
  否则闸门等的版本与演练装的版本可以是两个数。

两条方向判据与演练内那条同义：镜像比目标**更新** ⇒ 立刻具名失败（等待改不了方向）；预算用尽 ⇒ 具名
`the mirror did not offer <X> with both mac zips within 240 minutes (last reading: <Y>)`。

**`require_feed_version` 的语义随之变清楚**：它现在表示「让等待成立」。tag 通道恒等（由 `github.event_name`
决定，**不用布尔输入的假值兜底** —— `inputs.require_feed_version` 是布尔，`false || 'true'` 会算成 `'true'`，
照那样写会让 dispatch 的「关掉」失效），dispatch 默认不等（它通常演练一对已发布的版本，`require_feed_version=true`
时才等）。演练自己那句 `PURESCIENCE_DRILL_FEED_WAIT_MS`（45 分钟）一个字节没改 —— 闸门只决定**什么时候开始**，
「feed 供的是不是这一版」仍由已安装包的 updater 回答。

**本机读数（闸门的五种 feed 形状）**：把工作流里那段 `run:` 原样抽出来，对着本地 feed 文件跑（`BUDGET_MINUTES=0`
以便一次到判定）：

| feed 形状 | 读数 | EXIT |
| --- | --- | --- |
| 供对（`version: 2.33.4` + 两个 zip） | `::notice::the mirror offers 2.33.4 with both mac zips (after 0s, 1 poll(s))` | 0 |
| 落后（`2.33.3`） | `… did not offer 2.33.4 with both mac zips within 0 minutes (last reading: 2.33.3)` | 1 |
| 超前（`2.33.5`） | `the mirror already offers 2.33.5, which is newer than the target 2.33.4 — waiting cannot change that` | 1 |
| 版本对但缺 x64 zip | `the feed already says 2.33.4 but does not list: 2.33.4-mac-x64.zip` → 期满具名退出 | 1 |
| 取不到（无文件） | `the mirror answered nothing for file://…` → 期满具名退出 `(last reading: (nothing))` | 1 |
| `WAIT_FOR_FEED=false`（任一形状） | `::notice::not waiting for the mirror …` | 0 |

工作流契约测试 `scripts/ci/macos-upgrade-smoke-workflow.test.ts` **6 例**钉住：闸门在 ubuntu 上、`drill` `needs`
它、演练的版本来自 `needs.readiness.outputs`、tag 通道的等待由事件决定（并明确禁掉 `inputs.require_feed_version ||
'true'` 那种写法）、预算 ≥ 240 且作业超时 ≥ 预算 + 15 分钟、两种具名失败与「两个 zip」要求都在。四处变异各自
只红 1 例（去掉 `needs` / 预算改 45 / 换成布尔假值写法 / 演练改回自己解析版本），还原后 6 例全绿。

**同一轮的真机读数（`45110776730`，`v2.33.3 → 2.33.4`，`require_feed_version=true`）**：镜像已供这一版，
于是这条演练第一次**从镜像**下载并换包：

```
[mac-upgrade] check() -> {"state":"available","latest":"2.33.4",…,"totalBytes":295904957,"current":"2.33.3","applyKind":"restart"}
[mac-upgrade] download() -> {"state":"ready","latest":"2.33.4",…,"progress":100,"downloadedBytes":295904957}
[mac-upgrade] on disk now: 2.33.4 (was 2.33.3, check saw 2.33.3)
[mac-upgrade] relaunched reports {"name":"PureScience","version":"2.33.4",…}
[mac-upgrade] Gatekeeper: …/previous/PureScience.app: accepted
[mac-upgrade] user data after the swap: userData:kept storage:kept
macOS upgrade reading: passed from=2.33.3 to=2.33.4 relaunched="2.33.4" data=userData:kept storage:kept feed=offers 2.33.4
```

`downloadedBytes` 与镜像 feed 声明的 `size` 逐字节相同（295,904,957）⇒ 下载真的走的是镜像，不是 GitHub；
`feed=offers 2.33.4` 是从换包后的 bundle 里读 `app-update.yml` 再问镜像得来的。这一趟**只跑了 arm64**。

**这一趟没有证明的事**：`readiness` 闸门**没有被一次真 tag 推起来过** —— 它的首次真样本是下一次发版；
本机那五种形状只证明脚本的分支，不证明 GitHub 上 `needs` 与 outputs 的接线（那要真跑）。

## 这条判据**没有**证明的事

- ~~只在 arm64 上跑过~~ → **arm64 与 x64 都跑过**（`45002891087` 在 `macos-15-intel` 上，宿主与包架构由脚本断言）；但**只 dispatch**，还没有非手动触发的样本。
- **只有 dispatch 触发**，没有接进 `release.yml`。一条绿过一次的演练要不要成为发版硬门，是单独拍板的事；现在它只出证据。
- ~~没有覆盖「用户自己的数据」~~ → **已覆盖一半**：标记能证明「换包没有抹掉 userData 与 storage root」，但它是标记不是内容 —— 真会话、真文献库（SQLite 里的行、附件）在换包后是否仍可读、是否被新版本正确迁移，仍未验证。
- ~~**没有覆盖更新源故障**：feed 与包都来自 GitHub Releases，演练没有验证镜像/官网链路~~ → **镜像链路已覆盖**
  （`45110776730`：下载走镜像、字节数与 feed 声明一致）；**仍未覆盖**的是「镜像坏掉/半同步时应用怎么表现」。
- **「一次绿」不等于「不再偶发红」**。这个判断只有时间能给（同 `references-page-selection` 那条）。

## 复现

```
gh workflow run macos-upgrade-smoke.yml --ref main \
  -f previous_tag=v2.33.0 -f next_version=2.33.1
```

反向对照（预期红）：

```
gh workflow run macos-upgrade-smoke.yml --ref main \
  -f previous_tag=v2.33.1 -f next_version=2.33.2 -f sabotage=both
```

判据行只有两种：`macOS upgrade reading: passed … data=userData:kept storage:kept` 或 `failed …`；
`skipped` 出现在任一标记上都算没测到，不当成通过。失败时同时打印应用自己日志的尾巴与 ShipIt 的系统日志行；两者都没有时会明说「macOS 一行没写」，不留下无解释的空行。
