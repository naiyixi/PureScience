# PILOT in the Loop 研读 → PureScience 自进化落地建议

- 论文：*PILOT in the Loop: Live Self-Improvement for Long-Horizon Agents*（AllSpark Team，arXiv:2608.26530v1，2026-08-27；10 位作者，前两位 equal contribution）
- 研读日期：2026-09-12 · 材料：arXiv v1 **HTML 全文**（非仅摘要）+ 代码对照自查
- 结论一句话：**论文真正的贡献不是"自我进化"，而是把监督挪到运行中（live）**；我们的自进化通路（技能 / 记忆 / 检查点 / 追溯报告 / 确定性基准）比论文的 harness 厚得多，但全部是**事后闭环**，且**写入即生效、没有验证门控**——这两点才是本次借鉴的实质。
- 本文件为研读与方案，**不含任何代码改动**。

---

## 1. 论文骨架（可核验事实）

### 1.1 要解决的问题

| 现状 | 论文指出的缺陷 |
| --- | --- |
| 单智能体自纠错（ReAct / Self-Refine / CRITIC） | 执行与自评共用一个上下文；执行细节挤占判断所需注意力 |
| 子代理委派（AutoGen / MetaGPT / Magentic-One / Claude Code subagents） | 主代理**无法在子代理仍在运行时改道**，只能等它跑完 |
| 事后自进化（Reflexion / ExpeL / ACE / ADAS / AutoHarness / Meta-Harness / Self-Harness / Continual Harness …） | 经验只在执行结束后处理 → 帮不了产生它的那一轮，也没法立刻用该轮去验证 |

### 1.2 两个耦合机制

- **live steering（运行中改道）**：supervisor 与活跃 worker 之间一条双向通道，共五个操作。
  - worker → supervisor：`Notification`（主动汇报进度 / 中间结果 / 风险，发完继续跑）、`Question`（需要监督输入，**暂停**等回复）、`Result`（运行结束由 runtime 自动投递）。
  - supervisor → worker：`Steer`（把指引**排入 worker 的下一轮**；当前轮先跑完）、`Abort`（中断该 worker）。
- **live self-evolution（运行中蒸馏）**：监督过程中把可复用流程与失败模式写成 harness 的 skills / memory，H → H′；**同一 episode 内之后 spawn 的 worker 也会加载 H′**，形成闭环。
- **harness 定义** = skill library + memory；模型参数冻结。"self-improvement" 在本论文里 = harness 演进，不是权重更新。

### 1.3 关键数字（v1 全文）

| 指标 | 结果 |
| --- | --- |
| Terminal-Bench 2.0（89 任务） | GLM-5.1 **71.9%** / Kimi-K2.6 **71.3%**；两骨架平均 71.6%（Pi 66.3%）；Hard 分档 55.0%/55.0%（Pi 50.0%/48.3%） |
| SWE-bench Pro（平均） | PILOT **59.9%** vs Pi 55.5% / Mini-SWE-Agent 55.2% |
| 六组合排名 | 第一 5/6（Kimi 上 SWE-bench Multilingual 第二） |
| 自进化 20 轮 best-so-far | +14.6pp（GLM-5.1：66.3→80.9）、+12.4pp（Kimi-K2.6：68.5→80.9）；同起点同骨架下 OpenCode +7.9pp、Pi +2.3pp |
| 技能库规模 | GLM 62→83、Kimi 50→81 |
| 每任务平均输出 token | 28.5K→16.3K（**−42.9%**）/ 41.9K→22.1K（**−47.4%**） |
| 每百万输出 token 成功评测数 | **+110.3%** / **+134.0%** |
| 难度分档增益（通过任务数） | GLM：Easy +2 / Medium +6 / **Hard +8**；Kimi：+1 / +7 / **+12** |

### 1.4 门控口径（最值得抄的一条）

迭代内更新**只用 live 轨迹 + 环境反馈**产生（拿不到 verifier 信号，也没有奖励）；迭代结束后**只有成功 run 的更新被并入 H_{k+1}，失败 run 的更新丢弃**；verifier 结果**从不**用于创建或修改更新内容。这是"避免把失败做法固化成技能"的护栏。

### 1.5 live steering 的作用范围（论文自评，判定标准很严）

判定=supervisor 指出具体错误 / stalled branch / 无效策略 → worker 采纳 → 沿纠正路径成功；被忽略、过期、冗余的干预不算。

| 难度 | GLM-5.1 | Kimi-K2.6 |
| --- | --- | --- |
| Easy | 0.0% | 0.0% |
| Medium | 1.1% | 8.1% |
| **Hard** | **6.1%** | **19.7%** |
| 全部 | 2.3% | 10.6% |

→ 结论：live steering 的价值集中在**长执行链、错误会累积**的难任务；简单任务无需干预。

### 1.6 论文自陈限制与工程可得性

- 迭代式自进化评测成本高 → 只覆盖 3 个 benchmark、2 个开源权重模型；未探索异构（监督者/执行者不同模型）配对。
- 实现是对 Pi harness 的扩展（supervisor 为一个 agent session，worker 同进程另开 session）；同一冻结模型兼任两角色。
- **代码未公开**：论文给出的 `github.com/XiaoYang66/Pilot` 实测 HTTP **404**（2026-09-12 核验）→ 只能借鉴机制，无代码可移植。
- 邻域（用于判断我们的位次）：ADAS / ACE / AutoHarness / Meta-Harness / AHE / Group-Evolving Agents / EvoSkill / Memento-Skills / Mem²Evolve / Continual Harness / Self-Harness；PILOT 的差异点是**作用于当前 run**。

---

## 2. 我们现在的自进化现状（代码级对照）

| # | 维度 | PILOT | PureScience 现状 | 代码证据 |
| --- | --- | --- | --- | --- |
| 1 | 监督者与执行者上下文分离 | ✅ supervisor 独立会话 | ✅ **已有**：fresh-context Reviewer ACP 会话 + reviewer-only 工具作用域 + rubric + 外部来源核验 | `src/main/reviewer/orchestrator.ts:1-6`、`src/main/reviewer/rubric.ts`、`src/main/acp/reviewer-session-owner.ts:139` |
| 2 | 监督**时机** | ✅ 运行中（live） | ❌ **事后**：`runReview` 在每轮 turn 完成后触发 | `src/main/reviewer/orchestrator.ts:1` |
| 3 | supervisor → worker 纠正 | ✅ `Steer`（排队到下一轮） | ⚠️ 有事后纠正轮：`[Auditor]` 消息注入主会话 + 修复循环 ≤3 轮 | `src/main/reviewer/correction.ts:1-20`、`orchestrator.ts:6` |
| 4 | worker → supervisor 上报/提问 | ✅ `Notification` / `Question`（可暂停等待） | ❌ 无 | — |
| 5 | 中断单个 worker | ✅ `Abort` | ⚠️ 仅会话级 `cancelPrompt` 与 `reviewer:abort-fix-loop` | `src/main/acp/application-commands.ts:70-74`、`src/main/host-application-commands.ts:188` |
| 6 | 并行 worker | ✅ 每 episode 可 spawn 多个 | ✅ `delegate_tasks` ≤12 并行、独立会话、支持 `completion_contract` | `src/main/connectors/descriptors/delegate-tasks.ts` |
| 7 | 中间结果回收 | ✅ 事件级实时 | ❌ `Promise.all` + `waitForRun`：**全部跑完才拿到输出** | `src/main/connectors/sub-agent-executor.ts:143` |
| 8 | 技能写入能力 | ✅ | ✅ `create_skill` + `skill_eval`（评审并给具体改写）+ `skill_list/skill_read` + 系统提示 bootstrap 块 | `src/shared/skill-create.ts`、`src/shared/skill-eval.ts:1-11,63-68`、`src/main/skills/mcp-server.ts:182,216-230` |
| 9 | 技能写入者 | ✅ 独立监督上下文 | ⚠️ **执行者自己**（同一上下文） | app MCP 工具集（`src/main/agent-framework/app-mcp-names.ts`） |
| 10 | harness 热更新 | ✅ 更新后 spawn 的 worker 加载 H′ | ✅ **已有**：会话/子代理 spawn 时 materializer 同步技能目录；会话内还有 `reloadDecision: continue\|reload` 与 `needForceLoad` | `src/main/skills/materializer.ts:101-233`、`src/main/settings/claude-config-provision.ts:139`、`src/main/acp/turn-skill-owner.ts:35-40` |
| 11 | 长期记忆 | ✅ memory 写入 | ✅ `memory_save_note` + 分类驱动召回 + `supersededBy` 失效链 | `src/shared/memory-mcp.ts:8`、`src/main/settings/memory-recall.ts:42,65-76` |
| 12 | **验证门控保留** | ✅ 仅成功 run 的更新并入 | ❌ **无**：技能/记忆写入即永久生效，不携带"来源 run 是否通过检查" | `create_skill` 入参无 outcome/来源字段 |
| 13 | 确定性验证器 | ⚠️ 依赖 benchmark verifier | ✅ **现成且更强**：SciBench-Local 9 条机械规则对 trace 求值（**禁 LLM 打分**）+ 执行追溯报告 + 检查点输入指纹 | `src/shared/sci-bench.ts`、`docs/sci-bench-v0.md`、`src/shared/trace-report.ts` |
| 14 | 复用/继承追踪 | 指令要求记录"建立在哪些技能上" | ⚠️ 部分：每轮技能活动已记录，但"技能 A 建立在技能 B 上""技能被谁用了"未建模 | `src/main/acp/turn-skill-owner.ts`、`src/main/acp/codex-skill-activity.ts` |
| 15 | 自进化 KPI | ✅ token↓ + 成功/百万 token↑ | ⚠️ 有 token/上下文统计，无"每百万 token 成功数"口径 | `src/main/acp/*-turn-usage.ts`、`context-usage-tracker.ts` |

**一句话**：第 1、6、8、10、11、13 项我们已经比论文的 harness 更厚（论文的 harness 只有 skills + memory 两件）；缺的是 **2、4、12**——**时机**、**worker→supervisor 通道**、**验证门控**。

---

## 3. 六条启示（机制 → 我们的缺口 → 落法 → 差异化 → 机械验收）

> 差异化红线条（沿用既有排期口径）：交付必须**优于对标**而非平齐；禁空壳；能做成契约的护栏不要写成提示词或记忆。

### I1 事后审计 → 运行中监督（SupervisorChannel）

- **落地**（应用层，不改 ACP 协议）：新增 supervisor 端口，两个方向：
  - worker → supervisor 的 `progress/risk/question` **由应用侧从既有事件流派生**（`AcpRuntimeEvent` + 工具调用边界 + 检查点事件），不要求 worker 主动调用工具 → 零 worker 改造；
  - supervisor → worker 的 `steer` = 走既有 `sendPrompt` **排队语义**（当前轮跑完再生效，与论文一致）；`abort` = 复用 `cancelPrompt` / TaskRunner 的 run 取消。
- **差异化（超越点）**：论文的 steer 是自由文本。我们的 steer **必须携带可核验句柄**（artifact id / 文件+行 / tool-call id / checkpoint id）；无句柄者降级为"建议"且不得改变执行路径；每次干预写入 trace report 成为可审计条目。
- **验收**：①确定性测试：喂 fixture 事件流，断言生成带句柄的 steer、无句柄时降级；②实机：一个长任务出现 ≥1 次带句柄 steer，且 trace report 可见该条目与其后续步骤。

### I2 技能/记忆的验证门控保留（verifier-gated retention）

- **缺口**：`create_skill` / `memory_save_note` 写入即生效、永久有效，不区分"来自一次已验证成功的 run"还是"来自一次半途崩掉的 run"。这正是技能库长期污染的来源。
- **落地**：新增 `src/shared/skill-provenance.ts` 契约 —— 条目携带 `{originRunId, originTurnId, evidenceHandles[], kind: 'procedure'|'failure-mode', verification: 'unverified'|'verified'|'rejected', verifiedBy: 'sci-bench'|'checkpoint'|'user'|'reviewer'}`，含派生函数 `describeSkillTrust()` / `isReusableWithoutReview()`。
  升级路径（任一确定性条件命中即 `verified`）：SciBench 用例在该 run 的 trace 上通过 / 关联检查点指纹校验通过 / 用户显式确认。
  **`unverified` 的技能不参与自动加载与自动复用**，只能被 `skill_list` 显式检索到。
- **差异化（比论文更强，且更贴科研现场）**：论文只有一条门（benchmark pass/fail），且**失败 run 的更新整包丢弃**——但真实科研里"这条路不通"（PEP 668 装不上包、受体 PDB 与对接坐标不一致、vina 只能走 conda 包）恰恰是最贵的知识。我们做**三级**：`procedure` 类门控严格；`failure-mode` 类允许保留为**负面知识**，但必须绑定复现证据（命令 + 报错 + 环境指纹）并标注"来源 run 未经成功验证"；禁止作为正面操作依据。
- **验收**：契约 + 派生函数 + 单测（护栏写进契约而非提示词，沿用 omics-preview 模式：UI 与结论无法"忘记标注"）；新增 SciBench 用例——"未验证技能被自动复用"应判违规。

### I3 复用链与技能收益台账（我们版的 Figure 3(d)）

- **落地**：从既有事件（技能活动 + usage tracker + 检查点）派生 `skill-reuse-ledger`：技能 ↔ 采用它的 run ↔ 该 run 的验证结果。**零新增 IPC 通道**（放进既有会话事件投影），避免契约面涟漪。
- **差异化**：论文只报整体 token 下降；我们把 KPI 落到**单个技能**（使用次数 / 首次使用是否成功 / 平均节省的工具调用与 token，需有同族无技能对照），零收益技能进 stale 候选（复用已有 `reviewer/flag-stale-reviews` 的成熟做法）。
- **验收**：面板有真功能（能点进去看证据，非空壳）；无数据时明确"无数据"，不打印占位符。

### I4 自进化 KPI 进发版说明（机械口径）

- **落地**：`docs/sci-bench-v0.md` 增一节 + 发版流程输出对照表：同一批 trace 在 v_n 与 v_{n-1} 上的 SciBench 求值（"成功"= 9 条规则命中），附每任务 token 与"每百万 token 成功评测数"。
- **红线**：**禁止把"技能数增长"当成功指标**——技能膨胀本身不是收益（论文有 skill 数增长，但收益是用 token 效率证明的）。
- **验收**：每次发版说明带该表；规则未命中如实写"未计算 / 缺引擎"。

### I5 监督者预算与低内存约束（**不照搬**论文的常驻监督）

- 论文用同一模型常驻监督，开销只体现在 token 统计里；本机 8GB + Electron main OOM 的历史（多次真实事故）说明**再来一个常驻监督会话是危险的**。
- **落法**：**信号唤醒**——同一工具连续失败 ≥3 / 检查点指纹不符 / SciBench 规则命中 warn / 触发上下文压缩 → 才拉起 supervisor 会话；单轮干预上限 N、预算上限 M token，超限即降级为事后审计（=今天的 Reviewer 模式），并把降级原因写进 trace report 的诚实性说明段。
- **验收**：降级路径有单测；实机跑一个长任务确认未出现常驻监督会话。

### I6 失败模式库（论文口径的内在张力，我们显式化）

论文把 failure modes 列为蒸馏对象，但又规定"失败 run 的更新不并入" → 失败模式实际很难入库。我们将其显式为一等公民（见 I2 的 `failure-mode` 类），来源 run 成败无关，**唯一门槛是复现证据齐备**。

---

## 4. 明确不照搬

1. **"失败 run 的更新整包丢弃"** —— 与科研现场冲突（见 I2 三级门控）。
2. **常驻第三个模型会话** —— 预算 / 内存 / 成本；改信号唤醒（I5）。
3. **"同模型兼任监督与执行即最优"** —— 我们已有受限运行配置（`restricted-runtime-profile`）先例，保留异构可能。
4. **代码级移植** —— 论文仓库 404，无可复用实现；全部动作基于自研架构。

---

## 5. 建议单元排期（待拍板）

| 单元 | 范围 | 类型 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| **U1** | 技能/记忆溯源与验证门控（`shared/skill-provenance.ts` + `create_skill` 扩展 + 面板徽标） | 纯应用层 | — | 契约+派生函数+单测；UI 徽标有真数据；`unverified` 技能不自动加载 |
| **U2** | 失败模式知识类与三级门控策略 | 纯应用层 | U1 | 负面知识必须带复现证据；SciBench 用例守护 |
| **U3** | 复用链台账 + 技能收益榜（零新通道） | 渲染层为主 | U1 | 面板非空壳；无数据显式标注；stale 候选可导出 |
| **U4** | 自进化 KPI 进发版说明（SciBench 口径 + 对照表） | 文档/流程 | U1 | 发版说明含真实求值表；未计算如实标注 |
| **U5** | `SupervisorChannel` MVP：应用层 steer/abort + 两向事件 **（先只接 Claude Code + `delegate_tasks` worker）** | 跨模块（最重） | U1 | fixture 事件流确定性测试；实机长任务出现带句柄 steer 且 trace report 可见 |
| **U6** | 干预台账 + 机械判定"干预是否被采纳"（论文表 2 的自动化版） | 分析层 | U5 | 判定规则可机械执行；产出分难度统计 |

**建议**：U1–U4 一批（都在应用层、可机械验收、直接服务"自进化不空壳"，且 U1 是所有后续项的地基）；U5/U6 单独立项、先跑通一例再扩到 Codex/OpenCode。

**风险登记**：注入权限（steer 由模型生成 → 须走既有 permission/identity 门，作者身份标 reviewer 而非 user，防越权）、干预抖动（上限+冷却）、技能库污染（门控）、评测口径（禁 LLM 打分）。

---

## 6. 诚实性说明

- **已核验**：本文件第 1 节全部数字、机制、判定口径均出自 arXiv 2608.26530v1 **HTML 全文**（含 §3.1 实验设置、§4.2 表 2、附录 A.2 伪代码、A.3 自改进指令原文）；`github.com/XiaoYang66/Pilot` 返回 404 为本次实测。
- **代码核验**：第 2 节每一行均以"文件:行"给出调用点，非凭记忆。
- **⚠️ 结构已具备、未实跑**："运行中 `create_skill` 新建的技能会被随后 spawn 的 worker 加载"——materializer 在会话 spawn 时同步（`claude-config-provision.ts:139`）在代码上成立，但本次**未做实机验证**；U5 落地前应先补一次实测。
- **未做**：本文档不含代码改动；未在本机实跑 live steering 场景；未评估 U5 的跨框架（Claude Code / Codex / OpenCode）适配工作量细节。
