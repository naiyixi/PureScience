# 帧间隔仪器的两处自身缺陷 —— 2026-11-05

排期 v2.23.0 第一条写的是「先修测量方法：p90 在离屏/软件光栅下饱和（两边都是 81 ms），绝对数不可用」。
本轮**先怀疑仪器**，结果是：那句描述里的**成因没被复现**，而仪器本身确实有两处会造出假数字的缺陷。
分开记，不合并。

## 一 假设检验：窗口不在前台，会把 rAF 压到 ~12 Hz 吗

仪器：`~/.hermes/cache/scratch/cadence-probe.cjs`（50 行，不碰产品代码、不需要构建）。一个 `BrowserWindow`
加载空白页，在三种窗口状态下各采 750 ms 的 `requestAnimationFrame` 间隔。

| 状态 | 默认（硬件光栅）median / p90 / ticks | `--disable-gpu`（软件光栅）median / p90 / ticks |
| --- | --- | --- |
| 可见但非 key（`showInactive()`） | **16.7** ms / 33.3 / 38 | **16.7** ms / 33.3 / 39 |
| 提到最前 + `app.focus({steal:true})` | **18.1** ms / 33.4 / 32 | **17.8** ms / 33.3 / 34 |
| 隐藏（`hide()`） | 17.7 ms / 33.4 / 34 | 16.7 ms / 33.3 / 37 |

三条读数（本机 M2 / 8 GB / macOS 27.0.1，2026-11-05 09:1x）：

1. **「不在前台」在本机不足以把 rAF 压到 12 Hz**：三种状态的中位都在 16.7–18.1 ms，软件光栅同样。
   ⇒ 把 81 ms 归因成「窗口被遮住、合成器把它降频」这个说法，**本轮证不出来**，不许当成结论写进排期。
2. **探针自身的能力边界**：`hide()` 之后 `document.visibilityState` 仍是 `visible`（三次采样都报
   `focused:false`、`visibility:"visible"`）⇒ 这次**没有真的造出隐藏状态**，隐藏那一行只能读作「窗口仍在
   出帧」，不能读作「隐藏时不掉帧」。同一处的观察：所有 p90 都落在 33.3 ms（= 2×16.7），说明这台机器上
   帧间隔的读数是量化到 vsync 的倍数的 —— 所以一个 81 ms 的量级更像是**几个 vsync 周期**，而不是独立的
   绝对耗时。
3. 结论只到这一步：**81 ms 的成因仍未知**；已知的候选是「重页面在软件光栅下的绘制吞吐上限」与
   「单次停顿被当成 p95 报出来」两种，而第二种现在已经被下面的改法排除（见二）。

## 二 两处仪器缺陷（可复算，不依赖真机）

`e2e/perf/smoothness.spec.ts` 原来自己实现了一个百分比：

```ts
values[Math.min(values.length - 1, Math.floor(values.length * 0.95))]
```

- **缺陷 A（取的是最大值）**：`floor(n * 0.95)` 在 `n < 20` 时恒等于 `n - 1` ⇒ 样本少于 20 时它返回的
  **就是最大值**。用例 `<20 样本时旧公式等于最大值>` 直接把这句钉住：20 个样本 `1…20` ⇒ 旧公式 `20`，
  最近秩 p95 = `19`。
- **缺陷 B（样本根本不够）**：`measureIpc` 只采 `12` 次往返，而 `floor(12 * 0.95) = 11` ⇒ 它打印的
  「p95」是**12 个里的最大值**。一条臂长 300 ms 的相位只有 2–3 帧时同理（本轮真机读数就出现了
  `frames=2`，旧代码会把它报成 `p95`）。
- **缺陷 C（没有自证）**：没有任何一步确认 rAF 在按前台速率出帧。合成器饿着窗口与产品慢**完全同形**。

## 三 改法（三个文件）

| 位置 | 改动 |
| --- | --- |
| `src/shared/perf-frame-cadence.ts`（新增） | `percentile(values, q, minSamples=20)` = 最近秩、样本不足返回 `null`；`summarizeFrameCadence(gaps)` 用中位间隔对 `FOREGROUND_MIN_FPS=50` 判 `usable` / `throttled` / `no-frames`；`describeFrameMetric()` 在不可用时把 `frames/p95/max` 一律印成 `n/a` 加原因，可用时**永远先印样本数与最大值**再印 p95。 |
| `e2e/perf/smoothness.spec.ts` | 测前 `page.bringToFront()` + 采 750 ms 空闲节奏自证；`[perf] instrument: usable/throttled — …` 一行进日志并作为 test annotation；`stopProbe` 改走 `describeFrameMetric`；帧上限断言只在仪器可用且 p95 有值时才判；`measureIpc` 采样 12 → **30**，p50/p95 走同一支最近秩，样本不足印 `n/a`。 |
| `src/shared/perf-frame-cadence.test.ts`（新增） | 15 项：旧公式在 4 样本 / 20 样本上分别等于最大值（回归钉子）、最近秩 p95 ≠ 最大值、样本不足返回 null、非有限值被剔除、边界 20 ms 判可用 / 21 ms 判不可用、`describeFrameMetric` 在 throttled 与样本不足两种情形下都不印数字。 |

## 四 真机读数（隔离工作树 `/tmp/ps-perf` @ `3f628550` + 本笔；`npm run build:e2e` ✓ 25.57 s）

`PERF_TURNS=1 npx playwright test e2e/perf/smoothness.spec.ts` ⇒ **1 passed (10.2s)**：

```
[perf] instrument: usable — idle cadence 17ms is at or above 50 fps — frame intervals describe the app
[perf] ipc idle: project.list n=30 p50=0ms p95=0ms max=1ms
[perf] streaming 1 turns: longest=0ms | >50ms=0 of 0 | frames=55 max=33ms p95=33ms
[perf] typing into the composer: longest=0ms | >50ms=0 of 0 | frames=99 max=33ms p95=33ms
[perf] scrolling the transcript: longest=0ms | >50ms=0 of 0 | frames=42 max=33ms p95=33ms
[perf] command palette: longest=0ms | >50ms=0 of 0 | frames=2 max=17ms p95=n/a (fewer than 20 samples)
[perf] reopening a heavy session: longest=0ms | >50ms=0 of 0 | frames=2 max=18ms p95=n/a (fewer than 20 samples)
```

**「少样本」那一行是本笔的分量**：同一次运行里既有能支撑 p95 的相位（55/99 帧），也有不能的（2 帧）。
旧代码在这两种相位上**长得一模一样**（都印一个数），现在能分开了。

**变异自证（反向）**：把 `FOREGROUND_MIN_FPS` 临时改成 `2000`（同一份代码，只改这一处常量）再跑 → 通过，
日志变成

```
[perf] instrument: throttled — idle cadence 17ms is below 2000 fps (budget 1ms) — …
[perf] streaming 1 turns: … | frames=n/a p95=n/a max=n/a (throttled: …)
```

⇒ 拒绝分支真的可达，且**一个帧数字都不会印**。跑完已还原（`FOREGROUND_MIN_FPS = 50`）。

## 五 门禁读数（隔离工作树，读数取自最后一次改动之后）

| 环 | 读数 |
| --- | --- |
| 定向 vitest | **1 file / 15 passed**（`src/shared/perf-frame-cadence.test.ts`） |
| `src/shared` 整目录 vitest | **156 files / 1671 passed**（4.92 s） |
| `tsc --noEmit -p tsconfig.node.json --composite false` | **exit 0**（`e2e/**` 与 `src/shared/**` 都在该 project 里） |
| `tsc --noEmit -p tsconfig.web.json --composite false` | **exit 0**（`src/shared/**` 也在 web project 里） |
| `eslint --no-cache`（本笔 3 文件） | **0 error / 0 warning**（先 4 条 prettier warning，已 `--fix`） |
| 真机 perf spec | **1 passed (10.2s)**，见 §四 |

## 六 边界（不许读成更强）

1. **81 ms 的真实成因仍未定**。本轮证明的是「不是『窗口不在前台』这一个原因」，并排除了「少样本被报成
   p95」这一条；「重页面在软件光栅下的绘制吞吐上限」**没有测**（要真窗口 + 真实长会话 + `--disable-gpu`，
   本机此刻空闲页 ~60 MB、swap 已用 7.1/8.2 GB，起不了那个场景）。
2. **探针的隐藏状态没造出来**（`visibilityState` 仍 `visible`）⇒ 那一行不构成隐藏态的读数。
3. **本轮没有改任何产品行为**：新增的是测试仪器与其纯函数，产品渲染路径一个字节没动 ⇒ 不构成任何
   「变快了」的声明。v2.23.0 的四项预算与本条的「同机同窗口前后对比」仍未开始。
4. **「p95 = 81 ms」这条历史读数不能再被引用**：它当时的样本数没有记录，而按缺陷 A，样本少于 20 时那个
   数字就是最大值。
