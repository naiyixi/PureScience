# 启动那趟的组成：扫描 512 ms、派生状态 1336 ms（真机拆解）

- 日期：2026-09-18
- 实例：`electron-vite dev`（本仓，**带新增的 `scanDurationMs` 计时**）— headless，**自己的 user-data-dir** 与端口 44102
- 语料：真实数据根的副本（`/tmp/ps-bench-attrib`，59 会话），真实根未被指向
- 触发：进程启动那一次 `session-hydration`（`startupCleanupEligible: true`）

## 一、数字（同一次运行）

| 组成 | 实测 |
|---|---|
| **扫描文档** `load-authority`（全量解析 59 份） | **512 ms** |
| **派生状态协调** `reconcile-derived-state` | **1336 ms** |
| 该趟合计 | **≈1.85 s** |
| 同次运行另有两项与本项无关：`install-lifecycle` 4753 ms（应用启动装配）、`fetch-manifest` 2836 ms（更新检查联网） | — |
| 完成状态 | `status: 'ready'`、`sessionCount: 59` |

## 二、为什么先测这个（以及一个被证伪的量法）

计划里的「启动协调水位增量，判据 < 1 s」隐含一个前提：**省掉重新解析就等于省掉那趟**。先量才知道前提真假 —— 结果是 **假**：

- 文档水位最多动到那 **512 ms**；
- 剩下 **1336 ms** 是 `reconcile-derived-state`，它逐会话读**整份文档 + 产物存储 + 文件索引 DB**；文档没变而恢复仍必须发生的情形是被用例保护的既有行为（`artifact-finalization-recovery.integration.test.ts`），因此**不能**用文档指纹跳过它。
  ⇒ **原判据达不成**（理想水位也只省 ~0.5 s / 1.85 s），这一项据此**改写**为设计问题：需要第二把尺（产物存储 + 文件索引 DB 的按会话修订），并先证明"存储侧无变化即可跳过"。

**一个被证伪的量法（记下来免得再试）**：用 vitest 进程量这些开销**不可用** —— 同一语料下，同进程内 `读取59份(172 ms) + JSON.parse(113 ms) + normalize(116 ms) ≈ 401 ms`，而仓库的 `loadAllWithDiagnostics()` 在同一进程里报 **19,186 ms**（约 48×），而**应用内**同样的"扫描+协调+序列化"是 **1368 ms**。⇒ vitest 的转换/源码映射开销使 CPU 密集路径放大一个数量级，属**测量环境失真**，不能用它做归因，必须测应用侧。

## 三、本批顺带留下的产品价值

`session-hydration` 的完成日志现在带 **`scanDurationMs`**（此前只有 `reconcile-derived-state` 有耗时，扫描那半完全不可观测 —— 正是这次卡住的地方）。三条完成路径（partial / degraded / ready）都带上。

## 四、操作上的两个坑（本轮各踩一次）

1. **第二个 dev 实例必须有自己的 user-data-dir**：与用户常驻实例共用 dev profile 时，新实例会**静默退出**（日志停在 `starting electron app...`、无监听）。加 `--user-data-dir=/tmp/ps-udd-attrib` 即正常。
2. **`pkill -f "electron-vite dev"` 会连带杀掉用户的 launchd 常驻实例**（它的命令行走同一个名字）。本轮误杀一次，KeepAlive 自愈（约 15 s 内重新监听 44100）。正确做法：只按**自己实例独有的特征**（user-data-dir / 端口 / 父 PID）结束进程。

## 五、诚实边界

1. 单次运行的一组数字（两半各一次），不是分布；用途是**否决一个前提**，不是评估优化收益。
2. dev 构建；打包版同一路径未再拆（打包版的该趟合计此前测得 2464 ms）。
3. 该趟与 `install-lifecycle` 并发，所以绝对值含启动争用；两半的相对比例才是本档要用的结论。
