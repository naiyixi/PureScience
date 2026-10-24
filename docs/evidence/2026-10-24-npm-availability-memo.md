# settings:npm-available —— 同一份 npm、同一个答案，每次设置面都要重付一次 Node 启动

窗口：打包版真机日志（只读）`~/Library/Logs/PureScience/` 三份（`main.log` / `main.1.log` / `main.2.log`），
`2026-10-23T10:59:43Z → 2026-10-24T06:50Z`，`ipc handler was slow` 记录按通道聚合。

## 一 读数（为什么取这一条）

| 通道 | 次数 | 中位 | 最大 |
|---|---|---|---|
| `settings:npm-available` | **37** | **1,917 ms** | 22,604 ms |
| `settings:get-settings`（对照：同样只读设置） | 16 | 145 ms | 558 ms |

- 这条通道只回答一个问题：**PATH 上有没有 npm**。它被 37 次调用，每一次都跑一整遍 `npm --version`
  —— npm 是一个 JS 程序加一层 shim，所以那是**一整个 Node 启动**，而不是一次文件系统查询。
- 对照通道 `settings:get-settings`（16 次、中位 145 ms）说明「设置面慢」不是这条通道的普遍属性：
  中位 1.9 s 的那部分是它自己 spawn 出来的。
- 同一个问题问的是**同一个文件**：两次调用之间答案能变的唯一条件是那个文件变了。
- 同窗口的机器侧归因（见 `docs/evidence/2026-10-24-preflight-probe-attribution.md` §二）：
  本进程 `cpuShare` 中位 **0.077**、`loadAvg1m` 中位 39.2 ⇒ 绝对耗时随负载飘一个数量级，
  **因此本单元只去掉「不可能产生不同答案」的重复工作**，不按耗时做优化。

## 二 交付

| 位置 | 改动 |
|---|---|
| `src/main/settings/npm-executable.ts`（新） | `resolveNpmExecutable`：按（已增广的）`PATH` 扫出 npm，Windows 上按 `npm.cmd`/`npm.exe`/`npm.bat`/`npm` 顺序试；`createNpmAvailabilityProbe`：用 `withVersionProbeCache` 按**文件身份**（`mtimeMs`+`size`，跟随符号链接）记忆「npm 能答 `--version`」，并发同键共享一次 |
| `src/main/settings/claude-install.ts` | `detectNpmAvailable(runNpm?)`：**未注入探针**时走记忆化的 `npmAvailable()`；**注入探针时行为逐字不变**（`resolve ⇒ available`、`reject ⇒ unavailable`），因此既有替身用例与 `runInstallWithFallback(npmProbe)` 一个字节未改 |
| `scripts/ci/change-impact.json` | 把本笔新文件与上一轮的 `version-probe-cache.ts` 一起登记进 `windows_sensitive` —— 两者都有 `platform === 'win32'` 分支，而分类器要求「带 Windows 运行时信号的生产文件必须被分类为 Windows 敏感」，上一轮的 `nightly`/`Windows Full Test` 正是红在这一条上 |

**三条边界（写进模块头注）**：

1. **不改启动方式**：探针仍然用裸名 `npm` 加完全相同的选项（Windows 上带 shell，因为 npm 是 `npm.cmd`
   批处理垫片；`PATH` 已增广，GUI 起的应用照样能解析 Homebrew/nvm 装的 npm）。变的只有重复成本。
2. **解析不到 ≠ 没装**：PATH 扫不到时身份是 `unknown`（不是 `missing`）—— Windows 上 shell 还能通过
   `PATHEXT` 解析，所以「我们自己没找到」不能证明 npm 缺席。这条路径**不缓存**，与改动前一致。
3. **失败不记忆**：spawn 失败（含负载下的超时）不是一个答案；若记住，会把「刚装好的 npm」显示成「没装」
   直到文件变化为止。

## 三 真机探针（产品自己的默认依赖，跑完即删、未提交）

```
resolved=/Users/totota/.local/bin/npm rawSpawnMs=276.5 coldMs=337.8 warm1Ms=1.8 warm2Ms=1.1
```

- `rawSpawnMs` = 改动前那条路径（`npm --version`）；
- `coldMs` = 本单元第一次调用（含 PATH 扫描 + spawn）；
- `warm1Ms` / `warm2Ms` = 后续调用（一次 PATH 扫描 + 一次 `stat`），**约 250 倍差距**。

## 四 门禁（全部实跑，取自最后一次改动之后）

| 环 | 读数 |
|---|---|
| `src/main/settings` + `src/main/diagnostics` 整域 | **104 files / 1,523 passed**（3 skipped），exit 0 |
| 本笔 2 个测试文件 | **43 passed**（新增 10 条模块用例 + 2 条接线用例） |
| `scripts/ci/classify-pr-changes.test.ts` | **41 passed**（红转绿：`version-probe-cache.ts` 归位后 `uncoveredFiles` 为空） |
| 双 typecheck（`--composite false`，堆 8192） | node / web 均 exit 0 |
| `eslint --no-cache` + `prettier --check` | 0 problems / 全过 |

## 五 边界（不许读成更强）

1. **没有窗口读数**：证据 = 单测 + 产品默认依赖上的本机探针。要在窗口里看到差别，需以新构建重启 dev
   实例，而当时空闲页与 swap 不满足条件（见计划档该节）⇒ **具名未取**。
2. 只覆盖「npm 在播报可用性」这一条；`settings:check-environment` 与 `runtime:*` 那一簇 20–30 s 的通道
   **未动**（它们的时间在那段窗口里由机器侧主导，且缺分步归属）。
3. 记忆边界同样是「文件身份」：若有可执行文件自身字节不变而输出随外部状态变化，本层会一直用第一次应答。
   npm 的 `--version` 不属于这一类。
4. 不占版本号（无用户可见文案、无窗口读数）。
