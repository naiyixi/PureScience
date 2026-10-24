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
