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
1. `state.selectedSkillIds.length > 0` 这一支被走到，且 `descriptorsForIds` 返回空 —— 该支**按设计不写留痕**，于是"没记录 + 没注入"两者同时成立；
2. `prepareProvider` 对这个 backend 形状**压根没被调用**（回合路径中比它更早的条件把它跳过了）。

## 2. 我要更正自己的三条判断（都在本轮，且都是量出来的）

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
