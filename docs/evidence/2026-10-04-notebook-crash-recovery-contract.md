# 笔记本崩溃恢复契约：一次真机取证，与它没测到的那一半 —— 2026-10-04

## 我原本要取什么

今晚修的徽章（`ff05c41c`）把「问题状态」按真实状态分说，其中一条是
**app-terminated 的中断不再被称作 error**。它**显示**的是记录里的状态，所以关键是**记录里到底写什么**。
契约写在 `src/main/notebook/repository.ts:271-287`：

> 「Crash recovery: **on the first load of a session in a fresh process**, any run still marked 'running'
> (or 'queued') was in flight when the previous process died — its kernel is gone, so mark it 'interrupted'
> with interruptionReason 'app-terminated'（**NOT failed** — the code may have been fine）」

## 取证过程（八次运行，前七次都在纠我自己的探针）

八次里前七次失败的成因**全部落在探针侧**，逐条记下来免得重踩：

| # | 现象 | 真因 |
| --- | --- | --- |
| 1–2 | 重启后 `runs: []` | 我**没传 `projectName`**；运行历史按 `(storageRoot, projectName, sessionId)` 解析（`repository.ts:80-85`），少一个字段就读到另一个根的空白历史 |
| 3–4 | 单元格「在跑」这个前提从没成立 | 我在**默认环境还在准备**时就发单元格——应用自己报的原文：「The Python environment is still being prepared — retry shortly.」 |
| 5 | `Invalid notebook path segment: Interrupted run` | 我的项目名**带空格**，被路径段校验拒 |
| 6 | 等环境就绪等到超时 | 我盯的是 `notebook.state.environments`——而它**在首次运行前按设计就是空的**（V6 诊断量到过 `BEFORE any run: []`） |
| 7 | 默认环境 15 次「still being prepared」 | 隔离实例的**默认环境要下载**才能就绪，本机网络到不了那些源；改走**缓存包导入具名环境**（本会话 V6 已验证单元格真能跑） |

**第 8 次**：前提终于被**实测**站住（`attempt 1: running=true statuses=["completed","running"]`），
然后读数是：

```
[interrupt] runJsonPath=…/notebooks/<projectKey>/e2e-session-1/run.json
[interrupt] cell is running; taking the app away (90s cell)
[interrupt] runs after restart: []                     ← 重启后 notebook.state 返回空
[interrupt] run.json on disk: [["…-1","completed",null],["…-2","failed",null]]
                                                       ← 盘上那格是 failed，interruptionReason 为 null
```

## 结论：一个待取读数，两个已确证的现象（不夸大、不掩盖）

**已确证（两条读数都在同一轮里、同一时刻）**：

1. **重启后 `notebook.state` 返回空运行列表**，而盘上 `run.json` 有两条记录 ⇒ 这次读取**没有加载该会话的历史**。
2. **盘上那格记的是 `failed` 且 `interruptionReason` 为 `null`** —— 与契约承诺的 `interrupted` + `app-terminated`
   **不一致**。

**由此可推、但尚未实测的一环**（这正是契约的触发条件）：
恢复只在「新进程里**首次加载**该会话」时跑（`repository.ts:271`）。而我的读法（`sessions.loadAll()` +
`notebook.state`）**明显没有触发那次加载**（否则读到的不会是空）。所以：
- 我**不能**说「崩溃恢复坏了」——**那次恢复很可能压根没跑**；
- 我也**不能**说「契约没问题」——因为我读到的盘上内容与契约不符。

⇒ **这一条是「未取」，不是「已证伪」**。要把话说完，下一次要取的读数是：**让面板真的打开该会话的笔记本**
（UI 路径，而不是 `notebook.state` 探针），再读盘——那时恢复应当已跑过，盘上应变成 `interrupted` +
`app-terminated`；若仍是 `failed`，那才是真缺陷。

**对我今晚那次徽章修复的反向影响（如实说）**：徽章修的是**显示**（记录说 interrupted 才说 interrupted），
这一点没变、也没错。但**如果**记录在某些路径上被写成 `failed`，读者看到的仍会是 error——**那条路径的
真机读数我这一轮没取到**。所以 `ff05c41c` 的结论文案应理解为「显示与记录一致」，而不是「中断在任何情况下
都不会被显示成 error」。

## 留下的东西（都可用）

- **脚手架不落树**（跑不绿的不算验收）：227 行的 spec
  `~/.hermes/cache/scratch/comp/notebook-interrupted-run.spec.ts` —— 缓存包导入 → 绑定 → 真跑单元格 →
  **实测前提** → 重启 → 读回状态**并读盘仲裁**。它现在**红在最后一条断言**上，而这条红是**真读数**
  而非探针故障；改一处（把「读状态」换成「UI 打开该会话的笔记本」）即可继续。
- `docs/evidence/2026-10-04-notebook-run-badge-status.md` 的「未取」一节由本份接续。
