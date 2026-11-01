# `notebook:state` 的慢读，一半是「我们自己刚写完就把它忘掉」

日期：2026-11-02 · 单元：主进程读通道（`NotebookRunRepository.persist` 的缓存语义）· 提交见文末

## 1 缺口：真机日志里 112 次慢读，全部是缓存未命中

真机主日志（`~/Library/Logs/PureScience/main.log` + `main.1.log`，打包版 **v2.21.1** 运行中，
窗口 `2026-10-29T14:42Z → 2026-11-01T16:26Z`，合计 17,309 行）:

| 读数（全量重算） | 值 |
|---|---|
| `notebook state read was slow` 行数 | **130** |
| 其中同一会话 `d79576e8…` | **112**（37 分钟内，13:16:48 → 13:53:52） |
| 该会话 `loadMs` 区间 | **205 – 626 ms**（`cold` 全为 `false`） |
| 该会话 `runs` 增长 | 50 → 100（活跃会话，边跑边读） |
| 同一窗口 `notebook:state` 慢 IPC 行 | 175 条，中位 283.7 ms，**合计 70.0 s 主线程** |

`loadMs` 只覆盖 `loadOrCreate`（读 + 解析 + 归一化 run.json）。同一会话的两次慢读常常只隔 **30–45 ms**
（如 13:18:10.718 / 13:18:10.763，`runs` 同为 54），两次都付了 230–280 ms。

**判据**：缓存命中时这条路径是 ~1 ms 级（下表实测）。两次相邻慢读都慢 ⇒ 两次都是**未命中** ⇒ 区间内发生了写。
读代码可确认机制：`persist()` 每次落盘后 `documentCache.delete(filePath)` —— 所以我们**自己的一次写入**
会把下一次读打成全量重新解析，而活跃会话每轮执行要写很多次（run 起跑 / 终态 / 内核状态 / 文件证据）。

## 2 先量后改：把生产函数搬到真文档副本上单独跑（只读真数据根，副本落 `/tmp`）

用生产函数 `NotebookRunRepository` 直接吃真文档副本；「读前先写一次」用 `updateKernelStatus` 制造
（这正是活跃会话里真实发生的那次写）：

| 文档 | 字节 | runs | 未命中读 | 命中读 | 一次写 | **写后立刻读（改动前=未命中）** | **写后立刻读（改动后）** |
|---|---|---|---|---|---|---|---|
| 活跃会话 `d79576e8…` | 12.50 MB | 100 | 61.4 ms | 0.7 ms | 118.8 ms | 61.4 ms | **0.7 ms** |
| 全库最大 | 63.04 MB | 80 | 147.7 ms | 0.9 ms | 1,110.2 ms | 147.7 ms | **5.2 ms** |

口径：三次取中位；探针在隔离目录、`node_modules` 用仓库自己的；真数据根只读。
字段上的 205–626 ms 比这里的 61.4 ms 高，差额与同窗口 `event loop stalled` 74 条一致（机器侧停摆），
本单元只解决「我们自己的写把缓存打掉」这一半 —— 停摆那一半不在此列。

## 3 交付（2 文件）

| 位置 | 改动 |
|---|---|
| `src/main/notebook/repository.ts` | `persist()` 落盘（`rename` 之后）不再 `documentCache.delete(filePath)`，改为 **写穿**：`stat` 真文件后把**刚写出的那份文档**连同 `mtimeMs`/`size` 一起放进缓存；`stat` 失败才退回删除。 |
| `src/main/notebook/repository.test.ts` | 原来那条「drops the cached document when it writes one itself」改成 **「serves the document it just wrote, and never the one before it」**：写完读回必须是新状态且连续两次一致；**再加一段**——写穿之后缓存条目仍按文件校验，外部改写（这里故意用压缩格式写出，字节数与原有 pretty 格式不同）必须被读到。测试只加不减。 |

**三条设计判据**

1. **写穿而不是删**：落盘字节就是我们刚序列化的那份文档，缓存里换成它，命中即等于磁盘内容；
   旧写法「删」原本是为了防「同一毫秒内同尺寸重写被当成命中」——现在条目里是**新**文档，那条隐患消失。
2. **`stat` 在 `rename` 之后取**：条目绑的是真正落地的那个文件；外部写者（另一实例共享同一数据根、恢复备份）
   仍然改 `mtime`/`size` ⇒ 照旧不命中。这一条由测试第二段钉住。
3. **读路径仍然每次给归一化副本**：`loadOrCreate` 命中时走 `normalizeDocument`，调用方拿到的永远是独立对象；
   写路径的返回值在这一仓没有调用方会改（`run-terminalization` 只做查找、`postCommit` 只用 `result`）。

## 4 门禁（全部实跑）

| 环 | 读数 |
|---|---|
| 定向 `src/main/notebook` 整目录 | **91 文件 / 1,444 例全绿**（9 文件 / 100 例按设计 skip） |
| 双 `tsc --noEmit --composite false` | 本笔 **0 错**；node/web 两边各余 **4 条，全在并行会话在制的 `src/main/references/screening-service.ts`**（`TS6133`×3 / `TS2564`×1），未去改 |
| `npx eslint --no-cache`（本笔 2 文件） | **exit 0，0 error / 0 warning** |

## 5 边界（不许读成更强）与具名未办

1. **没有「字段读数已下降」的真机证据**：本机此刻跑的是打包版 v2.21.1，本笔要等下一次装包才会在真实会话里跑。
   留给下一版的判据：活跃会话里 `notebook state read was slow` 的条数（写后读那部分应先消失），以及 `loadMs`
   在 `cold:false` 下的分布。
2. **写侧没动，而且它比读侧更贵**：`mutate()` 每次写都要 `loadExisting` 全量解析，再用 `JSON.stringify(…, null, 2)`
   美化序列化 —— 实测 12.50 MB 一次写 **118.8 ms**、63.04 MB **1,110.2 ms**。这不在本单元范围内（读通道的分段里
   看不到它，它落在执行路径上），此处具名立案，下一轮候选。
3. **缓存仍无淘汰上限**：条目按会话数增长，解码后的文档（63 MB 的 JSON 解出来更大）会长驻内存。
   本笔没有改变这个形状（写穿不新增条目种类），但也**没有**变好 —— 同样具名立案。
4. **`findExisting()` 与 ad-hoc 实例不吃缓存**：`src/main/ipc.ts` 里三处 `new NotebookRunRepository(...)` 是每次
   新建的只读实例，各自没有缓存；它们是一次性读，本单元不声称覆盖。

## 6 提交

见 `git log --oneline -1 -- src/main/notebook/repository.ts`。
