# 内核空闲却在烧一个核：PyMOL 的无 GUI 循环被我们自己的内核兜住了

**一句话**：一个 `import pymol; pymol.finish_launching([...])` 的 cell 之后，Python 内核**没有请求在飞时仍占 97.6% CPU**；
本机两个内核就这么各转了一个半昼夜，把宿主 load 顶到 20 以上——用户说的「整个机器卡」有一部分就是它。
修在内核里（每个 cell 结束时兜底），同一场景从 **97.6% → 0.0%**，后续 cell 里 PyMOL 仍可用。

## 一 怎么发现的（只读真机读数，2026-11-06 14:5x）

起因是「卡」的归因：先按日志聚合，再看进程。日志（`~/Library/Logs/PureScience/main*.log`，11-04 起 25,549 行）里
`event loop stalled` **1,156 次**、窗口 p50 1,550 ms、p90 4,100 ms，`attribution` 65% 是 `no-cpu-in-process`，
`cause.kind` 86% 是 `unexplained`——都不是我们主进程算出来的。于是去看进程表：

```
  68591   45101    4MB  94.4  15:36:46  /Users/totota/.purescience/runtime/envs/default-python/bin/python …/PureScience.app
  20422   45101    4MB  94.4  16:04:53  /Users/totota/.purescience/runtime/envs/default-python/bin/python …/PureScience.app
```

两个**内核进程**各占近一个核，已跑 15–16 小时。宿主侧同时读到的量（同一分钟）：

| 读数 | 值 |
|---|---|
| `vm.loadavg` | 12.87 / 13.38 / 11.88（日志里同一现象的最大值 `loadAvg1mMax` = **142.66**） |
| `vm.swapusage` | 已用 **8,655 MB** / 10,240 MB |
| `vm_stat` 空闲页 | 4,070 页 ≈ **65 MB**（页大小 16 KB） |
| 内核进程物理占用 | `sample` 报 physical footprint **471.9 MB**（峰值 731.2 MB），父进程 = `PureScience` |

日志面（同一窗口）另有 1,156 次事件循环停摆、`sessions:save-session` 慢 2,607 次（p50 108 ms / p95 1,535 ms /
max 46.6 s）、`session save was slow` 605 次——这些是**背景**，本单元不动它们；先修的是那两核。

## 二 根因：包自己把「永不退出」的条件置上了

`sample 68591 2` 的栈里，主线程 1,119/1,119 个样本停在 `read()`（空闲内核读 stdio，正常）；**第二个线程
1,119/1,119 个样本**是一条没有等待的调用链：

```
Thread_11330847
  pythread_wrapper → method_vectorcall → _PyEval_EvalFrameDefault
    → cfunction_call → Cmd_GetRedisplay (in _cmd.cpython-312-darwin.so)
      → PBlockAndUnlockAPI → PyObject_CallFunction → …（循环体内反复）
```

被调的那段在自己的 `pymol/__init__.py` 里（安装态 3.1.0，本机运行时环境）：

```python
def _launch_no_gui():
    p = pymol2.SingletonPyMOL(); p.start()
    while (p.idle() or p.getRedisplay() or
            invocation.options.keep_thread_alive or      # ← finish_launching 自己把它设成 1
            cmd.get_modal_draw() or cmd.get_setting_int('keep_alive') or ...):
        p.draw()                                          # ← 循环体没有任何等待
```

`finish_launching()` 里先 `invocation.options.keep_thread_alive = 1` 再起这个线程 ⇒ **条件恒真**，`p.draw()` 空转。
没有显示可驱动时它永远不会阻塞，于是每进程一核、直到进程结束。包自己的启动文档把这种线程式启动标为
macOS 上不支持，所以这一侧只能由我们兜。

## 三 复现（跑的是产品自己的内核文件，不是仿写）

探针：`resources/notebook/python_loop.py` 起一个真内核（用应用运行时那支 `default-python/bin/python`），
灌一个 cell，然后用 `ps -o cputime` 的**增量**除以墙钟算利用率（macOS 的 `ps -o %cpu` 是生命周期平均，不可用）。

| 场景（cell 内容） | 空闲窗口 | CPU 增量 | 利用率 |
|---|---|---|---|
| `import pymol; pymol.finish_launching(['pymol','-cq'])` | 5.0 s | 4.94 s | **97.6%** |
| 同上，随后清 `keep_thread_alive` | 5.0 s | 0.00 s | 0.0% |
| 同上，随后只把 `pymol2.SingletonPyMOL.draw` 封顶 20 Hz | 5.0 s | 0.01 s | 0.2% |
| 对照：`pymol2.PyMOL()` + `start()` + `stop()`（包推荐的进程内用法） | 5.0 s | 0.00 s | 0.0% |

第四条说明这不是「PyMOL 一定慢」，而是**那一条启动分支**的问题；前两条说明两种兜法都能把 CPU 拿回来。

## 四 交付

`resources/notebook/python_loop.py` 新增 `_apply_idle_loop_guards()`，在 `_run()` 的 `finally` 里调用
（cell 抛错也照样执行；`KeyboardInterrupt` 的软超时路径同样覆盖）：

1. 只在 `sys.modules` 里**已经有** `pymol` 时才动手（没导入过的内核每 cell 只多一次字典查找）；
2. 清 `invocation.options.keep_thread_alive` ⇒ 循环自己收尾（实测会话仍活：后续 cell 能 `cmd.fragment()`、
   `cmd.count_atoms()` 得 10 个原子、`cmd._COb is not None` 为真）；
3. 万一还有别的条件让它继续转，就把 `pymol2.SingletonPyMOL.draw` 封顶 20 Hz（幂等，带 `_purescience_throttled` 标记）。

**放在 cell 末尾而不是 import 时**，是因为：只 import 不 launch 的 cell 不该被碰；而 launch 之后到 cell 结束这
一小段里，兜底一落地循环就收尾（实测同一 cell 内清标志也立即生效）。

## 五 修复后的同一场景（真内核，同一支解释器，本机）

```
cell1 stdout='LAUNCHED'  err=''                 ← 只有 import + finish_launching，没有任何手工兜底
cell2 stdout='ATOMS 10 SESSION True' err=''     ← PyMOL 仍然可用，会话没被拆掉
IDLE util=0.0%  (delta=0.00s over 8.0s)         ← 修前同一场景 97.6%
```

## 六 门禁

| 环 | 读数 |
|---|---|
| 新增源码契约用例 `src/main/notebook/kernel-idle-loop-guard.test.ts` | 3 passed（防「守卫被静默删掉/挪出请求路径」） |
| 真内核集成用例（`RUN_KERNEL=1 PURESCIENCE_TEST_PY_ENV=…`） | 6 passed（含新增 1 例：桩包设标志 ⇒ 下一条请求读到 `KEEP 0` / `CAPPED True`） |
| 定向 + 全量 vitest / 双 typecheck / eslint | 见提交信息与 §八 读数 |

顺带修了这条集成套件自己的仪器错：内核早先加了「执行已开始」的首帧（同一个 `req_id`、没有结果字段），
而测试的 `startLine` 助手按 `req_id` 直接 resolve ⇒ **6 条用例全部读到首帧、`error` 是 `undefined`**。
现在助手跳过这种确认帧。这条错不是本轮引入的（首帧是 11-05 的提交加的），但**它会让这条套件永远假红**，
所以同批修掉；判据是「6 passed」，且断言本身没有被放松（仍然逐条比对 `stdout` 与 `error`）。

## 七 边界（不许读成更强）

1. **只治这一支**：清的是这个包自己的循环标志 + 封顶它的 draw。别的库若自己起忙等线程（无标记可清、无函数可换），
   这里一分钱也不管——那种情况需要的是下面的观测，不是更多的白名单。
2. **主进程没有「空闲内核在烧 CPU」的观测**。这次是读日志 + 看进程表才发现的，应用自己不会说。立为下一单元候选：
   判据 = 内核无在飞请求时采样其 CPU，连续两次 >50% ⇒ 一条具名日志（含 pid、CPU、持续时间），并让运行状态里能看见。
   本轮不做，是因为要在主进程加通道/计数面，连锁远大于本笔。
3. **本机现存那两个仍在转的内核我没有动**：它们是用户正在用的应用里的进程，杀掉会丢用户会话的命名空间。
   给用户的一句话：在应用里重启对应内核（或重开会话）即可当场释放两个核；本笔之后即使再次 launch 也不会再复现。
4. 探针的两个「人工兜底」对照（清标志 / 封顶）各自的数据只说明**单用**也够，产品里是两者叠加；
   叠加后实测 0.0%，但我没有单独跑「叠加 vs 只用清标志」的差值——两者都在噪声地板附近，不构成可分辨的读数。

## 八 复算

```bash
# 1) 进程面：谁在烧（%cpu 列是生命周期平均，看 Top 的瞬时值更准）
top -l 1 -n 10 -o cpu -stats pid,cpu,mem,command | tail -12
# 2) 栈：那个线程在干什么（换成真实 pid）
sample <pid> 2 -file /tmp/sample.txt && grep -n "Thread_\|Cmd_" /tmp/sample.txt | head
# 3) 产品路径复现（96% 上下为复现成功；修后应 ~0%）
RUN_KERNEL=1 PURESCIENCE_TEST_PY_ENV="$HOME/.purescience/runtime/envs/default-python/bin/python" \
  npx vitest run src/main/notebook/python-loop.integration.test.ts
```
