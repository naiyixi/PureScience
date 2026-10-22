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

## 5.2 真机核查（含一次自我纠正，2026-10-22）

起 opencode headless（`/tmp/ps-vp`，端口 44320）跑 `claim-calibrated-to-evidence`
（session `ses_e9c12f850ffeCT8zI31dw2vIXG`，原子 0.33），读它的 `opencode.json`：

```
"mcp": {}      # 空
```

**我一度据此判断「opencode 拿不到任何 MCP 服务」，这是错的。** 复查代码：
MCP 服务经 ACP 的 `buildSession({ mcpServers })` 传入（`provider-session-creator.ts:109`、
`provider-session-resumer.ts:250`），**不写进 opencode.json**——那个文件为空是预期行为，
`agent-framework/opencode.ts` 的注释也写明 opencode 走 stdio、与 Claude 同一套配置。

结论撤回：opencode 与 claude-code 都拿到同一批 stdio MCP 服务（artifact / notebook /
skill-import …），因此 `capability_preflight` 在两边都应可见。claude-code 侧有真实 transcript
作为旁证（`mcp__purescience_skills__*` 5 个工具）。

### 仍未证的那件事

「agent 到底会不会调用这些工具」——此前 pilot 记录里看不到技能工具调用，但当时没有专门
检查工具调用序列，因此**不能**再解释成"它没有工具"。要回答，只能看真实 run 的 transcript
里有没有 `capability_preflight` / `skill_read` 的调用条目。

### 方法教训

判断「某个 runtime 有没有某能力」时，配置文件的空值不是证据——要顺着运行时的实际传参路径
（这里是 ACP 的 session 参数）或直接看 transcript。差一步就会把一个 self-inflicted 的
假发现写进结论。

## 5.3 真机取证：工具存在，但一次都没被调用（2026-10-22）

给 run 记录加了 `toolCallNames` 之后，同一案例的重跑给出了可读的答案
（`docs/bench-runs/2026-10-22T14-25-10-165Z-claim-calibrated-to-evidence-full-contract.json`）：

```
atomic 0.33   status completed
tools ["execute", "other"]   count 2
capability_preflight called: false
```

也就是说：

- 工具**确认挂载可用**（上一节：MCP 服务经 ACP 传参，claude 侧有 transcript 旁证）；
- 但这一次真实运行里，模型只发了 2 次工具调用（`execute` + 一个无名的 `other`），
  **没有 skill_read、没有 capability_preflight、也没有 notebook 工具**；
- 于是两臂差异为零的原因第三次得到确认：**不是契约不可见，而是模型根本不问。**

这条把"契约层有没有价值"的问题改写成了另一个更实际的问题：
**靠模型自觉调用工具来消费契约，不成立**——至少在 `deepseek-v4-flash` + 单轮文本任务上不成立。

### 由此得到的选路

| 做法 | 说明 | 判断 |
|---|---|---|
| 继续加工具/加契约覆盖 | 模型不调用，加得再多也是零作用面 | ✗ |
| **把预检结果注入回合上下文** | 不需要模型主动问，缺口在执行前就已写在提示里 | ✓ 下一步 |
| 把预检设为某些技能的前置硬门 | 与 G1（只建议不阻断）冲突，且会误杀合法路径 | ✗ |

结论：`capability_preflight` 作为"可问的工具"保留（对会问的模型/运行时有用），
但**契约效应的实验必须改成注入式**，否则测的永远是"模型要不要问"。

## 5.4 注入打通（真机证据，2026-10-22）

沙盒根补上当前资源（`resources/skills` → `<root>/skills`，20 个契约）后跑同一案例，应用自己的日志：

```
declared contracts in sandbox: 20
[capabilities] capability gaps notice {
  sessionId: 'ses_e9b929f5effeEBrDW14bqXeHQk',
  sessionFound: true,
  injected: true,
  lines: 12,
  chars: 1281
}
atomic 0.333   tools ["execute","other"]
```

三件事同时被证实：

1. **注入真的发生了**：12 条缺口、1281 字符进入该回合的 provider content；
2. **它是逐轮的**：同一会话不同回合会重新计算（facts 变了，文本就变）；
3. **模型仍然没理它**：本次仍是 0.333、2 次工具调用。这个案例是纯文本论断校准，
   缺的是组学输入——它不做组学步骤属于**合理**行为，不能算「忽略了提示」。

### 过程中踩到的两个真问题（都已修）

| 问题 | 现象 | 修法 |
|---|---|---|
| ACP 会话 id 与会话库 id 不同 | `sessionFound: false`，注入静默为空 | 在 prompt 组合处先 `resolveAppSessionId` |
| 「查不到会话」与「没有缺口」共用一句 `injected: false` | 掩盖了上一条 | 返回 `{ block, sessionFound }`，日志两个字段都记 |

### 一条部署事实

契约来自 `resources/skills` 的 frontmatter，而**已安装的旧资源里没有 `contract:`**。
所以现网升级后，要等技能资源重新物化，注入才会有内容——沙盒里我们手工补了这一步。

## 5.5 第一次注入对照 —— **实验无效，由我自己的设置造成**（2026-10-22）

两臂各 3 次 `figure-axis-discipline`：

| arm | 原子 | 工具调用 | 状态 |
|---|---|---|---|
| full-contract | 1.00 / 1.00 / 1.00 | read/edit/execute 等 | completed |
| no-contract | 1.00 / 1.00 / **0.33（0 次工具调用）** | — | 第三条记录 `running`，无效 |

看起来像"全契约 3/3、无契约 2/2+1 无效"，但**这个对照不成立**：

```
grep 'injected: true' /tmp/ps-arm-f/run.log → 5
grep 'injected: true' /tmp/ps-arm-n/run.log → 3    ← 本该一条都没有
grep -l 'contract:' /tmp/ps-arm-n/skills/*/SKILL.md | wc -l → 20
```

原因：为了让沙盒有契约，我把 `resources/skills` 直接拷进了 `<root>/skills`。
而消融是在**物化时**剥掉 `contract:` 的——我手工拷贝绕过了物化，于是两臂读到同一批 20 个契约，
注入完全相同（都是 12 行 / 1281 字符）。**被测变量根本没变。**

### 方法教训

1. 消融必须作用在它真正生效的那一步（物化），不能手工构造"看起来对"的输入；
2. 跑完先验证**操纵检查**（manipulation check）：两臂的注入计数必须不同，
   否则后面的分数一律不可读。这次是先看分数、后看日志，顺序反了。

### 重跑条件（下一次）

- 让应用自己物化技能（不要预拷贝 `resources/skills`）；
- 开跑前断言 `full-contract` 的 `injected: true` 次数 > 0 且 `no-contract` 严格为 0；
- 断言不成立就中止，不采信分数。

## 5.6 第二次对照 —— 操纵仍未成立，但拿到了方差基线（2026-10-22）

这次不手工拷资源，让应用自己物化。跑完的操纵检查：

```
full-contract: injected_true=0   contracts_on_disk=0
no-contract  : injected_true=0   contracts_on_disk=0
```

**两臂都没有契约**——`<root>/claude/skills` 里的 `.catalog_stamp` 与版本相同，物化被跳过，
于是保留下来的还是那份没有 `contract:` 的旧文件。操纵再次没成立，分数依旧不可读。

### 但这一轮有个真结果：**无操纵时的方差**

两臂条件完全相同（都没有注入），同一道题 6 次：

```
1.00  1.00  0.33  1.00  1.00  1.00
```

也就是说，**在没有任何差异的情况下，这道题本身就能产出 0.33**（那一次的模型一次工具都没调）。
含义很直接：

- 用 n=3 比两臂，看到 2/3 vs 3/3 也说明不了任何事；
- 想分辨小于「1/6 翻转率」的效应，这道题至少要 10+ 次/臂，且必须报告翻转率而不是平均分；
- 或者换一道**基线不稳**的题（现在的题大多 1.00，天花板效应严重）。

### 下一次的正确起点

1. 删掉沙盒里的 `.catalog_stamp`（或整个 `claude/skills`）强制物化；
2. 操纵检查先跑：`full` 必须有 `injected_true>0`、`no` 必须为 0，否则中止；
3. 每臂 ≥10 次，报告命中率与翻转次数。

## 5.7 第三次重跑：三层原因，前两层是产品 bug（2026-10-22）

操纵检查反复失败，逐层挖下去，**前两层都是产品缺陷，不是实验设置**：

| 层 | 缺陷 | 后果 |
|---|---|---|
| 1 | 注册表只扫 `<configRoot>/skills` | 真实安装 89 个内置技能在 `claude/skills`，一个都没被看见（`4b94b069` 修：多根） |
| 2 | 物化目录名 `os-<id>`，契约声明裸 id，解析器要求 `id === expectedId` | **每个**物化副本产出 `id_mismatch` 被丢弃（`50e82458` 修：剥前缀后比较） |
| 3 | 沙盒本身：`.os-versions.json` 让物化跳过；且 opencode 与 claude 的物化目录不同 | 前两轮"全契约臂"其实也没契约 |

第 3 层仍未彻底解决：最新一次沙盒里 `opencode/` 目录根本没被创建，注入计数为 0，
分数（0.33 × 3）因此依旧不可读。

### 这轮真正的产出

不是实验结论，而是**两个会让能力契约在真实安装里完全失效的 bug**：

- 修 1 之前：任何真实安装都不会有 `declared` 能力；
- 修 2 之前：即使修了 1，物化副本的契约也全部被拒；这两个 bug 叠加起来，
  等于"契约层在现网从未生效过"，而单元测试因为用的是无前缀的夹具目录，一直是绿的。

### 结论与建议

手搓沙盒已经连续三次在环境细节上失败（stamp、目录、runtime 目录），继续手工搭建的边际收益很低。
建议改为：**给应用加一条 bench 专用的物化+取证入口**（一条命令完成"按臂物化 → 起会话 → 跑题 → 落记
录 → 报操纵计数"），把这次踩到的每个坑固化成断言，再谈分数。

## 5.8 第一次**有效**的对照：20/20 通过操纵自检，效应为零（2026-10-22）

修好三层（多根、`os-` 前缀、会话 id）并重建之后，注入终于真的发生。两臂各 10 次
`claim-calibrated-to-evidence`：

| arm | n | 通过操纵自检 | Pass@1 | 平均原子 | no-proof-language | hedge-present | citations-support-claims |
|---|---|---|---|---|---|---|---|
| full-contract | 10 | **10/10** | 0/10 | 0.33 | 10/10 | **0/10** | **0/10** |
| no-contract | 10 | **10/10** | 0/10 | 0.33 | 10/10 | **0/10** | **0/10** |

（full 臂每次运行 `noticeInjectedTurns=1`，no 臂恒为 0 —— 操纵这次是成立的。）

### 结论

1. **在这道题上，缺口注入没有任何可测效应**，而且这个零不是"操纵没做到"造成的；
2. 但这是一道**天花板题**：`citations-support-claims` 永远不可能通过，因为证据层
   `collected.citations` 固定为 `false`（引用从未采集）；`hedge-present` 两臂 0/10。
   最高分就是 0.33 —— 一道及格线锁死在 1/3 的题，测不出"有没有变好"；
3. 所以这个结果只能说明"注入没让这道题变好"，**不能**推广成"契约层无价值"。

### 下一次选题的三个硬条件

- **该项检查有能力通过**（证据层必须采集它依赖的证据类；引用题先修 citations 采集）；
- **注入的缺口与该题相关**（本次注入讲的是组学输入，题目是纯文本论断校准）；
- **基线不稳但有提升空间**（0.33 这种锁死基线没有分辨率；1.00 天花板同样没有）。

## 6. 不做

- 不做"只注入文档"与"只给工具名"这两个臂（需要正文/工具清单裁剪，另立项）。
- 不把臂开关放进设置面、不随会话持久化。
- 不用估算模型代替真实 run：没有 run id 的分数不进报告。
