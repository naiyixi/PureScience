# macOS 打包冒烟门禁：一条读不出任何东西的红，先修仪器

日期 2026-10-27（执行器轮次）。对象：`scripts/macos-package-smoke.mjs`。

## 一 触发这次改动的真读数

`Nightly` run `40368147837`，绑提交 `6e1653e24969f1b797cf9a7e6aeefdea294a6e94`（本执行器的两笔：
诊断词表改动 + 计划档）。判决 **failure**。

作业级归因（先读作业，不读车道）：

| 作业 | 结论 | 失败步骤（第一个红的） |
|---|---|---|
| `build / Verify (lint + typecheck + test + package)` | success | —（用例 0 红） |
| `build / Build linux-x64` | success | — |
| `build / Build windows-x64` | success | — |
| `build / Build macos-arm64` | success | —（同一支冒烟步骤 passed，20.8 s） |
| **`build / Build macos-x64`** | **failure** | **17 `Smoke test macOS packages`** |

失败原文（作业 `121739119093`）：

```
17:50:33.671  ##[group]Run node scripts/macos-package-smoke.mjs --artifact-dir dist --signature-reading …
17:51:56.441  Error: Timed out waiting for the packaged macOS web service.
17:51:56.449      at waitFor (scripts/macos-package-smoke.mjs:63:9)
17:51:56.449      at async launchAndProbe (…:122:21)
17:51:56.449      at async smokeAppBundle (…:180:3)
```

随后两条红**都是它的后果**，不是独立缺陷：

- 步骤 18 `Enforce the macOS Developer ID signature gate`：`macSignature=unproven … an unobserved state
  must not be recorded as a pass` —— 冒烟没跑完，签名读数文件根本没被写出，闸门按设计拒收。
- 步骤 23 `Enforce platform certification`：`MACOS_SMOKE_OUTCOME=failure` ⇒ `macos_smoke ended with failure`。

## 二 这是不是「我改坏的」

三条对照，全部现取：

| 对照 | 读数 | 说明 |
|---|---|---|
| 同一提交的另一架构 | `Build macos-arm64` 同一步骤 **passed**，整支脚本 20.8 s（两次启动） | 同一棵树、同一支脚本 |
| 前一笔提交（`37b236cc`）同一条车道 | `Build macos-x64` 冒烟 **passed**，整支脚本 30.0 s | 同架构基线 |
| 本笔改动面 | 只有诊断日志字段与计划档，**零** `scripts/**`、零打包路径 | 不可能是它 |

⇒ 判决：**间歇红**（x64 runner 上单次启动卡住 >60 s；健康基线是整支 30 s、每次启动约 15 s，限值 60 s
并不在刀口上）。**不重跑单作业**（会与下一次推送的车道抢并发组，且「取消 ≠ 绿」）；由下一次推送的
`Nightly` 给出新的独立数据点。

## 三 为什么先修仪器而不是修产品

原消息 `Timed out waiting for the packaged macOS web service.` 把**四种完全不同的情形压成同一句话**：

1. 应用根本没起来（崩在启动早期）；
2. 应用起来了、也打印了端点，但**格式变了**、正则不再匹配（阅读器坏了）；
3. 应用起来了、什么都不打印（卡在 provision / 首启迁移）；
4. runner 太慢（环境问题）。

而这四种的下一步动作完全不同（改产品 / 改正则 / 加埋点 / 换 runner）。按「仪器读不出值 ≠ 值不在」
的规矩：先把这四种分开，再谈成因。

## 四 交付（`scripts/macos-package-smoke.mjs` + 同名用例）

超时消息现在自己说明它看见了什么：

```
Timed out waiting for the packaged macOS web service (<哪个包>) after <实测> ms (limit 60000 ms).
- process: still running (pid N) when the limit expired | already exited with code N | already exited on signal S
- service announcements: none — the app never announced a web endpoint
                       | N line(s) mentioned the endpoint but none matched http://127.0.0.1:<port>/?token=… (format drift)
- last output (2000 chars max, tokens redacted):
<尾巴 或 (the app wrote nothing to stdout or stderr)>
```

- **哪个包**：冒烟会跑两次（DMG 挂载的那份、ZIP 解出来的那份），原来分不出是哪一次卡住；现在标签里带**产物名**。
- **活着的进程**：说明「崩了」还是「没崩但没就绪」；并把 pid 落进日志。
- **有没有宣告过端点**：`none` 与「有行但解析不了」是两件事（后者是格式漂移）。
- **输出尾巴**：上限 2000 字符，`token=…` 一律 `<redacted>`（服务地址带 bearer token，不能进 CI 日志；
  `exit before healthy` / 非零退出两条既有分支的原文也一并对 token 脱敏）。
- **别的分支不改写**：只有被 `code: 'SMOKE_TIMEOUT'` 标记的那条会被重写，其余错误原对象透传。

**没有做的事（具名）**：`STARTUP_TIMEOUT_MS` 一个数字都没动。健康基线 30 s（x64）/ 20.8 s（arm64）
对 60 s 限值，把限值调大只是把一次红换成一次更晚的红。

## 五 证据

**真进程探针**（`/tmp/probe-startup-timeout.mjs`，跑完即删）：用一个只会 `sleep` 的假包跑真实
`launchAndProbe`，实测：

```
PROBE elapsed=60.2s
Timed out waiting for the packaged macOS web service (PROBE-bundle (fake app that never announces)) after 60185 ms (limit 60000 ms).
- process: still running (pid 28144) when the limit expired
- service announcements: none — the app never announced a web endpoint
- last output (2000 chars max, tokens redacted):
(the app wrote nothing to stdout or stderr)
PASS ×6
```

⇒ 这条贯通的是**真的子进程 + 真的缓冲 + 真的计时**，不是拼字符串。

**用例 10 条**（`scripts/macos-package-smoke.test.ts`）：消息四要素、空输出与「有输出但解析不了」分开、
尾巴有界、`token` 脱敏、`waitFor` 给自己的超时打标、`toStartupFailure` 只改写被标记的那条。

**四条变异逐条变红**（不是「加了断言」就算数）：

| 变异 | 变红用例 |
|---|---|
| 消息里去掉包标签 | 2 条（四要素 + 贯通） |
| `redactServiceTokens` 变成恒等 | 1 条（token 泄漏） |
| `toStartupFailure` 原样透传 | 1 条（贯通） |
| `waitFor` 不打 `SMOKE_TIMEOUT` 标 | 1 条（打标） |

还原后 10 passed。

## 六 门禁

| 环 | 读数 |
|---|---|
| `eslint --no-cache scripts/macos-package-smoke.mjs scripts/macos-package-smoke.test.ts` | **0 error / 0 warning** |
| `tsc --noEmit -p tsconfig.node.json --composite false` | **0** |
| `tsc --noEmit -p tsconfig.web.json --composite false` | **0** |
| `scripts/macos-package-smoke.test.ts` + `scripts/windows-release-workflows.test.ts` | **22 passed** |

## 七 具名未办 / 风险

1. **下一次真超时才会长成新样子**：这一版只保证「红的时候话变清楚」，不保证红变少。真正的成因
   （x64 上首启卡在哪一步）要等一次带输出的红才能定，届时看 `service announcements` 与输出尾巴。
2. **`child.kill('SIGKILL')` 只到直接子进程**：探针里假包的孙进程（`sleep`）继承了管道，父进程因此
   不会退出（我自己第一次探针就是这么挂住的，靠显式 `process.exit` 收场）。真实失败里那一步是
   17:51:56 立刻结束的（说明打包态没把管道交给孙进程），所以这是**具名风险、不是当轮要修的东西**：
   改成整进程组杀会动到产品的子进程信号语义，需单独立项。
3. **没有真机打包态读数**：本机没有待测的 `.app`，走的是「真子进程 + 假包」的探针；这条不冒充打包态。
