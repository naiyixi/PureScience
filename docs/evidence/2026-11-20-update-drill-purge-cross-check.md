# 更新演练的「清缓存」证据：从「目录空了」升级成「应用自报清了哪个目录、多少字节」

日期：2026-11-20 · 单元：演练的清理交叉核对（接上一轮 §一百八十五 §五 ③）

## 一 改之前的读数（两条，都现取）

| 项 | 读数 | 来源 |
| --- | --- | --- |
| 「应用自报缓存目录」这条核对在打包态取不到 | `[drill] running 2.30.2; the app resolved its cache to "unavailable: Cannot find module 'electron-updater'"` | Update Drill (macOS) run `44630482279`，作业 `135935464418` 日志原文 |
| 清缓存的那条断言只有目录读数 | `[drill] updater cache after the install: 0 files, 0 bytes (was 590843729)` | 同一次日志 |

判读：`--real-update` 这条车道（CI 里唯一真的换包的那条）判「应用清掉了安装包」，依据是**目录变空**；
而这条目录是脚本从包内 `app-update.yml` 的 `updaterCacheDirName` **推断**出来的。两件事都缺一个「谁来担保」：

1. 目录空 ≠ 应用清的（外部清理、初始就是空、甚至脚本看错了目录，三种都会同形通过）；
2. 脚本看的是不是应用真正解析到的那个目录，打包态**没有任何读数**能回答（`require` 在打包后的主进程里解析不到该模块）。

## 二 应用其实一直在自报（产品侧真样本，本机装机版日志）

`~/Library/Logs/PureScience/main.log` 里，v2.30.2 装机版自己写下的一行（逐字）：

```json
{"t":"2026-11-18T03:41:23.606Z","level":"info","scope":"update","msg":"update cache: purged after a completed install","runId":"0ad97d75-7481-4a97-b70e-1815de4a602b","data":{"cacheDir":"/Users/totota/Library/Caches/purescience-updater","installedVersion":"2.30.2","removedFiles":3,"removedBytes":570527788}}
```

这三个字段正好是缺的那半个证据：**应用自己解析到的目录**（`cacheDir`）、**它认为装上的版本**
（`installedVersion`）、**它实际移除的字节数**（`removedBytes`）。该记录由 `src/main/update/cache-maintenance.ts`
的 `purge()` 写出，字段自 `v1.76.0`（`73871fc4`）起就在（`git merge-base --is-ancestor 73871fc4 v2.31.0` 为真）。

## 三 改法（`scripts/macos-update-cache-drill.mjs`）

1. 新增 `readAppUpdateCacheRecords`：按**行解析 JSON** 而不是 grep 子串 —— 原来那句 `line.includes('update cache:')`
   连「recorded the pending install」（还没装）也算命中，两种记录在证据里长得一样。
2. 新增 `selectPurgeRecord`：只按**目录**取最新一条 purge 记录，**不按版本过滤** —— 否则「有记录但版本不符」
   会被报成「从没记录过」这种错话（这是本轮自己在写测试时抓到并改掉的）。
3. 新增 `judgePurgeRecord`：三态失败各自具名 —— 无记录 / 版本不符 / 字节数与演练自己数的不一致；
   `--real-update` 车道在清缓存断言之后调用它，`!ok` 就 `throw`（车道上按名失败，不是静默通过）。
4. 记录进 `evidence.scenarios[…].appPurge`（含 `purgeRecordsSeen` 与命中的那条），失败时日志里能直接看到
   「应用说的目录 vs 演练看的目录」。

## 四 判据（本机实跑）

| 项 | 读数 |
| --- | --- |
| `vitest run scripts/update-drill-purge-cross-check.test.ts` | **8 passed**（读记录 / 跳过半行 / 只取该目录最新 / 通过 / 无记录 / 目录不符 / 字节不符 / 版本不符） |
| `vitest run scripts/ci/update-drill-workflow.test.ts` | **6 passed**（含新增的接线守卫） |
| 变异 ①：去掉字节比较（`if (false)`） | **1 failed**（字节不符那条当场红） |
| 变异 ②：删掉 `if (!purgeVerdict.ok) throw …` | **1 failed**（接线守卫当场红） |
| `eslint --no-cache` 三文件 | 0 error / 0 warning |
| `typecheck:node` / `typecheck:web` | 均 0 |

## 五 第一次派发的读数：新断言当场把演练打红，红的是**参照点**（真发现）

派发 `44653013476`（跑 `db82164f`）后，演练红在自己新加的那一步，逐字：

```
[drill] app purge record: byte count disagrees
macos update drill: failed at cross-check-the-app-purge-record: the drill counted 590843729 bytes in
/Users/runner/Library/Caches/purescience-updater before the install, while the app reports it removed
590843790 — the purge the app performed is not the one this drill observed
```

差 **61 字节**。定因（不是猜测）：应用在**收到 apply 之后**才写 install-pending 标记
（`src/main/update/cache-maintenance.ts` 的 `markInstallPending`），而演练的 `cacheBefore` 快照是在
`download()` 返回后、`apply()` 之前取的 ⇒ 标记那 61 字节不在快照里，却在应用的 `removedBytes` 里。

算术自证：`{"version":"2.31.0","recordedAt":"2026-11-20T01:24:33.123Z"}` + 换行 = **61 字节**（实算）。

修法（收紧参照点，不放宽断言）：在**旧应用退出、新版本尚未启动**的那一刻再取一次快照 `cacheAtQuit`，
`expectedBytes` 改用它的字节数，并把两个读数同时写进证据（`cacheBytesBefore` / `cacheBytesWhenTheAppQuit`）。

## 六 边界（不许读成更强）

- 本轮第一次派发（`44653013476`）**红了**，红在参照点（见 §五），已修并重新派发；第二次的读数回填在
  §七。在那之前，「应用自报的字节数与演练一致」只到「口径已对齐、断言已生效」这一步。
- 演练仍只覆盖 macOS arm64→arm64；Windows 走 `windows-upgrade-smoke`，Linux 无就地更新演练。
- 这条交叉核对证明的是「应用清了它自己解析的那个缓存目录、清掉的字节数与演练观测一致」，
  **不证明**候选包内容正确（那是 feed 的 sha512 与签名两道门的事）。
