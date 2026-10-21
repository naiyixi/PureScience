# 第一次开库不是那 7.7 秒 —— 分步账把 573–7,672 ms 从收件箱头上挪走

日期：2026-10-22（执行器）
提交：见本文件所在批次（`perf(startup): 把第一次开库单独计时，并把剩下的 await 补进同一张账`）
上一轮读数：`docs/evidence/` 无（本档是这条线的第一份；埋点本身由 `46d10584` 交付）

## 一 起点：一条账，四个数，谁都解释不了（真实启动日志）

`logs/headless.out.log`（用户自己的数据根，dev 实例的真实启动）里同一份代码的六次启动：

| 启动 | `compose runtime steps` 的 `totalMs` | 其中 `restore-notification-inbox` | 到 `install-lifecycle` 完成的 `durationMs` |
|---|---|---|---|
| ① | 713 | **573** | — |
| ② | 983 | **844** | 5,701 |
| ③ | 1,860 | **1,724** | — |
| ④ | 3,184 | **2,892** | 11,532 |
| ⑤ | 7,834 | **7,672** | **26,960** |

同一份代码、同一个数据根，同一段工作从 573 ms 走到 7,672 ms。埋点只记了 4 步，而整窗最长 26,960 ms
⇒ **19 秒没有任何归因**，而这 19 秒过去只能靠猜。

最差那次（⑤）的同一个窗口里，诊断线自己写着进程在挨饿：

```
[diagnostics] event loop stalled {
  rssMb: 98, heapUsedMb: 98, freeMemMb: 163, totalMemMb: 8590,
  loadAvg1m: 28.33, windowMs: 1443, lateMs: 943, cpuMs: 434, cpuShare: 0.301,
  attribution: 'cpu-bound-in-process'
}
```

## 二 用产品自己的客户端量「开库这一段」到底多贵

`restore-notification-inbox` 那一步当时**同时**包含两件事：`getProjectDbClient()`（建目录 + 起查询引擎 +
重放 schema 守卫）与收件箱自己的两条查询 —— 一个合并数字，机器慢与代码慢长得一模一样。

于是把库**复制**到 `/tmp` 再量（真实库只读，副本 87,851,008 字节；`Project` 56 行、`NotificationInboxItem`
86 行、`UnreadTaskSession` **0 行**），用的是产品自己的 `node_modules/.prisma/client`：

| 段 | 五次数值（ms） |
|---|---|
| 构造客户端 | 2.0 / 2.2 / 2.8 / 3.6 / 4.6 |
| 首次查询（起引擎 + 连接 + schema 守卫） | 17.5 / 32.4 / 45.8 / 56.2 / 80.5 |
| 66 条 `CREATE TABLE/INDEX IF NOT EXISTS` 重放 | 34.4 / 65.1 / 107.3 / 29.0 / 117.4 |
| 30 次列探测（`addColumnIfMissing` 那类） | 8.1 / 10.1 / 28.7 / 36.3 / 125.9 |
| 收件箱查询 | **0.2 / 0.3 / 0.4 / 0.8 / 0.1** |
| 合计 | **95.8 / 98.6 / 121.4 / 214.9 / 281.4** |

裸 sqlite3 交叉核对同一量级（`measure.py`）：`sqlite_master` 首读 1.6 ms、66 条 DDL **8.8 ms**、70 次
`PRAGMA table_info` 0.7 ms、legacy `findMany` 0.02 ms、裁剪扫描 0.03 ms、重开连接后重放 4.9 ms。

## 三 结论（本档只下这一句判断）

- **573–7,672 ms 不是收件箱的账**：它的两条查询在**每一次**读数里都 ≤ 0.8 ms，且 legacy 表 0 行。
- **也不是 schema 重放的账**：66 条 DDL 拆开量 8.8–117 ms，包含起引擎在内的整段是 96–281 ms。
- 剩下的成本落在 **Electron 主进程里「第一次开库」这一段上下文**（引擎子进程冷起、文件系统冷、CPU 饥饿），
  ⑤ 那次 `event loop stalled … loadAvg1m 28.33 / freeMemMb 163` 与之一致；而探针是在**同样恶劣**的内存条件下
  跑的（本轮实测空闲页 3,841 ≈ 63 MB、swap 已用 11.6 G / 12.0 G）仍然 96–281 ms ⇒ 「机器慢」解释不了全部差额。

**因此本单元不优化通知收件箱**（那会是照着一个假归因改代码），改为：把这段的账**拆开**，让下一次真实启动
自己说清是谁 —— 那才是能继续查下去的形状。

## 四 本笔改动

| 位置 | 改动 |
|---|---|
| `src/main/ipc.ts` | 新增独立步 `open-project-db`（`getProjectDbClient` 自己就做建目录 + 起引擎 + schema 守卫），`restore-notification-inbox` 从此**只量收件箱自己**；并把 compose 里剩下会慢的 await 补进同一张账（`application-events`、`permission-grant-registry`、`notebook-application`、`specialist-skill-catalog`、`specialist-package-snapshot`、`builtin-catalog-ready`）⇒ 记账从 4 步到 **11 步** |
| `src/main/ipc-startup-attribution.test.ts` | 新增 pin：读真实源码，断言 11 个步名的**有序清单**、`open-project-db` 必须排在 `restore-notification-inbox` **之前**、每个 `step(` 都必须 `await`（未被 await 的步会记 0 ms 且什么也没围住）、`createComposeStepRecorder(` 恰好一次、`logSummary()` 恰好一次，外加「源码长度 > 100k」的自检（截断的读法会让上面每一条空过） |

## 五 边界（不许把本档读成更强的东西）

1. **探针不是 Electron 主进程**：未打包 Node + 库副本 ⇒ 它量的是「这段 SQL/引擎工作本身多贵」，不是那次启动的现场。
   所以本档**不声称**找到了 26,960 ms 的全部归属，只声称**排除了两个候选**。
2. **96–281 ms 的离散本身就是机器负载的指纹**（同一份代码、同一份库、五次读数差 3 倍）。
3. **本轮没有取到真机窗口读数**（内存闸门：空闲页 3,841 ≈ 63 MB、swap 11.6 G / 12.0 G 已用）⇒ 不声称
   「启动变快了」，也不声称新增的 7 步在真机上有读数（要等下一次真实启动才有的，是**未取**，不是 0）。
4. **若开库在本步之前已被别处打开**，本步会读到缓存的 promise（≈0 ms），成本归给先打开的那一处 —— 这是
   **可见的**而非静默的：pin 测试钉死步名与顺序，日志里那一步自己会出现在 0 ms 的位置上。
5. 上表的 ①②③④⑤ 是**同一份代码**的历史启动记录，不是本笔的启动记录（本笔的 11 步账一次真机读数都还没有）。

## 六 复跑配方

```bash
# 1) 库副本（真实库只读）
mkdir -p /tmp/ps-inbox-probe && cp ~/.purescience-project/purescience.db /tmp/ps-inbox-probe/p.db
sqlite3 /tmp/ps-inbox-probe/p.db "select count(*) from Project; select count(*) from NotificationInboxItem; select count(*) from UnreadTaskSession;"

# 2) 产品自己的客户端量「构造 → 首次查询 → 66 条 DDL → 30 次列探测 → 收件箱查询」
#    脚本：/tmp/ps-inbox-probe/prisma-open.cjs（每次先 copyFileSync 一份新的副本，避免复用上一轮的 WAL）
node /tmp/ps-inbox-probe/prisma-open.cjs

# 3) 裸 sqlite3 交叉核对（DDL 与 PRAGMA 的同量级读数）
python3 /tmp/ps-inbox-probe/measure.py

# 4) 真实启动里的分步账
grep -A5 "compose runtime steps" logs/headless.out.log | tail -20
```

两条仪器坑（本轮各咬一次，别再犯）：① 复用同一份输出/同一份库副本会把**上一轮的 WAL**算进本轮读数 ⇒ 每轮先
`copyFileSync` 一份新副本；② 读数的**量级**先与 `loadAvg1m` 一起看 —— 同一段代码在同一天从 95.8 走到 281.4 ms
是机器的事，不是代码的事。

## 七 变异证明：这条 pin 真的会咬人（不只是「现在是绿的」）

pin 的价值在于「把面改小/改松时它会红」。用隔离工作树（`git worktree add --detach /tmp/ps-mut-03d2d3c8 03d2d3c8` +
软链 `node_modules`）逐条施加变异，再跑同一支 pin：

| 变异 | 结果 | 变红的断言 |
|---|---|---|
| M0 未变异（基线） | **5 passed** | — |
| M1 把一个 `await composeSteps.step(` 改成 `void composeSteps.step(` | **1 failed / 4 passed** | `awaits every timed step` |
| M2 把 `specialist-package-snapshot` 改名成 `specialist-packages` | **1 failed / 4 passed** | `times exactly the inventory … in composition order` |
| M3 把 `open-project-db` 挪到 `restore-notification-inbox` **之后**（合并数字的那一版） | **2 failed / 3 passed** | 有序清单 + `measures the first database touch as its own step …` |

三次变异各自只打断它该打断的那一条（M3 打断两条，正是因为它同时改了清单顺序与先后关系），
工作树随即 `git worktree remove --force` 删除，主树 `git status --short` 为空。
**边界**：这证明的是「断言没有退化」，不是「11 步在真机上都录到了」——后者仍属未取。
