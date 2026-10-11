# P0-10：内容存储的按需回收 + 「版本解析慢」的归因（执行器，2026-10-11）

> 本档只记**本轮自己取到的读数**。取不到的一律写「未取」并说明原因，不写 0、不编。

## 〇 一句话结论

计划里 P0-10 的两条修法，**一条被只读取证否掉**（「版本解析走索引」——慢的不是这条代码路径的成本，是主进程争用），**另一条交付了前半**（存储面板的「一键清理」＝按需回收重复内容）。
跨类目的重复被**刻意留着不链**：存储读数按类目各自去重，跨类目成链省下的字节面板不会记账（原因与后果见 §三.1）。

## 一 开工核对

- 起点 `HEAD == origin/main == 46d10584`（本地另有会话落的 `20d9c0ef` 未推送）；工作区里那 **84 份** `docs/evidence/*.md` 是**别人的**表格重排，本轮一位未碰、未暂存。
- 内存：空闲物理页 **13,908（约 217 MB）** / swap 已用 **5,400 M of 6,144 M** ⇒ **未起 Electron**（本单元也确实不需要窗口读数）。

## 二 只读取证：两条都推翻了计划写时的前提

### 2.1「版本解析走索引」不成立：慢的不是这条路径的成本

采样口径：本机打包版日志 `~/Library/Logs/PureScience/main.log` + `main.1.log` + `main.2.log`
（三份轮转，5.2 MB / 5.2 MB / 3.4 MB，最新 2026-10-10 21:56），grep `artifact version resolve was slow`
共 **273 条**（87 / 175 / 11）。逐条把埋点字段摊开：

| 字段 | 条数 | 中位 | 最大 |
| --- | --- | --- | --- |
| `queryMs`（解析那条主键查询） | 273 | **78 ms** | 1,172 ms |
| `readMs`（读内容） | 273 | **31 ms** | 3,062 ms |
| `clientMs`（调用方） | 273 | **0 ms** | 145 ms（合计 1,358 ms） |
| `bytes`（读到的内容大小） | 273 | 22,255 B | 746,842 B（**≥1 MB 的 0 条**） |
| `queryEventLoopMaxMs` | 273 | 0 | 140 ms |
| `readEventLoopMaxMs` | 273 | 0 | 2,317 ms |

- **主导段**（按每条最大的那一段计）：`queryMs` 208 条 / `readMs` 65 条 / `clientMs` 0 条。
- **事件循环占比**：Σ`readEventLoopMaxMs` 16,430 / Σ`readMs` 33,173 = **49.5%**；
  Σ`queryEventLoopMaxMs` 1,818 / Σ`queryMs` 41,377 = **4.4%**。逐条比值的中位数两侧都是 0.0 ——
  阻塞**集中在慢的尾巴上**，不是每次都阻塞。
- **隔离实测**（同一台机、上一轮同一批）：把真实的 **117 MB** 库复制到 `/tmp` 隔离根、用真 Prisma 客户端
  量四种查询形状（现状 `findFirst + include artifact`、同 where 只取四列、纯主键、单独量 `include` 的反序列化）
  **全部中位 ≤1 ms**；`sha256` 一个真 **564 KB** 内容文件 **1 ms**。

结论：**毫秒级的读与摘要，配上占比近半的事件循环阻塞 ⇒ 慢的成因是「主进程那一刻被别的工作占住」，不是这条代码路径的成本。**
按「先量再改、量不中就撤」，**没有动版本解析代码**；计划的这一半改成**具名立案**（要治得先有「主进程当时在做什么」的分步归因，
与 P0-3 同一族，读数见 `docs/evidence/2026-10-11-...` 附件与本档 §五）。

### 2.2 内容存储维护的真实形态

- 启动读数（用户真机打包版）：`content storage` **uniqueBytes 14.28 GB / totalBytes 18.07 GB / files 290,495 / linkedFiles 241,573**。
- `pruneUnreferencedContent` 在这台机上恒为 0 的原因不是「没问题」：**全机不存在 `.content` 目录**，那条回收路径没有输入。
- 真正在干活的是同族的 `sweepDuplicateContent`（启动维护）：真机 **scanned 874 / linked 4 / bytes 742,655**，
  幂等 —— 第二遍就没有可做的事。
- 顺带查出两处**未接线**（本单元只改第二条）：
  1. **`installContent`（写时去重）全树没有生产调用方** ⇒ 具名立案，不在本单元范围。
  2. **启动维护用的根 ≠ 面板读数用的根**：启动维护用配置根 `resolveStorageRoot()`，而面板总量与类别用数据根
     `resolveDataRoot()`；迁移过的装机上两者不同 ⇒ 自动维护会扫错目录。**本单元已改成数据根。**

## 三 交付（P0-10 前半：按需回收）

| 面 | 内容 |
| --- | --- |
| 共享类型 | `DuplicateSweepResult` / `DuplicateSweepOutcome`：回收字节、链接数、扫描数、已共享数、不可读数、未链成数、耗时；注释写明「与面板读数同一根、同一批字节」 |
| 主进程 owner | `sweepDuplicateContent()`：扫**数据根**（与面板总量同一根）、**同一时刻只允许一次**（第二次点击并入在跑的那次）、**成功且真有字节移动**时才 `usageCache.clear()`、失败按 `{ok:false,error}` 作答而不是裸拒、成败都落日志 |
| 通道 | `storage:sweep-duplicate-content`（LOCAL、**无参数** ⇒ 渲染端点不了目标），契约目录 + 前载 + 应用命令 + 生成物一并改齐 |
| 面板 | 按钮（盘面读数之下、与它要改的那个数字同屏）+ 确认对话框 + 「检查中」态 + 结果行（**回收 N 字节 / 无可回收 / 未能回收**）+ 真有字节移动时重读读数 |
| 文案 | 9 个键 × 9 语种（`zh ≠ en`、`zh-Hant` 全繁体，用技能自带 `scripts/add-i18n-keys.py` 批量插入，脚本自带九文件齐平预检） |
| 归位 | 启动维护的根由配置根改为数据根（与面板一致） |

### 3.1 为什么回收**只在同一个类目内**成组

存储读数 `computeStorageUsage` 给**每个类目各自的去重集**（源码注释写明假设：「硬链接不跨数据类目」）。
回收若把 `uploads/` 里的名字链到 `artifacts/` 里的同内容文件，省下的是**面板总量不会记账**的字节：
用户点完看到「回收 4 MB」，而它上面那个总量几乎不动 —— 那个数字就成了一句屏上无法核实的承诺。
所以成组键是「**类目 + 大小**」；代价是跨类目的重复留着（具名记档，见 §六.1）。

探针读数正是这件事的两面：同内容**跨类目**的 `artifacts/a-1.bin` nlink 仍为 **1**，
而类目**内**的 `uploads/u-2.bin` / `artifacts/art-2.bin` nlink = **2**。

## 四 真机／过程读数（本单元能取到的那一条，且不冒充窗口读数）

一次性探针（跑完即删）：真内容树（2 MB 重复对、1.5 MB 重复对、64 KB 同大小不同内容对、0 B 重复对、跨类目同内容一份）
→ 生产 walker → **应用自己的读数**前后各一次 → `du -sk` 从外部对照 → 链接计数与逐字节回读。

| 读数 | 值 |
| --- | --- |
| `du -sk`（前 → 后） | 11,392 KB → 7,808 KB（**Δ 3,584 KB**） |
| 面板读数 `totalBytes`（前 → 后） | 11,665,408 → 7,995,392 |
| 面板读数 `sharedBytes`（前 → 后） | 0 → 3,670,016 |
| `sweep` | scanned **8** / linked **3** / bytes **3,670,016** / distinct 5 / alreadyShared 0 / unreadable 0 / unlinked 0 |
| **三个相等** | `totalDelta` = `sharedDelta` = `sweep.bytes` = `duΔ × 1024` = **3,670,016** |
| 负向对照 | 同大小不同内容 `artifacts/unique.bin` nlink = 1；跨类目重复 `artifacts/a-1.bin` nlink = 1 |
| 内容回读 | 被替换的 `uploads/u-2.bin`、`artifacts/art-2.bin`、未动的 `artifacts/a-1.bin` 逐字节等于原内容（三处 true） |
| 0 字节重复 | `uploads/empty-u2.bin` nlink = 2（**链了但不移动字节** ⇒ 判据用字节而不是链接数，见 §六.3） |

**本单元没有 Electron 窗口读数**，也不假装有：探针跑的是主进程的真实模块 + 真实文件系统 + 应用自己的读数函数；
界面那一半的证据是渲染套件（点开确认 → 调用 → 结果行 → 重读），不是窗口。

## 五 门禁与验证读数

全部在**我自己的最后一个改动之后**跑（口径：CI 同版），逐环取各自的汇总行：

| 环 | 读数 |
| --- | --- |
| 定向单测（storage / host-application-commands / application-command-composition / 契约目录 / 面清单 / preload / StoragePanel 渲染 / i18n 质量门） | **Test Files 22 passed (22)** / **Tests 447 passed (447)**，`VITEST_EXIT=0` |
| `eslint --no-cache .`（全仓，CI 同口径） | **exit 0**，`0 errors / 122 warnings`（前几轮基线 140 —— 差额来自 prettier 把 i18n 里**既有的**超长行折行，**不是本单元修掉的告警**） |
| 双 `tsc`（`typecheck:node` / `typecheck:web`，均 `--composite false`） | **exit 0 / exit 0**，两份日志各只含 npm 横幅（94 / 92 字节，零诊断） |
| `bash scripts/pre-push-checks.sh` | **exit 0**（`[pre-push] 全部通过。`，五查逐条 ✓） |

**Windows 车道抓到一处我漏跑的 pin**（`3f1fa7e1` 的 `Windows full test (8/8)`：`expected …396… to have a length of 396
but got 397`；已就地修，`cd865873`）：本仓的**本地 Web 可调用面**在 `src/renderer/web/renderer-argument-shape-characterization.test.ts`
里还另有一份自己的计数。我第一轮只跑了 `src/main` 与 `src/shared` 那几族 ⇒ 本机全绿、只有跑全量的车道才现形。
已按「只改计数、不改判据」修（396→397 + 一行说明它与 runtime 环境通道同型），并把 `src/renderer/web` 与
`src/main/web-service` 并入本单元的补跑集合（**227 passed | 1 skipped (228)** / **3056 passed | 3 skipped (3059)**）。
同一 run 里那几条 `##[error] mac update feed …` **不是失败**：它们出自 `scripts/merge-mac-feed.test.ts` 自己的负向用例输出
（该文件 `✓ 21 tests`），该作业唯一的失败断言就是上面这条。

**契约 pin 的连锁**（加一个通道要改的五处，全部改动后为 85/85/57）：契约目录 `toHaveLength(85)`、
`dispatcher.commandNames()` `toHaveLength(85)`、本地专有清单 `toHaveLength(57)`、应用命令组合器的
`INTERNAL_COMMAND_COUNT 360→361` / `LOCAL_WEB_COMMAND_COUNT 358→359` / `REMOTE_REJECTED_COMMAND_COUNT 125→126`
（LOCAL 通道 ⇒ 内部 +1、本地 Web 面 +1、远端 fail-closed 集 +1），以及面清单与 preload 面各 +1。
`delegates every canonical argument tuple` 那条用例断言**每个 owner 桩恰好被调用一次** ⇒ 新方法必须在调用侧
补一次 `invocation([])` 并补一条 `toHaveBeenCalledWith()`（无参数：根由主进程解析，调用方点不了目标）。

## 六 刻意的边界（不许读成「已做」）

1. **跨类目的重复不回收**（原因见 §3.1）。要回收得先让读数**全局去重**（那是读数语义的改动，动它要连 runtime 分解一起看），具名立案。
2. **`installContent`（写时去重）没有生产调用方** —— 具名立案，本轮未动。
3. **0 字节的重复会链接但不移动字节**：面板总量不变、`sharedFiles` 会 +1（那一行只在字节 > 0 时显示）。
   所以「是否重读数」的判据是**字节**不是链接数；探针里 `empty-u2` 就是这条边界。
4. **版本解析没有优化**（§2.1 的读数），计划里「走索引」那半句已就地更正为立案口径。
5. **面板文案不承诺「总量会掉 N」**：只说「已回收 N（M 个重复副本）」；那 N 与总览的可互核性由 §3.1 的规则保证（§四 的三个相等即其读数）。
6. **与并发写入者的 P0-10 口径不冲突、也不重复**（它本轮把 `measureRuntimeFootprint` 作为「并行第二套」自行 revert，`f816a299`）：
   **读数通道**（`src/main/storage/usage.ts:139` 的 `computeStorageUsage`）与**环境移除**（`manage_environments` 的 `remove` 动作）
   本来就存在 ⇒ 它们**不是**本单元的缺口，本单元也不新建第二套。本单元加的是**动作**那一层（用户可达的按需回收）
   与**根的一致性修正**（启动维护原本扫配置根、面板量的是数据根）。它列出的三个剩余候选
   （`runtime/pkgs` 包缓存回收、`removeEnvironment` 回报回收字节、会话数据按会话清理）**都不是本单元碰过的面**，
   仍在册、待核。

## 七 版本位点台账

Latest = **v1.102.0** 不动；本单元是**运行时行为改动**（新增通道 + 维护动作）⇒ 占一个版本位，
并入下一个版本边界（v2.0.0 P0 批）。本轮不打 tag、不抬号。

## 八 遗留与下一轮第一步

1. **P0 批未认领的只剩**：「P0-9 的用户可见密度独立读数（渲染层审批卡计数，不许拿主进程日志替代）」与
   **P0-10 的三个剩余候选**（`runtime/pkgs` 包缓存回收路径 / `removeEnvironment` 是否回报回收字节 / 会话数据的按会话清理入口）。
   **已交付的不要再按 ⬜ 重做**：P0-7（`67bba067`）、P0-6 前半（`ab0a017b`）、P0-8 前半（`60333ac9`）、P0-9 的
   口径纠正 + 可测性（`af6e3354` + `e1c9ec0c`）、本单元的按需回收。
2. 本单元带出的**具名立案**（都附读数）：`installContent` 无消费方；跨类目回收（需读数全局去重）；版本解析的「主进程当时在做什么」分步归因。
3. 跨轮不变：IC40 needs-attention（需真后台投递）、IC6 收割（真算力主机）、中文源四家（外部条件）、M2/IC54（产品决定）。
4. **CI 判决**：本轮推送后按完整 40 位 SHA 查 `Nightly` + `Windows Full Test` 终态；本轮结束前若未落定，
   下一轮第一件事就是取终态（`cancelled` 不算绿，`docs/**` 纯文档提交查回 0 条 run 是 paths 过滤、不许读成「未触发」）。
