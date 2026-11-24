# DeepSeek Harness 与 Pi 的 ACP 握手读数（2026-11-24）

两段 `initialize` 都是**真进程**回的，不是查文档：`acp-probe.py` 起子进程、写一条 spec 形状的
JSON-RPC `initialize`、读第一条同 id 的响应。包通过 `npx -y --registry=…` 现取，没有预先装到系统里。

## DeepSeek Harness

- 包：`deepseek-harness-acp`（npm），本次取到 **0.1.27**；镜像上 `latest` 已到 0.1.31。
  `--version` 直接打印版本号，`--help` 自带 `dsh-acp` 别名，说明它与 `@deepseek-ai/dsh` 是两个包。
- 交互式 CLI 是 `@deepseek-ai/dsh`（bin `dsh`）。**注意** npm 上不带域的 `dsh` 是另一个东西
  （`A shell written in JavaScript`，repo `infusion/node-dsh`），按名字装会装错。
  `@deepseek-ai/dsh` 已发布版本全是 `alpha`/`rc`，`latest` 指向 `0.2.2-rc.5`，`npm i -g @deepseek-ai/dsh@*`
  会报 `ETARGET`（`*` 不匹配预发布），必须写 `@latest` 或显式版本。
- `--help` 列出的环境变量：`DEEPSEEK_API_KEY`（必填）、`DEEPSEEK_BASE_URL`（可选）、
  `DSH_PERMISSION_MODE`（`workspace-write` | `danger-full-access`）、`DSH_SESSIONS_ROOT`（默认 `./.sessions`）。
  配置可用 `-c cordis.yml`，但**不传也能起** —— 服务自称 Standalone。

握手回包（2.2 秒）：

```json
{
  "protocolVersion": 1,
  "agentInfo": { "name": "deepseek-harness-acp", "version": "0.1.27" },
  "agentCapabilities": {
    "promptCapabilities": { "image": true, "audio": false, "embeddedContext": false },
    "sessionCapabilities": { "resume": true, "list": true },
    "loadSession": true,
    "mcpCapabilities": { "stdio": true, "sse": true, "http": true }
  },
  "authMethods": []
}
```

由此可得、且只能由此得出的结论：

- `authMethods` 为空 ⇒ 不需要终端登录流程，凭 `DEEPSEEK_API_KEY` 即可。
- **`mcpCapabilities` 三个都为 true** ⇒ 与 Hermes 相反，应用的工具面理论可达；但「声明支持」不等于
  「已接上」，真正的接线还需一次带 `mcpServers` 的会话读数。
- 图片提示位为 true，音频为 false。

## Pi

- 包：`pi-acp`（npm，社区适配器）本次取到 **0.0.35**；Pi 本体是 `@earendil-works/pi-coding-agent`
  （1.6.0），官方安装脚本 `https://pi.dev/install.sh` 实际就是装这个 npm 包（脚本里
  `PI_PACKAGE="@earendil-works/pi-coding-agent"`）。

握手回包（2.7 秒，节选）：

```json
{
  "protocolVersion": 1,
  "agentInfo": { "name": "pi-acp", "title": "pi ACP adapter", "version": "0.0.35" },
  "authMethods": [
    { "id": "pi_terminal_login", "type": "terminal", "args": ["--terminal-login"] }
  ],
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": { "image": true, "audio": false },
    "mcpCapabilities": { "http": false, "sse": false }
  }
}
```

由此可得：

- 有 `authMethods` 终端登录项 ⇒ 首次使用可能需要在终端里配 key；界面必须如实提示，不能假装一键可用。
- `pi-acp` 是**社区适配器**，不是 Pi 官方 ACP 服务；文案不能写成「官方」。

## 尚未测到（不许当成已知）

- 两者的 `session/new` + `session/prompt` 是否回 `end_turn`（Hermes 那套认证用例还没对它们跑过）。
- 两者在真 provider 下的模型选择语义（是否吃 `DEEPSEEK_BASE_URL` / Pi 的 provider 配置格式）。
- Pi 的 `mcpCapabilities.stdio` 未取到（回包被截断），不要按「有 stdio」实现。
