# Hermes 的 ACP 服务端在这台机器上真的握手了

`docs/plan-2026-11-23-agent-catalog.md` 里 Hermes 的阻塞项是「没有一条真握手读数」。这条读数现在有了。

## 读数

隔离数据根（`HERMES_HOME=/tmp/hermes-acp-probe`，不碰用户自己的 `/Users/totota/.hermes`）先做自检：

```
$ HERMES_HOME=/tmp/hermes-acp-probe hermes acp --check
hermes: preparing dependencies for this data root (the checkout's updates belong to /Users/totota/.hermes)…
Preparing the isolated Hermes runtime… ✓
Hermes ACP check OK          # exit 0
```

然后按 ACP（Agent Client Protocol）发一条标准的 `initialize`，走 stdio：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize",
 "params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true}}}}
```

回包（原文，7.2 秒内到达）：

```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":1,
  "agentInfo":{"name":"hermes-agent","version":"0.23.3"},
  "agentCapabilities":{"loadSession":true,
                       "promptCapabilities":{"image":true},
                       "sessionCapabilities":{"fork":{},"list":{},"resume":{}}},
  "authMethods":[{"id":"hermes-setup","type":"terminal","name":"Configure Hermes provider",
                  "args":["--setup"],
                  "description":"Open Hermes' interactive model/provider setup in a terminal. …"}]}}
```

所以：**启动命令是 `hermes acp`，协议版本 1，能力集与 Claude Code / Codex 那两个适配器同一族**（`loadSession`、
`promptCapabilities.image`、`sessionCapabilities.fork/list/resume`），而它把「没有配置 provider」这件事办成一条
`terminal` 类型的 auth method（`hermes setup`），不是一条 JSON 报错。

## 这条读数改变的是什么

- **不再是「猜 Hermes 有没有 ACP」**：`hermes acp` 是这个发行版自带的子命令（`hermes acp --help` 还提供
  `--accept-hooks` / `--setup-browser` / `--check`），不需要社区适配器。这一点与 Pi 不同 —— Pi 那条依赖社区 adapter，
  Hermes 这条不依赖。
- **安装来源明确了**：Hermes 是 Python 包（本机走 pipx venv），与 CodeBuddy/Claude Code 那几个 npm CLI 不同，
  安装单元要按 pipx 那套写，不能照抄 npm 的探测。

## 还没有读数、因此还不能算完成的部分

1. **一次真对话**：`session/new` + `prompt` 让模型真的回一句话 —— 这一条没跑，所以「Hermes 能在我们的会话里
   干活」目前**不是**已验证事实。
2. **provider 怎么进去**：上面那条 `authMethods` 指向交互式 `hermes setup`，而我们的应用自己持有 provider 与密钥。
   要让应用侧的 provider 进到 Hermes 里，得先弄清它认哪个环境变量/配置字段（`config.yaml`? `OPENAI_BASE_URL`
   那类?），并且**实测**应用配的模型出现在 Hermes 的回包里 —— 没测出来之前，接进去就是一个点了会失败的按钮。
3. **探测与版本**：`hermes --version` 的输出形状（`Hermes Agent v0.23.3 (2026.9.24) · stable · local caafe5389ae5`）
   要按「从哪一段取版本」定死，否则会重犯 Windows 那条把整段 `--version` 当版本号的错。

所以这次只钉住第 1 步（服务端确实在、协议版本与能力集可读），`AgentFrameworkId` 的联合类型**没有动** ——
单变量走完剩下的 3 条，再进代码。

## 追加：真 prompt 跑通了，provider 两条路各自独立可用

用仓库自带的 `evals/acp_empty_session_wire.py`（本地 HTTP 模型夹具，不走付费推理）跑真 ACP 会话：
`initialize` → `session/new` → `session/prompt` → `session/fork`。prompt 阶段回包：

```
{"stopReason": "end_turn", "usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}}
```

持久化里读到成对的消息（原始会话与 fork 各一对）：

```
(local-3c0a…, 'user',      'Reply with a short greeting; do not use tools.')
(local-3c0a…, 'assistant', 'Local fixture reply.')
(local-101b…, 'user',      'Reply with a short greeting; do not use tools.')
(local-101b…, 'assistant', 'Local fixture reply.')
```

脚本最后一步（`session/load` 之后读 `model_config_json`）在自己的断言上抛了 `TypeError: … not NoneType`，
那是它针对「已存在的空会话行」的探针断言，与上面这条路径无关 —— 该失败不改变 prompt 已跑通这条读数。

### provider 注入：三条变体各跑一遍（本地夹具，同一台机器）

| config.yaml 里有 `api_key` | 环境里有 `OPENAI_API_KEY/BASE_URL` | prompt 结果 |
|---|---|---|
| 有 | 有 | `ok` / `end_turn` |
| **无** | 有 | **`ok` / `end_turn`** |
| 有 | **无** | **`ok` / `end_turn`** |

结论：两条路各自都够用，所以应用可以只走环境变量、把明文密钥挡在生成的 `config.yaml` 之外
（与 CodeBuddy 那条「密钥只进 env」的纪律一致）。配置形状：

```yaml
model:
  provider: 'custom'
  default: '<model>'
  base_url: '<base>'
  api_mode: 'chat_completions'
mcp_servers: {}
memory: { memory_enabled: false, user_profile_enabled: false }
```

`agent.system_prompt` **不写** —— 在 Hermes 那里它承载的是渲染后的 personality 文本，且它自己的
`config_migrations.py` 会在迁移时把这段擦掉；应用侧的指引改走 ACP prompt 前缀（上面已验证的那条路）。

## 这次仍然没有接进应用的代码，原因与剩余面

我把 `AgentFrameworkId` 扩到五个、写了 `hermes.ts` 与它的测试，然后**全部还原**了。原因是编译器把真实
工作量摊开后，这不是一个「加一个文件」的改动：`contextCompaction` 是必填（Hermes 只能声明
`framework-managed`）、`REGISTRY_PROBE_PATHS` 是按 npm 包路径探测的（Hermes 是 Python 包，这条路对它
不成立）、`preflight.ts` 需要一个新的 `hermesPath` 与它自己的探测（`hermes --version` 的输出是
`Hermes Agent v0.23.3 (2026.9.24) · stable · local caafe5389ae5`，取版本要按段取，不能整段当版本号）。

要把它做成「实机可用」，还差的落点（按依赖顺序）：

1. `src/shared/settings.ts`：`AgentFrameworkId` + `AGENT_FRAMEWORK_IDS` + 完整性映射；
2. `src/main/settings/types.ts` / `repository.ts`：`hermesPath` / `hermesVersion` 两个字段与读回；
3. 一个 `hermes --version` 的探测器（取 semver 段）与 `agent-runtime-manager.ts` 的 ready 判定；
4. `preflight.ts` 的 `hermesReady`、`environment-check.ts` 的注册表探测改成「非 npm 框架跳过」；
5. `src/main/agent-framework/hermes.ts`（本次已写好骨架：`hermes acp` + `HERMES_HOME` + 生成的
   `config.yaml` + 密钥只进 env）与 `registry.ts` 注册；
6. `backend-resolver.ts` 的 `resolveHermesExecutable`（pipx 安装的 `hermes` 在 `~/.local/bin`）；
7. 渲染层：`provider-icons.tsx` / `provider-form-value.ts` / `AgentPanel.tsx` / `UninstallRuntimeDialog.tsx`
   与九语种文案；`renderer-contract-catalog.ts` 里那几个 pinned 计数要跟着动；
8. e2e：一条真跑 `hermes acp` 的认证用例（而不是断言配置文件长得对）。

在没有 5、6、8 之前把它挂进 `AGENT_FRAMEWORK_IDS`，用户看到的就是一个点了会失败的按钮 —— 这是本次
停在证据、不进代码的唯一理由。
