# 重投影那一次抽取：26 ms 里没有一次是「查得慢」，是它把 1.2 MB 的溯源 JSON 也读回来了

2026-11-11。被测对象 `extractSessionFiles`（`src/main/project-files/mutation-projection.ts`），
它在 `sessions:save-session` 的投影段被调用——只要账本与文档的 `filesRevision` 对不上，
或者投影被别处改动（`projection-drift`），就走这条重建路径。

## 一 语料与量法

真实项目库**整份拷贝**到 `/tmp`（`purescience.db` 96 MB），只读打开；文档读的是产品自己的
`SessionRepository.loadSession`，抽取计时调的是**已交付的函数本体**（不是在探针里重写的等价物）。
全程没有写真实配置根与数据根（见 §五 那件事也一并记在这里）。

```
sessions/ 下 66 份文档全部可解析（66/66），最大的单份 3.1 MB
managedFile 496 行；最忙的会话 31 个文件行 / 31 条血缘
artifactVersion：这 6 条会话里每个血缘恰好 1 个已定稿版本（无 staging 混杂）
UploadVersion：**0 行** ⇒ 上传那一条分支在真实语料上量不到（见 §四）
```

## 二 先分辨「形状」和「载荷」

上一轮把 `isFileProjectionCurrent` 的慢读记成「按父取一的 N+1」，本轮把同一族读拆开量，
结论与那个说法不符：**嵌套 `take: 1` 本身不慢，慢的是它把整行都读回来。**

同一份语料、4 条最忙会话、每项 12–16 次（先热身一次把引擎启动排除在外）：

| 读法 | 会话 A（31 血缘） | 会话 B（29） | 会话 C（24） | 会话 D（22） |
| --- | --- | --- | --- | --- |
| 嵌套 `include` + `take:1`（整行） | 17.21 ms | 23.26 ms | 21.99 ms | 12.48 ms |
| 嵌套 `take:1` + **窄 `select`**（9 列） | **0.55** | **0.51** | **0.48** | **0.45** |
| 平查整行（`artifactId in …`） | 16.29 | 25.55 | 22.81 | 12.35 |
| 平查 + 窄 `select`（9 列） | 0.47 | 0.46 | 0.41 | 0.41 |
| 平查 + 只取 `id`/`artifactId` | 0.29 | 0.29 | 0.28 | 0.27 |

决定性的一格是**第二行**：形状完全没变（还是嵌套 `take: 1`），只把投影收窄，就从 17–23 ms
掉到 0.45–0.55 ms。所以：

- **不是 N+1。** 引擎并没有为每条血缘发一次子查询；`take: 1` 的嵌套与平查在同一投影下几乎同价
  （0.51 vs 0.46）。
- **是载荷。** `ArtifactVersion` 带 `evidenceJson`、`executionSnapshotJson` 这类大 TEXT 列：
  31 个版本的 `evidenceJson` 合计 **1,166,896 字节**（1.1 MB），29 个版本的会话合计 1.3 MB。
  `include` 会把它们全读回来并解码，这就是那 17–25 ms。
- 连带更正：上一轮代码注释与用例头注里「per-parent `take` 不能下推 ⇒ 每条血缘一次子查询」
  这个因果**是错的**，本轮就地改成「载荷」并附本表读数（改的是说明，不改行为）。

## 三 交付与读数（同一批会话，改前 / 改后）

`extractSessionFiles` 的两处读都从 `include` 改成**只取 Files 磁贴真正用到的列**：

| 分支 | 改前 | 改后 |
| --- | --- | --- |
| 血缘 → 最新已定稿版本 | `include: { versions: { take: 1 } }`（整行） | `select: { id, filename, versions: { take: 1, select: { id, checksum, messageId, filename, contentType, sizeBytes, createdAt, contentStorageKey } } }` |
| 上传 → 指定版本 | `include: { versions: { take: 1 } }`（整行） | 同上形态，取 `originalFilename`/`filename`/`checksum`/`contentStorageKey`/`contentType`/`sizeBytes`/`createdAt` |

同一语料、同一 6 条会话，**已交付函数本体**的 p50 / p90：

| 会话（文件行） | 改前 p50 | 改后 p50 | 改后 p90 | 产出文件数 | 错误数 |
| --- | --- | --- | --- | --- | --- |
| A（31） | 16.82 ms | **0.67 ms** | 0.89 | 31 | 0 |
| B（29） | 25.99 ms | **0.57 ms** | 0.62 | 29 | 0 |
| C（24） | 22.68 ms | **0.51 ms** | 0.58 | 24 | 0 |
| D（22） | 12.75 ms | **0.49 ms** | 0.53 | 22 | 0 |
| E（19） | 6.35 ms | **0.45 ms** | 0.52 | 19 | 0 |
| F（18） | 1.90 ms | **0.51 ms** | 0.56 | 18 | 0 |

产出**逐条相同**：改前改后每条会话的文件数与错误数一致（31/29/24/22/19/18，错误全 0），
`errors` 也都为空 —— 收窄只改「读哪些列」，不改判定、不改排序、不改去重。

## 四 边界（不许读成更强）

1. **不是装机读数。** 这是主进程一侧的库内成本（真实库拷贝、单连接、无并发）。装机后的效果只能从
   慢行 `fileIndexMs` 看：真实机器上该段 p50 127 ms / p90 418 ms，本轮这一笔在库内省掉的是
   **16–26 ms**（约 13%–20%），其余仍是与产品内其他工作争同一条连接（`connection_limit=1`）的等待。
   判据：下一版之后同一份日志里 `fileIndexMs` 的 p50/p90 各降十几毫秒。
2. **上传分支没有真实读数。** 真实库里 `UploadVersion` 是 0 行 ⇒ 那条分支的收窄**只经过单测**
   （形状钉住 + 字段映射断言），没有语料读数。它今天不构成热点，改它是为了不让同一族写法在
   有上传的机器上重新长回来。
3. **没有动「什么时候重投影」。** 本轮只降低重投影一次的成本，`fileIndexPath=reprojected` 的
   比例仍未测（要等装机后的那版日志）。若该比例很高，下一个杠杆是「只对变化的来源重抽取」，
   与本笔不重叠。
4. 复跑配方：把 `purescience.db` 拷到 `/tmp/<名>/`，`createProjectDbClient(<名>)` 打开；
   文档用 `SessionRepository` 读（**在非 electron 进程里必须 `vi.mock('electron')`，见 §五**），
   用请求参数代理记录 `findMany`/`findFirst` 的实参形状。

## 五 一件事必须记下来：读路径会搬走用户的文档

本轮第一次写探针时直接用了 `SessionRepository.loadSession`，但**没有**给 vitest 一个
`electron` 替身。`readSessionFile` 把 `decodeSessionDataPaths` 放在同一个 `try` 里，
而它在没有 `app` 的进程里抛 `Cannot read properties of undefined (reading 'isPackaged')`，
于是 `catch` 分支把文档当成「内容损坏」**改名隔离**——21:22:16 与 21:22:38 两次探针
把 **66 份真实会话文档全部**变成 `<id>.json.invalid-<ts>-<n>`。

- 处置：**当场按名字还原 66 份**（`os.rename` 回 `<id>.json`），复核「主文档 66 份、隔离件 0 份」，
  之后所有探针都先做两件事：`vi.mock('electron')` + 用纯函数 `normalizeSessionFile` **预校验**，
  只让能解析的文档进入 `loadSession`。本轮其余读数全部产生在还原之后。
- 这不是探针独有的形状：`try` 里同时装着「解析内容」与「解码路径」，
  任何**与环境有关**的异常（`app` 未就绪、`pathToFileURL` 收到坏字节、解码器自己的 bug）
  都会被读成「这份文档坏了」，然后把用户的文件搬走。装机版里 `app` 通常就绪，所以它没露过面；
  但一旦露面，代价是**整库会话从界面上消失**。
- 收口：把「隔离」的判据收紧成**只有内容自证不合格才隔离**（JSON 解析失败、或纯函数
  `normalizeSessionFile` 判定无效）；解码/归一化**抛错**一律报 `unreadable` 且**不动文件**，
  见同批提交与 `repository-decode-failure.test.ts`。

## 六 门禁

| 环 | 读数 |
| --- | --- |
| `src/main/project-files` | **8 files / 80 passed**，exit 0（新增 3 例：血缘读的形状、窄读后字段仍齐全、上传读的形状） |
| 双 typecheck（`--composite false`，node 侧 `NODE_OPTIONS=…8192`） | node 0；web 0 |
| `eslint --no-cache`（改动文件） | 0 error / 0 warning |
| 变异自证 | 往 `versions.select` 里加回 `evidenceJson: true` ⇒ `asks for the Files tile columns…` 当场红（1 failed / 5 passed），**已还原并复跑绿** |
