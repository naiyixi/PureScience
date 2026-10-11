# PureScience v2 线排期与发版规划（2026-10-10 定稿稿）

> 依据：`docs/competitive-tracking/2026-10-10-two-benchmarks-delta-and-plan.md`（两个标的的窗口增量与能力面判定，本地台账）。
> 本份只写**我们自己的**范围、单元、窗口与发版动作；标的名与被禁词一律不出现在本文件里。
> 口径：**一版范围项做完＝立刻走完整发版流程**（抬号 + CHANGELOG + README 双语横幅 + 全量门禁 + tag + 盯 Release 页），不带未发布版本做下一版。

---

## 〇、前置：1.x 收官（半天内，内容已就绪）

| 项 | 现状 | 动作 |
|---|---|---|
| **v1.102.0** | CHANGELOG 条目已写（检查/测量手段类 20 条），门禁读数是占位符 `<GATE_FILES>/<GATE_PASSED>/<GATE_SKIPPED>/<GATE_WARN>` | 回填门禁读数 → 四文件核对 → 打 tag → 盯 Release 页与 21 资产 |

**为什么先发它**：仓规是"不带着未发布的版本继续做下一版"。把 v1.102.0 发出去，v2.0.0 的范围就从**干净的起点**开始，
CHANGELOG 的新段只覆盖本版内容。落款为 **1.x 收官版**。

---

## 一、版本线定义与抬号规则

- **v1.x 收官**：`1.102.0` 之后不再出 1.x。
- **v2 线主题**：**可复算的科研工作台**（每个新能力都必须给出"可复算/可溯源"的那一半）。
- **抬号规则**（与既有纪律一致）：
  - 版本号只抬 `package.json` 的 `version`；`package-lock.json` 的版本位按本仓历史**保持不动**。
  - 位点取自**上一个已发布**的版本（不取自排期档里的批次标签）。
  - 纯文档/测试/工具链改动**不占补丁号**。
  - 新线的第一个版本 `2.0.0`：`1.102.0` → `2.0.0`（跳过 1.103+，不做 1.x 尾巴）。
- **每个版本边界**：CHANGELOG 新段 + README/README.en 发布横幅（逐字节一致）+ 四平台产物 + `RELEASE-CERTIFICATION.json`。

---

## 二、版本序列（v2.0.0 起）

| 版本 | 主题（对外一句话） | 范围批 | 窗口预算 | 与其他版的关系 |
|---|---|---|---|---|
| **v2.0.0** | **先修稳，再换代**：P0 稳定性与流畅度收口（九天真机日志暴露的 10 项）+ 结构工作台（3D 视图 + 结构状态进对话 + 选择/测量即证据）+ 中文文献翻译 | **P0 + D + A** | 5–6 个工作窗口 | 新线首发；P0 先做（旗舰要在真机跑，稳定与流畅是前提）；D 与 A 路径不相交，可并行推进 |
| **v2.1.0** | **执行可信**：可审阅的 Notebook 执行 + 别名级依赖血缘 + 会话内文件变更审阅 | B | 2 个窗口 | 依赖 D 的权限门复用点已就位 |
| **v2.2.0** | **数据面加宽**：ENCORI / PDC / Ensembl 群体 LD / ChEMBL assay 详情与分页 / ClinVar 逐提交证据 / 文献库整页全选 | C | 1.5 个窗口 | 与 v2.1.0 无依赖，可提前并行 |
| **v2.3.0** | **方法即产物**：画布 → 编译为可调用能力 + 插件创建器（读第三方公开仓库 → 声明工具/运行时 → 部署 → 验一次真跑） | E | 3 个窗口 | 需要 D 的结构节点类型与 engine-catalog |
| **v2.4.0** | **目标与知识**：持久目标模式（进度只能由真读数推进）+ 个人知识库（文件/网址/文件夹语义检索 + 引用 + 文件夹 Wiki） | F + G | 3 个窗口 | 与 background-delivery / routines 打通 |
| **v2.5.0** | **设计侧引擎族**：反向折叠（ProteinMPNN 类）/ binder 生成（RFdiffusion/BindCraft 类）/ MD（GROMACS） | H | 2 个窗口 | 挂进既有 engine-catalog 机制（权重许可事实 + 审批前脚本） |

**默认按上表顺序推进**；`v2.1.0` 与 `v2.2.0` 若撞在同一窗口且路径不相交，可交换先后。

### 备选（若首版要更快出门）
`v2.0.0` 只装 **D**，A 顺延为 `v2.1.0`，其后各版依次后移一位。
**取舍**：单旗舰窗口短（约 3 个窗口）、更快拿到一个可演示的大件；代价是"中文文献翻译"这个对中文用户最有感的能力要晚一版。

---

## 二·补、v2.0.0 批 **P0：九天真机日志暴露的稳定性与流畅度缺口**（2026-10-10 抽取）

> **证据来源**：本机打包版应用（1.100.0，10-10 20:14 安装）的**真实使用日志**
> `~/Library/Logs/PureScience/{main.log, main.1.log, main.2.log}`，窗口 **2026-10-01 22:18 → 2026-10-10 21:56**，
> 共 **28,039 条**结构化记录（info 16,890 / warn 7,580 / debug 2,069 / **error 1,500**）；
> 外加一条真实崩溃报告 `~/Library/Logs/DiagnosticReports/PureScience-2026-10-10-195205.ips`。
> 这不是压测数据，是**用户自己 68 个会话**跑出来的读数 —— 每条缺口都带次数与最大耗时。

### P0 清单（每条：现象 → 真实读数 → 优化点 → 真机验收判据）

| # | 现象 | 真实读数（9 天） | 优化点 | 真机验收判据 |
|---|---|---|---|---|
| **P0-1** | **应用退出即崩溃** | 10-10 19:52 打包版 **1.97.0** 崩（`EXC_CRASH` / `SIGABRT` / `Abort trap: 6`）；崩溃报告显示：启动 19:51:30 → **25 秒空档** → 19:52:00 退出四阶段全部报 `completed`（usage-drain / renderer-session-flush / backend-teardown）→ 5 秒后 abort | 收尾路径必须**原子**：四阶段报 completed 之后不得再 abort；崩溃时把"当时处于哪个阶段 + 最后一条操作"写进日志与 `.ips` 之外的自有日志 | 连续 20 次「启动→退出」零新增 `.ips`；每次退出日志末尾有具名完成行 |
| **P0-2** | **1,481 次 `uncaughtException` 被静默吞掉** | network **1,344** / system **137**；**10-04 13 点单小时 604 次**（连发）；而日志里**只有 `errorCategory`，没有 message / stack** | ① 记 message + stack + 去重计数；② 同类 60 秒内合并为一条带 `count`；③ 连发退避；④ 屏上给**具名提示**，不再静默 | 造一次网络抖动：日志出现 **1 条**带 stack 与 `count` 的记录；屏上出现具名提示；连发不再刷屏 |
| **P0-3** | **启动关键路径串行慢探针** | `settings:get-preflight` 中位 **919 ms**（max 12.0 s）、`network:check-connectivity` **871 ms**、`settings:check-environment` **760 ms**、`settings:npm-available` **525 ms**；**数据根解析 25 秒空档**（该根：**290,495 文件 / 18.07 GB**） | 首屏可交互前不跑阻塞探针（并行化 + 延后到空闲）；数据根解析走索引/缓存并显示进度 | 冷启动到可交互的读数落到本次基线之内；探针不再出现在首屏路径 |
| **P0-4** | **保存/投影类通道拖慢界面** | `sessions:save-session` **4,282** 次慢调用（中位 100 ms、p95 **939 ms**、**max 50.0 s**）；`notebook:state` 819（max 15.4 s）；`acp:get-plan-projection` 568（max 15.2 s）；`reviewer:get-for-session` 289（max 12.5 s）；合计 **6,756 次** | 保存去抖 + 增量写；投影读取加缓存与陈旧检测；把"慢"改成可归因（哪一段慢） | 重放同一批操作，p95 与 max 落进基线；慢调用日志能点名**具体阶段** |
| **P0-5** | **计划步骤状态机与 agent 打架**（工具失败第一名） | `purescience-plan/update_step_status` 失败 **83 次**：`dependency-not-satisfied` 38 / `invalid-transition` 37 / `No such tool available` 8 | 允许 agent 的合法推进顺序；前置未满足时给**可行动**提示（该先做哪一步），不是一句拒绝 | 同一段真实任务里该工具 **0 次**失败 |
| **P0-6** | **项目范围拒绝误伤真实工作** | `Bash` 被拒 **15 次**，其中把**数据根自身**（`~/.purescience`）与**模型权重目录**（`~/.cache/torch/hub/checkpoints`）判成"项目范围之外"；另 `purescience-figure/figure_review` 4 次 "No such tool available" | 数据根自身与权重缓存进白名单（**2026-10-11 执行器核实并纠正**：数据根**本来就在 roots 里**，真因是分词器把 `;` 留在 token 里 ⇒ 见下面 P0-6 交付行）；工具注册名两侧一致（`purescience-plan/x` 与 `mcp__purescience_plan__x` 并存是同一件事的两种写法） | 权重目录与数据根内的读写不再被拒；两侧工具名逐字一致 |
| **P0-7** | **产物能力令牌过早失效** | `purescience-artifacts/write_artifact_file` **13 次**："capability … issued for an earlier turn (or already spent)" | 令牌生命周期与回合语义对齐；失效时给**可行动**指令而不是让 agent 反复重试 | 同回合内重试即成功；跨回合给出下一步指引 |
| **P0-8** | **出网隧道目标失败 86 次**（含连接器自己的来源） | `api.anthropic.com` **43** / `api.deepseek.com` 11 / `ftp.ncbi.nlm.nih.gov` 11 / `raw.githubusercontent.com` 8 / `patents.google.com` 4 / `huggingface.co` 2 / `files.rcsb.org` 1 / `ftp.wwpdb.org` 1；另 `egress decision ignored` 263 次 | 失败按**域名族**给具名原因（超时/DNS/被拦）；对科研来源提供镜像回退（我们已有镜像机制的场景扩到这些族） | 真机跑 PubMed / RCSB 各一次：失败时给具名原因，且镜像回退拿到真数据 |
| **P0-9** | **权限询问密度过高** | 9 天 **2,128 次** `permission request received`，分布在 **68 个会话**，最高单会话 **112 次**；同时有 2,052 条 reviewer 自动批准日志 | 询问粒度显性化："本会话内同类调用不再问"；统计每次询问**本是否可自动**并给出覆盖率 | 同一会话跑同类调用：第二次起不再逐次询问；面板给出"自动批准覆盖率"读数 |
| **P0-10** | **内容存储体积与版本解析成本** | 存储读数：**unique 14.28 GB / total 18.07 GB / 290,495 文件 / 241,573 链接**；`artifact version resolve was slow` **184 次** | 存储面板给读数 + 一键清理（可达上限、**回收字节可复核**）；版本解析走索引 | 清理动作给出"回收 N 字节"并与清理后读数自洽 |

**排期含义**：P0 里的 P0-1/P0-2 属"**数据完整性/信任**"级（静默吞异常与退出崩溃会让用户对"跑完了没"没有把握），
排在旗舰之前；P0-3/P0-4/P0-9 直接对应"**卡、不如对标流畅**"这条用户反馈，与旗舰同版交付（旗舰的流畅度就是它们的验收场景）。

### 交付进度（按提交，勿重复做）

| # | 状态 | 提交 / 证据 |
|---|---|---|
| **P0-1** 退出 abort | ✅ **已交付（真机读数待补）** | `6c24323d`：收尾新增 `database-release`（显式释放 Prisma 查询引擎、3 s 有界、结果具名）+ 逐阶段 fsync 面包屑（下次启动点名上次死在哪个阶段，已完成/从未记录完成/不可读三态分开）。**未取证项**：连续 20 次「启动→退出」的真机读数被内存闸门挡住（空闲物理页 7,112 ≈ 111 MB），配方见证据档 |
| **P0-2** 1,481 次异常只有分类 | ✅ **已交付** | `6c24323d`：脱敏消息 + 首个调用帧 + 稳定签名 + 次数，60 s 窗口折叠连发、指数退避（上限 8 分钟）、退出 flush |
| **P0-4** 慢保存归因 | ✅ **已交付（执行器）** | `a2209532`：`sessions:save-session` 慢调用点名到阶段（4,282 次 / max 50.0 s）—— 归因那一半 |
| **P0-5** 计划状态机拒绝不可行动 | ✅ **已交付** | `a523583c`：两条拒绝点名**缺哪一步/哪个阶段**与**当前状态允许设置的状态集合**；blocked 保持契约终态（放宽属契约变更，已具名说明不顺手改） |
| **P0-8** 出网目标失败 86 次 | 🚧 **前半已交付（执行器 `60333ac9`）；后半未做** | `60333ac9`：单一来源的失败族词表（`src/main/net/egress-failure.ts`）+ 代理对目标失败**先作答 502 具名原因再断开**（此前隧道裸 destroy、HTTP 路径把错误整个丢掉且回 403）+ 连接器边界把族带进 agent 看到的错误。真读数 `docs/evidence/2026-10-11-egress-failure-families.md`（回放九天真机日志 **203 条 → 199 条具名 / 0 条无名**，4 条是原日志的空串）。**未做**：科研来源**镜像回退**（需逐来源决定镜像与校验，属独立单元）⇒ **v2.0.0 的 CHANGELOG「明确没做」段必须写明这半未做**
> **后半开工前的勘察（2026-10-11）—— 结构事实与来源清单已具名**：
> - **既有能力（已核）**：`src/main/net/resilient-download.ts` 已有重试 / 校验和 / 停滞检测，被 update 下载、
> notebook provisioner、language-pack 三处消费，**但它没有「镜像」这个概念**；连接器各自经自己的 `ctx` 取数，
> **全树没有任何连接器带镜像回退**（grep 到的 `mirror` 全是散文）。⇒ 这是**新机制**，不是把既有开关打开。
> - **来源清单按「能否证明换源后内容相同」分三类**（这决定策略，不是喜好）：
>   ⚠️ **本表已被实测改写（2026-10-11，读数见 `docs/evidence/2026-10-11-mirror-candidate-identity-probe.md`）**：`ftp.wwpdb.org` 在本机**连 DNS 都不解析**、`ftp.ncbi` 与 `eutils` **服务不同内容** ⇒ 我原先写的"同一组织即可放心回退"**不成立**；
>   真正在本机成立、且拿得出同一性证据的只有两条：`huggingface.co → hf-mirror.com`（原始超时 / 镜像 200）与
>   `raw.githubusercontent.com → cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>`（镜像 sha 与仓内已知内容逐字节相同）。**每一行镜像都必须有实测**，不能靠组织归属推理。
>   1. （原判，已被上条修正）**同一组织的第二条官方端点**：`files.rcsb.org` ↔ `ftp.wwpdb.org`（同属 wwPDB 体系）、
> `ftp.ncbi.nlm.nih.gov` ↔ `eutils.ncbi.nlm.nih.gov`（NCBI 自己的两条路）。日志里正是这两族在失败（各 11 / 1 次）。
>   2. **第三方镜像 / CDN**（可用，但**必须按校验和证明同一性**）：`huggingface.co` ↔ `hf-mirror.com`（文件级 sha256 可得）、
> `raw.githubusercontent.com` ↔ jsDelivr（内容可能被缓存或改写 ⇒ 要么有仓内已知哈希、要么改从 API 取）。
>   3. **不该有镜像**：`api.anthropic.com` / `api.deepseek.com`（认证与计费端点，换源等于把凭据发给第三方，**永不回退**）。
> - **硬判据（建议写进设计）**：换源**必须同时给出「内容同一性」的证据**（校验和，或同组织的第二条官方端点）；
> 给不出就宁可按**具名失败**报错 —— 对科研工具而言，「静默换了源、拿到的东西不确定」**比失败更糟**。
> - **落地形状（建议）**：镜像表写成**纯数据模块**（host → 候选 + 每个候选的同一性证明方式），回退逻辑放在
> **内容取数那一层**（不是每个 connector 各写一遍），返回结果里带上**实际来源标记**（`via: origin | mirror:<host>`），
> 并且这个标记要**上屏 / 入证据** —— 否则用户拿到镜像来的数据却以为来自原始来源。

> **进展（2026-10-11）—— 后半第一版已交付并双绿**：`d4de3915`（镜像表 + 回退包装 + 接进带 digest 的 `language-pack-fetch`）、
> `3476e2bd`（`via` 随产物上行；真消费方=供应过程的**进度文案**：非 origin 时显示 `Downloaded <file> from <host>`）。
> 判决：`d4de3915` 与 `3476e2bd` 的 `Windows Full Test` / `Nightly` 均 success。
> **真机读数**：候选端点同一性（`docs/evidence/2026-10-11-mirror-candidate-identity-probe.md`）+
> **回退那一跳**（`docs/evidence/2026-10-11-mirror-fallback-live-path.md`，`via=hf-mirror.com` / 落地 sha 与预期逐字符相同）。
> 附带读数：`raw.githubusercontent.com` 的**超时是间歇性的**（同路径另一次 `via=origin` 且校验通过）⇒ 回退形态必须是
> 「**先试原始端点、失败才换源**」，不是「检测到网络环境就换源」。
>
> **仍未做（具名，且已核过它到底要动什么）**：
> 1. **`via` 进入持久溯源**：`FetchedBundle` 只有 `{ lockPath, pathBudget? }`、`provisioner` 无 logger ⇒
>    这一步实际是**给 env 记录加一个来源字段**（schema 演化 + 迁移口径），属**独立单元**，不是顺手一笔；
>    当前用户可见面只有进度文案（已上线并实测）。
> 2. **> **读池设计已产出（2026-10-11，`docs/evidence/2026-10-11-single-connection-read-pool-design.md`）**：在源码注释里核对到 limit=1 的**两条**理由（硬约束=运行时约束迁移要在同一物理连接上先关 `foreign_keys`；软理由=避免 SQLITE_BUSY），并据此把实施拆成**先小后大**两步 —— 
> **第一步**（推荐先做）：在**现有那一条**连接上开 `journal_mode=WAL` + `busy_timeout`（WAL 是**文件级** PRAGMA，不需要读池就能上），代价是出现 `-wal`/`-shm` 伴随文件 ⇒ **删除协调器 / 存储用量走查 / 任何拷 .db 的写法都要核**（只拷 `.db` 会丢掉未 checkpoint 的内容）；
> **第二步**（仅当第一步读数不足）：独立**只读**连接承载读查询，写与迁移仍留在 limit=1 那条；内存增量必须实测（本机 8 GB，这一项可能是否决项）。两步的验收都要求**真机改前/改后对照读数**，当前被内存闸门挡住。
单连接读池**（P0-10③ 的根因）未开工：需 WAL + 读池 + "运行时约束要求同一物理连接"的迁移口径，独立设计。
> 3. **RCSB / NCBI 两族维持具名失败、不回退** —— 实测结论（`ftp.wwpdb.org` 本机 DNS 不解析；`ftp.ncbi` 与 `eutils` 服务不同内容），不是遗漏。
> 4. `ftp.wwpdb.org` 这一行**不作回退**，但保留在证据档里：它对**别的网络**可能可用，问题是本机解析不了。
 |
| **CI 判决（本批）** | ✅ **两条车道全绿** | `3d7ca25b`：`Windows Full Test = success`、`Nightly = success`。**两个中途红 SHA 具名留档**：`02bcebf4` / `0e839723`（Windows 红，成因是同一处跨平台缺陷：文件 fsync 落在只读句柄上 —— Windows 的 FlushFileBuffers 要求句柄可写），修后前进、未改历史 |
| P0-3 启动串行慢探针 | 🟡 **埋点已交付；分步读数待真机** | 空档被夹死在**一个阶段之内**：`compose-runtime` @11:51:31.445 → `data root resolved` @11:51:57.083，**25.6 秒零归因**。假设 A（schema 校验）**实测否掉**（真库副本 `client_ms=1 / ensure_ms=25 / tables=40`）；假设 B（固定开销）被 137 次启动分布否掉（min/median/p90 = 0.6/12.5/61.5 s；同版本同根 **1.0 s 与 26.4 s 并存** ⇒ 机器侧主导）。**埋点已交付** `46d10584`：`createComposeStepRecorder`（慢步骤点名 ≥250 ms、失败带类别、窗口关闭一行汇总），接线到 `settings-service` / `read-stored-settings`（经系统密钥库解密，首要嫌疑）/ `hydrate-child-proxy-runtime` / `restore-notification-inbox` 四个 await；`Windows Full Test = success`。**下一步**：真机跑一次读"哪一步慢"（卡内存闸门：空闲物理页 ≈111 MB，配方见证据档第四节） |
| P0-6 范围拒绝误伤 | ✅ **两半都已交付（前半 `ab0a017b`、后半 `63ebc76b`）** | 对源纠正了修法口径：**数据根一直在 roots 里**（`agent-runtime-manager.ts:727` 传 `{roots:[dataRoot, storageRoot]}`，本机实际 roots 文件就是那一个目录），真机那条"根被拒"的原文是 `"target":"/Users/totota/.purescience;"`，即**分词器把 `;` 留在 token 里**（根 + 一个字符），所以「加白名单」是对着症状修、机制修法在分词。真机读数 `docs/evidence/2026-10-11-path-guard-false-refusals.md`：用户自己的围栏决策日志 **662 行 / 36 条拒绝**（正则或通配 6、权重缓存 6、标点粘连 2、agent 临时件 2、工具链 1、根或家目录 16、其它 3）；同一批真 payload 的 before/after 对照（before = 机器上正在跑的那份产物，after = 应用自己的 writer 新写出的那份）三类误伤转 allow，五条负向对照（凭据 / 整盘搜索 / 他人家目录通配 / 兄弟缓存 / 临时目录）逐条仍 deny；`/` 未被放宽。**未做（已立案）**：P0-6 后半 = **工具注册名两侧一致** —— 真机 `No such tool available` 累计 25 次且**两种拼写都有人猜错**（`mcp__purescience-plan__generate_plan` 是真存在的工具，那次失败是入参 JSON 解析失败；下划线的 `mcp__purescience_plan__update_step_status` 报不存在；反向也有 `mcp__purescience-notebook__…` 报不存在），根因是**同一个应用里两套命名约定并存**（notebook 下划线，plan/figure/artifacts/activity/skills 连字符）；**✅ 后半已交付（执行器 `63ebc76b`，2026-10-11）**：工具注册名两侧一致 —— `activity`/`artifacts`/`skills`/`plan`/`memory` 五个服务的 `canonicalName` 去连字符（notebook 此前已由 `f41f176e` 改）、旧拼写进 `legacyNames`、**未在此声明的服务（figure、用户自建）也继续应答旧拼写**；身份目录 / 权限策略（含 Codex 叶子别名）/ agent 文案 / 渲染层身份与活动识别 / e2e 夹具连锁 **42 文件**，另加 **4 条回归守卫**（所有声明名无连字符 · 注册常量等于声明值 · 旧拼写解析到同一身份 · 未声明服务保旧拼写）。**真机读数就地更正**：三份 `main*.log` **全量**是 **31 条**（不是本行原记的 25 条——那是当时一个窗口的数），逐条分类为 **12 条「猜测名 = 应用今天渲染的名字」**（`purescience_plan` 8 · `purescience_figure` 4，最近一条 2026-10-10T13:46Z）**⇒ 本改动直接修**；6 条「模型自己猜连字符」（notebook，其注册名在 `f41f176e` 之后早已无连字符）**本改动不修、已立案待新窗口复测**；5 条模型编造叶子名；8 条非本应用服务。取数脚本已入库可复跑 `scripts/audit-mcp-tool-name-failures.mjs`，读数与边界见 `docs/evidence/2026-10-11-app-mcp-server-name-consistency.md`。 |
| P0-7 产物能力令牌过早失效（13 次） | ✅ **已交付（执行器 `67bba067`）** | 根因＝能力寿命写死 **2 小时**、而 `extend` 只在回合「开」的那一刻被调用 ⇒ **长回合中途被自己的时钟判过期**；过期判定还排在回合作用域匹配之前，"这个回合还开着"从没机会被考虑。改为「有匹配 scope（＝回合还开着）就续期、**没有活回合在问**时才关闸」，两句失效文案改成可行动。真机读数：用户日志 `purescience-artifacts/*` 268 行里 24 条能力类失败、落 4 个 session，**四条 episode 全在进入回合 2 小时之后**（192/589/692/965 分钟），其中三条在最后一枪后 **24–50 秒**回合就结束了。证据 `docs/evidence/2026-10-11-artifact-capability-turn-lifetime.md`。**未做**：令牌的总体寿命上限（"开放回合被抛弃后能力一直活着"的残余风险已具名记档） |
| P0-9 权限询问密度 | 🟡 **口径纠正 + 可测性已交付** | **我先前的口径错了**（"九天 2,128 次用户被打扰"站不住），真读数：2,128 次 `permission request received` 里 **2,048 次（96%）是 reviewer 自己的 MCP 工具**（`query_execution_log` 一项 **1,254**），且**每条之后 +0.00 秒**就跟着 `approving scope-bounded reviewer MCP tool call`（同一 `toolCallId`；`main.log` 单文件 **906 请求 ↔ 856 自动批准**）⇒ 这些**是应用内部自动批准**，用户并没被问 2,128 次。判据（能否避免）也量了：问的那一刻已有同会话授权的只有 **10 次**；非 reviewer 族只剩 ~80 条（fetch 29 / WebFetch 22 / execute 10 / notebook 6 …），用户可见询问只可能出在这里。**缺陷是可测性**：请求记 `info`、而"已自动批准"的决定记 `debug` ⇒ 正常日志只看得见请求、看不见决定，读起来像"问了 2,128 次"。**已交付** `af6e3354`：决定提到 `info` 并加 `rule: 'scope-bounded-reviewer-mcp'`，两者可按 `toolCallId` 相认。**未做**：真正的用户可见密度需要独立读数（渲染层审批卡计数）才能报，**不许拿这条日志替代** |
| P0-10 存储体积 —— 口径第三次被读数改写 | 🔴 前两版口径不成立；剩余缺口已核成事实 | **① 读数通道早已存在（不是缺口）**：`storage/usage.ts:139` `computeStorageUsage`（分类 + `runtime` 逐环境子项与人类可读标签 + 基础设施/隐藏目录区分 + loose 文件）、`usage-cache.ts`（TTL 缓存、保留上次读数、后台刷新、`pending` 态）、`command-owner.ts:189`（用户可达 `storage.getInfo` + `storage info was slow` 相位遥测）；inode 去重也有并额外记账「共享省下多少」。**② 环境移除也已存在**：`manage_environments(action:"remove")` → `provisioner.removeEnvironment`（内置环境受保护）。⇒ 我的 `measureRuntimeFootprint` 属**并行第二套**，已 **revert** `f816a299`（`index.ts` 接线一并拆净、含引用已删模块的隐患；执行器那两行 `resolveDataRoot` 原样保留）。**③ 真机复核读数**（对既有通道的独立复核）：13.76 GB / 178,450 文件，逐族与 `du` 一致（`envs 5.17G / pkgs 2.75G / notebooks 3.74G / artifacts 540M / claude 422M / provenance 153M / packs 75M`）。**④ 已核成事实**：(a) `runtime/pkgs` 2.8 GB **确认无回收路径**（`micromamba-cache.ts:211` 的 `rmSync` 只清"本次创建后被拒"的目录；`conda clean` 一类零命中）⇒ **真缺口**（只增不减）**—— 回收读数已交付** `f7a23c2c`：`measurePackageCacheRedundancy` 把缓存按链接数分成 `redundant`（nlink>1，缓存副本可证冗余）与 `soleLink`（nlink==1，最后一条链）+ 观测到的 `maxLinkCount`，并接进启动维护日志；**真机读数：118,847 文件 / 5.48 GB（未去重）⇒ nlink>1：95,817 / 2.73 GB（可安全回收）、nlink==1：23,030 / 2.75 GB（需包级分析后再说）**。(b) `removeEnvironment`（`provisioner.ts:1388`）**确认不报回收字节**（`rmSync` 后直接 `return this.listEnvironments()`）⇒ **真缺口**（"回收字节可复核"不成立；改动按契约涟漪走）；(c) 会话数据 3.7 GB —— **已核实，且口径再次修正（第三次）**：① **删除路径不释放它**：`projects/deletion-coordinator.ts` 的清理步骤是 sessions(JSON/DB) → reviews → provenance → 项目行 → 内容库 prune，**没有任何一步删会话的 notebook 数据目录**（`sessionDataRoot`/`removeSessionData` 等名字全树零命中，`notebookSessionRoot` 只出现在执行/导出路径）⇒ **真缺口（信任级）：删项目/会话后磁盘不减少，用户以为删掉了**。② **它不是垃圾**：抽最大的那个会话目录下钻 —— 1.1 GB 是 `<run>/data/results/` 里**三个 300 MB 的 `.h5ad`**（`gse331003_processed` / `_hvg` / `_annotated`），即这位用户单细胞分析**真结果**的三步产物，目录里只有 180 个文件。⇒ 所以**不能**把"自动清理会话数据"当成修法（那会删用户的成果）；正确的形状是：**删除动作要真的释放它**（并让用户看到减了多少），至于三步产物里的中间步是否可丢，是 **agent/用户的选择**，不是我们能替他猜的。**本条据此改判：立项为「删除要名副其实」＋「会话体积可见」，不立项为「自动清理」。**

> **进展（2026-10-11）**：「删除要名副其实」**已交付** `48c290f6`（新模块 `src/main/notebook/session-data-cleanup.ts` + 并进 `finishDeletion` 的 provenance 之后、不吞异常、失败由既有重放收尾重试；项目 id 按 `^[A-Za-z0-9_-]{1,64}$` 做路径穿越边界、不合规按名拒绝；删除**前**先量、报 `freedBytes` 进 `project notebook data removed` 日志；"不存在"是具名 `absent` 而非 0 字节）。门禁 7 文件/62 条 + `typecheck:node` exit 0，**双车道绿**（含 Windows —— 递归删除是跨平台敏感面）。**未做半边（具名）**：① 把释放字节显示到界面（9 语 i18n + 渲染测试）；②「会话体积可见」尚未开工 —— **设计已勘察，且发现它是便宜的那一类**：
   - 现形状：`UsageCategory = { key, bytes, children? }`，面板用 `t('settings.storage.category.'+key)` 取标签；`computeStorageUsage` 只走 `CATEGORY_KEYS` 那几个顶层目录（不含 DB）。
   - **关键判据**：项目名是**动态文本，不可能做成 i18n 键** ⇒ 正解是给 `UsageCategory` 加可选 `label`（由主进程载荷自带），面板在有 `label` 时优先用它 ⇒ **不需要动 9 语字典**（这一步把本单元从 32 文件压到约 4 文件）。
   - **设计修正（2026-10-11，勘察第二步推翻了上一条的"4 文件"估计）**：`UsageCategoryKey` 是**字面量联合**（`artifacts|uploads|runtime|notebooks|workspaces`），而面板用 `CATEGORY_COLORS[category.key]` 与 `CATEGORY_LABELS[category.key]` 两处**按联合索引的 Record** ⇒ 往 `categories` 里塞动态 key（`project:<id>`）会让这两处查找失效（且颜色/标签无从给出）。**正解改为另开一个可选数组**：`StorageUsage.projects?: { id, name, bytes }[]`，面板为它渲染**独立的一小段列表**（行文本直接用载荷里的项目名——动态文本，不进字典），只需**一个**小节标题键。
   - 落地形状（6 文件 + 1 个 i18n 键 + 2 套测试）：`shared/storage.ts` 加 `projects?`；`computeStorageUsage(dataRoot, projects?)` 增**可选入参**（保持"只走目录"的既有语义，不把 DB 依赖灌进 usage 模块）；`command-owner.ts` 透传项目清单；`ipc.ts` 注入 `listProjects`；面板加"按项目"列表（`label`/名称取自载荷）；**1 个**标题键走本技能自带的 `scripts/add-i18n-keys.py`（九文件齐平预检）。
`computeStorageUsage(dataRoot, projects?)` 增**可选入参**（保持"只走目录"的既有语义，不把 DB 依赖灌进 usage 模块）；   - 与已交付的删除动作**配对**：一个"看得见谁占多少"、一个"删得掉且说得清释放了多少"。
③ 真机跑一次真项目删除取读数（卡内存闸门）。**⑤ 单连接读池**独立立项。**⑥ 包缓存回收动作 —— 等用户拍板入口**（技术约束已定死：只删 `nlink > 1` 的副本、删除时再核一次链接数、回收字节用删除前后读数之差给出、`soleLink` 那 2.75 GB 不动）：候选入口 ① 并进执行器刚做的「回收」面板按钮（用户可点，但会碰它的新通道）② 作为 `manage_packages` 的新动作（agent 可调，属既有工具域但同样要动 schema/文档/测试）③ 两者都做（先 ② 后 ①）。**这是会改变做法的取舍。**（问过一次、超时未答 ⇒ 按推荐项①评估，结果：**该路线实测 32 文件连锁** —— `StoragePanel.tsx` + 9 语 i18n + `renderer-contract-catalog` / `renderer-surface-inventory` / `web-api-map.generated` 三处 pin + 渲染测试；工具路线要动 `InstallRequest` 联合（`managePackages(request: InstallRequest)`）与 schema/文档/测试，连锁规模需先数再动。）**因此本项停在这里：读数已交付、安全规则已定死、入口连锁已量清 —— 留给下一轮或执行器开工；本轮不交付半截的删除动作（删的是用户数据，半个入口比不做更危险）。** |

---

## v2.0.0 单元拆分（可开工粒度）

### 批 D —— 结构工作台

| 单元 | 内容 | 差异化超越点（必须逐条落地，禁止平齐） | 真机验收判据 |
|---|---|---|---|
| D1 | 3D 结构视图内核（PDB/mmCIF/AlphaFold 产物加载；表示与配色；相机/焦点） | 内核用成熟开源 viewer；界面按我方极简风与主色**自研**（不做像素级模仿） | 真机打开一个 PDB → 可旋转/缩放/换表示 |
| D2 | 结构状态进对话：当前结构、链、残基区间、可见选区成为会话上下文 | 上下文里带**结构 id + 选择指纹**，不是"当前那个结构" | 选中一段区间 → 问 agent"这段是什么" → 回答引用的是该区间而非整链 |
| D3 | 选择与测量即证据：聚焦/连续区间/空间邻域/整链选择、距离与角度测量 | **选择/测量落成可复算的选择指纹**（结构 id + 区块 + 参数 + 时间）进溯源面板 | 溯源面板能回跳到该指纹；同一选择复算出同一指纹 |
| D4 | 标签与图层：命名选区、上色、检查/移除 | 标签进证据链（可被引用、可被导出） | 打标签 → 引用 → 导出后标签仍在 |
| D5 | 中文口语 → 选择：如"把 145 号半胱氨酸 5 埃以内的残基标出来" | 走中文术语归一路径；解析结果**上屏**（实际发出的选择参数） | 一句中文 → 选区正确 → 参数上屏 |
| D6 | 导出与动作过门：视图/视频/结构文件导出、远程结构加载 | 导出与远程加载按出网三态审批；标注会留下什么 | 导出触发审批卡；拒绝后无产物 |
| D7 | 结构产物与算力目录打通 | 结构预测引擎产物直接进视图，**权重许可事实随产物带出** | 一次预测产物 → 视图打开 → 许可事实可见 |

### 批 A —— 中文文献 PDF 翻译

| 单元 | 内容 | 差异化超越点 | 真机验收判据 |
|---|---|---|---|
| A1 | 翻译引擎与段落级检查点 | 段落 id + 页码 + 原文哈希进译文记录 | 中断应用 → 重开续传，已完成段落不重翻 |
| A2 | 三模式阅读：原文 / 译文 / 对照 | 对照模式滚动同步 | 三种模式切换与滚动同步 |
| A3 | 溯源回跳 | 任一段译文可回跳原文位置 | 点译文段 → 原文高亮 |
| A4 | 术语一致性 | 复用中文术语表（100 行 MeSH 来源）校验译文，偏离术语表的段落**具名标注** | 抽查 3 个术语 → 一致；造一条偏离 → 被标注 |
| A5 | 参考文献保真 | 引文块不翻译，保留原文与序号 | 导出件里参考文献仍是原文 |
| A6 | 具名缺态 | 无文本层页 ⇒ 明说"该页无文本层，未翻译" | 造一个无文本层页 → 面板明说 |
| A7 | 导出对照件 + 9 语 i18n | 对照件可复算（可选导出配方） | 导出 → 页面数与段落数自洽 |

---

## 三、每版发版动作清单（照抄执行，不临场发挥）

1. **冻结并发推送**：`hermes cron pause 2be4405e5dc6`，并核"已经开跑的那一轮"是否仍在工作（`hermes cron list` 的 `Last run` + `git status --short` 里它未提交的路径）。
2. **四文件**：`CHANGELOG.md`（本版段 + 成熟度自陈**双向**核对）、`README.md`、`README.en.md`（头部块逐字节一致）、`package.json`（只抬版本位）。CHANGELOG 门禁数字先用占位符，跑完门禁就地替换。
3. **门禁在隔离工作树、对"要打 tag 的那个提交"跑**：本技能自带的 `scripts/release-gate.sh <sha>`（`eslint --no-cache .` + 双 typecheck + 全量 vitest `--maxWorkers=4` + 仓规五查），并**单独**跑一次 `bash scripts/pre-push-checks.sh; echo EXIT=$?` 读退出码（汇总行不可采信）。
4. **推 main → 打附注 tag**：先 `git push origin main`，再核 `git merge-base --is-ancestor "$(git rev-parse 'vX.Y.Z^{commit}')" origin/main` 为真，才打 tag 并推。
5. **发布核验**：`gh release view <tag> --json name,tagName,isDraft,isPrerelease,assets` ⇒ `draft=false`/`isPrerelease=false`/四平台产物齐 + `SHA256SUMS.txt`、`RELEASE-CERTIFICATION.json`（`sourceSha` 与 `<tag>^{commit}` 逐字符比对）、`version.json`、`latest*.yml`、每架构 `*-mac.yml`；"哪个页是 Latest"用 `gh release list` 判。
6. **正文**：`npm run release:notes -- vX.Y.Z --keep-generated --apply` 后逐字复核（✅ 段是滚动史：前插本版头条、把上一条改写成 previous；**已交付的不要留在 🗺️、半截的不要写 ✅**）。
7. **认证车道读数**（两条命令都要跑，缺一条会误判"未取"）：`node scripts/ci/harvest-certification-readings.mjs --sha <完整 40 位>` 与 `--in-repo <tag>`。
8. **恢复并发**：Release 页核对完再 `hermes cron resume 2be4405e5dc6`。

**具名跳过（不得声称）**：两条 `notarize-mac` 作业因无 Apple 凭据**具名跳过** ⇒ 不写"已签名/已公证"。
**Nightly (latest main)** 是常态 Pre-release，不算异常。

---

## 四、并发、环境与已知闸门

| 项 | 现状 | 处理 |
|---|---|---|
| 工作树脏（2026-10-10 22:1x） | **83 个 `docs/evidence/*.md` 未提交**（对齐 markdown 表格重排，非本轮我的手笔） | 不 stash、不提交、不据它们声称读数；只提交自己的路径；门禁走隔离工作树 |
| 自主执行器 | `2be4405e5dc6`，每 2h | 每单元开工前 `git fetch -q origin && git log --oneline origin/main -3 && git status --short`；目录不相交才并行 |
| Windows `database` 分片 | 间歇红，**修法不许加超时** | 归因按"失败文件是否本批碰过"逐次判；判决只能由 Windows 车道给 |
| 内存闸门 | `vm_stat` 空闲物理页 + `vm.swapusage` | 起 `build:e2e` + Electron 前先取读数；不足就让位并点名 |
| 认证 spec 守卫 | 12 条带本机前置（curated runtime pack / scanned fixture / 用户态 sshd） | 车道空 + 仓内空 ⇒ 才是"未取" |

**外部条件挂账（不占排期）**：中文源四家连接器（只回 `text/html`，无机读契约）；IC40 / IC6（真算力主机与真后台投递）；M2 权重校验值。

---

## 五、验收总口径（每个版本都适用）

- 一切声称完成的能力必须**实机跑通**：真入口 → 真操作 → 真数据 → 真结果；单元/集成/契约测试**不构成**完成证据。
- 每种新能力都要能回答"**可复算的那一半**是什么"：指纹、配方、读数、判决，至少一项。
- 台账三处同步：CHANGELOG 的"明确没做"段 + 排期档该行 + 队列档本轮段；本版没做的项必须可被认领（谁、何时、判据）。
