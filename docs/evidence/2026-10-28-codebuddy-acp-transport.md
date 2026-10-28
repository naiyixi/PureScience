# codebuddy 的 ACP 为什么“连不上”：静默的 stdin 服务端与一个没被传的传输开关

日期：2026-10-28
结论一句话：`codebuddy --acp` **不带 `--acp-transport stdio`** 时，接受一个合规的 `initialize`
后**一个字节都不回**（进程存活）；带上该开关 1 秒内返回结果。我们此前只传了 `--acp`。

## 一 起因

机检③（4 个 runtime 各 1 会话契约可查）长期停在 **3/4**，缺 codebuddy。应用日志给的是：

```
[acp] ensureConnected: connect failed { framework: 'codebuddy', status: 'error' }
[acp] createSession: failed
[acp] agent process exit { code: 1, signal: null, framework: 'codebuddy' }
```

天然读法是「它没装好 / 要登录 / 下载有问题」——这三条都查过，**都不是**。

## 二 排除项（都有一手读数）

| 猜想                     | 读数                                                                                                                                  | 结论           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| npm 包名或 registry 失效 | `npm view @tencent-ai/codebuddy-code version` → npmjs **2.177.1**、npmmirror **2.177.1**                                              | 不成立         |
| 包下不下来               | `npm install`（临时 prefix）`NPM_EXIT=0`；应用原样命令 `npm i -g … --prefix ~/.local --registry npmjs` → **EXIT=0**，装成 **2.177.1** | 不成立         |
| 二进制坏了               | `/opt/homebrew/bin/codebuddy --version` → `2.174.0`；`~/.local/bin/codebuddy --version` → `2.177.1`                                   | 不成立         |
| 应用安装流程有错         | 应用日志里那次 `settings:install-codebuddy` 耗时 **134.7 s**、无错误、随后能探测到 CLI                                                | 只是慢，不是错 |

## 三 真因

`codebuddy --help` 对 `--acp-transport` 的描述是：

```
--acp-transport <transport>   ACP transport (only works with --acp): "stdio" (default) or "streamable-http"
```

“默认 stdio”这句话在实测里**不成立**。用同一份合规请求（`initialize`，`protocolVersion: 1`）对比：

| 启动参数                                           | 40 秒内的输出                                                                   | 进程     |
| -------------------------------------------------- | ------------------------------------------------------------------------------- | -------- |
| `codebuddy --acp`（2.174.0）                       | **0 字节**                                                                      | 存活     |
| `codebuddy --acp`（2.177.1）                       | **0 字节**                                                                      | 存活     |
| `codebuddy --acp --acp-transport stdio`（2.177.1） | **608 字节**，`{"id":1,"result":{"protocolVersion":1,"agentCapabilities":{…}}}` | 正常应答 |

也就是说：服务端在读 stdin 之前就停住了，而它**既不报错也不退出**——上层看到的只能是
`connect failed`。这不是「差一次测试」，是我们少传了一个参数。

## 四 改法

`src/main/agent-framework/codebuddy.ts` 新增 `codeBuddyAcpArgs()`，spawn 一律发
`--acp --acp-transport stdio`（其余参数原样追加），并在用例里锁死 argv 形状：

```
expect(codeBuddyAcpArgs()).toEqual(['--acp', '--acp-transport', 'stdio'])
expect(codeBuddyAcpArgs(['--model','m'])).toEqual(['--acp','--acp-transport','stdio','--model','m'])
```

门禁：该文件用例 **7 passed**、eslint 0、`tsc -p tsconfig.node.json` **0 error**。

## 五 方法教训

- **「静默」与「慢」不可区分**：一个不写任何字节的子进程，在两个方向上都可解释。定因的唯一办法是
  给它一个**最小合规请求**并观察“有没有字节回来”，而不是加大超时。
- **文档里的「默认值」要当断言验一遍**：这次 `--help` 明写 stdio 是默认，实测却不生效；如果我按文档
  行事，永远不会去加那个开关。
- 先排除「下载/登录/安装」这类外部猜想，用的是**可数读数**（版本号、EXIT 码、字节数），而不是印象。

## 六 修了传输开关之后，为什么还是 3/4：它要的是「组织登录」，不是 API key

传对开关后 `initialize` 通过，但下一个方法就断：

```
initialize            → 608 字节，agentCapabilities + authMethods
session/new           → {"id":2,"error":{"code":-32000,"message":"Authentication required","data":{"category":"auth"}}}
```

`authMethods` 只有四种，全是账号登录：`iOA`、`external`（Google/GitHub）、`internal`（WeChat）、
`selfhosted`（企业域）。**没有一条是 API key 路径**——而应用的 codebuddy 适配器是按
「provider 的 base URL + key + model」注入的（`models.json` 里放 `${PURESCIENCE_CODEBUDDY_API_KEY}` 引用）。

对照实测：

| 凭据                                                                | `initialize` | `session/new`                       |
| ------------------------------------------------------------------- | ------------ | ----------------------------------- |
| 不注入 provider 凭据                                                | 通过         | `-32000 Authentication required`    |
| 注入 `CODEBUDDY_BASE_URL` + `CODEBUDDY_MODEL` + `CODEBUDDY_API_KEY` | 通过         | **25 秒内无应答**（608 字节后停住） |

所以机检③ 的第四个 runtime **卡在凭据形态**，不卡在我们的代码：要么给它一次组织登录（浏览器 OAuth），
要么放弃「provider key 直连」这条假设。这不是「再测一次就能过」的事。

## 七 顺手排除的其他可能（都有一手读数，别再重复查）

| 假设                              | 实测                                                                                                                        | 结论   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| 版本旧（2.174.0 无可用 ACP）      | `2.174.0 --acp --acp-transport stdio` → **585 字节正常应答**                                                                | 不成立 |
| cwd 不对（打包版继承 `/`）        | cwd = `/`、`$HOME`、项目目录 → **608 / 608 / 608**                                                                          | 不成立 |
| `--system-prompt-file` 不被支持   | 带 20KB 的 `system-prompt.md` → **608 字节**                                                                                | 不成立 |
| provider 环境变量把它弄哑         | 无 / 只 baseURL+model / 三个都加 → **608 / 608 / 608**                                                                      | 不成立 |
| 畸形 `initialize` 会让它 `exit 1` | 空 params、字符串版本号 → 都返回 **`-32602 Invalid params`**，进程存活；只有不带 `id` 的通知才会「无输出」（符合 JSON-RPC） | 不成立 |

也就是说：手动用「应用自己的 argv + 配置目录 + cwd + env」启动，**每一种组合都秒回**；应用内却
`ensureConnected: connect failed`。剩下的差异只在 Electron 的 spawn 环境（`augmentedPathEnv()` 重建的
PATH），要定位得给 spawn 加一次性诊断（实际 argv / cwd / PATH / 退出码 / 完整 stderr）再打一次包。
