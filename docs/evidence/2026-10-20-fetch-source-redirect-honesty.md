# fetch_source 的三种「跳转」结局 —— 一个空字符串让每次外部来源验证都失败

- 日期：2026-10-20（执行器自主轮次）
- 面：`src/main/reviewer/external-source-fetch.ts`、`src/main/reviewer/host-sdk.ts`、
  `src/main/reviewer/mcp-server.ts`（审查员的 `fetch_source` 工具）
- 读数来源：`docs/plan-2026-10-19-runtime-audit-and-fixes.md` §2 P0-1（真机日志 159 次调用 / 0 次成功）
  与 §2 P2（`finalUrl` 拿不到真实值，只能回退成请求 URL）

## 1 缺口有两面，第二面是「说不清」

**第一面（功能性）**：`response.url` 在运行时栈不报最终地址时是**空字符串**，不是 `undefined`。
原实现写的是 `response.url ?? url` —— `??` 只对 `null`/`undefined` 生效，空串原样传下去，
`toPlainText()` 把它交给 JSDOM 作 base URL，JSDOM 抛 `Invalid URL: `（冒号后什么都没有）。
于是**每一次**外部来源验证都失败，而正文其实取到了：坏的不是抓取，是回落判据。

**第二面（诚实性）**：即使把回落补上，`finalUrl` 也只是「请求的 URL」而已。读者（审查员模型）拿到它
无法区分两件不同的事：

| 平台报了什么 | 事实 | 能下的结论 |
| --- | --- | --- |
| 报了一个不同的 URL | 跟随了跳转 | 页面身份 = `finalUrl` |
| 报的与请求一致 | 没跳转 | 页面身份 = 请求 URL |
| 什么都没报（空串） | 不知道有没有跳转 | **不能声称**页面身份，也不能声称「没跳转」 |

第三种在旧实现里与第二种**同形**（都回落成请求 URL）⇒ 模型会把「我没拿到」读成「我确认过了」。
这正是本仓反复收的那种失真：缺失被折成确定值。

## 2 修法

- `reportedUrl = response.url || ''`、`finalUrl = reportedUrl || url`：空串一律回落，
  JSDOM 永远拿到一个可解析的 base URL。
- 新增三态 `redirect: 'none' | 'followed' | 'not-reported'`（`SourceFetchResult` 上的**必填**字段）：
  空串 ⇒ `not-reported`；与请求相同 ⇒ `none`；不同 ⇒ `followed`。
- 同一条事实进两处消费方：日志行（`fetch_source verified { url, finalUrl, redirect }`）与工具返回值
  （`mcp-server` 把整个对象 `JSON.stringify` 给审查员）。
- 工具描述补一句三态语义，并明写 `not-reported` 时**不得**把 `finalUrl` 描述成「落到的页面」。

## 3 读数（全部实跑）

| 项 | 读数 |
| --- | --- |
| 单元套件（三个改动文件的测试） | `3 files / 60 passed` |
| 其中新增三条 | `none`（平台确认请求 URL）、`followed`（平台报了另一个 URL）、`not-reported`（空串仍能读出正文） |
| 反向门（证明用例不是摆设） | 把实现换回 `response.url ?? url` 且只留新用例 ⇒ `1 failed / 7 passed`，报错**逐字**是 `TypeError: Invalid URL: `（与真机日志同形） |
| 审查员整簇 + 桥接集成 | `24 passed | 1 skipped`（25 文件）、`281 passed | 3 skipped` |
| 双 typecheck | `tsc -p tsconfig.node.json --composite false` **exit 0**、`-p tsconfig.web.json --composite false` **exit 0** |
| lint（本次改动的 7 个文件，`--no-cache`） | **0 error / 0 warning** |
| 真进程探针（生产代码 esbuild 打包 + 真 `node` + 真 HTTP 服务，302 跳转） | `/plain` ⇒ `redirect: none`、`finalUrl` = 请求 URL；`/start` ⇒ `redirect: followed`、`finalUrl` = `/final`、`title` 取自落地页 |
| 全量单测 `--maxWorkers=4` | **1346 files / 17209 passed**（16 skipped files、207 skipped 用例，exit 0） |

真进程探针的接线：`--alias:electron=<shim>`（shim 的 `net.fetch` 就是 node 自己的 fetch），
其余全是产品代码（导航策略、`withCorrelatedFetch`、jsdom 抽取、日志）。**这样探针能证到的两种状态是
`none` 与 `followed`**；`not-reported` 只有 Electron 栈的（空串）行为能触发。

## 4 具名边界

1. **`not-reported` 的真机读数未取** —— `blocked-by`：本机内存闸门（空闲物理页 ≈ 60–80 MB、
   swap 已用 10–12 G），起不了 Electron。它由单元用例以**实测空串形状**钉住（`url: ''`），
   并在工具描述里向模型如实说明；解封条件＝下一次打包版或 dev 实例能起。
2. **这条与另一条执行体分支上的同名修复的关系**：那条分支（未合入 main）已把 `??` 改成 `||`，
   本条把它落到 **main**（main 上一直是坏的），并补上三态与工具描述；合并时若在两行上冲突，
   以本条的三态版本为准。
3. 不改 `rubric` 的既有指令文本、不开新通道、不加 i18n 键（这是主进程 → 模型的工具面，不上屏）。
