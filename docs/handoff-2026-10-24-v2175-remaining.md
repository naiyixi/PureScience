# 交接：v2.17.5 之后（E 的修复、F、B/C 尾巴、v2.18.0、v2.19.0）

> 给新会话的作业单。基准点：`~/purescience`，`main` @ `9ce36808`，版本 **2.17.5**（已发布）。
> 上一份交接（`docs/handoff-2026-10-24-remaining-schedule.md`）的 A/B/C/D/G 已完成到下面写明的程度，
> **不要再重做已完成的部分**。

---

## 0. 硬规矩（与上一份交接相同，只补新的坑）

- 仓库有 husky/gitleaks：提交用 `git -c core.hooksPath=/dev/null commit`，推送前跑 `bash scripts/pre-push-checks.sh`。
- `docs/**`、`**/*.md` 在 CI 的 `paths-ignore` 内：纯文档提交不触发 CI。
- 发版四文件：`package.json` / CHANGELOG 新段（覆盖自上一 tag 起**全部**提交）/ 双语 README 横幅（逐字一致）/
  `dist/notes-X.Y.Z-zh.md`（必须含未签名声明）。`dist/` 在 `.gitignore` 内，notes 只本地供发版脚本使用。
- 判 CI 必须用**完整 40 位 SHA**；`cancelled` 不算绿；有 Release 页的 tag 不要删重打。
- **`npm run build` / `publish-release.sh` 必须带 `NODE_OPTIONS=--max-old-space-size=8192`**，否则 tsc OOM。
- 共享树 Prisma client 过期会让双 typecheck 红在 `citedAt`/`citedSessionId`：先 `npx prisma generate`。

### 新踩到的坑（都在本轮真实发生过）

1. **`net/egress.test.ts:434` 是时序抖动**（`expected 'timeout' to be 'closed'`）。本地 3 跑 2 绿 1 红；CI 上红过两次、
   build-only 重跑又绿。**先证抖动，再决定是否改它**，不要把它当成自己的改动打红。
2. **发版脚本最后一步「下载校验」会因 GitHub CDN 超时失败**（`release-assets.githubusercontent.com … i/o timeout`），
   但此时资产已上传成功。用 `gh release view vX.Y.Z --json assets` + 本地 `shasum` 字节比对来核对，
   **不要重跑整个 publish**（同名产物会冲突）。
3. **端口 44100 会被一个 dev-tree headless 占住**（`~/purescience/node_modules/electron … --purescience-headless`）。
   它会挡住 `purescience start --app-path /Applications/...`。停掉它（用户已批准过一次）后，CLI 的 `status`
   /`run` 就会指向**桌面实例本身**——这是做真机读数最省事的姿势。
4. **不要在真机语料副本上跑 repair 扫描**：`SessionRepository.loadAllWithDiagnostics()`（默认 repair）
   会把副本里的会话文件判成 `corrupt` 并重命名成 `*.json.invalid-*`，读数全废。要测读性能只用
   `loadCatalogWithDiagnostics()` 或 `loadSessionWithDiagnostics()`，它们不隔离文件。
5. `purescience start` 会拒绝启动并报「already running (PID …)」，但那个 PID 可能是**桌面实例**而不是它自己起的
   daemon —— 先 `ps -o pid,etime,command -p <pid>` 看清是谁。

---

## 1. 已完成（不要重做）

| 版本 | 内容 | 关键读数 |
|---|---|---|
| v2.17.3 | 队列：`loadAll` single-flight、权威扫描移出队列、`readSessionById` 取代"读一个会话跑全量迁移" | `queuedMs` p90 **48,306 → 0 ms**、max **97,930 → 7 ms**；hydration pass 81 次/22h → 2 次 |
| v2.17.4 | 探针答案跨进程复用（`settings/probe-answers.json`，键 = `sha256(路径 + mtimeMs:size)`）；启动钥匙串四段计时 | 新进程第一次 preflight **6,116 → 634 ms**；`encryption-available=16,758ms,providers=24ms,connectors=1ms` |
| v2.17.5 | 兼容哈希按每文件 `size+mtime` 记忆；`session capabilities built` 点名 + `groups` | 冷启动最大单步（walk 55 ms + 读哈希 408 ms，忙时 811 ms）不再每次重跑；能力清单可归因 |
| — | `wip/settings-probe-timing` 已删：artifact 读数并入 + 修掉"重试耗尽时计数丢失"；`timed()` 因 main 已有 `recordStep` 而丢弃 | — |

---

## 2. 待办（按建议顺序）

### E-余项 — MCP 就绪超时的**修复**（读数已就位，修复未做）

- 真机复现（本机，14 个服务里 11 个一起超时）：`[mcp-readiness] Timed out waiting for MCP servers: purescience_plan,
  purescience_memory, purescience_context_summary, purescience_routine, purescience_goal, purescience_endpoints,
  purescience_annotations, purescience_pdf, purescience_knowledge, purescience_figure, purescience_host_query`；
  随后 `createSession: first attempt failed, retrying once` → 下一次成功（重试在掩盖它）。
- 就绪预算由**代理侧**（Claude Code 在 `session/new` 内）执行，产品端只能"少给/晚给"。
- 结构信息已就位：`src/main/acp/session-capability-owner.ts` 的 `buildStdioServers(request, enabled)` 是**扁平 14 项**；
  v2.17.5 已加 `FIRST_SCREEN_MCP_SERVER_NAMES`（artifacts/notebook/plan/memory/context-summary）与
  `deferredServerNames()`，日志里能读到 `groups: 5 core,9 deferred`。
- **已查清（不要再查一遍）**：ACP schema 里 `mcpServers` 只出现在 `session/new`（以及 `load`/`resume` 的重放），
  方法集合是 `session/new | load | list | delete | fork | resume | close | set_mode | set_config_option | prompt |
  update | cancel | request_permission` —— **没有"会话建立后追加 MCP 服务"的方法**（见
  `node_modules/@agentclientprotocol/sdk/schema/schema.json`，x-method 列表）。所以"延后挂载延后组"在不改协议的前提下
  **等于让那些能力整个会话不可用**，不能这么做。
- **因此 E 的三条可行路径**（按代价排序，任选其一并附读数）：
  1. **合并工具面**：把延后组里的图/PDF/知识/标注/端点合成一个 MCP 进程（工具名不变，进程数从 9 降到 1–2）。
     这是唯一能真正减少"同时启动 14 个进程"而不丢能力的路；
  2. **让每个服务启动更便宜**：MCP 入口的顶层 import 懒化（现在每个入口都连带拉起同一批重模块）；
  3. **预热常驻**：启动后先把这些服务拉起来并完成 initialize，使代理的 readiness 预算面对的是"已经在答"的进程。
- **已排除的假设（别重复排查）**：这 14 个服务**不是**各自启动一个完整 Electron —— 会话侧的服务配置全部带
  `ELECTRON_RUN_AS_NODE=1`（artifacts / notebook / annotation / context-summary / endpoint / figure / host-query /
  memory / pdf / routine / skills 都已是 node 模式；唯一还是完整 Electron 的是 `src/main/reviewer/mcp-server.ts`，
  它不在主会话那 14 个里）。所以剩下的成本是**模块加载重量 × 14 个并发 node 进程**，不是启动器选错。
  下一步的量法：给每个 server 记一条「spawn → initialize 完成」的耗时（在 `buildStdioServers` 交给代理之前先探一次并打点），
  再决定是懒化 import 还是预热。
- 三条路都不要调预算值掩盖；每条都要给出「14 个进程各自到达就绪的时间」的具名读数作为前后对照。

### F — 机检③ 补齐（当前 1/4）

- 只有 opencode 通过：`declared=28 session=read readings=28`；codebuddy 与 claude-code `session=null`
  （`errorCategory: 'network'` —— 沙盒拿不到钥匙串凭证）；本机 codex 是 `/opt/homebrew/bin/codex-acp`。
- 探针范式：`PURESCIENCE_CONFIG_ROOT=$ROOT PURESCIENCE_STORAGE_ROOT=$ROOT PURESCIENCE_WEB_PORT=$PORT
  PURESCIENCE_AGENT_FRAMEWORK=<framework> PURESCIENCE_ABLATION=full-contract node_modules/.bin/electron .
  --purescience-headless --disable-gpu --user-data-dir="$ROOT/electron-userdata"`，token 读 `$ROOT/web-token`。
- **纪律：不改判据凑绿**。拿不到凭证就如实记 N/4 并附具名原因。

### B 尾巴 — `probe-codex` 585 ms

- managed codex 版本已命中磁盘答案，剩下的 585 ms 是 `probeCodexRuntime` 里的 **ACP initialize smoke**，
  它不计入身份缓存（三次采样 5,373 → 1,632 → 585 ms）。
- 方向：给 smoke 结果也做身份键控（同二进制不重复 initialize），或在 preflight 里把它降级为"仅首屏需要时"。

### C 优化 — 钥匙串 16.8 秒

- 已归因：`isEncryptionAvailable()` 一次 16,758 ms（读文件/解析/迁移只有 25 ms）。
- 方向（择一，先量后改）：延迟到首次真正需要密钥时；或在 `web-service-started` 之后后台预热并记录耗时。

### v2.18.0 — 计划已落盘，未实现

`docs/plan-2026-10-24-v2.18-usage-and-zh-alias.md`：先接 provider **真实** usage（落 `source: 'provider' | 'estimate'`），
再出 token×墙钟成本矩阵（**单价未接入前不写美元**），最后做中文别名检索评测（命中率 / `zh_terms` 改写覆盖率 / 三源差异）。
读数落 `docs/bench-runs/`，必须可复跑。

### v2.19.0 — 设计已落盘，未实现

`docs/plan-2026-10-24-v2.19-a2a-trajectory.md`：A2A 映射到现有 ACP 会话（会话是唯一权威，A2A 不拥有状态）；
轨迹包字段与**硬性脱敏清单**（凭证一律 REDACTED）。实现顺序：只读轨迹包导出 → 能力快照 → agent card 只读端点 →
`message/send` 最小闭环 → 互通测试。**实测之前不许说"支持 A2A"**。

---

## 3. 常用命令（本轮验证过的）

```bash
cd ~/purescience
node -p "require('./package.json').version"
plutil -p /Applications/PureScience.app/Contents/Info.plist | grep -i shortversion   # 装机版本

# 装机（本机打包产物 → /Applications，未签名需去 quarantine）
hdiutil attach -nobrowse -quiet dist/zerolink-purescience-X.Y.Z-mac-arm64.dmg
rm -rf /Applications/PureScience.app && cp -R "/Volumes/PureScience X.Y.Z-arm64/PureScience.app" /Applications/
xattr -dr com.apple.quarantine /Applications/PureScience.app

# 真机读数（启动阶段）
python3 - <<'PY'
import json
for line in open('/Users/totota/Library/Logs/PureScience/main.log',encoding='utf-8',errors='replace'):
    if not line.startswith('{'): continue
    try: d=json.loads(line)
    except: continue
    if d.get('msg') in ('compose step slow','preflight step slow','settings key migration was slow','session save was slow'):
        print(d.get('t','')[11:19], d.get('msg'), d.get('data'))
PY
```

## 4. 自查清单

- `bash scripts/pre-push-checks.sh`；`NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck`（node+web 双绿）；
  改动域的 vitest；eslint/prettier 干净 —— 四样齐了再提交。
- 每完成一项：门禁 → 提交 → 推送 → **附真实读数**汇报；不要跨项攒大提交。
- 声称"完成"之前问自己：有真机读数吗？没有就写"未验证"，并把它写进 CHANGELOG 的「明确没做 / 未验证」。
