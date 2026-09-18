# U1：首开顿挫里"等"的那一半 —— 按通道归因（真机 dev 实例，主进程计时）

- 日期：2026-09-18
- 实例：`electron-vite dev` 带窗口（主进程计时不受 dev 渲染层影响），独立端口 44105 / 独立 `--user-data-dir` / CDP 9336
- 语料：真实数据根副本（`/tmp/ps-bench-u1`，59 会话 + 产物树硬链；真实根未被指向）
- 仪器（本单元产品代码，已随提交落地）：
  - `application-command-router`：handler 计时，≥50 ms 报 `slow-handler`（带 `durationMs`）
  - `diagnostics/ipc-rejection`：**成功**路径也计时，≥50 ms 记 `ipc handler was slow`（带 `channel`/`surface`/`location`/`durationMs`）。**这是关键一处**：渲染层的会话与文件调用走 **Electron IPC**，**不经过**应用命令路由 —— 只给路由加计时是量不到的（我先踩了这个空）。
- 判据：每个通道有 ms；与渲染侧 idle 对得上

## 一、实测（一次启动 + 四个交互：开搜索面板 / 开会话 / 开文件面板 / 滚动）

**启动窗口**（30 条 slow 报告）

| 通道 | 次数 | 中位 | 最大 |
|---|---|---|---|
| `settings:get-preflight` | 1 | 808 ms | 808 ms |
| **`sessions:list-catalog`** | **2** | 489 ms | **489 ms** |
| `settings:npm-available` | 1 | 422 ms | 422 ms |
| `storage:get-info` | 1 | 216 ms | 216 ms |
| `settings:get-settings` | 1 | 212 ms | 212 ms |
| `project-files:list-files` | **23** | 131 ms | 137 ms |
| `settings:set-ui-language` | 1 | 103 ms | 103 ms |

**交互窗口**（105 条 slow 报告）

| 通道 | 次数 | 中位 | 最大 |
|---|---|---|---|
| `settings:check-environment` | 2 | 2760 ms | 2760 ms |
| `network:check-connectivity` | 2 | 2096 ms | 2096 ms |
| `settings:get-preflight` | 3 | 595 ms | 604 ms |
| **`preview-resources:acquire`** | **5** | 368 ms | **375 ms** |
| `sessions:list-catalog` | 2 | 268 ms | 268 ms |
| `settings:list-skills` | 2 | 228 ms | 228 ms |
| `settings:npm-available` | 3 | 139 ms | 199 ms |
| **`project-files:list-files`** | **79** | 95 ms | 148 ms |

**合计**：这趟（几乎什么都没干）里，主进程有 **135 次 ≥50 ms 的 IPC 调用，累计 25.3 s**。

## 二、结论（三条，都能落到具体通道）

1. **`project-files:list-files` 是频次之王：全程 102 次、每次 95–150 ms**。它不是偶发慢，而是**被反复调用**；用户在文件面板/产物相关界面上感到的"顿"与它同源。
2. **`preview-resources:acquire` 是幅度之最：5 次、每次 ~370 ms** —— 预览资源获取。它与打包版量到的"文件面板最差帧 431.7 ms"量级吻合，是那条 432 ms 帧最可能的等待对象。
3. **启动后第一次 `sessions:list-catalog` = 489 ms**（稳态是 23–68 ms）—— 因为启动协调那趟**持有数据根租约**（`withDataRootWrite`），列表读要排在它后面。

## 三、对第 1 条"方案 D"收口的更正（必须记）

我在 D 里写的判据是"**用户可见路径不受这趟影响**"，实测数据支持它在**稳态**成立，但**不覆盖启动窗口**：这次量到 **启动后第一次列表读 489 ms**（排队在协调那趟持有的租约后）。先前打包版量到的 65 ms 冷启动，是**应用已起来之后**才采的（就绪探测/隔了几十秒），因此没有覆盖这个窗口 —— 这是我的口径漏洞，不是那次数字错。

⇒ 正确的重开理由（比原来的"语料变大"具体得多）：**把数据根租约的粒度/顺序看清楚**——协调那趟是否需要全程持有它，或列表读能否在它之前被服务。这属于"该趟被放到用户可见路径上"的第 ② 类条件，**本条据此重新立案**。

## 四、诚实边界

1. dev 构建；打包版的同表未采（但 `preview-resources:acquire` ≈370 ms 与打包版 432 ms 最差帧量级一致，方向一致）。
2. 单次运行；用途是**指名通道**，不是分布比较。
3. 启动窗口/交互窗口的划分按日志位置（中点）切分，非精确时间戳对齐 —— 两个窗口的归属可能有个别错位。
4. 阈值 50 ms 是我选的（低于要解释的 130–430 ms 顿挫、高于常规读）；换阈值会改变"哪些调用被记录"，不会改变最慢的那些。
5. 未做：**没有**对任何通道做优化 —— 本单元只交付基线与归因（下一单元才有靶子与前后对照）。
