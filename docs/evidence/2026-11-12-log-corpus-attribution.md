# 日志语料的归属：先切开实例与会话来源，再报错误族

日期：2026-11-12。语料：本机六份 `main*.log`（打包版 `~/Library/Logs/PureScience/` 3 份 + 开发版
`~/Library/Logs/PureScience (DEV)/` 3 份），共 **87,547 行**结构化记录。

## 一 为什么需要这一步（实测代价）

按 `msg` 直接聚合（不看会话来源）得到的榜首是：

| 族 | 行数 | 级别 |
| --- | --- | --- |
| `review protocol incomplete`（"Reviewer stopped without calling submit_findings…"） | **2,670** | error |
| `ipc handler was slow` | 6,444 | warn |
| `event loop stalled` | 5,129 | warn |

2,670 条 error 看起来是一次全局性故障。逐行看 `runId`，它们**全部**落在开发版，且同一 run 的
`reviewer session started` 写着 `e2e-session-*` —— 那是认证车道用替身 agent 驱动的夹具会话，
夹具的约定就是**不调 `submit_findings`**。同一族在打包版三份日志里：**0 行**。

也就是说：不切归属，这套语料会把一条夹具约定报成产品缺陷（并据此立案），
而真正要看的几族（`session save was slow` 789 行、`artifact version resolve was slow` 595 行、
`egress target failed` 292 行）会被它埋在下面。

## 二 仪器：`scripts/log-corpus-attribution.mjs`（`npm run diag:log-attribution`）

四态归属，缺一不可：

| 归属 | 判据 |
| --- | --- |
| `real` | 行上（`sessionId` / `mainSessionId` / `appSessionId`）或它所在 run 里的会话 id 全部不是夹具 |
| `fixture` | 同上，全部以 `e2e` 开头（认证/夹具会话） |
| `mixed` | 同一个 run 里两种 id 都在场 ⇒ **不替它选边** |
| `unattributed` | 行上没有 id，同一 run 里也没有 ⇒ 说不出归属就没有归属，**不许默认成 real** |

两处判据都写进自检：`--selftest` 钉住「借 run 判归属」「两种 id 同在 ⇒ mixed」「无 id 的行是
unattributed 而不是 real」「空输入无实例」。空答案具名：`no-log-files` 退出 2、`no-rows` 退出 3、
用法错 1、自检失败 4 —— 一个什么都没读到的工具不许看起来像读完什么都没发现的工具。

实例只取自**文件所在目录名**（`PureScience` / `PureScience (DEV)`）：日志本身不带实例名，
目录名是唯一非推断的来源。

## 三 真实语料读数（`npm run diag:log-attribution -- --top 6`）

```
[PureScience (DEV)] rows=54405 info=47096 warn=2987 error=2694 debug=1628
  errors:
     2670  review protocol incomplete  (real 0 | fixture 2670 | mixed 0 | unattributed 0)
        8  child process gone          (real 2 | fixture 0 | mixed 0 | unattributed 6)
  warnings:
     1459  ipc handler was slow        (real 26 | fixture 982 | mixed 0 | unattributed 451)
      726  event loop stalled          (real 4 | fixture 38 | mixed 0 | unattributed 684)
  slow rows: 1459 summed 1334870 ms    (real 26 | fixture 982 | mixed 0 | unattributed 451)

[PureScience] rows=33142 info=20847 warn=12100 debug=122 error=73
  errors:
       20  [Auditor] correction sendPrompt failed
       20  artifact finalization attempt failed
       17  uncaughtException
  warnings:
     4985  ipc handler was slow        (real 4967 | fixture 0 | mixed 0 | unattributed 18)
     4403  event loop stalled          (real 4401 | fixture 0 | mixed 0 | unattributed 2)
  slow rows: 4985 summed 23792864 ms   (real 4967 | fixture 0 | mixed 0 | unattributed 18)
```

可直接读出的两件事：

1. **开发版的语料主体是认证夹具**：1,459 条慢 IPC 里 982 条属夹具、只有 26 条属真实会话
   （其余 451 条行上无 id 且所在 run 也无 id，两版共有）。任何把两版日志混在一起算中位数、
   算 p90 的分析，量到的主要是测试台。
2. **打包版的语料是干净的**：4,985 条慢行里 4,967 条判到真实会话、18 条无归属、0 条夹具。
   ⇒ 之前那些基于「六份日志合计」的读数不会因此作废，但**必须写明标的是哪一版**。

## 四 边界（不许读成更强）

- **这不是产品行为改动**：一行运行时代码都没有改，App 的运行、日志内容、判定语义全不变。
  它是分析侧仪器 —— 改的是「读语料的人会不会把夹具算成缺陷」。
- **说不出就说不说**：借 run 的判据只在**同一份文件**内成立（`runId` 跨文件不可比，轮转后
  同一个 run 的两端可能落在两个文件里）；跨文件的情形会落到 `unattributed`，而不是被判成
  `real` 或 `fixture`。
- **`mixed` 不是折中**：同一 run 里两种 id 都在场时，本工具不给结论。要不要把它读成故障，
  得回到那一段窗口里看具体是哪条会话产生的。
- **没有阈值、没有采样**：全量读每一行；行数、级别分布、每族四态计数都打印出来，读者可以
  自己按 `--top` 换深度。

## 五 复跑配方

```bash
npm run diag:log-attribution -- --selftest          # 自检：run 借用、mixed、unattributed、空输入
npm run diag:log-attribution -- --top 12            # 两版实例分开报
npm run diag:log-attribution -- --log <file> --json  # 单文件、机读
```
