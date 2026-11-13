# macOS 签名与公证：三步

前提：Apple Developer Program 会员**已通过审核**（Team ID 已存在）。整个流程在本机完成，密钥不进任何聊天窗口、不进仓库。

## 1. 拿两样东西

**证书（Developer ID Application）**

```
Xcode → Settings → Accounts → 选中团队 → Manage Certificates… → 左下角 + → Developer ID Application
```

生成后导出：钥匙串访问 → 我的证书 → 右键 `Developer ID Application: 你的名字 (XXXXXXXXXX)` → 导出 → 存成 `.p12` → 设一个密码。

**API Key（给公证用，不用账号密码）**

```
App Store Connect → 用户和访问 → 集成 → App Store Connect API → 团队密钥 → +
角色：Developer → 生成 → 下载 AuthKey_XXXXXXXXXX.p8（只能下一次）
```

同时记下 **Key ID**（10 位）和页面顶部的 **Issuer ID**（UUID）。

## 2. 一条命令灌进去

```bash
./scripts/sign-mac-setup.sh
```

它会按顺序问：`.p12` 路径 → 它的密码 → `.p8` 路径 → Key ID → Issuer ID。Team ID 直接从证书名里读，不用你填。

脚本做的事：

- 先用 openssl 打开 `.p12`，**密码错了当场停下**（不会等到 CI 里才炸）；
- 把 `.p12` 和 `.p8` 转 base64 后**直接通过 stdin** 交给 `gh secret set`，不落临时文件、不回显；
- 设置 5 个 secret（`MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`、`APPLE_API_KEY_P8_BASE64`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`）和 1 个变量（`PURESCIENCE_MAC_TEAM_ID`）；
- 最后问你要不要立刻跑预检。

先看它打算做什么、不碰 GitHub：

```bash
./scripts/sign-mac-setup.sh --dry-run
```

## 3. 预检，然后发版

```bash
gh workflow run signing-preflight.yml && gh run watch
```

预检只报「有没有、形状对不对」，**不打印任何密钥片段**，输出可以直接贴出来讨论。六项全绿之后，打 `v2.27.0` 的 tag，release 流程会签名 → `notarytool submit` → `stapler staple` → Gatekeeper 冒烟。

## 为什么 Team ID 要单独设

`PURESCIENCE_MAC_TEAM_ID` 会被 `electron.vite.config.ts` 在**打包时**固化进主进程产物——打包应用从 Finder 启动没有环境变量，靠运行时 env 永远读不到。CI 的 mac 车道打完包会跑 `scripts/ci/assert-baked-team-id.mjs` 遍历所有 chunk 确认字面量真的进去了，没进去就红。

## 没配齐时会发生什么

fail-closed，不假装成功：mac 资产按 ad-hoc 发布，`RELEASE-CERTIFICATION.json` 记 `"macSignature": "unsigned"`，签名门禁会把这件事如实写进结论。

## 真实落地记录（2026-11-13）

这一步实际遇到的坑，记下来省得再踩：

| 现象                                                                                                                                                            | 原因                                  | 解法                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Xcode `Manage Certificates` 里 `+ → Developer ID Application` 报 `Communication with Apple failed — This operation can only be performed by the Account Holder` | 登录 Xcode 的 Apple ID 不是团队持有人 | 换持有人账号，或在网页后台用持有人身份创建                                                                                                         |
| 网页后台能建，但 CSR 不知道哪来                                                                                                                                 | 需要本机生成的 CSR，不是随便一个文件  | `openssl req -new -newkey rsa:2048 -nodes -keyout key.pem -out request.certSigningRequest -subj "/CN=PureScience"`，上传这个 `.certSigningRequest` |
| 下载的 `.cer` 双击装进钥匙串后导出，链不完整                                                                                                                    | 本机缺 Developer ID G2 中间证书       | 中间证书可以从叶证书的 AIA 取：`curl -o devidg2.der http://certs.apple.com/devidg2.der`（苹果官网 `DeveloperIDG2CA.cer` 在本机会 403）             |

证书有效期：2026-11-13 → 2027-12-13，Team ID `UGQZPJ74DF`。

用 `openssl pkcs12 -export` 直接合成 `.p12`（不经过钥匙串导出）是可行的：`.cer` 用 `openssl x509 -inform DER` 转 PEM，与 `key.pem` 一起打包即可，`security verify-cert -c cert.pem -p codeSign` 报 `certificate verification successful`。

本机在临时钥匙串里跑 `codesign` 仍会报 `errSecInternalComponent`（链已可验证、身份也有效），这一步以 CI 的 mac 车道为准——那才是发布用的环境。

## 六项就位的证据（2026-11-13）

`Signing preflight` 车道（run 由 `gh workflow run signing-preflight.yml` 触发）在 macOS runner 上的实际输出：

```
input                        state    detail
---------------------------- -------- ------
MAC_CSC_LINK                 ok       base64 PKCS#12, 3206 bytes
MAC_CSC_KEY_PASSWORD         ok       set (24 characters)
APPLE_API_KEY_P8_BASE64      ok       decodes to a PEM private key
APPLE_API_KEY_ID             ok       10-character key id
APPLE_API_ISSUER             ok       UUID
vars.PURESCIENCE_MAC_TEAM_ID ok       10-character team id
All six inputs are present and shaped correctly.
```

另外在本机用同一把 API key 直接问苹果：`xcrun notarytool history --key AuthKey_*.p8 --key-id … --issuer …`
返回 `No submission history.`——**空白历史本身就是凭据有效的证据**（403/401 才是没通过），比只检查形状更硬。

## 签名打开后，一条被测路径换了

`createUpdateStrategy` 的判断是「打包 + 非预发布版本 + 签名团队匹配」，三者都成立才走 electron-updater 原地更新，
否则回落到 `UpdateService` 的手动安装流程。Team ID 一固化，**打包且签名的稳定版就走原地更新了**——这是设计本意，
但它让 `e2e/certification/update-manual-install.spec.ts` 第一次在真机上失败：

```
expect.poll(manifestRequestLines).toBe(1)   → 收到 0，重试也一样
```

原因不是 flake：那条 spec 数的是 `/version.json` 请求，而原地更新走的是另一条路，根本不会请求它。日志里
`version.json` 出现 **0** 次，是这条判断的实证。

修法是让这条 spec **按名字要求**它要认证的那条路：`PURESCIENCE_UPDATE_FLOW=installer`（只有这个精确值被采纳，
其余一律走默认策略）。第一次把它写在模块作用域，被仓库自己的守卫用例当场拦下——Playwright 在跑第一个用例之前
就 import 了 worker 里所有 spec 文件，模块级赋值会改掉**每一个** spec 的启动环境；改成 `beforeAll` 里通过
`scopeEnvironmentToThisSpec` 设置、`afterAll` 还原。这条守卫是有来历的：曾经三条 spec 在模块级设了同一个变量，
整个 P0 车道的四条文检用例全红。

**仍未覆盖的一处**：稳定签名版的原地更新（Squirrel）只有单元测试，没有打包级 e2e。nightly 的版本号带 `-nightly.`
所以它永远走手动流程，这条路径在 CI 里等于没有真机证据。列为下一版的缺口，不当作已覆盖。
