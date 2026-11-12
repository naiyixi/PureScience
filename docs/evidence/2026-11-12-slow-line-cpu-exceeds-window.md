# 慢行里的「cpu-bound」是怎么来的：一个比窗口还大的 CPU 读数被当成了判决

日期：2026-11-12（执行器本轮）
范围：`src/main/diagnostics/cpu-attribution.ts`（新增 `attributionForWindow` / `cpuExceedsWindow`）、
`src/main/settings/service.ts`（两处改用它）、`src/main/diagnostics/slow-operation-ring.ts` 与
`src/main/application-command-router.ts`（各补一个可选字段）。

## 一 读数来源与口径

打包版与 DEV 版的 `main.log` / `main.1.log` / `main.2.log`（只读，未改动，六份）：按
`scope=ipc`、`msg=ipc handler was slow` 过滤，共 **6,384 行**。

每行带 `durationMs`（墙钟）与 `cpuMs`（`process.cpuUsage()` 的**全线程**累计）。

## 二 读数：1,140 行的 CPU 比自己的墙钟还长

| 形状                         | 行数      | 占全部慢行 |
| ---------------------------- | --------- | ---------- |
| `cpuMs > durationMs`         | **1,140** | 17.9%      |
| 其中 `durationMs ≥ 100 ms`   | 494       | 7.7%       |
| 其中 `durationMs ≥ 1,000 ms` | 30        | 0.5%       |
| 其中 `durationMs ≥ 5,000 ms` | 5         | 0.08%      |

按通道（`cpuMs > durationMs` 的行 / 该通道全部慢行）：`sessions:save-session` **877 / 4,012**、
`notebook:state` 62 / 164、`reviewer:get-for-session` 40 / 168、`acp:send-prompt` 24 / 364、
`artifacts:read-preview` 18 / 83。最典型的五行：

```
20005 ms   cpuMs 26928   cases:marketplace          （2026-11-09）
18823 ms   cpuMs 20816   cases:install              （2026-11-05）
15810 ms   cpuMs 16464   sessions:save-session      （2026-11-09）
 7100 ms   cpuMs 11488   cases:marketplace          （2026-11-09）
 6416 ms   cpuMs  8221   acp:get-plan-projection    （2026-11-05）
```

**这 1,140 行全部被分类成 `cpu-bound-in-process`**（当时全仓 3,642 行属这一类，占慢行的 57%）。

## 三 判决：这不是「这条通道在算」

一个串行执行完这次调用的 handler，不可能在 20,005 ms 的墙钟里烧掉 26,928 ms 的 CPU。多出来的部分
**必然**跑在别的线程上（V8 的并发编译/GC 线程、worker、其它 libuv 线程池工作）。`process.cpuUsage()`
是全线程累计，`src/main/diagnostics/cpu-attribution.ts` 的头注本来就写着这一点。

于是 `cpuShare = min(1, cpu/window)` 把两件不同的事压成了同一个数 1：

- 这条调用自己 100% 占满了窗口（该算我们的）；
- 别的线程在忙、这条调用在等（**不该**算我们的）。

而分类器只看这个被夹住的 share ⇒ 一律给 `cpu-bound-in-process`。**连续两轮**据此读错过：
§三百一十七 把 `cases:marketplace` 的 9 行读成「cpu-bound」并去查这条通道在算什么，
§三百一十八 用「cpuMs 比 durationMs 还大」否掉它（那次的读法是对的，但那是靠人肉看出来的，
不是仪器说出来的）。

## 四 改动（判据 + 一处单源）

| 位置                                                      | 改动                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cpu-attribution.ts`                                      | 新增 `cpuExceedsWindow(cpuMs, windowMs)`：`windowMs > 0 && cpuMs - windowMs > 1`；新增 `attributionForWindow(cpuMs, windowMs)`：超窗 ⇒ `inconclusive`，否则沿用 `classifyCpuShare`。`cpuAttributionFields` 改用后者，并在超窗时补一个**具名字段** `cpuExceedsWindow: true` |
| `settings/service.ts`                                     | 两处（阶段计时与整段 key 迁移行）改用 `attributionForWindow` / `cpuExceedsWindow`，不再各自算一套                                                                                                                                                                          |
| `slow-operation-ring.ts`、`application-command-router.ts` | 记录/诊断类型各补这个可选字段，免得「运行时有、契约里没有」                                                                                                                                                                                                                |

**为什么留 1 ms 余量**：`cpuMillisecondsBetween` 把微秒读数四舍五入成整毫秒，一个真的占满窗口的
串行 handler 最多只会高出 0.5 ms。1 ms 的余量专门挡这个舍入假阳（实测 1,140 行里只有 **66 行**的
超额 ≤1 ms），更大的差额不可能是舍入。

**为什么保留 `cpuShare`**：它仍然是测到的数（夹在 1），只是不再单独充当判决。判决被扣下时，
`cpuExceedsWindow: true` 就是原因 —— 不给一个没有交代的 `inconclusive`。

## 五 影响面（读数，不是推断）

修好之后同一份语料的分桶：`cpu-bound-in-process` 从 **3,642 行降到 2,502 行**（-31%），
被扣下判决的 1,140 行改读 `inconclusive + cpuExceedsWindow`。≥1 s 的 30 行按通道：
`sessions:save-session` 18、`cases:marketplace` 5、`reviewer:get-for-session` 2，其余五个通道各 1。

这些行**不是**被判定成「没问题」：它们是「这份读数不能回答『在不在算』」。下一步要回答这个问题，
得换一种量法（下面 §七），不是改阈值带。

## 六 门禁

| 环                                                                                          | 读数                                                                                                                      |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 定向（`src/main/diagnostics` + `application-command-router.test.ts` + `src/main/settings`） | **124 passed \| 1 skipped（125 文件）**，**1,724 passed \| 3 skipped**                                                    |
| 定向（四份直接相关文件）                                                                    | 4 files / **31 passed**（新增 3 例：超窗不给判决、具名标记只在超窗时出现、1 ms 余量）                                     |
| 双 typecheck（`--composite false`，node 侧 `NODE_OPTIONS=…8192`）                           | node 0；web 0                                                                                                             |
| `eslint --no-cache`（六个改动文件）                                                         | 0 error / 0 warning                                                                                                       |
| 全量 vitest `--maxWorkers=4`                                                                | **1,478 files（1,478 passed \| 31 skipped）/ 18,485 passed（228 skipped）**，exit 0（基线 18,482，多出的 3 例是本笔新增） |

## 七 边界与没做的事

1. **没有改阈值带**（0.6 / 0.15 一个字没动），也没有新增原因：超窗这一态只说明「这个数不是本窗口的
   share」，不说明时间去哪了。
2. **仍然不区分「在等外部」与「别的线程在忙」** —— 全线程计数做不到。要分开需要另一支仪器
   （单线程侧的 event-loop utilization 或按线程采样），**本轮没有做**，因为那会改判定的语义面，
   先把「不能自称算过」这条落地。
3. **不是装机读数**：六个日志文件来自已发布版本的运行，改动本身要等下一次发版才在用户机器上生效；
   本轮不给「装机后行数会变」的承诺，只给「装机的日志会自己说出原因」这一条。
4. 阶段级的 `phases` 只保留 `{ms, attribution}`（不带标记），因为它是汇总串的一格，不带键值对结构。
