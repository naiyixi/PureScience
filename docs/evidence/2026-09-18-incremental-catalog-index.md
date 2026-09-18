# 增量目录索引：真机实测（冷启动只读索引 / 失效 / 外部改删 / 缺失回退）

- 日期：2026-09-18
- 实例：`npm run dev:headless`（**带真实主进程的真机实例**，web RPC 44100，headless 无窗口）
- 语料：**真实数据根的副本**（`/tmp/ps-bench-cold`，只复制 `sessions` + `purescience.db` + `settings.json` + `web-token`；**真实根未指向、未被写入**）
- 量法：`POST http://127.0.0.1:44100/rpc/<channel>`，逐次计时（ms）+ 记返回体量（字节）；服务端自己的索引计数从 `logs/headless.out.log` 的 `session catalog read` 行读取
- 代码：`c16c1dd`（本档所有数字都在该提交上采）

## 一、判据对照（硬验收）

| 判据 | 实测 | 结论 |
|---|---|---|
| 列表载荷 **< 2 MB** | **569,858 B = 0.54 MB**（59 会话） | ✅ 达标 |
| 稳态 **p95 < 150 ms** | 运行 A **23.2 ms**（中位 12.0 / 最大 33.8，20 次）· 运行 B **28.3 ms**（中位 18.4 / 最大 54.4，20 次） | ✅ 达标 |
| **冷启动只读索引不解析文档** | 冷启动后第一次调用 **68.2 ms**；服务端计数 **`indexHits: 59, parsedDocuments: 0`**，该进程 21 次读取全部为 `59 / 0` | ✅ |
| **mtime+size 失效** | 外部改写一个文档 ⇒ **只解析那一个**（`hits 58 / parsed 1`），列表立即出现新标题 | ✅ |
| **外部改删必须被发现** | 外部删除一个文档 ⇒ 会话数 **59 → 58**、该条目从列表消失（无解析：`hits 57 / parsed 1`，那 1 次是上一步恢复文件导致 mtime 变化） | ✅ |
| **索引缺失回退全量** | 删掉全部 59 个索引文件后：第一次调用 **503.5 ms**（`hits 0 / parsed 59`，重建）⇒ **下一次 38.0 ms**（`hits 59 / parsed 0`） | ✅ |
| **载荷不倒退** | 55,371,532 B → 569,858 B，**降 98.97%** | ✅ |

## 二、同实例、同语料的对照（同一轮进程内）

| 调用 | 返回体量 | 耗时 |
|---|---|---|
| `sessions:load-all`（旧全量协调读，基线） | **55,371,532 B（55.4 MB）** | **1541.1 ms** |
| `sessions:list-catalog`（列表层，冷启动第一次，运行 A） | 569,858 B | **68.2 ms** |
| `sessions:list-catalog`（冷启动第一次，运行 B；与启动协调并发时采） | 574,603 B | **102.3 ms** |
| `sessions:list-catalog` 稳态 20 次（运行 A） | 569,858 B | p95 **23.2** / 中位 12.0 |
| `sessions:list-catalog` 稳态 20 次（运行 B） | 574,603 B | p95 **28.3** / 中位 18.4 |
| `sessions:read-document`（第二条新通道，单会话 116 条消息） | 2,336,655 B | **64.0 ms** |

**两条通道端到端**（真机 web RPC，非测试）：列表条目对同一会话**不带 `messages`**、但 `messageCount = 116` 且 `lastAgentMessage` 有值；`read-document` 取回该会话的完整文档（**116 条消息 + `conversationGraph` 存在**）。列表里没有内容、按需取回的内容是真的 —— 这是两级目录在真机上的分工证据。

## 三、启动协调**没有**被这次改动取消（回归项）

列表读不再触发协调，因此协调改为**进程启动时跑一次**。真机证据（运行 B）：

```
startupCleanupEligible: true          ← 仍是本进程的启动边界
phase: 'reconcile-derived-state', outcome: 'completed', durationMs: 2559
operation completed { mode: 'reconcile', status: 'ready', sessionCount: 59,
                      degradedReconciliationCount: 0, warningCount: 0 }
```

即：上传升级 / 产物恢复 / 文件索引同步 / 权限清理在这次启动里**照旧跑完了**（2.56 s，59 会话，0 降级），只是不再挂在用户读列表的那一跳上。

## 四、口径与诚实边界

1. **dev 构建**：本档数字来自 `electron-vite dev`。dev 构建会高估渲染层开销，但**服务端 scan 与序列化**这一半在打包版上已实测同量级（先前打包版 `load-all`：55.4 MB / 1191–1566 ms）⇒ 本档可作**上界**读，不冒充生产数字。
2. **语料是副本**：真实根（`~/.purescience-project` + `~/PureScience-DEV`）**没有被指向、没有被写**。副本里 59 个会话、55.4 MB，与先前打包版实测的 59 会话同规模。
3. **升级成本已量**：索引格式升到 v2、旧文件（v1）一律视为过期 ⇒ **升级后的第一次列表读 = 全量回退那一次**（本档 503.5 ms / 59 解析），之后每次都是 0 解析。
4. **未量**（不宣称）：① 带窗口实例的 UI 交互（本实例 headless，没有窗口）；② 打包版复测（生产构建里的同一路径）。
5. **启动协调那 2.6 s 仍是全量**（逐会话 reconcile）。「只处理水位之后变化的会话」是**另一个独立单元**，本档不含。

## 五、复现步骤

```bash
# 1. 副本语料（真实根只读复制）
cp -R ~/.purescience-project/sessions /tmp/ps-bench-cold/sessions
cp ~/.purescience-project/{purescience.db,settings.json,web-token} /tmp/ps-bench-cold/

# 2. 真机实例（无窗口，开 web 服务）
PURESCIENCE_E2E_STORAGE_ROOT=/tmp/ps-bench-cold PURESCIENCE_WEB_PORT=44100 npm run dev:headless

# 3. 计时 + 体量
python3 /tmp/ps_rpc_measure.py cold     # 冷启动第一次
python3 /tmp/ps_rpc_measure.py steady   # 稳态 20 次 → p95
python3 /tmp/ps_rpc_measure.py legacy   # 同实例基线

# 4. 服务端索引计数（判「是否真的没解析文档」）
grep -A 6 "session catalog read" logs/headless.out.log | grep -E "indexHits|parsedDocuments"
```
