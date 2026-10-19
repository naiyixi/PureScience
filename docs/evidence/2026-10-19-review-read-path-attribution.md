# 审查面板 203 秒那条慢通道：归因取数（2026-10-19）

> 结论先说：`reviewer:get-for-session` 的 203,180 ms **不是读路径自己算出来的**。在本机同版本、
> 同一份真数据上把这条读路径逐字重放，全部工作约 **76 ms**；真机上那 203 秒里有 **96%** 与另外
> 12 条慢通道的区间重叠。本轮因此**不改读路径的实现**（改了也治不了这个症状），只给它加一条
> **分段日志**，让下一次现场日志能自己说出"卡在哪一段"。

## 一、现场读数（装好的应用自己的日志）

`~/Library/Logs/PureScience/{main.log,main.1.log,main.2.log}`，筛 `ipc handler was slow` 且
`channel === "reviewer:get-for-session"`：

| 指标 | 读数 |
| --- | --- |
| 慢记录条数（>50 ms 才记） | **675** |
| 中位数 | 209 ms |
| p90 / p99 | 1,341 ms / 15,467 ms |
| 最大 | **203,180 ms**（`2026-10-18T02:44:15.300Z`，runId `5d1fedcd…`） |
| >1 s / >5 s / >10 s / >30 s / >60 s | 90 / 29 / 14 / 2 / 1 |

## 二、那 203 秒在等什么（区间重叠）

把同一份日志里所有慢通道按「结束时间 − durationMs」还原成区间，与这次调用求交：

- 与别的慢通道重叠的并集：**195.2 s / 203.2 s = 96%**
- 12 条重叠记录，其中：

| 通道 | 条数 | 最长 |
| --- | --- | --- |
| `sessions:save-session` | 2 | **118,871 ms** |
| `notebook:state` | 3 | 76,622 ms |
| `settings:function-models` | 2 | 56,113 ms |
| `artifacts:read-preview` | 2 | 46,142 ms |
| `acp:get-plan-projection` | 1 | 13,498 ms |
| `settings:get-local-parsing-models` | 1 | 8,390 ms |
| `sessions:import-posture` | 1 | 436 ms |

同一窗口里 `artifact-provenance` 自己的分段读数给出了更硬的证据：一次 **30 KB** 的读，`readMs` 38,309 ms、
`readEventLoopMaxMs` **12,046 ms**；而 `dbCanaryMs` **7,915 ms** 意思是连 `SELECT 1` 都要排队近 8 秒。
**主进程当时被别的工作占着，不是这条读路径在算东西。**

## 三、读路径自己有多少活（真数据副本重放）

方法：`git worktree` 从 `c8b5c409` 拉隔离工作树；用 `sqlite3 .backup` 把真库（228 MB）与该项目
的会话文档（2.0 MB）、产物目录（3.5 MB）复制到 `/tmp`（真实配置根只读，一个字节没写）；再用
**生产函数逐字调用**（`ReviewRepository` / `flagStaleReviews` / `ArtifactProvenanceRepository`）。

被测对象是本机 review 最多的那个会话（8 条 review，全部 `complete`）：

| 段 | 读数 |
| --- | --- |
| `getReviewsForProjectSession` | **35 ms** |
| 会话文档：读 2,094,358 字节 → `JSON.parse` → `normalizeSessionFile` | 2.9–4.3 + 2.4–3.0 + 2.9–5.4 ms（5 次） |
| `flagStaleReviews`（8 条 review） | **冷 28 ms / 暖 21 ms** |
| 其中 19 次产物版本 resolve | 合计 74 ms，单次 ≤ 4 ms |
| 单个 turn 的 structural pass | 6.7 ms |
| **合计（约）** | **≈ 76 ms** |

203,180 / 76 ≈ **2,670 倍**。

## 四、被推翻的那条假设

上一轮的记事本把 203 s 归到「每条 review 顺序 rehash、单细胞 `.h5ad` 300 MB 级产物、同一版本被重复哈希」。
真数据不支持它：

| 问题 | 读数（真库只读查询 + 磁盘 stat） |
| --- | --- |
| Review 总数 / 单会话最多 | 149 / 8 |
| 全部 review 引用的产物版本次数 / 唯一版本 | 806 / 796 ⇒ **重复因子 1.01** |
| 全部字节 / 唯一字节 | 100.3 MB / 99.4 MB |
| 单会话最大（本机"最大"那个） | **2.2 MB / 19 个版本** |
| 最大单个文件 | 5.1 MB |

按「25 s/条 × 8 条」的推法，每一条得指向 ~300 MB 的产物；实测该会话 19 个版本加起来 2.2 MB。
**"重复哈希"这条假设的收益上限是 1%，不值得为它动实现。**

## 五、评估过但不做的三件事（附理由）

1. **调用内按版本去重**：重复因子 1.01 ⇒ 收益 ≈1%。做了也只是多一份要维护的状态。
2. **跨调用缓存摘要（size+mtime 做键）**：会削弱现有判据 —— 代码头注写明「内容哈希是为了让
   **改大小又改回、mtime 不变**的外部编辑也能被发现」。为几十毫秒放弃这条不可逆判据，不划算。
3. **把哈希搬到工作线程**：本机实测哈希总量 2.2 MB / 74 ms，不是瓶颈；搬走只增加通道与打包面。
4. （真存在但本轮不做）`resolveVersionContent` 读完**整份文件并 sha256** 验校验和后，调用方
   `computeArtifactDigest` **又一次流式哈希同一份字节** ⇒ 每个版本读两遍。19 次合计 74 ms，
   去掉第二遍省 <40 ms；等读路径真有"必须提速"的需求时再一并做，且要用「真来源给得出才算」的能力位
   （不能要求所有替身都提供校验后摘要）。

## 六、本轮实际改的那一处（让下一次不必再复制 228 MB 数据）

`src/main/reviewer/ipc.ts` 的 `getForSession` 现在自己报分段，`totalMs >= 250` 时写一条
`review load segments`：

```
{ projectId, appSessionId, reviews, reviewsQueryMs, sessionLoadMs, flagMs, totalMs }
```

会话读不出来时也写一条（多一个 `sessionUnavailable: true`、`flagMs: 0`）——否则"会话读不出来"
与"会话读得很快"在通道日志里长得一模一样。三条用例钉住：慢的必须报且字段逐字对、
快的必须静默（每次开面板都写日志就是噪声）、读不出来那条必须带 `sessionUnavailable`。
反向门：换回旧实现，前两条必红（第三条两种实现都绿，因为它守的是"别吵"）。

## 七、仍未归因的那一半（单列，不在本单元内）

把主进程堵住的是**别的通道**：`sessions:save-session` 118.9 s（分段 `writeMs` 46.2 s、`authorityMs` 42.2 s、
`aftermathMs` 17.0 s、`fileIndexMs` 11.4 s）、`notebook:state` 76.6 s、`settings:function-models` 56.1 s。
它们各自需要自己的分段读数与修法，不能算在审查读侧头上。

## 八、探针自己的坑（留给下一次）

在 vitest 里直接调 `SessionRepository.loadSession` 时，`decodeSessionDataPaths` 会走
`decodeDataPath(path, dataRoot = resolveDataRoot())`，而 `resolveDataRoot()` 在非 Electron 环境里会抛 ⇒
读失败被当成"损坏文件"，真会话被**改名成 `.json.invalid-<ts>-<n>`**。这是**探针环境问题，不是产品缺陷**
（生产里那个文件仍在原地、mtime 未变）。判据：拿副本重放时先确认文件名没被挪；被挪就换
`normalizeSessionFile` 直调，别把这条"损坏"写进结论。
