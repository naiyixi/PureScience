# macOS 打包冒烟：把「机器慢」与「应用卡死」分开（2026-11-15）

## 一 症状与归属

| 车道 / 提交                                                | 结果    | 失败的作业                |
| ---------------------------------------------------------- | ------- | ------------------------- |
| Nightly `198c5f2f`（2026-11-14 16:07Z）                    | failure | `build / Build macos-x64` |
| Nightly `fa624f13`（2026-11-14 19:03Z）                    | failure | `build / Build macos-x64` |
| 同两笔的 `build / Verify`                                  | success | —                         |
| 同两笔的 `Build macos-arm64` / `windows-x64` / `linux-x64` | success | —                         |
| Nightly `687f4e72`（同日 11:02Z）                          | success | —                         |

两笔红在同一处、同一形状：`macos-package-smoke.mjs` 等打包版 web 服务，
`Timed out waiting … after 60,167 ms / 60,323 ms (limit 60000 ms)`，`process: still running`，
`service announcements: none`。**不是测试红、不是产品功能红**（Verify 与另外三条打包车道都绿），
是「60 s 内没有宣告端点」这一条判据在一台被占用的 intel 跑道上被触发。

## 二 原有读数与它的缺口

`fa624f13` 的失败正文里，应用自己打印的启动阶段最后一条是：

```
phase: 'electron-ready'  elapsedMs: 38646
```

之后到限额到期（60,323 ms）的 **21.7 s 里没有任何输出**。`198c5f2f` 则到过
`compose-runtime @ 31,676 ms`。两条读数能说明「跑到了哪」，但**说明不了**：

1. 这 21.7 s 是「还在干活、只是慢」，还是「停住了」——输出尾部没有任何到达时刻；
2. 若再多给几秒，端点会不会自己出现——限额一到期进程就被杀掉，唯一的证据流随之中断；
3. 通过的那一侧（arm64）一条耗时读数都没有，任何「今天这台比昨天慢吗」都无基线。

## 三 改动

1. **到达时刻**（`scripts/macos-package-smoke.mjs`）：`recordOutput()` 在每块 stdout/stderr 上记
   `activity.lastChunkAtMs`；失败正文新增
   `- output activity: last line arrived at <ms> ms; <silence> ms of silence when the wait tripped`。
   静默与「最后一行时刻」**在同一瞬间取样**（限额到期那一刻），否则会拿「限额前的静默」去配
   「限额之后才到的行」——本轮探针先咬了一次这个，已修。
2. **超时后再观察 30 s**（`POST_TRIP_OBSERVATION_MS`）：判据触发后**先不杀进程**，继续听 30 s，
   记下端点是否终于宣告以及宣告时刻。失败正文新增
   `- after the wait tripped: …`，按触发的判据分别措辞：
   - 预算触发 + 晚到 ⇒ 「the budget cut a run that was still progressing」；
   - 停顿触发 + 晚到 ⇒ 「it was slow, not wedged — the silence ended」；
   - 停顿触发 + 仍无 ⇒ 「the silence did not end: a hang, not slowness」。
     **判定不变**（两种触发都是失败），这一段只是把「慢」与「死」在证据上分开。
3. **判据从「一个 60 s 天花板」改成两条**：
   - `STARTUP_STALL_MS = 60_000`——**没有任何输出**持续 60 s ⇒ `SMOKE_STALL`，正文写明
     「the 180000 ms budget was not what tripped」；
   - `STARTUP_BUDGET_MS = 180_000`——仍在输出但超过绝对预算 ⇒ `SMOKE_TIMEOUT`。
     为什么要抬绝对预算：实测这台 intel 跑道「到 electron-ready 就 38.6 s」，而限额 60 s 在**它还没来得及
     宣告**时就把它切断 —— 旧判据量的是机器速度，不是应用是否卡住。为什么抬预算不等于放宽门禁：
     新的失败判据是**静默**（60 s 不说话），卡死照样红，而且红得更准（正文点名最后阶段与静默时长）；
     慢但仍在推进的运行不再红。
     窗口可注入（`stallMs` / `budgetMs` / `observationMs`），所以探针能在几秒内跑完整条路径。

## 四 真机读数（真实子进程，非单测）

`/tmp/ps-smoke-probe/{silent,chatty,progress}.sh` + 一个只调 `launchAndProbe` 的探针：

| 探针                       | 注入窗口                  | 实测                                                                | 结论                                                             |
| -------------------------- | ------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 说一句就静默               | stall 2 s / budget 20 s   | `SMOKE_STALL`，`no output for 2014 ms`，`last line arrived at 4 ms` | 停顿判据真的按静默触发，且正文把预算排除在外                     |
| 一直说话但从不宣告         | stall 1.5 s / budget 3 s  | `SMOKE_TIMEOUT`，`after 3038 ms (limit 3000 ms)`，静默仅 220 ms     | 预算判据在「仍在输出」时触发，两个判据不互相顶替                 |
| 慢但在推进（2.8 s 后宣告） | stall 1.5 s / budget 20 s | 等到端点：`packaged startup …: endpoint announced after 3582 ms`    | 慢不再被读成卡死（随后失败在 fetch，因为假端点没有真服务——预期） |

端到端另跑一次真脚本（空产物目录）：`exit 1`，marker 写成
`{"source":"smoke-failure","readable":false,"reason":"Expected exactly one macOS dmg in …; found 0."}`——失败通路与 marker 未被改动破坏。

## 五 门禁

| 环                                                                | 读数                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `npx vitest run scripts/macos-package-smoke.test.ts`              | **1 file / 19 passed**（新增 3 条：静默 vs 预算的头行互斥、晚到/仍无的两态、未记录不得读成读数） |
| `npx tsc --noEmit -p tsconfig.node.json --composite false`        | exit 0                                                                                           |
| `npx tsc --noEmit -p tsconfig.web.json --composite false`         | exit 0                                                                                           |
| `npx eslint --no-cache scripts/macos-package-smoke.{mjs,test.ts}` | 0 problems                                                                                       |
| `npx prettier --check`（同上）                                    | 通过                                                                                             |

## 六 边界（不许读成更强）

1. **真实 x64 跑道尚未跑过新窗口**。本轮的读数全部来自本机注入窗口的子进程探针；下一笔 Nightly
   的 `Build macos-x64` 才会给出「≈N ms 晚到」或「静默没有结束」的真实结论。
2. **60 s 静默窗是 2.8 倍于已测到的最大合法间隔**（21.7 s，且被限额截断 ⇒ 真值只会更大）。若应用
   合法地能沉默超过 60 s，这条会误红；判据就写在失败正文里（「it was slow, not wedged」），
   看到它就说明该放宽的是 `STARTUP_STALL_MS`，不是应用。
3. **180 s 预算没有上界读数**：我们只见过被 60 s 截断的运行，从未见过它自然跑完。
   这 3 倍是**对截断值的估计**，不是对完成值的测量。
