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

| 假设                                                          | 实测                                                                                                                        | 结论   |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| 版本旧（2.174.0 无可用 ACP）                                  | `2.174.0 --acp --acp-transport stdio` → **585 字节正常应答**                                                                | 不成立 |
| cwd 不对（打包版继承 `/`）                                    | cwd = `/`、`$HOME`、项目目录 → **608 / 608 / 608**                                                                          | 不成立 |
| `--system-prompt-file` 不被支持                               | 带 20KB 的 `system-prompt.md` → **608 字节**                                                                                | 不成立 |
| provider 环境变量把它弄哑                                     | 无 / 只 baseURL+model / 三个都加 → **608 / 608 / 608**                                                                      | 不成立 |
| PATH 里没有 node 目录（`~/.local/bin` 是这台机器唯一的 node） | `env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` → 仍回 **608 字节**                                            | 不成立 |
| 畸形 `initialize` 会让它 `exit 1`                             | 空 params、字符串版本号 → 都返回 **`-32602 Invalid params`**，进程存活；只有不带 `id` 的通知才会「无输出」（符合 JSON-RPC） | 不成立 |

也就是说：手动用「应用自己的 argv + 配置目录 + cwd + env」启动，**每一种组合都秒回**；应用内却
`ensureConnected: connect failed`。剩下的差异只在 Electron 的 spawn 环境（`augmentedPathEnv()` 重建的
PATH），要定位得给 spawn 加一次性诊断（实际 argv / cwd / PATH / 退出码 / 完整 stderr）再打一次包。

## 八 结论与边界（这一条决定 4/4 能不能做到）

- **能修的已经修了**：`--acp-transport stdio` 是货真价实的代码缺陷（裸 `--acp` 静默 40 秒），已进 `3cd515ee`；
- **4/4 的真正约束不在代码**：握手成功后 `session/new` 回 `-32000 Authentication required`，`authMethods`
  只有 iOA / Google·GitHub / WeChat / 企业域。**没有 API-key 路径**，注入 provider key 反而让它在 608 字节后停住。
  要做到 4/4，必须先设计一次**交互式组织登录**（浏览器 OAuth + 凭据落盘），这不是一个适配器参数能解决的；
- **应用内 `exit 1` 仍是未解之谜**（手动用同一份 argv/cwd/env/PATH 每次都成功，且它连自己的日志文件都没建）。
  既然它只影响「无凭据时的握手阶段」，而认证这一关本来就过不去，**先不追**；要继续追，就得给 ACP 的 spawn
  加一次性诊断（实际 argv / cwd / PATH / 退出码 / 完整 stderr）并打一次包。
- 一句话口径：**机检③ 3/4，缺的那一个卡在凭据形态，不是卡在下载、版本、参数或我们的代码质量。**

## 九 为什么对标产品「装下来就能用」，我们复杂：它做了三个我们没做的决定

拆对标产品的安装包（同源代码库；`spawn` 那段与我们原来一字不差：裸 `--acp`、
同样的 `needsShell` 正则、同样的 `augmentedPathEnv`）后拿到的读数：

| 维度          | 它                                                                                                                             | 我们                                                           | 后果                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安装方式      | 自己取 registry 元数据 + **tarball 解压**到 `codebuddy-managed/`（`resolvePackage` + `TAR_BLOCK`），失败回退 npmjs → npmmirror | `npm i -g @tencent-ai/codebuddy-code`                          | 它的安装不依赖 npm 前缀/权限/用户 npmrc；我们那次耗时 134.7 s，且受全局 prefix 影响                                                                                                |
| 版本          | **钉死** `CODEBUDDY_VERSION = "2.138.0"`，`isSupportedCodeBuddyVersion = (v) => v === "2.138.0"`（别的版本一律视为不支持）     | 认任何探测到的版本                                             | 我们落到 **2.177.1**：实测裸 `--acp` 在 ≥2.174 上**默认不再是 stdio**（40 秒 0 字节），它钉的 2.138.0 上裸 `--acp` 仍回 initialize（648 字节）——这就是「它行、我们不行」的直接原因 |
| provider 注入 | `CODEBUDDY_CHAT_COMPLETIONS_URL` + `CODEBUDDY_DEFER_TOOL_LOADING` + `CODEBUDDY_DISABLE_BACKGROUND_TASKS`                       | `CODEBUDDY_BASE_URL` + `CODEBUDDY_MODEL` + `CODEBUDDY_API_KEY` | 变量形态不同；实测给它 `CODEBUDDY_CHAT_COMPLETIONS_URL` 后 initialize 正常回（536 字节，`id:1` 在）                                                                                |

认证那关两边一样严：**连它钉的 2.138.0**，不注入凭据时 `session/new` 也回
`-32000 Authentication required`；注入凭据后不再是报错，而是**等端点**（无凭据 60 秒不回 id:2）。
所以它「能用」的前提是 provider 凭据注入成功，而不是 codebuddy 不需要认证。

### 所以它「简单」不是魔法，是三件事

1. **自己管安装**（tarball 直解），不把 npm 全局状态当契约；
2. **只支持一个版本**，把「行为随版本漂移」变成编译期就能看出来的不支持；
3. **按 codebuddy 期望的变量注入模型端点**，而不是我们自拟的 `BASE_URL + MODEL`。

我们照抄这三条，才是把 codebuddy 做到 4/4 的正路；继续在「探测任意版本 + 自拟变量」上加参数，
只会不断遇到下一个同类差异。

## 十 结局：真正的根因是「框架 → 二进制」的解析，不是 ACP 也不是凭据

新增的 spawn 诊断行给出了答案，一行字：

```
[acp] agent spawn { framework: 'codebuddy', executablePath: '/opt/homebrew/bin/opencode', … }
```

`backend-resolver` 里那个三元只特判 `codex`，**其余框架一律走 `resolveOpencodeExecutable`**；而 codebuddy
的探测结果（`setCodebuddyInfo` 存下的路径）在 `src/main` 里**没有任何一处读它**（grep 计数为 0）。所以
「选中 codebuddy」实际执行的是「用 codebuddy 的 argv 去跑 opencode」——opencode 不认识 `--acp`，打印 banner
后 `exit 1`，上层只能看到 `ensureConnected: connect failed`，stderr 里没有有用的东西。

**这同时解释了为什么我前面所有手动实验都成功**：那些实验跑的是真 codebuddy，而应用跑的是 opencode。
我把差异归因到 PATH / 版本 / env / cwd，全是错的——它们不是差异所在，因为被测对象根本不同。

修好之后（`5003afc8`）的打包版读数：

```
framework selection { stored: 'codebuddy', resolved: 'codebuddy' }
agent spawn { executablePath: '/Users/totota/.local/bin/codebuddy' }
connect failed 计数：0
session capabilities built { framework: 'codebuddy', transport: 'stdio', count: 14, groups: '5 core,9 deferred' }
Run completed（exit 0）
```

⇒ **机检③ 4/4**。

### 两条留作教训的判断失误

1. **「用手动能跑」不等于「产品在跑同一件东西」**。定因的第一步应该是确认**被测对象身份**（这里一行
   `executablePath` 就能省掉后面全部实验），而不是先怀疑环境差异。
2. 我曾据此写下「4/4 卡在凭据形态，需要交互式组织登录」——**这条结论是错的**，已作废。凭据那关由应用注入
   provider key 就能过（codebuddy 会话成功建立即为证）。`session/new` 在**无凭据**时的 `-32000` 是真实行为，
   但它不是本产品的阻塞点。
3. 版本与传输开关的发现仍然有效（裸 `--acp` 在 2.174+ 默认不再是 stdio），只是它不是这次「连不上」的原因。

## 十一 四框架回归（装机件 2.19.0 + `5003afc8`，同一台机器）

修复「框架 → 二进制」的解析之后，把四个框架各自跑了一次真实会话，读 `agent spawn` 行的
`executablePath`：

| 框架        | 实际启动                                             | connect failed | run    |
| ----------- | ---------------------------------------------------- | -------------- | ------ |
| claude-code | `/opt/homebrew/bin/claude`                           | 0              | exit 0 |
| opencode    | `/opt/homebrew/bin/opencode`                         | 0              | exit 0 |
| codex       | `~/.purescience/codex-managed/adapter/dist/index.js` | 0              | exit 0 |
| codebuddy   | `/Users/totota/.local/bin/codebuddy`                 | 0              | exit 0 |

四个各不相同、且都是该框架自己的入口——这是「选中的框架 == 实际启动的二进制」这一条契约的
可复现读数，也是这次修复真正被验证的地方（不是「某个框架能连上」，而是「四个都对上自己的」）。

装载方式：`rm -rf /Applications/PureScience.app && cp -R dist/mac-arm64/PureScience.app /Applications/`，
版本 2.19.0，asar 里 `resolveCodebuddyExecutable` 计数 2（修复前为 0）。
