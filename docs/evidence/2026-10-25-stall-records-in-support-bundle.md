# 支持包里的「事件循环停顿」摘要（2026-10-25，执行器）

> 一句话：用户导支持包的那一刻，通常刚被卡过。此前那份证据只存在于运行时日志的一行 JSON 里
> —— 日志按字节上限从新到旧拷贝，长会话里最该看的那条可能已被轮转掉，且维护者要 grep 兆级文本。
> 本单元把它变成包里的一份机器可读摘要：`diagnostics/event-loop-stalls.json`。

## 一 交付（提交 `66fe6cd7`，9 文件）

| 文件 | 作用 |
|---|---|
| `src/main/diagnostics/stall-record-ring.ts`（新） | 有界环（默认 16 条）+ `summary()`：`capacity / observed / dropped / oldestAt / newestAt / status / records` |
| `src/main/diagnostics/event-loop-stall-watchdog.ts` | 每条上报的停顿**先入环再写日志**（写日志抛错时记录不丢）；新增 `records?` 注入缝，生产用共享环 |
| `src/main/diagnostics/support-bundle.ts` | 新增**必填** `facts.stalls`；写 `diagnostics/event-loop-stalls.json`（自建目录）；README.txt 增一节 |
| `src/main/ipc.ts` | 组合根把 `sharedStallRecords.summary()` 接进 facts（唯一生产读取方） |
| 三个测试文件 + `e2e/support-bundle.spec.ts` | 见 §三 |

**为什么是环，不是「解析日志」**：解析器会在日志格式变化时报告「零次停顿」，与健康机器**同形**；
环里存的是 watchdog 自己的 `EventLoopStallRecord`，只有一份词汇。**为什么要 `dropped`**：只报
`records` 会让「我们观察到 40 次」被读成「只有最后 16 次」。**为什么空表要具名**：空闲进程与
从没被观察的进程都产出空列表，所以空表写 `status: 'no-stalls-observed'`，不留给读者推断。

## 二 真机读数（探针实例，非用户实例）

做法：把产品自己的 watchdog + `createSupportBundle` 用 esbuild 打成单文件，用
`ELECTRON_RUN_AS_NODE=1 electron` 跑（真 Electron 的 Node/V8、真采样线程、真 `vm_stat`），
在主线程上真忙等 **1.6 s**，然后走 `createSupportBundle` 真组包。

```
runtime            electron=43.7.5  node=24.21.0  v8=15.0.245.31-electron.0  platform=darwin
ring               status=records observed=1 dropped=0 capacity=16
record             windowMs=1900 lateMs=1400 cpuMs=978 cpuShare=0.515
                   attribution=cpu-bound-in-process
                   stack.status=profiled  mainThreadMs=1878 unobservedMs=0
                   frames=[main (scratch/probe-stall-bundle.cjs:4379) × 27 samples]
                   host.status=sampled  samples=8 maxGapMs=267 continuity=unknown
                   host.freeMemMbMin=79  loadAvg1mMax=13.26  pageouts=0  swapouts=0
                   pagingWindowMs=1021
日志同一行         stack.status=profiled  host.status=sampled   （count=1）
包                 2163 bytes / redactions=0
                   entries = README.txt, environment.json, manifest.json, parsing-models.json,
                             runtime.json, diagnostics/event-loop-stalls.json, logs/main.log
解包读回           status=records observed=1 dropped=0 records=1，内容与环一致（含 at 时间戳）
```

## 三 门禁与自证

- `npx vitest run src/main/diagnostics --maxWorkers=2` → **17 files / 107 passed**（新增 1 文件 5 例 +
  看门狗 1 例 + 支持包 2 例）。
- `tsc --noEmit -p tsconfig.node.json --composite false` → **exit 0**；`tsconfig.web.json` → **exit 0**。
- 全仓 `npx eslint --no-cache .` → **exit 0，0 errors / 128 warnings**；其中唯一一条在本单元新增的
  `e2e/support-bundle.spec.ts` 上（prettier 折行），已 `--write` 并单文件复检 **0 problems**。
- `npx prettier --check src/main/diagnostics/*.ts src/main/ipc.ts` → 全部通过。
- `bash scripts/pre-push-checks.sh` → **exit 0**（含品牌词扫描零命中、README 双语锚点、模型清单门）。

用例各自钉住的判据（不是「有没有这个文件」）：

1. 环：容量 2 记 3 条 ⇒ `observed=3 / dropped=1 / records=[后两条]`，`oldestAt/newestAt` 来自注入时钟。
2. 环：存的是**完整记录**（stack 与 host 两半、机器读数都在），不是投影。
3. 环：空表 ⇒ `status='no-stalls-observed'`，`oldestAt/newestAt` 缺席而不是空串。
4. 环：`capacity=0` 仍保留 1 条；`summary()` 交出去的是副本（读者改不动 watchdog 的账）。
5. 看门狗：**写日志抛错时记录仍进环**（日志是较慢的那一半），且环里就是日志那条记录的同一份。
6. 支持包：三处计数齐（`observed=3 / dropped=1 / capacity=2`）、帧与 `at` 过归档仍在、`logs/` 仍在。
7. 支持包：**什么都没停顿时文件照样在**，且写的是 `no-stalls-observed`（缺文件与「导出悄悄不带这段」无法区分）。
8. e2e（真窗口 + 真 IPC + 真组包）：包里有 `diagnostics/event-loop-stalls.json`，`status` 只在两个合法值之一，
   `no-stalls-observed` 时 `records` 必须为空、`records` 时必须有内容。

**真窗口读数（`e2e/support-bundle.spec.ts`，隔离工作树 `/tmp/ps-e2e-bundle` @ `66fe6cd7`，`build:e2e` 后跑）**：

```
✓ exports a scrubbed support bundle from the running app (9.3s)
✓ a cancelled export writes nothing and leaves the panel unchanged (6.3s)
2 passed (17.3s)
```

即那条断言链是**跑过才交的**：真窗口点 Settings → General → Export support bundle，包落到真磁盘，
`diagnostics/event-loop-stalls.json` 在里面、`status` 与 `records` 自洽，且整包每个文件都不含家目录与用户名。

## 四 边界（不许读成更强）

1. 探针证明的是「组出来的摘要带着真读数」，**不**证明主进程在真实 stall 时会走到同一条路径的端到端
   —— 探针与产品同代码同运行时，但**停顿是探针自造的**。
2. **用户常驻实例仍跑旧代码**：`logs/headless.out.log` 里 162,018 条 `event loop stalled`，最后两条仍是
   `stack: { status: 'no-second-stall' }` / `host: { status: 'window-armed' }`。因此「真机日志里这一行真的带上
   `stack.status=profiled` 与 `host.status=sampled`」在**用户那个实例**上**仍未取到**，要继续记为未取证
   （要取它必须重启那个实例，会打断用户正在用的网页界面 ⇒ 需用户点头）。
3. 环是**进程内**的：进程重启后归零（`observed` 从 0 开始），包里同时带 `logs/` 作为历史；
   两者不是同一份数据的两种写法，谁缺谁补在 README 里写明。
4. `continuity: 'unknown'` 是具名缺态（这次窗口两端证据不足一条），不是「机器没停」。
5. 环的代价是「多留 16 条记录」，没有新增计时器、没有新增子进程。

## 五 具名未办

- 用户实例上的那条日志读数（见 §四.2）—— 需重启，未做。
- 停顿记录进**轨迹包**（v2.19 `trajectory/`）—— 本单元只进支持包；轨迹包的段清单由会话线在推进，
  不在这里抢同一批文件。
