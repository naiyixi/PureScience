# 发版验收：把 Gatekeeper 自己的判决收进同一条命令（spctl + stapler）

- 单元：`scripts/verify-release.mjs` 新增 `--assess-installers` / `--require-notarized`
- 日期：2026-11-17（本轮执行器）
- 关联：排期档 v2.27.0 第 2 条「`spctl` 从 `rejected` 变 `accepted` / `Notarized Developer ID`」、
  第 3 条「cask 去掉 `--no-quarantine`」

## 一 为什么加这一条

上一轮把发版验收收成一条命令时，签名那一格明确只**转抄**认证记录里的 `macSignature`，并写下边界：
「不判资产内容对不对（不下载大件、不重算 dmg 摘要），也不做 `codesign`/`spctl`/`stapler` 的真实性验证」。
而排期档这次要的恰恰是 OS 的判决：`rejected` → `accepted` / `Notarized Developer ID`。

两者不可互相替代：记录说的是**流水线相信什么**，`spctl` 说的是**这台 Mac 认什么**。
中间那一档真实存在——Developer ID 签名在、公证票没钉上：记录里会写 `developer-id`，
而 `spctl` 判 `accepted` 但 `source=Developer ID`（不是 `Notarized Developer ID`），`stapler` 报没有票。
把「有签名」读成「已公证」正是这一版要避免的失真。

## 二 交付

| 位置 | 改动 |
| --- | --- |
| `scripts/verify-release.mjs` | 新导出纯函数 `parseGatekeeperAssessment`（解析 `spctl -a -t open --context context:primary-signature -vvv` 与 `xcrun stapler validate` 两段输出）；`evaluateRelease` 新增 `installerAssessments` / `requireNotarized` / `gatekeeperSkipReason`；`main` 新增 `--assess-installers`、`--require-notarized`，按页上的每个 mac dmg 逐张下载后交本机 Gatekeeper 判 |
| `scripts/verify-release.test.ts` | +11 例：两种真实输出形状、空输出、工具根本没起（status null）、CloudKit 失败不当作「没有票」、零退出但无确认行、逐张一读、宽/严两态、问了却没对象、本机不能问 |

判据（三类缺态各占一格，都不读成通过）：

1. **没问**（未加旗标）⇒ `gatekeeper-assessed` 记一条非致命说明；加了 `--require-notarized` 而未问 ⇒ 硬失败；
2. **本机不能问**（非 macOS / `spctl` 不在）⇒ 点名宿主，`--require-notarized` 下硬失败；
3. **问了但没有可判对象**（页上没有 mac dmg）⇒ 硬失败，不写「0 个问题」。

`--require-notarized` 的判据是 `verdict=accepted` **且** `source=Notarized Developer ID` **且** `stapler validate=valid` 三条同时成立；
默认模式下 `rejected` 只记警告（凭据到位前的历史版本本来就该是 rejected，这与 `--require-signed` 的既有口径一致）。

## 三 真机读数（本机实跑，真实发布页真实字节）

对 **v2.26.0**（ad-hoc 签名、未公证）跑两次，同一条命令的两个方向：

```
$ node scripts/verify-release.mjs v2.26.0 --assess-installers
WARN gatekeeper:zerolink-purescience-2.26.0-mac-arm64.dmg: rejected source=no usable signature
WARN stapled:zerolink-purescience-2.26.0-mac-arm64.dmg: stapler validate=missing
WARN gatekeeper:zerolink-purescience-2.26.0-mac-x64.dmg: rejected source=no usable signature
WARN stapled:zerolink-purescience-2.26.0-mac-x64.dmg: stapler validate=missing
VERDICT: accepted (0 failure(s), 4 warning(s))        EXIT=0

$ node scripts/verify-release.mjs v2.26.0 --assess-installers --require-notarized
FAIL gatekeeper:…-mac-arm64.dmg: rejected source=no usable signature
FAIL stapled:…-mac-arm64.dmg: stapler validate=missing
FAIL gatekeeper:…-mac-x64.dmg: rejected source=no usable signature
FAIL stapled:…-mac-x64.dmg: stapler validate=missing
VERDICT: rejected (4 failure(s), 0 warning(s))        EXIT=1
```

这两行合起来才是「仪器可用」的证据：真 `spctl` 真字节给出 `rejected`，严模式把同一份读数判红。
若仪器只会打印通过，第一条就应该是 `accepted source=Notarized Developer ID`——它没有。

**变异自证**：把严模式的判据从「`accepted` 且 `source` 含 Notarized」降到「`accepted`」⇒
只有 `accepts a signed-but-unstapled image only when notarization was required` 一条红，其余 31 条仍绿；
改回后 32/32。这条变异正是「有签名 ≠ 已公证」的机器化表达。

## 四 门禁

| 环 | 读数 |
| --- | --- |
| `npx vitest run scripts/verify-release.test.ts` | **1 file / 32 passed**（原 21，本轮 +11） |
| `npm run typecheck:node` | 0 |
| `npm run typecheck:web` | 0 |
| `npx eslint --no-cache scripts/verify-release.mjs scripts/verify-release.test.ts` | **0 error / 0 warning** |

## 五 边界与具名未办

1. **v2.27.0 还没有读数**：Release run `43849287714`（`4f26b9bd`）的 `Notarize + staple macos-arm64`
   自 `15:33:49Z` 起 `in_progress`，页尚未出现 ⇒ 本轮只把判据与仪器做好，不预填读数。
2. 只判**这一层**：不重算 dmg 摘要（`SHA256SUMS.txt` 与记录的一致性已有既有检查）、不挂载安装、不跑应用。
   `codesign -d --verbose=4` 的 Team ID 与「装上去能启动」属装机取证，仍未做。
3. 本机**没有窗口读数**（本单元是工具链，不新增界面/数据路径）。资源读数：空闲页 5,413（≈88 MB）、
   swap 可用 984 MB ⇒ 起不了 Electron 窗口，与近几轮同一条闸门。
4. `--assess-installers` 会下载每个 mac dmg（v2.26.0 两张合计约 300 MB），所以默认不开。

## 六 下一轮第一步

- ① 页出现后立刻：`node scripts/verify-release.mjs v2.27.0 --assess-installers --require-notarized`
  （要 `accepted` + `source=Notarized Developer ID` + `stapler=valid` 三样齐），读数写进本档并回填排期档第 2 条；
- ② 三样齐了才动第 3 条：README 那一句「signed ad-hoc rather than notarized，必要时 `--no-quarantine`」
  必须与事实同步（`README.md` / `README.en.md` 两处）+ tap 仓库 cask 的 caveats；
- ③ 若 `18:33Z` 的 3 小时上限到点仍未判决 ⇒ 按既有口径记读数、不 rerun（rerun 会再提交一笔）。
