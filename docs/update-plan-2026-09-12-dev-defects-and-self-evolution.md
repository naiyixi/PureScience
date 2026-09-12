# 更新计划 2026-09-12：DEV 实跑缺陷收敛 + PILOT 自进化借鉴

- 来源一：**DEV 近一周真实使用审计**（2026-09-05 ~ 09-12；`~/.purescience-project`，38 个会话、`logs/headless.out.log` 289,598 行、`settings.json`、`NotificationInboxItem`）
- 来源二：PILOT（arXiv:2608.26530）研读 → `docs/research/2026-09-12-pilot-live-self-improvement.md`
- 性质：**排期文档，不含代码改动**。每条缺陷都带可复核证据；未复现到根因的条目已显式标注"待复现"。

---

## 0. 一句话结论

DEV 一周的实跑暴露的不是"缺功能"，而是**已建成的护栏在真实使用中没在跑**：图表规则引擎因 RPC 上下文不可用而空转（14/38 会话）、自动审计默认关闭（38/38 会话）、长期记忆关闭、技能库一周零新增、托管运行时反复下载失败。这与 PILOT 的核心教训指向同一件事——**"自进化"缺的不是能力，而是让它真跑起来的通路与时序**。

---

## 1. DEV 实跑缺陷清单（P0/P1/P2）

| # | 缺陷 | 证据（可复核） | 频次 | 优先级 |
| --- | --- | --- | --- | --- |
| D1 | **`figure_review` 在真实会话不可用**：agent 只能"人工五项检查"并写进报告的"如实说明"段；出版级规则引擎（7 条 correctness）从未生效 | 14 个会话 21 次（f3ec1bbd、bef52b3a、b3be6d34、594b6697、3b9ab392、16938f18、e3378aa2、f6ecaa1d、54187f24、d1551b2f…）；代码：`session-capability-owner.ts:1427-1439` `buildFigureEnvironment` 在 `!routingId \|\| !projectName` 时**静默 return undefined**（服务器不注册、无任何提示） | 14/38 会话 | **P0** |
| D2 | **托管 Python 运行时下载失败 → 每次都要手动改绑外部运行时**；settings 已配 external `md-venv` 却仍走 managed | 主日志：`[notebook:runtime] runtimeSource:'managed'`、`prefix …/PureScience-DEV/runtime/envs/default-python`；会话 c60d8d78"托管的 Python 运行时下载失败(网络错误)"、c2b7695d"托管默认运行时因网络问题无法准备"、f3ec1bbd/d1551b2f"默认受管运行时不可用 → 绑定 molsim" | 4 会话直接受阻 | **P0** |
| D3 | **notebook RPC 超时致产物丢失**：长脚本被 `UND_ERR_HEADERS_TIMEOUT` 中断，留下空 `deliverables/`；前端同时出现未处理 rejection | 会话 126c9655#2"`deliverables/` 空目录是全量脚本被 RPC 超时中断的痕迹"；主日志 L260176-260186 `Notebook RPC transport failed: UND_ERR_HEADERS_TIMEOUT` → `renderer javascript failure` → **renderer 无响应 37.6 s** | 1 次产物损坏 + 2 次前端挂起（09-05 37 s / 09-06 121 s） | **P0** |
| D4 | **前端真实缺陷（未处理 rejection 指纹重复）**：同一 fingerprint `d22073f8` 在 09-05（surface=workspace）与 09-06（surface=settings）复现；伴随 `[main] uncaughtException errorCategory:'network'` ×2 | 主日志 L252508（09-05）、L261331（09-06）、L261327-261328；09-06 另有 renderer **V8 javascript OOM ×2**（L267841、L268001） | 3 次 | **P1** |
| D5 | **输入文件预检缺失 → 空跑**：任务引用的 `sim_*.csv` 全盘不存在，agent 只能自造"合成替代数据"并写大量诚实声明；产出报告描述的是模拟数据而非真实数据 | 会话 190cc71b（4 个文件均缺失，报告 §最重要的事先说）、92145499（自造两份模拟数据）、de70d881（"输入文件本会话缺失，全部数值基于合成替代数据"） | 3 会话 | **P1** |
| D6 | **外部抓取逐条授权摩擦**：专利/PMC/UniProt 抓取每次弹 `authorization.required` | `NotificationInboxItem` 中 `authorization.required` 40+ 条（近 8 天），如 USP28 会话连续 10+ 条专利站点授权 | 40+ | **P1** |
| D7 | **昂贵的失败教训无沉淀**：`pip build vina` 失败（09-08）、PEP 668、坐标系统不一致等教训，一周内技能库 **0 新增**、`memory.enabled=false` → 每次都重新踩 | 主日志 L283842 `Failed to build 'vina' …`；`~/.purescience-project/skills/` 仅 2 项（auto_fix_convergence 09-04、personal）；settings `memory.enabled:false` | 结构性 | **P1** |
| D11 | **`create_skill` 的长度校验以原始 MCP 报错砸回 agent**：唯一一次真实"想沉淀技能"的调用被拒（`MCP error -32602 … Too big: expected string to have <=200 characters at description`），因为 `SKILL_CREATE_TOOL_DESCRIPTION` 从未告知 200 字符上限；agent 只能自己猜着重试（09-04 23:03 被拒 → 23:09 才成功落盘 `auto_fix_convergence`） | 主日志 L246201-246207；`src/shared/skill-create.ts:28,44`（schema 有 maxLength，描述无） | 1 次硬失败 | **P1** |
| D8 | **守门与自进化通路在真实使用中未启用**：① `autoReviewEnabled` 38/38 会话为 False（代码默认 `=== true ? true : false`，`session-persistence.ts:1582`）；② `memory.enabled=false`；③ `disabledSkillIds` 17 项里含 **citation-integrity、evidence-grading、evidence-quality-assessment、literature-search-strategy、methods-writing-audit、research-contract、statistical-inference** —— 与外宣的质量护栏直接矛盾 | settings.json + 38 份会话元数据；`src/shared/session-persistence.ts:1582` | 全量 | **P0** |
| D9 | 上下文结构失衡：真实会话 `contextUsage.breakdown` 显示 tools≈569 k tokens、mcp≈109 k，而 messages≈5.5 k（同一会话 190cc71b） → 上下文预算主要被工具/MCP 定义吃掉 | 会话 190cc71b `contextUsage.breakdown`（estimated；used 276,492/1,000,000） | 结构性 | **P2** |
| D10 | **RPC 创建的会话不落盘、首轮秒停**（dev:headless 实测，v1.57.0）：`acp:create-session` 返回 connected，`acp:send-prompt` 后立即 `prompt stopped end_turn`、**零工具调用、零 agent 消息**，日志报 `Session Plan terminal projection failed: Cannot read runtime context for a missing Session`，会话文件始终未生成（带/不带显式 `cwd`、新旧项目均复现） | 实测 4 个会话：`bd43ec9e`、`9d29870e`、`5ef16831`、`f1550bb4`、`d386c136`；`logs/headless.out.log` L290595-290710 | 4/4 失败 | **P0**（阻塞一切自动化验收；也是 Web 远程控制的通路） |
| D12 | **Web UI 直接打不开**（用户报"我没找到 UI"的真因）：DEV 无窗口，UI 就是 `http://127.0.0.1:44100/?token=<~/.purescience-project/web-token>`；但静态包 `out/web`（**09-07 构建**）把可用通道白名单**烘进构建产物**，服务器现有 **296** 个通道（v1.54–v1.57 新增一批）→ SPA 的 `webRpcBootstrapSchema.safeParse` 失败 → 整页只剩一句 **"This computer did not finish responding. Incompatible PureScience Web RPC protocol. Expected version 1."**（文案把人引向"协议版本"，实际是**通道面漂移**） | 实测：Playwright 打开 UI 复现；`npm run build:web` 后同一页面正常渲染（项目列表/New project/composer 齐全，且能真发一轮 agent 回合并跑完 51s） | 100%（旧构建必现） | **P0（用户侧）** |

> 说明：主日志中 **09-05 ~ 09-12 窗口内没有 main 进程 OOM**（18 次 OOM 全部发生在 08-19）；两周前的 OOM 历史不纳入本计划，避免与本次审计混为一谈。

### 1.1 A1 复盘：实机核验后的修正（2026-09-12）

动手复现后，原 D1 的结论需要分两半看，**其中一半已经修好、另一半仍在**：

| 项 | 结论 | 证据 |
| --- | --- | --- |
| figure_review 的 RPC 参数契约 bug | ✅ **已于 09-05 修好**：`f42f353`（2026-09-05 23:43）把 review 请求按网关契约嵌进 `request`，并加了回归测试；日志里最后一次该错误发生在 09-05 22:26（**修复提交之前**），此后不再出现 | `git show f42f353`；日志失败时间线 09-04 10 次 / 09-05 起逐次减少至 22:26 结束 |
| **规则 6/7 在 agent 通路不可达**（新发现，v1.57.0 仍在） | ❌ **仍在**：`figurePanelSchema` 只有 id/title/chart_type/data_shape/series_count/label_count/excluded_rows/summary_used_excluded/rendered/note —— 缺 `axis_ticks`、`rendered_image_path`、`source_script_path`、`font_pt`，而引擎的 `checkLogAxisSanity` / `checkSourceArtifact` 只读这四个字段；zod 丢弃未知键 ⇒ 工具描述与会话提示词告诉 agent"申报 log 刻度、附上 .png/.py 路径"，agent 却**无法申报**，两条规则形同不存在 | `src/main/settings/figure-mcp-server.ts:20-47`（schema）vs `src/main/settings/figure-review-service.ts:176-215`（规则）；`src/shared/figure.ts:124-146`（提示词 append 明确要求"pass their paths"） |
| 端到端实机验证 | ⛔ **被 D10 阻塞**：会话不落盘、prompt 秒停，无法让 agent 真正调用一次 figure_review | 见 D10 |

**已落地的修复（本次）**：补齐 `axis_ticks` / `rendered_image_path` / `source_script_path` / `font_pt` 四个入参字段 + 映射到 `FigurePanel`，工具描述与会话提示词点名这四个参数名，并加两条回归测试（schema 必须暴露这四个字段；一次调用经 schema→mapper→真实规则引擎必须产出 `log_axis_sanity` 与 `source_artifact` 违规）。

### 1.2 A1 修复后的实机验证状态（诚实版）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 代码修复 + 回归测试 | ✅ 已推送 | `fd77b26`；本地 `vitest` 7 项通过、`eslint` 干净、`typecheck` 双配置绿 |
| CI | ✅ 全绿 | Nightly `34690206639` + Windows Full Test `34690206492`，均 `completed success`（用 `gh api .../actions/runs/<id>` 判定；注意 `?head_sha=` 需**完整 40 位 SHA**，短 SHA 会返回 `total_count: 0` 造成"没触发"的误判） |
| **修复前**行为的实机证据 | ✅ 已取得 | 一次真实调用（agent 主动声明 `axis_ticks`（含 log 轴上的 `"0"`）与 `font_pt: 4`）返回中**没有 `log_axis_sanity`、没有字号告警**，只有 `source_artifact`；agent 自己在回复里指出「两个 `axis_ticks` / `font_pt` 字段不在该工具的公开 schema 中，但未被拒绝」。证据会话 JSON 存档 `/tmp/fig-evidence/` |
| **修复后**端到端复验（agent 回合） | ⛔ **未完成**（阻塞，非未做） | 已重建 DEV 服务（新构建 `figure-mcp-server-CFjigjw5.js` 确认含 `axis_ticks`/`renderedImagePath`/`fontPt`）。RPC 派发用"先发 prompt → 再 `resume-session`"变体重跑 **4 个会话，4/4 失败**（prompt 秒停 `end_turn`、零 agent 消息、用户消息也不落盘）⇒ 先前那次成功是**偶发不可复现**，RPC 通路不能作为验收手段 |
| **修复后**规则引擎实机验证 | ✅ **已通过**（绕开 agent，直击被测对象） | 对运行中的应用调它自己的 `figure:review` 通道：探针面板 → `clean:false` + 命中 **`log_axis_sanity`**（`"0"` 出现在 log 轴）与 **`source_artifact` ×2**（缺 .png/.py、字号 4pt < 6pt 线）；合规面板（带 .png/.py、9pt）→ **`clean:true`** 零违规。即"违规判 fail / 合规判 clean"两条判据均实测成立 |
| 真实 agent 回合的端到端 | ⛔ 待 UI 侧确认 | 缺口已从"规则在 agent 通路不可达"缩小为"RPC 不能派发 agent 回合"（D10）。契约层由单测钉住（schema 暴露 4 字段 + schema→mapper→引擎往返），引擎层由上一行实测钉住；剩 agent 真调一次这一步建议在 UI 里点一下完成 |

**D10 的根因与已探明的可用配方**（供后续自动化验收复用）：

- 会话落盘权在**渲染端 store**（渲染器调 `api.sessions.saveSession`）；裸 RPC 只建 ACP 会话，不产生 App 侧会话记录 → `send-prompt` 时报 `Cannot read runtime context for a missing Session`，或直接静默 `end_turn`。
- 部分可绕开：`projects:create` → `acp:create-session` → **`sessions:save-session`**（该通道在 web RPC 面可用）→ `acp:resume-session` → `acp:send-prompt`。此路径**成功过一次**（agent 真调用 figure_review 并返回 JSON），但**不可重复**：后续同样序列均秒停。
- 对**用户 GUI 建的、未挂载的会话**发 prompt 会报 `ACP session not found`（HTTP 500）——需要先 `acp:resume-session`。

**遗留清理**：✅ 已完成——`projects:delete` 的正确参数键是 **`{id}`**（`{projectId}` 会触发 Prisma `findUnique` 报错 → HTTP 500），两个沙盒项目已删除、会话目录一并清除。

---

## 2. 合并后的单元排期

> 原则：**先让既有护栏真跑（P0），再把失败经验变成资产（P1），最后才是新能力（P2）**。每个单元都要"实机可验证 + CI 全绿"，禁空壳。

### P0 — 让已建成的能力真正生效（建议立即开工）

| 单元 | 交付 | 验收（机械） |
| --- | --- | --- |
| **A1** 修 `figure_review` 真机不可用 | 复现并定位（两个候选根因：① `buildFigureEnvironment` 静默 `return undefined` → 服务器不注册；② RPC 网关 `figureReview` 参数校验拒绝）；修法=**失败必须可见**（服务器不可用时向会话注入明确提示，而非静默消失）+ 项目作用域解析补齐 + 集成测试 | 真实会话里 `figure_review` 对一张违规图返回 fail、对合规图返回 clean；不可用时 agent 收到显式原因；vitest 覆盖两条路径 |
| **A2** 运行时供给前置化 | 启动/首个 notebook 调用前预检：external 运行时优先（settings 已配 `md-venv` 却走 managed 是缺陷）→ 不可用则走镜像/本地缓存 → 仍失败则**一键绑定已有运行时**并把结论写进会话首条提示 | 冷启动会话在 0 次手动试错下拿到可用运行时；断网复现（禁用镜像）时给出可执行指引而非报错堆栈 |
| **A3** 让守门与自进化通路默认开 | ① 自动审计（Reviewer）默认策略改为"新会话默认开启、可关"，并在 UI 明示状态；② 技能禁用清单复核：**引文诚信/证据分级/文献检索策略/方法学审计默认不得禁用**（与引文诚实性红线一致）；③ 记忆（memory）默认开启的可行性评估与显式提示 | 新会话元数据 `autoReviewEnabled=true`；被禁用的守门技能清零并在 UI 可见；实机跑一轮出现 Review 记录（`Review` 表非空） |
| **A4** notebook RPC 超时与产物保全 | 长脚本超时可续跑/分段；RPC 中断必须留下**可诊断产物**（而非空目录）；前端错误不外溢为 unhandled rejection | 复现一次长任务超时：无空 `deliverables/`、无 renderer 挂起、报告标注中断点与续跑方式 |

### 2.1 A2 归因与实施设计（2026-09-12 勘踏，根因已证实）

**根因：per-language 运行时选择在执行路径上是死配置。** `notebookRuntimes.<lang>`（`{source:'external', interpreterPath, appOwnedOverlay, packageInstallAuthorized}`）的读取方只有两处——设置面板快照（`src/main/ipc.ts:650`）与设置工作流（`runtime-selection-workflows.ts:123` 的 `buildSurvey`）。**执行/准入路径没有任何消费者**：`data-execution-admission.ts` 的 `route()` 只认 `binding`，无绑定时一律落到 `defaultEnvironment(language)`（托管默认 env）；`setRuntimeBinding` 只被绑定 owner 的 bind/switch/revoke/reload 调用，即只响应显式的 `notebook_bind_runtime` / `notebook_switch_runtime` / 设置页切换。而共享类型注释写的是"`selection` undefined => nothing chosen yet (resolves to the managed default at run time)"——**选了却不解析**，文档行为与实现不符，属缺陷而非待设计项。

**后果**（DEV 一周实证）：用户配了 external `md-venv`，未绑定绑定的会话仍去打托管包；国内下载 GitHub 资源失败 → agent 只能自行摸索 3–4 轮改绑 `molsim`/`md-venv`。

**实施设计**（无新 IPC ⇒ 零契约计数涟漪）：

1. `data-execution-admission.ts`：新增两个**可选注入**端口——`resolveRuntimeSelection(language)` 与 `autoBindSelection(session, language, selection)`；在"无 binding"分支先尝试自动采用已选 external（可运行才绑），失败则**保持今天的行为**（托管默认）并在拒绝信息里说明原因（honest failure，不静默换轨）。
2. `ipc.ts` 构造 admission owner 处接线：`resolveRuntimeSelection` → `settingsService.getRuntimeSelection`；`autoBindSelection` → `NotebookRuntimeBindingOwner.list(session)` 里按 `interpreterPath` 找到对应 `runtimeId`，再 `bind(session, language, runtimeId)`（复用既有 API，不新造路径）。
3. 测试四组：①选中 external 且可运行 + 无绑定 → 走 external；②选中 managed → 行为不变；③未选择 → 保持托管默认；④选中 external 但不可运行 → 回退托管默认且给出可见原因、不崩。

**验收**：单测四组通过；实机复现"设置选 external → 新会话首次执行不再触发托管包下载、直接用所选解释器"；断网（禁用镜像）场景下失败信息给出可执行的下一步而非堆栈。

### P1 — 把失败经验变成资产（PILOT 借鉴的主体）

| 单元 | 交付 | 验收 |
| --- | --- | --- |
| **B1** 技能/记忆**验证门控**（PILOT I2） | `src/shared/skill-provenance.ts`：条目携带来源 run / turn / 证据句柄 / 类别（procedure｜failure-mode）/ 验证状态；`unverified` 不参与自动加载；升级条件=SciBench 用例通过 / 检查点指纹校验通过 / 用户确认 | 契约+派生函数+单测；新增 SciBench 用例守护"未验证技能被自动复用"=违规；UI 徽标有真数据 |
| **B2** 失败模式知识类（PILOT I6） | 负面知识（此路不通）显式保留，门槛=复现证据齐备（命令+报错+环境指纹），与来源 run 成败无关；禁止作为正面操作依据 | vina/`pip build`、PEP 668、坐标系统三条真实教训入册并可被后续会话检索到 |
| **B3** 监督者信号唤醒 + 干预台账（PILOT I1 轻量版） | 不引入常驻监督会话：同工具连续失败≥3 / 检查点指纹不符 / 规则命中 warn / 上下文压缩 时唤醒 Reviewer；超预算降级为事后审计，降级原因写入追溯报告诚实性段 | 单测覆盖唤醒与降级；实机长任务未出现常驻监督、出现 ≥1 次带证据句柄的告警 |
| **B4** 输入文件预检（D5） | 会话开始解析任务中引用的文件/路径；缺失即在前 2 轮内明确提示"文件不存在，是否用合成数据/换路径"，而不是几十轮后才在报告里声明 | 复现 190cc71b 场景：第 1 轮即出现 missing-input 提示；用户可选择继续（并在产物中强制标注 synthetic） |
| **B5** 抓取授权批量化（D6） | 按域/按来源批量授权 + 会话级"允许本域"，减少 40+ 次逐条授权 | 同一会话内同域抓取只弹一次；授权范围可在设置中查看与撤销 |
| **B6** 前端指纹 `d22073f8` 定位修复（D4） | 复现路径：09-05 workspace / 09-06 settings 两次；修未处理 rejection 与 `uncaughtException(network)`；评估 renderer OOM 的内存压力 | 复现步骤固化为测试或手工验收清单；修复后同场景无 renderer 挂起 |

### P2 — 自进化增强与度量

| 单元 | 交付 | 验收 |
| --- | --- | --- |
| **C1** 复用链台账 + 技能收益榜（PILOT I3） | 从既有事件派生技能↔run↔验证结果；零新增 IPC 通道 | 面板非空壳、可点开看证据；无数据显式标注 |
| **C2** 自进化 KPI 进发版说明（PILOT I4） | SciBench 口径对照表（v_n vs v_{n-1}）+ 每任务 token + 成功/百万 token；**禁把技能数增长当成功指标** | 发版说明含真实求值；未计算如实标注 |
| **C3** `SupervisorChannel` 完整版（PILOT I1/U5） | 应用层 steer（复用 `sendPrompt` 排队语义，当前轮先跑完）+ abort（复用 `cancelPrompt`）+ worker→supervisor 事件从事件流派生；先接 Claude Code + delegate worker | fixture 事件流确定性测试 + 实机长任务出现带证据句柄的 steer 且进追溯报告 |
| **C4** 工具/MCP 定义上下文瘦身（D9） | 按需加载/懒注册工具面，把 569 k 的 tools 预算压下来 | 同一会话 `contextUsage.breakdown` 对比截图（改造前/后） |

---

## 3. 依赖与顺序

```
A1 ─┐
A2 ─┼─ 可与 A3/A4 并行（互不依赖）
A3 ─┤
A4 ─┘
     └→ B1 ─→ B2 ─→ C1 ─→ C2
     └→ B3 ─→ C3
     └→ B4, B5, B6（独立）
```
- A3 是"自进化是否真在跑"的开关，做完后 `Review` 表应有记录 —— 这是后续 B3/C1 的数据来源。
- B1 是 B2/C1/C2 的地基（没有来源与验证状态就没法算"技能收益"）。

---

## 4. 风险登记

| 风险 | 应对 |
| --- | --- |
| A3 打开自动审计后每轮多一次模型会话 → 成本/内存（本机 8GB） | 复用 B3 的信号唤醒；设单轮预算上限；UI 明示审计状态与费用 |
| A1 根因可能不是"静默不注册"而是 RPC 校验 | 先复现再改（本计划要求：动手前必须实机复现一次并记录日志） |
| B3 干预抖动 / 权限越界 | 干预上限+冷却；steer 走既有 permission/identity 门，作者标 reviewer 而非 user |
| D9 工具瘦身伤到能力覆盖 | 只做懒注册，不删能力；以"同一任务改造前后成功率"对照验收 |
| 评测口径自证 | 一律用 SciBench 确定性规则，禁 LLM 打分（沿用既有红线条） |

---

## 5. 诚实性说明

- **已核验**：第 1 节每条均给出可复核来源（会话文件、日志行号、`settings.json` 字段、代码行号）。会话/日志均为本机 DEV 实跑产物，非推断。
- **待复现（未定位根因）**：D1 的两个候选根因、D4 的前端指纹具体代码路径、D2 中 external 配置未被优先采用的具体分支 —— 三个都要求动手前先实机复现，复现结论写回本文件。
- **未做**：本文件不含代码改动；未做 DEV 实机回归（不排除审计期间有别的会话同时改动）。
- **排除项**：08-19 的 main 进程 OOM 属历史问题，不在本次一周窗口内，单独立项评估。
