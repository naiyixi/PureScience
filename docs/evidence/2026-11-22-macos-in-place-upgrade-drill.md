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

## 这条判据**没有**证明的事

- ~~只在 arm64 上跑过~~ → **arm64 与 x64 都跑过**（`45002891087` 在 `macos-15-intel` 上，宿主与包架构由脚本断言）；但**只 dispatch**，还没有非手动触发的样本。
- **只有 dispatch 触发**，没有接进 `release.yml`。一条绿过一次的演练要不要成为发版硬门，是单独拍板的事；现在它只出证据。
- **没有覆盖「用户自己的数据」**：演练用的是临时目录里的干净副本，不涉及真实会话、真实文献库、真实配置在换包之后是否完好。
- **没有覆盖更新源故障**：feed 与包都来自 GitHub Releases，演练没有验证镜像/官网链路。
- **「一次绿」不等于「不再偶发红」**。这个判断只有时间能给（同 `references-page-selection` 那条）。

## 复现

```
gh workflow run macos-upgrade-smoke.yml --ref main \
  -f previous_tag=v2.33.0 -f next_version=2.33.1
```

判据行只有两种：`macOS upgrade reading: passed …` 或 `failed …`。失败时同时打印应用自己日志的尾巴与 ShipIt 的系统日志行；两者都没有时会明说「macOS 一行没写」，不留下无解释的空行。
