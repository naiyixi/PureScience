# 慢步骤的时长里，有一半是「我们根本没在跑」—— 时间与 CPU 归属分离

2026-10-25 · 执行器单元 · 提交见本档末「落点」

## 一 结论

启动与设置分析里的两条计时器过去只报**墙钟**：一段窗口里进程被挂起（合盖、系统调度、整机换页），
墙钟照样走，于是「六小时十八分」被记在**钥匙串**头上。同一次运行里，看门狗对**同一个窗口**
给出的却是 `cpuShare 0 / process-not-scheduled`——三份记录互相矛盾。本单元把「这段时间是不是我们的活」
做成**一份共享词汇**，让每个报时长的记录同时报出它花掉的 CPU，并在摘要里给「没在跑」的那段加
`(not-scheduled)` 后缀。

## 二 现场读数（只读产品自己的日志，未改动）

`~/Library/Logs/PureScience/main.log`，打包版，`runId=1c037550-0058-4aba-9948-f50fe06a6aa9`：

```
02:50:15.809 startup    compose step slow  {"step":"permission-grant-registry","durationMs":22763287}
02:50:15.679 settings   settings key migration was slow
                        {"totalMs":22763411,"outcome":"unchanged",
                         "phases":"encryption-available=22763345ms,providers=34ms,connectors=2ms"}
02:50:16.353 diagnostics event loop stalled
                        {"windowMs":22763558,"lateMs":22763058,"cpuMs":431,"cpuShare":0,
                         "attribution":"process-not-scheduled","stack":{"status":"no-second-stall"},
                         "host":{"status":"window-armed"}}
```

同一形状在 `2026-10-24T16:16:35Z` 那一次也出现过（635,268 / 635,144 / `cpuShare 0`）。
**判读代价**：下一个查启动慢的人会照着 `encryption-available=22763345ms` 去查钥匙串，而那段窗口里
主进程一个 CPU 周期都没拿到。

## 三 改了什么

| 文件 | 改动 |
| --- | --- |
| `src/main/diagnostics/cpu-attribution.ts`（新） | 唯一一份词汇：`cpuMillisecondsBetween` / `cpuShareOf` / `classifyCpuShare` / `attributionSuffix`。两档带名阈值（≥0.60 `cpu-bound-in-process`，≤0.15 `process-not-scheduled`，其间 `inconclusive`）。**零长度窗口判 `inconclusive` 而不是「没在跑」**：立刻返回的步是日志里最不值得怀疑的东西 |
| `src/main/diagnostics/compose-steps.ts` | 每步记 `cpuMs / cpuShare / attribution`；`slow` 行与 `failed` 行都带上；摘要里那类步带 `(not-scheduled)`；`steps()` 的公开形状不变（`ComposeStep` 不动，避免契约涟漪） |
| `src/main/diagnostics/event-loop-stall-watchdog.ts` | 删掉自己那对阈值常量，改引用同一模块 —— 不再是第二套判断 |
| `src/main/settings/service.ts` | 密钥迁移的每个阶段改为 `{ ms, attribution }`，`phases` 逐项可带 `(not-scheduled)`；整段也带 `cpuMs / cpuShare / attribution`；新增注入缝 `clock` / `cpuUsage`（默认 `Date.now` / `process.cpuUsage`） |

## 四 真机读数（产品自己的 recorder + 真 Electron 运行时 + 真信号去调度）

做法：用 esbuild 把**产品自己的 `compose-steps.ts`**（连同 `cpu-attribution.ts`、`logger` 的
`diagnosticErrorFields`）打成一处，在**真 Electron 主进程**里调用；两步——一步忙等 900 ms，
一步由外部 `sh -c "sleep 3; kill -CONT <pid>"` 在 3 s 后唤醒、自己 `SIGSTOP`（**真的被停住**，不是模拟）。
不是用户那个实例，跑完即退，未写任何用户数据根。

```
WARN compose step slow {"step":"busy-in-process","durationMs":900,"cpuMs":826,"cpuShare":0.918,
                        "attribution":"cpu-bound-in-process"}
WARN compose step slow {"step":"stopped-by-signal","durationMs":3065,"cpuMs":13,"cpuShare":0.004,
                        "attribution":"process-not-scheduled"}
INFO compose runtime steps {"totalMs":3969,"stepCount":2,
                            "slowest":"stopped-by-signal=3065ms(not-scheduled) busy-in-process=900ms"}
versions electron=43.7.5 node=24.21.0 v8=15.0.245.31-electron.0
```

读法：**忙等那一步不会被误判**（0.918 → `cpu-bound-in-process`，摘要里保留裸数字）；
**被信号停住的那一步自己说没在跑**（0.004 → 后缀 `(not-scheduled)`）。这正是现场那三份记录缺的那一栏。

## 五 没有取到的那半边（具名，不算已验）

**设置侧那条日志的真机读数没取到。** 它只在**一次真的 ≥250 ms 的迁移**发生时才会打印，而这种窗口
没有可靠的按需制造方式。这一轮试过两个探针：① 直接把 `SettingsService` 打包进真 Electron —— `safeStorage`
在未打包的 Electron 里要过钥匙串，探针卡在那里（240 s 超时）；② 用注入缝造时钟 —— 那属于单测，
按本仓口径不算实机。因此设置侧的归属只有下面第六节的**注入缝单例**作证据，加上「它和 compose 侧
共用同一个分类器（`cpu-attribution` 只此一份）」这一条结构事实。真实那一次再现时，同一行会自己长出新字段。

## 六 门禁读数（实跑）

| 门 | 读数 |
| --- | --- |
| 定向用例（`cpu-attribution` 6 + `compose-steps` 新增 2 + `service.key-migration-attribution` 2，另含既有 7 条） | `Test Files 3 passed` / `Tests 17 passed` |
| 整域 `vitest run src/main/diagnostics src/main/settings --maxWorkers=4` | `Test Files 112 passed \| 1 skipped (113)`；`Tests 1589 passed \| 3 skipped (1592)`；`EXIT=0` |
| `tsc --noEmit -p tsconfig.node.json --composite false` | `EXIT=0`（无输出=通过） |
| `tsc --noEmit -p tsconfig.web.json --composite false` | `EXIT=0` |
| `npx eslint --no-cache .` | `0 errors, 127 warnings` |
| `prettier --check`（本单元 7 个文件） | `All matched files use Prettier code style!` |
| `bash scripts/pre-push-checks.sh` | `全部通过`（含 v2.18.0 已发布核对、README 双语一致、`model-weights` 清单、53 个脚本入口、新增文件 lint） |

本轮 lint 中途红过一次：`service.key-migration-attribution.test.ts:72` 的 `let cpu` 应为 `const`（error 级），
改后全仓归零；同时 `prettier` 对两个新文件报了折行，已 `--write`，未夹带其他文件的格式漂移（本单元只碰
自己这 7 个路径）。

## 七 边界

- 阈值是**带名的经验档**（2026-10-19 探针：忙等约 0.8、被去调度约 0.0），中间带保持 `inconclusive`，
  不硬判——判错的代价是把一次真的同步阻塞说成「不在跑」。
- 这不会让慢步骤变快；它让**下一个人不去查错地方**。
- 老日志照旧可读：新字段全部是**新增**，不带这些字段的历史行不需要重新解释。

## 八 落点

- 代码与用例：`src/main/diagnostics/{cpu-attribution,compose-steps,event-loop-stall-watchdog}.ts`、
  `src/main/settings/service.ts`（+ 各自 `.test.ts`）。
- 计划档：`docs/plan-2026-10-03-next-queue-and-round-convention.md` §两百三十二。
