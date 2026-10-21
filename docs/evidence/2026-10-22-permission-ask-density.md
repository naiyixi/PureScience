# 审批询问密度：渲染层自己的计数（P0-9）

日期：2026-10-22 · 单元：P0-9 的「用户可见密度」那一半 · 提交范围：渲染层计数 + 卡片读数 + 一条负载敏感用例的收口

## 1 为什么这条读数只能来自渲染层

主进程的 `permission request received` 记的是**收到的请求**，不是**呈现在读者面前的卡**：

- 自动选项与已记忆的授权都在 broker 内部结清（`requestPermission` 先 `resolveCurrentAutomaticPermission`，
  再问 grant registry，都落空才 `enqueuePermissionRequest`），这些请求**从来没到达窗口**；
- 复查会话自己那一族更极端：`resolveReviewerPermission` 在 `info` 级记一条「approving scope-bounded
  reviewer MCP tool call」就把事办了，读者一次都没被打断。

所以按日志数出来的「9 天 2,128 次」在 2026-10 已被就地更正为**应用自己批准**（96% 是复查会话的 MCP 工具，
其中 `query_execution_log` 一项 1,254 次；同一 `toolCallId` 上 `+0.00 s` 就跟着一条自动批准）。
真正「用户被问了几次」，只有**卡**能回答 —— 这就是本单元落在渲染层的原因，不是实现偏好。

## 2 交付

| 位置 | 改动 |
|---|---|
| `src/renderer/src/lib/permission-ask-ledger.ts`（新） | 每会话一本账：按 `requestId` 去重记「这张卡被渲染过」，按工具身份数「同类重复」。`usePermissionAskSummary` 走 `useSyncExternalStore`，快照对象在计数变化前保持同一引用（否则消费者会自喂重渲染）。账本只活在渲染进程内存里，重启归零 —— 读数是**本会话**读数，不是历史记录 |
| `src/renderer/src/pages/workspace/PermissionApprovalControls.tsx` | 在**渲染那张卡的组件里**记账（`requests[0]` 才是真正上屏的那一张，排队的后一张变成第一张时才记）；卡片头部下方一条读数：本会话问了 `N` 次，其中 `M` 次是同一工具的重复询问。**第一张不显示**（第一次的计数不含信息） |
| 9 个语言文件 | `ws.permissionAsksCount` / `ws.permissionAsksRepeat` 两个键 × 9 语，插值留在组件内（`.replace('{count}', …)`，与 `permissionBatchSiblings` 同口径） |
| `src/main/notebook/provisioner-runtime.test.ts` | 见 §5：那条负载敏感用例的收口（与本单元同一批修掉，单独一笔提交） |

**判据为什么是「同类重复」而不是「本可自动批准」**：broker 在**问之前**就会用已记忆的授权结清请求，所以
「被问的那一刻是否已有授权」几乎恒为 0（那不是覆盖率，那是一句空话）。同一工具在本会话里被**第二次**问，
才是真能省下来的那部分 —— 第一次选「本会话」就免掉了后面每一次。文案不说「本可自动」，只说「同一工具的
重复询问」，因为同工具不同命令的风险等级确实可能不同。

## 3 读数（全部实跑）

| 环 | 读数 |
|---|---|
| 账本单测 `src/renderer/src/lib/permission-ask-ledger.test.ts` | **12 passed**（身份优先级、无身份不判重复、去重、重复计数、会话隔离、快照引用稳定、冻结、订阅只在新卡时通知、reset、64 会话上界） |
| 渲染单测 `PermissionApprovalControls.ask-density.render.test.tsx` | **4 passed**（第一张安静 / 第二张报数与重复数 / 同一张反复渲染不膨胀 / 换工具时不出现重复子句）；走**真 `LanguageProvider`（zh）**，断言的是读者读到的字 |
| 同族 7 文件簇 | **7 files / 100 passed**（i18n 渲染、交互、notebook 风险、专家删除、翻译质量门、账本、密度渲染） |
| 双 typecheck（`--composite false`，堆 8192） | node **0** / web **0** |
| `eslint --no-cache`（本笔 14 文件） | **0 error**；本笔自己引入的 4 条 prettier warning 已 `--write` 修掉，复跑干净 |

### 变异证明（断言不是「现在是绿的」）

| 变异 | 结果 |
|---|---|
| 把显示阈值 `askSummary.asked > 1` 改成 `> 0` | 只红「第一张安静」一条 |
| 把重复子句的条件改成恒真 | 只红「换工具时不出现重复子句」一条 |

## 4 边界（不许读成更强）

1. **真机窗口读数未取**：内存闸门（开工现取：空闲页 4,208 ≈ **67 MB**、`swap used 11,601.5 MB / 13,312 MB`）。
   判据写死：解封后 `npm run build:e2e` → 让 agent 连问同一工具两次 → 第二张卡上出现
   `data-testid="permission-ask-density"` 且文案为「本会话已询问 2 次 · 其中 1 次是同一工具的重复询问」。
   **在此之前不声称任何真窗口读数**；jsdom 渲染证明的是「同一份组件在两个语言下读到的字」，不是窗口。
2. **只数卡，不数决定**：被取消、被 profile 切换结清的卡也计入（读者确实看过一眼）。「用户按了几次允许」不是这条读数。
3. **身份来自 `mcpIdentity` / `providerToolName` / `toolKind`，不猜标题**：没有这三样的请求照常计入「问了几次」，
   但**永远不算重复** —— 用 provider 写的标题当身份会制造从未发生的重复。
4. **账本不持久化**：重启归零；跨会话不汇总（要跨会话就得先定「什么算一次」的历史口径，属另一个单元）。
5. **只覆盖渲染层能看到的卡**：应用自有批准（专家删除一类 `requestAppApproval`）走同一面，因此一并计入。

## 5 同批修掉的一条负载敏感用例（不是本单元，但它让全量每次挂一条）

`src/main/notebook/provisioner-runtime.test.ts > attaches structured offline-create diagnostics to a timeout`
把「子进程完成 node 启动并写出 stdout」塞进 **200 ms** 预算，满载时必然读到空 `stdoutTail` ⇒ 红在机器上、
不在代码里（上一轮全量 17,600 例里唯一那条红，单文件 isolation 3/3 绿）。

改法：预算提取为具名常量 `TIMEOUT_PROBE_BUDGET_MS = 1_500`（文档写清它**是启动预算、不是超时口径**），
并**加强**断言：`durationMs >= 预算 − 50`，即「是预算结束了这次调用，不是子进程自己退出」—— 加预算的同时把
「谁让它结束」钉住。另一条同族用例（stderr 那一支）同步改用同一常量。

| 读数 | 结果 |
|---|---|
| 单文件 isolation ×3 | **19 passed × 3**，exit 0 |
| 变异：把期望的 `stdoutTail` 改成 `'MUTATED-token'` | **1 failed**（`- "stdoutTail": "MUTATED-token"` / `+ … "timeout-stdout-token"`）⇒ 断言在读真值 |
