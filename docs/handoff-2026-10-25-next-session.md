# 交接：v2.18 系列四连发已完成（2026-10-26）

> 本文件在 2026-10-26 刷新过：v2.18.0 / v2.18.1 / v2.18.2 / v2.18.3 **四个版本都已发布并验证**，
> §4 只剩需要外部条件的四条。

> 给下一个会话：这份文件是**开工前置**，不是完成声明。先跑 `git status --short` 与 `git log --oneline -5`，
> 再读 §4 的阻塞表——每一条都写了 `blocked-by` 与解封条件，别从零调研。

## 1. 本轮已发布 / 已发布件

**v2.18.0 → v2.18.3 四连发（都已发布页 + 装机验证）**

| 版本    | tag commit | 内容                                                             | 装机读数                                            |
| ------- | ---------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| v2.18.0 | `505858ad` | 钥匙串只在真要迁移时问、codex 探针缓存化、轨迹包、agent card     | `open-project-db` 406 ms（修复前基线）              |
| v2.18.1 | `d4b7b00c` | 项目库 DDL 快路径（指纹 + schema_version）、技能目录缓存按目录存 | `open-project-db` **106 / 148 ms**                  |
| v2.18.2 | `f4417298` | 镜像测速移出启动路径（channel 惰性解析）                         | `web-service-started` **1735 ms**（改前 2480–4170） |
| v2.18.3 | `37b236cc` | usage 落日志（第二来源）、真机验证三项                           | Release run `completed/success`                     |

四份发布页均 21 个资产、`draft=false`，`RELEASE-CERTIFICATION.json` 的 `sourceSha` 与 tag commit 逐字符一致；
v2.18.1 / v2.18.2 的 DMG 做过本地重算（v2.18.2 三源一致），v2.18.3 只到「清单 ↔ GitHub digest 一致」。

## 1.1 v2.17.7（上一轮）

- **v2.17.7 已发布并装机**（tag `v2.17.7` → `b433207a`）：Release 页 `draft=false`、21 个资产、
  `RELEASE-CERTIFICATION.json` 的 `sourceSha` 与 `git rev-parse 'v2.17.7^{commit}'` 逐字符一致。
- 该版内容：14 个 MCP 能力从「每会话 14 个子进程」改为走应用自己的 HTTP 宿主（`transport: http, count: 14`，
  零就绪超时）；同版含 egress 收尾、启动归属第 12 阶段、`buildMs` 读数、逐服务就绪探针。
- 装机读数（打包版，三次启动）：`compose runtime steps` **375 / 416 / 497 ms**，`read-stored-settings`
  **4–9 ms**，最慢已是 `open-project-db`（323–497 ms）。

## 2. 本轮已落地（全部有提交号，可逐笔查）

| 主题                 | 提交                                                   | 关键点                                                                                                                                                         |
| -------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 逐服务 MCP 就绪探针  | `987811e2`                                             | 默认关闭（`PURESCIENCE_MCP_READINESS_PROBE=1`）；serial + burst 两遍；读数在 `docs/bench-runs/2026-10-25-mcp-readiness-per-server.md`                          |
| 传输选择判定         | `83c748cb`                                             | `resolveMcpTransport()`；`acceptsHttpMcp?` 未声明=旧规则                                                                                                       |
| 14 能力全走 HTTP     | `6121beec`                                             | 十类接进 `AgentMcpHttpHost`；`count: 14` 真机读数                                                                                                              |
| 中文别名检索评测     | `f87dacc8`                                             | env-gated 脚本 + 40 条术语；**75% → 100%**（补 11 条蛋白/他汀词条 `9b5727e4`）                                                                                 |
| 探针缓存化（B 尾巴） | `11e9e18f`                                             | codex 适配器版本探针套身份键控缓存（每次启动省 300–990 ms）                                                                                                    |
| 钥匙串（C 尾巴）     | `3b1698e5` + `195bb941`                                | 没有待迁移 `keyRef` 就不再问钥匙串（`hasLegacyKeyRefs`）                                                                                                       |
| 轨迹包（v2.19 §2）   | `1b46939a` `1cfc84df` `e20c6d64` `f9abd3f9` `c24dd773` | 六段（manifest/session/tool-calls/artifacts/capabilities/checksums），脱敏复用 support-bundle 的 `scrubText`，`manifest.sections` 具名缺席原因                 |
| 会话能力投影         | `c24dd773`                                             | `sessionCapabilities`：建立时记 `descriptor.canonicalMcpServerNames`，缺席 ≠ 没有                                                                              |
| agent card 只读端点  | `9c51fb88`                                             | `GET /api/v1/agent-card`，真机读数在计划档 §7.2；`interop.a2a` 恒为 `unverified`                                                                               |
| 归档级验收           | `19bf1afb`                                             | 轨迹段 ENOENT 修复 + 「scrub 旁路仍被拒发」用例                                                                                                                |
| 启动：项目库快路径   | `2458555f`                                             | 180 条 DDL → 指纹 + `schema_version` 双判据；真机 `open-project-db` **330 → 126 ms**（首次 432 ms 写戳）；读数 `docs/bench-runs/2026-10-25-project-db-open.md` |
| 启动：技能目录缓存   | `e19a3094`                                             | 单槽缓存（N 个键抢 1 槽）改按目录 `Map` + 并发解析；p50 203→46 / 第二遍 260→29；真机掉到 250 ms 阈值以下                                                       |
| 启动：排队归因       | `c1eec738`                                             | `load-probe-answers` 的 107/189 ms 是排队——550 字节文件读一次 0.08 ms；**不做优化**                                                                            |
| 分区守卫修复         | `82512eff` `ae07ea8f`                                  | 新增真 SQLite bench 落进并发池 ⇒ Windows/Nightly 同红；按守卫规矩改配置（`DATABASE_TEST_GLOBS`），断言不动                                                     |

本地全量：`src/main src/shared src/preload` **939 文件 / 12,679 例全绿**（排除 integration 与 net-fetch，按仓里配方）。

## 3. 环境（现取现写，别照抄旧版）

- 工作树：`~/purescience`，`main` = `19bf1afb`。
- **并发写者**：cron 执行器（每 2h）仍在同一树里活动，最近在 `src/main/diagnostics/*`
  （`event-loop-stall-watchdog`、`ipc-rejection`、`loop-held-windows`、`host-stall-sampler`）。
  提交前 `git status`，只 `git add` 自己动过的路径；发现撞车**让位**。
- 遗留进程：`83003`、`84304` 两个打包版无头实例（`/tmp/ps-2177-ud`），以及 `/tmp/ps-2177-run`、
  `/tmp/ps-2177-serve.log`。清理需要用户放行（`kill` 被守卫拦过）。

## 4. 未完成项（每条带 blocked-by 与解封条件）

| 项                                | 状态                                                                                                        | blocked-by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 解封后第一步                                                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **A2A 互通**                      | 未做（`interop.a2a` 恒为 `unverified`）                                                                     | 需要第二个 A2A 实现                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 起一个外部实现，跑一次 `message/send` 往返                                                                                       |
| **F：机检③**（现 **2/4 可复现**） | opencode / claude-code 有可复现读数；**codex 的读数已撤销**（来自已被证伪的 settings 注入路）；codebuddy 缺 | 不存在把框架注入一次无头 run 的缝：`StartTaskRunRequest` 无 framework 字段、`PURESCIENCE_AGENT_FRAMEWORK` 对 CLI 驱动无效、设置存储里没有 `agentFrameworkId` 键（`framework selection { forced: null, stored: null }`）。原记录：codebuddy 的设置切换不生效：`agentFrameworkId=codebuddy` + `purescience run` 返回 0、打印 `Session created`，但落盘会话是 `claude-code`（日志 `framework: 'claude-code'`）；`StartTaskRunRequest` 无 framework 字段，`PURESCIENCE_AGENT_FRAMEWORK` 对 CLI 驱动不生效 | GUI 里切框架后重跑；或给 `StartTaskRunRequest` 加 framework 字段（功能改动）。证据 `docs/evidence/2026-10-27-machine-check-3.md` |
| ~~`/tmp/ps-2177-*` 清理~~         | **已完成**（2026-10-27）：`ps-2177-run`/`-ud` 目录 + 本轮 4 个 DMG（~813MB）已删                            | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 直接删并把清单记档                                                                                                               |

**已结清、别再当未完成**（每条都有读数或证据文件）：

- Windows 车道红（`0bd9594a` + `02a118d0`）；`egress.test.ts` 的 3 秒看门狗 flaky（`25d4c0a7` 修，v2.18.2 版记里做了口径更正）；
- 项目库 `open-project-db` 330/406 → 106–148 ms（`2458555f`）；技能目录缓存 203→46 / 260→29 ms（`e19a3094`）；
- 镜像测速移出启动路径（`bca5a279`），真机 provision 端到端验过（`9c4a0770`，28.9 s，探测到 TUNA 镜像）；
- 启动归因收口：不存在「未归因的 400–500 ms」，那是 compose 汇总行排除步骤间空隙的假差额
  （`docs/evidence/2026-10-26-startup-attribution-closed.md`）；
- 轨迹包实物导出（`739ddd47` 真窗口回读）+ `toolCalls` 从 `absent:not-collected` 变为可产出
  （`d9e38b53`，真实会话 `calls=1 / unnamed=0`）；
- 模型驱动的工具调用（HTTP 工具面 + 权限门）验实（`d9e38b53`）；
- **usage ↔ 日志对账**（v2.18 §2 第 4 条）：真回合 `5701eafe`（2026-10-27T10:43Z）六个字段逐字段相同。
  中间踩到一处真缺陷：`cacheTokens` / `cachedReadTokens` / `cachedWriteTokens` 被自家脱敏规则当秘密抹成
  `[redacted]`（`isTokenMetricKey` 的名单缺 `cache`/`read`/`write`），修法只补这三个计数词（`b6a2dbc3`），
  证据 `docs/evidence/2026-10-27-usage-reconciliation-partial.md`。

## 5. 本轮踩过、别再踩的坑

1. 改过 `src/main` 后**必须** `npm run build`，否则 dev 实例加载旧 `out/`（我因此读到过一次 404）。
2. `npx tsc` 不带 `NODE_OPTIONS=--max-old-space-size=8192` → **Abort trap 6（134）**。
3. 提交消息含反引号必须写文件用 `git commit -F`（本轮 `-m` 被 shell 吃掉，提交根本没发生）。
4. 评测脚本末尾的 `grep -c` 零匹配会返回 1，看起来像失败（判据读 `BENCH_EXIT` 与 `Tests passed`）。
5. 打包版无头起 web 服务要 `--serve=<port>`，且**不支持** `--config-root`；dev 构建反过来（支持 env 根、不需要 `--serve`）。
6. 同一工作树里跑全量前先确认没有别的写入者刚落下提交（vitest 启动时收集文件清单）。
7. **`src/main/net/egress.test.ts` 的 reset 那条不是抖动、也不是产品漏关**（2026-10-26 定因并收口，队列档 §二百三十七）：
   真 loopback 上约 3–5% 的 reset，对端 socket 仍是 `open`、无 `end`、**写一个字节还能 flush** ⇒ 代理拿不到事件。
   现在真 TCP 一侧只在**观察到结束包**时断言目标被关，漏断言由两支确定性 pin 承担（`ECONNRESET`+destroy、
   无 error 无 end 的静默 close）；`teardown` 也补了具名日志（`reason`/`hadTarget`）。改这块时别把它改回无条件等待。
