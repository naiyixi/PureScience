# 启动归因收口：没有「未归因的 400–500 ms」了

2026-10-26，两次冷启动的完整分段（`performance.now()` 同一时钟，打包版）：

| 分段 | 第一次 | 第二次 |
|---|---|---|
| `register-start` | 1646 | 1569 |
| `composition-start` | +3 | +2 |
| **`after-timed-steps`（12 个已计时的 compose 步骤）** | **+516** | **+412** |
| MCP client manager + agent runtime | +12 | +15 |
| screening model | +57 | — |
| code reconstruction / 权限授权投影 / settings / session / runtime-selection / office-preview / notebook-env / storage / artifact / conversation-export / remote-structure / search-evidence / reviewer / auto-review / electron-sender / command-dependencies / shutdown / command-composition / subagent | 合计 **+10** | 合计 **+9** |
| surface 安装 + 收尾 | +11 | +13 |
| **`runtime-composed`（= registerIpcHandlers 结束）** | **2256（610 ms）** | **2086（517 ms）** |

## 结论

`registerIpcHandlers` 的 517–610 ms 里，**412–516 ms 就是已计时的 compose 步骤本身**——每一项都有自己的名字
和读数（`open-project-db`、`specialist-skill-catalog`、`load-probe-answers` 等，见各自的 bench 文档）。
剩下约 100 ms 分散在十几个已具名的构造点上，每个 0–11 ms。

所以先前记在案上的「剩余 400–500 ms 尚未归因到具体构造」**不成立**：不是有暗块，而是那 400–500 ms 本来就是
compose 步骤，只是它的汇总行（`compose runtime steps`）把步骤之间的空隙排除在外，看起来像差额。

## 附带说明：为什么不能用 `startup timeline` 的 phase 差值反推

`phase()` 与 `compositionStage()` 用的不是同一个零点（同一次启动里 `ipc-handlers-registered=1876` 而
`runtime-composed=2256`）。比较相位差只能看趋势，精确归属要用同一时钟的分段行。
