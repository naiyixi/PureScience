# 设置页视觉基准刷新：`settings-general.png`（2026-10-15，执行器）

> 一句话：认证车道那条视觉红是**基准陈旧**（设置在导航里多了一项），刷新方式让**产品自己重画一遍**，
> 不用手改像素、不放宽容差、不遮蔽导航区。CI 的判决还没拿到 —— 见 §四。

## 一 起因（判据见另一份档）

`docs/evidence/2026-10-15-nightly-lint-red-and-stale-visual-baseline.md` §二：macos-arm64 构建作业里的
`npm run test:e2e:visual` 在 `631dfcae`（今天 14:11）与 `83036ef0` 上 failure（该图 4815 px，**重试仍红**），
而昨天 `74fb22fd` 的同一作业 **1 passed (8.2s)**；两次之间落进设置导航的正是 `2067c866`
（新增 `Goals and readings`），而基准最后一次更新是 **10-05**（`ecf8ef71`）。

## 二 怎么刷的（可复跑）

1. 隔离工作树，避免与在跑的执行体抢 `out/`：
   `git worktree add --detach /tmp/ps-visual 36426103` + `ln -sfn <主树>/node_modules /tmp/ps-visual/node_modules`。
2. `npm run build:e2e`（在该工作树里）⇒ **产物写进工作树自己的 `out/`**（复核读数：主树 `out/` 的 mtime
   仍是 16:06 未被触碰）。
3. `npx playwright test e2e/visual-regression.spec.ts --update-snapshots` ⇒ **真 Electron 真窗口**，
   真点开 `Settings` → `General`，按规格自己的遮蔽规则（App version 区、GitHub 链接）出图。
4. 复核（这一步才是读数）：**不带** `--update-snapshots` 再跑一次 ⇒
   `✓ 1 e2e/visual-regression.spec.ts:36:5 › keeps core desktop surfaces visually stable (4.6s)`、
   `1 passed (4.9s)`、`EXIT=0` ⇒ 同一份基准连跑两次逐像素一致（本机渲染是确定的，不是「改完就算过」）。

## 三 量出来的改动（不是推断）

| 项 | 读数 |
| --- | --- |
| 文件 | `e2e/visual-regression.spec.ts-snapshots/settings-general-darwin.png` |
| 旧 | `106546 B` ／ `sha256 5ec4ad35bf1903a2d806655d9687283ca5bf88f4b569b46f5e497c2d324f4777` |
| 新 | `107135 B` ／ `sha256 b8e4e30f253a1bd2eed55b859bdc210cb7fecdd498e020c23336600a09d93b9f` |
| 逐像素对账 | 两图都是 **1280×800**；差异 **22673 px（2.21%）**，**包围盒 x 161..339（宽 179）**、y 21..778；**26 条差异行带**，间距 ≈30 px（= 一行导航的高度） |
| 结论 | 差异**全部落在设置导航那一列**：页面正文区（x > 339）与顶栏（y < 21）**一个像素都没变**；形状与「导航多在中间插入一项 ⇒ 它之后的各行整体位移」相符（`SettingsPage.tsx` 里导航 label 共 24 条，含分组子项；26 条行带与该形状吻合，但**具体是哪些行未逐条解析**）—— 本条只断言「差异全在导航列」，不外推具体条目 |
| 其余三张基准 | `home-empty` / `project-create-dialog` / `workspace-empty` 刷新前后 **sha256 逐字符相同** ⇒ 本次只动了该动的那一张 |

对账用的是一个纯 Python 的 PNG 解压 + 逐像素比对脚本（本机没有 PIL），
放在 scratch：`~/.hermes/cache/scratch/png-diff-box.py`（用法：`python3 png-diff-box.py 旧.png 新.png`）。

## 四 未证到什么（不写成「已修绿」）

- CI 跑的是**打包态**、macos-14 runner；本机是**未打包**构建。这层差异历来存在 —— 昨日那份本机基准在 CI 上
  是绿的（`1 passed`）⇒ 说明「本机基准」这条路在 CI 上能落进 0.4% 阈值内；但**刷新后的这份**能否再次落进去，
  **只有下一次 macos-arm64 构建作业能给判决**。
- **判决已取（2026-10-15 17:54，本笔推送 `3bfb44fb` 的 Nightly）**：run `38709880842`、
  macos-arm64 构建作业 `116344530833`，该作业第 16 步 **`Run desktop visual regression` = completed / success**，
  日志原文 `1 passed (7.4s)`；同一作业第 14 步 `Run P0 Electron certification` = success（`95 passed (24.9m)`）；
  整个 run `completed / success`（Verify + 四平台构建 + publish 全 success），同笔 `Windows Full Test` = success。
- **仍具名未取的一格**：认证记录 JSON（`dist/certification-*.json`，落在 566 MB 的 `macos-arm64` 产物里）
  没有下载逐字核对；能确证的是**输入侧**：该作业日志把记录脚本里那条判据以已替换的形式印出
  （`if [ "success" = "success" ]; then`）与 `VISUAL_OUTCOME: success` ⇒ 该分支成立、记 `passed`。
  若要逐字核对，下一次可直接从该 run 的 `macos-arm64` 产物里取 `certification-*.json`。
- 因此本条的终态是：**本机读数（§二.4、§三）+ CI 判决（本节第二格）都已取到**。
  若将来同一张图再次红，先读它报的新差值与包围盒，再决定是「还有别的机器相关差异」还是「这次刷新漏了什么」，
  **不得**改阈值。

## 五 明确没有做的事（防被读成放宽）

- 没有改 `maxDiffPixelRatio`（仍是 darwin `0.004`）。
- 没有遮蔽导航区（`App version` 区与 GitHub 链接的既有遮蔽一字未动）。
- 没有改规格里任何一条断言；改的只有基准 PNG 一个文件。
