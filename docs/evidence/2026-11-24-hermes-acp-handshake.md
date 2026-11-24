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
