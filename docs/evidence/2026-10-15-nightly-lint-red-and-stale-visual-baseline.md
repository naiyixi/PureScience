# Nightly 两条红的定因：eslint 的 1 个 error + 认证车道的陈旧视觉基准（2026-10-15，执行器）

> 结论先写：红 1 是**真红**（我改了产品树里的一个字节：`let`→`const`，属工具门禁的语法要求，不是放宽断言）；
> 红 2 是**基准陈旧**（UI 真变了、基准没跟着刷新），不是产品缺陷，也不许靠放宽容差收口。
> 本条只写读到的原文与判据；没验到的部分在 §四 具名。

## 一 红 1：Nightly `build / Verify (lint + typecheck + test + package)` 的 eslint error

| 项 | 读数 |
| --- | --- |
| 车道/作业 | `Nightly` run `38703077283`，提交 `83036ef0`（当时 main 的 HEAD），job `116315847727`（`build / Verify …`）= **failure** |
| 作业级日志原文 | `✖ 131 problems (1 error, 130 warnings)` ⇒ `##[error]Process completed with exit code 1.` |
| 唯一 error | `e2e/goals-panel.spec.ts:35:7  error  'page' is never reassigned. Use 'const' instead  prefer-const` |
| 下游 | 同一 run 的 `build / Build …` 与 `publish` 全 **skipped**（Verify 红 ⇒ 打包与发布都不起） |

**这条走红的时间线**（都是 `gh run list --workflow=Nightly` 的真实读数）：

| 提交 | 时间 | Nightly | 说明 |
| --- | --- | --- | --- |
| `631dfcae` | 14:11 | success | `e2e/goals-panel.spec.ts` 还不存在 ⇒ Verify 绿 |
| `f12f9896` | 15:46 | failure | 该文件已入库（`0c64c888` 建、`49d1be82` 加重启断言）⇒ 同一处开始红 |
| `83036ef0` | 16:04 | failure | 同一个 error（本条定因） |

**为什么另一条车道一直绿**：`Windows Full Test` 在同一批提交上全绿（`83136…`/`83036ef0` 两次都 success）——
它**不跑全仓 eslint**。所以「某条车道绿」在这件事上给不出任何保证；这条正是本仓常驻纪律的又一实证：
门禁要按**它自己的口径**核，不能拿别的车道的绿替它。

**修法**（本批复核）：`e2e/goals-panel.spec.ts:35` 的 `let page` 改为 `const page`。
该变量在同一个用例里确实从未被重新赋值 —— 重启那一步用的是另一个常量（`const relaunched = await app.restart()`），
`page` 在它之前最后一次使用是「真点一次 `Refresh goals`」，之后不再出现。

**本地按 CI 口径复跑**（`npx eslint --no-cache .`，全仓、无缓存）：**0 error / 144 warning，`ESLINT_EXIT=0`**。
warning 条数（144）高于 CI 的 130，原因可解释且已核对：这一次本地跑**带着会话当时未提交的在制品**
（`src/main/specialist/**`、九份 i18n、`SpecialistsPanel.tsx` 等 19 个路径），那些文件各自的 prettier 漂移也在计数里；
**error 数为 0 才是本笔要证的判据**（CI 只按 error 判红）。

## 二 红 2：认证车道的视觉基准陈旧（`settings-general.png`）

| 项 | 读数 |
| --- | --- |
| 步 | macos-arm64 构建作业里的 `npm run test:e2e:visual`（`playwright test e2e/visual-regression.spec.ts`） |
| 上次绿 | `74fb22fd`（昨天 21:35Z，run `38641465149`）：**1 passed (8.2s)** |
| 本次红 | `631dfcae`（run `38690946464`）与 `83036ef0`（run `38703077283`）：`1 failed` |
| 失败原文 | `expect(page).toHaveScreenshot(expected) failed` / `4815 pixels (ratio 0.01 of all image pixels) are different.` / `Snapshot: settings-general.png`；**重试 #1 仍红**（不是抖动） |
| 阈值 | 该图 `maxDiffPixelRatio = 0.004`（darwin）⇒ 1% 远超它 |

**定因**：`2067c866`（v2.4.0 F3 上屏）在**设置导航**里新增了一项 `Goals and readings`。
而视觉规格截的是**整页**（`Settings` 对话框在屏，导航栏就在图里），
基准文件 `e2e/visual-regression.spec.ts-snapshots/settings-general-darwin.png` 的最后一次更新是 **10-05**（`ecf8ef71`）
⇒ **基准比 UI 旧**，多出来的一行导航条目正好是这 1%。两次读数（上次绿 / 本次红）之间，
落在该页面上的改动只有这一处。

**诚实性附注（别把日志里的回显读成判决）**：认证记录里这一步被如实写成 `visual_regression=not-applicable`
—— 脚本是 `if [ "failure" = "success" ]; then visual_regression=passed; fi`，条件为假 ⇒ 赋值没有执行；
日志里那行 `visual_regression=passed` 是 **bash `set -x` 回显的分支体**，不是结果。
（同一份日志里 `electron_p0=passed` / `package_smoke=passed` 是真执行的。）所以这条**不能**被引用成「视觉回归通过」。

## 三 处置

1. **红 1**：已改（见 §一），与本文一并提交。
2. **红 2**：按仓内既有先例（`0a6362be`「regenerate the two stale darwin baselines, and say why rather than just doing it」）
   刷新该基准，**不放宽 `maxDiffPixelRatio`**、也不遮蔽导航区。刷新读数与复核记录：
   `docs/evidence/2026-10-15-visual-baseline-refresh.md`（若该文件不存在，说明刷新那一步在本轮没有跑成，
   §四 会写明内存闸门的具体读数与配方 —— 不许把未跑成写成已修）。

## 四 未取证 / 未复核（具名，不写成 0）

- 刷新后的基准**能否在 CI 的 macos-14 runner 上通过**，只能由下一次 macos-arm64 构建作业给出判决；
  本机刷新只证明「本机同一份代码跑同一张图是自己一致的」。
- 本机内存闸门（取证时刻的真实读数）：空闲物理页 **4154 ≈ 65 MB**、`vm.swapusage` 已用 **6627.94 M / 7168.00 M**。
  占位者按 RSS 排序：`eslint`（本次门禁，约 0.6 GB）、Hermes 桌面进程、Bitz Net 等长期驻留应用。
