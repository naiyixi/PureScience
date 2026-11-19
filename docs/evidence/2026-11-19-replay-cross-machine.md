# 4.1 跨机重放：记录在 macOS 封存，在干净的 Linux runner 上重跑（2026-11-19）

## 验的是什么

排期 4.1 的判据是「**同一份记录在干净机器重放成功**」。这条判据的核心不是「结果对不对」，而是
「记录本身够不够把一次运行搬到另一台机器上重来」——所以必须真的换一台机器，本机重跑不作数。

上一轮我给这一条标了 UNVERIFIED 并立案到 v3.5，理由是缺机器不缺口实现。这一轮把机器补上了：
用 CI 的干净 runner 当第二台机器。

## 仪器

| 环节           | 机器                                                 | 解释器 / 运行时                 |
| -------------- | ---------------------------------------------------- | ------------------------------- |
| 封存（record） | macOS 26 arm64（开发机）                             | Python **3.9.6**                |
| 重放（replay） | Ubuntu **linux-x64**（GitHub 托管 runner，干净实例） | Python **3.14.4**、Node 22.23.5 |

两端都不是同一台机器、不是同一架构、**不是同一个 Python 大版本**。重放侧不读开发机的任何副本：
输入字节从记录里 base64 还原，先复算 digest 对得上才允许执行。

## 判定用的是产品自己的代码

`scripts/verify/replay-cross-machine.mjs` 不自己写比较逻辑，只做三件事：重建输入、跑分析、
把输出 digest 交给 `compareReplayOutputs`（`src/shared/replay-verification.ts`，也就是应用内重放用的
同一个函数、同一个 `SealedRecipe` 形状）。判定词也来自产品：`reproduced` / `differs` / `unverifiable`。

## 读数（run `44523950998`，结论 success）

| 项           | 读数                                                   |
| ------------ | ------------------------------------------------------ |
| 重放平台     | `linux-x64`（记录侧 `darwin-arm64`）                   |
| 重放解释器   | `Python 3.14.4`（记录里写的是 `python3 3.9.6`）        |
| 判定         | **`reproduced`**                                       |
| 逐文件       | `summary.csv` → `match`；`counts.json` → `match`       |
| **反向对照** | 把一个输出的 digest 改掉 → **`differs`**（附具名原因） |

反向对照是这条演练的硬要求：只报「一致」而证明不了「能分辨不一致」，判据就是恒真的，等于没判。

## 记录里到底有什么

`docs/evidence/replay-recipes/mean-summary.json`（随仓库走，重放侧只依赖它）：

- `origin: "executed"`——不是模型重建的步骤，按产品的类型规则才允许被重跑；
- `inputs`：`analysis.py` 与 `measurements.csv` 的**字节本身**（base64）+ digest + 长度，所以记录
  自足，不需要外部副本；
- `outputs`：只存 digest 与长度，不存输出内容——重放的价值在于重新算一遍；
- `environmentLockRef: "python3 3.9.6"`——记的是真解释器版本，不是「system」。

## 边界（不许读成更强）

1. 重放的是**一段被封存的分析**（固定输入 → 定长小数 CSV + 定长 JSON），不是应用里一次完整的
   notebook 会话在 CI 上重跑。后者需要把 Electron 应用装进 runner、带 kernel 起会话，本轮没做。
2. 字节一致而解释器从 3.9.6 跨到 3.14.4，说明**这段分析的输出不依赖那次环境**；不能读成
   「环境也一致」。产品的重放报告同样把这两件事分开说（`ReplayEnvironmentComparison` 五态）。
3. 只跑了 Linux x64 一个重放平台。Windows 侧的同一演练需要把 `python3` 换成 `python`（runner 的
   命令名不同），未做，是下一步的小活。
4. 演练脚本是 `.mjs`（`node --experimental-strip-types` 直接吃共享 TS 模块），没进产品打包物。

## 复现

```bash
# 开发机封存（会重写 docs/evidence/replay-recipes/mean-summary.json）
node --experimental-strip-types scripts/verify/replay-cross-machine.mjs record
# 任意机器重放并判定（退出码 0 = reproduced 且反向对照 differs）
node --experimental-strip-types scripts/verify/replay-cross-machine.mjs replay
```

CI 上由 `.github/workflows/replay-cross-machine.yml` 在 `replay-verification.ts`、演练脚本、
fixture、recipe 任一变动时自动跑，读数作为 artifact `replay-reading` 留存。
