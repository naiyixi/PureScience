# aipoch/open-science 竞品跟踪 · v0.20.0 差距分析
## 2026-08-26 快照（PureScience v0.14.3）

> 目的：诚实量化我们相对直接竞品 aipoch/open-science 的现状，作为 ROADMAP 与官网"诚实矩阵"的更新依据。
> 方法：对比 aipoch 官方 releases API（v0.16.0–v0.20.0）+ ROADMAP + 近 18 个 commit，与 PureScience 代码库关键词扫描。
> 诚实标注：✅=PureScience 已有 / 🟡=部分或待完善 / ⬜=缺少或待建设 / 🔴=对方已发而我们暂无。

---

## 一、版本节奏差距（最刺眼的事实）

| 维度 | aipoch/open-science | PureScience |
|---|---|---|
| 当前版本 | **v0.20.0**（2026-08-25）+ nightly 日更 | **v0.14.3** |
| 近一个月发布 | v0.16 → v0.17 → v0.18 → v0.18.1 → v0.18.2 → v0.19 → v0.20 = **7 个 release** | ~1 个小版本 |
| 提交量 | main 分支 **1,320 commits** | 较少 |
| 社区 | **2.9k star / 202 fork / 93 watching** | 待增长 |

**结论：PureScience 在代码发布节奏上落后约 5-6 个小版本、一个月迭代量。诚实承认，不夸大。**

---

## 二、对方近月新能力 → 我方差距清单

按 aipoch v0.16.0–v0.20.0 五项 release note + ROADMAP + 最新 commit 归纳：

### A 组 · 对方已发 · PureScience 暂无（🔴 明确缺口）

| # | 能力 | 来源 | 优先级 |
|---|---|---|---|
| A1 | **跨会话引用（`#` session-ref）** — composer 插 chip，agent 只读引用另一会话 | v0.20.0 | P0 |
| A2 | **Side Chat 中段 advisory 触达主 agent** — 运行中主 turn 实时收侧聊提示 | v0.20.0 | P0 |
| A3 | **Token 用量仪表盘**（周期汇总 + 活动图） | v0.16.0 | P1 |
| A4 | **xAI (Grok) OAuth 订阅** — 一账号驱动 Grok 跨框架 | v0.19.0 | P1 |
| A5 | **GLM-5.3 / GLM-4.5-Air 提供商**（智谱） | commit 2026-08-26 | P1 |
| A6 | **场景模型卡（Scenario models card）** 统一编排子代理/审查/视觉模型策略 | v0.20.0 | P1 |
| A7 | **Notebook 跨运行依赖追踪（tree-sitter WASM）** — 变量变更自动标 stale | v0.19.0 | P1 |
| A8 | **多语言界面：韩 / 法 / 俄**（本地化持续扩张） | v0.18–v0.18.2 | P2 |
| A9 | **Marketplace 治理** — 已装包只读、SemVer 基线、统一安装/更新/卸载生命周期 | v0.19.0 | P1 |
| A10 | **上下文压缩可见化 + SQLite 元数据索引**（快速首屏 / 搜索会话编号） | v0.19–v0.20 | P2 |

### B 组 · 对方已有 · PureScience 部分覆盖（🟡 需补强）

| # | 能力 | PureScience 状态 |
|---|---|---|
| B1 | 持久 Vision 证据中继（纯文本模型也能分析图） | 有 vision 配置但未"中继"化 |
| B2 | 会话内 subagent 委派（durable messaging） | 多代理有，durable 消息待完善 |
| B3 | SSH 密码认证 compute host | 有 SSH HPC，密码认证待查 |
| B4 | 代理运行时选择（Claude Code / OpenCode / Codex） | 已支持（Codex 2351 命中、OpenCode 402 命中）|
| B5 | 会话导出（含选定轮次）+ archive undo | 有导出，archive undo 待查 |

### C 组 · 双方均有（✅ 已对齐）

- 中文界面（简繁） · 本地优先 · 模型无关 · 24 连接器 · 35+ 技能
- 不可变产物 + provenance · 审批 profile · 远程 compute · 多内核 notebook
- 离线安装器 · macOS/Win/Linux · 自动更新 · 数据根可配置

---

## 三、对我方独有优势的影响

**不变的核心差异化（竞品给不了）：**
- **35+ 内置科研技能（含 BioNexus 生物医学包）** — 竞品依赖 skills 目录，我们的内置规模更大
- **12,452 测试全绿 + 59 万行 TS + RELEASE-CERTIFICATION** — 工程严谨度
- **七题全过实测证据墙**（docs/demo-verification/）— 竞品无此级验证资产
- **中国市场可用 + 国产模型直连 + HGR 合规本地执行** — 竞品在中国不可用
- **中英双语完整 + DeepSeek 深度集成（163 命中）**

**需要补的差距（影响"代际领先"叙事）：**
- 版本迭代节奏与社区声量（2.9k star）— 影响营销可信度，需补 roadmap 进展
- 跨会话引用、token 仪表盘、Grok OAuth 等交互/集成项 — 影响体验完整度

---

## 四、行动建议（按优先级）

1. **P0（近期）**：跨会话引用（`#`）+ Side Chat advisory 触达主 agent + GLM-5.3 提供商接入
2. **P1（本季度）**：Token 用量仪表盘 + Grok OAuth 订阅 + Notebook 依赖追踪 + Scenario 场景模型卡
3. **P2（半年）**：多语言扩张（韩/法/俄）+ Marketplace 治理 + SQLite 元数据索引
4. **持续**：提升发布节奏（目标月更），活跃社区（star/fork/discussion）

---

*本分析基于 2026-08-26 aipoch/open-science 公开 release + commit + ROADMAP；PureScience 端基于代码关键词扫描，存在低估可能，需人工复核确认。*
