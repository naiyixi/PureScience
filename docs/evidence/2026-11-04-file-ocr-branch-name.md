# 图片取字的认证规格：分支名与断言不同字，缺引擎那一支永远落进空框断言

- 日期：2026-11-04
- 提交：`046d09f4`（main，一处 spec 修改）
- 提交前状态：`origin/main = cf477225`，`Nightly` `41788542097` 的 `Build macos-arm64` 红

## 1. 车道给的那条红

`Nightly` `41788542097`（提交 `cf477225`）：

| 作业                                                 | 结论                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `build / Verify (lint + typecheck + test + package)` | success                                                                 |
| `build / Build windows-x64` / `linux-x64`            | success                                                                 |
| `build / Build macos-x64`                            | **failure**（`macos_smoke`：DMG 挂载后的成品 60 s 内没有宣告 web 端点） |
| `build / Build macos-arm64`                          | **failure**（认证规格 `e2e/certification/file-ocr.spec.ts:203`）        |

arm64 作业日志里规格自己打印的分支是：

```
[ocr-cert] tile=ready before the read
[ocr-cert] rendered=true branch=toolMissing dialog="Recognised text lab-scan.png × Reading images
needs the tesseract program. Install it (brew install tesseract) and try again."
```

即：**这台 runner 没有 tesseract，产品走的是「缺引擎」这一支，并且已经把具名原因写在对话框里** ——
产品行为正确。红在断言：spec 用 `Object.entries(outcomeNodes)` 的**键名**当分支名（`toolMissing`），
而 `switch` 一侧写的是 `'tool-missing'`，于是这一支掉进 `else`，去等 `file-ocr-empty`
（「recognised no characters」）—— 那个节点在缺引擎的对话框里根本不存在，20 s 后 `element(s) not found`。

同一份映射里 `packMissing` 与 `'packMissing'` 恰好同字，所以只有缺引擎这一支会踩到；
`unsupported`/`unreadable`/`empty`/`text` 也都同字。**这是「本地永远看不见」的那一类缺陷**：
本机有 tesseract，走的永远是 `text` 分支；只有没有引擎的车道才会进这一支。

## 2. 修法（一处 spec，不做产品改动）

`e2e/certification/file-ocr.spec.ts`：

- 映射的键改成与分支字面量**同一个拼写**（`'tool-missing'` / `'pack-missing'`），并加注释说明为什么两处必须同字；
- `visibleOutcomes()` 的返回类型收紧为 `OutcomeName[]`（`keyof typeof outcomeNodes`），分支不再是一个自由字符串；
- `if / else if` 链改成 `switch`，`default` 里写 `const unexpected: never = branch` ——
  **新增一个结果而不在断言里处理它，会先在这里编译不过**，这一类错不会再静默落到「空框」断言上。

没有改动产品代码：对话框文案、`data-testid`、`pdf:ocr` 通道、焦点归还都保持原样。

## 3. 本地读数（能做到的部分）

| 环                                                                                                                | 读数                                                                           |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 隔离工作树 `npx tsc --noEmit -p tsconfig.node.json --composite false`（`/tmp/ocr-fix-check` @ `cf477225` + 本笔） | **0 error**，exit 0                                                            |
| `npx eslint --no-cache e2e/certification/file-ocr.spec.ts`                                                        | **0 problem**，exit 0                                                          |
| `bash scripts/pre-push-checks.sh`（提交后）                                                                       | 全部通过（品牌零命中 / 双语 README 一致 / 60 入口可解析 / 本笔 1 文件 lint 0） |

**未取到的真机读数（具名，不当成通过）**：本机 `vm_stat` 空闲页 4,182（约 65 MB）、
`swap used = 6,854 MB / 8,192 MB`，同机还有一条在跑的 dev 实例与会话；此时 `npm run build:e2e` +
Electron 真机跑会与它抢 `out/` 并把机器拖进换页 ⇒ 本笔**没有**在本机重跑这支 spec。
缺引擎这一支的真机读数只能由**没有 tesseract 的车道**给：`046d09f4` 的 `Build macos-arm64`
就是那个环境，判决以它为准（日志里应出现 `branch=tool-missing` 且该作业转绿）。

## 4. macos-x64 的 smoke 超时：同提交另一架构绿 ⇒ 先按机器侧/抖动记

同一次运行里 `Build macos-arm64` 的成品 smoke **通过**（`macOS DMG and ZIP launch smoke completed
successfully.`，19 s），而 x64 在 60 s 预算内没有等到 web 端点；日志显示应用起得来
（`application-startup` → `load-bootstrap-modules` 2,299 ms → `single-instance-lock` 2,361 ms →
`prepare-runtime` 2,364 ms → `load-application-modules` 2,367 ms）之后就没有再打印阶段。
上一笔 `20746bcf` 的 x64 smoke 是 success。

**归属**：同一棵树、另一台 runner（arm64）通过 ⇒ 不是产品逻辑的普遍回归；判据是下一次推送的
x64 作业是否转绿（零代码改动）。本笔**不**改超时、不改 smoke 判据 —— 那会把一条真实信号调小。
