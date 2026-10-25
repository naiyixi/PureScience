# 项目库打开：一次「什么也没变」的启动要付 120 ms

**问题**：`compose runtime steps` 里 `open-project-db` 一直是启动最慢的一步（真机 330 ms，`cpuShare 0.30`
说明不是 CPU 密集）。它做的就是 `ensureProjectSchema`：一串**串行**的 DDL 经 Prisma 查询引擎执行。

| 动作 | 条数 |
|---|---|
| `CREATE TABLE IF NOT EXISTS` | ~40 |
| `CREATE INDEX IF NOT EXISTS` | ~60 |
| 守卫式 `ALTER TABLE ADD COLUMN`（每个先读 `sqlite_master` 再读 `PRAGMA table_info`） | ~40 步 → ~80 往返 |
| CHECK 约束迁移（可能重建表） | 6 组 |

**在已是最新的库上，这一整套的答案是「都在」，但每次启动都要问一遍。**

## 读数（255 MB 真实库的副本，5 轮，`scripts/bench/project-db-open.bench.test.ts`）

| | p50 | p90 |
|---|---|---|
| 改前 `ensureProjectSchema` | **120.7 ms** | 174.7 ms |
| 改后 `ensureProjectSchema` | **38.4 ms** | 55.0 ms |
| 改前 打开步合计（含引擎 `SELECT 1`） | 129.0 ms | 180.8 ms |
| 改后 打开步合计 | **48.6 ms** | 63.3 ms |

复现：`PURESCIENCE_BENCH_PROJECT_DB=1 npx vitest run scripts/bench/project-db-open.bench.test.ts`
（脚本把读数写到 `docs/bench-runs/2026-10-25-project-db-open.txt`）。

## 改法：把序列变成数据，用数据算指纹

1. 250 行的顺序调用改成**一份有序步骤表**（`sql` / `column` / `checks` 三种步骤），执行器 8 行；
2. `PROJECT_SCHEMA_FINGERPRINT` 由**步骤表本身**算出（SHA-256 前 31 位）——**不靠人手改版本号**，
   改了任何一条 DDL 指纹必变；
3. 指纹 + SQLite 自己的 `PRAGMA schema_version` 存进 `SchemaStamp` 表；启动时只读这两件事，
   一致就跳过全部 DDL。

**为什么必须是两个判据**：只存指纹的话，一个被外部改写过的文件（另一进程改了表、恢复的备份、老版本
写的库）会冒充「已是最新」。`schema_version` 在**任何** DDL 之后都会自增，所以它是「这个文件现在真的
是这样」的判据。真机验证就在仓里：三条 legacy 迁移用例（legacy 输入表约束、filename 回填、状态约束
重建）都是先建全再**改写一张表**，只有 `schema_version` 这一条判据能让它们继续通过——它们全部通过。

**快路径的语句数**（用例逐条数，不测毫秒）：冷启动 >50 条 → 温启动 **4 条**（两个 pragma + 戳读取 +
`schema_version`）。新用例还钉住两条：指纹不符要重跑、外部改写要重跑。

## 真机对照（打包版 2.18.0 + 本次改动，同一台机器、同一个 255 MB 库）

| 启动 | `open-project-db` | `compose runtime steps` 合计 |
|---|---|---|
| 改动前（无快路径，每次启动都一样） | **330 ms** | 404 ms |
| 改动后第一次（无 `SchemaStamp`，跑全序列并写戳） | 432 ms | 492 ms |
| 改动后第二次（命中快路径） | **126 ms** | **185 ms** |

平台：macOS 26（arm64），应用 `/Applications/PureScience.app`，`CFBundleShortVersionString = 2.18.0`，
asar 里能 grep 到 `SchemaStamp` / `ddlFingerprint` 且 `user_version` 已不存在（先证明跑的是这棵树）。
`compose step slow`（阈值行）在 126 ms 这次也不再出现——改前 330 ms 那次是出现的。

**第一次启动会比以前慢约 100 ms**（多一张表 + 一次写戳），第二次起比原来快 **约 200 ms**。

## 发布件（v2.18.0 的 DMG）也装过一遍

DMG 下载完成后（GitHub CDN 在本机只有 ~20 KB/s，四轮断点续传才拉全 284,219,199 字节），做了三件事：

1. **字节校验**：`shasum -a 256` = `1299d1460f17e32ad281574dbcf5b01e91e471d56528cb4c8145e43de4b30b43`，
   与 Release 页 `SHA256SUMS.txt` 里那行**逐字符一致**；
2. **内容核对**：`CFBundleShortVersionString = 2.18.0`；asar 里 `/api/v1/agent-card` 与 `trajectory/` 在，
   **`SchemaStamp` 不在** —— 发布件确实早于这次快路径；
3. **装机读日志**：`open-project-db = 406 ms`（`compose runtime steps` 合计 497 ms），即**修复前**的形状。

随后把含快路径的本地构建装回（同一版本号 2.18.0，asar 里 `SchemaStamp` 已存在），机器保持在修复后的状态。

**所以这一版的收益不在 v2.18.0 里**：同一台机器、同一个库，发布件 406 ms vs 修复版 126 ms。

## 做不到 / 没做

- 剩下的 38 ms 里含引擎首次查询与 WAL 打开，不是这套 DDL 序列，没有继续压；
- 真机（打包版）读数要等下一次装机启动日志对照，bench 是本机副本读数，两者不能互相替代。
