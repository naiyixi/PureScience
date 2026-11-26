# 首窗预算 180 s 从来不可达：把它夹到测试自己的剩余预算（2026-11-26）

## 一 读数：v2.33.9 那一趟 P0 里唯一的 flaky 不是断言竞态

`Nightly` run `45764638376` / `build / Build macos-arm64`（job `139729574429`，head `94d44f81` =
v2.33.9 的 tag 提交）现取：

```
electron P0 reading: passed
  1 flaky
    e2e/certification/references-page-selection.spec.ts:13:5 › the literature library PDF picker selects and clears the page it names
  12 skipped
  126 passed (47.0m)

[96/139] …references-page-selection…（06:48:32 开始）
[97/139] (retries) …references-page-selection… (retry #1)（06:51:49）
  1) …references-page-selection.spec.ts:13:5 …
     Test timeout of 120000ms exceeded while setting up "app".
```

失败发生在 **fixture 装配**（`setting up "app"`），不是用例正文的断言；重试 23 秒通过。同一趟里
`artifact-replay.spec.ts:58` 与 `notebook-python-provisioned-runtime.spec.ts:34` 都跑过了
（roadmap §十图收敛 里那两条「仍红」在这笔上已不成立）。

## 二 结构矛盾：一条永远不可能生效的预算

| 事实 | 现取 | 位置 |
| --- | --- | --- |
| Playwright 每个用例的总预算 | **120 000 ms** | `playwright.config.ts` `timeout: 120_000` |
| 打包车道请 `firstWindow()` 等多久 | **180 000 ms** | `e2e/fixtures/electron-app.ts`（`packagedLane ? 180_000 : 30_000`） |

180 000 > 120 000 ⇒ 窗口若真要等到 120 s 以上，先到的是 runner 自己的
`Test timeout … while setting up "app"`，而那句话**不带**启动日志、不带进程死活。fixture 里那套
「点名 + 贴最后 20 行启动输出」的失败路径（`openWindowOrNameFailure`）在打包车道**从未有机会执行**。

这不是断言写松了，也不是把超时调大的理由：能真正生效的上限是「测试剩下的预算」，所以让请求服从它。

## 三 修法（`e2e/fixtures/launch-budget.ts` + `electron-app.ts`）

1. 新纯函数 `resolveWindowBudgetMs({configuredMs, remainingMs})`：
   `min(配置值, remaining - 5 000)`，下限 **1 000 ms**（Playwright 把 `timeout: 0` 读成「永不超时」，
   所以下限必须 > 0）；`remaining` 为 `Infinity`（测试没有超时）时原样返回配置值。
2. fixture 用 `testInfo.timeout - (Date.now() - startedAt)` 逐次取剩余预算并传进 harness；
   `restart()` 在中途发起时同样按当时的剩余预算夹。
3. 真正发生夹取时打印一行：
   `[e2e] first-window budget: 180000ms requested, 115000ms left before the test's own deadline — waiting the smaller one`
   —— 读者要能分清「我们等满了预算」与「runner 先把我们掐了」。
4. 失败路径不变：夹到的那次超时仍然走 `openWindowOrNameFailure`，带 `process: is still running/exited`
   与最后 20 行启动输出。

## 四 门禁（本机，隔离工作树 `/tmp/ps-round-264` @ `94d44f81`）

| 项 | 读数 |
| --- | --- |
| `npx vitest run scripts/ci/e2e-launch-budget.test.ts` | **9 passed**（6 条解析语义 + 3 条「fixture 真的用了它」的源码契约） |
| 变异：把 fixture 改回传 `configuredWindowTimeoutMs` | **1 failed**（源码契约当场抓住），恢复后 9 passed |
| `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:node` | **EXIT=0** |
| `npx eslint --no-cache`（三个文件） | **EXIT=0**，0 problems |

源码契约那三条是本单元的「不是空壳」判据：只测纯函数会允许 fixture 继续把配置值直接交给
`firstWindow()`，而缺陷恰在那一行。

## 五 边界与具名未办

1. **夹取本身还没有真机读数**：它只在打包车道（`PURESCIENCE_E2E_EXECUTABLE`）生效，本机不起实例
   （内存闸：空闲页 4 060、swap 11.2 G/12.2 G）。判据留给下一趟 P0：若 `references-page-selection`
   再红，失败行应是 `The Electron app never opened a window: …` 加启动尾巴，而不是
   `Test timeout of 120000ms exceeded while setting up "app"`。
2. **装配为什么慢，这一笔没有回答**：`9d6c9cba` 已给单实例分支与开窗决定留下具名行；本单元让那些行
   在超时那一刻**能被读出来**。真正的定因仍缺一次带尾巴的失败读数。
3. **`94d44f81` 的 Nightly 红不是产品红**：`Build macos-x64`（job `139729574664`）红在
   `##[error]Failed to CreateArtifact: Unable to make request: ENOTFOUND`，打包与 mac 冒烟都是 success；
   同一提交的 `Release` 车道 success（17 个资产、`sourceSha=94d44f81…` 与 tag 提交逐字符相同），
   `Windows Full Test` success。前一笔 `9d6c9cba` 的 Nightly 同样红在 `ENOTFOUND`（job `139692262452`）
   ⇒ 两次同形，判为产物上传侧的基础设施抖动，不作产品缺陷立案。
