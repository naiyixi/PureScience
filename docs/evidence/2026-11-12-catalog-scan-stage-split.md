# 目录扫描的慢行现在自带分段：目录列举 / 索引读 / 文档读

日期：2026-11-12（执行器单元）· 代码：`src/main/session-persistence/repository.ts`
（`loadCatalogWithDiagnostics` / `readProjectCatalog`）· 用例：`catalog-index.test.ts`（+2）

## 一 症状与本单元的取舍

装机日志里 `sessions:list-catalog` 的慢行只有通道名与总时长（6 行，p50 932 ms，一行 14.2 s 的
`attributedHeldMs` 12.5 s），而**同一次读在本机、索引在位时是 33 ms**。三种可能（目录列举、索引读、
文档回退）对应三种完全不同的修法，字段读不出来就只能靠猜——本单元把这三段各自报出来。

## 二 本机读数（真实语料，只读）

语料：打包版数据根 `~/.purescience/sessions` 拷到临时根（**264 份会话文档 / 206 MB / 60 个项目**），
用交付的 `SessionRepository.loadCatalogWithDiagnostics()` 扫三遍。改前（与改后逐位相同，分段只是加读数）：

| 次 | 总时长 | directoryMs | indexMs | documentMs | manifestMs | 命中/解析 |
| --- | --- | --- | --- | --- | --- | --- |
| 冷（无索引） | 93,022 ms | 55 | 387 | 92,563 | 2 | 0 / 264 |
| 第二次 | 103 ms | — | — | — | — | 264 / 0 |
| 第三次 | 33 ms | — | — | — | — | 264 / 0 |

**单份文档的真实成本不是 350 ms。** 同一批文件里最大的四份（5.29 / 4.05 / 3.41 / 2.75 MB）各量一遍
`readFile` / `JSON.parse` / `normalizeSessionFile`（产品自己的函数）：

| 文件 | 大小 | readFile | JSON.parse | normalize |
| --- | --- | --- | --- | --- |
| c39e4fc2…json | 5.29 MB | 9 ms | 12 ms | 18 ms |
| e26108e7…json | 4.05 MB | 11 ms | 6 ms | 7 ms |
| 182a6adb…json | 3.41 MB | 5 ms | 7 ms | 5 ms |
| 55cb994f…json | 2.75 MB | 4 ms | 6 ms | 5 ms |

⇒ 冷扫里 `documentMs / parsedDocuments` = **350 ms/份**，而同样的读+解析+归一化是 **~35 ms/份（最大的那份）**。
差额不在解析里。

**规模无关性**：只取 30 份文档（28 个项目）冷扫一次 = **14,147 ms**（`documentMs` 14,112，平均
**470 ms/份**）⇒ 不是「语料越大越慢」的累积效应，而是每份文档的读都在等。

## 三 一个被证伪的假设（已回退，不留这笔改动）

第一反应是「冷扫为每份文档起一个不等待的索引预热（`void writeSessionSummary`），264 个并发写压住了读」。
把它改成串行（`summaryWarmQueue` 链式）后**同一语料再量**：

| 版本 | 冷扫总时长 | documentMs |
| --- | --- | --- |
| 并发预热（交付态） | 93,022 ms | 92,563 |
| 串行预热（临时改动） | 94,504 ms | 94,027 |

**无改善（在噪声内反而更慢）** ⇒ 假设不成立，改动已回退：不留一笔「说不清为什么留着」的代码。
（这条记下来的价值：下一轮不要再往这个方向动手。）

## 四 边界（不许读成更强）

- **这是库内、单连接、无并发的读数**，不是装机读数，也不是窗口读数。
- 冷扫的 350–470 ms/份**不能判成产品缺陷**：同一时刻本机 `loadAvg` 14.1、空闲内存 169 MB / 8.6 GB、
  日志里 4,402 行「event loop stalled」——判为这台机器的 I/O 与换页等待。要判它是不是产品问题，需要
  **一台空闲机器上的同一次扫描**；本单元不声称其中任何一段是「我们的 CPU」。
- **不改任何行为**：分段只增加一行日志（`session catalog read was slow`，仅当总时长 ≥ 250 ms 时打印），
  返回结果与改前逐字段相同（`index.hits` / `parsedDocuments` 未动，`catalog-index.test.ts` 的 8 条
  既有断言一字未改）。
- 分段口径：`directoryMs` 累计「项目列举 + 每个项目的文件列举」；`indexMs` 累计每次
  `tryReadSessionSummary`；`documentMs` 累计每次 `readSessionFile`（回退解析）。索引预热写在
  `documentMs` **之外**（它是 `void` 的，不计入）。

## 五 装机判据（下一版之后可直接读）

新版日志里 `session catalog read was slow` 一行同时给出 `totalMs` / `directoryMs` / `indexMs` /
`documentMs` / `manifestMs` 与 `indexHits` / `parsedDocuments`：

- `documentMs` 占大头且 `parsedDocuments` 高 ⇒ 索引没被用上（升级后首次、或指纹漂移），修法是索引写入
  时机，不是解析；
- `indexMs` 占大头 ⇒ 每份一份 `stat + read` 的成本，修法是一次目录级批读；
- 三段都很小、`totalMs` 却很大 ⇒ 时间在**等**（主线程/连接被别的通道占着），此时不该改这个函数。

## 六 复跑配方

探针是一次性文件（量完即删、不进提交）。重建设法：

1. 临时 vitest 用例 `vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))`
   —— **必须**，否则 `decodeSessionDataPaths` 会在无 `app` 的进程里抛错（上一轮这条教训已让 66 份真实
   会话文档被改名）；
2. `cp -R ~/.purescience/sessions <tmp>/sessions`（**只读真实语料，一切写入落在临时根**）；
3. `new SessionRepository(<tmp>, {}, { warn: (message, data) => 写一行到 /tmp/*.jsonl })`，然后连扫三遍；
4. 单文件成本另测：`readFile` → `JSON.parse` → `normalizeSessionFile(parsed)` 三段各自计时。
