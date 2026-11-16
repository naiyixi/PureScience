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

**「通过」那一支的输出形状也不是猜的**：本机拿一台**已公证的第三方 dmg（另一发布方，非我方产物，只读不改）**
喂同一对工具，读出 `accepted` / `source=Notarized Developer ID` / `origin=Developer ID Application: …` 与
`The validate action worked!`，与解析器的两种形状逐字一致。它证明的是**解析器面对真公证件的输出能认**，
**不是**「我们的包已公证」——我方第一份 `accepted` 读数当时仍只能等 v2.27.0 的页（**那句「页未出现」写在页出现之前，
已被 §三之一 取代**）。

**变异自证**：把严模式的判据从「`accepted` 且 `source` 含 Notarized」降到「`accepted`」⇒
只有 `accepts a signed-but-unstapled image only when notarization was required` 一条红，其余 31 条仍绿；
改回后 32/32。这条变异正是「有签名 ≠ 已公证」的机器化表达。

## 三之一 v2.27.0 的首份 `accepted`（页 2026-11-16T17:07:54Z 发布后立刻取）

```
$ node scripts/verify-release.mjs v2.27.0 --require-signed --require-notarized
OK   page-exists: v2.27.0 published 2026-11-16T17:07:54Z
OK   page-not-draft / page-not-prerelease: draft=false, isPrerelease=false
OK   assets-complete: 17 families present of 17 assets
OK   mac-blockmaps: 4/4 mac blockmaps not published (notarized re-emit drops pre-staple blockmaps by design)
OK   body-length: 77061 bytes (floor 2000)    OK   body-no-generator-noise
OK   source-sha-matches-tag: 4f26b9bd869e78b5c94057136c245a0ebe5a7e5e
OK   record-artifacts-on-page: 8 recorded artifact(s) all on the page
OK   sha256sums-match-record: 8 digest(s) equal; 0 record artifact(s) absent from the sums file
OK   mac-signing-observed: macos-arm64=signed (credentialsPresent=true); macos-x64=signed (credentialsPresent=true)
OK   gatekeeper:zerolink-purescience-2.27.0-mac-arm64.dmg: accepted source=Notarized Developer ID
OK   stapled:zerolink-purescience-2.27.0-mac-arm64.dmg: stapler validate=valid
OK   gatekeeper:zerolink-purescience-2.27.0-mac-x64.dmg: accepted source=Notarized Developer ID
OK   stapled:zerolink-purescience-2.27.0-mac-x64.dmg: stapler validate=valid
VERDICT: accepted (0 failure(s), 0 warning(s))        EXIT=0
```

排期档 v2.27.0 第 2 条「`spctl` 从 `rejected` 变 `accepted` / `Notarized Developer ID`」由此取到真读数：
两张 dmg 都是 `accepted` + `Notarized Developer ID`，且**票是钉在包上的**（`stapler validate=valid`），
不是「有签名、没票」那一档。上一轮对 v2.26.0 的对照读数（`rejected source=no usable signature` +
`stapler validate=missing`）与这一份构成同一台仪器上的两个方向。

### 首跑暴露的工具缺陷（已修；与 v2.27.0 的包无关）

在 v2.27.0 上的**第一遍**判决是 `rejected (1 failure)`，失败行自我矛盾：

```
FAIL mac-signing-observed: signing required but record says: macos-arm64=signed (credentialsPresent=true); macos-x64=signed (…)
```

根因是本工具要求字面量 `developer-id`，而记录器（`scripts/ci/mac-signing-status.mjs`，`MAC_SIGNATURE_STATES`）
写的是 `signed` / `unsigned` / `unproven`；那个 `developer-id` **只存在于本工具的测试夹具里**——测试把一处猜测
钉成了契约，于是这条门在真实页面上**从未可能通过**，而它自己的失败文案又在说「要求签名，记录说 signed」。

修法（**收紧**，不是放宽）：`signingEvidenceGap()` 改成「状态 + 可归属的证据」双判——

1. `macSignature === 'signed'`（记录器自己的词表）；
2. 记录里 `teamIdentifier` 非空且不是 `not set`（**可归属**到某个团队）；
3. `teamIdExpectation === 'configured'` 时，`teamIdentifier` 必须等于 `teamIdExpected`；
4. `readingSource` 非空（**被观测**，而不是被断言）。

夹具换成 v2.27.0 记录里的真实形状，并另加三例：只有 `signed` 一词而无 TeamIdentifier ⇒ 红；
TeamIdentifier 不是本项目配置的那个 ⇒ 红；`unproven` ⇒ 红（**未观测不算有签名**）。38/38 绿。

## 四 门禁

| 环 | 读数 |
| --- | --- |
| `npx vitest run scripts/verify-release.test.ts` | **1 file / 38 passed**（原 21 → 32 → 本轮补 6：词表与证据四例 + 读取形状两处） |
| `npm run typecheck:node` | 0（**须带 `NODE_OPTIONS=--max-old-space-size=8192`**；默认堆下 `Abort trap: 6`，那是本机小内存的老形状，不是代码错） |
| `npm run typecheck:web` | 0 |
| `npx eslint --no-cache scripts/verify-release.mjs scripts/verify-release.test.ts` | **0 error / 0 warning** |

## 五 边界与具名未办

1. ~~**v2.27.0 还没有读数**~~ ⇒ **已取**（§三之一，`VERDICT: accepted`）。页 `2026-11-16T17:07:54Z` 发布，
   `Latest`、`draft=false`、`isPrerelease=false`、17 族资产齐、`sourceSha` 与 tag 指向的提交逐字一致。
2. 只判**这一层**：不重算 dmg 摘要（`SHA256SUMS.txt` 与记录的一致性已有既有检查）、不挂载安装、不跑应用。
   `codesign -d --verbose=4` 的 Team ID 与「装上去能启动」属装机取证，仍未做——本轮**只**证明 OS 认这两个 dmg，
   **没有**证明装机后可启动。
3. 本机**没有窗口读数**（本单元是工具链，不新增界面/数据路径）。资源读数见当轮汇报。
4. `--assess-installers` 会下载每个 mac dmg（两张合计约 300 MB，本机实测冷跑 > 300 s 超时，热跑 < 180 s），
   所以默认不开。

## 六 下一轮第一步

- ① 第 2 条已收口（读数在 §三之一）；接着做排期档 v2.27.0 第 3 条：cask 与 README 的签名自陈是否已与事实同步
  （`0c74c080` 自称已同步 ⇒ **核它，不重做**）。
- ② 把本轮的词表缺陷补进「发版验收」的常驻口径：**门禁要求的字面量必须来自生产者自己的枚举**，
  不能由消费方另造一个词（否则夹具先绿、真页面永红）。
- ③ 恢复推送后把本地攒的几笔一并推（`git log --oneline origin/main..HEAD`），推后按完整 40 位 SHA 盯双车道。
