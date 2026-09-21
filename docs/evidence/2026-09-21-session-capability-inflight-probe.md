# 证据：会话级票据下 Artifact claim 为何消失（2026-09-21，已定因并修复）

## 结论（整条写入路径打点实测，取代上一版的推断）

**根因不是"更早的删除点"** ✗ —— 本档上一版记录的那个推断作废 ✗。真根因是**排空 promise 被丢掉**：

`ArtifactTurnOwner.closeWrites`（`src/main/acp/artifact-turn-owner.ts`）里，退休调用写在了**带花括号的箭头函数体**里
且**没有 `return`** ✗：

```ts
const rpcDrain = turn.rpcCapabilityToken
  ? Promise.resolve().then(() => {
      this.options.retireRpcCapabilityScope?.(...)   // ✗ 返回值被丢弃，排空不在等
    })
  : Promise.resolve()
```

上一版本是**简洁体箭头** ✓（`() => this.options.revokeRpcCapability?.(...)` ✓，返回值即 promise ✓），改成花括号时
**静默丢掉了等待** ✗ ⇒ 封存**根本不在等**那笔已准入的写入 ✗ ⇒ `finalizeTurn` 立刻列出结果得 0 条 ✓
⇒ `artifacts.length === 0` 早退 ✓ ⇒ 无 claim ✓ ⇒ `artifactClaimId` 永远 undefined ✓✓。

## 实测轨迹（同一失败用例，修前 / 修后）

用例：`src/main/acp/runtime.test.ts > ACP runtime session management > drains an authorized Artifact RPC write before freezing the claim and marker`

**修前** ✗：

```
admit:OK inFlight:1 → rpc-createVersion:enter → close-writes
→ retire inFlight:1 → drain-settled ✗（写入仍在途！）
→ finalize-listed: 0 → empty/none
→ 之后才 rpc-createVersion:landed → release inFlight:0
```

**修后** ✓：

```
admit:OK inFlight:1 → rpc-createVersion:enter → close-writes
→ retire inFlight:1 → rpc-createVersion:landed → release inFlight:0
→ drain-settled ✓ → finalize-listed: 1 versionIds:[…] ✓ → claim 发出 ✓
```

即**退休（release-scope）真在等已准入的写入** ✓，封存之后才列出并冻结 claim ✓。

## 上一版两处结论的更正

| 上一版结论                                                       | 实测                                                                               | 判定   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| "revoke 进入时表里已查不到该票据 ⇒ 存在更早的删除点，是本因"     | `found:false` 是 `releaseSessionCapability` 自己删的条目，属**设计内**行为         | ✗ 作废 |
| "本档曾有一处测量错误（`?? -1` 把'查不到'读成计数为负），已更正" | 该更正本身成立 ✓                                                                   | ✓ 保留 |
| "main 上看不到该缺陷是因为 main 的 revoke 会删条目"              | 与本缺陷无关 ✗：main 的封存**在等** promis（简洁体箭头 ✓），是本分支的改写把它丢了 | ✗ 作废 |

## 为什么上一版会推断错

打点只覆盖了 **RPC 服务侧的计数三处**（准入 / 退休 / 释放）✗，看不到**归属方**有没有 await 那个 promise ✗：
服务侧读数在 `retire found:true` 之后就被 `releaseSessionCapability` 删条目掩盖了 ✓。这次按拍板要求对
**整条写入路径**打点（准入 → 版本落库 → `finalizeTurn` 列出结果 ✓ + 归属方排空时序 ✓），才把"服务侧看起来对、
归属方没等"这一层测出来 ✓。**测量代替推断** ✓。

## 顺带测出的两个设计洞（"一会话一票据"必须补）

在 `local-rpc-server.test.ts` **先写测试再修** ✓，两点均为实测：

1. **同一会话的第二轮被直接 403** ✗
   实测：`admit:MISMATCH field:agentFrameId expected:frame-root` ✓。
   原因：`agentFrameId` **每轮都变** ✓（`rootFrameId` 才是会话级 ✓，取自 `graph.rootFrameId` ✓），而票据的
   `turnScopes` 只记了 4 个字段 ✗ ⇒ 会话票据对第一轮之后的**每一轮都不可用** ✗。
   修法：`turnScopes` 记全轮次身份（`artifactRunId`/`rootFrameId`/`agentFrameId`/`runtimeSegmentId`/
   `promptMessageId`/`messageBranchId`）✓，准入改为"**必须有一个 scope 同时满足该方法携带的全部轮次字段**" ✓
   （逐字段各自匹配会允许跨轮拼身份 ✗）。

2. **可信参数取自票据的陈旧绑定** ✗
   `trustedParams` 用 capability 原始轮的 run/prompt/segment 覆盖请求值 ✗ ⇒ 第二轮写入会被记到**第一轮**名下 ✓。
   修法：改取**唯一匹配的那个 scope** ✓；不携带轮次字段的方法（如 replay）退回票据自身绑定 ✓。

## 已拍板事项（打开失败只退休该轮 scope）

- 实现：打开失败分支由 `revokeRpcCapability` ✗ 改为 `retireRpcCapabilityScope(token, runId)` ✓ —— 票据属于
  artifact storage session、可能已在服务另一轮，失败方无权吊销整张 ✓；退休同样会等该轮已准入的写入 ✓。
- 牵连测试：**实测 3 条** ✓（与拍板时估计一致 ✓）——`artifact-turn-owner.test.ts` 2 条、`runtime.test.ts`
  「cleans up prompt in-flight state when artifact run activation fails」1 条。
- 拍板时记的"一次失败打开会命中退休两次"**实测不成立** ✗：退休**恰好一次** ✓（`toEqual([一个匹配项])` 通过 ✓）。

## 回归护栏（防止该缺陷再被埋回去）

`artifact-turn-owner.test.ts > keeps the seal waiting for the retirement it started, not merely starts it` ✓：
在**没有** app 写在途的前提下只让退休可控地挂起 ✓，断言**退休 resolve 之前 `listRunVersions` 不得被调用** ✓
—— 丢弃 promise 时该断言必失败 ✓。

## 落地清单（本档随修复一起提交）

- 代码：`artifact-turn-owner.ts`（排空等待 ✓、失败打开退休 ✓、会话释放 ✓、`extendRpcCapability` 类型 ✓）、
  `local-rpc-server.ts`（scope 记全身份 ✓、唯一轮次匹配 ✓、可信参数取匹配 scope ✓）、`runtime.ts` 与
  composition 类型透传 ✓
- 测试：新增 3 条（第二轮可用 ✓、退休轮次被拒 ✓、封存等待护栏 ✓）+ 更新 3 条钉死 ✗→✓
- 门禁：`typecheck` ✓、`runtime.test.ts` ✓、`artifact-turn-owner.test.ts` ✓、`local-rpc-server.test.ts` ✓、全量门禁 ✓
- 打点已全部删除 ✓（写入时管道把 `Bearer` 字面量改写成 `***` ✗ → 测试改用 `ARTIFACT_AUTH_SCHEME` 常量 ✓）
