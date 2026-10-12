# D2 真机读数：结构选择进了会话上下文（2026-10-12，常驻 dev 实例 + 真 agent 回合）

> 版本自证（取证第一步）：运行中的实例构建里含**只有本改动才有**的字符串
> `purescience_structure_context` —— `out/main/ipc-DzGie4oB.js` 命中 2 次（旧构建 0 命中）。
> 实例由 `launchctl kickstart -k gui/$(id -u)/com.totota.purescience` 重启到含本改动的代码后取值。

## 1. 方法与真实输入

| 项 | 值 |
|---|---|
| 真结构文件 | `crambin.pdb`，**49,491 字节**（D1 那次探针从 RCSB 取回的那份，与 `2026-10-12-d1-live-structure-format-reading.md` 的读数一致） |
| 真实链/残基 | 单链 `A`，编号 1–46；22–26 号实测为 **PRO / GLU / ALA / ILE / CYS**（从文件本体解析，不是手写） |
| 内容摘要 | `sha256:42199a30a0701864a2a5cc76cd7f35cc544cd0e65fbcf63e03c166543249b811`（sha256(文件字节)） |
| 选择 | 链 A、残基 22–26、startResidue=PRO、endResidue=CYS、view=cartoon/spectrum |
| 通道 | Web RPC（`:44100`）：`projects:create` → `acp:create-session{permissionProfile:'auto'}` → `sessions:save-session` → `sessions:read-document`（回读）→ `acp:resume-session` → `acp:send-prompt{structureSelection}` |
| 读取方式 | 回合的 assistant 文本从运行时快照 `acp:get-state` 的事件流按 `promptMessageId` 聚合（RPC 建的会话不由渲染端落盘，`sessions:read-document` 回读到 0 条 —— 这是已知限制，不是本单元的缺陷） |

**踩过的一个坑（值得记）**：`sessions:save-session` 的载荷里时间戳必须是 **epoch 毫秒整数**；
发 ISO 字符串时主进程侧以 `Cannot convert undefined to a BigInt` 整条拒收（HTTP 500，日志只写
`handler-rejected` 不带原因）—— 原因是**响应体**里才有：`{"code":"handler_error","message":"Cannot convert undefined to a BigInt"}`。

## 2. 读数一：注入块确实到了模型，且**没有**污染用户消息

- 主日志：`[acp-prompt-turn-workflow] prompt start { sessionId: '6346db14-…', textLength: 117 }`
  —— 117 正是我发出的用户消息字符数 ⇒ **块不在 `request.text` 里**（D2③ 的分离在真机上成立）。
- 同一回合真跑：`egress-proxy … host: 'api.deepseek.com' / 'api.anthropic.com'` → 一次真实 `Bash` 工具调用
  → `[acp] prompt stopped { stopReason: 'end_turn' }`。

## 3. 读数二：agent 的回答引用的是**该区间**而非整链（D2 的验收判据）

agent 原话（`acp:get-state` 聚合，913 字符，逐字摘录）：

> 结构上下文里的 `structureId` 是 `file:d2-probe:crambin.pdb`，带一个内容摘要 `sha256:42199a30…`
> … | 链 | **A** | | 残基编号区间 | **22 – 26**（共 5 个残基） | | 区间起始残基 | **PRO**（脯氨酸） |
> | 区间末尾残基 | **CYS**（半胱氨酸） | | 覆盖范围 | **其中一段，不是整条链** —— 上下文字段为 `scope: "range"` |
> **关于"整条链还是一段"：是你选中的一段。** 应用明确把这次选择标记为 `scope: "range"`（范围选择），
> 而不是 `whole chain`，所以 A 链在 22 号之前和 26 号之后都还有残基没被选中。

三条一起才构成这次的证据：① 它复述的字段名与值**只可能来自我们注入的那块**（`structureId`、摘要前缀、
`scope: "range"`、PRO/CYS、22–26）；② 它对"整链还是区间"给的正是区间 ⇒ **判据达成**；
③ 它**拒绝编造**中间三个残基（23/24/25）并具名说出缺口（"上下文只给了区间首尾两个残基…我手上又没有文件可查"）
——把"应用告诉我的元数据"与"我自己解析出来的事实"分开陈述。

## 3b. 本次读数**没有**覆盖到的（具名）

- **真机点击链路未取证**：本轮走 RPC（无窗口），"在真视图里点残基 → 上屏 → 上行"那一半由组件用例
  （`PreviewFileContent.test.tsx`：点残基 → `chain A residue 1` → Shift 点 → `chain A residues 1-2` → store 同一份
  → 高亮 → 清除）覆盖，**真机点击未取**（需 CDP 驱动 Web UI，下次补）。
- **对照轮未发**（不带 `structureSelection` 的同题回合）：因下面第 4 节的范围闸门，agent 读不到文件，
  对照轮的信息量有限，本轮未发。
- **中间残基名字未在真机核对**：agent 明确说它拿不到文件 ⇒ 23/24/25 的名字没被真机验证（真值是
  GLU/ALA/ILE，见上表）。

## 4. 顺带抓到的真机缺陷（**不是本单元引入**，已单独立案）：agent 的范围根与真实数据根不一致

同一回合里 agent 的 `Bash` 调用被范围闸门拒绝，原文：

```
Refused: /Users/totota/PureScience-DEV/workspaces/e6ce83b2-… is outside this project scope.
Project files are read from the project folder itself (/Users/totota/.purescience-project);
```

**同日日志里同形拒绝共 6 次**，其中 **4 次是用户自己的真实会话**（`750c63b0…`、`980c1262…`，
即 MSM/GPCR 那个项目 `cmuh0axy50000jt29bqjmk9gm`），被拒的是它自己的 notebook 产物与会话工作区：

| 被拒目标 | 归属 |
|---|---|
| `<dataRoot>/notebooks/<projectId>/<sessionId>/data/figC_pmf_hysteresis.png` | 用户真实会话 |
| `<dataRoot>/notebooks/<projectId>/<sessionId>/data/umbrella_sampling_orthogonal_hysteresis_sim.py` | 用户真实会话 |
| `<dataRoot>/notebooks/<projectId>/<sessionId>/data/gpcr_msm_disconnect_4panel.png` | 用户真实会话 |
| `<dataRoot>/workspaces/<sessionId>/gpcr_msm_kinetics_disconnect_sim.py` | 用户真实会话 |
| `<dataRoot>/workspaces/<sessionId>` | 本次探针 |
| `<dataRoot>/workspaces/<sessionId>/…` | 本次探针 |

三条**同一个根上互相矛盾的读数**（都取自应用自己）：

1. 权威文件 `~/.purescience-project/claude/hooks/path-guard-roots.json`
   （2026-10-12 19:34 写入）= `{"roots":["/Users/totota/.purescience-project"],"hint":"/Users/totota/.purescience-project"}`
2. `storage:get-info` 自报 `dataRoot = /Users/totota/PureScience-DEV`（`isDefault: true`，
   `defaultDataRoot` 同值）——而**会话工作区与 notebook 数据确实建在它下面**（本机实测路径如上表）。
3. 写入点 `src/main/settings/agent-runtime-manager.ts:706`
   `const dataRoot = settings.dataRoot?.trim() ? settings.dataRoot : this.storageRoot` 与 `:722`
   `{ roots: [dataRoot, this.storageRoot], hint: dataRoot }` —— 落到盘上却只有**一个**根，且是**配置根**。

⇒ 机制：agent 侧的范围根与存储层真正的数据根**不是同一个解析结果**；在这台机器上表现为
**agent 读不到自己的会话工作区与自己的 notebook 产物**（用户真实会话里已经发生）。
`settings.json` 里并没有 `dataRoot` 键（实测），所以 agent 侧那条 `?? this.storageRoot` 回落到配置根，
而存储层用的是另一套默认（`PureScience-DEV`）。

### 4b. 定性读数（同日补）：打包版两者一致 ⇒ 影响面收窄到「两套解析不一致的安装」

| 安装 | 闸门权威文件里的根 | 会话工作区实际所在 | 一致？ |
|---|---|---|---|
| **打包版**（`~/.purescience`） | `{"roots":["/Users/totota/.purescience"]}` | `~/.purescience/workspaces/`（**76** 项） | ✅ **同根** ⇒ 闸门行为正确 |
| **dev 常驻实例**（配置根 `~/.purescience-project`） | `{"roots":["/Users/totota/.purescience-project"]}` | `<dataRoot=/Users/totota/PureScience-DEV>/workspaces/`（**306** 项） | ❌ 不同根 ⇒ 用户真实会话被拒 |

⇒ **定性**：这不是「闸门策略本身错」，而是**同一个概念（数据根）在两条路径上被解析成了两个值**：
agent 侧走 `settings.dataRoot?.trim() ? settings.dataRoot : this.storageRoot`（本机落到**配置根**），
而存储层（工作区、notebook、`storage:get-info` 自报）用的是**另一个默认**（`PureScience-DEV`）。
打包版上两条路径恰好同根，所以症状不现形；**影响面 = 数据根与配置根被分开的安装**（本机 dev 实例即一例，
用户真实会话已实际受损）。
产品侧仍应立案：**「数据根」只能有一处解析**（单一来源），否则任何一处改了根、另一处都会静默地
把 agent 关在自己的工作区外面。

**未做（具名）**：修法与判据都还没落。方向是让闸门的根来自**与存储层同一处**的解析（单一来源），
而不是把根放宽（放宽属于安全面，按仓规要先写成可复查的提权论证：谁本来就有更强权力、可达面是否变化、
以及每条 fail-closed 规则各配一个用例）。
