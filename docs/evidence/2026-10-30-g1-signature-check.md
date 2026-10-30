# G1（非花钱半边）—— 签名状态与「装得上但系统不认发布者」的下一步

日期 2026-10-30 22:2x CST｜仓库 `/Users/totota/purescience`｜`purescience doctor` 新增 `signature` 一项

## 1 为什么先做这半边

计划 §四 G1 需要拍板花钱（Apple Developer Program 99 美元/年；Windows OV 证书约 200–400 美元/年），
不拍板就只做「未签名但可安装」的提示与校验。这件事用户真正会遇到的是**两种完全不同的处境**：

- 装不上（包坏了）—— 这是缺陷，要修；
- 装得上但系统说不出发布者是谁（adhoc / NotSigned）—— 这是**已知状态**，需要一句「点哪里继续」。

在此之前，CLI 对这件事一句话都没有：`doctor` 只说定位到了哪个二进制。

## 2 本轮交付

| 位置                                     | 内容                                                                                                                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/purescience/signature.mjs`     | `checkSignature({command, platform, exec, exists})`：macOS 读 `codesign -dv --verbose=2` 的签名类型 + `spctl --assess -vv` 的 Gatekeeper 判决；Windows 读 Authenticode 状态；Linux 明确「没有这一层」                       |
| `packages/purescience/doctor.mjs`        | 新增 `signature` 检查项：`developer-id`/`authenticode`/`not-applicable`/`development` ⇒ `ok`；`adhoc`/`unsigned` ⇒ `warn`；`invalid`（Windows `HashMismatch` 等）⇒ `fail`                                                   |
| `packages/purescience/signature.test.ts` | 10 条：三种 `codesign` 文本各归各位、`.app` 包的定位、Gatekeeper `rejected` 与「下一步」文案、Developer ID 不说「点仍要打开」、Windows `NotSigned` 与 `HashMismatch` 分开、Linux 不写成「未签名」、没有二进制时是 `unknown` |

三种状态分开命名，**不合并成一句「未签名」**：`adhoc` 是有签名但无证书、`unsigned` 是根本没签、
`development` 是开发运行（压根没有发布签名这件事）。合并会把「开发运行」读成「安装包有问题」。

## 3 真机读数（本机，两次实跑）

开发运行（`node packages/purescience/cli.mjs doctor`，定位到 `node_modules/electron` 里的 Electron）：

```
[ok  ] app_binary  command=/Users/totota/purescience/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron packaged=false
[warn] signature  state=adhoc gatekeeper=rejected detail=首次打开会被 Gatekeeper 拦下：…
```

已安装的产品包（`--app-path /Applications/PureScience.app/Contents/MacOS/PureScience`）：

```
[ok  ] app_binary  command=/Applications/PureScience.app/Contents/MacOS/PureScience packaged=true
[warn] signature  state=adhoc gatekeeper=rejected detail=首次打开会被 Gatekeeper 拦下：…
```

- `gatekeeper=rejected` 是 `spctl` 自己的判决，不是我们推断的；
- 两句读数都带「下一步」文案（系统设置 → 隐私与安全性 → 仍要打开 / SmartScreen → 仍要运行），
  这段文案是安装流程的一部分，不是安慰话。

## 4 边界（没做，且不假装做了）

- **没有证书就没法「消除」拦截**：这一项能让用户看懂处境并继续，不能让系统认发布者。真正的 `ok`
  要等 G1 拍板后接入 Developer ID + 公证（macOS）与 Authenticode（Windows）。
- Notarization / stapling 未接：它们依赖 Developer ID，属于拍板后的那一段。
- 原位更新与 Homebrew tap（同属 G1）未开工。
