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

## 4. 发现四（小）：`install-codex` 缺参数时是 500 TypeError，不是校验错误

`settings:install-codex` 传空参返回 `handler_error: Cannot read properties of undefined (reading 'source')`。
契约上请求是 `{source}`（`src/shared/settings.ts:801-803`），缺参应以校验错误回答，而不是 TypeError 崩在处理器里。

## 5. 未取与下一步（一条路走完即可，不必重探）

**未取**：①④⑤ 的留痕读数（内置回落与具名原因 / 真实往返与是否真选出技能 / `call-failed` 回落）。

**下一步（按代价从小到大）**：
1. 读出该会话的 always-on/预选技能集（`settings:skill-availability` 用正确的请求对象调），若非空 ⇒ 关掉它们或在无预选作用域的会话里重跑；
2. 若仍为空，则在回合路径埋一次可读证据（`bridgeSkillsAvailable` 的取值）以定位闸门 2；
3. 然后用同一驱动脚本 `/tmp/ps-q1/q3-turns.py`（三例一起跑、读 `<configRoot>/function-model-events.json`）取读数。
   **纪律照旧**：④ 的"真实往返耗时"若该路径不上报，就写 **not reported**（`elapsedMs` 确实被算了但被桥丢弃，
   `runtime-prompt-composition.ts:97` 只取 `value`），绝不写 0。

**实例现状（供接手）**：44190 实例**仍在运行**（配置根 `/tmp/ps-q3-root`，含 303 MB 托管 codex），
夹具/脚本在 `/tmp/ps-q1/`；未清理未停进程。收尾时应：停实例、确认 44190 无监听、删 `/tmp/ps-q3-root` 与 `/tmp/ps-q1`。
