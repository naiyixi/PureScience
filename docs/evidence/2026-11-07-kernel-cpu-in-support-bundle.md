# 空闲内核的 CPU 读数现在能随诊断包离机（2026-11-07）

> 上一单元（`292` 节，`fba913b9` + `35ecbcd1`）修掉了 PyMOL 刷新循环把空闲内核烧满一个核的**源头**，并补了
> 主进程侧的观测：一条具名日志 `notebook kernel idle spin detected {cpuPercent, pid, action:'observed-only'}`。
> 那条观测的**唯一**落点是日志行，而日志是有上限、会轮转的（本机到过 81 MB / 3.7 M 行；诊断包只按
> newest-first 复制 8 MB）。于是「机器变慢了、风扇一直转」这类报告最常见的形态——事后导出诊断包——恰好读不到
> 那条解释。本笔把同一批窗口做成机器可读的环，并作为诊断包的一节离机：**没有新通道、没有新 IPC、没有新文案**。

## 一 交付（4 处，全部在主进程侧）

| 位置 | 改动 |
| --- | --- |
| `src/main/notebook/kernel-idle-spin.ts` | 新增进程级环 `sharedKernelCpu`（`createKernelCpuRing` 可注入）：记录**每一个完成的采样窗**（不只是越线的），给 `observed` / `dropped` / `capacity`，另存**每内核最新一窗**（不受尾部轮转影响）；命名状态 `samples` / `no-samples` / `monitor-not-started` / `unsupported-platform` / `probe-failed` |
| 同上（监控器） | `KernelIdleSpinMonitor` 写入该环：每窗 `record`、探针失败与 `win32` 各记一次具名 reason、`start`/`stop` 记监控器状态 |
| `src/main/diagnostics/support-bundle.ts` | 新增**必填**段 `notebookKernelCpu` → 写成 `diagnostics/notebook-kernel-cpu.json`；`README.txt` 里加一节说明 |
| `src/main/ipc.ts` | facts 里加一行 `notebookKernelCpu: sharedKernelCpu.summary()`（与 `sharedSlowOperations` / `sharedIpcChannelLatency` 同一装配点、同样的进程级单例） |

三条设计取舍，都是被本仓既有教训逼出来的：

1. **安静窗也要记**。只留越线窗的话，`97.6%` 旁边没有任何可比的读数，"空闲时占用 12%" 这种半高占用就永远看不见。
2. **测不到不写 0**。`probe-failed`（pid 已退出 / `ps` 不可用）与 `unsupported-platform`（Windows 没有可移植的
   累计 CPU 探针）各自具名；`monitor-not-started`（一个内核都没起过，等于**没人看**）与 `no-samples`
   （看着，但还没凑满一窗）分开。把"没人看"读成"机器很安静"正是这类诊断最常犯的错。
3. **每内核最新一窗独立于尾部轮转**。本机常年 11 个内核，120 条尾部只覆盖约 3 分钟；"哪个内核在烧"必须活得比尾部长。

## 二 读数

### 2.1 真窗口（认证车道那条导出路径，本机 e2e 产物）

```
npx playwright test e2e/certification/support-bundle-export-readback.spec.ts --reporter=line
→ 1 passed (7.5s)
[ic37] the panel says: "Support bundle saved to …/storage/support-bundle.zip — 285.7 KB, 0 fields redacted"
[ic37] the bundle on disk: 292541 bytes
[ic37] kernel cpu section: status=monitor-not-started, monitor=never-started, observed=0, latest=0, reasons=(none)
```

即：**真窗口点「导出诊断包」→ 真归档 292,541 字节 → 解包后 `diagnostics/notebook-kernel-cpu.json` 确实在里面**，
内容是这一态该有的具名状态（该 spec 不跑 notebook，所以「没起过内核」是唯一诚实的答案，而不是一张空列表）。

### 2.2 真实探针 + 真实空转进程（`kernel-cpu-ring.test.ts`，非 win32）

真子进程（`process.execPath` 起 6 秒忙循环）+ **真的** `ps -o time=` 探针，窗口 250 ms：

- 环里出现 `spinning: true` 的窗，`cpuPercent > 50`，`pid` 即该子进程，`windowMs > 0`；
- `summary.status = 'samples'`、`latest` 恰好一条且就是该 pid。

这一条覆盖的是 2.1 没覆盖的那一半（`samples` 分支的真数值），也顺带证明环里的百分比不是替身算出来的。

### 2.3 单元层

`kernel-cpu-ring.test.ts` 9 项：安静窗与越线窗都记、`dropped` 计数、每内核最新窗跨轮转存活、`probe-failed`
不写 0、`monitor-not-started` → `running` → `stopped` 三态、`win32` 具名、非有限百分比被丢弃、summary 交出副本。
`support-bundle.test.ts` 新增 2 项：段随包存在且内容按真环形写出；空态写明 `monitor-not-started`。

## 三 门禁（隔离工作树 `/tmp/ps-cron-kernelcpu` @ `af2e77e6` + 软链 node_modules）

| 环 | 读数 |
| --- | --- |
| 定向 vitest（环 + 监控器 + 诊断包 + 命令 owner） | 4 files / **50 passed**，exit 0 |
| `tsc --noEmit -p tsconfig.node.json --composite false` | exit 0 |
| `tsc --noEmit -p tsconfig.web.json --composite false` | exit 0 |
| `eslint --no-cache`（6 个改动文件 + 认证 spec） | **0 error / 0 warning**（新文件先跑 prettier 修掉 6 条格式 warning） |
| `npm run build:e2e` | exit 0，`✓ built in 41.16s` |
| 全量 vitest | 见汇报（本笔提交前跑的那一轮） |

## 四 边界（不许读成更强）

- **真窗口那条路径只覆盖到"命名空态"**：一次带内核的真机导出（`status=samples` 且带真 pid/百分比）**没有**在打包版
  窗口里跑过 —— 它需要先起内核、再等 ≥1 个 15 s 采样窗，这一轮没做。`samples` 分支由 2.2 的真探针 + 真子进程覆盖，
  但要声称"用户在真机上导出时看得到内核数字"，还差这一条。
- **仍然只是观测**：不杀、不降频、不重启（理由在 `kernel-idle-spin.ts` 文件头：cell 返回后自起的后台线程可能是用户
  真要的计算）。回收策略仍属需拍板项。
- **Windows 没有探针**：`unsupported-platform` 具名，不采样、不编数字。
- **对用户不可见**：诊断包要用户主动导出。把它做成面板一行（"某内核空闲却占 N% CPU"）需要新通道 + 九语言，连锁
  约 30 处；本轮按"连锁最小"选了诊断包这条既有出口，面板入口**没做**，具名留待拍板。
