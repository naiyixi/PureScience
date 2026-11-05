# macOS 签名门：期望的 Team ID 不再写死在仓库里（2026-11-05）

> 口径：每一条结论都能回落到一行源码或一条本机读数；没取到的那一支明确写在 §4。

## 0. 问题（读源，不猜）

发布认证门 `scripts/ci/mac-signing-status.mjs` 曾把一个 Team ID 直接写进仓库：

```js
// 改动前（mac-signing-status.mjs:34）
export const OFFICIAL_MAC_TEAM_ID = '<另一位发布者的 Team ID>'
```

`scripts/macos-update-cache-drill.mjs:282` 又抄了一份同名常量。而产品自己早就不是这么做的 ——
`src/main/update/create-strategy.ts:27` 读的是环境变量 `PURESCIENCE_MAC_TEAM_ID`，未配置就 fail-closed
退回手动安装流程。

写死的那 17 位不是我们的 Team：它是 v2.22「签名实测」里在参考产品上量到的那一支（排期档 §0 表格同一行）。
后果三条，都是发版时才会咬人的：

1. **门永远过不去**：等我们买到自己的 Developer ID，`verify --credentials present` 会拿我们的 Team 去和那个常量比，
   把正确签名判成「不是已签名」⇒ v2.27 的发版链在认证步骤停住，而报错句子看起来像证书问题。
2. **认证件里带着别人的身份**：`RELEASE-CERTIFICATION.json` 的 `macSignatureEvidence.teamIdExpected` 会逐字写上那个 Team，
   随发布资产公开。
3. **两处副本会漂移**：一个改了一个没改，门与演练各说各话。

## 1. 改法（一个变量，两个消费者）

| 文件 | 改动 |
|---|---|
| `scripts/ci/mac-signing-status.mjs` | 删除 `OFFICIAL_MAC_TEAM_ID`；新增 `MAC_TEAM_ID_ENV='PURESCIENCE_MAC_TEAM_ID'` 与 `expectedMacTeamId(env)`（与产品同一个变量名，空白即「未配置」）；`parseCodesignDescription` / `readMacBundleSignature` / `evaluateMacSignatureGate` / `macSignatureEvidence` 都接受 `expectedTeamId`，缺省取环境变量；`verify` 增加 `--team-id` 覆盖并在步骤摘要里打出「期望的团队」与它的未配置态 |
| `scripts/macos-update-cache-drill.mjs` | 删掉自己那份副本，改从上面那个模块导入 `expectedMacTeamId()`；未配置时**具名停止**（「无法判断这两个包是否带本项目的签名」），不再与空串比较 |
| `scripts/ci/release-certification-evidence.*`、`scripts/ci/mac-signing-status.test.ts` | 夹具改用中立 Team（`TESTTEAM01` / `OTHERTEAM1`），并把期望值显式传入，不依赖环境 |

三条判据：

- **签名不再是「读文件里写的那个布尔值」**：gate 从 reading 自己的 `teamIdentifier` 重算，
  一份手写的 `{"signed": true, "teamIdentifier": "<别人的团队>"}` 换不到通过。
- **未配置是一个具名状态，不是通配**：记录里写 `teamIdExpected: 'not-configured'` + `teamIdExpectation`，
  而不是留空让下一个读者猜「没期望」还是「没测到」。
- **凭据在、团队未配置 ⇒ 直接失败**，句子点名 `PURESCIENCE_MAC_TEAM_ID`（这是 v2.27 的配置动作，不是代码缺口）。

## 2. 真机读数（本机 `/Applications/PureScience.app`，真 `codesign`）

退出码一律 `cmd > /tmp/out.txt 2>&1; echo EXIT=$?` 取（不经过管道——`| tee` 会取到 tee 的状态）。

| 场景 | reading 来源 | 期望团队 | 判决 | 退出码 |
|---|---|---|---|---|
| 凭据在、团队未配置 | 本机安装包（ad-hoc） | 未配置 | `FAIL — unsigned`：点名 `PURESCIENCE_MAC_TEAM_ID` | **1** |
| 凭据在、团队已配置、包是 ad-hoc | 本机安装包（ad-hoc） | `TESTTEAM01` | `FAIL — unsigned`：`TeamIdentifier=not set, expected TESTTEAM01` | **1** |
| 无凭据、包是 ad-hoc | 本机安装包（ad-hoc） | `TESTTEAM01` | `ok — unsigned`（只记录，不声称已签名） | 0 |
| 凭据在、团队匹配 | 合成夹具（`synthetic-fixture`） | `TESTTEAM01` | `ok — signed` | 0 |
| 凭据在、团队不匹配 | 合成夹具（`synthetic-fixture`） | `OTHERTEAM9` | `FAIL — unsigned`：两个 Team 都打在句子里 | **1** |
| 无凭据、团队匹配 | 合成夹具（`synthetic-fixture`） | `TESTTEAM01` | `ok — signed`（凭据不是签名成立的前提，实测也不是） | 0 |

本机安装包的真实读数是：

```json
{"schemaVersion":1,"source":"installed-app","artifact":"PureScience.app",
 "bundle":"/Applications/PureScience.app","readable":true,
 "identifier":"com.zerolink.purescience","teamIdentifier":"not set",
 "signerTeam":null,"teamIdExpectation":"not-configured","signed":false}
```

环境变量这条路径也单独跑过：`PURESCIENCE_MAC_TEAM_ID=TESTTEAM01` + 合成签名 reading ⇒ `ok — signed`（EXIT=0）；
同一个变量配上 ad-hoc reading ⇒ `FAIL`（EXIT=1）。即 `--team-id` 只是覆盖，真源是那个变量。

## 3. 变异自证（新例不是摆设）

把 gate 的判定改回「只要有 Team 就算 signed」（`const signed = observed && signerTeam !== null`），
`npx vitest run scripts/ci/mac-signing-status.test.ts` 当场 **3 红**：

- `fails a credentialed run when no expected team is provisioned, naming the variable`
- `fails a credentialed run signed by another team, naming both ids`
- `does not let a reading claim a signature for a team the project does not own`

改回后 5 个相关文件 **58 passed**（`mac-signing-status` / `release-certification-evidence` /
`macos-package-smoke` / `release-notes` / `windows-release-workflows`）。

## 4. 边界（不许读成更强）

- **没有自己的 Developer ID 证书**，所以「真实签名 + 公证」这一支**一条真机读数都没有**；上表里两行 `signed`
  用的是合成 reading，只为证明判定逻辑，不是签名证据。
- **v2.27 的配置动作（不是代码缺口）**：拿到证书时，三处步骤要拿到这个变量 ——
  `build.yml:507`（`Enforce the macOS Developer ID signature gate`）、`notarize-mac.yml:294`（stapling 之后那道）、
  `update-drill-macos.yml:131`（`--real-update` 演练）。不配置的后果是**具名失败**（`unprovisioned is not a pass`），
  不会静默通过 —— 这正是本笔要的效果。
- 本笔不动 workflow（受保护），也不改产品侧 `create-strategy.ts`：它本来就正确。
- 仓库里现在**代码、夹具、文档全文零命中**那 17 位（`grep -rn` 已复核）：排期档里那条历史读数也只写「其 Team 属对方身份，不转录进本仓」。
