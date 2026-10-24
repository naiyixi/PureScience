# 会话 MCP 就绪：逐服务真机读数（2026-10-25）

单位毫秒。两条口径在同一台机器上一次取完，`runId` 见下；命令可复跑（见文末）。

## 0. 为什么要这个

生产日志里一次会话建立有 **11 / 14 个服务一起超时**（`[mcp-readiness] Timed out waiting for MCP
servers: …`），随后 `createSession: first attempt failed, retrying once` 才成功——重试把问题掩盖了。
此前只有 `session capabilities built`（我们交配置花了多久），没有「每个服务多久到达就绪」，于是
「我们交得慢」与「它们起得慢」无法分开，也就无法决定该修哪一半。

## 1. 隔离实例里的一次真实会话（claude-code，14 个 stdio 服务）

- `session capabilities built`：`count=14`、`groups="5 core,9 deferred"`、**`buildMs=5`**
- 探针两遍（serial 一个一个起 / burst 14 个一起起），**14/14 全部 ready，无失败**

| 服务 | spawn(burst) | initialize | tools/list 到达 | 工具数 |
|---|---|---|---|---|
| purescience_artifacts | 15 | 2042 | 2059 | 3 |
| purescience_notebook | 14 | 2299 | 2335 | 12 |
| purescience_skills | 12 | 2142 | 2150 | 6 |
| purescience_plan | 12 | 2383 | 2394 | 2 |
| purescience_memory | 11 | 2369 | 2380 | 3 |
| purescience_context_summary | 10 | 2242 | 2255 | 2 |
| purescience_routine | 8 | 2193 | 2207 | 3 |
| purescience_goal | 7 | 2087 | 2093 | 3 |
| purescience_endpoints | 6 | 2303 | 2359 | 7 |
| purescience_annotations | 5 | 2439 | 2442 | 3 |
| purescience_pdf | 4 | 2357 | 2373 | 7 |
| purescience_knowledge | 4 | 1890 | 1903 | 5 |
| purescience_figure | 3 | 2266 | 2277 | 1 |
| purescience_host_query | 1 | 1215 | 1359 | 1 |

serial 一遍：`initialize` 299–568 ms（最慢 artifacts 568）。burst 一遍：最慢 2,442 ms。
**`tools/list` 只比 `initialize` 多 8–150 ms** ⇒ 工具清单不是成本，握手本身就是成本。

## 2. 同一个子进程在开发树 / 安装版二进制下各要多久

子进程的真实形状是「二进制 + 主入口 + MCP 参数」。下面这条量的是「spawn → 模块加载完 → 因缺
RPC 环境退出」，即启动成本本身（不含握手）。

| 组 | serial 中位 | serial 最大 | burst 中位 | burst 最大 |
|---|---|---|---|---|
| 开发树 `Electron.app` | 319 | 505 | 1,858 | 2,043 |
| 安装版 `PureScience.app`（app.asar） | 405 | 808 | 2,635 | 2,729 |

两轮 `load average`：14.4 / 17.3 / 24.6（macOS，`sysctl -n vm.loadavg`）。

## 3. 结论（只写读数支持的部分）

1. **我方装配不是瓶颈**：`buildMs=5`。
2. **单服务到达就绪 = 一个 Electron-as-node 引导 + 模块图**：安装版 serial 中位 405 ms；14 个并发时
   被争抢放大到 2.4–2.7 s（约 6 倍）。`tools/list` 不是成本。
3. **本机在 load≈14 时仍有 3–4 倍预算余量**（2.7 s vs 代理侧 10 s）⇒ 生产那次 11/14 超时不是「每个服务
   天生要 10 秒」，只能来自当时的系统级争抢或主进程忙碌。旁证：同一时间窗里 `probe-codex` 也从
   585 ms 掉到 1,337 / 2,380 ms（同一台机器整体变慢），且连续三次重试都在 10 s 全灭。
4. 因此**不许调 10 s 预算**（那只是掩盖），能动的只有「少起进程」或「让每个进程起得更便宜」。这两条都
   牵动闭集清单（`APP_MCP_SERVERS`、权限身份目录、计数钉），属于下一个单元，不在本次范围。

## 4. 复跑

```bash
# 1) 隔离实例（两个根都要指，否则会话落进真实数据根）
ROOT=/tmp/ps-mcp-probe PORT=44331
pkill -9 -f "$ROOT/electron-userdata"; lsof -ti :$PORT | xargs -r kill -9
cp ~/.purescience/settings.json "$ROOT/settings.json"   # 没有 provider 行会在 createSession 就被拒
PURESCIENCE_CONFIG_ROOT=$ROOT PURESCIENCE_STORAGE_ROOT=$ROOT PURESCIENCE_WEB_PORT=$PORT \
PURESCIENCE_AGENT_FRAMEWORK=claude-code PURESCIENCE_MCP_READINESS_PROBE=1 \
node_modules/.bin/electron . --purescience-headless --disable-gpu --user-data-dir="$ROOT/electron-userdata"

# 2) 一次真实会话（读 ~/Library/Logs/PureScience (DEV)/main.log 里的 session capabilities built /
#    mcp readiness probe / mcp readiness probe summary）
purescience run --project <id> --prompt "只回复两个字符：ok" --wait --port $PORT --config-root $ROOT
```

注：`initialize` 之外还要发 `notifications/initialized` + `tools/list` 才算「客户端认可的 connected」，
只量 initialize 会低报；探针已按这个顺序发。

## 5. 单进程启动成本拆解（含一个被证伪的假设）

同一个二进制、同一台机器（load ≈ 14），各 7 次取中位：

| 组 | 开发树 | 安装版 |
|---|---|---|
| `-e ""`（只引导 node，不加载我们的代码） | 132 | **123** |
| `<主入口> --…-mcp`（引导 + 主入口 + 服务模块） | 266 | **305** |
| 差值 | 134 | 182 |

差值一开始被我判成「app 入口模块图」。**做完薄入口才证伪**：新增一个只 import `node:` 内建与
argv 常量的 `mcp-entry.ts`（构建 6.88 kB，对比主入口 121 kB），子进程改指它之后

| 组 | 中位 |
|---|---|
| 主入口 `out/main/index.js` + memory 服务参数 | 317 |
| **薄入口 `out/main/mcp-entry.js` + memory 服务参数** | **329** |

没有收益、甚至略慢 ⇒ 那 182 ms 不是 app 入口图（它本来就在应用分支里动态加载，5 MB 的 ipc
chunk 子进程根本不碰），而是 **MCP SDK + zod + 服务模块自身**的成本，任何要讲 MCP 的子进程都得付。
该重构已按「不留无收益重构」回退，未入库。

结论：单进程成本 = 约 123 ms Electron-as-node 引导 + 约 180 ms MCP SDK/服务模块，两者都压不动；
**唯一有效的杠杆是减少子进程个数**（14 → 更少），而不是让每个进程更便宜。

## 6. HTTP 通道：代理侧支持、应用侧只做了一半（实测）

claude-agent-acp 的 `initialize` 结果里 `mcpCapabilities: { http: true, sse: true }`，应用的
`AgentMcpHttpHost` 也已经在 `runtime-composition.ts` 里无条件构造。把 claude-code 的传输切成 http 后
真机会话的读数：

```json
{"framework":"claude-code","transport":"http","count":4,
 "servers":"purescience_artifacts,purescience_notebook,purescience_plan,purescience_skills",
 "groups":"5 core,1 deferred","buildMs":1}
```

**count 只有 4**：`buildHttpServers()` 里只有 artifacts / notebook / skillImport / plan 四段
（`host.registerArtifact|Notebook|SkillImport|Plan`），其余 ten 类（memory、context_summary、routine、
goal、endpoint、annotation、pdf、knowledge、figure、query）没有 HTTP 注册通路。因此：

- 此刻把任何一个框架切到 http，都会**静默丢掉 10 个能力**——这正是要修的那类缺陷，不能这么做；
- 反过来也是一条既有隐患：任何只接受 http 的框架（历史上 opencode 就是）在这些能力上是**缺的**，
  只是没有任何日志说过这件事；
- 本次的翻转已回退（`claude-code.ts` 里留了具名注释与判据）。基础设施（`resolveMcpTransport` +
  `acceptsHttpMcp?`）留下，语义是「未声明 = 沿用旧规则」，所以现有行为一字未变（37 例定向用例全绿）。

下一步单元因此定为：把剩下 ten 类接进 HTTP 宿主（每类 = 宿主注册 + 每请求构服务器的分支 + 用例），
14/14 都在 http 上之后再把 claude-code 翻过去。收益是 14 个子进程 → 0。

## 7. 已完成：14/14 走 HTTP（真机读数）

十类逐个接进宿主（每类抽一个 `create<X>McpServerForEnvironment(environment)`，宿主加 kind/register/
buildServer 分支，owner 的 `buildHttpServers` 加同形状的一段），然后按判据验收：

```json
{"framework":"claude-code","transport":"http","count":14,"groups":"5 core,9 deferred","buildMs":3,
 "servers":"purescience_annotations,purescience_artifacts,purescience_context_summary,
 purescience_endpoints,purescience_figure,purescience_goal,purescience_host_query,
 purescience_knowledge,purescience_memory,purescience_notebook,purescience_pdf,purescience_plan,
 purescience_routine,purescience_skills"}
```

- **count=14**、十四名字逐个在列（不是 4）
- 该会话**没有**任何 `[mcp-readiness] Timed out`（整个 dev 日志该计数为 0）
- 结构上不再有 MCP 子进程：`buildHttpServers` 把环境注册进宿主，agent 连 `/mcp/<kind>/<routingId>`
- 门禁：`tsc -p tsconfig.node.json` exit 0；`eslint --cache=false`（12 个文件）0；定向 vitest **203 文件 /
  3,326 例全绿**；`npm run build` exit 0

⚠️ 未验证（不许当已验）：**真实工具调用**要模型，本轮的隔离实例拿不到钥匙串凭据（`Authentication
required`），所以「工具真能调通」只在传输层被证明（initialize + tools/list 十四类都过），
执行面留到装机后的发版验收，届时跑一次 memory 存一条 / plan 读一次。

### 7.1 执行面补证（不需要模型的那一段）

`src/main/acp/mcp-http-host.test.ts` 新增一例：起真的 `AgentMcpHttpHost`，注册 memory 环境到一个
记录请求的桩 RPC 服务，然后用真的 MCP 客户端走 StreamableHTTP 调 `memory_save_note`，断言：

- 工具列表里有 `memory_save_note`（宿主构建的是**真的** memory server，不是替身）；
- 工具调用落到网关的封装是 `{ method: 'memorySaveNote', params: { sessionId, categoryName, text } }`，
  即主进程侧真正期待的那个信封；
- 返回值透传（`note-1`）。

这一步把「HTTP 宿主 → 十类真实 server → 工具执行 → RPC 网关」这条链钉住了；仍然缺的只有
「**模型**决定去调工具」这一段，它与传输无关，留装机验收。




