# 启动汇总行按「自己花的时间」排序：被挂起的步骤不再占成本位，但仍在这行里被点名

2026-10-28，执行器。改动面：`src/main/diagnostics/compose-steps.ts`（汇总行 `logSummary`）+ 其用例。

## 一 缺口的形状

`compose runtime steps` 这一行是读者开机先扫的一行，它给的是「谁花了这个启动窗口」。改动前它按**墙钟**
（`durationMs`）排序，于是**落进循环被占住窗口里的步骤**会占掉成本位：这类步骤墙钟可以极长（本机实测过
`permission-grant-registry` **22,763,287 ms / cpu 份额 0**），而它一个字节的活都没干。一行只留 6 条，
被挂起的步骤一多，真正花时间的步骤就被挤出这一行。

上一轮（§二百五十 §四.3）已把这条记成候选：**排序要按 own 时间（自己真正花掉的那段），同时把钉着
`permission-grant-registry=22763287ms(no-cpu)` 必须可见的那条断言一起改写**。

## 二 改法

| 位置 | 改动 |
|---|---|
| 排序键 | `ownMs = durationMs - heldMs`（`heldMs` 缺席即整段都是自己的）降序；相同 own 时退回墙钟降序，再相同按记录顺序（确定性） |
| 新列 `suspended` | 有 `heldMs` 的步骤按 `heldMs` 降序，最多 `summarySize` 条；**没有任何步骤被挂起时整列缺席**，普通启动的行形状一字不变 |
| 条目文本 | 不变：仍印墙钟 `name=Xms` + 既有后缀（`(failed)` / `(no-cpu)` / `(held Nms)`），因此 `墙钟 = own + held` 可以从同一行读出来 |
| `steps()` 访问器 | 语义不动（墙钟序），注释就地写明「汇总行按 own 时间排」 |

**为什么必须两列而不是直接重排**：`stepMs` 是各步墙钟之和，被挂起步骤的墙钟**仍在 `stepMs` 里**。只重排会让
下一个读者看到 `stepMs 22,766,129` 而六个条目没有一条对得上——那正是本仓最忌讳的「有个数没人认领」。
`suspended` 这一列就是那个认领。

## 三 真数据回放（两次真实启动，产品日志原文）

`logs/headless.out.log` 里最近两次启动的汇总行（改动前的形状，原文照抄）：

```
totalMs: 5797,  stepCount: 12, heldMs: 675,  stepMs: 5772, gapMs: 25
slowest: 'open-project-db=1942ms(held 675ms) specialist-skill-catalog=1883ms(no-cpu)
          restore-notification-inbox=949ms(no-cpu) specialist-package-snapshot=734ms(no-cpu)
          builtin-catalog-ready=109ms(no-cpu) load-probe-answers=89ms'

totalMs: 15245, stepCount: 12, heldMs: 1071, stepMs: 15174, gapMs: 71
slowest: 'specialist-skill-catalog=11221ms(no-cpu) load-probe-answers=1818ms(held 1071ms)
          open-project-db=1225ms(no-cpu) specialist-package-snapshot=550ms(no-cpu)
          restore-notification-inbox=162ms builtin-catalog-ready=124ms(no-cpu)'
```

把这两次启动里**具名的 6 条步骤**（名字、墙钟、held）按原顺序重放进**生产记录器**（`createComposeStepRecorder`，
注入时钟与 held 窗口，`slowMs` 拉高以免刷慢行），得到新字段的读数：

| 启动 | 旧序（按墙钟） | 新序（按 own 时间） | 新列 `suspended` |
|---|---|---|---|
| A（total 5797） | `open-project-db=1942(held 675)` 第一 | **`specialist-skill-catalog=1883` 第一**，`open-project-db=1942(held 675)` 第二（own 1267） | `open-project-db=1942ms(held 675ms)` |
| B（total 15245） | `specialist-skill-catalog=11221` 第一，`load-probe-answers=1818(held 1071)` 第二 | 第一不变；**`load-probe-answers` 退到第三**（own 747，落在 `open-project-db=1225` 之后） | `load-probe-answers=1818ms(held 1071ms)` |

**边界（不许读成更强）**：

1. 回放只含**具名的 6 条**（真实启动各 12 条），所以回放的 `totalMs` 更短（5706 / 15100），不是那次启动的真实窗口。
2. 回放注入的 CPU 源恒为 0，因此每条都印 `(no-cpu)` —— **那不是这次启动的 CPU 归属**，只是回放的副作用；
   真实行里 `open-project-db` 没有这个后缀。**排序与 held/own 算术**才是回放要证的东西。
3. 真正的新鲜真机启动行（产品自己打的那一行）**没取到**：取它要重建 `out/` 再起一个隔离实例，而 `out/` 的
   写入会被在跑的 dev 实例的 watcher 接住（等于未经同意重启用户在用的实例），且本机当时空闲页 ~60 MB。
   这条与既有待办「重启常驻 dev 实例取真机行」同一张单子，不另立。

## 四 变异自证（4 次，逐个删掉改动的一部分，各自变红一次）

| 变异 | 结果 |
|---|---|
| 删掉排序第一级键（own 时间） | **2 failed / 16 passed** |
| 删掉 `suspended` 列 | **3 failed / 15 passed** |
| 删掉 own 相同时的墙钟次级键 | **1 failed / 17 passed** |
| `suspended` 不做 held 降序（退回记录顺序） | **1 failed / 17 passed** |

## 五 门禁读数（全部实跑，数字取自最后一次改动之后）

| 环 | 读数 |
|---|---|
| `npx vitest run src/main/diagnostics/compose-steps.test.ts` | **18 passed**，EXIT 0 |
| `npx vitest run src/main/diagnostics src/main/settings/agent-runtime-manager.test.ts src/main/ipc-startup-attribution.test.ts` | **21 files / 179 passed**，EXIT 0 |
| `npx vitest run src/main/settings --maxWorkers=2`（另一族消费者） | **94 passed / 1 skipped（95 files）**、**1475 passed / 3 skipped（1478）**，EXIT 0 |
| 双 typecheck（`--composite false`，堆 8192） | node **0**；web **0**（两份日志均 0 行） |
| `npx eslint --no-cache`（本笔 2 文件） | **0 error / 0 warning**，EXIT 0 |
| `npx prettier --check`（本笔 2 文件） | 通过 |
| 全量 vitest | **未跑**：本机 swap 已用 9,350 MB / 10,240 MB、空闲页 3,847（≈60 MB），上一轮同水位下全量 45 分钟未完并产出 7 条负载假红 ⇒ 按受影响面（两族消费者 + 整目录）取读数，不拿机器去赌 |

## 六 用例变化（只收紧，不放宽）

1. `reports in the summary how much of the window the loop was held for` → 改名并重写为
   `ranks the summary by own time and names the parked step separately`：新增一条 1,150 ms 全正常运行步骤，
   断言墙钟序会把 1,800 ms 那步排第一、而 own 序把它排第二；并断言 `suspended` 只含被挂起那条。
   （旧断言 `heldMs 1 500` 随窗口集合变化改为 `1 200`：旧值是被替身对**所有**窗口都夹到 1 200 的产物，
   不是另一次测量。）
2. 新增 `keeps a fully parked step out of the cost list while still naming it`：真实 22,763,287 ms 记录，
   断言 `slowest` 里**不含**该步骤（它一分钱没花）、`suspended` 里**含**它、`totalMs` 仍含它的墙钟。
3. 新增 `falls back to wall-time order when every step was parked`：own 全为 0 时退回墙钟序，行不会变空。
4. `summarizes the slowest steps in one line…`：追加 `not.toHaveProperty('suspended')`，钉住普通启动的行形状不变。
5. 既有的单步 `(no-cpu)` 用例保留（它是唯一一条步骤，仍会被点名），就地加注：它钉的是后缀，不是排序。
