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
