# 慢通道归因（2026-10-28）：先测后改，三条通道各有各的病因

数据窗口：近 7 天 `~/Library/Logs/PureScience/main.log`（error/warn 共 214 条，慢 IPC 141 条占 66%）。
方法是先读**已有的分阶段字段**，再决定改什么；三条通道都已有归因字段，不需要新增埋点。

## 一 `notebook:state`（42 条慢 IPC；12 条专用慢读样本）— 已修，`c03d3f9a`

| 字段                    | 读数                                                 |
| ----------------------- | ---------------------------------------------------- |
| `totalMs ≈ loadMs`      | 207 / 248 / 259 / 272 / 286 / 292 / 352 / **902** ms |
| `ensureMs`、`projectMs` | 噪声                                                 |
| `cold`                  | 全为 **0**（不是建会话慢）                           |
| `cpuShare`              | 30%–50%（一半时间不在算，在等 I/O）                  |

真机证据：`~/.purescience/notebooks` 下 174 个 `run.json`，最大的 **60.1 MB**，其后 15.9 / 13.7 / 12.7 / 12.3 MB。
`loadMs` 就是 `loadOrCreate()` 的 `readFile + JSON.parse` 整份文档。

改法与实测（同一份 60.1 MB / 80 runs 的真实文件）：

| 版本                              | 冷启     | 热 p50                        |
| --------------------------------- | -------- | ----------------------------- |
| 改前                              | 222.7 ms | 358.2 ms                      |
| 中间态（加 `structuredClone`）    | 191.8 ms | 127.6 ms ← 深拷贝自身 ≈100 ms |
| 改后（mtime+size 缓存，不深拷贝） | 165.1 ms | **1.6 ms**                    |

不深拷贝的依据是两条事实：`loadOrCreate` 的调用点只有 `session-lifecycle`、`session-read-model` 两处且都只读；
所有写路径走 `loadExisting()`，每次重新读盘。两条用例守护缓存不能撒谎（外部重写可见、自身写后读回新值）。

## 二 `settings:list-skills`（4 条慢 IPC）— 只做结构性改进，未达标

日志中位 662 ms，但**进程内复现不出来**：完整 `listSkills()` 冷启 50.8 ms、热 11.0 ms（67 个技能、真实目录）。
已做：并行化 + mtime/size 缓存（热 11.0 → 8.1 ms）、写路径显式失效、以及总耗时 >150 ms 时输出
`skill list attribution { totalMs, registryMs, userMs, settingsMs, skills }`。

**没有宣布达标**：基线拿不到，就不该用「改了多少」冒充「达标多少」。

## 三 `sessions:save-session`（28 条慢 IPC；32 条专用慢存样本）— 已归因，未改

`saveSession` 自带五段归因（队列/物化/序列化/磁盘/rename），样本读出**两种不同的慢**：

| 模式         | 典型读数                                                                              | 含义                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **写后捕获** | `writeMs` **3 ms**，但 `provenanceMs` **394–403 ms**、`aftermathMs` 399–416           | 慢在 `captureFinalizedMessages()`：先 `materializeSessionConversationGraph()`，再查一次 Prisma 的 `artifactVersion`（`messageSnapshotId: null`） |
| **写本身**   | `writeMs` 91–238 ms，其中 `writeDiskMs` 达 **211 ms**、`writeReplaceMs` 达 **176 ms** | 真的在写盘与 rename（60 MB 级文档）                                                                                                              |
| **权限检查** | `authorityMs` 达 **308 ms**                                                           | 项目删除权威检查                                                                                                                                 |
| **准备阶段** | `prepareMs` 达 **206 ms**                                                             | 上传升级/绑定校验                                                                                                                                |

关键观察：模式一的 `cpuShare` 是 **0**（CPU 35/33 ms，其余在等），说明那 400 ms 主要不是算，是**等数据库**；
而 `provenanceMs` 192 ms 的样本 `cpuShare` 是 1（CPU 167 ms），说明有时又是图物化在烧 CPU。

### 建议改法（下一项工作，未实施）

1. **空转就别查**：自动保存很频繁，但「有未捕获的 finalized artifact 版本」是少数。为此在
   `captureFinalizedMessages` 前算一个**廉价指纹**（finalized 消息数与末条消息 id + 会话内 artifact 版本计数），
   与上次成功捕获的指纹相同则整段跳过。**先量一次**：若指纹本身要遍历所有消息，就不值得，改为在写入侧记录
   「本轮是否新增了 finalized 版本」的标志位。
2. **写盘侧**：`writeReplaceMs` 176 ms 说明 rename 也在付 60 MB 的代价；可先写增量（新 run 追加）再周期性全量重写。
3. 不做「加大超时」「后台线程糊过去」这类掩盖：本条要先拿到指纹成本读数再动手。

## 四 方法教训（三条，写给自己）

1. **先读已有字段，再决定埋点**：三条通道本来就都有分阶段字段，第一反应若是「加埋点」会白加一轮。
2. **日志中位数不等于进程内耗时**：`settings:list-skills` 的 662 ms 在进程内是 50/11 ms，直接照日志调参会优化噪声。
3. **真实文件才是基线**：合成的 133 KB `run.json` 只需 1 ms，真机 60 MB 才是 358 ms 的来源；bench 必须指向真文件。

## 五 `sessions:save-session` 的写盘一半：已到 I/O 下限，剩下的读数是争用

补测（同一台机器、同卷）：

| 量                                 | 读数                                                |
| ---------------------------------- | --------------------------------------------------- |
| 写 5.5 MB（临时目录）              | `write_p50` **9.5 ms**                              |
| 写 5.5 MB（`~/.purescience` 同卷） | `write_p50` **10.7 ms**                             |
| `rename` 到最终名                  | **0.2–0.3 ms**                                      |
| `JSON.stringify(session, null, 2)` | **17.3 ms**（紧凑 13.1 ms，文件 5.44 MB → 5.01 MB） |
| `structuredClone(session)`         | 6.2 ms                                              |
| **一条保存的理论下限**             | **≈ 28 ms**                                         |

真机慢存样本里 `writeDiskMs` 150–211 ms、`writeReplaceMs` 116–176 ms，是下限的 5–7 倍，而
`attribution` 多为 `inconclusive`、`cpuShare` 0–1 —— 即**不是我们的算法**，是同一时刻的 I/O/事件循环争用。

因此这一步**不做**：把 `JSON.stringify` 改成紧凑格式只能省 ~4 ms 与 8% 体积，却要改变磁盘格式（多处解析与
用例依赖现有形状），性价比为负。真正的杠杆在上一节那次 400 ms 查询，已经修掉。

bench 落档：`scripts/bench/session-file-write.bench.test.ts`（写/rename 下限）、
`scripts/bench/session-serialize.bench.test.ts`（序列化与拷贝成本）。
