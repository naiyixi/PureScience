# 交接：v2.17.7 之后、v2.18 / v2.19 进行中（2026-10-25）

> 给下一个会话：这份文件是**开工前置**，不是完成声明。先跑 `git status --short` 与 `git log --oneline -5`，
> 再读 §4 的阻塞表——每一条都写了 `blocked-by` 与解封条件，别从零调研。

## 1. 本轮已发布 / 已发布件

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

| 项                                               | 状态                                              | blocked-by                                                                                                             | 解封后第一步                                                                                                                                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~Windows 车道红~~                               | **已解除**（2026-10-25，`0bd9594a` + `02a118d0`） | —                                                                                                                      | 已由本会话接手修掉：原用例在真实时钟下要求「profiled 记录里出现本测试文件的帧」，测的是 runner 调度器而不是 watchdog；改成「承诺用可注入 profile 逐条断言（两次停顿都要有具名帧 + 归因）、真实采样只断言任何 runner 都办得到的事」。Windows 8/8 分片全绿 |
| ~~Release 前置~~                                 | **解除**                                          | —                                                                                                                      | Windows 绿了，可发下一版（注意 `02a118d0` 的 Nightly 判决还没回）                                                                                                                                                                                        |
| **v2.18.0 发布 DMG 字节校验**                    | **未完成**（同一提交的本地打包已装机验证）        | 本机到 GitHub CDN 只有 ~20 KB/s 且 `PROTOCOL_ERROR` 断流；断点续传多轮停在 120–156 MB / 284.2 MB                       | 换网络后：`shasum -a 256` 对 `SHA256SUMS.txt`，再装一次读日志（预期 `open-project-db` 仍是 330 ms —— 发布件里没有快路径）                                                                                                                                |
| P0 认证 red（`ae07ea8f`）                        | **属 e2e 在制单元**，非本轮改动                   | 失败用例 `e2e/certification/pdf-annotation-search-evidence.spec.ts:332`；执行器已用 `2dbdb00d` 修该读数来源 + 视觉闸门 | 等 `2dbdb00d` 的 Nightly 落地确认；若仍红，看 `project-create-dialog.png` 的 3717 像素差（1%）是否同类                                                                                                                                                   |
| 轨迹包**实物导出**                               | 未做                                              | 需要窗口交互（`support bundle` 走 save dialog，屏幕锁屏时无法操作）                                                    | 解锁后从 App 导出一次，核对 `trajectory/*` 六件与 `checksums.sha256`                                                                                                                                                                                     |
| **F：机检③**（现 1/4）                           | 未做                                              | 沙盒实例拿不到钥匙串凭据（`Authentication required`）；打包版单实例与 dev 无头抢同一配置根                             | 停掉 dev 无头后，用打包版 + 真实配置根跑 `PURESCIENCE_AGENT_FRAMEWORK=<fw>` 探针；拿不到凭证就如实记 N/4                                                                                                                                                 |
| **v2.18 §2/§3**（成本矩阵、usage 对账）          | 未做                                              | 需要真实模型调用（token）/ 对账需要一次真跑                                                                            | 先确认 §0 的核对结论：`AcpTurnTokenUsage` 早已落盘，别再新造记账结构                                                                                                                                                                                     |
| **v2.19 `message/send`**、agent card 之外的部分  | 未做                                              | 真正跑通需要模型；互通测试还需要第二个实现                                                                             | 先做「只读 + 明确 unverified」的部分，别在实测前说支持 A2A                                                                                                                                                                                               |
| 模型驱动的工具调用验证（v2.17.7 的 HTTP 工具面） | 未做                                              | 需要一次模型调用                                                                                                       | 一条 prompt 调 `memory_save_note`，判据见 CHANGELOG                                                                                                                                                                                                      |

## 5. 本轮踩过、别再踩的坑

1. 改过 `src/main` 后**必须** `npm run build`，否则 dev 实例加载旧 `out/`（我因此读到过一次 404）。
2. `npx tsc` 不带 `NODE_OPTIONS=--max-old-space-size=8192` → **Abort trap 6（134）**。
3. 提交消息含反引号必须写文件用 `git commit -F`（本轮 `-m` 被 shell 吃掉，提交根本没发生）。
4. 评测脚本末尾的 `grep -c` 零匹配会返回 1，看起来像失败（判据读 `BENCH_EXIT` 与 `Tests passed`）。
5. 打包版无头起 web 服务要 `--serve=<port>`，且**不支持** `--config-root`；dev 构建反过来（支持 env 根、不需要 `--serve`）。
6. 同一工作树里跑全量前先确认没有别的写入者刚落下提交（vitest 启动时收集文件清单）。
