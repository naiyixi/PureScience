# Q3：真实 codex 回合路径上的 ①④⑤ —— 打通到"能起真回合"，但**读数未取**（2026-10-02）

结论先写：队列 Q3 的前提（"适配器通了 ⇒ 能起真实 codex 回合"）**在应用内不成立**；换成应用自己的
托管安装后**确实起了真 codex 会话并跑了 6 次真实回合**（每次 120–147s），但**留痕一条也没写**——
即 ①④⑤ 这三项**没有取到**，具名阻塞写在下面。**没有把缺的测量当成测量。**

方法：隔离实例（`PURESCIENCE_STORAGE_ROOT=/tmp/ps-q3-root`、`dataRoot=/tmp/ps-q3/data`、端口 44190、
`npm run dev:headless`），全部经应用自身通道（loopback RPC + web-token）。真实配置根只读一份 `settings.json`+`skills` 的拷贝。

## 1. 发现一：应用内的 codex 检测**不接受**用户自己装的适配器（A8 的覆盖范围比队列以为的窄）

| 读数 | 值 |
| --- | --- |
| `settings:detect-codex` | `codex: {}`（**空**，尽管 `~/.local/bin/codex-acp` 在、`/Applications/ChatGPT.app/Contents/Resources/codex` 在、版本 0.154.0-alpha.6.2） |
| `acp:create-session`（framework=codex） | 500 `Codex native executable not found. Re-detect or install Codex in settings.` |
| 真实配置根 | `~/.purescience-project/codex-managed/` **不存在**（本机从未装过托管 codex） |

根因可复核：应用把 `managedAdapterPath` 指向自己的托管位置（`src/main/settings/agent-runtime-manager.ts:299-313`：
`managedCodexAdapterEntry(storageRoot)`），而检测在**声明了托管适配器时只把这一条当候选**
（`src/main/settings/codex-detect.ts:85-89`：`deps.managedAdapterPath ? [deps.managedAdapterPath] : discoveredCandidates`）
⇒ A8（`14bf82fe`）修掉的是**零参数/独立检测**的版本探针门（那次复验正是零参数调用），
**应用内**路径仍然只认托管适配器。**用户装的适配器在应用里不可用** —— 这是 A8 的后续缺口，不是本轮新引入的。

## 2. 发现二：应用自己的托管安装**可用**（本轮据此拿到了真 codex 会话）

```
settings:install-codex {"source":"managed"}   # 装在隔离根里，机器未被改动；npm 源会跑全局 npm install ⇒ 未用
-> {"installId":"install-codex-1790908493747-2","ok":true}     # codex-managed 303 MB
```
装完检测记录为 `{resolvedPath: …/codex-managed/adapter/dist/index.js, version 1.1.4, nativeVersion 0.144.6}`，
`acp:create-session` 随即返回 **`frameworkId=codex`、`backendId=codex:builtin-codex-isolated`、sessionId `01a0fa79-…`**。
⇒ 真 codex 会话可复现，配方即上面两行（隔离根内，可重复）。

## 3. 发现三：两次"换 provider 形状"各跑 3 个真实回合，**留痕都是空的**

| 会话 | provider 形状 | 3 个真实回合耗时 | `function-model-events.json` | 技能活动事件 |
| --- | --- | --- | --- | --- |
| `01a0fa79-…` | `codex:builtin-codex-isolated`（订阅/隔离，自带后端） | 147.4s / 135.6s / 135.2s | **一条也没有**（`[]`） | 0 |
| `01a0fa80-…` | `codex:p_1786100000000_1`（API-key provider 走应用 Responses 桥） | 121.4s / 120.9s / ~121s | **一条也没有**（`[]`） | 0 |
| `01a0fa89-…` | `codex:p_1790909688055_5`（**自定义 chat-completions-only** provider，即 `requiresChatCompletionsBridge` 该为真的那种形状） | 120.7s / 120.4s | **一条也没有**（`[]`） | 0 |

三次回合的 function model 分别是：① `{}`（未配置）、④ `{skill-selection: deepseek-v4-pro}`、⑤ 不可达端点
（`http://127.0.0.1:9`，临时 provider 用完即删）；每次 `acp:get-state` 都报 `status=connected`、`lastError=null`，
事件里只有 `system/message/stop`，**没有** `providerToolName='skill'` 的活动。

第一轮（订阅 provider）的解释是**具名的**：`bridgeSkillsAvailable = Boolean(currentResource()?.bridgeLease?.selectSkills)`
（`src/main/acp/connection-resource-owner.ts:106-108`），而 Responses 桥是为**API-key provider**建的
（`backend-resolver.ts:1330-1331`）⇒ 订阅 provider 的回合路径**根本没有技能选择这一支**。

第二轮换到 API-key provider 后仍为空，因此闸门在 `src/main/acp/turn-skill-owner.ts:139-170` 之内，而**不是**空目录：
codex 技能根已物化 **625 个 `SKILL.md`**（`/tmp/ps-q3-root/codex/skills`、`codex-subscription/skills` 各 625）。余下的候选闸门：
1. `state.selectedSkillIds.length > 0` ⇒ 直接返回描述符、**不调选择器**（会话预选/always-on 技能会走这条）；
2. `codex?.bridgeSkillsAvailable` 在该组合下仍为 false。

`settings:skill-availability` 存在但用 `args=[]` 调用返回 500（需要请求对象），**因此这一轮没能读到 always-on 集合**——
不猜，如实记为未读到。

### 3.1 闸门定位（继续读到源码后的结论，文件:行可复核）

- `state.selectedSkillIds` 由**请求**带入（`turn-skill-owner.ts:62`：`input.selectedSkillIds ?? []`），我这三次回合都没带技能
  ⇒ 该分支（`:144-149`）**不成立**；`catalogForCodexHome` 在生产里**是接好的**（`runtime-composition.ts:265` →
  `settingsService.codexSkillCatalog`）⇒ 也不是它。
- 因此只剩 `codex?.bridgeSkillsAvailable`（`turn-skill-owner.ts:151`），其值为
  `Boolean(currentResource()?.bridgeLease?.selectSkills)`（`connection-resource-owner.ts:106-108`）。
- **为什么没有 bridge lease**：Responses 桥只在 target 声明需要它时创建
  （`backend-resolver.ts:745-752`：`target.needsChatResponsesBridge ? ensureResponsesBridge(...) : needsNativeResponsesCompatibility ? ensureNativeResponsesCompatibility(...) : undefined`）。
  本机两条 provider 形状都没走到建桥那一支 ⇒ 没有 `bridgeLease` ⇒ `bridgeSkillsAvailable=false`
  ⇒ 在调选择器之前就 `return []`。这解释了为什么两条路径各 3 个真回合都没有留痕。
  **更正**：本节初稿把建桥条件写成"`codex-responses` route 那一支"，**是错的**——那支（`:739-743`）是
  **native codex provider transport**（把 `provider` 换成自带后端），与建桥无关；建桥的判据是
  `target.needsChatResponsesBridge`。以本节为准。

**独立交叉验证**：codex 自己的 rollout 逐字文件
`/tmp/ps-q3-root/codex/sessions/2026/10/02/rollout-…-01a0fa80-….jsonl`（30 行）里，该回合的用户消息就是
`Reply with the single word: ready`（**33 字符**），全文件 grep `skill` / `loaded skill` / `specialist` **均为 false**
⇒ 该回合确实**没有**任何技能被注入，与"留痕为空"互相印证（不是"选了 0 个"的假绿，而是**这条支根本没跑**）。

## 4. 发现四（小）：`install-codex` 缺参数时是 500 TypeError，不是校验错误

`settings:install-codex` 传空参返回 `handler_error: Cannot read properties of undefined (reading 'source')`。
契约上请求是 `{source}`（`src/shared/settings.ts:801-803`），缺参应以校验错误回答，而不是 TypeError 崩在处理器里。

## 5. 未取与下一步（一条路走完即可，不必重探）

**未取**：①④⑤ 的留痕读数（内置回落与具名原因 / 真实往返与是否真选出技能 / `call-failed` 回落）。

**结论口径（只说量到的，2026-10-02 更正）**：八次真实回合（三种 provider 形状）**都发生在「跳过可读」之前**，
那时这条支的跳过是静默的 ⇒ 只能确定「**选择器没跑**」，**不能**确定是哪一道闸门（无桥 / 无目录读取器 / 目录为空 当时都表现为同一片空白）。
**更正**：本节初稿写「本机可配的三种形状都不可达（无桥）」，**证据不足**——按代码，自定义 chat-completions provider
**本应**需要桥（`requiresChatCompletionsBridge`：框架=codex、框架支持 `responses`、provider 有 `openai` 无 `responses`），
所以「本机没有形状会建桥」这句话当时无法成立，现在也**不声称**它。回合侧可读证据（`bridge-unavailable` / `call-not-attempted`）已交付，
**下一次真机回合即可判定**；若届时仍报 `bridge-unavailable`，那才是「需要桥却没建桥」的具名缺陷。
（与 A3 的 ✅ 不矛盾——A3 走的是 `settings:function-models` 的**探针**路径，不是 turn 路径，这正是 Q3 存在的理由。）

**下一步（2026-10-02 更新：第 1 步已交付，剩下的只有第 2 步）**：
1. ~~把 `bridgeSkillsAvailable` 的取值做成**回合侧可读**~~ ✅ **已交付**（提交 `b80fa197`）：新增具名原因
   `bridge-unavailable`，真机回合实测写出并回读该条目；见 `docs/evidence/2026-10-02-q3-turn-side-reason.md`。
2. **在下一次真机回合里读那条原因**，用它把闸门钉死：本机以**自定义 chat-completions provider**（`apiEndpoints:["openai"]`、无 `responses`）
   起 codex 会话跑一个回合——
   - 留痕是 `not-configured` ⇒ 选择器**跑了**（该形状有桥），④⑤ 只是还没配模型/端点，接着配 ④ 真模型与 ⑤ 不可达端点即可取得；
   - 留痕是 `bridge-unavailable` ⇒ **需要桥却没建桥**，那才是具名缺陷（`target.needsChatResponsesBridge` 为真而 `bridgeLease` 缺席）。
   本轮曾尝试这一测定（隔离实例 44194），**卡在托管安装**：`settings:install-codex {"source":"managed"}` 这次从 npm registry
   下载**无进展**（>9 分钟零字节；上一次同样操作 ~3 分钟装完 303 MB）⇒ 未取得读数，实例与临时目录已清。

**实例现状（2026-10-02 13:2x 更新）**：当时那个 44190 实例**已停**，`/tmp/ps-q3-root`（含 303 MB 托管 codex）与 `/tmp/ps-q1` 夹具
**已删**（13:2x 的收尾轮完成，端口 44190/44192/44194 均无监听，`/private/tmp` 回到 26M）；本轮又一次测定用的 44194 实例
也**已停并清干净**。留下的是**历史残留**（早期会话的 `/tmp/ps-*.log|.sh` 等几百个小文件，合计约 26M），非本次产物。
