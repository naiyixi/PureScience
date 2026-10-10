# P0-7：产物能力令牌的生命周期跟着回合走（2026-10-11）

> 一句话：`write_artifact_file` 的能力令牌有一条**与回合无关的 2 小时寿命**，而一个回合可以跑十几个小时
> ⇒ 长回合在中途被自己的时钟判为"过期/已花掉"，用户自己的九天真机日志里**四次长回合全都撞在这上面**，
> 其中三次在最后一次写入被拒后**半分钟内回合就结束了**（agent 放弃了那件事）。
> 修法：**在回合还开着的时候续期，而不是拒绝**——权威由回合的封存结束，不由时钟结束。

## 一 真机证据（用户自己的日志，不是压测）

来源：本机打包版应用的真实使用日志
`~/Library/Logs/PureScience/{main.log, main.1.log, main.2.log}`（1.100.0，窗口 2026-10-01 → 10-10；本档另回看了更早的两段归档）。

**总体计数（当场扫三份日志逐条统计）**：`purescience-artifacts/*` 工具行共 **268** 条，其中**能力令牌类失败 24 条**：
`expired and was revoked` **4**（每个 episode 的第一枪）· `not valid for this turn … issued for an earlier turn` **13**（重试）·
更早版本措辞 `Invalid Artifact RPC capability.` **7**（同一形状，老版本文案）。**24 条落在 4 个 session 上，零散落。**

| # | 第一次被拒（UTC） | 该回合开始 | **进入回合几分钟** | 回合结束 | 该 episode 的失败构成 |
| --- | --- | --- | --- | --- | --- |
| 1 | 2026-08-27T04:01:42.493Z | 2026-08-26T11:56:43Z | **965 min（16.1 h）** | 04:02:32Z（**+50 s**） | 1 expired + 5 旧措辞 |
| 2 | 2026-09-21T02:40:30.969Z | 2026-09-20T16:51:48Z | **589 min（9.8 h）** | 02:40:59Z（**+29 s**） | 1 expired + 2 旧措辞 |
| 3 | 2026-10-03T03:55:33.613Z | 2026-10-02T16:23:46Z | **692 min（11.5 h）** | 03:55:57Z（**+24 s**） | 1 expired + 6 新措辞 |
| 4 | 2026-10-04T15:55:45.198Z | 2026-10-04T12:43:21Z | **192 min（3.2 h）** | 16:02:31Z（+6.8 min） | 1 expired + 7 新措辞 |

**四条都落在 2 小时（默认寿命）之后**；三条在最后一次写入被拒后 **24–50 秒**内回合就结束了。
即：这不是"偶发网络抖动"，是**同一个机制的四次复现**——回合比令牌活得久。

episode 3 的逐行原文（同一 session `577a01d2…`、同一 runId `71a1e7f2…`）：

```
2026-10-03T03:55:33.613Z warn acp tool call failed tool=purescience-artifacts/write_artifact_file
  reason=Artifact RPC capability expired and was revoked; a retry with it cannot be admitted. …
2026-10-03T03:55:35.025Z warn acp tool call failed tool=purescience-artifacts/write_artifact_file
  reason=Artifact RPC capability is not valid for this turn: it was issued for an earlier turn (or already spent). …
（03:55:36 / 38 / 40 / 43 / 45 又各一次，共 6 次重试）
2026-10-03T03:55:57.789Z info acp prompt stopped
```

**"重试指令"那一半其实早就做过了**（`f9842d6c`，2026-09-21：把措辞改成"重试同一个能力不可能成功"），
但真机上 agent **照样重试了 6–7 次**——因为那句话没有告诉它"那我现在该做什么"。
所以本单元的两半是：① 让**回合还开着时根本不该失效**；② 失效时的句子要点名**唯一能work的动作**。

## 二 对源定位（file:line）

- 令牌的寿命：`src/main/notebook/local-rpc-server.ts:264` `DEFAULT_ARTIFACT_RPC_CAPABILITY_TTL_MS = 2 * 60 * 60 * 1_000`，
  在 `issueArtifactRunCapability`（`:401`）与 `extendArtifactRunCapability`（`:440`）里写死 `expiresAt = now + ttlMs`。
- **`extend` 只在回合"开"的那一刻被调用**（`src/main/acp/artifact-turn-owner.ts:182`，由 `runtime-composition.ts:288` 接线）
  ⇒ 一个回合中途不会再刷新，寿命就是从回合开始起 2 小时。
- 判定顺序（改前）：`acquireArtifactRpcRequest`（`:1042` 起）= ①令牌不在表里 → 401「issued for an earlier turn」；
  ②`expiresAt <= now` → **先吊销再 401**（无论这一枪是不是某个**还开着的回合**发出的）；③方法白名单；④回合作用域匹配。
  ⇒ ②在 ④之前，所以"回合还开着"这件事**从来没有机会被考虑**。
- 回合还开着的可判据**本来就在手边**：`turnScopes` 是回合开时登记、**回合封存时移除**的
  （`retireArtifactRunCapabilityScope`，`artifact-turn-owner.ts:466-488` 的 `closeWrites` 调用它）
  ⇒ **"有匹配的 scope" ≡ 主进程在说"这个回合还开着"。**

## 三 修法（一处文件 + 一处用例；零新通道 / 零 i18n）

`src/main/notebook/local-rpc-server.ts`：

1. **把回合作用域的匹配提前**，并让过期只在**没有活回合在问**时才关闭准入：
   `if (!matchedTurnScope && capability.expiresAt <= this.now()) { revoke + 401 }`。
   一个匹配到 scope 的请求 ⇒ 该回合还开着 ⇒ 时钟不构成拒绝理由。
2. **准入通过后给该回合续期**（每个寿命窗口至多一行 info 日志
   `artifact RPC capability renewed for a turn that is still open`），让下一次长回合**可被日志解释**，
   而不是看起来像"从没发过令牌"。
3. **两句失效文案改成可行动**（点名唯一能work的动作：不要再重试这次调用，请用户再发一条消息，在新回合里写文件）。
   `expired` 那一句追加了 "with no live turn holding it"——因为它现在**只在这个条件下**才出现。

语义边界（刻意如此，写在代码注释里）：**结束一个回合的权威的，是它的封存（scope 被移除），不是时钟。**
时钟仍然关闭"没有活回合持有的能力"（会话释放 / 服务重启后的死令牌）。

## 四 验证

| 项 | 读数 |
| --- | --- |
| 定向单测 `src/main/notebook/local-rpc-server.test.ts` | **31 passed (31)** |
| **变异验证**（把源码回退成旧语义） | 新用例**当场红**：`AssertionError: expected 401 to be 200` —— 与真机上那一枪的判决**同形** |
| 模块目录 `src/main/notebook` + `src/main/acp` | <MODULE_SUITES> |
| `eslint --no-cache .`（全仓，CI 同口径） | <ESLINT> |
| 双 `tsc`（node / web，`--composite false`） | <TSC> |
| `bash scripts/pre-push-checks.sh` | <PREPUSH> |

**新增/改写的用例（只紧不放）**

- **新增** `renews the Artifact capability of a turn that is still open instead of refusing it`：
  时钟推 11.5 小时后同一回合的写入**必须 200**（真机上这一枪是 401）；再推 3 小时仍 200；
  **封存后**（scope 移除）同一调用才被拒，且是 `cannot be admitted` 那句具名判决——两个方向都钉住。
- **改写** `revokes new Artifact requests while draining one already-authorized write`：它的本意是"吊销期间关闭准入 + 排水等已授权的那笔"
  ⇒ 把中段那枪的拒因从**时钟**换成**吊销**（它自己的主题），并补上判词断言；不再依赖"过期"这条已改的语义。
- **改写** `rejects expired and revoked Artifact run capabilities`：先 `retire` 掉 scope，再让时钟过期 ⇒
  它现在钉的是新契约下的过期分支（**没有活回合**才过期）。

## 五 刻意的边界（不许读成"已做"）

1. **没有动令牌的总体寿命上限**：一个回合**只要还开着**，它的能力就一直续期。取代时钟的是回合封存（`closeWrites`）
   与会话释放（`releaseSessionCapability`，`artifact-turn-owner.ts:444`）这两道。**"开放回合被抛弃后能力一直活着"这条残余风险本档具名记下**，
   不声称已消除；若要消除它，得引入"回合心跳/超时"这条**新的**语义，属独立单元。
2. **不改变跨回合的既有拒绝**：命名已封存回合的写入仍是 403「belongs to an earlier turn」（既有用例 `refuses a write that names a retired turn…` 仍在跑、未放松）。
3. **本单元没有真机（Electron）读数**：修的是主进程的准入判定，证据是**真机日志**（上表 4 个 episode）+
   进程内真 HTTP 往返的单测。要在真机上"复现一次 11.5 小时回合"不现实（配方见下）。

## 六 复现 / 取证配方（任何人可重跑）

1. 数真机那 4 次：`node` 读 `~/Library/Logs/PureScience/main*.log`，筛 `data.tool` 以 `purescience-artifacts/` 开头、
   `data.reason` 含 `capability` 的行（本档脚本一次性，未入仓；判据就是本档 §一 的表）。
2. 进程内复现：`./node_modules/.bin/vitest run src/main/notebook/local-rpc-server.test.ts -t "renews the Artifact capability"`；
   把 `src/main/notebook/local-rpc-server.ts` 的续期分支删掉，同一条用例立刻变 `expected 401 to be 200`。
3. 旧语义的形状仍在**另一条**用例里被钉着（`rejects expired and revoked Artifact run capabilities`）：
   **没有活回合**时过期照样关闭准入——所以这次改动不是"把闸门删掉"，是"把闸门挂到回合上"。
