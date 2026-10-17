# P0-4 慢保存：真机分段读数（2026-10-17）

> 目的：在动「保存去抖 / 增量写」之前，先用**用户自己机器上的真实日志**判清 `sessions:save-session`
> 的时间到底花在哪一段。上一版判断（档里与源码注释里都写着）是「中位 100 ms 配 50 s 最大值 = 排队」——
> **本次读数把它否掉了**。结论与证据如下，全部可复跑。

## 一 取数方式（只读）

- 数据源：`~/Library/Logs/PureScience/main.log`（当前）+ `main.1.log`（上一份），**打包版应用自己的日志**，
  不是压测、不是本次构建。
- 对象：已有的具名慢行 `session save was slow`（阈值 200 ms，见 `coordinator.ts` 的
  `SLOW_SESSION_SAVE_THRESHOLD_MS`）。该行自带分段：`queuedMs` / `authorityMs` / `prepareMs` / `writeMs` /
  `aftermathMs` / `totalMs`。
- 复跑：

```bash
python3 - <<'PY'
import json,statistics
rows=[]
for p in ['~/Library/Logs/PureScience/main.log','~/Library/Logs/PureScience/main.1.log']:
    for line in open(p,encoding='utf-8',errors='replace'):
        if 'session save was slow' not in line: continue
        rows.append(json.loads(line)['data'])
for k in ['queuedMs','authorityMs','prepareMs','writeMs','aftermathMs','totalMs']:
    v=sorted(r.get(k,0) for r in rows)
    print(k, 'median=%d p90=%d max=%d sum=%d'%(statistics.median(v), v[int(len(v)*0.9)-1], v[-1], sum(v)))
PY
```

## 二 读数（n = 159 条慢保存）

| 段 | 中位 | p90 | 最大 | 合计 |
| --- | --- | --- | --- | --- |
| `queuedMs`（在队列里等） | **0 ms** | **50 ms** | 7,376 ms | 12.5 s |
| `authorityMs`（读权威会话） | 105 ms | 395 ms | 4,812 ms | **39.9 s** |
| `prepareMs`（合并 / materialize / 上传升级 / 绑定校验） | 4 ms | 55 ms | 2,870 ms | 8.7 s |
| `writeMs`（整份 JSON 落盘） | 98 ms | 476 ms | 10,578 ms | **44.6 s** |
| `aftermathMs`（JSON 落盘之后：证据快照 + 文件索引 + 通知） | 68 ms | 473 ms | 9,043 ms | **37.0 s** |
| `totalMs` | 335 ms | 1,720 ms | 12,782 ms | 142.7 s |

- **排队只有 3 条超过 500 ms、1 条超过 2 s**（7,376 ms 那一条）。p90 = 50 ms ⇒ 「排队形状」不成立。
- 时间三分天下：**写 31% / 读权威 28% / 善后 26%**，准备只占 6%。
- 慢保存的**尾部**（max 10.6 s 写、9.0 s 善后）说明这不是稳定开销，而是**整份 1 MB 级 JSON 的落盘与
  随后的证据/索引**在 IO 抖动时被放大。

## 三 会话体积（同一台机器，真数据根，只读）

`~/.purescience-project/sessions/*/*.json`（不含 `*.summary.json`）：**65 个会话**

| 指标 | 值 |
| --- | --- |
| 中位 | **847.8 KB** |
| p90 | **1,937.4 KB** |
| 最大 | **3,044.5 KB** |
| 合计 | 65.8 MB |

⇒ 每次自动保存都是一次 **0.8–2 MB 的整份重写**（外加一次同量级的读），一个回合里会被触发数十次。
这就是 `writeMs` 与 `authorityMs` 各占约 30% 的解释，也是「写不动/善后慢」的真实来源。

## 四 结论与下一单元

1. **本轮的队列合并方案被数据否掉，已撤回**（未提交、未推送）：它只能改善 159 条里那 3 条
   `queuedMs > 500 ms` 的情形，却要放宽「中间状态何时变得耐久」这条语义 —— 代价换来不可见的收益。
2. **下一单元（已定死，判据可执行）**：**按内容增量写 + 善后按需**。
   - 现状：整份 JSON 重写；读取端（`loadSessionWithDiagnostics`）同样整份读。
   - 目标形状：消息追加日志（append-only）或按 `filesRevision`/消息游标的分块写，压缩后仍是同一份可读
     JSON；**读取路径必须继续读出同一份权威文档**（不许出现第二套真源）。
   - 验收判据（真机，可复算）：同一批操作重放后 `writeMs` 的中位与 p90 落进基线的一半以内，且
     `authorityMs` 不上升；会话文件仍可被现有读取器逐字解析（用应用自己的读取器验证，不新写解析器）。
   - **不做**：加大阈值、减少保存次数（那是拿掉用户的数据安全边界换数字）。
3. **本轮落地的只有归因那一半**：善后段再劈成 `provenanceMs`（证据快照）与 `fileIndexMs`（文件索引）
   两段，`aftermathMs` 保持旧含义（落盘之后的总量）⇒ 新旧读数仍可比。这是本单元唯一进入产品代码的改动。

## 五 边界（不许读成更强）

- 样本是**已安装的打包版**（用户日常使用），不是本次未发布的构建；慢行的字段集合与当前代码一致，
  所以分段可比，但**不能把本读数当成某个特定提交的 CI 读数**。
- 159 条只统计**超过 200 ms 的尾部**：它说明尾部花在哪，**不说明**有多少比例的保存慢（分母没有记）。
  分母需要渲染层的保存计数，那是另一条读数（P0-9 同族口径）。
- 65 个会话是**这台机器的一个数据根**，不代表所有人；体积分布用于**定形状**（整份重写是否合理），
  不用于对外宣称任何平均值。
