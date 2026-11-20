# 更新演练的「应用自报缓存目录」：探针在打包态永远答不出来，改成判应用自己的交接记录

2026-11-21。被修的是 `scripts/macos-update-cache-drill.mjs`（`--real-update` 那条真机演练）里一处
**自陈与判据不符**：注释写着「应用自己的解析才是权威」，判据里却从来没有比过它。

## 一 缺口长什么样（先看代码，再看它为什么不可能有值）

`readUpdaterCacheDirFromApp` 在 Electron 主进程里 `require('electron-updater')`，读
`autoUpdater.getOrCreateDownloadHelper().cacheDir`。打包产物里那个模块不可解析，函数于是返回
`unavailable: Cannot find module 'electron-updater'`；两处调用点只把它 `console.log` 出来并写进 evidence
（`evidence.cacheDirResolvedByApp` / `scenarios[0].cacheDirResolvedByApp`），**没有任何一处读它的值做判断**。

于是演练真正判的仍是「按包内 `app-update.yml` 推断出来的那个目录被清空」，而「凭什么是这个目录」这条只有
安装后的 purge 记录覆盖了一半（`judgePurgeRecord` 要求记录里的 `cacheDir` 与演练看的目录逐字相同）——
**安装前**那半从未被核过。这不是产品缺陷，是仪器缺口：读不出值与值不在，在日志里长得一模一样
（`scripts/ci/update-drill-workflow.test.ts` 的注释其实早写明「`require('electron-updater')` 在打包产物里不可解析」，
缺口因此长期停在「已知、但仍按它的自陈读」）。

## 二 修法：判应用自己写的交接记录（三态，缺一不通过）

应用在**把包交给安装器之前**就会写下它解析到的目录 —— `src/main/update/cache-maintenance.ts` 的
`markInstallPending()`（`src/main/update/electron-updater-strategy.ts:592` 调用），info 级，`data` 里
同时有 `version` 与 `cacheDir`：

```
update cache: recorded the pending install   { version: <被安装的版本>, cacheDir: <应用解析到的目录> }
```

也就是说「应用用自己的代码路径解析到了哪个目录」在打包态**本来就有读数**，只是演练一直没读它。
新判据（`selectHandoffRecord` + `judgeCacheDirResolution`）：

| 态 | 条件 | 判决 |
| --- | --- | --- |
| `matched` | 交接记录的 `version` 是被安装版本，且 `cacheDir` 与演练看的目录逐字相同 | 通过，摘要打出该目录 |
| `mismatch` | 记录里的目录是另一个 | **失败**，原因同时点名两个目录（演练一直盯着错误的目录） |
| `unavailable` | 这个版本没有交接记录（只有别的版本的，或一条都没有） | **失败**，原因写明「目录只是从包内配置推断的，因此该目录被清空不能归给应用」 |

选择器只认同一个版本的记录：别的安装写下的记录对这一次什么也证明不了。同时**删掉那个死探针**
（两处调用点与导出）：一个在打包态永远返回 `unavailable` 的读数，比没有读数更糟。

## 三 读数

### 3.1 本机（单测 + 变异）

- `npx vitest run scripts/update-drill-purge-cross-check.test.ts scripts/ci/update-drill-workflow.test.ts`
  ⇒ **2 files / 19 tests passed**（新增 4 例判据 + 1 例工作流契约）。
- 变异证明断言仍然活着：把选择器的版本过滤去掉 ⇒ **1 failed**（「本版本没有交接记录」那条被别的版本顶过）；
  把 `recorded !== cacheDir` 置成恒假 ⇒ **1 failed**（mismatch 那条）。两次恢复后均回到 19 passed。
- `npx eslint --no-cache` 三个改动文件 ⇒ 0 problem；`npm run typecheck:node` ⇒ 0；`scripts/pre-push-checks.sh` ⇒ EXIT=0。

### 3.2 真机（打包态真安装）

本机造不出这条读数：就地安装要求包带发布用 Developer ID 签名，本机打包是 ad-hoc 签名
（`create-strategy.ts` 的 `macCanAutoUpdate` 直接拒绝）。真机读数由仓库的 `Update Drill (macOS)` 车道给：
它下载两个**已发布**的 arm64 包、起本地 feed、驱动 shipped 的 `quitAndInstall` 完成一次真替换。

- 派发对象＝提交 `1efea1ae`（探针分支 `probe/drill-cache-dir-cross-check`，为的是不顶掉 main 上在飞的 Nightly），
  run `44778180323`，`previous=2.31.0`、`current=2.31.1`。

（读数见 §3.3，由该 run 的真实日志填入。）

### 3.3 该 run 的判决（`44778180323`，逐字摘自作业日志）

```
[drill] updater cache under test: /Users/runner/Library/Caches/purescience-updater
[drill] running 2.31.0; the package's update config resolves the cache to purescience-updater
        (the app's own resolution is judged from its hand-off record below)
[drill] downloaded package before the install: 3 files, 590922823 bytes
[drill] restart-to-update driven via ipc:window.api.update.apply() (applying); the app quit
[drill] updater cache when the app quit: 4 files, 590922884 bytes (61 more than the download)
[drill] app cache-dir resolution: the app resolved /Users/runner/Library/Caches/purescience-updater before installing 2.31.1
[drill] Squirrel.Mac replaced the bundle with 2.31.1 after 3738ms
[drill] the new version is running: 2.31.1
[drill] app purge record: the app recorded purging 590922884 bytes (3 files) from /Users/runner/Library/Caches/purescience-updater after installing 2.31.1
[drill] updater cache after the install: 0 files, 0 bytes (was 590922823)
macos update drill: ok 2.31.0-2.31.1
```

三件事各自有用：

1. **新判据真的跑了并给了值**：`the app resolved … before installing 2.31.1` 出自 `markInstallPending` 的
   交接记录，`state=matched`；同一行在旧版演练里是 `unavailable: Cannot find module 'electron-updater'`。
2. **它回答的是「凭什么是这个目录」**：演练按包内配置推断的目录与应用自己解析的目录逐字相同
   —— 这条以前从未被核过。
3. **两个数字对上了**：退出时缓存 590,922,884 字节（比下载多 61 字节 = 交接标记），应用自报清除
   590,922,884 字节；安装后目录 0 文件 0 字节。

## 四 边界与具名未办

1. **本地 sweep 诊断路径（`runSweepDrill`）的交叉核对仍是记录式**：它读 purge 行、且读不到不致命。它不在
   CI 里跑、本机也没有已签名的包能驱动它，所以这一轮没有改它的判定语义（改了就没有真机读数支撑它没变红）。
   具名立案：下一轮若要收紧，得先给这条路径造一个可驱动的读数。
2. 只覆盖 macOS arm64→arm64；Windows 有 `windows-upgrade-smoke`，Linux 无就地更新演练。
3. 交接记录是**应用写入的日志**，不是内存读数：日志被轮转/截断时新判据会判 `unavailable`（具名失败），
   而不是默默放过 —— 这正是它与旧探针的区别。
