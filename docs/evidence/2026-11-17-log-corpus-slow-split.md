# 语料报表要先切「谁的时间」：慢行的时间归属与停顿判词分组

- 单元：`scripts/log-corpus-attribution.mjs`（`npm run diag:log-attribution`）
- 日期：2026-11-17（执行器）
- 语料：打包版真实实例 `~/Library/Logs/PureScience/main.log`，8,092 行结构化记录（2026-11-09 → 11-16）
- 关联：本档只改**报表**，不改任何产品代码路径 ⇒ 无窗口读数（具名，见末节）

## 一 为什么改（一句话：那份 headline 会被读成产品缺陷）

工具的旧报表只给一个数：

```
slow rows: 1780 summed 6271859 ms  (real 1762 | fixture 0 | mixed 0 | unattributed 18)
```

6,271,859 ms ≈ **1 小时 44 分**。按字面读，这是「应用在自己的 IPC handler 里烧掉了一小时四十四分」，
而真正发生的是两件不同的事混在一个数字里：

1. 少数**长回合**（`acp:send-prompt` 一条 13–27 分钟，等模型与工具）——那是功能的形状，不是缺陷；
2. 机器**整进程停摆**的窗口（睡眠 / 换出 / 极端争用）——那段时间应用一行代码都没跑。

这两种都必须能分开，否则下一轮会照着这个数字去"优化保存路径"。实测分工如下（同一次运行）：

| 切法 | 行数 | 时间 |
| --- | --- | --- |
| 能切开（生产者写了 `heldMs`/`ownMs`） | 73 | own 5,133,738 ms ｜ held（循环没在跑）651,749 ms |
| 没有停顿窗口压在它上面（生产者**不写**这两个字段） | 1,707 | 486,374 ms，整段都是 handler 自己的 |
| 窗口环丢过覆盖（`heldUnmeasured: 'windows-dropped'`） | 0 | 说不出来，不替它选边 |

也就是说：**1,707 条"慢行"合计只有 486 秒（8 分钟）**；那 1 小时 44 分几乎全部来自 73 条长调用，
其中又有 4 条 `acp:send-prompt` 就占了 4,844,958 ms（13–27 分钟/条）。

## 二 改法（三个态 + 一个分组，字段早已在生产者的日志里）

`heldMs` / `ownMs` / `heldUnmeasured` 与 `cause.kind` 都已由主进程写好（见
`src/main/diagnostics/ipc-rejection.ts`、`loop-held-windows.ts`、`stall-cause.ts`），工具此前一个都没用。
现在：

| 报表项 | 判据 | 含义 |
| --- | --- | --- |
| `slow split` | 行上有有限 `heldMs` | 切成 own / held；`ownMs` 缺省时按 `durationMs - heldMs` 推出，且两者之和**永不超过**该实例的 summed |
| `noStall` | 行上没有 `heldMs` 也没有 `heldUnmeasured` | 生产者的**缺席即语义**：没有停顿窗口压在它上面（`heldSplitFromMeasured` 在 `rounded < 1` 时返回 `undefined`）⇒ 整段时长是 handler 自己的。与"没测"是两件事 |
| `dropped` | `heldUnmeasured: 'windows-dropped'` | 环已把这段覆盖丢掉 ⇒ 说不出来，具名而不并进任何一边 |
| `stalls` | 按 `cause.kind` 分组 + `lateMs` 合计 | `process-frozen` 单独累计：那一窗里**本进程没有任何线程在跑**，属于机器 |

`own` 有一句必须写在报表里的话：它只说「循环在跑」，**不说「在算」**——长回合天然有几分钟的 own，
要判是不是我们的 CPU，得回头看该行的 `cpuShare`/`attribution`。这句和三种态一起进了 read-me。

## 三 自检（钉住四件事，红了就说明报表在骗人）

`node scripts/log-corpus-attribution.mjs --selftest` ⇒ `selftest OK (… slow-row held split, stall verdicts …)`，退出 0。
新增 7 条夹具与断言：

1. 两条能切的（一条 own 由生产者给、一条只给 held ⇒ 余量推出）⇒ `splittable=2`、`held=1100`、`own=400`；
2. 一条切不开的 ⇒ `noStall=1` 且它的时长仍计入 `noStallMs=70`（不是丢进 own）；
3. 一条具名缺口 ⇒ `dropped=1`；
4. **不变式**：`held + own ≤ summed`（切开的两半不许比总和还大）；
5. 三条停顿行 ⇒ 按判词分组；`process-frozen` 的 `lateMs` 单独累计 2,000 ms；`lateMs` 合计 3,000 ms；
6. 停顿行**没有判词**时记 `unstated`，不许被算成任何已知判词；
7. 原四件事（借 run 判归属 / 三态含 mixed / 无 id 不算 real / 空输入）逐条复跑仍绿。

## 四 真机读数（`node scripts/log-corpus-attribution.mjs --log ~/Library/Logs/PureScience/main.log --top 6`）

```
[PureScience] rows=8092 info=4090 warn=3758 error=222 debug=22
  errors:
      203  uncaughtException
       12  unhandledRejection
        4  operation failed  (real 3 | fixture 0 | mixed 0 | unattributed 1)
        3  [Auditor] correction sendPrompt failed
  warnings:
     1780  ipc handler was slow  (real 1762 | fixture 0 | mixed 0 | unattributed 18)
     1176  event loop stalled  (real 1175 | fixture 0 | mixed 0 | unattributed 1)
      295  artifact version resolve was slow
      179  session save was slow
       55  tool call failed
       50  project files read was slow  (real 48 | fixture 0 | mixed 0 | unattributed 2)
    … 28 more family/families not shown (--top)
  slow rows: 1780 summed 6271859 ms  (real 1762 | fixture 0 | mixed 0 | unattributed 18)
  slow split: 73 row(s) split — own 5133738 ms | held (the loop was not running) 651749 ms;
              1707 row(s) had no stall window over them (486374 ms, the whole duration is the handler's)
  stalls: 1176 late 71454884 ms — unmeasured 1059 | cpu-in-process 57 | unexplained 57 | garbage-collection 3
```

`--json` 同步带上 `slow.split` 与 `stalls`（`splittable 73 / heldMs 651749 / ownMs 5133738 /
noStall 1707 / noStallMs 486374 / dropped 0`；`causes` 同上；`frozenLateMs 0`）。

那 73 条按通道分：`sessions:save-session` 30、`notifications:get-snapshot` 10、`reviewer:get-for-session` 8、
`cases:marketplace` 4、`acp:send-prompt` 4（这 4 条占 own 的 94%）、`preview-resources:acquire` 3。

## 五 边界与具名未办

1. **这份语料来自 2.26.0 安装版**：整进程冻结的判词 `process-frozen` 是 2026-11-14 才进主干的
   （`297d5b45`）⇒ 本语料里 66 条 >10 分钟的窗口仍记在 `unmeasured`/`unexplained` 名下，
   `frozenLateMs` 因此为 0。这不是工具缺陷，是**被读的构建没有那个判词**；下一份 2.27.0+ 的语料才能自证这一格。
2. **`own` ≠ 我们的 CPU**：4 条 `acp:send-prompt` 的 13–27 分钟是等模型/工具的回合时间。要判 CPU 得看
   行上的 `cpuShare`/`attribution`（本语料里 73 条中 52 条 `cpuShare > 0.5`）。
3. **`sessions:save-session` 的 181 s 与 57 s 两条落在同一段停摆窗口里**（10:30–10:38 UTC 的
   `late 40–129 s` 停顿，其中数条 `host.continuity: gapped`），是**后果不是成因**：181 s 那条自己的读数是
   `attribution: no-cpu-in-process`、`cpuMs 13.9 s`，也就是九成以上的墙钟里这个进程根本没在跑。
   这条不该按"保存路径慢"立案。
4. **无窗口读数**：本单元只动报表工具，不改渲染层、不改主进程行为 ⇒ 按纪律具名，不冒充真机 UI 读数。

## 六 下一轮第一步

- ① 用同一支工具读**下一份 2.27.0+ 的语料**，验证 `process-frozen` 真的把 66 条长窗归位（这是本档唯一的口径承诺）。
- ② 若那份语料里仍出现「`own` 大且 `cpuShare` 高」的行，才轮到按行去查那一条通道的同步工作——本轮证据不支持直接改保存路径。
