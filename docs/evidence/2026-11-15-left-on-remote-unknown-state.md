# `left_on_remote` 的第三种状态：没枚举 ≠ 远端什么都没剩

日期：2026-11-15（执行器）
触发来源：`docs/plan-2026-10-03-next-queue-and-round-convention.md` §三百三十 §五 第 3 条（下一单元候选）。

## 一 缺口是什么

`JobResult.left_on_remote`（`src/shared/compute.ts`）原来只有一个形状：一个数组。空数组同时承担两件相反的事：

| 真实情况                                                                                     | 写进库的 `left_on_remote`                           | 读到的人以为 |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------ |
| 枚举过远端工作目录，确实一个文件都没留下                                                     | `'[]'`                                              | 远端是干净的 |
| 收割在枚举**之前**就停了（余量不足 / 卷读不出来 / 主机查不到 / SSH 解析失败 / 枚举本身失败） | `'[]'`（`2f7ac9bc` 之前那条跳过路径写的就是空数组） | 远端是干净的 |
| 收割还没开始                                                                                 | 列不存在                                            | 远端是干净的 |

于是**三个读者都在替一份没做过的检查担保**：

1. `ComputeService.getJobResult()` 是 agent 通过 `attach_job(id).result()` 拿到的那个对象 —— 它会**据此决定下一步**（`resources/skills/remote-compute-ssh/SKILL.md` 的「Chaining jobs via left_on_remote」一节就是教它这么用的）；
2. 面板 `FeaturedOutputs` 的「N 个留在远端」那一行（空数组时这一行根本不出现）；
3. `compute_done` 广播的 `JobSummary.left_on_remote_count = 0`。

这一条正是「**契约/投影里有了、生产里没有任何消费方**」的反面：消费方一直在，缺的是能表达「没看」的那一格。

## 二 改动

`src/shared/compute.ts`

- 新增 `LeftOnRemoteState = 'enumerated' | 'not-enumerated'`、`LeftOnRemoteEntry`、`LeftOnRemoteReading`，以及**单一读取器** `readLeftOnRemote(column)`：列缺席 / 列不是数组 / JSON 解析失败，三种都归 `not-enumerated`。
  - 关键判断：**解析失败不能读成空列表**。一个读不出内容的列没有任何资格支持「远端已检查且干净」这句话。
- `JobResult` 增加必填 `left_on_remote_state`（三个返回点全部接上：非终态、终态未收割、终态已收割）。
- `JobSummary` 增加可选 `left_on_remote_state`，并把 `left_on_remote_count` / `left_on_remote` 在 `not-enumerated` 时**置为缺席**（不是 `0` / `[]`）。

`src/main/compute/harvest-engine.ts`

- 五条早退路径（余量读不到 / 余量不足 / 主机查不到 / SSH 解析失败 / 枚举失败）写库由 `'[]'` 改成 **`null`**（列本身可为空，`job-repository.ts` 的 `leftOnRemote?: string | null` 早已支持）。
- 广播的 `JobSummary` 一并带上 `left_on_remote_state` 与 `harvest_error` —— 否则面板在收到广播的那一刻只能显示「未枚举」，而**原因要等下一次列表刷新**才出现。

`src/main/compute/job-notifier.ts` / `ipc.ts` / `compute-service.ts`

- 三处各自手写过的 `JSON.parse` + `catch` 全部换成 `readLeftOnRemote`（一份读取规则，三处消费）。`ComputeDonePayload` 的 `left_on_remote_count` / `left_on_remote` 改为可选、`left_on_remote_state` 必填。

`src/renderer/src/components/FeaturedOutputs.tsx` + 九语字典

- 新增一行 `jobDetail.leftOnRemoteNotEnumerated`（`data-testid="left-on-remote-not-enumerated"`），**只在 `state === 'not-enumerated'` 且确实有 `harvest_error` 时出现**：前者说明「没人看过」，后者说明「为什么没看」。没有失败原因的未枚举（例如收割还没开始）不弹这一行，免得对着一个从没打算读的工作目录反复提示。
- 同时保证「零」不会以另一种形式出现：`left_on_remote_count` 缺席时那一行数字芯片不渲染（用例钉住）。

`resources/skills/remote-compute-ssh/SKILL.md`

- agent 面文档同步：`result()` 的字段清单加 `left_on_remote_state`，并在「收割失败」与「串接作业」两处写明「`not-enumerated` 时空数组不代表远端是空的」。

## 三 门禁（本机实跑，2026-11-15 00:0x CST）

| 环                                                                                          | 读数                                                                               |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `npx vitest run src/main/compute --maxWorkers=2`                                            | **28 passed \| 1 skipped（29 files）**；**579 passed \| 5 skipped（584）**，exit 0 |
| `npx vitest run src/renderer/src/components/FeaturedOutputs.render.test.tsx --maxWorkers=1` | **6 passed**，exit 0                                                               |
| `npx vitest run src/renderer/src/i18n/translation-quality.test.ts`                          | **42 passed**，exit 0（zh 值不得等于 en 值、九文件齐平）                           |
| `npx tsc --noEmit -p tsconfig.node.json --composite false`                                  | exit 0                                                                             |
| `npx tsc --noEmit -p tsconfig.web.json --composite false`                                   | exit 0                                                                             |
| `npx eslint --no-cache`（本笔 20 个文件）                                                   | exit 0，0 problems                                                                 |
| `npx prettier --check`（同上）                                                              | 通过                                                                               |

与上一单元基线对照：`src/main/compute` 从 577 passed 涨到 579（新增两条：`ipc.test.ts`「枚举过但为空要报 0」、`compute-service.test.ts`「没枚举要报未知」）；另有 `harvest-engine.test.ts` 两条既有用例补上了状态断言、面板新增两条渲染用例。

## 四 用例里的一个假替身（被本单元撞出来，已修）

`harvest-engine.test.ts` 的 `makeJobRepo().update` 原来返回 `{ ...job, ...data }`——把 Prisma 命名（`harvestError` / `leftOnRemote`）直接铺到 `ComputeJob` 记录上。于是**读「更新后的 job」的任何断言都看到更新前的值**，这是一个「不可能让这条断言失败」的替身。本单元要断言的正是「广播里带的状态与原因」，所以把它改成按仓储真实的列名映射（`harvestError → harvest_error`、`leftOnRemote → left_on_remote`、`Date → epoch ms`）。这条替身不修，新加的三条状态断言全是假绿。

## 五 边界与具名未办

1. **没有窗口读数，本机也取不到**：真实安装的库 `~/.purescience-project/purescience.db` 里 `ComputeJob` **零行**（只读查询，见下），所以这个面板的任何状态都还没有被人用真数据看过一次。
   ```
   sqlite3 "file:$HOME/.purescience-project/purescience.db?mode=ro" "SELECT COUNT(*) FROM ComputeJob;"  → 0
   ```
   要造一行真实数据，得在**隔离根**里起动实例并种一行作业（`harvest_error` 非空 + `left_on_remote` 为 NULL），再读 `[data-testid="left-on-remote-not-enumerated"]`。本轮的条件：空闲页 4,306（≈67 MB）、swap 10.4/11.2 GB 已用 ⇒ 起 Electron 会把机器压到 thrash，按纪律不做窗口读数。**下一轮的配方已写死在计划档 §三百三十一 §五**。
2. **`not-enumerated` 且没有 `harvest_error` 的情形不上屏**：这是刻意的（收割还没开始的作业不该被提示「没列出」），代价是「作业终态 + 从未收割」这一支在面板上仍然沉默。它属既有行为，本笔不改。
3. **`left_on_remote` 的计数芯片语义未变**：枚举过且为空时仍然显示 0 —— 那时 0 是真的。
