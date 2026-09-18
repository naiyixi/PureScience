# U5：装了"阻塞 vs 等待"的判别仪器；本轮**驱动失败**，无样本可报

- 日期：2026-09-18
- 实例：`electron-vite dev` 带窗口，独立端口 44105 / 独立 profile / CDP 9336；语料＝真实数据根副本

## 一、仪器（已随提交落地，产品代码 + 用例）

新模块 `src/main/diagnostics/event-loop-latency.ts`（`perf_hooks.monitorEventLoopDelay`，分辨率 20 ms），导出 `resetEventLoopLatency()` / `readEventLoopLatency() → {maxMs,meanMs,p99Ms}`。

它回答的是 U4 无法回答的那个二元问题：

| 观察 | 结论 |
|---|---|
| 操作用了 340 ms，**其间事件循环延迟也 ~330 ms** | 主线程**被阻塞**（同步工作/同步等待） |
| 操作用了 340 ms，**其间事件循环健康（几 ms）** | 这是一次**真正的异步等待**（引擎往返 / 文件系统），不是卡住进程 |

已接入两处：`ManagedPreviewResources.acquire`（慢调用报告里附加 `maxMs/meanMs/p99Ms`）与 `project-files listFiles`（同一路径交叉验证）。`ManagedPreviewResources` **静态核对无任何锁/队列**（`resources`/`releasedOwners` 都是 Map），所以"注册表串行点"这条候选在代码层已排除。

## 二、本轮结果：0 个样本（驱动失败，不是现象消失）

驱动只点到 4 行、且"文件面板"导航点击**超时失败**（`clicked: false`）⇒ 应用停在首页，那 4 次点击落在首页元素上。

**证据**：本次运行日志里 **`preview-resources:acquire` 一次都没有出现**（连 IPC 慢通道清单里也没有），`grep -c preview` 仅 3 行；`project-files:list-files` 仍是启动期那 51 次。

⇒ 本轮**不能**说明"340 ms 不复现"，也**不能**给出任何事件循环数字。按纪律：**没有样本就不报结论**。

## 三、下一条动作（已具名，且是纯驱动问题）

把驱动做成**确定性**的：不做"按名字找面板按钮 + 按文本点行"，改为
1. 先断言已进入文件视图（用 DOM 条件等待，而非超时），
2. 再用稳定选择器点一个**确定会出预览的产物行**（例如带 `mimeType` 图标的 artifact 行），
3. 断言预览已挂载（出现预览容器/iframe）后再计时。

这样"0 个样本"才能与"现象不存在"区分开 —— 本轮正是这个区分做得不好，已如实记档。

## 四、诚实边界

1. **本单元没有任何测量结论**；只有一个新仪器 + 静态排除一条候选 + 一次失败的驱动。
2. U1/U3/U4 的 370 / 163 / ~340 ms 仍各自成立，但都不是本次运行的数据。
3. 未做任何优化。
