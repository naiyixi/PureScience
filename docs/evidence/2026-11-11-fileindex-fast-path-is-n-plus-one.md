# 保存快路径里那次「投影是否最新」的读是 N+1：31 条血缘 ⇒ 31 次子查询，16 ms；平查后 0.63 ms

2026-11-11。被测对象 `isFileProjectionCurrent`（`src/main/project-files/mutation-projection.ts`），
它在每次 `sessions:save-session` 的投影段被调用一次——只要文档的 `filesRevision` 与会话账本一致。

## 一 量法与语料

真实项目库**只读**，整份拷贝到 `/tmp` 后在上面跑（写只落临时目录，结束删除）：

```
managedFile 496 行 / artifactLineage 477 行 / artifactVersion 517 行 / managedFileSessionSync 168 行
最忙的一条会话：31 个项目文件行、31 条血缘
```

三条读各自计时（每项 200 次，先跑一次热身把 Prisma 引擎启动排除在外）：

| 读 | p50 | p90 | max |
| --- | --- | --- | --- |
| `managedFileSessionSync.findUnique`（账本） | 0.13 ms | 0.15 ms | 0.60 ms |
| `artifactLineage.findMany`（裸查，只要 id） | 0.24 ms | 0.25 ms | 2.17 ms |
| `artifactLineage.findMany` + 嵌套 `versions{take:1}` | **15.88 ms** | 16.50 ms | 28.98 ms |
| `managedFile.findMany`（五行投影） | 0.21 ms | 0.22 ms | 1.21 ms |

**嵌套那一项是唯一的异常**：裸查 0.24 ms，加上「每个血缘取最新一条已定稿版本」就变成 15.9 ms。
它与血缘条数成正比——另一个 22 条血缘的会话单次 12.9 ms（≈0.58 ms/条），31 条 = 15.9 ms；
也就是说 `take: 1` 的按父取一在这里落成了**每条血缘一次子查询**，不是一次 `IN` 查询。
（空表对照：同一引擎上一条无命中查询 0.11 ms ⇒ 15.9 ms 不是引擎固有开销。）

## 二 交付

`isFileProjectionCurrent` 改成两条平查询：先取该会话的血缘 id，再一次性取这些血缘的**全部已定稿版本**
（`artifactId in (…)`，按 `versionNumber` 降序、`id` 降序），在 JS 里按 `artifactId` 取第一条。
「最新」的定义与原来逐字相同（同一排序、同一 `take: 1` 语义）。

同一份语料上，改后走**已交付的函数本体**（不是我在探针里重写的等价物）：

| 形态 | p50 | p90 | max |
| --- | --- | --- | --- |
| 交付前（嵌套 `take:1`） | 16.52 ms | 17.94 ms | 48.65 ms |
| **交付后**（`isFileProjectionCurrent` 本体） | **0.63 ms** | 0.68 ms | 1.12 ms |

判决一致：同一个会话两种写法都答 `true`；探针另外逐条比对过两种写法产出的 `lineageId → 最新版本 id`
映射，`same-result=true`（31/31）。

## 三 门禁与自证

| 环 | 读数 |
| --- | --- |
| `src/main/project-files` + `src/main/session-persistence` | **21 files / 351 passed**，exit 0 |
| 双 typecheck（`--composite false`，node 侧 `NODE_OPTIONS=…8192`） | node 0；web 0 |
| `eslint --no-cache`（改动文件） | 0 error / 0 warning |
| 变异自证 | 把「按血缘取第一条」改成「最后一条覆盖」（即取最旧版本）⇒ `repository.test.ts` 的 `projects the latest finalized Artifact Version instead of a stale Session descriptor` **当场红**（1 failed / 38 passed）。**已还原并复跑绿** |

新增 `mutation-projection.test.ts` 三条：① 一个会话多条血缘时**只有一次**版本读（形状钉住，防止有人
改回按父取一），且最新版本按 `versionNumber` 再按 `id` 取、更晚的 `staging` 行不得胜出；② 行指向旧版本 ⇒ 判陈旧；
③ 血缘没有已定稿版本而行声称有 ⇒ 判陈旧。

## 四 边界（不许读成更强）

1. **不是装机读数**。这是主进程侧一处读的**库内成本**（真实库拷贝、单连接、无并发的理想条件）。
   装机后的效果只体现在慢行 `fileIndexMs` 上：真实机器上这一段 p50 127 ms / p90 418 ms，
   其中**这一读**原本占约 16 ms（≈13%），其余是与产品内其他工作争同一条连接（`connection_limit=1`）的等待。
   判据：下一次发版后同一份日志里 `fileIndexMs` 的 p50/p90 应各降十几毫秒，且
   `fileIndexPath`/`fileIndexPathReason` 能说出走的是哪条路。
2. **没有改判定语义**。`isFileProjectionCurrent` 的三条否定条件（投影计数/版本号不符、旧式上传归属跨会话、
   原生上传归属跨会话）一条未动；改的只是「最新版本」从哪里读。
3. **`fileIndexMs` 的大部分仍不是这次读**。127 ms 里还剩 ~110 ms 是等待与重投影，
   下一处要看的是同一段里 `syncSession` 重建路径的占比（`fileIndexPath=reprojected` 的比例）。
4. 复跑配方：把 `~/.purescience-project/purescience.db` 拷到 `/tmp/<名>/`，用 `createProjectDbClient(<名>)`
   打开，按 `managedFile.groupBy` 取最忙会话，分别计时交付函数与嵌套 `include` 形态各 200 次。
   探针文件**不入库**，跑完即删。
