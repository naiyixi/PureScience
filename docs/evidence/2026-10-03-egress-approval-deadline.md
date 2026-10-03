# egress 审批「到点自动拒」：主进程侧补上真实用例（V8 一半）

> 日期：2026-10-03。依据 `docs/plan-2026-10-03-v1.81.0-queue.md` 的 **V8**：
> 「真窗口等满 60s：卡片**自动撤**、应答失败不再静默」。

## 0. 先摆事实：这条分支此前**两侧都没有测试**

- 主进程 `EgressProxy.requireApproval` 的到期分支（`setTimeout(..., APPROVAL_TIMEOUT_MS)` → `onDenied()`）：
  `src/main/net/egress.test.ts` 里 4 条审批用例**全都显式决定**（allow_once / deny / 无 handler / deny 列表优先），
  **没有一条**让"用户一直不回答"这条路走完。
- 渲染器侧的撤卡（`WorkspacePage.tsx:1207-1225` 的 `setTimeout(expiresInSec * 1000) → dropEgressApproval`）：
  也没有测试（`EgressApprovalCard.render.test.tsx` 只渲染卡片本身，撤卡是父组件的 effect）。
- 也就是说：老账写的「修复已完成（到点自动撤卡 + 应答失败不再静默）」在**两侧都无任何验证**——
  修复存在，但没有任何东西拦住它回退。

## 1. 本轮做了什么（主进程侧）

- **生产改动（小）**：`EgressProxy` 增加可注入的审批预算
  `constructor(options: { approvalTimeoutMs?: number } = {})`，默认仍 `APPROVAL_TIMEOUT_MS = 60_000`。
  体例照 `TimeoutController` 的 `hardGraceMs?` / `startupGraceMs?`：**被测量的是这段等待本身**，
  一个必须真睡一分钟才能证明的测试只会被跳过或变脆。生产调用点 `egress-runtime.ts:107` 不传参，行为不变。
  `expiresInSec` 也改为由同一字段导出，**卡片的倒计时与代理的真实死线是同一个数**（不会各写一份而漂移）。
- **新用例**（`egress.test.ts`，真实 I/O、真实计时器、80ms 预算）：
  1. **不回答 ⇒ 到点即拒**：被挂起的请求在死线处拿到 **403**（不再挂到进程级超时）。
  2. **卡片的数字就是代理的死线**：`seen` 读到 `expiresInSec: 0.08`，与注入值同源。
  3. **迟到的决定不复活请求**：死线之后 `allow_once` 抵达 ⇒ 对端**一次都没被访问**（`peerHits === 0`），
     这正是"应答失败不再静默"要保证的那件事——请求已经结束，决定必须被当作迟到处理而不是默默吞掉。

读数：`npx vitest run src/main/net/egress.test.ts` → **25 passed（392ms）**（含新增 1 例）。
若把到期那段去掉，第 1 条断言会挂到测试超时——即这条用例真的在守这段分支。

## 2. 还没取到的（具名，不含糊）

- **渲染器侧撤卡**：未测。原因具名——撤卡逻辑在 `WorkspacePage` 的一个 `useEffect` 里（`dropEgressApproval`
  不是独立可测单元），要覆盖它需要一次 WorkspacePage 级渲染；本轮未做。
  建议做法：要么把"按 `expiresInSec` 排定撤卡"抽成一个纯函数/hook 再测，要么在 WorkspacePage 的既有
  渲染套件里加一条带假计时器的用例。
- **真窗口「等满 60 秒」端到端**：未取。原因具名——审批只能由**沙箱子进程**（笔记本 / 计算）发出的
  被拦请求触发（`kernel-executor.ts:636` 与 `shell-process.ts` 注入 `HTTP_PROXY`），
  单窗口无法诚实造出该请求；本机的 `configureFakeAgent` 夹具驱动的是 MCP 边界，不是出口请求。
  **不为此写一个假装是用户路径的夹具**。
  复跑配方（留给下次）：开出口白名单 → 起一个真笔记本内核 → 跑一格访问未在白名单的域名 →
  等满 60s → 断言卡片自行消失且该格以具名原因失败。

## 3. 顺带记下一条边界

`APPROVAL_TIMEOUT_MS` 是常量、默认 60s，**没有环境变量覆盖**；本轮只加了构造参数注入，
生产路径依然恒为 60s（真窗口那条读数若要自动化，可考虑用环境变量在 e2e 里缩短，
但那会让「等满 60 秒」这条读数的**时长本身**不再是事实，需要显式标注）。
