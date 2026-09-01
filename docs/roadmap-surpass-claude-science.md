# PureScience 全面超越对标产品的更新计划

> 版本：v1.0（计划稿）
> 日期：2026-08-30
> 依据：对标产品 CS v0.1.15-dev（2026-07-01 构建）深层代码剖析（bunfs 源码 bundle + drizzle 97 迁移 + 87 MCP servers + 30 skills + agents metadata），以及 PureScience v1.24.0 现有能力盘点（CHANGELOG + src 全量 grep 验证）。
> 目标：在 **防幻觉核验、长上下文、记忆溯源、生态规模、可审计执行** 五个维度全面反超，同时守住 PureScience 已有的 **生物医药垂直、中文体验、CN 网络适配、BYOK 多提供商** 差异化护城河。

---

## 0. 现状盘点：PureScience 已经有什么（避免重复建设）

以下能力**已经存在**，本次计划不重复开发，只做强化/对齐：

| 能力域 | PureScience 现状 | 验证方式 |
|---|---|---|
| Frame 树（root_frame_id / parent_frame） | ✅ 已有，48 文件 | src 全量 grep |
| Reviewer 审计（v3：ReviewCheck + ReviewerLogEntry + ScopeBlock contentHash） | ✅ 已有，161 文件（reviewer/orchestrator.ts, repository.ts, scope.ts） | shared/reviewer.ts 确认 turn 级窗口审计 + 陈旧检测 |
| 上下文压缩（compaction） | ✅ 已有，41 文件 | 但缺「可检索摘要」—见差距 G2 |
| Memory（分类 + 自动回忆 + MCP 保存工具） | ✅ 已有，16 文件（memory-recall.ts / memory-mcp-server.ts） | 但缺「证据溯源/版本取代」—见差距 G4 |
| 子代理委托 + 子代理模型覆盖 | ✅ 已有（delegate 79 文件；v1.24.0 sub-agent model override） | CHANGELOG v1.24.0 |
| 网络出口白名单（egress allowlist） | ✅ 已有（v1.17.1/v0.17.1） | 但缺「deny-first」语义 —见差距 G5 |
| MCP 工具授权 | ✅ 已有，24 文件 | 粒度可再细 —见差距 G5 |
| Artifact 版本化 + 血缘 | ✅ 已有，44 文件 | 缺「环境快照/代码提取」—见差距 G7 |
| 生物医学技能包（BioNexus 17-skill） | ✅ 已有 | 规模 vs 对方 30 skill + 87 MCP —见差距 G6 |
| 生成式会话标题/描述 | ✅ v1.20.1 等价 | 无差距 |

## 1. 差距清单（G1–G8）——来自 对标产品 CS 深层代码剖析

### G1. 防幻觉核验：从「turn 级审计」升级到「claim 级闭环」⭐ 最高优先级

**对方做法**（drizzle 0029_verification.sql + reviewers/agent metadata）：
```
session_claims 表：每轮提取 agent 可核验陈述（claim_text, entities, source）
  → verification_checks 表：verdict(pass/warn/fail/inconclusive) + severity
    + evidence + rebuttal + reviewer_idx + reviewer_model
    + source_ref + status(open/resolved/unaddressed) + reflag_count
  → REVIEWER agent：skills_locked, enable_thinking:false（实测 thinking 占 72% token 但 recall 无提升）
  → 用户可 Mark addressed / reflag
```

**PureScience 差距**：现有 reviewer 是「整轮窗口」审计（ReviewCheck 挂在 turn 上），没有 **claim 级持久化 + 证据链 + 用户解决闭环**。

**升级方案**（对齐对方但保持自己的 ReviewerLog 优点）：
- P1: 新增 `session_claims` 表（claim_text/entities/source_ref/root_frame_id）
- P2: 新增 `verification_checks` 表（verdict 四态 + severity + evidence + rebuttal + status + reflag_count）
- P3: Reviewer 升级：提交 findings 时同时产出 claim 级 check（复用现有 ACP reviewer session）
- P4: Renderer 新增「核验清单」面板：claims 列表 + 每条 verdict 徽标 + 证据引用 + Mark addressed + reflag
- P5: 实测驱动：复刻对方的基准方法（bench-reviewer：对比 thinking on/off 的 recall 差），用数据决定是否给 reviewer 关 thinking

**验收**：一次会话中 agent 声称 5 个可核验事实 → 全部进入 claims → reviewer 给出 verdict+evidence → UI 可逐条标记 addressed → 重启后状态保留。

---

### G2. 长上下文：两级 Rolling Compaction + summary_query 可检索摘要 ⭐

**对方做法**（bundle 事件枚举）：
```
RC_FOLD_L1（浅折叠）→ RC_FOLD_L2（深折叠）→ COMPACT_DESTRUCTIVE（破坏性）
rc_context_ceiling: 200k–2M tokens 滑动天花板
折叠产物：<summary id=…> + summary_query(summary=<id>, question=…) 对原文 chunk 提问
boundary(label=…) 工具：agent 主动标记任务边界，折叠落在任务之间
```

**PureScience 差距**：有 compaction（41 文件）但**无 summary_query**（grep 0 命中）、无折叠等级概念、无 agent 主动 boundary 标记。

**升级方案**：
- P1: 折叠时持久化 summary chunk（id + 原文引用），不直接丢弃
- P2: 新增 `summary_query` ACP 工具（对折叠 chunk 做定向检索）
- P3: 两级折叠策略（L1 快速折叠 / L2 深度折叠）+ 可配置 ceiling（200k–2M）
- P4: `boundary` 工具注入 system prompt，agent 在任务收尾时主动标记
- P5: 折叠活动可视化（timeline 上显示 fold 事件 + 可展开摘要）

**验收**：200k+ token 长会话中，早期讨论的关键数据（数值/文件名/决策）在折叠后仍可通过 summary_query 取回；UI 可见折叠历史。

---

### G3. 科学 MCP 生态规模：内置 87 个生物信息学 MCP 服务器 ⭐

**对方做法**（mcp-servers/bio-tools/lib/ 87 个包，纯 Python stdio，统一 run_server.py 启动器 + bundledRegistry.ts 注册 + MCPPool 懒连接 + conda 共享环境）：
```
文献: pubmed_search/fetch, europepmc_fulltext, biorxiv_fetch, arxiv_fetch, openalex_works
变异: gnomad_variants, clinvar_records, dbsnp_records, cadd_scores
结构: pdb_structures, alphafold_structures, emdb_meta
化学: chembl_bioactivity/targets/drug_search, pubchem_compounds, bindingdb_affinities
基因组: ensembl_rest, encode_search, gtex_expression, eqtl_catalogue, rfam, reactome
模型: depmap_models, cellguide, protein_atlas, panglaodb_markers, string_network
临床: clinicaltrials_essie/fetch, civic_evidence, cbioportal_studies
```

**PureScience 差距**：有 BioNexus 17 个**技能**（SKILL.md + run_script），但技能是「给 agent 的说明书」，不是「开箱即用的检索服务」。对方是**服务层**（stdio MCP，agent 直接 query），两者互补。

**升级方案**：
- P1: 移植 top 20 个最高价值 MCP server（优先：pubmed/europepmc/gnomad/clinvar/pdb/chembl/pubchem/ensembl/clinicaltrials/openalex）
- P2: 移植 MCPPool 模式：懒连接 + refCount + 共享 conda env + 启动失败降级
- P3: 每个 server 配 installPip 依赖钉扎 + 首次启动自动安装（复用 run_script 的依赖自检）
- P4: 按批次扩到 40–60 个；保留 BioNexus 技能层作「使用说明书」叠加
- P5: 网络适配：内置 CN 可达镜像/代理配置（对方服务直连海外 API，PS 必须解决 egress）

**验收**：新建会话可直接 `host.mcp("pubmed", "search", ...)` 查询并返回结构化结果；断网/API 失败时优雅降级提示。

---

### G4. 记忆溯源：evidence + superseded_by + subject 绑定

**对方做法**（memories 表）：
```
subject_project_id / subject_artifact_id / subject_version_id / subject_frame_id
origin / evidence / superseded_by / last_surfaced_at
每条记忆绑定产生它的精确 artifact 版本 + frame + 证据；新记忆可 supersede 旧记忆
```

**PureScience 差距**：memory 有分类/自动回忆/保存，但记忆**没有绑定证据出处**，无法回答「这条记忆哪来的、是否已被取代」。

**升级方案**：
- P1: memories 表加列：subject_artifact_id / subject_version_id / subject_frame_id / evidence / superseded_by / last_surfaced_at
- P2: memory_save_note MCP 工具扩展：agent 保存时自动携带当前 frame/artifact 上下文（无需 agent 手动填）
- P3: 回忆注入时附 evidence 引用；被 supersede 的记忆默认不注入
- P4: Memory 面板显示「来源」「证据」「取代链」；UI 可手动 supersede/删除

**验收**：agent 保存记忆后，该记忆在 UI 中可展开看到来源 frame/artifact 与证据；同主题新记忆自动标记旧记忆 superseded。

---

### G5. 权限与安全：deny-first 网络 + 写审计（writetrace）+ 更细 MCP 授权

**对方做法**：
```
network 权限：内置 exfiltration deny list（"deny wins"——黑名单域名永远无法被授权）
host 权限：rw/ro 两种模式分离 + 路径绑定可撤销
writetrace.dylib：OPERON_WRITE_TRACE 环境变量控制，审计 agent 全部文件写入
```

**PureScience 差距**：有 egress 白名单但缺 deny-list 语义；无文件写入审计；MCP 授权粒度可细化。

**升级方案**：
- P1: egress 增加 deny list（内置已知外泄域名），deny 优先于 allow（改现有 allowlist 判定顺序）
- P2: 文件写审计：在 run_script / 内核写路径挂钩，记录 时间/路径/字节/进程 → 审计日志（纯 JS 实现，不依赖原生库）
- P3: MCP 授权细化：支持按工具 + 会话范围授权（当前是否全有？验证后补）
- P4: 审计 UI：写审计事件可查（时间线视图）

**验收**：列入 deny list 的域名即使被 allow 也无法访问；agent 写文件的每条记录可查。

---

### G6. 自定义 Agent 档案（user_agents）+ 技能-代理绑定

**对方做法**：
```
user_agents 表：name/display_name/description/system_prompt/icon_key/color_key/tags/skill_names/base_agent
agent_skill_assignments 表：skill×agent×user 唯一绑定
identity_prompt（能力声明）与 working_style_prompt（风格）分离——用户档案只替换前者
```

**PureScience 差距**：有 subagent 委托 + 模型覆盖，但**没有用户可创建/自定义的 agent 档案**（grep agent_profile 仅 2 文件，基本无）。

**升级方案**：
- P1: user_agents 表 + 设置面板「代理档案」：创建/编辑/启用（名称、描述、system prompt、图标、颜色、技能清单）
- P2: 会话创建时可选目标 agent（对应 ACP target_agent）；委托时可选 subagent 档案
- P3: 技能-代理绑定：agent 只暴露绑定的技能（对齐 agent_skill_assignments）
- P4: identity/working-style 分离注入（对齐对方避免 profile 覆盖风格）

**验收**：用户创建「单细胞分析专家」档案（自定义 prompt + 绑定 scRNA 技能）→ 新建会话选择该档案 → 行为符合自定义指令。

---

### G7. Artifact 环境快照与代码提取

**对方做法**（artifact_versions 表）：
```
extracted_code / code_description / environment_snapshot / is_intermediate
dependency_mappings / parent_version_id / lineage_messages
每个产物带生成代码 + 环境快照 + 血缘
```

**PureScience 差距**：有 artifact 版本化 + 血缘，缺 **environment_snapshot**（生成时的包环境）与 **extracted_code**（自动提取生成代码）。

**升级方案**：
- P1: artifact 创建时记录 environment_snapshot（conda env 包清单摘要）
- P2: 保存 figure/table 时自动提取生成代码块存入 extracted_code
- P3: UI「产物详情」新增 环境/代码/血缘 tab

**验收**：查看任一产物可看到生成时的包版本快照与来源代码。

---

### G8. 计算编排：remote compute 容器模板 + 并发上限

**对方做法**：
```
remote-compute-modal / remote-compute-ssh skills
compute/run.sh.tmpl + wrapper.sh.tmpl（容器执行模板）
session_concurrency 表（max_concurrent）
```

**PureScience 差距**：有 Modal/NVIDIA NIM 端点（v1.17.2 等价），但缺 SSH 密码认证（key-only）、无会话级并发上限。

**升级方案**：
- P1: SSH 密码认证支持（对齐对方 v0.18/v0.21）
- P2: session_concurrency：会话级最大并发委托/任务数 + UI 配置
- P3: 远程执行模板化（run.sh 生成）

**验收**：配置密码认证的 SSH 主机可执行远程计算；会话并发超限时排队提示。

---

## 2. 分阶段执行路线（6 个里程碑）

> 每阶段以版本代号命名（沿用 PureScience 中华科学代号体系），完成后打 tag + 发版。

### 里程碑 M1「衡」— 核验闭环（对应 G1）
- 目标：claim 级核验全链路上线，这是「超越」最可感知的差异化
- 交付：session_claims + verification_checks 表、reviewer claim 产出、核验清单 UI
- 验收：见 G1 验收；含 e2e 截图基线
- 版本：v1.25.0

### 里程碑 M2「简」— 可检索长上下文（对应 G2）
- 目标：summary_query + 两级折叠 + boundary 工具
- 交付：折叠持久化、summary_query ACP 工具、折叠 timeline UI
- 验收：200k+ 长会话数据可召回
- 版本：v1.26.0

### 里程碑 M3「聚」— 科学 MCP 生态（对应 G3，第一批 20 个）
- 目标：开箱即用的科学检索服务层
- 交付：MCPPool + 20 个内置 server + 依赖自装 + CN 适配
- 验收：pubmed/gnomad/pdb 等可用；离线降级友好
- 版本：v1.27.0
- **状态 ✅ 已闭环**：60 原子包对照 58 覆盖（含 M3 补的 CADD/DepMap/PanglaoDB——参考产品自身因许可门控禁用的 3 个源）；剩余仅 KEGG（许可限制，可选）。v1.31.0 补**许可门控机制**（工具级 `noncommercialOnly` + use-intent fail-closed，CADD 已标记）——从"覆盖齐"升级为"合规可讲"。

### 里程碑 M4「源」— 记忆溯源 + Artifact 快照（对应 G4 + G7）
- 目标：所有产出可溯源
- 交付：记忆 evidence/supersede、artifact env snapshot/code extraction
- 版本：v1.28.0

### 里程碑 M5「界」— 权限与写审计（对应 G5）
- 目标：deny-first + 审计可见
- 交付：deny list、写审计日志 + UI、MCP 细粒度授权
- 版本：v1.29.0

### 里程碑 M6「拓」— Agent 档案 + 计算编排（对应 G6 + G8）
- 目标：用户可编程的 agent 生态 + 远程计算完备
- 交付：user_agents 档案 + 技能绑定、SSH 密码认证、并发上限
- 版本：v1.30.0

### 里程碑 N1「律」— 定时任务编排 + 许可门控（2026-08-31 二轮深挖新增）
- 目标：agent 可编排周期任务（无人值守监控），数据源合规门控
- 交付：routine MCP（configure/status/cancel）+ 30s tick 调度器（missed/idle/stuck 记账、连败 3 次自动暂停）+ 设置面板「定时任务」+ `noncommercialOnly` 许可门控（CADD 标记，commercial 模式 fail-closed）
- 版本：v1.31.0

### 里程碑 N2「驻」— 本地模型服务 managed endpoints（2026-08-31 二轮深挖新增）
- 目标：守护进程托管本地模型服务器（容器/本地推理进程），生命周期全自动
- 交付：endpoint_* MCP（register/unregister/start/stop/status/list/free_port）+ 状态机（stopped→starting→live→failed + setStateIfStill 防竞态）+ 脚本 sha256 审批白名单（字节相同静默）+ 就绪路由探测放行 + 凭据 env 注入 + 设置面板「本地模型」+ llama.cpp runbook（首批 1 个模型，ESMFold2 等 13 个分批补）
- 版本：v1.32.0

### 里程碑 N3「注」— 文件注解 file annotations（2026-08-31 二轮深挖新增）
- 目标：文件级轻量注解（标签 + 备注），agent 与用户共用的低噪声记忆
- 交付：annotation_* MCP（set/list/remove）+ 项目级 JSON 持久化（targetKind/targetKey/label/contentChecksum 对齐统一注解表）+ 路径安全校验 + 文件面板行内注解弹窗（zh/en 双语）+ 模型 runbook 扩充（managed-bio-endpoints 通用托管模式 + fair-esm2/esmfold2 示例）
- 版本：v1.33.0

### 里程碑 N4「览」— PDF 分层阅读 pdf-explore（2026-08-31 二轮深挖新增）
- 目标：50 页 PDF 不占上下文——文本持久化 + 目录 + 相关度扫描 + 按需取页
- 交付：pdf_* MCP（open/pages/outline/scan）+ pdfjs 解析（逐页文本 + 书签大纲）+ 词频相关度扫描（无外部模型）+ 页/文档上限保护 + 扫描件空页识别
- 版本：v1.34.0

### 里程碑 N5「绘」— 出版级图表流水线 figure-style（2026-08-31 二轮深挖新增）
- 目标：科学图表正确性规则化——数据保真/label/色彩/选图/渲染五查，纯规则无审美
- 交付：figure_review MCP 工具（五条规则引擎，结构化面板输入 → 违规清单）+ figure-style 内置技能（完整规则文档 + 数据形态选图表）；figure-composer fan-out 与 paper-narrative 故事线审查分版推进
- 版本：v1.35.0

### 里程碑 N6「创」— 技能自举 skill bootstrap（2026-08-31 二轮深挖新增）
- 目标：技能创建/评估/迭代循环——描述 trigger 优化器 + 技能库检视
- 交付：skill_eval（描述可触发质量 0-10 分评估器：首句自包含/动作词/具体主题/关键词/长度 + 改写建议）+ skill_list/skill_read（技能库检视，防重复造轮子）+ 与既有 create_skill 组成自举循环；纯规则无外部模型
- 版本：v1.36.0

### 里程碑 N7「省」— Agent 自省 host_query（2026-08-31 二轮深挖新增）
- 目标：agent 只读自省应用数据库——查自己做过什么、项目什么状态
- 交付：host_query MCP 工具（SELECT-only + 表白名单 + 项目隔离后置过滤 + 200 行 cap）+ self-awareness 内置技能（11 张自省表参考 + 示例查询）
- 版本：v1.37.0 —— **N1-N7 编排层差距全部清零**

### 持续项（贯穿全程）
- **实测驱动**：每个机制上线前先建 benchmark（复刻对方 bench-reviewer 方法），用数据说话
- **i18n**：所有新 UI 同步 zh/en
- **测试**：每表/每工具补单元 + 交互测试（全量并行不 flaky）
- **发布**：npm run build 后打包验证（含 CFBundleShortVersionString + asar 校验）

---

## 3. 优先级与依赖关系

```
G1 核验闭环 ──┐
G2 长上下文 ──┼── 无依赖，可并行（M1/M2 同批或顺序推进）
G3 MCP 生态 ──┼── 依赖：无（独立服务层）
G4 记忆溯源 ──┼── 依赖 G3 的 MCPPool 模式（可独立）
G5 权限审计 ──┼── 依赖 G3（MCP 授权细化）
G6 Agent 档案 ─┼── 依赖 G1（reviewer 复用）可选
G7 Artifact 快照 ─┼── 无依赖
G8 计算编排 ──┘
```

**推荐顺序**：M1 → M2 → M3（含 M5 的 deny list 先行）→ M4 → M6 → M5 收尾 → M7(G7)。

---

## 4. 保持差异化（不追平的部分——对方没有而我们有的）

| 能力 | 说明 | 动作 |
|---|---|---|
| 生物医药垂直案例 | EGFR/KRAS、Mpro 对接+MD、单细胞、GLP-1 等 14 个真实项目 | 持续扩充案例库（已存 ~/PureScience-DEV） |
| 中文体验 | 深度 zh 本地化 + 术语表 | 新功能全部双语，术语表持续回填 |
| CN 网络适配 | CDN 镜像、离线自愈、镜像源 | MCP server 安装走 CN 镜像 |
| BYOK 多提供商 | 20+ 提供商（含 GLM/DeepSeek/Grok） | 持续跟进新模型目录 |
| GPU serverless | Modal/NVIDIA NIM | 保持领先，对标 G8 扩展 |
| 引用诚实性 | ✅已验证/⚠️待验证 分离（用户硬性要求） | 与 G1 核验闭环打通——claim 的 evidence 即引用核验 |

---

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| MCP 生态量大（87 个）移植成本高 | 按价值分批，首批 20 个；复用对方纯 Python 实现（Apache 等宽松许可需核实） |
| 网络（海外 API 慢/不可达） | 每 server 配 CN 镜像/超时/降级；离线缓存优先 |
| 长上下文改造影响现有会话 | 折叠仅对新建会话启用（feature flag），旧会话保持现行为 |
| 核验闭环可能拖慢主 agent | reviewer 用独立模型 + 实测决定 thinking 开关（对齐对方 bench 方法） |
| 许可合规 | 移植 MCP server 前逐一核实许可（对方 vendored 多为 MIT/Apache） |

---

## 6. 验证方法（每个里程碑）

1. 单元测试 + 交互测试全绿（vitest 全量并行）
2. typecheck + electron-vite build + build:web 通过
3. electron-builder 打包 + 安装 + 启动（compose-runtime 无 error）
4. e2e 截图基线（新 UI 面板逐屏）
5. 真实场景走查：用一个科学任务（如「查询 gnomAD 中 EGFR T790M 变异频率并核验」）端到端演示
6. GitHub 推送 + 本地保存双份

---

*本文档由 对标产品 CS v0.1.15 深层剖析驱动，差距清单 G1–G8 均来自对方实际代码（drizzle schema / bundle 事件枚举 / agents metadata / mcp-servers 目录），非推测。*
