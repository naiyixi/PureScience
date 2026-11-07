# 诊断包里的空闲内核 CPU：第一次从**真内核**读到 `status=samples`

日期 2026-11-07（执行器轮次）。单元：`feat(diagnostics): 空闲内核的 CPU 读数随诊断包离机`（提交 `08efb017`）。

## 一 上一轮留下的那一格

`08efb017` 落地时，真窗口认证 spec（`support-bundle-export-readback`）读到的是
`status=monitor-not-started`——那是**诚实**的：那支 spec 不跑任何 notebook，段里没有内核可看。
单元测试证明的是「两个累计 CPU 读数会算成一个窗口」，不是「用户手上那份诊断包里真有一个窗口」。
缺的那一格就是本文补的。

## 二 取证方式（不经 agent 回合）

新认证 spec：`e2e/certification/support-bundle-kernel-cpu.spec.ts`

1. 隔离实例里落一条会话（`sessions.saveSession`），`runtime.listEnvironments()` 挑一个可运行 python，
   `runtime.setEnvironmentEnabled` 打开（这就是设置页「运行时」写的那道闸）；
2. `notebook.bindRuntime` → `notebook.execute` 跑 `print("kernel cpu probe")`——**同一对通道**界面调的那两个；
   不起 agent、不要 provider：被测的是主进程的采样环，与谁派的这个 cell 无关；
3. 等 **35 s**（采样间隔 15 s，且**第一拍只取基线**，第二条记录才是一个完整窗口），走设置页
   「导出诊断包」按钮（只桩掉系统保存对话框），解压后读 `diagnostics/notebook-kernel-cpu.json`。

## 三 读数（两次独立运行，都是真机）

```
[kernel-cpu] kernel started: runtime=~/<旧布局>/runtime/envs/default-python/bin/python3.12
             run=notebook-run-1794015096997-1 status=completed
[kernel-cpu] attempt 1: status=samples, monitor=running, observed=1, latest=1, reasons=(none)
[kernel-cpu] newest window per kernel: pid=97496, cpuPercent=0, windowMs=14993, spinning=false, env=default-python
1 passed (1.1m)
```

```
[kernel-cpu] kernel started: runtime=~/.hermes/tools/python-3.14.9+202****1021-darwin-arm64/bin/python3.14
             run=notebook-run-1794015198241-1 status=completed
[kernel-cpu] attempt 1: status=samples, monitor=running, observed=1, latest=1, reasons=(none)
[kernel-cpu] newest window per kernel: pid=723, cpuPercent=0, windowMs=14996, spinning=false, env=default-python
1 passed (46.1s)
```

要点：

- `status=samples` 且 `observed=1`、`latest=1` —— 段里真有窗口，不是空段配一句「采样过」；
- `pid` 是真进程号（97496 / 723），`windowMs≈15 000` 与采样间隔一致（窗口宽度是量出来的，不是常量抄的）；
- `spinning=false` 且 `cpuPercent=0`：空闲内核确实没烧核，这与本档另一处「真忙循环子进程读到 >50%」互为两向；
- `monitor=running`：导出那一刻采样器还活着（不是「曾经跑过」）。

## 四 会咬人的两处（记下来）

1. **本机有真 `opencode`（`/opt/homebrew/bin/opencode`），e2e 的假 agent 只在这台机器上没有真货时才生效**：
   首启检测把真路径写进 `settings.opencodePath`，之后 `configureFakeAgent` 重启仍按那个路径起进程，
   于是 prompt 打到假 provider（`127.0.0.1:9`）→ 整回合 `Cannot connect to API`。
   这正是「不经 agent 回合」的第二个理由（第一个是：被测对象是主进程的采样环）。
2. **运行时要先启用**：`notebook.bindRuntime` 对未启用/未知运行时是**具名拒绝**
   （`"…" is not an enabled python runtime …`）。先 `listEnvironments` + `setEnvironmentEnabled`，
   再 `listRuntimes` 取 `runtimeId`——跳过这一步会读成「产品不支持」。

## 五 边界（不许读成更强）

- 本文只证明**导出侧**：真内核 + 真采样窗 + 真诊断包段。`spinning>50` 的判定路径由 `kernel-cpu-ring`
  的单测与本档另一处的真忙循环探针覆盖，本 spec 不重复。
- 机器上没有可运行的 python 时，这支 spec 以**具名原因 skip**（不是红、也不是绿）：`test.skip` 的句子
  就是「这台机器起不了内核」。
- 采样窗口的宽度与间隔都由产品常量决定（15 s）；本 spec 为等第一条记录用固定 35 s 睡眠，
  失败时最多再导出两次——每次都是真导出，数字只从归档里读。
