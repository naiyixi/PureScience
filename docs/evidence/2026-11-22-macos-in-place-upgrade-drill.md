# macOS 原地升级：从「没有演练」到一条能分辨失败的判据

- 日期：2026-11-22
- 结论：`macOS upgrade reading: passed from=2.33.0 to=2.33.1 relaunched="2.33.1"`（run `44983043496`）
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

## 这条判据**没有**证明的事

- **只在 arm64 上跑过**，x64 的 zip 走同一条流程但没演练。
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
