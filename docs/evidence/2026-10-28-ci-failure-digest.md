# CI 失败原因不可见：`gh run view --log` 读回 0 字节还退出 0，改用 `gh api …/jobs/<id>/logs`

日期：2026-10-28（执行器轮次 §二百五十二）
交付：`scripts/ci-failure-digest.mjs` + `scripts/ci-failure-digest.test.ts`（18 例）

## 一 缺口的第一手读数（动手之前）

交接档把这条记成「Verify 红时 `gh run view --log-failed` 返回空」。本轮按读数把它拆成两半，
第一半得到**确定的、可复现的**形状：**`gh run view --log` 与 `--log-failed` 在这个环境里对任何作业都读回
0 字节，并且退出码是 0**。

| 目标（run `40492038901`，`dae37ac3` 的 Nightly） | `gh run view … --log` | `gh api …/jobs/<id>/logs` |
| --- | --- | --- |
| 整个 run（`--log`） | **0 B** | —— |
| 整个 run（`--log-failed`） | **0 B** | —— |
| `build / Resolve platform matrix`（4 s，成功） | **0 B** | **4,823 B** |
| `build / Verify`（12 m 28 s，**失败**） | **0 B** | **11,849,514 B** |
| `publish`（skipped） | **0 B** | **215 B** |

`GH_DEBUG=api gh run view … --job <id> --log` 的请求序列只到 `actions/jobs/<id>`、`actions/runs/<id>`、
`actions/workflows/<id>` 三条，**从未请求过任何 logs 端点**（`gh` 2.73.0，本机）。
而 `gh run view` 不带 `--log` 的普通视图是正常的（能打印作业与逐步骤状态）⇒ 坏的是取日志那条路，
不是认证或仓库。

> 归属只写到这里：这是**本机 gh 版本下的实测行为**，不断言别的 gh 版本或别处如何；也不需要它成立才能继续
> —— 可读的那条路（`gh api`）存在，而且一次就给出了 11.8 MB。

## 二 因此缺的不是「日志被截断」，而是「拿到日志之后仍要人工翻 12 MB」

上一轮已核过：红的那份日志里**汇总行与根因都在**（`Test Files 112 failed …`、`Error: Electron failed to
install correctly.`）。所以本单元要做的不是修日志生成，而是把「翻日志」这一步变成一个命令。

## 三 交付

`node scripts/ci-failure-digest.mjs [<run id> | <sha>]` —— 取该 run 的失败作业日志（走 `gh api`），
打印：失败步骤名、vitest 三个汇总数、失败测试文件清单（去重，超上限时写明还藏了几条并给出 grep 提示）、
根因候选（含其下一行的栈帧，`Caused by:` 链折叠成同一条）、`##[error]` 行数与最后一条；完整日志落盘并打印路径与字节数。

四种「没有答案」的形状各自具名、**都不退出 0**：

| 状态 | 退出码 | 含义 |
| --- | --- | --- |
| `digest` 有内容 | 0 | 至少一条根因或一个失败测试文件被引到 |
| `no-failed-jobs` | 2 | 该 run 的作业没有一个失败（越界读会以为「没什么可看」） |
| `logs-unavailable` | 3 | 日志读回 0 字节或 API 报错（含原因原文）——**不许**读成「这里没失败」 |
| `no-failure-markers` | 4 | 日志读到了但没有任何标记（此时也不许读成通过） |

三条仪器纪律写在源码里：① `git rev-parse` 解析出的 SHA 必须是 40 位，**解析不出就报错而不是发
`head_sha=` 空值**（API 对空值会把**最近 50 个 run 全列出来** —— 第一版就是这么把 5 个不相关的历史失败当成本次结果
digest 出来的，已修）；② 同一句失败穿了不同前缀（`##[error]` / `Caused by: Caused by:`）只算一条原因
（否则读起来像三件事都坏了）；③ eslint 的 `✖ N problems` 汇总**不**算根因（第一版把它当成 root cause 打了出来，
指向了与失败无关的 lint）。

## 四 真机读数（本机实跑，不是用例）

红的那次（`run 40492038901`，退出码 **0**）：

```
CI failure digest — run 40492038901 (Nightly, failure) · head dae37ac3
job build / Verify (lint + typecheck + test + package) · failure · failing step(s): Test (with coverage)
  log: …/job-122148662592.log (11849514 bytes)
  vitest: Test Files 112 failed | 1290 passed | 21 skipped (1423)
          Tests 15883 passed | 206 skipped (16089)
          Duration 458.13s (transform 29.65s, setup 8.90s, import 189.86s, tests 263.73s, environment 108.02s)
  failed test files (112):
    scripts/stage-default-envs.test.ts
    …
    … and 97 more (grep ' FAIL ' …/job-122148662592.log)
  root cause candidates (2 distinct, first 2):
    Error: Electron failed to install correctly. … · at getElectronPath node_modules/electron/index.js:43:13
    Error: [vitest] There was an error when mocking a module. …
  ##[error] lines: 6 (last: Process completed with exit code 1.)
```

三条负例也是实跑：

- **绿提交**（`HEAD` = `2ccb6f8c`，两条车道都 success）⇒ 退出码 **2**，两行 `no-failed-jobs: 8 job(s), none failed (…)`；
- **不存在的 ref**（`nosuchref`）⇒ 退出码 **1**，第一行是 `git` 的原话（`fatal: ambiguous argument 'nosuchref'`）；
- **日志真的取不到**在历史里就有：`run 40388037491` 的 `build / Build macos-x64` 现在是 **HTTP 404**（日志已过期）
  ⇒ 该作业那一段打 `logs-unavailable: the API returned an empty log (gh: HTTP 404)`，退出码 3。
- 同一次查询还顺带引出一份真实根因：`run 40368147837` 的 `Error: Timed out waiting for the packaged macOS
  web service.`（两次失败步骤：`Enforce the macOS Developer ID signature gate`、`Enforce platform certification`）。

## 五 边界（不许读成更强）

1. **它不替代读日志**：digest 只做「引文 + 落盘路径」，判断仍要打开那份文件。极限情况下（失败原因是产物层面的事，
   比如某一步 `exit 1` 而没有任何 `Error:` 行）它只会给出 `##[error]` 计数与失败步骤名，此时**它不会编一个根因**。
2. **「日志读不到」与「没有失败」是两态**，代码与用例各自钉住（用例 `names an empty log instead of reading it as
   "no failure" (exit 3)`）。
3. **没有做**：junit + artifact 上传（要动受保护的 workflow 文件，且体积问题已由 `2ccb6f8c` 治掉 76%），
   以及把 digest 接进任何自动流程 —— 它现在是**人/执行器手动运行**的工具，本轮不给它加调度。
4. `gh` 的行为只按实测记录，未追到底是版本缺陷还是本机网络 / 代理交互。
