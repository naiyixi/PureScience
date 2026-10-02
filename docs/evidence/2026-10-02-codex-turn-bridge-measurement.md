# codex 回合路径 / 建桥闸门：一次测定与**我自己三次更正**（2026-10-02）

目标：把文档里留着的那条测定做掉——**自定义 chat-completions provider（按代码 `requiresChatCompletionsBridge` 应为真）
在 codex 回合里，究竟走没走到技能选择器？** 结果：**仍未取得**，但边界收窄了；同时更正我先前三条**过强/错误**的判断。

## 1. 实测（隔离实例 44196，配置根 `/tmp/psq6-root`，dataRoot 钉在 `/tmp/psq6/data`）

| 步骤 | 读数 |
| --- | --- |
| `settings:install-codex {"source":"managed"}` | **落定**：`codex-managed` 303 MB 级；settings 记录 `{resolvedPath: …/adapter/dist/index.js, version: 1.1.4, nativePath: …/codex, nativeVersion: 0.144.6}` |
| 安装进度（自测） | 暂存目录 `adapter.tgz`+`codex.tgz`：**56.6 MB → 98.6 MB / ~100 s**（约 1 MB/s，有停顿），随后落定 |
| 会话 | `01a0fb56-…`，`framework=codex`、**`backend=codex:p_1790923143139_2`**（自定义 provider：`apiEndpoints:["openai"]`、**无** `responses`） |
| 一个真实回合 | 会话 `status=connected`、10 个事件（3 message / 1 `Prompt stopped`，即回合跑完）；codex rollout 文件存在 |
| **留痕** | **`function-model-events.json` 根本没生成**——既不是 `not-configured`（=选择器跑了），也不是 `bridge-unavailable`（=我的新代码在无桥时写的具名原因） |
| rollout 里的提示 | 逐字就是 `Reply with the single word: ready`（**33 字符**），全文 grep `skill`/`os-`/`mcp-`/`loaded skill` **均 false**（⇒ 没有技能被注入） |

**能得出的结论（只说量到的）**：这个形状下，**codex 那条技能选择路径根本没有产生任何可读记录**，也**没有**注入技能，
而回合本身是跑完的。因此「该形状有没有桥」**仍未判定**——我的具名原因本是为此设计的，它没有出现。

**边界收窄到的候选**（都不是推断，是下一步要读的）：
1. `state.selectedSkillIds.length > 0` 这一支被走到，且 `descriptorsForIds` 返回空 —— 该支**按设计不写留痕**，于是"没记录 + 没注入"两者同时成立。
   **已排除到大概率**：该值来自 `request.forcedSkillIds`（`prompt-turn-workflow.ts:168`），而本会话是 RPC 新建、无技能预选、无专家 ⇒ 应为空。
2. `prepareProvider` / `resolveCodexInputs` 对这个 backend 形状**没被走到**（回合路径中比它更早的条件把它跳过了）。**当前更可能的一支。**
   佐证（本轮新读）：函数模型宿主在生产里**是接好的**（`ipc.ts:2001-2005` 把 `resolveFunctionModelTarget` 与 `recordFunctionModelEvent` 交给运行时），
   ⇒ 只要选择器**被调用**过，留痕就会有条目；只要**没有桥**，我的新代码就会写 `bridge-unavailable`。两者都没发生，
   说明这条支**根本没进入**（或走了不写留痕的那一支）。下一步只需读 `prompt-preparation-owner.prepare` 的早退分支（handoff / 续轮 / 计划类）。
   **该早退已排除（本轮读）**：`prepare` 在 `input.turnSkill.prepareProvider(...)`（`prompt-preparation-owner.ts:153`）之前**没有**任何提前返回，
   所以 `prepareProvider` 一定被调用过。
   **"宿主为空"这条假设已被我自己推翻（本轮读）**：服务这个会话的运行时**带着**函数模型宿主
   （`ipc.ts:2001-2005` 的对象就是 `:2028` 交给 `createAcpRuntime` 的那一份；另一处构造在 `screening-model-runner`，与本会话无关）；
   而且"什么都没配"那支**是先记录 `not-configured` 再调内置选择**（`function-skill-selection.ts:106-119`，`builtIn()` 在 try 之外）
   —— 所以无论走"有桥"还是"无桥"，这条路径**都该留下一条记录**。两者都没留下，说明它**没走到那两处**。

   ⇒ 与全部观测（**无留痕** + rollout 提示仅 33 字符无技能文本 + 目录非空 625 + 回合跑完）自洽的**只剩一支**：
   `state.selectedSkillIds.length > 0`（`turn-skill-owner.ts:156`）——该支**按设计不写留痕**（"那是设计路径，不是跳过"），
   且 `descriptorsForIds(...)` 若返回空，就既不注入技能、也不写任何记录。即：**会话带着强制技能 id（很可能是 always-on 的 `mcp-*` 连接器技能），
   而这些 id 在 codex 技能根里取不到描述符 ⇒ 静默返回空**。这是**第二条静默失败**（第一条是我已修的三处跳过），
   如果成立，它与"选择器没跑"是两件不同的事，都需要写清。

   **一次真机即可分辨（下次务必留住日志）**：跑一个回合，看应用日志里有没有
   `Codex Skill selection failed { reason: 'selector-error' | 'catalog-error' }`：
   - **有** ⇒ 走的是选择器且**失败被静默**（`selectionFailed` 只 `log.warn`、不写留痕 —— `turn-skill-owner.ts:197-200`，这是我这份切片**没覆盖到**的缺口）
     —— **该缺口本轮已修**：`selector-error` 现在记录 `call-failed`、`catalog-error` 记录 `call-not-attempted`（复用既有具名原因，不动契约；两条新用例钉住）。
     于是**①④⑤ 里的 ⑤ 在 turn 路径上从此可取得**：失败不再只是日志。
   - **没有** ⇒ 是上面那一支（强制 id + 空描述符），则要修的是"描述符取不到时说一声"。
   两条都值得修；修法与我已经交付的三处跳过**同源**（复用既有的具名原因，不新增契约）。

## 4. 修好之后：同一实例上连续三次回合的**完整读数**（2026-10-02）

诊断日志先把闸门钉死（短暂插入、跑完即删）：
```
[acp-turn-skill-owner] DIAG resolveCodexInputs {
  frameworkId: 'codex', selectedSkillIds: 0, bridgeSkillsAvailable: true,
  codexHome: '…/codex', hasCatalogReader: true, hasRecordHook: true }
[acp-bridge] bridge skill selection failed { model: 'unreachable-model', reason: 'invalid-response' }
```
⇒ **该形状确实有桥**（`bridgeSkillsAvailable: true`，我撤回的那句得到实测确认），`selectedSkillIds` 为 0，
目录读取器与留痕钩子都在 ⇒ 闸门既不是"没桥"也不是"没接线"，而是**这条支在修好宿主之前根本没把结果写出去**。

修好宿主后连跑三例（真 codex 会话、隔离实例 44198）：

| 例 | 留痕（磁盘原文） | 判读 |
| --- | --- | --- |
| ① 未配置 | `{"outcome":"built-in","reason":"not-configured"}` | ✅ **① 取得**，且真实 |
| ⑤ 不可达端点（`http://127.0.0.1:9`） | `{"outcome":"used-model","providerId":"p_…_2","model":"unreachable-model"}` | ⛔ **假声称**——那个端点**不可能作答** |
| ④ 真 provider（deepseek-v4-pro） | `{"outcome":"used-model","providerId":"p_…_1","model":"deepseek-v4-pro"}` | ⛔ **不成立**（见下） |

**⑤ 为什么是假声称（机制，已读源码）**：桥把失败**吞掉**并返回空 ⇒ `createSkillSelectionBridge` 的
`runWithModel` **正常 resolve**（从未抛错）⇒ `runFunctionModelSkillSelection` 走成功分支、记 `used-model`
（`function-model-skill-selection.ts:123-130`）。即"请求没成功"被记成"模型作答了"。

⇒ **turn 路径的 `call-failed` 取不到**——不是"模型没被咨询"，而是**失败被记成成功**；
连带 **④ 也不成立**：它与上面那条假声称**用的是同一个标签**（`used-model`），在这条路径上无法区分
"真往返"与"被吞掉的失败"。这与 A3 的教训同源（探针当年也踩过，靠注入**记账 fetch** 才修好）——
**turn 路径缺那道记账**。

**已完成（同一条线的收口，2026-10-02 16:31）**：把探针那套记账接到了 turn 路径的桥包装器上——
桥在知道真相的那一层记录本次调用的实际结果（`answered` / `failed` / `skipped`），经端口→租约→连接资源所有者
→回合路径逐层转发，回合把它具名为 `call-failed` / `call-not-attempted`，而「作答但没选」仍如实记 `used-model`。
吞掉异常的行为**保留**（回合照常回落内置路径），改的只是「怎么记账」。①（内置回落 + 具名原因）**已取得**且可复核。

### 4.1 ⑤ 的真机读数：修复前 vs 修复后（同一场景、隔离实例、真实 codex 会话）

| | 场景 | 留痕（磁盘原文） |
| --- | --- | --- |
| **修复前**（实例 44198） | 端点 `http://127.0.0.1:9` | `{"outcome":"used-model","providerId":"p_…_2","model":"unreachable-model"}` ⛔ 关于**不可能成功的调用**的声称 |
| **修复后**（实例 44200，`9d79b984`） | 同一场景 | `{"outcome":"built-in","reason":"call-failed","providerId":"p_1790929705380_2","model":"unreachable-model"}` ✅ |

同一实例的另一次对照（未配置功能模型）：`{"outcome":"built-in","reason":"not-configured"}`（3.4 s，真实回合）。
脚本自判：`{"① not-configured": true, "⑤ call-failed (post-fix)": true, "⑤ still claims used-model (pre-fix bug)": false}`。

⇒ **④ 的读数仍取不到**，且原因已经明确、不再是「路径不可达」：隔离根里没有真 key，机器上能用的 provider
不在这个实例内，所以**没有可用的模型可跑真往返**（脚本会打印 `④ NOT EXERCISABLE` 而不是编一个读数）。
要在真机取 ④，得在一个配了真实可用 provider 的实例里跑同一场景——那是下一步，不是这一轮。

## 5. 本轮的代码修复（都随下一版走，v1.79.0 产物不含）

| 提交 | 修了什么 |
| --- | --- |
| `b80fa197` | 跳过具名（`bridge-unavailable` / `call-not-attempted`）+ 原因清单与契约同源 |
| `a4cdffbc` | `selector-error` → `call-failed`、`catalog-error` → `call-not-attempted`（失败不再只是日志） |
| `c7de13ff` | **宿主被静默丢弃**（`AcpRuntimeCompositionOptions` 未声明 `functionModels`）→ 现在转发；`selectSkills` 返回空时记 `call-failed`；新增源码守卫 `runtime-composition-wiring.test.ts` |
| `9d79b984` | 失败不再记成「作答」：桥记录本次调用的实际结果（`answered`/`failed`/`skipped`）并在端口暴露，回合具名为 `call-failed`/`call-not-attempted`；引入 `runtime-prompt-composition` 侧的分类器；真机读数见 4.1 |

## 6. 我要更正自己的三条判断（都在本轮，且都是量出来的）

| 我先前的说法 | 实际读数 | 结论 |
| --- | --- | --- |
| 「托管安装卡在 npm registry（国内网络）」 | `dns.lookup(registry.npmjs.org)` **29 ms**；TCP 连上 **2.2 s**（IPv6 也通） | **错误**：registry 可达，安装当轮也在**下载**（见下） |
| 「安装卡住、零文件系统活动」 | 暂存目录 `<configRoot>/.codex-install-*/` 里两个 tgz **56.6→98.6 MB / ~100 s** | **错误**：我盯的是**数据根** `/tmp/psq6/data`，而安装器用的是 `dataRoot: this.storageRoot`（**配置根**）——两次都在看错目录 |
| 「本机没有 provider 形状会建桥」（已写进 v1.79.0 正文） | 见上文：该形状的测定**未能判定** | 已在 `CHANGELOG`/两个 README/发布页**收回**（提交 `95d735c5` + 页面重合成） |

第三次更正的价值在于它是**同一类错误的第三次**：把「我没量到」说成「它就是这样」。写进公开正文前的自问应更狠一点——
**这次测量究竟能区分哪一种可能？**

## 3. 下一步（一次源码读 + 一次真机，二选一即可）

- 源码：读 `prompt-preparation-owner` / `prompt-turn-workflow` 中 `input.turnSkill` 的来源与守门，确认候选 1 还是 2；
  若是候选 1，则要读「会话为什么会带着 selectedSkillIds」。
- 或真机：把 always-on/预选技能关掉后重跑同一回合，若仍无留痕则候选 2 成立。

**纪律照旧**：④⑤ 在拿到读数前**不写进任何声称**；本次也未改任何产品代码。
（本轮实例与临时目录已清：44196 无监听；`/tmp/psq6*` 已删。）
