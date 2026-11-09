# 产物定稿的失败行说不出「哪条规则拒了它」

日期：2026-11-09（执行器轮次）
状态：**诊断面已交付**（原因码 + 日志字段 + 源码守卫）；**根因仍未定**（两条候选立案，见 §五）。

## 一 症状（来自用户自己的真机日志，不是推测）

`~/Library/Logs/PureScience/{main,main.1,main.2}.log` 全量聚合（只读），`scope=artifacts:finalization`、
`msg="artifact finalization attempt failed"` 共 **20 条**：

| claim | 版本行 | 尝试次数 | 时间跨度 |
| --- | --- | --- | --- |
| `artifact-claim-1793897553264-38` | `4490f3e9…` | 1 → 15 | 2026-11-06 03:30 → 2026-11-07 16:02 |
| `artifact-claim-1793807368207-30` | `9e4b6288…` | 1 → 2 | 2026-11-04 15:49 → 15:54 |
| `artifact-claim-1793807815085-31` | `027f4c7a…` | 1 → 3 | 2026-11-04 15:56 → 16:47 |

每条的 `data` 里 `failureKind` **一律是 `invalid-proof`**，`durableFinalizationCompleted=false`、
`provenanceRetries=0`；除此之外只有 claim / run / message / frame / branch / segment 的 id。
**没有任何一个字段说明是哪一条证明规则拒绝的**：同一份日志里 20 条错误，读者能得到的结论只有
「证明无效」，而「无效」有 15 种可能（根帧不符 / 分支不属该帧 / 段属别的帧 / 提示消息不属声明 /
消息不属声明 / 版本不再合格 / 版本被漏报 / 版本已绑别的消息 / 证据非法 / 快照缺失 / 快照损坏 /
快照越出分支血缘 …）。要分辨，只能把那次运行再复现一遍——而这是终态失败（不重试），复现成本最高。

## 二 已读到的现场（只读，`~/.purescience/purescience.db`）

三个版本行现在的状态：

| 版本 | state | messageId | rootFrameId |
| --- | --- | --- | --- |
| `4490f3e9…` | `pending` | 空 | `root-frame-pending-session-1793891820688-12` |
| `9e4b6288…` | `unpublished` | 空 | `root-frame-pending-session-1793806439965-11` |
| `027f4c7a…` | `unpublished` | 空 | `root-frame-pending-session-1793806439965-11` |

三行的帧 / 分支 / 段都是 `*-pending-session-<时间戳>-<序号>` 形态（`pending-session` 前缀由
`src/renderer/src/stores/session-store-message-graph-owner.ts` 的 `createPendingSessionId()` 铸造）。
这是一条**有价值的线索，但不是结论**：证明校验比的是「声明身份 vs 持久会话图」，占位身份能不能与
落盘后的图对上，取决于会话绑定（`bindPendingSession`）时图里的 id 是否被改写。见 §五。

## 三 交付（3 个产品文件 + 1 条守卫用例）

| 位置 | 改动 |
| --- | --- |
| `src/main/artifacts/provenance-repository.ts` | 新增闭集 `ArtifactFinalizationProofCause`（19 个原因码）；`ArtifactFinalizationProofError` 构造要求**具名原因**；`ArtifactOwnershipPersistenceRaceError` 只接受两条可重试原因（`runtime-segment-not-durable` / `message-not-durable`）；17 处抛出点逐个具名 |
| `src/main/artifacts/ipc.ts` | 失败行新增 `proofCause`（仅当确为证明类拒绝）；claim 侧两处抛出点也具名 |
| `src/main/artifacts/proof-cause-naming.test.ts`（新） | 源码守卫：两文件的**构造数 == 具名数**（防新增抛出点忘记命名）× **声明集 == 使用集**（防「声明了却没人报」的漂移），并带「扫到 2 个文件、每份 > 1000 字符」的自检，避免路径写错导致全绿空转 |
| `src/main/artifacts/ipc.test.ts` | 终态失败用例断言 `proofCause` 真的进了失败行；既有「消息正文不得进日志」的红线断言保留且仍通过（原因码是枚举，不携带 id / 路径） |
| `src/main/data-content-application-commands.test.ts` | 构造点跟随新签名（行为未变） |

为什么是枚举而不是把错误正文抄进日志：正文里含版本 id，个别分支的正文来自被捕获的异常（可能带路径）。
枚举给出同样可操作的信息量，且**日志里不可能因此多出用户数据**——这条在 `ipc.test.ts` 里已有断言
（`not.toContain('/Users/private')`、`not.toContain('secret artifact contents')`），本轮继续成立。

## 四 验证读数（全部在最后一次改动之后）

| 环 | 读数 |
| --- | --- |
| 定向单测 `ipc.test.ts` + `proof-cause-naming.test.ts` | **Test Files 2 passed / Tests 39 passed**，exit 0 |
| 定向单测 `provenance-repository.test.ts` | **1 file / 41 tests passed**，exit 0 |
| 定向单测 `data-content-application-commands.test.ts` | **1 file / 9 tests passed**，exit 0 |
| `tsc --noEmit -p tsconfig.node.json --composite false` | **exit 0**（修复前它抓到一处漏改的构造点 `TS2345`，已修） |
| `tsc --noEmit -p tsconfig.web.json --composite false` | **exit 0** |
| `npx eslint --no-cache`（本次 5 个文件） | **exit 0**，0 error（3 条 prettier warning 已 `--fix`） |

**真机窗口读数：未取，原因具名** —— 要看到 `proofCause` 上屏需要一次**真实的证明失败**，而失败发生在
应用自己的定稿路径上（claim 登记表是内存结构，重启即丢，无法用脚本伪造一个「重启前的 claim」）。
本轮也没有起 Electron 实例：`vm_stat` 空闲物理页 **3,981 × 16 KB ≈ 62 MB**，
`vm.swapusage` **13,066 / 14,336 MB 已用** ⇒ 起窗只会把机器拖进抖动，读数也不可信。
因此本单元的实证强度停在：**真机日志证明缺口存在**（20 条）+ **单测/守卫证明新字段按设计产生**。
按本仓口径，这不构成「实机跑通」，已在计划档立案，等下一次真实失败或下一次真机取证补上。

## 五 立案：根因仍未知（两条候选，都不是结论）

1. **占位身份**：三条失败版本行的帧 / 分支 / 段都带 `pending-session` 前缀。若会话绑定后图里的 id
   被改写（`bindPendingSession` 只改 session id，图内 id 是否跟着改未核），声明侧与持久侧永远不等 ⇒
   终态拒绝且永不恢复。核法：对一个 pending 会话跑一次「创建 → 绑定 → 落盘」，读图里三个 id，
   与版本行的三个 id 逐字比。
2. **段每同步一次新铸一枚**：`synchronizeSessionGraph()` 每次调用都 `createRuntimeSegmentId()`，
   而版本行记录的是**声明那一刻**的段 id。若提示消息在后续同步里被投影到新段，校验的
   `promptMessage.runtimeSegmentId === context.runtimeSegmentId` 就会恒假。核法：同一会话连续两次
   同步后，比较同一提示消息的 `runtimeSegmentId`。
3. 无论哪条为真，**修复方向都不会是放宽校验**：前者要在绑定/落盘时把版本行的身份一起对齐（写侧），
   后者要让段 id 与「一轮」而不是「一次同步」绑定。两者都属写侧行为改动，需先取证再动。

下一轮第一步：用隔离数据根复现一条「新会话里产出产物 → 立刻定稿」的路径，读版本行与图里的三个 id；
若确认是候选 1/2，按候选对应的写侧修法立项；若两者都不成立，新的 `proofCause` 会让下一次真实失败**自己说出**
是哪条规则——这正是本轮交付的意义。

## 六 收尾

- 隔离工作树 `/tmp/ps-r298`（`origin/main` 738227d1 + 本轮改动），提交后即删；真实配置根 `~/.purescience-project`
  与 `~/.purescience` 全程**只读**（本单元的 SQLite 查询一律 `-readonly`）。
- 未打 tag、未抬版本号：本单元只改诊断字段，不构成运行时行为对用户可见的变化。
