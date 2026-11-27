# 2026-11-27 · 「窗口建了却没等到事件」这条读数现在能分辨了；issue #13 按三连绿结案

## 一 为什么改

issue #13 剩下的那一半是：P0 认证（打包车道）偶发 `firstWindow: Timeout 180000ms exceeded`，而同一份启动日志里
主进程 3.8 秒就打印了 `main window created`。上一轮把**单实例**那一支补了具名行、又加了启动步骤的同步落盘标记
（`[startup-step] …`），但两种可能仍然同形：

1. 应用**没有**开窗（启动卡在某个原生调用里，`main window created` 是上一次实例留下的行，或进程随后停了）；
2. 窗口**开了**，但 Playwright 的连接从没被告知 —— 事件丢了。

这两种的修法完全不同（改产品 vs 改夹具），所以先把它们分开。issue 里原本给的候选判据是「失败那一刻
`application.windows()` 是否非空」。本轮把这个判据做进夹具：**只在等待超时之后**读一次连接自己的窗口集合，
既有判据、也有恢复。

## 二 先核了一件事：Playwright 自己已经会「认领已存在的窗口」

`node_modules/playwright-core/lib/coreBundle.js` 里 `ElectronApplication` 的实现：

```js
_onPage(page) { this._windows.add(page); this.emit(Events.ElectronApplication.Window, page); … }
windows() { return [...this._windows]; }
async firstWindow(options) {
  if (this._windows.size) return this._windows.values().next().value;
  return await this.waitForEvent("window", options);
}
```

所以「先看一眼 windows() 再等」**不是**我们要补的东西 —— 它已经在那儿。这同时把判据收紧了：
`firstWindow()` 开等那一刻集合是空的，超时那一刻若非空，就**只可能**是事件漏了（窗口在等的过程里被发布进来、
而事件没有送达）。这条读数让「认领」这个动作有了确切的适用条件，而不是猜。

（这也是本轮没有新写「先查 windows() 再等」一段代码的原因：那是第二套实现，且会永远不生效。）

## 三 交付

| 文件 | 改动 |
| --- | --- |
| `e2e/fixtures/app-process-log.ts` | `WindowWatch` 增加**可选** `windows?: () => unknown[]`；新增 `describeKnownWindows()`；启动失败句多一行 `windows the connection knows about: …`（三态：`not reported by this caller` / `none — no window was ever published to the connection` / `N (the wait expired with a window already there)`）；超时分支：集合非空 ⇒ 打印 `[e2e] window event missed: N window(s) were already open …` 并**认领第一个窗口**，不再把整条 spec 判红 |
| `e2e/fixtures/electron-app.ts` | 把 `application.windows()` 接进 `openWindowOrNameFailure` |
| `test/app-process-log.test.ts` | 新增 3 例：认领（含具名行）/ 集合为空时点名「none」/ `windows()` 抛错时不得读成「0 个窗口」 |

设计的两个边界：

1. **只读在超时之后**。通过路径（窗口正常到达事件）一个字节都不变 —— 这条缝不会改变任何一次绿的样子。
2. **认领不等于放宽**：认领到的窗口仍要过 `open`（`observe` + `waitForLoadState('domcontentloaded')`），
   窗口在但渲染不出来依旧失败。断言强度只在「窗口确实存在」这一格上松开，而那正是判据本身。

`readKnownWindows()` 把「`windows()` 抛错」读成 `not reported by this caller`，**不**读成 0 ——
目标已关闭时抛错说明「不知道有几个」，把「不知道」写成「零个」正是这条改动要消灭的那种混同。

## 四 门禁（本机，隔离树 `/tmp/ps-wincount` @ `ecc688de`）

| 项 | 读数 |
| --- | --- |
| `npx vitest run test/app-process-log.test.ts` | **21 passed**（原 18 + 3） |
| 变异①：认领分支置恒假（`if (false && …)`） | **1 failed**（认领那一条）；恢复后 21 passed |
| 变异②：`windows()` 抛错改回 `return []` | **1 failed**（「不得读成 0 个」那一条）；恢复后 21 passed |
| 变异③：空集合的措辞改成「not reported」 | **1 failed**（「点名 none」那一条）；恢复后 21 passed |
| `npx vitest run scripts/ci/e2e-launch-budget.test.ts scripts/ci/classify-pr-changes.test.ts test/app-process-log.test.ts` | **71 passed**（3 文件；夹具源码契约与 Windows 信号清单都没被这次的接线打断） |
| `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:node` | **EXIT=0** |
| `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:web` | **EXIT=0** |
| `npx eslint --no-cache`（三文件） | **EXIT=0**，0 problems |

## 五 issue #13 的结案读数（现取）

### 5.1 发布核验：v2.33.11

| 项 | 读数 |
| --- | --- |
| `gh release view v2.33.11` | `draft=false` / `isPrerelease=false` / **17 个资产**；`gh release list` 判为 **Latest** |
| 资产齐否 | 四平台产物（mac arm64 dmg+zip、mac x64 dmg+zip、linux AppImage+deb、win setup.exe+blockmap+zip）+ `SHA256SUMS.txt` + `RELEASE-CERTIFICATION.json` + `version.json` + `latest*.yml` + `arm64-mac.yml`/`x64-mac.yml` |
| `sourceSha` | `ecc688debd7c62755ff04222326fcde401509950`，与 `git rev-parse 'v2.33.11^{commit}'` **逐字符相同** |

### 5.2 两条车道三连绿（三个连续提交）

| # | 提交 | Nightly（macos-arm64 的 P0） | Windows Full Test | `Smoke test Windows installer` |
| --- | --- | --- | --- | --- |
| 1 | `991d464a` | `127 passed (51.4m)` / **0 flaky** / `never opened a window` **0 次** | success | success |
| 2 | `ea8c4ce2` | `127 passed (46.5m)` / **0 flaky** / 0 次 | success | success |
| 3 | `ecc688de` | `127 passed (33.4m)` / **0 flaky** / 0 次 | success | success |

对照：`09dfed08` 那一趟是 `1 flaky` + `never opened a window` 1 次（`lock-import`）—— 三连绿不是「一直没跑」，
而是同一条车道从「有」变成「三个连续提交都没有」。

`session-fork` 的 `Messages: 2`：这三趟里该 spec 都是首跑通过（日志里 5 处命中全部是排队行/结论行，无 `retry #N`），
加进 issue 里已记的 6 次，合计 **9 次连续首跑通过**。

### 5.3 结案口径（诚实的半边）

issue 的判据原文是「同一发版在两个平台连续 3 次全绿」。事实上**同一次发版只会构建一次**，所以本轮取的是
「**三个连续提交** × 两条车道都绿 + 两处具名失败在 P0 日志里 0 次出现」，并把这条差异写明。
下一次若同形状复发，判据换成本轮交付的那一行：`windows the connection knows about:` 后面是 `none`
（⇒ 应用没把窗口发布给连接，回到产品侧）还是 `N (…)`（⇒ 事件漏了，已自动认领，且会在报告里留具名行）。

## 六 边界与具名未办

1. **本轮没有真机读数**：这条失败只在打包车道出现，本机不起实例。认领分支的行为由**注入**证明（3 例 + 3 个变异），
   不是真机跑出来的。下一次复现才有真读数，判据已写在 §5.3。
2. **`console.log` 那一行只在认领时出现**：绿的一趟不会有任何新输出，日志噪音不变。
3. 认领时若窗口不止一个（本产品正常只有一扇），取**第一个**并在行里报总数；没有挑选策略，也没有猜。
