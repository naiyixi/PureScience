# 单连接读池：把约束核清之后的设计（P0-10③ 根因，2026-10-11）

> 起因：`artifact version resolve was slow` 273 次、`dbCanaryMs`（`SELECT 1`）中位 47 / p90 346 / max 1,163 ms，
> 而 `queryEventLoopMaxMs` 中位 0（事件循环没堵）、耗时与 `bytes` 桶无关 ⇒ 根因是**单连接池排队**。

## 现状（已核，逐条给出处）

- `src/main/projects/prisma-client.ts:15` `PROJECT_DB_CONNECTION_LIMIT = 1`，`:923` 拼进 URL `?connection_limit=1`。
- 该文件里**没有**任何 `journal_mode` / `WAL` / `busy_timeout` 设置。
- `:12-14` 的注释写明了 limit=1 的**两条**理由（原文）：
  1. **硬约束**：*"SQLite PRAGMAs are connection-scoped. The runtime constraint migration disables foreign keys
     before entering its rebuild transaction, so this client must keep both operations on one physical connection."*
  2. **软理由**：*"A single writer also avoids unnecessary SQLITE_BUSY contention for the local Project DB."*

## 设计要分清的一条 PRAGMA 语义（这决定了实施顺序）

- `PRAGMA foreign_keys` 是**连接级**的 ⇒ 迁移那一步**必须**在同一物理连接上完成（这是硬约束，读池不能破坏它）。
- `PRAGMA journal_mode = WAL` 是**数据库文件级**的（持久，写一次对之后所有连接生效）⇒ 它**不需要**读池也能先上。

⇒ 因此实施顺序应当是**先小后大**，而不是一步做读池：

### 第一步（推荐先做，改动小、无新连接、无内存增量）

在**现有那一条**连接上，初始化时执行 `PRAGMA journal_mode = WAL` + `PRAGMA busy_timeout = <ms>`：

- 收益：WAL 下**读不再被写者的日志锁挡住**（rollback-journal 模式下写事务会挡读），这正是 `dbCanaryMs` 那种"同步慢"的形状。
- 代价与要处理的后果：
  - 会多出 `purescience.db-wal` / `-shm` 两个伴随文件 ⇒ **凡是"复制/搬运/统计数据库文件"的路径都要核一遍**：
    本仓至少要查删除协调器、存储用量走查（我这轮加的按项目体积）、以及任何"拷 .db 备份"的写法；
    只拷 `.db` 会**丢掉 WAL 里尚未 checkpoint 的内容**（这是 WAL 最经典的坑）。
  - 退出路径（P0-1 那条逐阶段面包屑）需要在收尾时 checkpoint 或接受 `-wal` 残留。
- 验收判据：**必须取真读数** —— 同一台机器、同一条 `dbCanaryMs` 探针，给出 p50/p90/max 的**改前/改后对照**；
  以及"删除/迁移/备份三类路径在 WAL 之下仍正确"的定向用例。

### 第二步（只有在第一步读数不足时才做）

独立**只读** PrismaClient（自己的连接）承载读查询；**写与迁移仍留在 limit=1 的那条**：

- 硬要求：读客户端**永远不发出写**（否则 SQLITE_BUSY 会回来，且跨连接事务语义会变）；
  路由判据按"这次调用会不会写"分，而不是按调用点拍脑袋。
- 硬要求：**迁移/DDL 只在写客户端上跑**，`foreign_keys=OFF` 那条必须在同一物理连接内完成（原约束不变）。
- 代价：多一个 PrismaClient 实例 ⇒ **内存增量必须实测**（本机 8 GB、空闲物理页常年百来 MB ⇒ 这一项可能是否决项）。
- 子代理/多进程并发写同一 DB 的形态**不在本设计范围**（那是另一个问题）。

## 未做与阻塞

- **本设计尚未实施**（`PROJECT_DB_CONNECTION_LIMIT` 仍为 1，无 WAL）。
- 第一、二步的**验收读数都必须在真机取**（同一台机器、同一探针、改前改后对照）—— 当前被内存闸门挡住
  （空闲物理页 ≈111 MB），**未取就是未取**，不允许用单测或 CI 读数替代。

## ⚠️ 更正（2026-10-12）：本文件原先给的因果**未被实验支持**，别照它当事实

本文件开头把"读被写者的日志锁挡住"写成 WAL 的理由。**我做了两次对照实验，都没能复现这个机制**：

| 实验 | 做法 | 结果 |
|---|---|---|
| v1 | 写者停在 `BEGIN IMMEDIATE`（RESERVED 锁），另一连接读 `SELECT 1` ×40 | `delete` 与 `wal` **都 0 阻塞**，中位 0.001 ms |
| v2 | 写者提交 **120,000 行**（提交窗口 77 ms(delete) / 158 ms(wal)），读者线程持续读 | `delete`：737,096 次读、**0 阻塞**、p99 0.016 ms、>20 ms 的读 **0**；`wal`：798,192 次、**0 阻塞**、p99 0.014 ms |

- v1 的负结果本身有解释：`BEGIN IMMEDIATE` 只拿 RESERVED 锁，**读仍可过**；真正可能挡读的是提交的写回阶段。
- 但 **v2 把写回窗口拉到几十毫秒后，两种模式下读依然一次都没被顶起来** ⇒
  **"慢 `SELECT 1` 源于文件级日志锁"这条假设，用我可及的测量手段得不到支持。**
- 范围说明（别过度外推）：这是 `sqlite3` stdlib 的两线程两连接对照，**不是**应用的 Prisma 连接池 ——
  但它足以否掉"文件锁导致排队"这条解释：连**裸 SQLite 的 `delete` 模式**都没出现该现象。

**因此对 P0-10③ 的结论要改写**：慢 `SELECT 1`（中位 47 / p90 346 ms）与事件循环无关、与载荷无关，
最合身的解释仍是**应用侧单连接池排队**（`PROJECT_DB_CONNECTION_LIMIT = 1`）—— 也就是本设计的**第二步**。

**WAL 这一步怎么办**：保留（它本身无害、且是读池的前置条件：多连接读之前必须先让并发读在文件层可行），
但它的定位**降级为"前置条件"**，不再是"已经对症"的修法；
**"它是否真的改善了那 273 次慢解析"必须由第 3 项（真实使用时段的出现率对照）回答，我不预设结论。**

实验脚本（可复跑）要点：`.backup` 取真实库的一致副本（不能 `cp`，会漏 WAL 内容）；读连接**必须建在读者线程内**
（sqlite3 对象默认线程绑定，跨线程直接抛 `ProgrammingError`）；读者用 `timeout=60`，被 BUSY 挡住的等待会计入其延迟。
