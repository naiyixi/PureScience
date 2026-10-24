# settings:get-preflight —— 一次 14 秒的无归因等待，与每次重跑的同一个探测

窗口：打包版 **v2.16.0** 真机日志（只读）`~/Library/Logs/PureScience/main.log`，**1,174** 条，
`2026-10-23T12:29:48Z → 2026-10-24T01:57:52Z`；对照为同版本更早的两份日志 `main.1.log` / `main.2.log`
（`09:30:27Z → 12:29:48Z`）。

## 一 读数（IPC 处理器慢日志，按通道聚合）

| 通道 | 次数 | 中位 | 最大 | 合计 |
|---|---|---|---|---|
| `settings:get-preflight` | **35** | **14,034.8 ms** | **35,060.4 ms** | 528.8 s |
| `runtime:manage-named-environments` | 4 | 117,915.2 ms | 143,726 ms | 481.0 s |
| `settings:install-codex` | 2 | 175,156.1 ms | 288,398 ms | 350.3 s |
| `settings:check-environment` | 9 | 28,724.8 ms | 42,249.2 ms | 216.4 s |
| `runtime:get-enablement` | 8 | 21,894.0 ms | 23,184 ms | 177.3 s |
| `settings:npm-available` | 29 | 2,105.0 ms | 22,604 ms | 117.4 s |

- 35 次 `get-preflight` 分散在 12:30–15:46（相邻两条多数相隔 10–60 s，仅 `13:07:10.493` 与 `.503` 是一对并发），
  即**每一次打开设置面就重付一次**，不是一次启动开销。
- **同一版本更早的两份日志里这两条通道一次都没有出现**（`main.1.log` 10,635 条、`main.2.log` 10,475 条，
  `slow` 记录 0 条）⇒ 变慢发生在 12:29 之后的那段窗口，而不是某个版本引入的常量成本。
- 处理器级阈值是一整秒，**那条日志只写了通道名与总时长**，没有任何一步的归属 ⇒ 就算想改也不知道改哪一段。

## 二 机侧归因（先量再改：这段窗口不能用来比较代码好坏）

同窗口的 `diagnostics / event loop stalled` 记录（**190** 条带 `lateMs`，另有 265 条旧形态无该字段）：

| 指标 | 中位 | 最大 |
|---|---|---|
| `lateMs`（本轮事件循环被推迟） | 1,424.5 ms | 31,567 ms |
| `loadAvg1m` | 39.2 | **164.9** |
| `cpuShare`（本进程在窗口里拿到的 CPU 占比） | **0.077** | 0.526 |
| `freeMemMb` | 152 | — |

`attribution` 分布：`process-not-scheduled` **99** / `inconclusive` 80 / `cpu-bound-in-process` 11。
本进程只拿到 **7.7%** 的 CPU、系统负载中位数 39（8 GB 机器），即**这段窗口的时间被机器侧吃掉了**。

结论：**此刻不适合按耗时做优化**（同一个 handler 在空闲时段是 0.6–1 s 量级，读数会随负载飘一个数量级）。
可做且与本机负载无关的，只有**去掉那些「不可能产生不同答案」的重复工作**——同一个二进制、同样的字节，
重复 spawn 一遍得到的版本号必然一样。

## 三 交付

| 位置 | 改动 |
|---|---|
| `src/main/settings/version-probe-cache.ts`（新） | `withVersionProbeCache`：**按文件身份**（`mtimeMs` + `size`，`stat` 跟随符号链接）记忆版本应答；**并发同键共享一次 spawn**（single-flight）；条目上限 64，最旧先淘汰。三条边界写进头注：**失败不记忆**（spawn 超时是机器侧瞬时现象，缓存它会把「装着的运行时」显示成「没装」）；**Windows 上 stat 缺失降级为 unknown**（该平台的探测经 shell 解析 `PATH`/`PATHEXT`，`stat` 看不见不等于跑不了）；**没有身份就不记**（身份读取本身出错时照常探测，只是不缓存） |
| `claude-detect.ts` / `opencode-detect.ts` / `codebuddy-detect.ts` / `codex-detect.ts` | `createDefaultDetectDeps()` 里的 `getVersion` / `getAdapterVersion` / `getCodexVersion` 全部包上该记忆层（注入式 deps 一个字节未动 ⇒ 既有用例的替身行为不变） |
| `src/main/diagnostics/compose-steps.ts` | 记录器新增可选 `messages`（三行文案），**默认值与原来逐字相同**，启动组合那条路径行为不变 |
| `src/main/settings/agent-runtime-manager.ts` | `getPreflight` 的四个二进制探测**并行**（互相独立）；每一步经记录器计时：`settings-read` / `probe-claude` / `probe-opencode` / `probe-codex` / `probe-codebuddy` / `provider-key`；单步 ≥250 ms 记 `preflight step slow`，整次 ≥250 ms 再记**一行** `preflight steps`（含 `totalMs` 与最慢几步）；**快的 preflight 一行都不记** |

**真机探针读数**（产品自己的默认依赖包，跑完即删、未提交）：

```
claude   first=211.9ms  second=0.159ms  version=2.1.212/2.1.212
opencode first=1427.2ms second=0.202ms  version=1.19.3/1.19.3
missing  undefined      spent=0.166ms
```

即重复的那两次探测从 **211.9 ms + 1,427.2 ms** 降到 **0.36 ms**；不存在的路径从「起一个必然失败的进程
（上限 5–10 s）」降到 **0.166 ms**。代价是每条应答多一次 `stat`（微秒级）。

## 四 门禁（全部实跑，取自最后一次改动之后）

| 环 | 读数 |
|---|---|
| `src/main/settings` + `src/main/diagnostics` 整域 | **103 files / 1,511 passed**（3 skipped），exit 0 |
| 本笔 4 个测试文件 | **45 passed**（新增：缓存 13、接线 5、preflight 2、记录器文案 1） |
| 双 typecheck（`--composite false`，堆 8192） | node **EXIT 0** / web **EXIT 0** |
| `eslint --no-cache` 本笔 11 文件 | **0 errors**（改前 4 条 prettier warning，`prettier --write` 后复跑 **0 problems**） |
| 变异 ①：`claude-detect` 的 `getVersion` 去掉记忆层 | 接线用例恰红 **1** 条（`spawnCount` 2、版本 1.2.2） |
| 变异 ②：`agent-runtime-manager.ts` 回退到 HEAD | 并行用例 + 归因用例恰红 **2** 条 |
| `scripts/pre-push-checks.sh` | 见提交前实跑 |

## 五 边界（不许读成更强）

1. **没有真机窗口读数**：本轮全部证据是单测 + 产品默认依赖包的本地探针。要拿到「窗口里 preflight 变快」
   的读数，需要以新构建重启 dev 实例，而本机空闲页 4,409（≈69 MB）、swap **8.07 G / 9.2 G** ⇒ 未重启，**具名未取**。
2. **只覆盖二进制版本探测**。`settings:npm-available`（29 次、中位 2.1 s）走的是 `npm --version`，要先按 `PATH`
   解析出 npm 的真实路径才能有身份键，**本单元未做**，已具名立为下一单元候选。
3. **记忆的边界是「文件身份」**：若某个可执行文件的输出会随外部状态变化（而它自身字节不变），本层会把第一次的
   应答一直用到该文件被改写为止。仓内四个探测都是「读自身包版本」，不属于这一类。
4. **并行只在这四个探测之间**：`provider-key`（Keychain 解密）与 `settings-read` 仍是各自一步，没有和探测并行——
   它们与设置的读取顺序有关，本轮不动。
5. **不占版本号**：无用户可见文案、无窗口读数，属内部可观测性与重复工作消除。
