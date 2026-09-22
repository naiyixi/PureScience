# `windows-upgrade-smoke` 为什么一直是红的：根因调查（2026-09-22）

结论先行：**失败的不是安装包，也不是 CDN 镜像，而是"由 electron-updater 驱动、在托管 Windows runner 上落盘并重启到新版本"这一段**。它至少从 v1.65.0 起每次发布都以同一签名失败；同一批安装包的**直接安装/静默升级演练是成功的**。

## 一、先纠正两处容易被误读的表象

**表象 1：workflow run 是绿的，所以没事？** 不是。该 job 带 `continue-on-error: true`（`release.yml:85`），所以 job 失败不会让 run 变红；job 自身的 `conclusion` 是 `failure`。

**表象 2：日志里每个步骤都显示 success？** 那也是 `continue-on-error: true` 造成的：出错的步骤会把它自己的 `conclusion` 变成 success，而 `outcome` 保留原始的 failure。于是 job 里最后那步"Report Windows update-drill outcome"（`run: exit 1`，条件就是"有 drill 步骤的 outcome 不是 success"）**按设计把被吞掉的失败再放大成 job 级失败**。它是放大器，不是故障点。

v1.68.0（run `35639134811`，job `106472619633`）的逐步结论：

```
Checkout / Setup Node / Install deps / Download current / Download previous  success
Certify Windows electron-updater differential update                          success  (outcome=failure)
Drill Windows silent upgrade, process lock, rollback, and restart              success  (outcome=success)
Record / Upload Windows update-drill evidence                                 success
Report Windows update-drill outcome                                           failure  ← 放大器
```

## 二、证据工件（v1.68.0，未过期，已下载核对）

`windows-update-certification` 工件（1,153 B）内容：

```
certification-windows-update.json
  currentTag v1.68.0 | previousTag v1.67.1 | status failed
  checks: electronUpdater/incrementalDownload/feedCompatibility/silentInstall/
          processLock/rollback/restart 全部 "failed"
  reason: "updater=failure,installer=success"

windows-installer-certification.log
  Smoke testing previous installer: zerolink-purescience-1.67.1-win-x64-setup.exe
  Packaged Windows MCP local RPC smoke completed successfully.
  Windows installer smoke completed successfully.        ← 直接安装/静默升级这一路是过的

windows-updater-certification.log
  Smoke testing previous installer: zerolink-purescience-1.67.1-win-x64-setup.exe
  Error: Timed out waiting for installed version 1.68.0.
      at waitFor (scripts/windows-installer-smoke.mjs:283:9)
      at async main (scripts/windows-updater-certification.mjs:392:5)
```

历史同名签名（同一 job、同一句报错，说明不是某版引入）：

| 版本 | 报错 | reason |
|---|---|---|
| v1.68.0 | `Timed out waiting for installed version 1.68.0.` | `updater=failure,installer=success` |
| v1.67.1 | `Timed out waiting for installed version 1.67.1.` | `updater=failure,installer=success` |
| v1.65.0 | `Timed out waiting for installed version 1.65.0.` | `updater=failure,installer=success` |

## 三、为什么可以排除"未部署的 CDN 镜像"

自证在脚本里，不靠推测：`scripts/windows-updater-certification.mjs` 在演练前**改写已安装包的 `resources/app-update.yml`**，把它指向本地资产服务器（`buildLocalUpdaterConfig(..., assetServer.url)`），并由该服务器自己提供 `latest.yml` 与差分安装包（`feedRequests` 计数就在数它）。演练断言的正是"feed 被请求过、下载到的是差分包而不是整包"（`windows-updater-certification.mjs:254-267`）——这些断言**都过了**，失败发生在更后面的"等已安装版本变成新版本"。也就是说：这条链路读的是本地 feed，`statics.zerolink.com` 有没有部署与它无关。

同理也排除"我们刚修的 feed 回退"：回退改的是应用真实更新检查的 feed 选择，而这里 `app-update.yml` 已被改写为本地地址、检查也由演练脚本经 `window.api.update.check()` 直接驱动。

## 四、仍然未知的部分（具名）

现在的失败之所以只有一句超时，是因为**演练没有留下能定位的证据**：

1. `runElectronUpdater` 从"开始"到超时之间**一行输出都没有**，看不到 `check()`/`download()`/`apply()` 各自返回了什么。
2. 落盘失败的现场信息未被采集：NSIS 安装器进程的退出码、它的 `/LOG=` 输出、以及"electron-updater 到底有没有真的把安装器拉起来"。
3. `certification-windows-update.json` 在失败时把 8 项检查**一律写成 `failed`**（非逐项结论），丢掉了"哪一项先坏"的信息。

候选机制（均未证实，不得当成结论）：托管 runner 无可交互桌面会话导致更新器重启/接管失败；或安装器需要提权而在非提权进程下静默失败；或 NSIS 自更新分支提前退出。这两类都无法通过本机（macOS）复现——CI 是唯一的观测面。

## 五、下一步（具体、可执行）

在 `scripts/windows-updater-certification.mjs` / `windows-installer-smoke.mjs`（都在 `scripts/`，**不属于受保护的工作流**）里补上现场采集，让下一次发布的 Windows run 自己把原因说出来：

- 记录 electron-updater 三步各自的返回（check 的 state/latest、download 的 state、apply 的调用时刻）；
- 记录 NSIS 安装器进程的启动事实与退出码，并把 `/LOG=$env:TEMP\nslog.txt`（或等价开关）的输出附到失败信息里；
- 失败时把"已安装版本、期望版本、更新器缓存目录中 installer.exe 的大小/时间戳、app-update.yml 的实际内容"一并写进证据 JSON；
- 把证据 JSON 的 `checks` 改成**逐项记实**（该项测了没有、结论是什么、没测就写 not-run），不再一律 `failed`。

**验收只能在下一次发布的 Windows run 上**：改完的这批代码本身无法在本机验证，因此本文件**不声称已修复**，只声称根因范围已收敛到这个环节。

## 六、对用户的影响

- **不影响安装包质量**：直接安装 / 静默升级 / 进程锁 / 回滚 / 重启这几项由 `windows-installer-smoke.mjs` 覆盖，v1.68.0 上是 **success**（见上文日志）。
- **不影响发版**：该 job 在 `publish` 之后运行且 `continue-on-error: true`，不阻断四平台构建、公证与发布；Windows 包本身有意暂不签名（未配证书）。
- **影响的是"Windows 差分自更新在 CI 里被证实"这件事**：即 CI 目前无法证明 `electron-updater` 差分路径在托管 runner 上能落盘成功。这条要修，但修法与验收都在 CI 侧。
