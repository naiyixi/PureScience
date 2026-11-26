# `session-fork` 的 `Messages: 2`：六连绿落档，且顺手更正一条不实的 flaky 列（2026-11-26）

## 一 这条要答什么

issue #13 第二条：`e2e/certification/session-fork.spec.ts:79` 的 `Messages: 2` 与「交换已持久化」之间存在竞态，
判据是「该 spec 不再出现在失败日志里、连续三次全绿」。认证 spec 只在 `macos-arm64` 这个作业里执行
（`e2e/certification/` 不进 `Windows Full Test`，也不进旧 journey），所以**只数这条车道**。

本档不重复上一档的结论，而是把它**独立复核一遍并留下可取回的读数**：日志是本次现取的
`gh api repos/naiyixi/PureScience/actions/jobs/<job>/logs`，判据是逐行的，不是转述。

## 二 读法（怎么算「首跑通过」而不是「没跑」）

每份日志里该 spec 出现三次，缺一次就是「没跑」：

1. 排队行：`[113/139] e2e/certification/session-fork.spec.ts:27:5 › measures a fork before copying it …`
2. 结论行：同一串文本再出现一次（无 `[n/139]` 前缀、无 `(retries)` 前缀）；
3. 它自己的两条真按压读数：
   `[session-fork] pressing fork at 271,348 (box 82x17); the point resolves to button[data-slot=session-fork-measure] "Fork session"`
   与 `[session-fork] pressing create the copy at 281,435 … data-slot=session-fork-confirm`.
   中间还夹着 `[e2e] app process output (…)`。

重试过的话，第 1 行会带 `(retries)` 前缀并在结论行标 `retry #N`。**七份日志里一次都没有出现**，
`1 flaky` / `2 flaky` 那些行也从未点名这个 spec。

## 三 读数（`macos-arm64` 车道，现取）

| # | run | head | 事件 | P0 结论 | `session-fork` | 该 run 的 flaky（逐条点名） |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 45709744863 | `a57e84c5` | push | passed（127 passed / 44.6m） | 首跑通过（`[113/139]`，无 retry） | 0 |
| 2 | 45673395862 | `82064383` | push | passed（127 passed / 48.9m） | 首跑通过（`[113/139]`，无 retry） | 0 |
| 3 | 45651334823 | `16e58032` | push | passed（126 passed / 51.5m） | 首跑通过（`[114/139]`，无 retry） | **1**：`connector-custom-detail`（retry #1） |
| 4 | 45650744918 | `f9b9b4ee` | push | passed（125 passed / 53.4m） | 首跑通过（`[113/139]`，无 retry） | **2**：`session-vision-evidence-card`（app 装配 180 s 超时）、`workspace-activity-group-expand-all`（firstWindow 180 s 超时） |
| 5 | 45629592887 | `d25bb717` | push | passed（126 passed / 44.7m） | 首跑通过（`[113/139]`，无 retry） | **1**：`session-turn-readings-real-window`（`groups=3`，见 §五） |
| 6 | 45625097953 | `f62ffdec` | push | passed（127 passed / 36.2m） | 首跑通过（`[113/139]`，无 retry） | 0 |
| 7 | 45592089343 | `48ca13ce` | push | passed | 首跑通过（`[116/139]`，无 retry） | **3**：`lock-import`、`notebook-interrupted-run`、`packages-mutation` |

七次全部 `electron P0 reading: passed`，`session-fork` 七次全部**首跑通过**。spec 最后一次改动是
`489feb18`（2026-11-20），七份日志的 head 都在它之后。

**结论：连续 7 次全绿（issue 要求 3 次），第二条结案。** 修复本身是 `8cf5c9f`（测量前先 drain 运行时事件
再 flush 持久化，读用户看到的文档而不是恰好写完的），它已在位；若日后再红，按同样口径重新立案。

## 四 一处失真：上一版把三个 run 的 flaky 记成「无」

issue #13 第五条评论的表格里，run 3 / 4 / 5 的「该 run 的 flaky」写的是「无」。现取日志逐条点名是
**1 / 2 / 1**（见上表）。这些 flaky 都不是 `session-fork`，所以**结论不受影响**；但那张表是一个读数，
写成「无」会让后来者按它判断「那三次完全干净」，进而把同族的竞态当成已绝迹。本档与 issue 上的更正
评论（第六条）以现取日志为准。

## 五 同族第三处：`session-turn-readings-real-window` 的 `groups=3`

run 5 的重试前首跑逐字（`expect(count).toBe(2)` 处，`Received: 3`）：

```
[e1-pair] groups=3 [{"expanded":"false","text":"Fetched a page1 step · 36ms · usage not recorded"},
                    {"expanded":"false","text":"Fetched a page1 step · 2ms · usage not recorded"},
                    {"expanded":"true","text":"Fetched 2 pages2 steps · …"}]
```

形状是**取样早了**，不是多出一行：第二回合结束时，第一回合的两条调用**还没折成一行摘要**，各自站着；
重试时读到的就是折好的两行（`"Fetched 2 pages2 steps · 3ms"` + `"Fetched 2 pages2 steps · 1ms"`）。
与 `connector-custom-detail` / `connector-custom-skip-approvals`（`82064383` 修）同一族：点击/回合只**发起**
写入，面板要等事件落地才重排，而 spec 用固定 `waitForTimeout(2_000)` 后一次性 `count()` 取样。

修法（本档同批提交）：把固定等待 + 一次性计数换成**会重试的计数断言**
`await expect(groups).toHaveCount(2, { timeout: 30_000 })`，再读摘要。断言强度不变 —— 真多出一行且永不折叠时
这条会超时失败，不会被藏起来。判据落在 `macos-arm64` 的 P0 车道，本地只做静态门禁（本机内存闸：
没有 build、没有起实例），**下一次该 spec 的读数由车道给出**，本档不预支。

## 六 另外两处：app 装配阶段 180 s 超时（立案，不改代码）

run 4 的两条 flaky 都不是断言竞态，而是**应用根本没开窗**：

```
Error: The Electron app never opened a window: electronApplication.firstWindow: Timeout 180000ms exceeded
       while waiting for event "window"
  process: is still running
  launch log (last 20 lines): { arch: 'arm64', isPackaged: true, operation: 'application-startup',
       operationId: '03d49afb-…', phase: 'web-service-started', elapsedMs: 3458 }
```

形状：进程活着、web 服务在 3.4 秒就起来了、`phase` 到了 `web-service-started`，但**窗口从未出现**。
另外一条（`session-vision-evidence-card`）是 `Test timeout of 180000ms exceeded while setting up "app"`，
同一件事的另一种落法。重试即通过 ⇒ 与「代码这一笔坏了」不同形。

这是一条独立缺陷，**本轮不动**：它的修法要先能分辨「上一个实例还占着单实例锁 ⇒ 新实例把请求转交后就退了」
与「窗口创建路径本身挂住」，而现有启动日志两种情况同形（都只到 `web-service-started`）。立案判据：

- 需要在启动日志里给**单实例分支**一条具名行（拿到锁 / 没拿到并把 argv 转交给谁），位置在
  `src/main/app-startup.ts` 的 `requestSingleInstanceLock` 周围（`second-instance-router` 已有纯函数面）；
- 拿不到这条读数之前不许改窗口创建路径，也不许加大 e2e 的 180 s 装配超时（那是把缺陷换成静默）。

## 七 门禁（本机，隔离工作树 `/tmp/ps-round-263`）

见本节表格（提交前的现取读数，命令与退出码逐行落在 `/tmp/` 日志里）：

| 项 | 读数 |
| --- | --- |
| `playwright test e2e/certification/session-turn-readings-real-window.spec.ts --list` | EXIT=0，2 tests / 1 file |
| `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:node` | **EXIT=0** |
| `npx eslint --no-cache e2e/certification/session-turn-readings-real-window.spec.ts` | **EXIT=0**（0 problems） |
| `bash scripts/pre-push-checks.sh`（提交后跑） | **EXIT=0** —— 敏感词零命中 / README 横幅 v2.33.8 与双语一致 / 新增文件 lint 0 problems / 79 个启动器可解析 |

真窗口读数：本条不预支，判据在下一次 `macos-arm64` 的 P0（该 spec 在 `[113/139]` 行之后）。

## 八 边界

1. 七份日志都来自 `macos-arm64` 一台 runner 的一次执行；「七连绿」不等于「竞态绝迹」，判据仍是 issue 里的
   「同一发版在两个平台连续三次全绿 + 两处不再出现」。
2. `40/139` 这类用例编号会随 spec 数量变化，本档引用时同时给了 spec 路径，编号只是定位。
3. 本轮的 `groups=3` 修法与 `82064383` 同族但**不同 spec**，两者没有共同代码改动，回退互不牵连。
