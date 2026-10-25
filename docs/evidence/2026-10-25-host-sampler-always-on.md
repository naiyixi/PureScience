# 第一段停顿的「机器看见了什么」：采样线程常开 + 有界环缓冲，读数按需取

日期：2026-10-25（执行器轮次，§两百三十）。改的是量仪（`src/main/diagnostics/**`），不动任何业务路径。

## 一 缺口是什么

上一轮（§两百二十九，`docs/evidence/2026-10-25-stall-first-stack.md`）把 **栈** 那一半补上了：profiler 常开、有界轮转，
第一段 stall 也有栈。同一份记录里的另一半 **没有** 一起补上 —— `host`（自己线程上采样的机器读数）
仍然是「**由第一段 stall 创建、15 秒后销毁**」：

- 第一段只能记 `{ status: 'window-armed' }`：线程是在事件**之后**才起来的，构造上不可能看见停顿里的机器；
- 一段突发只服务第一个 15 秒窗口，窗口外再停顿又要重新 arm（也就再丢一段读数）；
- `stop()` 是**单次 flush**：答完就 terminate，读一次就把采样线程用掉了。

上一轮的真机读数里那一行就是证据：`host:{ status:"window-armed" }`（record 1）。

## 二 先量代价，再决定「常开」这件事做不做得起

常开的代价不是猜的。同一台 8 核机、10 秒空转一段（`node` 里跑与 worker 相同的循环）：

| 做什么                                                      | 10 s 内 CPU | 折合单核占用 |
| ----------------------------------------------------------- | ----------- | ------------ |
| 采样循环本身（250 ms 采 cpu/load/free/rss）                 | 4.4 ms      | 0.04 %       |
| 每次 paging 读（`vm_stat` 子进程 1.62 ms CPU / 13.3 ms 墙） | —           | —            |
| paging 每 **500 ms**（原默认）                              | 48.4 ms     | **0.48 %**   |
| paging 每 **1000 ms**（改为这个）                           | 20.8 ms     | **0.21 %**   |

⇒ 采样循环本身几乎不要钱，钱花在 `vm_stat` 子进程上，所以把 paging cadence 从 500 ms 放宽到 **1 s**。
环缓冲让「常开」不等于「一直长」：1,200 个样本 ≈ 5 min @250 ms、120 份 paging 文本 ≈ 2 min @1 s。

## 三 交付

| 位置                                 | 改动                                                                                                                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host-stall-sampler.ts`（worker 侧） | 环形缓冲（满了丢最旧）+ 新增 `read` 消息：**答快照、不终止**；`read` 前先 `sample()` 一次（见 §四 那条自证）                                                                                               |
| 同上（主线程侧）                     | `HostStallSampler` 从 `stop(from,to)` 改为 `read(from,to)` + `stop()`；`requestId` 匹配、读取串行化、超时返回 `unavailable`、连续 3 次超时才关线程（机器被饿住时一次迟到不算坏）                           |
| `summarizeHostWindow`                | `continuity` 现在要求**窗口两端都有证据**（起点之前、终点之后各有样本），只有一端一律 `unknown`；paging 差值的锚点：窗口内两份就用窗口内，否则接上**窗口前最近那份**，并新增 `pagingWindowMs` 报出实际跨度 |
| `event-loop-stall-watchdog.ts`       | 采样器**在 watchdog 启动时就建**，删掉 `hostWindowMs` / arm 计时器 / `window-armed` 状态；每一段 stall 都读同一线程                                                                                        |
| 两个测试文件                         | 接缝改成 `read`/`stop`；新增 5 条：同一时间线答第二次读、环满丢最旧、`stop()` 后读是 `unavailable`、paging 跨停顿取锚并报跨度、时间线早于窗口结束时 `continuity=unknown`                                   |

## 四 真机读数（Electron 自己的运行时，三次连续运行）

用 esbuild 把 watchdog 打成单文件，`ELECTRON_RUN_AS_NODE=1 electron` 跑
—— **Electron 43.7.5 / Node 24.21.0 / V8 15.0.245.31-electron.0**，真 host 线程、真 `vm_stat`、真忙等，
外加一次**真的整进程冻结**（`SIGSTOP` 自己 1.5 s，由外部 `sh` 发 `SIGCONT` 恢复）：

```
runtime: node=24.21.0 electron=43.7.5 v8=15.0.245.31-electron.0
RUN 1
  first（本进程的第一段，1.5 s 忙等）: stack=profiled host.status=sampled samples=8
        continuity=kept-sampling maxGapMs=263 freeMemMbMin=71 cpuMs=817 pageouts=0 pagingWindowMs=1019
  freeze（1.5 s SIGSTOP）            : host.status=sampled samples=0 continuity=gapped maxGapMs=1812
  second（1.0 s 忙等）               : host.status=sampled samples=5 continuity=kept-sampling maxGapMs=311
RUN 2
  first : samples=6 kept-sampling maxGapMs=253 freeMemMbMin=65 cpuMs=857 pageouts=0 pagingWindowMs=1072
  freeze: samples=1 gapped maxGapMs=1602 cpuMs=3
  second: samples=5 kept-sampling maxGapMs=253 cpuMs=511
RUN 3
  first : samples=7 kept-sampling maxGapMs=269 freeMemMbMin=66 cpuMs=924 pageouts=0 pagingWindowMs=1047
  freeze: samples=1 gapped maxGapMs=1762 cpuMs=7
  second: samples=5 kept-sampling maxGapMs=252 cpuMs=606
```

三件事同时成立：**第一段有机器读数**（不再是 `window-armed`）、**第二段仍是同一线程答的**（读一次不等于用掉它）、
**整进程冻结被读成 `gapped`（缺口 1.6–1.8 s）而不是「机器很好」**。冻结那一段的 `cpuMs` 是 3–7 ms，
与「不是我们在烧 CPU」一致；忙等那一段是 511–924 ms。

## 五 一处仪器说谎，被真机探针抓到（本轮的修法就是它）

第一次跑冻结探针时，冻结那一段被记成 **`continuity: kept-sampling`、`maxGapMs: 251`** —— 一个 1.5 s 的整进程
冻结被读成「采样一直在跑」。成因不是采样线程没停（它停了），而是**读取时快照停在窗口结束之前**：
主线程恢复后立刻发 `read`，worker 先处理消息、再轮到它自己的 250 ms 定时器 ⇒ 环里只有冻结**之前**的密集样本，
缺口搜索能看见的唯一一对相邻样本是冻前的 251 ms，于是「没有洞」。

两条修法一起上（缺一条都不够）：

1. worker 收到 `read` 时**先 `sample()` 再答**，时间线必定延伸到读取的那一刻（窗口右端有证据）；
2. `continuity` 改为**两端都要有证据**才敢下结论（起点前 / 终点后各有样本），只有一端 ⇒ `unknown`。

修后同一份探针三次都是 `gapped`（见 §四）。这条也解释了为什么单测全绿时它看不见：合成时间线是「已知完整」的，
只有真线程才会给出「快照比窗口短」这种形状。

## 六 门禁（全部实跑，取自最后一次改动之后）

| 环                                                     | 读数                                                                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/diagnostics` 整域                            | **16 files / 96 passed**，exit 0（上一轮 91 ⇒ 本单元 +5 条）                                                                     |
| `tsc --noEmit -p tsconfig.node.json --composite false` | **EXIT 0**                                                                                                                       |
| `tsc --noEmit -p tsconfig.web.json --composite false`  | **EXIT 0**                                                                                                                       |
| `eslint --no-cache .`（CI 同口径全仓）                 | **0 errors / 127 warnings，EXIT 0**（warning 不拦 CI；本笔 5 个源/测文件单独跑 **0 problems**）                                  |
| `prettier --check`（本笔 6 个文件）                    | 全部通过（先 `--write` 修掉测试文件一处折行）                                                                                    |
| 全量 `vitest run --maxWorkers=4`                       | **1393 passed / 3 failed / 18 skipped（1414 文件）**；**17,666 passed / 4 failed / 211 skipped（17,881）**；exit 1、耗时 2,084 s |
| 三条失败的定性复跑                                     | 三个文件各 3 遍（`--maxWorkers=1`）：**9/9 全绿** ⇒ 按负载抖动记档（详见 §七 之后的说明）                                        |

**全量里那三条红**（都不是本笔改动的路径，形状一致 —— 慢阈值/时序断言在 `load1` 33–45 的机器上被推过阈值）：
`storage/ipc.test.ts` `expected 800 to be less than 412`；`settings/agent-runtime-manager.test.ts`
`expected "vi.fn()" to not be called at all, but actually been called 1 times`；`SessionPlanSurfaces.test.tsx` 两条
`expected <article …/> to be null`。逐个 `--maxWorkers=1` 跑 3 遍全绿 ⇒ 判负载抖动，**不谎报「全量绿」**（exit 1 如实记）。

## 七 顺手修掉主干上一处 typecheck 红（不是本单元，但不许累积）

`11e9e18f`（codex 适配器版本探针缓存）的提交信息写着「tsc node exit 0」，实际 **`tsc -p tsconfig.node.json` 红三条
`TS2322`**，全部落在它新增的 `codex-adapter-version-probe.test.ts`：`vi.fn(async () => …)` 没给类型参数时推断成
`Mock<Procedure | Constructable>`，赋不进 `(executablePath: string) => Promise<ExecutableIdentity>`。
`Nightly` 的判决与此一致：`40156739836` → `build / Verify` → **步骤 Typecheck 红**（同提交的 `Windows Full Test`
是 success，因为它不跑类型检查）。

修法按本仓既有写法（`version-probe-cache.test.ts` 用的是 `vi.fn<VersionProbe>(…)`）：给那个 mock 显式类型参数。
读数：`tsc node` exit 0（修前 3 条 error、修后 0）。

> 归属说明：该文件已由后续一笔 `b4614612`（会话线）独立修掉，**本单元这一笔不再包含它**；这里只记当时的读数，
> 不当作本单元交付的一部分。

## 八 边界（不许读成更强）

1. 本单元证明的是「第一段 stall 也能拿到机器侧时间线」，**不**证明 10-23 那 20 秒是内存/换页造成的。
   真机冻结是探针自己用 `SIGSTOP` 造的，不是产品里发生过的。
2. paging 差值现在可能跨到停顿**之前**那一段（`pagingWindowMs` 会把它报出来，本例 1.0–1.3 s vs 停顿 1.0–1.6 s）；
   `pageouts: 0` 只说明这台机器那段没换出页，不是「不可能换出」。
3. 只在 **Electron 的 Node 运行时**里取到读数，**没起带窗实例** ⇒ 产品主进程里那一行要等下一次真机 stall。
4. 常开的代价是「低于本机噪声下界」（0.21 % 单核）而不是零；`vm_stat` 每 1 s 一个子进程这件事本身仍是成本，
   平台侧若给出无子进程的换页计数来源，这一项可以再降。
5. `host` 的第一段读数是「从 watchdog 启动到停顿结束」这段窗口的切片；应用启动后的头 250 ms 之内若就停顿，
   环里可能一个样本都没有 ⇒ 那会如实记 `no-in-stall-samples` / `unknown`，不是「机器正常」。
