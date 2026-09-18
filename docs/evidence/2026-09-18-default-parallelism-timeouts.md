# 默认并行度的"全量门禁"：15 s 上限不够 —— 实测与处置（2026-09-18）

- 机器：macOS arm64，**8 核 / 8 GB**，同时跑着常驻 headless 实例（背景负载如实计入）
- 对比口径：同一份代码 `npx vitest run`（**默认并行度**）与 `npm run test:gate`（`--maxWorkers=4`）

## 一、症状与拆解（处置前）

默认并行度全量：**12 文件 / 77 例红，EXIT=1**；同一份代码 `--maxWorkers=4` **0 红**。

把 77 条按错误类型拆开（这步是关键，否则会把级联当成"很多坏测试"）：

| 类型 | 条数 | 说明 |
|---|---|---|
| **真的等到超时**（`Test timed out in 15000ms` ×15、`Hook timed out in 10000ms` ×2） | **17** | 上限被负载顶穿 |
| **级联断言**（`expected [] to have a length of 4 but got 0`、`vi.fn()` 未被调用、`expected null not to be null` …） | **58** | 同文件里跟在那 17 条后面的下游失败，不是独立缺陷 |

那 17 条分布在 **11 个文件**：`ProjectFilesView(3)`、`WorkspaceMessageScroller.interaction(2)`、`WorkspaceMessageScroller.render(2)`、`PreviewFileContent(2)`、`main/storage/ipc(2)`，以及 `main/artifacts/provenance-repository`、`main/agents/completion-gate.execute-control.integration`、`main/acp/runtime`、`main/session-persistence/artifact-finalization-recovery.integration`、`main/session-persistence/deletion-integration`、`main/settings/service` 各 1。

**"负载产物"的判据**（不是靠感觉）：

1. 这 11 个文件各自单跑都绿；
2. 其中 5 个最重的文件**一起**跑（402 例）**11.2 s 全绿** ⇒ 它们不慢，是被 1042 个文件同时抢 CPU 时"等不到"；
3. 最极端一条：`PreviewFileContent > renders large code previews as plain source` 在默认并行度下等了 **80,028 ms**，而它健康时约 **1 s**（80×）。

## 二、处置（机制，不是散点补丁）

`vitest.config.ts`：`testTimeout: 15000 → 60000`，并显式设 `hookTimeout: 60000`（原本走 10 s 默认，同样被顶穿）。配置里写清了上面的实测依据。
**为什么不给那 17 条逐一加超时**：上限是**并行度**造成的，逐条补丁要动 11 个文件 17 处，且下一个重负载用例仍会复现；上限提到 60 s 一次覆盖全部，且**不会掩盖真挂起**（真挂起远不止 60 s）。
**为什么不把默认并行度调小**：默认并行度是开发者/CI 各处入口的共同默认值，改它会改变所有入口的行为；本机门禁的口径已由 `npm run test:gate`（`--maxWorkers=4`）承担。

## 三、复测（处置后，同一命令、同一机器、同一份代码）

**默认并行度全量：`1028 files passed | 14 skipped`、`13870 tests passed | 190 skipped`、`EXIT=0` —— 零红。**

对照：处置前同一命令 **12 文件 / 77 例红（EXIT=1）**。⇒ 那 17 条超时确实是**全部**根因，58 条级联随它们一起消失（没有留下任何"独立缺陷"）。

## 四、诚实边界

1. 这是**测试基建**的处置，不改产品代码；它让"默认并行度全量"不再产出假红，但**不代表**默认并行度下的绝对等价性（拥塞下的耗时本来就随机器变）。
2. 60 s 是**本机观测**（最坏 80 s 那条恰好越界）之后取值；换更慢的 runner 仍可能不够 —— 因此 CI 侧若要依赖它，建议同时给重负载套件单独放宽（与先前立的那条一致）。
3. 未做：把 worker 上限固化进 CI 的重负载 job（仍为立案项）。
