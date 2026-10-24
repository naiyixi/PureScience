# 交接：完成剩余排期（v2.17.3 起）

> 这份文件是给**新会话**的作业单。它假定你没有任何上下文：读完就能开工，不需要再问。
> 基准点：仓库 `~/purescience`，`main` 在 `c16e5d77`，版本 `2.17.2`（已发布、latest）。

---

## 0. 环境与硬规矩（先读，违反会浪费一整轮）

### 仓库与推送

- 工作目录 `~/purescience`；远端 `https://github.com/naiyixi/PureScience.git`，账号 `naiyixi`，git 身份 `zerolink <naiyixi@gmail.com>`。
- 该仓库有 git hooks（husky/gitleaks）：提交用 `git -c core.hooksPath=/dev/null commit`，推送前跑 `bash scripts/pre-push-checks.sh`。
- `docs/**`、`**/*.md` 在 CI 的 `paths-ignore` 内 —— 纯文档提交**不触发 CI**。所以「文档改了但 CI 没跑」不等于失败，也意味着文档类修复要等下一次非文档提交才会被 CI 复核。

### 提交前的门禁（缺一不可）

```bash
cd ~/purescience
npx prettier --write <改动的文件>
npx eslint --cache=false <改动的文件>
NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck     # 必须 node + web 都过
npx vitest run <相关目录或文件>
bash scripts/pre-push-checks.sh                              # 推送前
```

- `npm run build` 必须带 `NODE_OPTIONS=--max-old-space-size=8192`，否则 tsc/vite 会 OOM abort。
- 共享树里如果 Prisma client 过期，双 typecheck 会红在 `citedAt`/`citedSessionId` —— 先 `npx prisma generate`。

### 发版仪式（每一次发版都一样）

四个文件必须一起改，**CHANGELOG 新段覆盖自上一 tag 起的全部提交**（不是只写自己那笔）：

1. `package.json` 的 `version`
2. `CHANGELOG.md` 新段（含「成熟度自陈」「真机读数」「明确没做 / 未验证」三块）
3. `README.md` + `README.en.md` 的 `> 💡 **[PureScience vX.Y.Z released]**` 横幅（**两处文本必须逐字一致**）
4. `dist/notes-X.Y.Z-zh.md`（必须含未签名声明，脚本会校验）

然后：

```bash
bash scripts/pre-push-checks.sh
git push origin main
NODE_OPTIONS=--max-old-space-size=8192 bash scripts/publish-release.sh X.Y.Z --notes-file dist/notes-X.Y.Z-zh.md
```

### CI 判读的三个坑（都踩过）

1. **查 CI 必须用完整 40 位 SHA**：`gh api "repos/naiyixi/PureScience/actions/runs?head_sha=<FULL_SHA>"`，短 SHA 会误判「没触发」。
2. `cancel-in-progress` 会顶掉上一次 run ⇒ **「cancelled」不等于绿**，只认当前 HEAD 的结果。
3. **有 Release 页的 tag 不要删后重打**；无 Release 页的 tag 才可以删了重建。**不要单独重跑 publish job**（会同名重复产物，publish 报 missing）。

### 内容纪律（这个项目最看重）

- **不许编造**：任何数字、耗时、覆盖率必须来自真实命令输出；没跑过就写「未验证」。
- **降级必须被命名**：不能静默跳过，不能把「未完成」说成「完成」。
- **契约只声明能被验证的事实**；声明验证不了的前置 = 自造误报。
- 交付必须**优于**对标而非平齐：每功能先列差异化点（可执行核验 / 溯源 / 中文场景 / 权限门）。
- README 里有个守卫 `src/main/connectors/readme-connector-count.test.ts`：任何 `N tools` / `N connectors (` 的措辞都会被当成数字声明并与注册表比对（当前 282 tools）。写横幅时**不要出现「85 tools」这种短语**，用「85 tool calls」。

---

## 1. 当前状态快照

| 版本 | 状态 |
|---|---|
| v2.16.0（P0）| 契约/Registry/Preflight/失败族已落地；机检 ①✅ ②✅(n=30, 100%) ③⚠️1/4 ④✅ |
| v2.16.1 | Claude 会话建立失败修复（重试 + 具名报错）|
| v2.17.0 | 每轮注入开销 2.9×→测不出；第三方工具 skill 证据；启动阶段计时 |
| v2.17.1 | 交付物规则改**每轮提醒**（模型不产文件的真因）；隧道 egress 未捕获异常；设置探测缓存；connector 契约 3 个生产者 |
| v2.17.2 | **只加读数**：慢保存日志带 `queueBlockers` |
| v2.18.0 / v2.19.0 | **未开工** |

**已完成、不要重做**：

- **Claude 真机验证**：用户已在 2.17.1 上验完 —— Notebook 标签自动出现、任务自动产出文件（AAVrh74 任务 38 次工具调用 / 2 产物；BCL11A 任务 10 次 / 4 次调用 / 2 产物，全 completed）。已归档进 CHANGELOG v2.17.2。
- **四臂消融**：只跑通两臂（`full-contract` vs `no-contract`）。`baseline` 被 always-on 策略拒禁、`named-no-contract` 无对应机制 —— 结论已写在 `docs/BENCHMARK.md:111` 与 `:168`。**不要试图造一个用户到不了的状态**。

---

## 2. 待办清单（按建议顺序，逐项独立可交付）

### 任务 A — v2.17.3：队列优化（先读数，再改）

**背景**：真机 17:00–18:00 窗口，149 次 `sessions:save-session` 被判慢。最慢三条：

| queuedMs | writeMs | writeDiskMs |
|---|---|---|
| 23,294 | 15 | 6 |
| 15,099 | 35 | 27 |
| 14,800 | 7 | 5 |

p90 排队 **14.2 秒**，写盘始终 < 40 ms ⇒ 时间花在排队。

**已就绪的仪器**（v2.17.2）：`src/main/session-persistence/coordinator.ts`

- `enqueue(label, task)`：21 处调用点已全部命名（`load-all`、`save-session`、`session-metadata-snapshot` …）
- 环形 `queueTrace`（64 条）+ `markQueueTrace()` / `blockersSince(mark)`
- 慢保存日志新增字段：`queueBlockers`，形如 `load-all=8120ms,session-metadata-snapshot=1400ms`

**第一步不是改代码，是取读数**：

```bash
python3 - <<'PY'
import json,collections
p='/Users/totota/Library/Logs/PureScience/main.log'
c=collections.Counter()
for line in open(p,encoding='utf-8',errors='replace'):
    if not line.startswith('{'): continue
    try: d=json.loads(line)
    except: continue
    if d.get('msg')!='session save was slow': continue
    data=d.get('data') or {}
    for part in str(data.get('queueBlockers') or '').split(','):
        if part: c[part.split('=')[0]]+=1
print(c.most_common(10))
PY
```

**判据（互斥，别同时做）**：

- 占用者集中在 `load-all` / `reconcile` / `delete-project-sessions` 这类**大块工作** ⇒ **把长任务移出队列**（例如 loadAll 改为快照读 + 队列外扫描），保留队列只做写；
- 占用者集中在大量**短操作**（`save-session`、`session-metadata-snapshot`…）⇒ **修锁粒度**（按 projectId 分桶，或读写分离）。

**验收**：同一窗口重测 `queuedMs` p90 与 max 明显下降，附前后读数；`src/main/session-persistence` 全套用例绿。

---

### 任务 B — settings 预检 4.5 秒

**读数**（真机，同时段）：`settings:get-preflight` 4 次，中位 **4,479 ms**、最大 **6,427 ms**；单步 `probe-opencode` **3,937 ms ×5**。

**已有可复用的机制**：`src/main/settings/version-probe-cache.ts`（按文件身份 mtimeMs+size 记忆版本应答，失败不缓存，并发同键共享一次）。另见 `src/main/settings/npm-executable.ts`（同一套缓存）。

**首个动作**：确认 `probe-opencode` 是否绕过了该缓存；若是，接上；若它探的不是版本而是二进制本身，就按同一模式做身份记忆。

**验收**：本机探针给出 冷/暖 耗时对比（参考既有探针读数：opencode 首次 1,427.2 ms / 再次 0.202 ms）；`settings` + `diagnostics` 整域用例绿。

---

### 任务 C — 启动 `read-stored-settings` 12 秒

**读数**：`[startup] compose step slow { step: 'read-stored-settings', durationMs: 12,154 }`（单次启动）。

**首个动作**：先打点拆开这 12 秒（读文件 / 解析 / 迁移 / 校验各占多少），再决定优化对象。已有启动耗时管道：`DiagnosticOperation.phase`（带 `elapsedMs`）与 `[startup] startup timeline` 一行汇总，入口 `src/main/index.ts` 的 `web-service-started` 附近。

**验收**：时间线能指出 12 秒落在哪一步；若可优化，附前后读数。

---

### 任务 D — 冷启动：compatibility 哈希（目标 ~0.4 s）

**读数**（本机实测，非估算）：`bundledSkillCompatibility` 对每个技能的每个文件做 sha256 —— 50 个技能 / 279 个文件 / 1.4 MB ⇒ **walk 55 ms + 读+hash 408 ms**；忙机器上放大到 811 ms，是启动里最大的单步。

**代码位置**：`src/main/skills/registry.ts` 的 `bundledSkillCompatibility`。

**小心**：这是「技能是否变更」的判据，缓存写错会让物化**跳过更新**（真出过：`.catalog_stamp` 与版本相同导致物化被跳过，两臂对照因此失败）。缓存键必须覆盖**内容变化**：只用目录 mtime 不够（改文件内容不改目录 mtime），要按 per-file `size + mtimeMs` 签名。

**验收**：暖启动省下目标时间；写一条用例证明「改了 SKILL.md 内容后缓存失效」；`src/main/skills` 全套绿。

---

### 任务 E — MCP 就绪超时的根因

**读数**：真机又出现一次 `[mcp-readiness] Timed out waiting for MCP servers: purescience_figure, purescience_host_query`，紧接着是应用自己的 `createSession: first attempt failed, retrying once` —— **重试把会话救回来了**（v2.16.1 加的）。

**问题**：14 个 MCP 服务挤同一个就绪预算，重试只是兜底。

**代码位置**：`src/main/acp/session-capability-owner.ts`（`buildStdioServers` 等）、`src/main/acp/provider-session-creator.ts`（重试在这一层）。

**可选方向**：把非首屏必需的服务（figure / host_query / endpoint …）延后挂载；或分组就绪，先放行核心组。**不要**简单把预算调大（那是掩盖）。

**验收**：真机日志不再出现 readiness 超时，或超时后仍能建立会话且**有具名读数说明哪一组慢**。

---

### 任务 F — 机检③ 补齐 3/4

排期要求「4 个 runtime 各 1 会话契约命中可查」，当前只有 opencode 通过。探针脚本范式：`~/.hermes/cache/scratch/run-runtime-probe.sh`（若已不存在，按同样的环境变量范式重写）：

```bash
PURESCIENCE_CONFIG_ROOT=$ROOT PURESCIENCE_STORAGE_ROOT=$ROOT \
PURESCIENCE_WEB_PORT=$PORT PURESCIENCE_AGENT_FRAMEWORK=<framework> \
PURESCIENCE_ABLATION=full-contract node_modules/.bin/electron . \
  --purescience-headless --disable-gpu --user-data-dir="$ROOT/electron-userdata"
```

token 从 `$ROOT/web-token` 读。已有读数：opencode `declared=28 session=read readings=28`；codebuddy 与 claude-code `session=null`（`acp: createSession: failed`，`errorCategory: 'network'` —— 沙盒拿不到钥匙串凭证）；codex 本机是 `/opt/homebrew/bin/codex-acp`（`command -v codex` 为空）。

**纪律**：**不改判据凑绿**。拿不到凭证就如实记 `1/4` 并附具名原因。

---

### 任务 G — `wip/settings-probe-timing` 分支处置

分支上有一笔未完成改动（另一个工作进程留下）：`environment-check.ts` 里 `timed()` 已定义但四个探测调用点没接上，`tsc` 报 `TS6133 'timed' is declared but its value is never read`。

**处置二选一**（问用户，别自作主张）：接上 `timed(...)` 让逐步计时生效，或删掉死变量并丢弃该分支。**不要**直接合回 main（会红掉双 typecheck）。

---

### 任务 H — v2.18.0：成本矩阵 + 中文别名检索评测

**前置（已写进计划文档）**：成本表要真实 `usage` 记账，未接入前只报 token 数与墙钟，**不报美元 —— 不估钱**。参考 `docs/plan-2026-10-21-v2.17-scibench-v1.md:62`。

**拆分建议**：

1. 先接 provider `usage` 记账（prompt/completion/total tokens 已有 `contextUsage`，需确认真实计费字段）；
2. 再出成本矩阵（不同模型 × 不同题型的 token 与墙钟）；
3. 中文别名检索评测单独做：`wr`/连接器的中文术语表命中率、`zh_terms` 改写覆盖率（openalex/arxiv/pubmed 三源已有 Chinese term table 行为差异，见各 descriptor 的 description）。

**纪律**：评测必须可复跑，读数落 `docs/bench-runs/`。

---

### 任务 I — v2.19.0：A2A + 轨迹包

**未开工，无可继承设计**。开工前先写一页设计（放 `docs/plan-<date>-v2.19-a2a-trajectory.md`），说明：A2A 的 agent 卡/任务语义如何映射到现有 ACP 会话；轨迹包（trajectory bundle）包含哪些字段、如何脱敏（凭证一律 REDACTED）、复现需要什么。**先设计后实现**，不要直接写代码。

---

## 3. 排期之外、但真机上仍在发生的（知道就好，别顺手改）

| 现象 | 读数 |
|---|---|
| `artifact version resolve` 慢 | 9 次，queryMs 160 / dbCanaryMs 151 —— 与任务 A 同源（DB 争用）|
| `reviewer submit_findings` 被拒 | 2 次：`Execution log for activity … was not read before …` —— 审查器「先读日志再下结论」的闸 |
| 事件循环停顿 | 5 次（load 24 时段），比历史 21,454 次规模已大幅收敛 |

---

## 4. 常用自查命令

```bash
cd ~/purescience
node -p "require('./package.json').version"
git log --oneline -8
git stash list
git branch --list 'wip/*'

# 最近会话的工具调用分布（判断 agent 是否真的在用工具）
cd ~/.purescience/sessions && python3 - <<'PY'
import json,glob,os,time,collections
rows=[]
for f in glob.glob('*/*.json'):
    if f.endswith('.summary.json'): continue
    try: d=json.load(open(f))
    except: continue
    s=d.get('session') or {}; g=s.get('conversationGraph') or {}
    acts=g.get('activities') or []
    names=collections.Counter(a.get('providerToolName') for a in acts if a.get('providerToolName'))
    rows.append((os.path.getmtime(f), s.get('agentFrameworkId'), (s.get('title') or '')[:40], len(acts), names.most_common(3)))
rows.sort(reverse=True)
for r in rows[:6]: print(time.strftime('%m-%d %H:%M', time.localtime(r[0])), r[1], r[3], r[2], r[4])
PY

# 慢 IPC 通道分布
python3 - <<'PY'
import json,collections
p='/Users/totota/Library/Logs/PureScience/main.log'
c=collections.Counter()
for line in open(p,encoding='utf-8',errors='replace'):
    if not line.startswith('{'): continue
    try: d=json.loads(line)
    except: continue
    if d.get('msg')=='ipc handler was slow':
        c[(d.get('data') or {}).get('channel')]+=1
print(c.most_common(10))
PY
```

---

## 5. 建议的执行顺序

1. **A（队列）** —— 仪器已就绪，先取读数，一次只改一种方向；
2. **B（settings 预检）** —— 有现成缓存机制，风险低、体感明显；
3. **E（MCP 就绪）** —— 真机已两次触发，重试只是掩盖；
4. **C / D（启动与冷启动）** —— 需要空闲机器基线，D 要独立设计与测试；
5. **F（机检③）** —— 受凭证限制，能补多少记多少，不改判据；
6. **H（v2.18.0）** —— 先接 usage 记账，再出矩阵与中文别名评测；
7. **I（v2.19.0）** —— 先写设计文档。

每完成一项：跑门禁 → 提交（`git -c core.hooksPath=/dev/null commit`）→ 推送 → 附真实读数汇报。**不要跨项攒大提交。**
