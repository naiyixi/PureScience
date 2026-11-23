# v2.33.5 的发布被 Windows 闸门挡在门口（不是构建红，是「连续三次真机读数」不够）

## 一句话

四件套与门禁都过了、main 已推、tag 已打；`Release preflight` 在 **`windows-gate-streak --need 3`** 这一步
判红（`0/3 (not yet)`），于是 `build` / `notarize-mac` / `publish` 全部 `skipped` —— **没有 Release 页、
没有资产**。按发版恢复规程（该 tag 没有页）删掉了 tag，等 Nightly 攒够三次绿再重建。

## 读数（现取）

| 项 | 读数 |
| --- | --- |
| 门禁（隔离工作树 @`fbfb3df4`） | `eslint --no-cache .` **0 error / 101 warning**；双 typecheck **0 error**；仓规五查 **OK**；全量 vitest **1519 文件 / 19,130 passed、8 例红（336.7 s）**，8 例全是基线红 |
| 那 8 例 | `Reference runtime DDL is missing Prisma columns: expected [ 'edition' ]` —— 共享 `node_modules` 的 Prisma client 由会话在制 schema 生成，提交里没有该列；CI 从提交里的 schema 生成 client，不存在这一态 |
| `Release preflight`（run `45165603890`） | 前两步 success（tag 与 `package.json` 版本一致、`git merge-base --is-ancestor` 通过），第三步 `windows gate streak: **0/3** (not yet)` |
| 闸门的 skip 明细 | `45165554938 — no windows job`（当时还没跑）、`45161879456 — job in_progress`、`45143965397 — reading=failed` |
| 随后状态 | `v2.33.5` tag 已删（本地+远程，没有 Release 页可丢）；tag 事件带起的 `macOS Upgrade Smoke`（`45165603871`）已取消 —— 它等的是「镜像供出 2.33.5」，而这一步只有 `publish` 之后才可能发生，所以那一趟只会在 240 分钟后红 |

## 为什么这道门现在过不去

`scripts/windows-gate-streak.mjs` 读 **Nightly 的 `Build windows-x64` 作业**打印的那行
`electron P0 reading: passed`，从最新往回数，遇到第一份非 passed 就 `break`。当前最新三行是：

```
45165554938 — no windows job（当时尚未开跑）
45161879456 — job in_progress
45143965397 — reading=failed      ← 在这里断开
```

`45143965397`（head `2f88dd77`）红的正是三条**打包态 P0 超时**用例，归因已落在
`docs/evidence/2026-11-23-p0-red-shifted-after-mirror.md`：镜像把运行时安装这条路真正走通之后，
一次安装要 **63.2 s**，而夹具的 MCP 预算 60 s、两条 spec 的 `setTimeout` 120 s / 180 s 装不下它。
修法在 `1a9d1c57`（`callTool` 15 分钟有界预算、两条 spec 600 s）。也就是说：**这道门不是新缺陷，它要求的
那三份读数正好是这个修复要证的东**。

## 这一轮怎么推进（三条 Nightly 并行取证）

Nightly 的并发组按**事件**分（`nightly-${{ github.event_name }}`），所以一次
`workflow_dispatch` 可以与 push 触发的那趟同时跑 —— 这正是该文件注释里写的用途
（「手动 dispatch 是唯一能让某一份 head 跑完并落定的方式，发版判据需要它」）：

| run | 事件 | head | 作用 |
| --- | --- | --- | --- |
| `45161879456` | push | `1a9d1c57` | 修复提交本体（与 tag 提交的差量只有发版四件套） |
| `45165554938` | push | `e89a79de` | tag 提交自己那趟 |
| `45166052550` | workflow_dispatch | `e89a79de` | 并行取证，避免再等一整轮 |

三份都绿 ⇒ 闸门 3/3，重建 tag 即走完整发布链路。**在此之前不再往 main 推任何东西**
（一次 push 会取消在跑的 push 那趟，等于自己把读数丢掉）。

## 边界（具名）

- **本文件写下的时刻，三趟都还没落定**：`windows P0 reading` 尚未取回，所以「修复有效」在这份记录里仍是
  **待证**，不是结论。
- 没有 Release 页 ⇒ v2.33.5 **尚未发布**；`package.json` 已是 2.33.5，而 Latest 页仍是 v2.33.4 ——
  这是「main 已带上版本号、页还没建」的正常中间态。
- `readiness` 闸门（macOS 演练）的**首份真样本随真正的发版一起**，本趟不会产生。
