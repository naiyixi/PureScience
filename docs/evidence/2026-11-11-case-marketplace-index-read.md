# 案例市场的索引读：每次打开都重下一次，等满 20 秒后只说「操作被中止」

日期：2026-11-11 · 范围：`src/main/cases/marketplace.ts`、`src/renderer/src/stores/case-market-store.ts`、
`src/renderer/src/pages/home/CaseMarketplace.tsx` · 只读输入：`~/Library/Logs/PureScience/main*.log` + 本机常驻实例的
`cases:marketplace` 通道（真读数，见 §二）

## 一 读数（先量；两条独立来源）

**① 慢 IPC 分桶（`node scripts/slow-ipc-windows.mjs --top 15`，三份日志合计 4,925 行慢记录 / 1,960 段窗口）**

| 通道 | 慢行 | 合计 | 中位 | 最大 | 归因 |
| --- | --- | --- | --- | --- | --- |
| `cases:marketplace` | 23 | 269,428 ms | 10,517 ms | 22,062 ms | self-borne（peer rows 10%） |

其中 **9 条的 `durationMs` 落在 20,004–20,041 ms**，且 `cpuShare` 0.03–0.12、`attribution` 多为
`no-cpu-in-process` —— 形状是「在等，不是在算」，与「deadline 到点被中止」一致：

| 时刻（Z） | durationMs | cpuShare |
| --- | --- | --- |
| 2026-11-06T03:12:30 | 20,007 | 0.03 |
| 2026-11-06T03:32:00 | 10,517 | 0.017 |
| 2026-11-06T11:57:31 | 15,701 | 0.43（held 3,971 / own 11,730） |
| 2026-11-07T08:45:02 | 20,009 | 0.081 |
| 2026-11-05T05:43:03 | 20,041 | 0.059 |
| 2026-11-05T12:17:04 | 20,009 | 0.059 |
| 2026-11-05T15:16:06 | 22,062 | 0.119（held 1,841 / own 20,221） |
| 2026-11-09T11:08:31 | 20,023 | 0.642 |
| 2026-11-09T11:34:35 | 20,839 | 0.66 |
| 2026-11-10T14:57:40 | 20,012 | 0.039（held 602 / own 19,410） |

**同一天四次的形状**：`2026-11-06` 的 03:12、03:18、03:22、03:32 各有一次（20 s / 7.2 s / 1.25 s / 10.5 s）——
用户在一个面板里进出，每次打开都重下一遍索引。

**② 真机通道读数（本机常驻的 dev 实例，`/api/bootstrap` 报 `version 2.26.0`、380 个 RPC 通道，
`cases:marketplace` 在列；走产品自己的 web RPC，改前的代码）**

| 请求 | 耗时 | 返回 |
| --- | --- | --- |
| 默认索引地址（不带 `indexUrl`） | 2.27 s | `status:ok`，1 条案例（内部评测） |
| `https://192.0.2.1/case-marketplace.json` | 10.26 s | `refused / unreachable`，`detail: TypeError: fetch failed` |
| `https://10.255.255.1/case-marketplace.json` | 11.0 s | `refused / unreachable`，`detail: TypeError: fetch failed` |
| 本地服务器：读掉请求后**永不应答**（`127.0.0.1:45871`） | **20.06 s** | `refused / unreachable`，`detail: AbortError: This operation was aborted` |

前三条说明：网络层把可操作的成因（`connect ETIMEDOUT <host>` / DNS）藏在 `cause` 里，界面上只剩一句
`fetch failed`。第四条把日志里那 9 条 20 秒行完整复现了，并说明**等满 20 秒之后读者拿到的是一句"我们中止了操作"**。

## 二 缺陷（三处，都有读数或代码形状支撑）

1. **每次挂载都重下一次。** `CaseMarketplace` 由首页无条件渲染（`HomePage.tsx:718`），它的 effect 调
   `store.load()`，而 `load()` 只有「设 loading + 发请求」两个动作；store 自己的头注写着「读者离开再回来不应当
   再下载一次」。于是索引读被按「每次打开」计费 —— 在网络答不上来的时段，每次都要重付一遍 deadline（§一 ② 的
   20.06 s）。
2. **一个 20 秒的声明，实际是两段各 20 秒。** `fetchCaseMarketplaceIndex` 先用 `withTimeout(20 s)` 取响应头，
   再用**另一个** `withTimeout(20 s)` 读 body ⇒ 服务端先回头再卡住时最坏 40 秒（日志未出现 40 s 行，这条按代码
   形状修，不按读数修）。头到了不等于文档读完了。
3. **拒绝句不可操作。** `detail` 分别是 `TypeError: fetch failed`（真机实测）与 `AbortError: This operation was
   aborted`（真机实测）——前者丢了 `cause`，后者描述的是我们做了什么，既没说发生了什么，也没说等了多久。

## 三 交付（3 个产品文件 + 2 个测试文件）

| 位置 | 改动 |
| --- | --- |
| `src/main/cases/marketplace.ts` | ① 一个 `AbortController` + 一个 timer 覆盖**取头与读体两段**（`expired` 记「是预算到点」）；② 超时分支的 `detail` 由预算派生：`timed-out after ${budgetMs}ms`；③ 新增 `describeFetchError`：走最多 3 层 `cause` 链拼成 `fetch failed ← connect ETIMEDOUT …`（有界，防环/长链）。`where`/`state`/大小上限/索引校验一字未改。 |
| `src/renderer/src/stores/case-market-store.ts` | 新增 `reading: boolean` 与 `readAt: number \| null`；`load(options?: {force?: boolean})`：本会话读过（成功或拒绝都算）就不再问，进行中也不重复问；`force` 才重读。`resetCaseMarketStore` 一并复位。 |
| `src/renderer/src/pages/home/CaseMarketplace.tsx` | 刷新按钮改为 `load({ force: true })`（读者要重问的唯一入口）。 |
| `src/main/cases/marketplace.test.ts` | 新增 3 例：超时说出预算（`timed-out after 40ms`，不是中止原文）；body 停在头之后时**同一个 signal** 被中止（一条预算覆盖全程，用 `Promise.race` 兜 2 s，避免回归时挂满运行器超时）；`cause` 链被保留。 |
| `src/renderer/src/pages/home/CaseMarketplace.render.test.tsx` | 夹具补 `reading` / `readAt` 两个桩；新增 2 例：卸载再挂载只读一次；拒绝态保留、按刷新才再读一次。 |

## 四 门禁（全部实跑，取自最后一次改动之后）

| 环 | 读数 |
| --- | --- |
| 定向：`src/main/cases` + `src/renderer/src/pages/home` | **18 files / 137 passed**，exit 0 |
| 渲染层加宽：`src/renderer/src/pages/home` + `App.test.tsx` + `src/renderer/src/stores` | **45 files / 661 passed**，exit 0 |
| `tsc --noEmit -p tsconfig.node.json --composite false` | exit 0（堆：`NODE_OPTIONS=--max-old-space-size=8192`，默认堆会 abort 134） |
| `tsc --noEmit -p tsconfig.web.json --composite false` | exit 0 |
| `eslint --no-cache`（5 个改动文件） | 0 error / 0 warning |

**变异自证（三次，均还原）**：
① 关掉 store 的「读过就不再问」⇒ 两条新渲染用例红（2 failed / 6 passed）；
② 取头之后 `clearTimeout(timer)`（回到每段各自计时）⇒ body 那条用例红（2 s 兜底命中）；
③ 把 `timed-out after …` 换成中止原文 ⇒ 两条主进程用例红。

## 五 改后真机读数（本机常驻 dev 实例重启到本笔代码之后，同一台机器、同一条 RPC 通道）

实例 `launchctl kickstart -k gui/$(id -u)/com.totota.purescience` 重启（PID 18057，44100 LISTEN），随后同一条
`cases:marketplace` 通道：

| 请求 | 耗时 | 返回 |
| --- | --- | --- |
| 本地服务器读掉请求不应答（`127.0.0.1:45871`） | **20.15 s** | `refused`，`detail: timed-out after 20000ms` |
| `https://10.255.255.1/case-marketplace.json` | 10.16 s | `refused`，`detail: fetch failed ← Connect Timeout Error (attempted address: 10.255.255.1:443, timeout: 10000ms)` |
| 默认索引地址（第一次） | **20.17 s** | `refused`，`detail: timed-out after 20000ms` |
| 默认索引地址（第二次、第三次） | 10.66 s / 10.63 s | `refused`，`detail: fetch failed ← Connect Timeout Error (attempted address: github.com:443, timeout: 10000ms)` |

同一时刻的独立对照（不经应用）：`curl -sSL --max-time 30 <同一个默认地址>` **两次都是 `curl: (28) Connection
timed out after 30 s`** ⇒ 这台机器此刻确实连不上该主机，改后读到的拒绝不是代码造出来的。

**这份读数同时钉住三件事**：① 改后代码确实在跑（`timed-out after 20000ms` 与 `←` 链只有新代码会产生）；
② 等待的**上限**仍是 20 s（未缩短 —— 缩短是产品决定，不在本单元范围）；③ 拒绝句现在带可操作成因
（`attempted address` + 超时值），而不是 `fetch failed` / `This operation was aborted`。

## 六 边界（不许读成更强）

- **有 dev 实例真机读数（§五），没有打包版读数**：`launchctl kickstart` 重启的实例跑的是本笔代码（它的拒绝句证明
  这一点），但**打出去的安装包**要等下一次发版才带这段改动。
- **渲染层的「一次会话只读一次」没有真机窗口读数**：它不发请求，界面上与改前同形；证据是渲染用例（卸载→挂载
  只调一次桥、拒绝态保留、刷新才再读）。装机后的判据：`cases:marketplace` 的慢行条数在「同一天多次打开」的时段
  下降，且同一时段不再出现两次 20 秒行。
- **收益不承诺毫秒数**：省下的是「重复打开次数 − 1」份读取；第一份该等还是等（本机实测 2.27 s；不可达时
  仍要等满 20 s，因为 deadline 没有缩短 —— 缩短是产品决定，不是这次的范围）。
- **没有引入镜像/回退源**：索引是信任的根（案例归档靠它钉 sha256），按既有的「没有校验和就没有回退」口径，
  不能给它加一个未核对的备用地址。
- 日志里另有几条 `cases:marketplace` 是 `cpu-bound-in-process`（cpuMs 11–27 s）：那是**同一个进程也在算别的**
  （分桶的 20 秒行里 held/own 已分开），本轮没有归因，**不并入本单元**。
