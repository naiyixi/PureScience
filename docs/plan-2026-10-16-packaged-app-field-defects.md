# 打包版真机 7 天缺陷审计与排期（P1–P5）

> 方法：对**已安装的打包版**（`/Applications/PureScience.app`，v2.5.0）的真实数据根 `~/.purescience` 做只读挖掘，
> 覆盖 `sessions/<project>/<session>.json` 里 **近 7 天**（28 份会话 / 3883 条完成活动）的**问题活动 126 条**
> （`status=failed` 108 + `error` 18，跨 20 个会话）。按**签名频次**排序，先修最密的一类。
> 读数均为脚本聚合产出（`/tmp/mine-sessions5.py` 口径：`session.conversationGraph.activities[]` 里
> `status ∈ {failed,error}`，按 `providerToolName` 与 `rawOutput` 首行归一化签名分组）。

## 一 真机读数（近 7 天，打包版）

| 序     | 频次    | 症状（真机原话摘）                                                                                                                                                                       | 性质                                                                                                                                |
| ------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | **42**  | `plan.update_step_status` 被状态机拒：`dependency-not-satisfied` 26 + `invalid-transition` 16                                                                                            | agent 与状态机的接口摩擦：**最常见的动作（未标 in_progress 直接报 completed）被拒**，且依赖拒答只列「没完成的」、不说**先做哪一步** |
| **P2** | **~27** | `No such tool available: mcp__purescience_plan__update_step_status`（pdf / figure / notebook 同样中招；`purescience_plan` 与 `purescience-plan` 两种**服务名拼法**并存）                 | 工具名契约不一致 ⇒ 模型有一半概率喊错名字，整类工具面间歇不可用                                                                     |
| **P3** | 7       | `Artifact RPC capability is not valid for this turn: it was issued for an earlier turn (or already spent).`                                                                              | 按回合的能力令牌过期，且**不给下一步**（模型只能原样重试）                                                                          |
| **P4** | 2+3     | 路径守卫把「项目文件夹」写成**数据根** `/Users/totota/.purescience`；另有 3 次 `File does not exist. Note: your current working directory is /Users/totota/.purescience/workspaces/<id>` | **错提示**：把数据根当项目范围 ⇒ agent 去错地方找文件，白费回合                                                                     |
| **P5** | 7+4     | `Socket is closed`（WebFetch）×7、`Proxy connection ended before receiving CONNECT response` ×4                                                                                          | 传输层：**本机确有代理环境**，而主进程取数不走代理（本轮已修，见下）                                                                |

## 二 本轮已落

1. **P1 的一半（纯增益）**：依赖拒答现在**点名先做哪一步** —— `start with "X" first`（此前只列「未完成的步骤/阶段」，
   模型仍需自己挑，实测它随后原样重试）。`plan-service` 三文件 **50 passed**。
2. **P5 的主干（另案，已提交）**：`fix(net)` —— 主进程取数补齐**会话代理**、权重下载改走 **Chromium 栈**、失败具名可操作。

## 三 排期（按此序，每条带验收）

- **P1（状态机）**：允许「未开始 ⇒ completed」，**仍走同一道依赖闸**（所以「完成」不能插队）。
  验收：新用例钉住「未开始直接完成 ⇒ 成功」+「依赖未满足 ⇒ 仍被具名拒答（含 `start with … first`）」+ 既有
  「从终态再改 / in_progress 跳 skipped 的拒绝句点名可改什么」全绿。**注意**：`allowedStepStatuses`、转移表与
  既有 fixture 的**阶段/依赖状态**要一起读清（本轮我按猜改用例被 fixture 当场否掉，已缩回，不把红留在树上）。
- **P2 已落一半**：能力挂载不再取决于拼法（`session-capability-owner` 里 13 处相等比较改为两侧归一化后比，
  `src/main/acp` 88 文件 / 1425 passed）。这一半修的正是分析器诊断为「名字就是今天渲染的那个」的 12/28。
- **P2 剩下的一半 = 一条门的盲区 + 8 个服务的改名**（本轮读源读到的锋利形状）：
  - 仓内**已有**这条门：`app-mcp-names.test.ts` 的 `keeps every app-owned MCP server name separator-free`，
    注释逐字写着真机失败（「一个框架把连字符折成一个下划线、另一个折两个 ⇒ agent 拿到同一工具的两个可调用名
    并猜错，真机日志里就有只差分隔符的失败调用」）。
  - **但这条门只检查 `appMcpToolIdentities()`（目录里那六个）与 `FIGURE_MCP_SERVER_NAME`**，而全仓**另有 9 个
    应用自有服务**没进目录：`purescience-pdf` / `purescience_figure` / `purescience-endpoints` /
    `purescience-goal` / `purescience-annotations` / `purescience-context-summary` / `purescience-host-query` /
    `purescience-routine` / `purescience-reviewer`（前八个**带连字符**）⇒ **门看不见它们**，也就一直没红。
  - 我试着把这 9 个补进目录（规范名沿用今天注册的名字，保证投影不变），当场被两条门挡住：① 名字必须无分隔符；
    ② 目录必须与**记忆权限目录**（remembered-permission catalog）对齐。⇒ 正确解法**不是补录带连字符的名字**，
    而是**把这 8 个服务改成无分隔符名**：改 `src/shared/*.ts` 里的常量、在目录里登记、旧拼法进 `legacyNames`
    （让早先按旧名写的授予/配置仍解析到同一身份）、两个目录同步、并更新钉住旧名的用例与证据档。
  - **验收**：门先把**全部**应用自有服务枚举进来（而不是只枚举目录内六个）—— 它会**当场红**，那一片红就是
    这件工作的清单；改完必须全绿，且 `scripts/audit-mcp-tool-name-failures.mjs` 对打包版日志的分类里
    `wrong-separator` 与 `not-app-server` 归零。
    - ✅ **已交付（执行器，2026-10-17，与本台账 §一百七十七 同一笔）**：8 个常量改名（`purescience-pdf` → `purescience_pdf` 等）、
    其中 **7 个进命名目录 + 记住的权限目录**（`mcp_tool` 18→44、总数 35→61），**reviewer 有意不进目录**（内部身份不许被记住）；
    守卫改成**枚举全部 15 个应用自有服务常量并钉住 15**（少一个就红），并反向断言 figure / reviewer 必须留在目录之外；
    审计脚本把 reviewer 并入 `identities`；`reviewer-session-owner.ts` 的「恰好一台自有 reviewer 服务器」校验改为
    **两种拼写都折到规范名再比**（否则改名会把旧连字符配置判死），已记录标题的识别也补齐旧拼写。
    **验收读数（同一批真机日志、同一口径、只读）**：`callable-now` **12 → 19**（新增 `pdf_open` ×6 与 `endpoint_list` ×1，
    改前它们落在 `not-app-server`），`not-app-server` **9 → 2**，`wrong-separator` 1、`no-such-leaf` 6 不变，失败行 28 条同一窗口。
    **`wrong-separator` 归零仍等一段新窗口**（改动跑到用户机器之后产生的日志），不在本笔声称。
    证据档：`docs/evidence/2026-10-11-app-mcp-server-name-consistency.md` §八（其中 §四.5「reviewer 有意不改」由本笔就地取代，理由写在那里）。
- **P3 —— 核实后结案：早已修好，不立为工作**。按仓规「立未办之前先在仓里核实」：那句旧文案
  （`it was issued for an earlier turn (or already spent)`）出自更早的构建，而**当前树里已经是修好的形态** ——
  `fix(artifacts): P0-7 产物能力令牌的生命周期跟着回合走 —— 回合还开着时续期而不是拒绝`（`67bba067`），
  文案改为「…不在任何**活着的回合**上注册…**用同一张令牌重试不可能成功** —— 停止重试，请让用户发一条新消息」，
  并且**能力本身**改成「回合还开着就续期」。证据：`git log -S` 两处文案，`67bba067` **含在 v2.4.0 与 v2.5.0 里**。
  ⇒ 那 7 条字段失败来自**更早版本**跑出的回合，不构成本版待办；**若在新构建上仍复现**（判据：同一会话里出现
  「不在任何活着的回合上注册」这句），再按新读数立案。
- **P4（路径守卫提示）**：守卫的 `hint` 必须指向**它实际强制的那一个范围根**（现在指向数据根），并把
  「项目文件夹」与「会话工作目录」两个概念分开写；验收 = 真机一条越界调用，拒答里的路径与实际 scope 逐字符相同。
- **P5（传输）**：`WebFetch` 的 `Socket is closed` 属 agent 侧取数；与主进程代理修复同源，代理可用性要能被
  **一条探针**读到（而不是等用户点下载才发现）。

## 四 边界（不许读成更强）

- 本审计**只覆盖** `sessions/**` 的活动记录；DB（140 MB）与日志里的失败模式**未纳入**本轮口径（下一步可加）。
- 频次来自**单个用户的 7 天**数据（20 个会话），不是全量统计；P1/P2 的绝对数会随用法漂移，但**类别**可信。
- P4 的两条是**提示错误**（错误地把数据根说成项目范围），不改变守卫本身的拒绝行为。
