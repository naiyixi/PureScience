# macOS 签名与就地更新：产物级读数，以及一道此前不可能通过的闸门（issue #19 结案）

**日期**：2026-11-20
**对象**：v2.31.0 的 mac 产物（arm64 / x64）与「就地更新演练」这条发布期闸门
**结论**：① 已发布的 mac 包**确实带本项目的 Developer ID 签名并已公证/装订**（读数取自下载下来的真字节，
且与发布页 `SHA256SUMS.txt` 逐字节对上）；② issue #19 要求的「no-op 必须具名」「未签名不得发布」两条闸门
都已在位；③ 第 4 条验收（真实就地更新）此前**从未通过过**，根因不是产品，而是**演练工作流没把团队 ID 交给
演练脚本** —— 该门自建立起只有「签名不可归属」这一种判决。补上接线后同一份产物一次跑通：
`macos update drill: ok 2.30.2-2.31.0`。

## 一 产物级读数（本地现取，字节与发布清单一致）

| 项 | 读数 |
| --- | --- |
| 资产 | `zerolink-purescience-2.31.0-mac-arm64.zip`，295,421,771 字节 |
| 摘要对账 | 本地 `shasum -a 256` = `50226b870208d31355d057e128aaf80244103ecafcde73b92cba1e598025e1ac`，与发布页 `SHA256SUMS.txt` 里该行**逐字符相同** ⇒ 下面读到的签名是**发布出去的那份字节**的签名 |
| `codesign --verify --deep --strict` | `valid on disk` / `satisfies its Designated Requirement` |
| `codesign -dv` | `Identifier=com.zerolink.purescience`、`Authority=Developer ID Application: kai wang (UGQZPJ74DF)`、`flags=0x10000(runtime)`（硬化运行时） |
| `spctl -a -vv -t exec` | `accepted`，`source=Notarized Developer ID`，`origin=Developer ID Application: kai wang (UGQZPJ74DF)` |
| `xcrun stapler validate` | `The validate action worked!` ⇒ 公证票据已装订进**发出去的那个 zip 里的 .app** |

x64 半：同一次发布作业的读数（run `44595482669`，job `135850436306`）：

```
macOS signature reading (shipped-zip): Identifier=com.zerolink.purescience TeamIdentifier=UGQZPJ74DF signed=not-compared
stapled macos-x64: ok — macSignature=signed: Apple credentials are configured and the macOS asset is Developer ID signed
```

arm64 半（job `135850436320`）同样 `stapled macos-arm64: ok — macSignature=signed`，并且 `stapler staple`
与 `stapler validate` 对 dmg 与 .app 各成功一次（两行 `The staple and validate action worked!`），随后把装订后的
.app 重新压回 zip —— 这解释了为什么「下载下来的 zip 里票据是热的」。

**凭据在位**（只报名字与变量值，不报内容）：secret 五项 `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` /
`APPLE_API_KEY_ID` / `APPLE_API_ISSUER` / `APPLE_API_KEY_P8_BASE64` 均已配置；仓库变量
`PURESCIENCE_MAC_TEAM_ID = UGQZPJ74DF`（2026-11-13 设置）。

## 二 issue #19 第 2、3 条：闸门已经在位

| 要求 | 实现 | 读数 |
| --- | --- | --- |
| no-op 必须是**具名**的，不许安静地绿 | `notarize-mac.yml` 无机密时打印 `::warning::APPLE_API_KEY_P8_BASE64 is not set — notarization, stapling and the Gatekeeper smoke are SKIPPED … assets ship UNSIGNED`，并在发布页写披露块、认证记录写 `macSignature: unsigned` | 日志原文与 `scripts/ci/mac-signing-status.mjs:49,62,173-216` |
| 未签名不得发布 | `mac-signing-status.mjs verify --credentials present --reading <json>`：凭据在场而读数是 unsigned ⇒ `FAIL`；`release.yml` 在**上传之前**做 mac feed 双架构门与认证聚合 | `scripts/ci/mac-signing-status.mjs:310,337-341`；`release.yml:275-296` 的「Merges + Gate the mac update feed」两步 |
| 未观测 ≠ 通过 | `unproven` 是独立一等结果（读不出签名时既不算 signed 也不算 unsigned） | `mac-signing-status.mjs:41` 的 `MAC_SIGNATURE_STATES` |

## 三 issue #19 第 4 条：演练为什么从来没绿过，以及修法

| 读数（run） | 判据 |
| --- | --- |
| `36600498726` / `36667135084`（2026-09-29/30） | 当时产物是 ad-hoc 签名 ⇒ 演练按设计拒绝，issue 即由此开出 |
| `44629584158`（本次第一次派发，提交 `e2610438`） | 签名已经好了：`signatures: previous={teamIdentifier:UGQZPJ74DF, adHoc:false} update={…同上}`。红在同一句：`PURESCIENCE_MAC_TEAM_ID is not set, so the drill cannot say whether these bundles carry this project's Developer ID signature` |
| 根因 | `scripts/macos-update-cache-drill.mjs:583-593` 要求该变量；而 `.github/workflows/update-drill-macos.yml` 的 job **没有任何 env** ⇒ 这道门在凭据配齐之后仍然**只可能**停在这一句（门本身是对的：不可归属的签名不算通过，fail-closed） |
| 修法 | 工作流 job 级补 `PURESCIENCE_MAC_TEAM_ID: ${{ vars.PURESCIENCE_MAC_TEAM_ID }}`（与公证作业、发版闸门共用同一个变量，不写死字面量）；新增守卫用例 `scripts/ci/update-drill-workflow.test.ts` 钉四处契约：变量真被交接、两侧变量名一致、必须 `--real-update`、判决行两侧都在 |
| 提交 | `d60e0539`（2 个文件，+89） |

## 四 修后重跑的读数（run `44630482279`，全绿）

```
[drill] artifacts: 2.30.2 -> 2.31.0
[drill] signatures: previous={"identifier":"com.zerolink.purescience","teamIdentifier":"UGQZPJ74DF","adHoc":false}
                    update  ={"…同上"}
[drill] published mac feed: {"version":"2.31.0","advertisesArm64":true}
[drill] check()    -> {"state":"available","latest":"2.31.0"}
[drill] download() -> {"state":"ready","latest":"2.31.0"}
[drill] downloaded package before the install: 3 files, 590843729 bytes
[drill] restart-to-update driven via ipc:window.api.update.apply() (applying); the app quit
[drill] Squirrel.Mac replaced the bundle with 2.31.0 after 2882ms
[drill] the new version is running: 2.31.0
[drill] updater cache after the install: 0 files, 0 bytes (was 590843729)
macos update drill: ok 2.30.2-2.31.0
```

观测 JSON（run 产物）里两条场景都 `passed`：`download-then-restart-to-update-quits-the-app`、
`the-install-landed-then-the-downloaded-package-was-purged`；`updateArtifact.sha512` 与喂给应用的
`latest-mac.yml` 一致，`serverMetrics = {feedRequests:2, artifactRequests:1, artifactBytesServed:295421771}`。

## 五 边界（不把没验的写成验了）

1. **清缓存那条断言的路径来源**：`cacheDirResolvedByApp` 读成 `unavailable: Cannot find module 'electron-updater'`
   —— 演练在**打包态**主进程里 `require('electron-updater')` 解析不到（打包产物是 bundled），所以「应用自报缓存目录」
   这条**独立交叉核对在这一版取不到**。清缓存断言实际依据的是**包内 `app-update.yml` 的 `updaterCacheDirName`**
   （读数：`/…/Current/Resources/app-update.yml` → `purescience-updater` → `~/Library/Caches/purescience-updater`），
   也就是应用自己发布的配置，而不是演练猜的路径。这是**探针能力缺口**，不是产品缺陷；下一条演练改动若要更硬的证据，
   应让应用自己在日志里报出清理目录（`readAppPurgeLogLines` 已按 `update cache:` 找，本次未命中）。
2. 只覆盖 **macOS arm64 → arm64**（同一 Team 的两次稳定发布）。Windows 更新链有独立演练（`windows-upgrade-smoke`），
   Linux 未做就地更新演练。
3. 演练每次下载约 600 MB 安装件并真装真起，手动触发（`workflow_dispatch`），不进每次推送的门。
4. 本文件所有产物读数取自 v2.31.0；换版本要重取，不能沿用。

## 六 门禁（本机实跑）

| 环 | 读数 |
| --- | --- |
| `npx vitest run scripts/ci/update-drill-workflow.test.ts` | 1 file / **5 passed** |
| 变异证明（把变量名改成 `vars.MUTATION_PROBE`） | **1 failed** ⇒ 守卫真的在守接线，不是同义反复 |
| `npx eslint --no-cache`（改动的两个文件） | 0 error / 0 warning |
| `npm run typecheck:node`（`scripts/**` 只被 node 工程收录） | 0（`tsc --noEmit -p tsconfig.node.json --composite false`） |
| `bash scripts/pre-push-checks.sh` | `EXIT=0`，全部通过 |
| CI | 演练 run `44630482279` success；`d60e0539` 的 Nightly / Windows 判决另记（见发布轮档） |
