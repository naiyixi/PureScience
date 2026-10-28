# C1「框架 == 二进制」守护：CI 映射断言 + 真机四路探针（2026-10-29）

## 0 这条守护防的是什么

历史事故的形态是**静默的**：会话里 `agentFrameworkId` 写着 `codebuddy`，真正跑起来的进程是 `opencode`，
于是那次会话的一切读数都在描述另一个工具（`docs/evidence/2026-10-27-machine-check-3.md`）。
类型系统不会发现「映射表接错了一行」，而这类错误只会在真实启动时暴露。

## 1 分两层：CI 能跑的和只能在真机跑的

| 层     | 内容                                                                                                                                | 在哪跑                                                                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 映射层 | 四个框架各自解析到**自己的**可执行文件；缺失的框架如实报 `found: false`，不借用邻居的路径                                           | CI：`src/main/settings/agent-runtime-manager.test.ts` 的 C1 两例；Nightly 的 Verify 会跑到（Nightly = `build.yml` 的 lint+typecheck+test+package） |
| 真机层 | 真机上把 `settings:set-agent-framework` 逐个设成四个框架，读回 `settings:check-environment` 的 `agentFrameworkId` 与 `runtime.path` | 本机脚本 `scripts/probe-framework-binaries.sh`（GitHub runner 没装这四个 CLI，代理不了）                                                           |

## 2 映射层：新增两例

1. `names each framework's own binary, never a neighbour's` —— 设四次框架，每次读回
   `result.agentFrameworkId` 与 `result.runtime.path`，四行路径去重后必须是 4；任何跨接（codebuddy → opencode 那种）
   当场红。
2. `reports a framework as missing rather than borrowing another one's binary` —— 只装 opencode 时，
   codebuddy 那行必须 `found: false` 且路径不等于 opencode 的路径。

## 3 真机层读数（2026-10-29 01:15 CST，`out/` 构建，端口 44671，`readiness=200`）

```
claude-code stored=claude-code resolved=claude-code found=True  path=/opt/homebrew/bin/claude
opencode    stored=opencode    resolved=opencode    found=True  path=/opt/homebrew/bin/opencode
codex       stored=codex       resolved=codex       found=True  path=/Users/totota/.purescience/codex-managed/adapter/dist/index.js
codebuddy   stored=codebuddy   resolved=codebuddy   found=True  path=/Users/totota/.local/bin/codebuddy
distinct_paths=4
```

四行 `stored == resolved`，路径互不相同：claude 2.1.212、opencode 1.19.3、codex 走托管 adapter（1.1.4，驱动原生 0.144.6）、
codebuddy 2.174.0（`~/.local/bin/codebuddy`）。

顺带记录一条调用形状（下次省一次试错）：`settings:set-agent-framework` 的入参是
`SetAgentFrameworkRequest = { id: AgentFrameworkId }`，**不是**裸字符串；传裸字符串时命令返回 ok（回一份 settings 快照），
但框架并未改变 —— 这种「成功但没生效」正是本守护要防的同一类静默。

## 4 复现方式

```bash
bash scripts/probe-framework-binaries.sh            # 默认端口 44670
bash scripts/probe-framework-binaries.sh 44675      # 换端口，避开已占用的实例
```

脚本自己起一个独立 `--user-data-dir` 的 headless 实例（主实例在跑也不会抢单实例锁），跑完自动收尾，
最后一行 `distinct_paths=4` 是判据；非 4 时脚本以非零退出。

## 5 边界

- 探针只断言「框架 → 二进制」这一层，不启动真实会话；「跑起来之后确实是那个二进制」由
  `docs/evidence/2026-10-27-machine-check-3.md` 的会话级读数负责。
- 四个 CLI 的**版本**不参与判据：版本变化是升级，不是串味；串味的判据只有路径。
