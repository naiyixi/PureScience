# 空闲内核在烧 CPU：主进程侧的观测（只观测，不处置）

2026-11-06。上一单元（`35ecbcd1`）在 kernel 解释器里给 PyMOL 那类「初始化即起一个无 sleep 的
重绘线程」的包加了收尾守卫：cell 结束时清 `keep_thread_alive`、把重绘封顶到 20 Hz，同一场景
97.6% → 0.0%。那份守卫只能治它**点名认识**的包。本单元补另一半：**主进程自己看 CPU**，让下一次
「机器变慢」有一个带 pid 的读数，而不是靠猜。

## 一 这一格补的是什么（以及为什么不是自动处置）

- **观测**：每 15 s 对「有进程、还活着、且没有在飞请求」的内核采一次 CPU，连续两个窗口 ≥ 50%
  就在应用日志里落一条具名 warn，带 `key / kind / env / pid / cpuPercent / windowMs`。
  一次「空转」只落一行：继续烧不会每 tick 刷日志；回到阈值以下就重新武装，之后再烧会再报。
- **不处置**：不杀、不限流、不重启。cell 返回后自己起的后台线程可能是用户**真要的**计算，
  按 CPU 把它拆掉等于替用户否决一次分析。这里只把事实写下来。
- **谁定义「空闲」**：executor 自己的 `pending` 字段。这是唯一权威——定时器不许自己推断有没有
  在飞请求，`listIdleKernels()` 只在 `pending` 为空时才把那个内核交给观测器（`kernel-executor.ts`）。

## 二 为什么量 `ps -o time=` 而不是 `%cpu`

macOS 上 `ps -o %cpu` 是**进程生命周期平均**：5 分钟前开始空转的循环会被摊进一个小数字里，
看不出来。`time` 是**累计 CPU 时间**，两次采样之差除以窗口就是一整个窗口的真实占用。本机实测
（`yes > /dev/null`，`:~` 30 行探针脚本，输出原样）：

```
A=  0:01.58      # 起 2 s 后
B=  0:04.27      # 再 3 s 后 ⇒ (4.27-1.58)/3 ≈ 90% 单核
missing-pid: ps 退出码 1、标准输出空
```

pid 已退出时 ps 非零退出、输出为空 ⇒ 记 `probe-failed` 并丢掉基线，**绝不读成 0 ms**
（读成 0 会让一个死掉的内核永远显得「很乖」）。

## 三 真机读数（真内核进程 + 真 ps + 真日志文件）

一次性探针（跑完即删，未进仓库）：起一个真实 repl 内核，cell 返回后留一个每 tick 烧 40 ms 的
定时器（内核因此空闲却忙），用**真实** `ps` 探针与**真实** logger 写真实日志文件。日志原文：

```
{"t":"2026-11-06T09:41:49.107Z","level":"warn","scope":"notebook:kernel","msg":"notebook kernel idle spin detected",
 "runId":"a4338fa7-cec9-44bf-a01c-2246271d323c",
 "data":{"key":"repl","kind":"repl","env":"","pid":79142,"cpuPercent":82.4,"windowMs":255,
         "thresholdPercent":50,"consecutiveSamples":2,"action":"observed-only"}}
```

读法：`cpuPercent 82.4` 是这个最后烧了 40 ms/轮的进程在 255 ms 窗口里的真实占用；`action:
"observed-only"` 是记录的一部分——什么都没被限流或重启，读日志的人不必从「没有别的行」去推断。

## 四 边界（不许读成更强）

- **Windows 无探针**：记 `unsupported-platform`（每次运行一行 info），**不采样、不编数字**。
  该平台上这一格是具名缺态，不是「内核都很乖」。
- **没有 logger 就不跑**：`logger` 未注入时观测器不启动（读数没人能读＝白做）。生产由
  `runtime-service` 把 `notebook:runtime` 的 logger 经 `resolveDefaultExecutorOptions` 注进去。
- **界面未接**：这是一个日志级读数，没有面板徽标。用户侧仍要靠「机器变慢」这个体感进来；
  把这条读数做成运行状态可见（面板上一行「某内核空闲却占 82% CPU」）是下一单元候选。
- **不改既有语义**：`refuseInflightRuns`/`shutdown` 停止观测并丢掉基线；重启用新 pid 时取新基线
  （不拿重启前的累计值当窗口，否则会算出假的高占用）。
- 上一单元的 PyMOL 守卫仍然只有**装机版下一次发版**才进打包版；本单元的观测同样如此。

## 五 测试与门禁（全部实跑，读数原样）

- `src/main/notebook/kernel-idle-spin.test.ts` 12 项：三条 ps 文本形式与「读不出就是 undefined」；
  阈值/连续两窗/只报一次/静默后重新武装/非空闲不采样并丢基线/换 pid 取新基线/探针失败具名/
  windows 具名缺态；**真实探针对真实空转进程**（`process.execPath` 起一个 6 s 忙循环，实测
  `cpuPercent > 50`）；executor 接线两条（假探针 + 20 ms 窗口 ⇒ 一条具名 warn，且同一 executor
  随后仍能正常跑下一格；长 cell 期间 `probes === 0`）。
- 相关套件：`kernel-idle-spin` + `kernel-executor` + `session-lifecycle` + `runtime-service` +
  `runtime-service.architecture` = **5 文件 / 267 passed / 6 skipped，exit 0**。
- `runtime-service.architecture.test.ts` 的 1200 行上限仍成立（本单元 1199）：facade 只把 logger
  传给既有的 options 解析函数，没有在多行里加一行。
- `tsc --noEmit -p tsconfig.node.json --composite false`：exit 0（`NODE_OPTIONS=--max-old-space-size=8192`）。
- `eslint --no-cache` 本次五个文件：0 error（`kernel-executor.ts` 的两条 prettier warning 在
  `35ecbcd1` 上就已存在，`git show HEAD:` 那份同样不过 `prettier --check`，未顺手改，免得把无关
  hunk 卷进本笔）。
