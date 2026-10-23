# 主线的认证车道红在「收件箱少一条通知」上：两次连续运行同一支用例，读数一样

2026-10-23 · 执行器 · 取证对象：P0 认证车道（macos-arm64 打包态，真 Electron 窗口）

## 一 为什么查这条

`origin/main` 的 Nightly 连续两笔红（`4b94b069` 17:12Z、`919796af` 19:31Z），中间只有三笔提交。发版前主线必须绿，
所以先归因。**这两笔红都不是本轮代码引起的**，但只有把原因说清，下一笔推送才算干净。

## 二 车道的判词要读作业级，不能只读车道级的「红」

| 读数 | 值 |
|---|---|
| 失败作业 | `build / Build macos-arm64`（`919796af`：作业 120061875859；`4b94b069`：作业 119980219195） |
| 报在哪个步骤 | `Enforce platform certification`（第 23 步） |
| 它为什么拒 | `p0 ended with failure`（脚本原文，`set -euo pipefail` + `check p0 "$P0_OUTCOME"`） |
| 上面那步长什么样 | 第 14 步 `Run P0 Electron certification` 在 API 里是 `success` —— 因为它带 `continue-on-error: true`，**步骤结论被改写成 success，而 `steps.p0.outcome` 是 failure** |

⇒ 「归纳到失败步骤清单第一环」这条在这里会指错方向：`Enforce platform certification` 是第一环，
但它拒收的原因是同一条链路上的 P0 认证**真的失败了**，不是打包没成（第 10 步 `Build & package` success，第 13 步
`Resolve packaged Electron executable` success）。**派生的「成功」不等于那件事做成了。**

## 三 P0 跑出了什么

| 运行 | 提交 | 读数 |
|---|---|---|
| 39820576415 | `4b94b069` | **1 failed / 3 flaky / 99 passed / 12 skipped**（31.1 分钟） |
| 39840905132 | `919796af` | **1 failed / 10 flaky / 95 passed / 9 skipped**（38.9 分钟） |

两笔里 **failed 都是同一支**：`e2e/certification/notification-inbox-clear.spec.ts:28`
（`deletes one notice, clears them all, and cancelling changes nothing`）。
10 条 flaky 全是 `The Electron app never opened a window: electronApplication.firstWindow: Timeout 30000ms` ——
那是 runner 负载下的启动超时，重试后过，与这条无关（它是在**断言**上失败，不是启动）。

断言的原文（两笔、四次读数完全一致）：

```
[notifclear] seeded: unread=1; items=[{"kind":"task.completed"}]
Error: two notices are needed for this reading: ["task.completed"]
```

⇒ 收件箱里**只有一条** `task.completed`，缺的是那次权限请求本该写下的 `authorization.required`。

## 四 打包态应用日志说了什么（`p0-test-results-macos-arm64` 工件里的 `test-results/app-process/`）

重试那一次启动（`002-certification-notification-inbox-clear-…log`）：

```
[acp-prompt-turn-workflow] prompt start { sessionId: 'e2e-session-1', textLength: 44 }   ← 第 1 轮
[acp] prompt stopped { sessionId: 'e2e-session-1', stopReason: 'end_turn' }
[acp-prompt-turn-workflow] prompt start { sessionId: 'e2e-session-1', textLength: 27 }   ← 第 2 轮
[capabilities] capability gaps notice { sessionId: 'e2e-session-1', sessionFound: true, injected: true, lines: 12, chars: 1281 }
[acp] permission request received { isMcp: false, toolCallId: 'e2e-permission-tool', sessionId: 'e2e-session-1', optionCount: 2 }
```

**两轮都真的跑了，权限请求也真的到了应用侧**（`permission request received` 是权限上下文在决定之前打的那一行）。
随后日志直接进入退出流程（GPU/renderer 被 kill），**没有** `inbox record failed`、也**没有**任何一条与收件箱写入
有关的行 —— 因为写通知这条路上有三个出口是静默的（见下）。

## 五 可能的原因只有三条，这份日志分不开

写入路径：`runtime-composition.ts` 的 `onPermissionRequest` → `recordInboxAuthorization` →
`notification-inbox-controller.record()` →（`recordNow` 里的两道闸）→ 仓库落盘。

1. **没走到写入**（权限请求被自动裁决，因此没有 emit）：`resolveAutomaticPermission` 里 profile=`full`、
   原生 Skill、Artifact 保存、activity group、`auto`+conservative+工作区内低风险这五条会**直接答**而不入队；
   `permission-broker.ts` 还另有会话级 grant 一条。默认 profile 是 `ask`，所以这条要求那几条例外之一成立 ——
   日志里没有它们的判词。
2. **走到了写入但被闸门丢掉**：`recordNow` 两道闸 —— 会话已删除（`deletedSessionIds`）、
   或 `isSessionAvailable(sessionId)` 为假。**这两条以前都是裸 `return`，一行日志都不留。**
3. **写入发生了但读得太早**：写是 fire-and-forget（`recordInboxAuthorization` 不 await），
   而这支用例的播种读是一次性 `readInbox(page)`，**没有重试**。

⇒ 三种形状在日志里**完全同形**。这就是本单元要修的东西：**让仪器能分开这三条**，而不是猜一条去改产品。

## 六 本单元改了什么

| 位置 | 改动 | 它解决哪一条 |
|---|---|---|
| `src/main/notifications/notification-inbox-controller.ts` | 两道闸各自留下具名行：会话已删除 → `info`「notification dropped: its session was deleted」；会话不可解析 → `warn`「notification dropped: its session is not available」（都带 `kind` 与 `sessionId`）。第三个删除检查点同样具名（「…while it was being recorded」） | 第 2 条 |
| `src/main/notifications/notification-inbox-record-gate.test.ts`（新） | 3 条：两道闸各一条（断言具名行与「一行都没落」）、两闸都不适用时落盘且**不**打丢弃行（并断言 pending 授权不算已读） | 第 2 条 |
| `e2e/certification/notification-inbox-clear.spec.ts` | 播种读改成**有界等待**（`waitForNotices(page, 2, 30_000)`，250 ms 一采），并把等待耗时与当时的条目打进读数；**断言仍是「至少两条」**，一个字没放宽 | 第 3 条 |

**没有改产品行为**：闸门该不该拦、通知该不该写，判据不变。改的是「拦了要说话」与「读的时候别抢跑」。

## 七 门禁（全部实跑）

| 环 | 读数 |
|---|---|
| 新增用例 | 1 file / **3 passed** |
| `src/main/notifications` | **11 files / 167 passed**，exit 0 |
| 变异：把两道闸退回裸 `return` | **2 条红**（正是「names the reason …」那两条），第 3 条仍绿 |
| 双 typecheck（`--composite false`，堆 8192） | node **0**；web **0** |
| `eslint --no-cache`（本笔 3 文件） | **0 errors**（4 条 warning 全是 prettier 对**既有**行的意见，详下） |
| `prettier --check` | 新增的两个文件过；spec 的漂移在 `HEAD` 上就有（`git show HEAD:… \| prettier --check --stdin-filepath` 同样报），不是本笔引入 |

## 八 边界（不许读成更强）

1. **原因还没定**。本单元没有证明是「读太早」还是「被丢弃」——那需要下一次 P0 车道的工件：
   若真机出现丢弃，应用日志会有那一行具名警告；若没有那一行而读数仍只有一条，则落在第 1 条（自动裁决），
   那时才去查 `resolveAutomaticPermission` 的例外表。
2. **spec 的有界等待不能替代产品修复**。30 秒是给「写是异步的」留的窗口；如果下一次仍在 30 秒后只有一条，
   说明**不是抢跑**，失败信息里会带「after 30xxx ms of waiting」，那就是第 1/2 条的判据。
3. **两次连续红之间的三笔提交没有权限或通知代码**（`5f317a05` / `8e279804` / `4b94b069` 只碰能力注册表、
   preflight 的根、Web 能力路由与文档）⇒ 没有代码级解释，这也是我把它当「仪器/时序」而不是「回归」处理的依据。
   但**它连续两次红**，所以不能只当抖动记档 —— 本单元就是「先让仪器能说清」的那一步。
4. **无本机真机读数**：内存闸门未解（空闲页 ~63 MB、swap 15.3 G / 16.4 G），本轮不跑窗口。
   本条的证据是**打包态 CI 工件里的真机日志**（真窗口、真点击路径、真数据库），不是本机复现。
5. 不占版本号：没有新的用户可见能力。
