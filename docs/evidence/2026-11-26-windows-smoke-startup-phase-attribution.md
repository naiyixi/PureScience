# 安装包冒烟：启动阶段有了真读数，超时行也自己说清停在哪一段（2026-11-26）

## 一 问题与判据

issue #13 第一条：`build / Build windows-x64` 曾在 `scripts/windows-installer-smoke.mjs` 的
`waitFor('the installed app web service', …)` 60 秒窗口上超时，日志只能证明「应用没崩也没退出」，
无法回答「是某个阶段慢，还是端点根本没起」。当时的决定是：**先量各阶段耗时，再决定是预热还是按阶段断言；
不加大超时**。

本条落两件事：

1. 从真实 Windows 车道日志里取一次**逐阶段耗时**读数（此前只有输出，没有人把时间轴读出来）；
2. 让**失败行本身**点名停在哪一段 —— 阶段时间轴是实时打印的，但看红步骤的人先看到的是错误句，
   其次是整段 dump，不是上面那条时间轴。

## 二 真读数（Windows 车道，现取）

来源：`Nightly 45673395862` 的 `build / Build windows-x64`（job `139427502633`），head `82064383`，
产物 `zerolink-purescience-2.33.8-nightly.g8206438-win-x64-setup.exe`。
冒烟用的是一份**隔离配置档案**（`windowsProfileEnvironment`），所以这条读数就是「首次运行」的读数。

| 阶段（按到达顺序） | 相对启动 |
| --- | --- |
| load-bootstrap-modules | +207 ms |
| single-instance-lock / prepare-runtime | +214 ms |
| crash-reporting / load-application-modules | +242 ms |
| electron-ready | +1,301 ms |
| compose-runtime | +1,483 ms |
| rewrite-paths | +2,151 ms |
| persist-marker | +2,153 / +2,156 ms |
| read-index | +2,928 ms |
| query-provider / load-authority / ipc-handlers-registered | +2,955 → +2,961 ms |
| reconcile-* / icon-variant-ready / remote-access-ready | +2,964 → +2,991 ms |
| external-mcp-started | +2,993 ms |
| **web-service-started** | **+3,004 ms** |
| 收尾（install-lifecycle → completed） | +3,004 → +3,133 ms |

三个最大单段间隔：`load-application-modules → electron-ready` 1,059 ms、`persist-marker → read-index` 772 ms、
`compose-runtime → rewrite-paths` 668 ms。冒烟脚本本身从 `node scripts/windows-installer-smoke.mjs` 到
`Windows installer smoke completed successfully.` 共 36.7 秒（19:34:03.55 → 19:34:40.27，含安装与卸载）。

**结论（可核验的算术）**：健康端点在启动后 3.0 秒出现，预算 60 秒，用掉 5%（余量 20 倍）。
所以「60 秒对首次运行合成运行时不够」这一假设在本次读数上**不成立**；历史上那次超时的形状只能是
进程在窗口内没有继续输出（停摆/被 runner 压住），不是某个阶段慢。**没有改任何超时预算。**

## 三 交付（`scripts/windows-installer-smoke.mjs`）

| 改动 | 为什么这么做 |
| --- | --- |
| `createStartupPhaseTracker(clock)`：把阶段行（`phase: '<name>'`）连同相对启动的毫秒数记下，`describe()` 给出一句结论 | 时间轴实时打印，但错误句要能独立成立 |
| `waitFor(description, check, timeoutMs, describeProgress)` 在超时消息后接上这句 | 失败行 = 「超时」+「停在哪一段」+ 原有 lastError |
| 两处等待都接上：安装后探测、进程锁探测 | 两处是同一个 60 秒形状，只修一处等于留一处盲区 |
| 「退出早于健康」的消息也带阶段 | 应用在启动中途退出时，最后阶段就是崩溃现场 |
| 分块边界保留半行（`pending` 挂到下一块） | 块边界切在阶段行中间时，旧写法会漏掉这一段，错误句就会点名**前一个**阶段 —— 那是错读数 |
| 没有阶段时给**另一句话**：「No startup phase was logged before the wait expired.」 | 「没到一个阶段」与「停在某个阶段」是两种缺陷，不能同形 |

`waitFor` 的第 4 参数可选，既有调用与既有消息逐字不变。

## 四 门禁（本机，隔离工作树 `/tmp/ps-win-smoke`，`origin/main 09ee816b`）

| 项 | 读数 |
| --- | --- |
| `vitest run scripts/windows-installer-smoke.test.ts` | 21 passed（新增 2 例：阶段名 + 毫秒进超时行；无阶段时说另一句） |
| `vitest run` scripts 三个文件（含 `windows-release-workflows`、`ci/classify-pr-changes`） | 75 passed / 3 files |
| `npx eslint --no-cache`（两个改动文件） | 0 errors / 0 warnings |
| `npm run typecheck:node`（8192 堆） | 见提交时的读数 |

## 五 边界与具名未办

1. **判据落在 Windows 车道**：新错误行的形状只有下一次冒烟（成功或失败）才会在车道日志里出现；
   本机没有 Windows 产物，不伪造该读数。成功路径的行为不变（阶段仍逐行实时打印）。
2. 一条读数只是一台 runner 的一次启动。要判「跑在慢 runner 上够不够」，需要失败复发时的读数 ——
   现在复发时失败行会直接给阶段名与毫秒，不必再回翻 dump。
3. 60 秒预算未动，issue #13 的「三连绿」判据不受本条影响。
