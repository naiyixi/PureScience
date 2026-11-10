# 预览/复核读一次内容，把整行证据 JSON 也读了一遍：`resolveVersionContent` 的投影收窄

日期：2026-11-11（执行器轮次） · 范围：`src/main/artifacts/provenance-repository.ts`（+ 一条钉子用例）
· 输入：`~/Library/Logs/PureScience/main*.log`（只读）、`~/.purescience-project/purescience.db`（只读）

## 一 为什么查这里：慢 IPC 分桶的第一名不是它自己

`node scripts/slow-ipc-windows.mjs --exclude acp:send-prompt --gap 800` 的读数（5,569 行 / 2,598 段窗口）：

| 通道 | 条数 | 合计 | 中位 | 最大 | 判词 |
| --- | --- | --- | --- | --- | --- |
| `network:check-connectivity` | 20 | 2,444 s | 1,315 ms | 980,280 ms | self-borne（三条巨行是机器休眠：`heldMs` ≈ 整段） |
| `sessions:save-session` | 3,776 | 2,311 s | 108 ms | 181,067 ms | self-borne |
| `reviewer:get-for-session` | 161 | 297 s | 213 ms | 71,275 ms | self-borne |
| `notebook:list-runtimes` | 101 | 208 s | 1,262 ms | 5,851 ms | window-borne（上一轮已交付） |
| **`artifacts:read-preview`** | **85** | 51 s | **125 ms** | **8,241 ms** | window-borne 90% |

单独看 `read-preview`：`cpuShare` 中位 0.80、p95 1.00，`cpu-bound-in-process` **56 / 83 条** —— 这是**本进程在烧 CPU**，
不是网络也不是排队。逐窗口追它最大的三行（2026-11-05T15:15:30 的两条 `read-preview` + 一条 `probe-availability`，
各 8.24 s）与次大的两行（2026-11-09T10:58:25，同窗口里有 `sessions:save-session` 32,474 ms）⇒ 它们是**同一段窗口里
一起等**，通道自己不是持有者。

## 二 承重的读数：这条线上已经有分段仪表，用它的数字

`artifact version resolve was slow`（同一条解析路径自己的分段）共 **549 行**：

| 分段 | 中位 | p90 | p99 | 最大 | 合计 |
| --- | --- | --- | --- | --- | --- |
| `clientMs`（取客户端） | 0 | 1 | 5 | 13 | 0.24 s |
| `queryMs`（SQLite 查询） | 60 ms | 235 ms | **1,970 ms** | 3,846 ms | **78.3 s** |
| `dbCanaryMs`（同一连接的 `SELECT 1` 金丝雀） | 40 ms | 228 ms | 1,949 ms | 3,827 ms | 66.9 s |
| `readMs`（整文件读 + 校验） | 34 ms | 226 ms | 8,564 ms | 28,936 ms | 171.6 s |
| `bytes`（为此读的整文件） | 12.2 KB | 3.8 MB | 5.8 MB | 5.8 MB | **491 MB** |

两条判据：① `dbCanaryMs` 与 `queryMs` 同幅（2,232 ↔ 2,224），说明**引擎在忙**，不是我们的查询写法慢；
② `readMs` 的尾巴与 `readEventLoopMaxMs`（最大 15,141 ms）同现 ⇒ 大文件那几行的「读」里混着别人的长同步块。

**真机库的形状**（`sqlite3 -readonly`，517 条 `ArtifactVersion`）：

| 列 | 合计字符 | 平均 | 最大 |
| --- | --- | --- | --- |
| `evidenceJson` | — | 24,944 | 78,149 |
| `executionSnapshotJson` | — | 63,577 | 348,639 |
| 两列合计 | **45,765,684** | ~88,500 | ~426,800 |

## 三 缺口：读一次内容，把整行证据拖过来再丢掉

`resolveVersionContent` 的查询是 `include: { artifact: true }`，即**整行 `ArtifactVersion` + 父行 `ArtifactLineage`**；
而下面的代码只用四个标量：`contentStorageKey` / `filename` / `contentType` / `checksum`。

于是每一次预览打开、翻页、复核读取，都要为一行**平均 ~88 KB、最大 ~427 KB 的 JSON** 付三笔钱：
SQLite 读溢出页、Prisma 桥拷贝成字符串、客户端把它解析成 JS 对象 —— 下一行就丢。
这与本文件里已经写下的先例同族（`resolveVersionPaths` 的头注：*「`resolveVersionContent` 是回答可用性问题的错误工具」*），
只是那一次修的是「读不读文件」，这一次修的是「读不读整行」。

## 四 交付

| 位置 | 改动 |
| --- | --- |
| `src/main/artifacts/provenance-repository.ts` | `resolveVersionContent`：`include: { artifact: true }` → `select: { contentStorageKey, filename, contentType, checksum }`；注释写明真机字节数与「收窄的是读什么，不是校验什么」 |
| `src/main/artifacts/provenance-repository.test.ts` | 新增 1 例「projects only the columns a content resolve consumes」：真 Prisma 临时库 + `vi.spyOn(artifactVersion.findFirst)` 抓查询形状，钉住**精确**投影且**不得**出现 `include` |

**未动的语义**：`where` 的归属条件、`state` 过滤、`readFile` + `sha256` 校验、校验不符即抛错，一字未改 ——
收窄的是投影，不是证据门。

## 五 门禁（全部实跑，取自最后一次改动之后）

| 环 | 读数 |
| --- | --- |
| 新用例（定向） | 1 passed / 42 skipped |
| `src/main/artifacts` 整目录 | **21 files / 292 passed**，exit 0 |
| `src/main/reviewer` + `src/main/uploads`（另两个消费方） | **33 files / 402 passed**，exit 0 |
| `tsc --noEmit -p tsconfig.node.json --composite false` | exit 0 |
| `tsc --noEmit -p tsconfig.web.json --composite false` | exit 0 |
| `eslint --no-cache`（2 文件） | 0 error / 0 warning |

**变异自证两次（均还原）**：① 投影里加回 `evidenceJson: true` ⇒ 新用例当场红
（`expected { contentStorageKey: true, …(4) } to deeply equal { …(3) }`）；
② 改回 `include: { artifact: true }` ⇒ 新用例红（`expected undefined to deeply equal { contentStorageKey: true, …(3) }`）。

## 六 边界（不许读成更强）

- **没有装机读数**：这一笔只在主进程侧，真机日志要等下一次发版。装机后的判据两条：
  ① `artifact version resolve was slow` 里 `queryMs` 的 p90/p99 下移（本轮的 235 / 1,970 ms 是基线）；
  ② 同一时段 `artifacts:read-preview` 的 `cpu-bound-in-process` 条数与 `cpuShare` 中位（0.80）下降。
  **不承诺毫秒数**：省下的是「每行 88 KB 的溢出页读 + 解析」，实际耗时随产物库大小与机器状态变。
- **`readMs` 那一段没动**：整文件读 + `sha256` 是本仓的证据门（校验不符即拒），不以性能为名削弱；
  它的 171.6 s 合计里还混着别人的长同步块（`readEventLoopMaxMs` 最大 15 s），要单独归因得另立一单元。
- **`sessions:save-session`（3,776 条 / 2,311 s）仍是分桶第一名**，本轮只把「预览/复核读一次内容」这一段的
  DB 侧成本削掉，不等于削掉了那个窗口。
- 本轮的 `network:check-connectivity` 三条巨行判为机器休眠（`heldMs` ≈ 整段、`durationMs` 980 s），**不立案**；
  同一通道其余 17 行的中位 1.3 s 属探针正常开销。
