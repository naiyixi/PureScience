# 本地 sweep 演练：把「目录空了」升级成「应用自报它清了哪个目录、多少字节」

日期：2026-11-21（执行器）。对象：`scripts/macos-update-cache-drill.mjs` 的默认模式（本地 sweep 演练，
CI 不跑；CI 跑的是 `--real-update` 那条）。

## 一 改之前的读数（先取，再改）

隔离工作树 `/tmp/ps-sweep-drill`（`eead513d`，软链 `node_modules`，`npm run build:e2e` 产物），
`node scripts/macos-update-cache-drill.mjs`：

```
[drill] launch mode=dev-app-root app version=2.31.2
[drill] seeded cache: 6 files, 42991788 bytes
[drill] scenario 1: cache 42991788 B -> 0 B (0 files) in 41ms
[drill] app log: no purge line found
[drill] scenarios: landed-install-purges-the-downloaded-package=passed, ...=passed（四条全绿）
macOS update-cache drill completed successfully.
```

四条全绿，但**没有任何一条**引用应用自己的记录：`passed` 全部来自「演练看到的目录空了」。
`no purge line found` 就是那个缺口露出来的地方。

## 二 为什么读不到：日志目录名是按构建模式变的，演练在猜

- 应用侧：`app.getPath('logs')` 在打包态答 `…/Logs/PureScience`，在 dev app root 答
  `…/Logs/PureScience (DEV)`；记录本身由 `src/main/update/cache-maintenance.ts` 写（`markInstallPending` /
  `purge` / 孤儿清理三条，均在 `info` 级）。
- 演练侧（改前）：只在 `home/Library/Logs/PureScience` 与真实 `~/Library/Logs/PureScience` 两个**写死的名字**里找。
- 实测：本轮之前那次 dev app root 运行，应用的记录实际落在
  `~/Library/Logs/PureScience (DEV)/main.log`，演练两个候选都没中 ⇒ 打印 `no purge line found`，而判决不受影响
  （因为它本来就没参与判决）。这就是「读数在，但没人读」。

## 三 改法（只动演练脚本 + 它的用例，不动产品代码）

1. **让应用自己说日志文件在哪**：`launchApp` / `launchPackagedApp` 在拿到窗口后调
   `window.api.logs.getPath()`（既有通道 `logs:get-path`），把路径带出；读者用它的目录，名字不再猜。
   应用不答时保留原有两个候选（不变）。
2. **判决里加应用侧的正值证据**（与 packaged 演练同一条纪律）：
   - 场景 1、2：`judgePurgeRecord` —— 应用自报的 `cacheDir` 必须**逐字等于**演练看的目录、
     `installedVersion` 等于本轮装上的版本、`removedBytes` **逐字节等于**演练落地前的快照；
   - 场景 2b（空缓存保持为空）：改成**计数**「应用的 purge 记录条数不变」，而不是只看目录没变；
   - 场景 3（回滚保留可安装包）：新增 `judgeOrphanRemovalRecord` —— 应用必须自报删掉了**那个**孤儿
     `pending/temp-…zip`；同时 purge 记录条数不变（说明它没把这个包当成已落地的安装）。
3. **两处仪器修正**（都是本轮自己咬到的）：
   - 读者的尾部窗口从 400 行抬到 5,000 行并做成常量：一次启动能写数百行，400 行会让**启动早期**写的记录
     在演练读到它之前掉出窗口 ⇒ 表现为「应用没记录」（实测：孤儿那条就这么丢了）。
   - 孤儿记录的选择加了 `skip`（本轮之前已存在的条数）：种下去的文件名是确定的，上一轮留下的记录会**同名**，
     内容判据挡不住它，只能用位置区分。
4. 新增 `waitForAppRecord`（10 s 内轮询，写盘是异步的），缺记录不再等于「应用没记录」。

## 四 改之后的真机读数（dev app root，应用版本 2.31.2）

```
[drill] app purge record: the app recorded purging 42991788 bytes (5 files) from <隔离根>/Library/Caches/purescience-updater after installing 2.31.2
[drill] scenario 1: cache 42991788 B -> 0 B (0 files) in 92ms
[drill] app purge record (relaunch): the app recorded purging 42991788 bytes (5 files) from <同一个目录> after installing 2.31.2
[drill] scenario 2b: cache stayed at 0 B, purge records 2 -> 2
[drill] app orphan record: the app recorded removing the orphaned partial download pending/temp-PureScience-2.31.3-arm64-mac.zip
[drill] scenario 3: pending package 33554432 B -> 33554432 B, marker kept=true, partial removed=true, app orphan record=ok, purge records 2 -> 2
[drill] scenarios: 四条全 passed
```

即：**四个判决现在都建立在应用自己写下的记录上**，字节数（42,991,788 = 落地前快照）与文件数（5）逐字对上。

## 五 变异自证（三处闸门都能真的打红）

在隔离工作树里各造一份变异副本跑真机（每次都是四启动的真演练）：

| 变异 | 结果 |
| --- | --- |
| 日志目录不取应用自报（退回猜名字） | **红**：`no purge record — 2 purge record(s) seen, naming "/Users/totota/Library/Caches/purescience-updater"`（改前这一态是静默通过） |
| 期望字节 +1（让比对不可能成立） | **红**：`byte count disagrees — the drill counted 42991789 bytes …, while the app reports it removed 42991788` |
| 孤儿记录 skip 基线 +1（让本轮记录够不着） | **红**：`app orphan record=missing`，场景 3 失败 |

第三条同时证明「上一轮的同名记录不能顶替本轮」这一条判据是有效的。

## 六 门禁（本机，改动之后）

- `npx vitest run scripts/` —— **46 文件 / 590 例通过**（13 文件跳过）；其中
  `scripts/update-drill-purge-cross-check.test.ts` **20 例**（新增 6 例：应用自报日志目录 2 例、purge 计数 1 例、
  孤儿记录 3 例，另加 1 例「启动把记录推到 1,000 行之后仍要读得到」）。
- `npx eslint --no-cache` 两个文件 —— **0 error 0 warning**。
- `npm run typecheck:node` / `typecheck:web` —— **均 0**。

## 七 边界（不许读成更强）

- 跑的是 **dev app root** 模式（`out/main/index.js`），不是打包态：本机 `dist/mac-arm64/PureScience.app`
  是 **v2.21.0（10-31）**的旧包，本轮用它跑 packaged 模式时卡在 `electronApp.close()`（600 s 未返回；应用
  自己已收到 quit 并写了 shutdown 记录）——**这是旧包的现场，不是本轮改动引起的**，也没有据此声称任何产品缺陷。
  打包态的这条演练由 CI 的 `--real-update`（真签名包、真替换）覆盖，本轮没有改动那条路径。
- 本地 sweep 演练**不在 CI 里**（`.github/workflows/update-drill-macos.yml` 只跑 `--real-update`），所以本轮读数
  是本机真机读数，不是车道读数。
- 记录是 `info` 级的日志行；若某次运行把日志级别调高到 `warn`，这条交叉核对会转成「拿不到记录 ⇒ 具名失败」，
  不会静默通过。
- 没有改任何产品代码、没有写 CHANGELOG。
