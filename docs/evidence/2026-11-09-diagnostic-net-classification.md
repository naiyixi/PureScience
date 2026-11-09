# 诊断行说不出「为什么失败」：Chromium 网络码被折叠成 `error`

- 日期：2026-11-09（自主执行器）
- 单元：`diagnosticErrorFields` 对 `net::ERR_*` 做**闭集分类**（只分类、绝不复制原文）
- 改动：`src/main/logger.ts`（+41 行）、`src/main/logger.test.ts`（+40 行）
- 产品行为：无 UI 变化；改变的是**失败行携带的分类词汇**

## 一 现场读数（真机日志，非合成）

运行中的开发实例（`~/Library/Logs/PureScience (DEV)/main.log`，最后写入 2026-11-09 11:38）里，
更新检查失败 6 次，全部只有这一行：

```json
{"level":"error","scope":"update","msg":"operation failed","data":{"strategy":"manifest","result":"error",
 "operation":"update-check","phase":"fetch-manifest","phases":"fetch-manifest=28ms","totalPhaseMs":28,
 "outcome":"failed","durationMs":565,"errorCategory":"error"}}
```

真实的成因在同一份日志里，但落在**另一条**、**另一层**的 warn 行上：

```json
{"level":"warn","scope":"http-request","msg":"req-9ac89ee3 https://github.com/…/version.json failed:
 net::ERR_NETWORK_CHANGED"}
```

⇒ 一次失败在日志里被拆成两处，其中操作级那一处**没有任何可归因信息**：
「网络中途换了」（可重试、用户侧原因）与「清单本身坏了」（我方要修）在它眼里完全同形。

同一形状在存储侧也出现过 40 次：`storage:ipc · available storage lookup failed · {"errorCategory":"not-found"}`
—— 分类只说了「没找到」，没说找的是什么。

## 二 为什么不能直接把 message 写进日志

`diagnosticErrorFields` 的契约（`src/main/logger.ts` 头注逐字写着）是**固定词汇**：
不得保留 provider 文案、请求数据、凭据、研究内容、栈与本地路径；数字码与标识符形状的系统码
「被分类而不是被复制」（`Raw numeric RPC codes and identifier-shaped system codes are classified
rather than copied`）。把 message 整段塞进去会直接破掉这条，而截断也不行 —— 截断后的路径仍是路径。

## 三 改法

在显式 `code` 判定之后、`name` 表之前插入一层：只在 message 的**前 400 字符**内匹配
`net::(ERR_[A-Z0-9_]{3,40})`，命中后只用**闭集表**给出分类，任何未见过的新码归入 `network`、
`ERR_CERT_*` 归入 `certificate`。message 本身一个字节都不进日志。

分类优先级保持不变：显式系统码（`ENOENT` / `EACCES` …）仍然先命中，网络分类只接管
「本来会落到 `error` / `object`」的那一支。

## 四 读数

| 环 | 读数 |
| --- | --- |
| 定向单测 `vitest run src/main/logger.test.ts src/main/diagnostics/operation.test.ts` | **2 文件 / 79 例 passed**，`EXIT=0` |
| `tsc --noEmit -p tsconfig.node.json --composite false` | 0 error，`NODE_EXIT=0` |
| `tsc --noEmit -p tsconfig.web.json --composite false` | 0 error，`WEB_EXIT=0` |
| `npx eslint --no-cache src/main/logger.ts src/main/logger.test.ts` | 0 error，`LINT_EXIT=0` |
| **真机日志回放**（把日志里那 6 个真实 `net::` 串喂给分类器） | `tokens=6 → [["network-changed",6]]`，无一例再落回 `error` |

回放脚本是一次性探针（跑完即删，未提交）；它读的是运行中应用**自己写下的**字符串，
不是构造的样例。

## 五 边界（不许读成更强）

- **用户看到的界面文案没有变化**：本单元只让失败行可归因，不新增「网络切换了，请重试」这类提示。
  要那种提示得同时动九语字典与状态机，属另一单元。
- **运行中的开发实例没有重启**：改动要在下一次启动/下一次 `build:e2e` 之后才会写进该实例的日志。
  因此本轮给出的是「分类器在真实记录上的回放」，不是「新日志行已经在磁盘上」。
- 未跑全量：改的是 `src/main/logger.ts` 的纯函数分支，已按定向簇 + 双 typecheck + lint 收口；
  全量留给推送后 CI 的两条车道。
- 工作区那棵**陈旧树**（Nov 4 起 5 天未提交，37 个文件有未落地改动）一个字节未碰；本轮在
  `origin/main` 的隔离工作树里做。那棵树里已有一份 `includeShape`（给未知对象补 `errorName`/`errorKeys`）
  的同族证据档，**本单元刻意没有复制它** —— 两份实现会漂移，且它只覆盖 `object` 分支，
  盖不到本次真机日志里的 `errorCategory:"error"`。
