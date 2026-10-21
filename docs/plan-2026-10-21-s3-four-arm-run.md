# Plan 2026-10-21 · S3 四臂运行（设计先行）

> 前置：`docs/plan-2026-10-21-v2.17-scibench-v1.md`（题库/评分器/比较器已就位）、
> `/api/v1/sessions/:id/evidence`（取证已就位）。
> 本文只回答一件事：**臂差异靠什么物理杠杆实现**，以及 pilot 的验收口径。

## 1. 先说清一个事实

产品里"给模型看什么"目前只有一个杠杆：**技能物化**。运行时看到的是物化出来的
`SKILL.md`（frontmatter 含 `contract`）＋ 技能目录（名字/描述）。没有"注入全文"与
"只给工具名"这两个独立开关。

因此计划里的四臂，物理上能区分的是**两支**：

| 计划臂 | 物理动作 | 能否区分 |
|---|---|---|
| A4 full-contract | 现状（frontmatter 带 contract） | ✅ 可跑 |
| A1 baseline / A2 doc-only / A3 named-no-contract | 三者在当前产品里**是同一件事**：契约不出现在物化产物里，文档仍可 `skill_read` 读到 | ⚠️ 合并为「no-contract」一支 |

与其伪造四臂，不如先跑两支并把话说清：**这一版能量的是「契约层在不在」的效应**；
"只注入文档"与"只暴露工具名"要等物化层支持按臂裁剪正文/工具清单后才能分开。

## 2. 臂开关的形态（拍板）

- 位置：headless 任务面 `POST /api/v1/runs` 的请求体新增可选字段
  `ablation: 'full-contract' | 'no-contract'`，**缺省 full-contract**。
- 作用域：只影响本次 run 的物化产物（stripping `contract:` 行），不写用户设置、不改全局。
- 桌面面不接受该字段；收到即拒绝（`ablation_requires_headless`），避免把研究开关变成产品开关。
- 未实现的臂（`doc-only` / `named-no-contract`）必须**显式拒绝**并给出原因，不得静默降级成
  `no-contract`——否则一次「四臂」实验会在数据里变成两支却没人知道。

## 3. 物化层要动的最小面

`ClaudeCodeSkillMaterializer`（`src/main/skills/materializer.ts`）在写出 `SKILL.md` 时按
`ablation` 决定是否保留 `contract:` 行。要求：

1. 只删 `contract:` 这一行，其余 frontmatter 与正文逐字节不变（可测：同一技能两种臂的产物
   diff 只有该行）。
2. 默认路径零改动：不传 `ablation` 时输出与今天完全一致（回归测试用快照锁住）。
3. 物化结果里记录本次臂（`ablation` 写入技能目录旁的 run manifest），让取证时能回答
   "这次跑的是哪一支"——否则两个 run 的差异无法归因。

## 4. Pilot 协议（先 1 题，再 16 题）

1. 选 1 题（`checkpoint-resume-order` 这类**不依赖外部 API** 的题，先排除网络噪声）。
2. 同一模型、同一 runtime、同一种子，跑 `full-contract` 与 `no-contract` 各 1 次。
3. 用 `/api/v1/sessions/:id/evidence` 取证 → `evaluateBenchCase` 判分 → 落
   `docs/bench-runs/<date>-pilot.json`（含 run id、模型、arm、evidence 摘要）。
4. **先看判分是否说得通**，再扩到 16 题。判分说不通就修判据，不修数据。
5. 成本口径不变：未记账前只报 token 与墙钟，不报美元。

## 5. 验收（pilot 阶段）

- 同一题两次运行的证据都能导出，且 `collected` 字段如实（缺的类别不补零）；
- `comparabilityProblems(runs)` 为空（同模型/同 runtime/同种子）；
- arm manifest 能证明"这次跑了哪一支"，且默认路径产物与今天逐字节一致；
- pilot 报告写进 `docs/BENCHMARK.md` 之前先生成 `docs/bench-runs/` 原始 JSON。

## 6. 不做

- 不做"只注入文档"与"只给工具名"这两个臂（需要正文/工具清单裁剪，另立项）。
- 不把臂开关放进设置面、不随会话持久化。
- 不用估算模型代替真实 run：没有 run id 的分数不进报告。
