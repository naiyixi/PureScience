# 解释器探测的记忆化：`notebook:list-runtimes` 的 3.8 s 中位里，绝大部分是重复起的子进程

日期：2026-11-02 · 执行器单元（§二百七十八）

## 一 这份证据回答什么

真机日志里 `notebook:list-runtimes` 的中位耗时是 **3,777 ms**（66 次，最大 21,926 ms），是所有「读」类通道里
最慢的一个（同一次会话的 `notebook:state` 只有 168 ms 中位）。本单元先把「慢在哪一段」量出来，再只改那一段。

## 二 量（真机日志 + 生产函数的本机读数）

### 2.1 日志读数（`~/Library/Logs/PureScience/` 三份，窗口 2026-10-28T10:22Z → 2026-11-01T02:32Z）

| 项 | 读数 |
|---|---|
| `notebook:list-runtimes` 慢行 | **66 次**，中位 **3,777 ms**，p90 6,000+ ms，最大 **21,926 ms** |
| 归因 | `inconclusive` 44 · `no-cpu-in-process` 14 · `cpu-bound-in-process` 8 |
| 其中「进程没在花 CPU」合计 | **58/66（88%）** ⇒ 时间花在等进程外的东西（子进程、磁盘），不是算 |
| 相邻两次调用间隔 | **37/65 段 ≤ 10 s**（一次面板打开就是一阵）、1 段 ≤ 60 s、其余更久 |
| 同族对照 | `notebook:state` 中位 168 ms（同一个 `ensure()` 前置，差的就是 discovery） |

对照的关键在于后两行：同一个 `ensure()` 前置的 `notebook:state` 只要 168 ms，而 `list-runtimes` 是它的 22 倍，
差的只能是 discovery；而归因说这段时间没有 CPU（在等子进程）。**每一条读数都指向「每次读都重新 spawn
一遍 `<interp> --version`」**。

### 2.2 生产函数本机读数（真实运行时根 + 真实解释器，`discoverInterpreters` + `defaultDiscoveryDeps`）

改动前（同一台机器、同一份代码路径、同一份数据根）：

| 语言 | 解释器数 | 首轮 | 紧接着的第二轮 |
|---|---|---|---|
| python | 28 | 196 ms | 76 ms |
| r | 1 | **818 ms**（其中约 500 ms 是 `Rscript` 起一次看 jsonlite） | **523 ms** |

改动后（同一个探针脚本，加 `clearInterpreterProbeCache()` 区分冷热）：

| 语言 | 行数 | 首轮 | 第二轮 | 第三轮 |
|---|---|---|---|---|
| python | 28/28/28 | **388 ms** | **46 ms** | 47 ms |
| r | 1/1/1 | **892 ms** | **41 ms** | 38 ms |

- **行内容逐字相同**（`JSON.stringify(cold) === JSON.stringify(warm)` 为 true），行数一致 ⇒ 记忆化没有改列表。
- 第二轮剩下的是**枚举**（`which -a`、已知目录 `existsSync`、32 个候选各一次 `realpath`），那部分按要求保持新鲜。
- 首轮没变慢也没变快：本单元不动「第一次清点」的成本（那要削减探测项，是另一单）。

## 三 交付

| 位置 | 改动 |
|---|---|
| `src/main/notebook/interpreter-probe-memo.ts`（新） | 一份**有界**的探测记忆：键 = 探测种类 + 解释器路径，值 = 答案 + 该二进制自己的指纹（mtime+size）+ 时刻。每次读都**重新 stat** 一次指纹（换了解释器立刻不命中）；**stat 不到就不记**（没有可比对的东西可失效）；**否定答案也记，但同样只有有限龄期**；同一键的并发探测**合并**而不是各起一次。带上限（512 条）防止长跑进程无界增长。 |
| `src/main/notebook/environment-discovery.ts` | `defaultDiscoveryDeps` 的 `probeVersion` / `rRunnable` 走这份记忆；导出 `clearInterpreterProbeCache()`。**枚举一个字节没改**（env 目录被删掉，下一次读仍然看不见它 —— 那是由目录判断的，不由这份记忆判断）。 |
| `src/main/notebook/package-operations.ts` | 装包（`manage`）结束后清空记忆（`finally`，失败也清：装了一半也会改环境）。用例：一行「Needs jsonlite」是从 `Rscript` 探测来的，不是从包列表来的。 |
| `src/main/notebook/environment-management.ts` | 建环境 / 删环境 / 从锁导入（成功与「incomplete」两种终态）都清空记忆。 |
| `src/main/notebook/interpreter-probe-memo.test.ts`（新，8 例） | 命中、换指纹即失效、超龄即失效、stat 不到不记、否定答案有界、并发合并、`clear` 全忘、条目上限。 |
| `src/main/notebook/environment-discovery-probe-memo.test.ts`（新，2 例） | **接线那一半**：生产 `defaultDiscoveryDeps().rRunnable` 连续两次只起一次 `Rscript`；把解释器文件换掉（`utimes` 抬 mtime）后立刻重新探测。 |

## 四 边界（不许读成更强）

1. **第一次调用仍然要清点**（本机 1.3 s，负载下日志里是 3–4 s）。本单元只拿掉「同一批解释器在 60 s 内被
   反复 spawn」这一段；把首轮也压下来要削减探测项或换探测手段，未立项。
2. **龄期是 60 s**：这期间内如果环境被换成了一个「内容变了但 mtime 与大小都没变」的二进制（本机不可能由正常
   安装产生），列表会沿用旧答案。正常升级/替换会改 mtime，`utimes` 那一例就是钉这条。
3. **只覆盖两处探测**（版本、R 的 jsonlite）。`packages` 清单、环境体积这些都不在记忆里。
4. **读数来自本机 + 生产函数，不是窗口读数**：没有在用户正在跑的实例上重启验证（不动在用实例是纪律）。
   窗口侧读数是日志里那 66 条慢行，前后对照要等新版本跑起来才拿得到 —— 这一点在汇报里如实写明。
5. `rRunnable` 的 500 ms 是 `Rscript` 冷启动本身就贵，记忆化只保证「不重复付」，不代表它变快了。
