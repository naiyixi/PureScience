# 「写日志」把应用自己写成了 54 次系统故障：控制台管道关了之后的 EPIPE

> 执行器单元，2026-11-10 06:3x–。数据源：本机打包版自己的日志 `~/Library/Logs/PureScience/main.log`
> （2.26.0，`isPackaged: true`，Electron 43.7.5）。全程只读该日志，不写真实配置根。

## 一 开工核对（防重做 + 并发 + 该谁做）

- `origin/main = cb047dd2`；本轮第一件事是把上一轮挂着的判决取到手（完整 40 位 SHA 现查）：
  `cb047dd2` 的 `Windows Full Test` = **success**、`Nightly` = **success** ⇒ §三百 §五 ① 收口。
- 共享工作树 `git status --short` 只有三份**不是我的**未跟踪证据档（`2026-11-01-reviewer-fix-loop-double-review.md`、
  `2026-11-04-file-ocr-branch-name.md`、`2026-11-04-upload-probe-availability.md`）⇒ 不碰、不提交。
- 队列 B 段（A7 ✅ / S3 ✅ / M2 ⛔ 卡产品决定）仍无可做项；§299 §四 ② 那条真机窗口读数**仍被资源闸门挡着**
  （`vm_stat` 空闲页 5,680 × 16 KB ≈ 89 MB、`vm.swapusage` 7,372 / 8,192 MB 已用）⇒ 本轮取一个**不需要起窗**的单元。

## 二 单元从哪来：先量真机日志，再只查被点到的那一处

把 `main.log`（5,347 条，2026-11-09 一整天）按 `level|scope|msg` 聚合，11 条 `error` 里有一族形态完全一致：

```
54  error  main  uncaughtException  {message:"write EPIPE", frame:"afterWriteDispatched (stream_base_commons:159:15)"}
```

折叠记录的 `firstAt=16:17:47.635Z`、`lastAt=16:27:10.648Z` ⇒ **54 次发生在同一个十分钟窗口里**。

**归因读数（这是本单元的关键一步）**：把同一窗口的全部记录数出来 —— **56 条**（其中 3 条是折叠后的 EPIPE 记录本身，
代表 54 次原始事件，其余 53 条是正常 info/warn）。也就是**几乎每写一条日志，就多一次 EPIPE**。
窗口内没有任何会话/回合活动（无 `acp` 记录、无用户操作），所以这不是某条业务路径，而是**每行日志都会碰到的那条路**。

读源码把这条路定死：

- `src/main/logger.ts` 的 `emit()` 默认 `mirrorToConsole: true`，每条记录都调一次 `console[level](…)`；
  主进程的 `console.*` 写的就是 `process.stdout` / `process.stderr`。
- Node 的这两个进程级流**默认没有 `error` 监听器**；读端消失（起它的终端退出、监督进程关掉管道）之后，
  下一次写会在这条流上抛 `EPIPE`，而**未处理的流 `error` 会被 Node 重新抛成进程级 `uncaughtException`**。
- 那个 `uncaughtException` 落进 `index.ts:245` 的 `createProcessFailureCapture`，按 `errorCategory: 'system'`
  记一条 error 级记录 —— 于是「日志写不出去」被记成了「应用出系统故障」，一次一条，共 54 条。

**同类先例**：`crash-diagnostics.ts` 的头注记着 10-01→10-10 的 1,481 条 `uncaughtException`（1,344 network / 137 system）
也是同一类「不具名、不成比例」的噪声。`egress-proxy.ts` 在 10-23 修过一次同族的 `write EPIPE`（tunnel socket 无监听器），
本单元是它的**另一条入口**：不是 socket，是控制台流。

## 三 交付（2 产品文件 + 1 新模块 + 1 测试文件）

| 位置 | 改动 |
| --- | --- |
| `src/main/console-pipe-guard.ts`（新） | `createConsolePipeGuard({ stdout, stderr, onPipeClosed })`：给两条进程级流挂 `error` 监听；**每条流只报一次**（一串失败是一个事实，不是 N 个）；`code` 缺席时报 `no-code`（不静默丢）；`install()` 可重复调用（不叠监听器，两个 guard 是两个独立订阅者）；`isBroken()` 供调用方查询 |
| `src/main/logger.ts` | 新增 `suppressConsoleMirror()`：此后**不再镜像到控制台**，文件记录照旧；只关不开（一条已经失败的流不值得再写，开回去等于把刚修掉的东西装回来） |
| `src/main/index.ts` | 在已有的进程级失败捕获旁边装上 guard；回调里**先**关镜像、**再**记一条 `warn`：`console output pipe closed` + `stream` / `code` / `message` / `consequence: 'console-mirroring-disabled'` —— 一条关于死管道的记录，自己不能再写进那条死管道 |

**为什么不是「吞掉所有 uncaughtException」**：guard 只监听这两条流；其余任何来源的异常仍原样进 crash-diagnostics。
**为什么保留一条日志**：读端消失是真实事件（可解释「为什么此后没有控制台输出」），但它不是故障。

## 四 门禁（全部实跑，读数取自最后一次改动之后）

| 环 | 读数 |
| --- | --- |
| `vitest run src/main/console-pipe-guard.test.ts` | 1 文件 / **8 passed**，exit 0 |
| 受影响簇 `src/main/logger.test.ts` + 本文件 + `crash-diagnostics.capture.test.ts` + `src/main/diagnostics` | **29 文件 / 294 passed**，exit 0 |
| `tsc --noEmit -p tsconfig.node.json --composite false`（堆 4096） | exit 0 |
| `tsc --noEmit -p tsconfig.web.json --composite false` | exit 0 |
| `eslint --no-cache`（本批 4 文件） | **0 error / 0 warning**（先跑 `prettier --write` 本批两个新文件） |

**变异自证（改完即还原，各跑一遍）**：

1. 把 guard 的监听从 `'error'` 改成 `'close'` ⇒ 6 条用例红（6 failed / 2 passed）；仍绿的恰好是「镜像抑制」那条与
   「真管道」那条 —— 它们验的是另外两个机制，不该跟着红。
2. 把 `emit()` 的 `mirror` 改回 `config?.mirrorToConsole ?? true`（即无视抑制）⇒ 「抑制后不再镜像」那条红（1 failed / 7 passed）。

**机制本身也有一条真读数（不是桩）**：`console-pipe-guard.test.ts` 末尾那支用真 OS 管道跑两个子进程，父进程 250 ms 后
销毁读端 —— 不挂监听的臂写出 `UNCAUGHT EPIPE`，挂了监听的臂写出 `PIPE-ERROR EPIPE` 且**没有** `UNCAUGHT`。
没有这一臂，「guard 有效」只等于「guard 与自己的桩一致」。

## 五 边界（不许读成更强）

1. **真机窗口读数未取**：本机空闲页 ≈ 89 MB、swap 已用 7,372 / 8,192 MB，起 Electron 会把机器拖进抖动。
   本单元的证据是「真日志里的读数 + 真 OS 管道的机制复现 + 单测」，**不是**「打包版里从此不再出现 EPIPE」——
   那要等下一版发出去之后，在同一台机器上再看一次 `main.log` 有没有新的 `write EPIPE`。
2. **归因是读数推出来的，不是抓到的**：EPIPE 的 `frame` 是通用的 `afterWriteDispatched`，日志里不带流名。
   支撑是「窗口内 56 条记录 / 54 次 EPIPE」这个近似 1:1。**如果下一版发布后仍出现同形态的 `write EPIPE`，且次数远少于
   记录数，说明真正的写端不是控制台流** —— 那时本节的归因作废，按同一条思路去查子进程 stdio 那一族（`mcp-client-manager`、
   ACP 子进程 stdin 的写入路径），guard 那一层仍是对的（它修的是真的存在的一处）。
3. **抑制是全局且不可逆的**：只要有一条流死掉，两条流都不再镜像（logger 的 `console.*` 不区分流）。代价是「stderr 还活着」
   时也失去控制台输出；换来的是不会再往死管道里写。文件日志不受影响。
4. **不覆盖子进程 stdio**：guard 只看进程级两条流；某个子进程 stdin 的 `EPIPE` 仍会逃成 `uncaughtException`（已具名，见上）。
5. **不占版本号**：这是运行时行为改动，进下一版（v2.27.0 或先发的过渡版）随包生效。

## 六 下一轮第一步

① 取本笔双车道判决（完整 40 位 SHA；`cancelled` 不算绿）；② §299 §四 ② 那条真机窗口读数仍挂着，资源闸门一开就补
（隔离 `PURESCIENCE_STORAGE_ROOT` + `settings.dataRoot` + 独立端口 + `--user-data-dir`）；③ 同一条日志里还有两族开项，
按顺序取：`reviewer:correction` 的 `An ACP prompt is already running for this session`（同一 run 里 3 次，随后
`correction failed in fix loop — marking remaining checks unaddressed` ⇒ 修复环静默降级）、`egress approval timed out`（11 次）。
