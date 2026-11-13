# 签名上线之后，mac 的「手动安装」认证级不再可达（v2.27.0 发版红两次的定因）

日期：2026-11-13（执行器）。仓内不提第三方产品名。

## 一 读数（两轮 Release，同一处红）

| 车道 | run | 作业 | 失败步骤 | 读数 |
| --- | --- | --- | --- | --- |
| Release（`v2.27.0` = `b8dd679a`，手动派发） | `43384543262` | `build / Build macos-arm64`（job `131761548959`） | `Enforce platform certification` | `P0_OUTCOME: failure` ⇒ `p0 ended with failure` |
| Release（同 SHA，重跑） | `43394830799` | `build / Build macos-arm64`（job `131793833882`） | 同上 | 同上 |

两轮的 P0 明细完全一致：

```
1 failed
  e2e/certification/update-manual-install.spec.ts:96:5 › the update installer downloads, verifies,
  and tells a macOS reader to replace it by hand
    Expected: 1   Received: 0      （update-manual-install.spec.ts:132，Timeout 30000ms）
1 flaky   pdf-annotation-narrow-pane.spec.ts:242:5（重试通过）
118 passed (36.4m)
```

第 132 行那条断言是「**冷启动只发一次 manifest 请求**」（30 秒轮询）。`Received: 0` ＝ 这一次启动
**一次 `/version.json` 请求都没有**，不是请求失败。

**这是确定性的，不是抖动**：两轮、各自重试一次，四次机会全部拿到 0。

## 二 定因：签名上线把 mac 稳定版的路由从「手动安装」切到了「原地更新」

`src/main/update/create-strategy.ts` 的策略选择：

- `win32` / `linux` ⇒ `ElectronUpdaterStrategy`（原地更新）；
- `darwin` 且 `isPackaged && !version.includes('-') && 已安装包带本项目的 Team 签名` ⇒ `ElectronUpdaterStrategy`
  （`macCanAutoUpdate`，签名用 `codesign -d --verbose=4` 读 `Identifier` + `TeamIdentifier` 比对）；
- 其余（dev / nightly / ad-hoc / 归属不明）⇒ `UpdateService`（manifest + 手动安装包）。

v2.27.0 是**第一个真的带上 Developer ID 与 Team ID 的稳定版**（证书与变量在此前几笔落地，
`2d0dea00` / `1d70f49c` / `b37e1b66`）。于是发版车道上这台 mac 的包第一次满足 `macCanAutoUpdate`
⇒ 走原地更新；而 `update-manual-install.spec.ts` 钉的正是**手动安装流程**：

1. 它的冷启动断言数的是 `[http-request] … /version.json`（`manifestRequestLines`）——**只有 `UpdateService`
   会发这个请求**；`ElectronUpdaterStrategy.check()` 走的是 electron-updater 的 `checkForUpdates()`
   （读 `app-update.yml` / `*-mac.yml`），不发 `version.json`。
2. 它的夹具替身 `stubUpdateManifest` 替换的是主进程的 `net.fetch`，而 electron-updater 的 HTTP 执行器
   不走这个包装 ⇒ 即使原地更新真的发了请求，替身也拦不到。

⇒ 规格钉的那条路，在签名后的稳定版上**产品里已经不存在了**（对本机用户是好事：签名稳定版走原地更新，
这是设计）。红在「规格过时」，不是产品坏了。

**旁证**：同一份代码在 Nightly 车道是绿的——nightly 版本号带 `-`、包是 ad-hoc，路由仍是手动安装；
v2.26.0 及更早的 Release 也是绿的，因为那时还没有签名。

## 三 修法（本笔）

不做「把断言改成 0 就绿」这种事——那是把认证撤掉。改法是把**两条路各自钉住**：

| 位置 | 改动 |
| --- | --- |
| `src/main/update/create-strategy.ts` | 新增具名开关 `PURESCIENCE_UPDATE_FLOW`（`UPDATE_FLOW_ENV`）：值恰为 `installer` 时在 mac 上直接给 `UpdateService`，**先于签名探测**；其余任何值（含空、含拼错）一律走既有默认策略。win32/linux 不受影响（它们的车道认证的就是原地更新） |
| `src/main/update/create-strategy.test.ts` | 三条：具名请求在**签名稳定版**上赢过签名探测（且探测未被调用）；`in-place` 这类其它值不生效；空白值不生效。16 passed |
| `e2e/certification/update-manual-install.spec.ts` | 模块级设 `PURESCIENCE_UPDATE_FLOW = 'installer'` 并在 `test.afterAll` 清掉（夹具把 `process.env` 原样传给被测进程），断言一条不改 |

为什么用开关而不是改断言：手动安装流程**仍在产品里**（nightly、ad-hoc 包、以及「装的是别家签的包/签名读不出来」
的全部回落路径），它值得保留一条端到端的认证；而原地更新那条路要一条**自己的**真机读数，见下节。

## 四 边界与具名未办（不许读成更强）

1. **本笔没有「签名包 + 真 Team」的本机复现**：Apple 证书只在 CI 密钥里，本机无法造出满足
   `macCanAutoUpdate` 的包。⇒ 开关本身的确定性由单元用例钉住（构造策略这一步）；「发版车道上这台包
   确实走了哪条策略」的判决只能由下一次 Release 车道给，不许在本机声称已验。
2. **原地更新（mac）的真机读数仍未取**（排期档 v2.27 那一条仍为空）：需要一台装了签名稳定版、且有一个
   更新的签名版本的机器，走「检查 → 下载 → 重启 → 版本变新」。本笔只把它与手动安装流程**分开**，
   没有替代它。
3. 夹具替身拦不到 electron-updater 的请求（上文 §二.2）——这本身是一条**测试台**事实，写在这里，
   免得下一轮有人拿 `stubUpdateManifest` 去驱原地更新而得到假绿。

## 五 门禁（本机实跑）

| 环 | 读数 |
| --- | --- |
| `npx vitest run src/main/update/create-strategy.test.ts` | 16 passed（含新增 3 条） |
| `npx vitest run src/main/update` | 见提交信息 |
| 双 typecheck（`--composite false`，`NODE_OPTIONS=--max-old-space-size=8192`） | node 0 / web 0 |
| `npx eslint --no-cache`（三文件） | 0 error / 0 warning |
| `bash scripts/pre-push-checks.sh` | 推送前实跑 |
