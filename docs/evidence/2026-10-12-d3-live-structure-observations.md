# D3 真机读数：结构观察的记录与投影（2026-10-12）

本档记录 **D3 第三片**（选择/测量落成可追溯的观察记录，并能在溯源面板里回跳）的真机读数：
**写半场已取、读半场已取**，未取项在末节具名。相关提交：`169d1c60`、`a6d22aa3`，加本轮的接线修复与诊断（见下）。

## 一、写半场（已取）

**装置**：本机常驻开发实例（headless，`127.0.0.1:44100`），重启后确认加载本批代码；一次真回合经
`/rpc/acp:create-session` → `sessions:save-session` → `acp:resume-session` → `acp:send-prompt`（带
`structureSelection`）发出。选择用的是一份**真文件**（crambin.pdb，49,491 字节）里真实存在的链 A 残基
22–26，编号与残基名从文件读出来，`contentDigest` 由该文件的字节算 sha256。

**读数**（沙盒会话 `a4217126-9340-4c76-89bb-98324ecca6a2`）：

| 判据 | 读数 |
| --- | --- |
| 日志里的回合开始 | `prompt start { sessionId: 'a4217126-…', textLength: 60 }`（＝用户原文长度；注入块没进 `request.text`） |
| 记录被调用的自证 | `[structure-observations] structure observation recorded { sessionId, kind: 'selection', entries: 1, dropped: 0 }` |
| 落盘位置 | `<dataRoot>/.structure-observations/a4217126-….json`，`dataRoot = /Users/totota/PureScience-DEV`（与读侧 `resolveDataRoot()` 同一个根） |
| 文件 | 646 字节、`entries` 1 条、`dropped` 0 |
| 条目 | `kind=selection`、`recordedAt=2026-10-12T14:26:01.771Z`、`chain=A`、`resi=22-26`、`kind=range` |
| **与发出去的那份逐字一致** | `schemaVersion / structureId / contentDigest / chain / residueStart / residueEnd / kind / startResidue / endResidue` **九项全 True** |

条目原文（摘）：

```json
{"entries":[{"recordedAt":"2026-10-12T14:26:01.771Z","kind":"selection",
"selection":{"schemaVersion":2,"structureId":"file:d3-probe:crambin.pdb","chain":"A",
"residueStart":22,"residueEnd":26,"startResidue":"PRO","endResidue":"CYS","kind":"range",
"contentDigest":"sha256:42199a30a0701864a2a5cc76cd7f35cc544cd0e65fbcf63e03c166543249b811"}}],"dropped":0}
```

### 这一轮抓到的真缺陷（真机读数才暴露出来的）

**录制器根本没接上**，而它是**静默**的 —— 两次探针都只看到「日志文件不存在」，与「选择根本没到」同形。
补上一行具名诊断后，日志直接点名：

```
[acp] structure observation: a selection arrived but no recorder is wired { sessionId: 'f655a8a5-…' }
```

根因：装配处把 `onStructureObservation` 放进了**模块依赖字面量**，而 `createAcpRuntime` 是**显式解构**
自己那份字段清单的 ⇒ 不认识的键在这一层被丢掉（`contextSummaryCapture` 一类能过，是因为它们被写进了
那份清单）。修法：**在 `runtime-composition.ts` 里就地接线** —— 那里本来就有 `const dataRoot = resolveDataRoot()`，
所以写入与读取用的是同一个解析结果，不需要再往任何选项对象里传根。装配处那个**空转的字段已删除**
（留着就是死配置）。修后同一探针：`structure observation recorded` 出现、日志文件落盘、九项逐字一致。

**顺带留在这条路径上的两条具名可观测性**（静默路径的代价要能被看见）：字段到了却没有录制器 ⇒
`warn`；录制写失败 ⇒ `warn` + `errorLogFields`（仍然**不抛回回合**，那一点没变）。

## 二、读半场（已取）

**装置**：对一条**真实成品版本**做**只读**读取（用户真实项目/会话，全程不写不删）：
`artifacts:get-version-provenance { projectId: cmuh0axy5…, artifactId: 4a10527a-…, versionId: 360118e9-…, appSessionId: 750c63b0-… }`。

**读数**：返回键为 `['contentStatus','descriptor','evidence','messages','readings','review','structureObservations']`
⇒ 新分段**确实由真通道送出**；其值 `{"state":"unavailable","reason":"not-recorded"}`，且同一次读取里
`readings` 也是 `{"state":"unavailable","reason":"not-recorded"}` —— 两条证据族在真机上行为一致，
而 `not-recorded`（没录过）与 `unreadable`（读坏了）在值上是分开命名的。

**未取（具名）**：**同一条会话里端到端**（我那条观察出现在同一会话的版本面板上）需要一个**在沙盒会话里
真正定版**的产物版本，本轮未取 —— 面板侧的渲染与回跳由 jsdom 用例钉住（含指纹当场复算、窗口/上限/无戳
三行读数、回跳把选择写回工作台），窗口语义由纯函数单测钉住；真机点击链路需要窗口 + CDP，本轮内存闸门
不允许起浏览器。

## 三、收尾复核（数字）

- 沙盒项目 `projects:delete` → `freedBytes: 0 / runData: absent`；探针目录已删（`probe_dir_gone True`）；
- 观察日志目录（只含我沙盒会话的那一个文件）已删，删除前已把内容抄进本档；
- **数据根条目 9 = 基线**、**workspaces 306 = 应用存量**、无 `.structure-observations` 残留；
- 探针第一次曾在 `projects:delete` 抛错时漏掉收尾（该通道的键名是 `id` 不是 `projectId`），已改为 `finally` 收尾并补清；
  探针另会留下**应用自己 provision 的会话工作区**（其目录名与 sessionId 不同）⇒ 收尾脚本已按 `resume` 返回的 `cwd` 精确删除。

## 四、同批复现到的既有缺陷（非本片引入）

- **P0-11（agent 范围根与真数据根不一致）**：本片两次探针里各复现一条 agent `Bash` 被拒：
  `Refused: /Users/totota/PureScience-DEV/workspaces/<id> is outside this project scope. Project files are read
  from the project folder itself (/Users/totota/.purescience-project)`。同一批的既有记录见 D2 档。
- **裸 RPC 会话的派发不完整**：`prompt start` 有、工具调用有（日志里两次 `tool call failed`），但
  `sessions:read-document` 回 0 条消息、并有 `Session Plan terminal projection failed: Cannot read runtime
  context for a missing Session`。**这不影响本片读数**（记录挂在回合准备那一刻，与消息是否落盘无关），
  但它说明「拿 agent 的原话当证据」这条路在裸 RPC 会话上不可靠，需要窗口驱动。
