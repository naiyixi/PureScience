# 发版验收从「每次手搓一张清单」变成一条命令（2026-11-16）

## 一 为什么做这一件

每一轮发版结束都要手工核同一批东西：页是不是 draft / prerelease、四平台资产齐不齐、
`RELEASE-CERTIFICATION.json` 的 `sourceSha` 是否等于 tag 指向的提交、正文是不是生成器原样输出、
`SHA256SUMS.txt` 与认证记录里的摘要是否逐项相等。**这份清单在历史里已经出过两次仪器错**：

- 靠记忆里的一份短清单数资产 ⇒ 完整页被判成「资产不全」；
- 用大小写不对的名字去选认证件 ⇒ 零命中被读成「认证记录不存在」。

而真正的坏发版形状是**页在、但只有 3 个资产**（发布作业被跳过，例如
`docs/plan-2026-10-25-release-verify-pin-and-egress-close.md` 里 v2.17.1/4/5/6 那张表：
21 → 3 → 21 → 3 → 3 → 3）。这条形状靠人眼扫 `gh release view` 会漏，靠命令一眼就能判。

## 二 交付

| 位置                             | 改动                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/verify-release.mjs`     | 新增。纯函数 `planRequiredAssets` / `parseSha256Sums` / `readCertification` / `evaluateRelease` + 一个 CLI（`gh release view` / `gh release download` / `git rev-parse` 取数） |
| `scripts/verify-release.test.ts` | 新增 21 条：夹具用的是 **v2.26.0 真实资产名与真实记录形状**（`{schemaVersion, sourceSha, platforms[]}`）                                                                       |
| `package.json`                   | `release:verify` 入口：`npm run release:verify -- v2.27.0`                                                                                                                     |

判的十件事（每条都有名字，失败会点出具体资产名/具体文件）：

1. `page-exists` / `page-not-draft` / `page-not-prerelease`（预发布页要 `--allow-prerelease` 明说不算失败）；
2. `assets-complete`：**21 个族**（mac 8 / linux 2 / windows 3 / 元数据 8），缺哪个点哪个，不数总数；
3. `body-length`（默认下限 2000 字节）与 `body-no-generator-noise`（没有以 `release-notes:` 开头的行）；
4. `certification-read` 与 `source-sha-matches-tag`：记录里的 `sourceSha` 必须与 `git rev-parse '<tag>^{commit}'` 逐字符相等；
5. `record-artifacts-on-page`：记录里列出的每个产物都必须真在页上；
6. `sha256sums-match-record`：`SHA256SUMS.txt` 与记录两侧的摘要必须相等；**一条都没比上（解析出 0 行）判失败**，不读成「一致」；
7. `sha256sums-covers-record`：记录里有、sums 里没有 ⇒ 只**告警**并点名（不撒谎说不一致）；
8. `mac-signing-observed`：签名状态**逐平台照抄记录**（例如 `macos-arm64=unsigned (credentialsPresent=false)`），**从不从绿点推断**；`--require-signed` 才把「不是 Developer ID」判失败。

## 三 读数（本机实跑）

**真实发布页 v2.26.0**（`node scripts/verify-release.mjs v2.26.0`，退出码 0）：

```
OK   page-exists: v2.26.0 published 2026-11-04T19:15:31Z
OK   page-not-draft: draft=false
OK   page-not-prerelease: isPrerelease=false
OK   assets-complete: 21 families present of 21 assets
OK   body-length: 74152 bytes (floor 2000)
OK   body-no-generator-noise: no release-notes: lines
OK   certification-read: record read
OK   source-sha-matches-tag: 9388544e497a030930feb2a1c4b3c6d8c37f26f8
OK   record-artifacts-on-page: 8 recorded artifact(s) all on the page
OK   sha256sums-match-record: 8 digest(s) equal; 0 record artifact(s) absent from the sums file
OK   mac-signing-observed: macos-arm64=unsigned (credentialsPresent=false); macos-x64=unsigned (credentialsPresent=false)
VERDICT: accepted (0 failure(s), 0 warning(s))
```

这条读数与历史手工结论**逐项吻合**（21 资产、8 个摘要相等、`sourceSha` 与 tag 提交一致、mac 未签名）
⇒ 仪器不是「只要有页就报绿」：它是用同一批判据复算了一遍已经人工核过的发版。

**变异自证**：把 `sha256sums-match-record` 的比较改成恒不触发（`if (false && …)`），
对应用例 `fails when the two digest sources disagree, naming the file` **当场红**，其余 20 条仍绿
⇒ 这条断言没有被削弱成「跑过就算」。改回后 21/21 全绿。

## 四 门禁

| 环                                                                   | 读数                    |
| -------------------------------------------------------------------- | ----------------------- |
| `npx vitest run scripts/verify-release.test.ts`                      | **1 file / 21 passed**  |
| `npm run typecheck:node`（`NODE_OPTIONS=--max-old-space-size=8192`） | **0**                   |
| `npm run typecheck:web`                                              | **0**                   |
| `npx eslint --no-cache scripts/verify-release.{mjs,test.ts}`         | **0 error / 0 warning** |
| 真机读数（真实发布页）                                               | 见 §三，退出码 0        |

## 五 边界与具名未办

- **它不判资产内容对不对**：只判「页上的族齐不齐、两处摘要一致不一致、记录指向哪个提交」。
  真正的字节正确性仍要靠下载 + 实际运行（装机 smoke），本条不替代。
- **不下载大资产**：只取 `RELEASE-CERTIFICATION.json` 与 `SHA256SUMS.txt`（几 KB），
  所以它不会替你做「重算 dmg 摘要」这件事。
- **v2.27.0 还没有读数**：该页尚未出现（arm64 公证仍在 Apple 队列里）⇒ 本条只在 v2.26.0 上取过真读数，
  v2.27.0 的读数要等页出现后再补，**不预填**。
- 不做签名/公证的**真实验证**（`codesign` / `spctl` / `stapler validate`），那是装机取证的活；
  本命令只如实转抄认证记录里的签名状态。
