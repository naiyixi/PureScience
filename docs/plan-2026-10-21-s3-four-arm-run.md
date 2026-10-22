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

## 2.1 一个必须先说清的架构事实（2026-10-21 核实）

物化不是**每次 run** 发生的：`provisionAppClaudeConfigDir()` 由 `skill-catalog` 在应用级
配置目录上调用，产物落在全局的 `configDir/skills/os-*`。也就是说：

- 现在**没有**「这次 run 用哪套技能文件」的概念，只有「这个应用安装现在是什么样」；
- 因此 `POST /api/v1/runs` 加一个 per-run `ablation` 字段**在今天是不可能生效的**——
  它会被写进请求、然后在物化时被忽略，正是本仓最反感的"看起来有、其实没有"。

结论：臂必须按**先后顺序**改变全局物化状态，而不是随 run 参数走。于是 pilot 的做法改为：

1. 施加一臂（重新物化，带/不带 `stripContracts`）；
2. 立刻跑该臂的 run，并取证判分；
3. **马上恢复**默认臂（重新物化回带契约），避免影响用户后续会话；
4. 两臂分两次做，不并发；跑之前确认没有用户会话正在使用同一配置目录。

这条限制写进 pilot 报告：两臂不是"同时可比"，而是"同机、同模型、同 runtime、先后各一次"，
证据里必须带各自的 run id 与施加臂的时间戳。

## 3. 物化层要动的最小面

`ClaudeCodeSkillMaterializer`（`src/main/skills/materializer.ts`）在写出 `SKILL.md` 时按
`ablation` 决定是否保留 `contract:` 行。要求：

1. 只删 `contract:` 这一行，其余 frontmatter 与正文逐字节不变（可测：同一技能两种臂的产物
   diff 只有该行）。
2. 默认路径零改动：不传 `ablation` 时输出与今天完全一致（回归测试用快照锁住）。
3. 物化结果里记录本次臂（`ablation` 写入技能目录旁的 run manifest），让取证时能回答
   "这次跑的是哪一支"——否则两个 run 的差异无法归因。

## 3.1 环境要求（2026-10-21 实测踩到）

第一次尝试起 pilot 实例时踩到两个环境事实，记下来免得下次重演：

1. **必须没有并发实例**。本机当时另有两个 Electron 实例在跑（一个 headless、一个 dev），
   可用内存只剩约 60 MB；`electron-vite dev` 的 esbuild 在 transform 阶段直接 Go panic 退出，
   `electron .`（已构建）则**静默退出、无任何输出**——看起来像"启动脚本写错了"，其实是内存。
2. **`electron .` 不是 headless 的受支持入口**。仓库里 headless 只有两条路：
   `electron-vite dev -- --purescience-headless`（dev）与打包版二进制；用构建产物直接
   `electron .` 不会起 web 服务。

因此 pilot 的前置条件写成清单：无并发实例、内存充足、用受支持的启动入口。
未满足时 pilot 不跑，也不拿旧实例顶替——旧实例是 v2.15.2，没有 `/sessions/:id/evidence`。

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

## 5.1 实测发现：预检没有可用的注入面（2026-10-22）

要把"契约"变成"agent 真的会用的东西"，得先找注入点。实测三个候选都不通：

| 候选 | 实际情况 |
|---|---|
| `skill_read` 工具 | HTTP 传输层直接抛错（`Skill library reads are unavailable over the HTTP transport`）——opencode 走不走这条都读不到；claude-code 侧也不保证 |
| 技能文件（`opencode/.../skills/os-*`） | agent 要主动打开文件才看得到 frontmatter 里的 contract；pilot 观测到它基本不打开 |
| `opencode/instructions/purescience.md` | 是**安装级**文件，不是会话级——写进去会跨会话串味 |

所以"契约层价值"测不出来，根因不是模型，而是**没有会话级的注入面**。

### 需要拍板的两条路

| 方案 | 形态 | 代价 |
|---|---|---|
| **A. 每会话 MCP 工具 `capability_preflight`** | 与 reviewer/skills 同族的 MCP server，按 session 计算 facts，返回 ready/missing/suggested | 中：新增一个 MCP server + 工具；需按六处计数规矩联动 |
| B. 会话级指令片段 | 每会话生成 instructions 片段并在物化时写入会话专属配置目录 | 大：需要打开 opencode 的会话级配置能力，或为每会话单独 provision 配置目录 |

我倾向 **A**：语义清楚（"问一下这一步能不能跑"）、可测、不会串会话；代价是要动 MCP 表面。

## 5.2 真机验证：opencode 拿到的 MCP 服务是**零个**（2026-10-22）

起了一个 opencode headless 实例（`/tmp/ps-vp`，端口 44320），跑完 `claim-calibrated-to-evidence`
（session `ses_e9c12f850ffeCT8zI31dw2vIXG`，原子 0.33），然后读它自己生成的配置：

```
/tmp/ps-vp/opencode/config/opencode/opencode.json →  "mcp": {}      # 空
```

对照 claude-code（本机安装根真实 transcript）：

```
mcp__purescience_skills__{skill_list, skill_read, skill_eval, request_skill_import, create_skill}
mcp__purescience_notebook__* / mcp__purescience_pdf__* / mcp__purescience_plan__* ...
```

也就是说：

- **claude-code**：技能服务挂着，`capability_preflight` 自动随行；
- **opencode**：**一个 MCP 服务都没有**——没有 skill_read、没有 preflight、没有 notebook 工具。

### 这条改变了此前 30+ 份记录的解释

之前的 pilot 全在 opencode 上跑，因此那些记录测的是"opencode + 只有文件形态的技能"：

- 「agent 从不打开技能」**不是行为偏好，而是结构使然**——它没有 skill 工具可调；
- 契约消融在这些记录里接近空操作，除了"没环节消费契约"，还叠了"这个 runtime 连工具面都没有"。

所以：**契约效应实验必须换到工具面真的挂上的 runtime**（claude-code），或先给 opencode 接上 MCP。

### 两条路

| 方案 | 说明 | 代价 |
|---|---|---|
| **A. 给 opencode 写 mcp 段** | 用已有的 HTTP MCP host（`host.urlFor('skill-import', routingId)`）生成 `type: remote` 条目 | 中：opencode 配置写入 + 路由 id 生命周期 + 权限提示 |
| B. 换 claude-code 跑实验 | 工具面现成 | 需可用凭证（开发构建拿不到钥匙串密钥，此前正是因此切到 opencode） |

## 6. 不做

- 不做"只注入文档"与"只给工具名"这两个臂（需要正文/工具清单裁剪，另立项）。
- 不把臂开关放进设置面、不随会话持久化。
- 不用估算模型代替真实 run：没有 run id 的分数不进报告。
