# 事件循环停顿的归因（2026-10-28）：从「这个进程没花 CPU」到一个能被核对的类别

排期行：`docs/plan-2026-10-28-two-releases.md` §三 A5 ——「停顿归因三类化 / 现状 24 条全兜底 / 目标 可解释率 100%（每条都有具体类别与毫秒），不再出现 `no-cpu-in-process` 兜底」。

## 一 病：三个处境，一个词

近 7 天 `~/Library/Logs/PureScience/main.log`（error/warn 共 214 条）里 24 条 `event loop stalled`，低 CPU 段的**全部**读数是同一个词：

```
{"msg":"event loop stalled","data":{"windowMs":…,"cpuMs":287,"cpuShare":0,"attribution":"no-cpu-in-process"}}
```

`no-cpu-in-process` 是**测量**，不是原因（`cpu-attribution` 的头注释早就这样写着）：三种完全不同的处境都会落到它 —— 操作系统没调度我们、我们在等进程外的东西、或者一段 stop-the-world 暂停占了主线程。读它的人拿不到任何可行动的信息，只能把整段调查重做一遍。

## 二 两条真数据先于两个阈值

**(a) 设备上那次 canary 的分布**（同一份日志里 `managed preview acquire was slow` 自带的 `canaryMs`，57 个样本）：

| 量 | 读数 |
| --- | --- |
| 最小 / 中位 / p90 / 最大 | **1 / 24 / 180 / 686 ms** |
| ≤ 2 ms（线程池空闲） | **5** 条 |
| ≥ 20 ms（线程池被占） | **29** 条 |

这条读数本来就有（`managed-preview-resources` 已在用），此前没人按分布读过：**慢 acquire 发生时，共享线程池多数时候真的在排队**。因此 `fs-queue-saturated` 的门槛取 **20 ms（空闲侧 0–2 ms 与占用侧 ≥20 ms 之间的空档）+ 窗口的 10%** —— 后者防止「24 ms 的排队」被写成「1.2 s 停顿的原因」。

**(b) 两个仪器在本机的实跑读数**（`scripts/bench/stall-cause-instruments.bench.test.ts`，生产仪器、非替身）：

```
GC status=measured pauseMs=10 pauses=45        # ~1 s 的分配抖动里 V8 真的报告了 45 次暂停
FS idleMs=0 saturatedMs=6 recoveredMs=0        # 预热后的 canary
```

**这份 bench 能证明什么、不能证明什么**：它证明两个仪器在本机**有读数**（而不是恒 `unavailable`），也证明 canary 会随池的占用变大；但合成 96 路并发读只把 canary 推到 **6–14 ms**，**复现不出生产里 20–686 ms 的那段争用** —— 真正的区分证据是 (a) 的设备分布，不是这条 bench。这一条写在这里，免得下一轮把 bench 的 6 ms 当成「池不忙」。

## 三 交付（三个模块，一个字段）

| 位置 | 改动 |
| --- | --- |
| `src/main/diagnostics/gc-pause-monitor.ts`（新） | `PerformanceObserver('gc')` 的有界环（512 条）；`pauseMsWithin(start,end)` 按**交集**裁剪 —— 同一段暂停不能被相邻两个窗口各算一次；运行时拒绝观察 ⇒ `unavailable`（不是 0） |
| `src/main/diagnostics/stall-cause.ts`（新） | 一个类别 + 一句话 + 两个分量：`garbage-collection` / `fs-queue-saturated` / `cpu-in-process` / `unexplained` / `unmeasured`；阈值与设备读数一起写在常量旁边 |
| `src/main/diagnostics/event-loop-stall-watchdog.ts` | 每条记录新增 `cause`；GC 环与 canary 都在**启动时**就建好（停顿发生后才建的仪器只能描述恢复期，与 stack sampler 同一条教训）；canary 在停顿结束那一刻**发出**、与两个采样器一起 await |
| `src/main/diagnostics/support-bundle.ts` | 包内 `diagnostics/event-loop-stalls.json` 的说明加一段：`cause` 是什么、它凭什么 |

**两条不冒充**：`unexplained` = 两个仪器都跑了、都不解释这个窗口（`basis` 里点名了被排除的毫秒数）；`unmeasured` = 有仪器缺席，什么都没排除。把这两态合成一个词，正是「没人看着」开始读成「机器没事」的机制。

## 四 门禁（全部实跑，数字取自最后一次改动之后）

| 环 | 读数 |
| --- | --- |
| 定向 vitest（`src/main/diagnostics`） | **24 files / 184 passed**，exit 0 |
| 新增用例 | `gc-pause-monitor` 4 条（交集裁剪、`unavailable`、有界环、`stop` 断开）、`stall-cause` 7 条（五个类别的门槛与优先级、两个「不冒充」态、共享门槛）、watchdog 4 条（GC/FS/unexplained/unmeasured 各决定一条记录）+ 真时钟那一条补两条断言（生产仪器确实产出 `measured`） |
| 双 typecheck（`--composite false`） | node **0**；web **0**（两处夹具因新必填字段红了，按纪律补桩，没有把字段改成可选） |
| `eslint --no-cache`（本笔改动文件） | **0 error / 0 warning** |
| 全量 vitest | 见下节 |

## 五 边界（不许读成更强）

1. **同步 fs 没有被直接观测**。V8 只报告 GC；本片用「线程池 canary + 在飞计数」作为**代理**，`basis` 那句话就是这么写的（`fs canary 250 ms with 7 in flight`）。读代码的人不许把它当成「同步 fs 已归因」——本仓同一族里 `fs-queue-probe` 的头注释早写过这条界限。
2. **数据库那一路没有接进 `cause`**：`db-queue-probe` 的 canary 需要一个 Prisma 客户端，而 watchdog 在组合根的更外层。要接就得把客户端传进来（连锁更大），本片没做；低 CPU + GC 静默 + 池空闲的窗口仍落 `unexplained`，不会被假装解释。
3. **生产里还没有一条带 `cause` 的停顿读数**。`src/main/index.ts:235` 的调用点只传了 `log`，所以新字段在**下一次启动**（dev 常驻实例 07:03 起就在跑旧代码）之后才会写进日志与支持包。重启在跑实例需要用户点头 —— 这一条按「具名立案」记，不算已取。
4. **`gc.pauseMs` 的量级提醒**：本机 45 次暂停合计 10–13 ms（亚毫秒级 scavenge），所以 `garbage-collection` 在 500 ms 级停顿上要 50 ms 门槛才可能触发 —— 也就是说，**只有真的大回收**才会被点名为 GC；小的不会，这是有意的（否则每次停顿都能挂上 GC 这个名）。

## 六 下一轮第一步

① 按完整 40 位 SHA 读本笔的双车道判决；② 下一次重启/发版后，从 `main.log` 里 grep `"cause"` 取第一条真实归因读数并把分布返填本节（判据：类别 + `basis` 的毫秒都在）；③ 排期 A 段剩下的 `artifacts:read-preview`（86 条，最大 695 ms，`cpuShare` 0.315）—— 它的 acquire 路径已经有 canary 读数，但 `read-preview` 本身还没有分阶段字段，属于「先加归因再改」的形状。
