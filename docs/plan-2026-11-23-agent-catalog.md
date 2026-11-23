# 智能体目录：CodeBuddy 在线安装已修，Pi / Hermes / DeepSeek Harness 待接入

## 已完成（本轮）

CodeBuddy 的卡片早就有 `npm` 安装源，但 `onInstall` 里写着
`if (source !== 'npm') return Promise.resolve(undefined)` —— 而卡片传下去的那个源并不是字面量 `'npm'`，
于是按钮按下什么都不发生，界面只能让人「手动安装」。现在只有一份源就直接装；未就绪提示也从
「手动安装 @tencent-ai/codebuddy-code 后重新检测」改成「尚未检测到 CodeBuddy。」——按钮就在旁边，让按钮说。

判据：`src/renderer/src/pages/settings` **733 passed / 1 skipped**。

## 待接入的三个（先把事实查清，别猜）

2026-11-23 查到的官方口径：

| 智能体 | 安装 | ACP 形态 |
| --- | --- | --- |
| **Pi** | `curl -fsSL pi.dev/install.sh \| sh`（Windows: `powershell -c "irm pi.dev/install.ps1 \| iex"`） | **自身没有 ACP 模式**，要靠社区适配器 `npx -y pi-acp`（`Attamusc/pi-acp`、`svkozak/pi-acp`） |
| **Hermes** | Python 包（`pipx install hermes-agent` 一类），本机已有 | **原生 ACP**：`hermes acp` 起来即 ACP server（NousResearch/hermes-agent 文档 `docs/acp-setup.md`） |
| **DeepSeek Harness** | `dsh` 本体 + `npm i -g deepseek-harness-acp` | 官方 ACP server 由 `deepseek-harness-acp` 提供；另有社区 `deepseek-acp` |

## 为什么这次没有直接写进去

`AgentFrameworkId = 'claude-code' | 'opencode' | 'codex' | 'codebuddy'` 是一个贯穿全层的联合类型：
`preflight.ts` 的探测、`backend-resolver.ts` 的可执行文件解析、`settings/repository.ts` 的持久化、
`application-commands.ts` 的安装通道、渲染层的卡片与图标、以及 e2e 认证。加一个框架要同时改到这些地方，
且必须**真跑一次 ACP 握手**才算完成 —— 半接进去的框架等于给用户一个点了会失败的按钮，而这正是我们要消灭的东西。

## 接入顺序（每个框架一条完整链，逐条提交）

1. `AgentFrameworkId` 加 id + 探测（版本命令、可执行名、`resolvedPath`）。
2. 安装源：Pi 用官方脚本（macOS/Linux）与 PowerShell（Windows）；Hermes 用 pipx；DSH 用 npm 全局。
3. 启动规格：Hermes `hermes acp`；DSH `deepseek-harness-acp`；Pi `npx -y pi-acp`（并说明这是社区适配器，
   不是 Pi 官方 ACP）。
4. 设置页卡片 + 图标 + 中英文案（名字、一句描述、未就绪提示）。
5. 认证：本机真机跑一次 `createSession` + 一轮 prompt，附日志；接不上就降级成「安装但不列为一等框架」。

先做 Hermes（本机已装、原生 ACP、链路最短），再做 DeepSeek Harness（npm 一键），Pi 因为要借社区适配器放最后。
