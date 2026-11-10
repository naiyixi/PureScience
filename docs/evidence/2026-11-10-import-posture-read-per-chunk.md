# 导入只读状态：每个流式块读一次的主进程调用，改成每次打开会话读一次

日期：2026-11-10（执行器单元）
相关：`src/renderer/src/hooks/useSessionImportPosture.ts`（新）、`src/renderer/src/pages/workspace/WorkspacePage.tsx`、
`docs/plan-2026-10-03-next-queue-and-round-convention.md` §三百零六

## 一 读数（先量后改；全部取自真机日志，只读）

真机日志 `~/Library/Logs/PureScience/main.{log,1.log,2.log}`（2026-11-04 → 11-10）里
`sessions:import-posture` 的 `ipc handler was slow` 共 **102** 条：

| n | med | p90 | p99 | max |
| --- | --- | --- | --- | --- |
| 102 | 183 ms | 995 ms | 2,855 ms | 3,908 ms |

归因分布：`cpu-bound-in-process` 54、`inconclusive` 39、`no-cpu-in-process` 9。
**97 / 102 条落在同一个进程运行（runId `4c440a91…`，2026-11-09）** ⇒ 不是散布的历史噪声。

同一通道在 **1.2 秒内出现 10 次调用**（2026-11-05T15:15:47.911 → 15:15:49.072，54–147 ms），
其中三对起止时刻逐字相同（`.911` 三条 147 ms、`.307` 两条 86/87 ms）⇒ 同一会话在短时间内被反复读取。

## 二 缺口：读的效果按「会话对象」做依赖，而会话对象每块都换

- `WorkspacePage` 里 `activeSession = useMemo(() => sessions.find(...), [selectedSessionId, sessions])`；
  store 的 `appendAgentMessageChunk` 对**每个提交的块**都 `sessions.map(...)` 造一个新的会话对象
  （`session-store-run-projection-owner.ts:103-110`，且 `shouldCommit` 在三个投影分支里恒为 `true`）。
- 于是依赖数组 `[activeSession]` 在**流式回合里每个块都变一次**，effect 就发一次
  `sessions:import-posture`（一次 IPC + 一次小文件读 + 一次 `setState`，后者还整页重渲）。
  也就是说：读得最频繁的时刻，正是主进程最忙的时刻（上面 54 条 `cpu-bound-in-process` 与这些调用同形）。
- 该记录只可能与它所属的会话一起出现或消失，导入**必然产生新的 sessionId** ⇒ 同一个 id 存活期间
  一次读取就是全部契约；重复读拿到的字节完全相同。

## 三 交付

- 新增 `src/renderer/src/hooks/useSessionImportPosture.ts`：依赖只有两个原始值
  `(projectId, sessionId)`；返回值按 `posture.sessionId === sessionId` 过滤
  ⇒ 换会话后旧的记录立刻不再对外可见（不需要在 effect 里同步 `setState` 复位，
  那会被 `react-hooks/set-state-in-effect` 拦下，也本来就多余）。
  `window.api?.sessions?.importPosture` 全链可选（Web 面没有这个桥时安静不动）。
- `WorkspacePage.tsx`：删掉原先的 `useState` + `useEffect` 对（19 行），改为
  `const importPosture = useSessionImportPosture(activeSession?.projectId, activeSession?.id)`；
  横幅的渲染条件原样保留。

## 四 判据与自证（全部实跑，取自最后一次改动之后）

| 环 | 读数 |
| --- | --- |
| 定向 vitest（`useSessionImportPosture.test.tsx`） | **1 file / 4 passed** |
| `src/renderer/src/hooks` + `src/renderer/src/components/session-package` | **9 files / 59 passed** |
| `src/renderer/src/pages/workspace`（整目录，含 10+ 支 WorkspacePage 渲染用例） | **177 files / 1,915 passed** |
| `src/renderer/src`（整个渲染层） | **411 files / 4,455 passed | 1 skipped** |
| `tsc --noEmit -p tsconfig.web.json --composite false` | exit 0 |
| `eslint --no-cache`（本笔 3 文件） | 0 error / 0 warning |

四条用例：① 调用方每次都递进一个新对象、字段相同 ⇒ 只读一次（这正是回归的形状）；
② 换会话会重读，且返回的记录挂在它自己的 id 下；③ 换会话之后才到位的旧答案不会显示；
④ 普通会话（无记录）与 Web 面（无桥）都安静。

**变异自证**：把 effect 的依赖从 `[projectId, sessionId]` 改成一个每次渲染新建的对象
`[{ projectId, sessionId }]`（即恢复「按对象身份」的行为）⇒ ① 与 ② 当场红（2 failed / 2 passed），
还原后 4 条全绿。

## 五 边界（不许读成更强）

1. **没有真机窗口读数**：旁证只有日志（同一通道 1.2 秒 10 次）与源码路径，装机后的判据是
   同一会话在流式回合里的 `sessions:import-posture` 出现次数降到「每次打开一次」
   （该通道只在超过阈值时才打慢行，所以判据是**慢行条数**与**同一分钟内条数**同时下降）。
2. **收益未测毫秒**：每次省下的是一次 IPC + 一次小文件读 + 一次整页重渲；实际省多少取决于
   块的数量与产物面板的规模，本轮没有取到真机毫秒。
3. **记录的「外部变化」不再被主动发现**：以前每个块都重读，所以别的窗口改了盘上的记录会被顺带看到；
   现在只在打开会话时读。导入在本应用里必然产生新会话（新 id ⇒ 会读），因此这是可接受的收紧；
   若将来出现「就地改写记录」的路径，需要显式触发重读。
4. **`artifacts:read-preview` 这一族本轮判为「不是该通道的缺陷」（零代码收口）**：
   它的 85 条慢行里 p99 8.2 s 那几条集中在 2026-11-05T15:15:30 同一个时间片，
   同一片的 `diagnostics` 行写着 `event loop stalled … cause.kind = fs-queue-saturated`
   （fs canary 5,954 ms、loadAvg1m 14.23、freeMem 64 MB、swapouts 11,208），
   同时 `preview-resources:acquire` 5.6 s、`artifacts:probe-availability` 8.2 s 一起变慢
   ⇒ 那是**宿主 fs 队列饱和 + 内存压力**，三个通道同时排队；该通道自己的读在队列空闲时是 60–90 ms。
   这一族的后续不在这里：要动的是「谁在同一时刻占住主线程/队列」，属另一根因。
