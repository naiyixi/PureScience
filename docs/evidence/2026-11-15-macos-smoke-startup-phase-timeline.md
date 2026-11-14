# macOS 打包冒烟超时：把「它卡在哪一步」写进失败里，而不是留在 2000 字符的输出尾部

日期：2026-11-15（执行器）
触发来源：`198c5f2f` 的 Nightly 红在 `Build macos-x64`（`scripts/macos-package-smoke.mjs` 的启动等待超时）。

## 一 那条红的原始读数

run `43613880366`，作业 `Build macos-x64`，步骤 `macos-package-smoke.mjs --artifact-dir dist`：

```
Error: Timed out waiting for the packaged macOS web service (DMG-mounted bundle
       zerolink-purescience-2.27.0-nightly.g198c5f2-mac-x64.dmg) after 60167 ms (limit 60000 ms).
- process: still running (pid 22331) when the limit expired
- service announcements: none — the app never announced a web endpoint
```

同一份日志里，应用自己打印的启动阶段（`[main] operation phase`）走到：

| 阶段 | 应用自报 elapsedMs |
| --- | --- |
| `load-bootstrap-modules` | 1,468 |
| `single-instance-lock` | 1,811 |
| `prepare-runtime` | 1,813 |
| `load-application-modules` | 1,818 |
| `electron-ready` | **26,931** |
| `compose-runtime` | **31,676** |

**这条读数的边界**（不许越过）：

- 它证明的是「进程还活着、而且到 31.7 s 还在推进」，**不证明**它最终会宣告 web 端点；
- 60 s 预算里剩下的 28 s 内既没有新阶段也没有端点行 ⇒ 只能记「预算内没等到」，不记「它卡在 compose-runtime」；
- 同一提交的 `Build macos-arm64` 作业**通过了同一段冒烟**（同 run），`Verify`（lint+typecheck+test+package）也是 success
  ⇒ 在这份证据上，macos-x64 那条红不是本批代码的缺陷，更像**这台 intel runner 的启动预算不够**。这只是当时能给出的最强归因，
  下一笔提交的车道若在 x64 上再红一次，就按「复发」处理（见 §四）。

## 二 缺口：这条读数当时只能靠翻 2000 字符的输出尾部

`describeStartupTimeout` 本来已经会写三件事（哪个 bundle、进程还在不在、有没有宣告行），但**没有**写出
「退到了哪个启动阶段、那时已经多久」。而这三者的组合恰恰决定归因方向：

- 阶段停在很早的位置且不再推进 ⇒ 应用卡住（产品问题）；
- 阶段推进到很晚、只是慢 ⇒ 机器慢（预算问题）；
- 一个阶段都没有 ⇒ 应用没进到主进程日志（更早的失败）。

所以本次改的是**仪器**：把应用自报的阶段时间线解析出来，作为失败信息的一行。

## 三 改动

| 位置 | 改动 |
| --- | --- |
| `scripts/macos-package-smoke.mjs` | 新增 `extractStartupPhases(output)`：按 `[main] operation phase` 切块，取 `phase` + `elapsedMs`；**缺时间的块整块丢弃**（「到过这里但不知道什么时候」不能当一条阶段读数）。`describeStartupTimeout` 增加一行 `- startup phases: N reported, last '<名>' at <ms> ms ⇒ <最近 6 条时间线>`；一条都没有时写 `none — the app never reported a startup phase` |
| 同上（成功态） | `launchAndProbe` 拿到端点后打一条 `packaged startup (<label>): endpoint announced after <ms> ms; startup phases: …`。**通过的那一侧此前一条读数都没有** ⇒ 任何「这台 runner 是不是比昨天慢」的问题都没有基线；有了它，复发时才能拿「两台跑道的通过耗时」对照，而不是只凭一次超时下结论 |
| `scripts/macos-package-smoke.test.ts` | 用真实日志形状（上面那张表里的四条阶段）钉住：条数、最后阶段名与毫秒数、时间线里含 `electron-ready@26931 ms`；「一个阶段都没有」那态单独断言；缺 `elapsedMs` 的截断块被丢弃 |

**没有改超时预算**（仍是 60 s）。加预算是另一件事：它会把「机器慢」这类红变成绿，需要先有复发读数与「慢在哪一段」的分段证据，
否则就是拿加大超时把一道闸门调成常绿。这一条写在 §四。

## 四 边界与具名未办

1. **不证明 x64 在真机上启动要多久**：这条读数来自 CI 的 intel runner，不是用户机器；本地也没有打包态 x64 读数。
2. **预算是 60 s 没动**：若 `fa624f13`（含本笔之后仍用同一预算）在 macos-x64 上再超时一次，按复发处理，下一轮的分岔是
   （a）给冒烟加「阶段停滞」判据（例如最后阶段 15 s 不推进就判卡住）而不是单纯加时长，（b）按平台给预算并写明依据。
   两者都要附两台跑道的对照读数，不能只凭一次。
3. **阶段名是应用侧打印的字符串**：改名会让这里变成 `none`（同样是真实读数，只是解释力下降）；因此解析规则用「找 marker 块里的
   任意 `phase`/`elapsedMs`」，不写死阶段名清单。

## 五 门禁（本机实跑，2026-11-15 03:2x CST）

| 环 | 读数 |
| --- | --- |
| `npx vitest run scripts/macos-package-smoke.test.ts scripts/ci/mac-signing-status.test.ts --maxWorkers=1`（成功态那条用例补上之后） | **2 files / 34 passed**，exit 0 |
| `npx eslint --no-cache scripts/macos-package-smoke.{mjs,test.ts}` | 0 problems |
| `npx prettier --check`（同上） | 通过 |
| 直接跑脚本（空 artifact 目录 + `--signature-reading`） | exit 1，marker 落盘，`reason` 为真实那句 `Expected exactly one macOS dmg …; found 0` |

首版把 `extractStartupPhases` 同时写成 `export const` 并列入文件末尾的导出表 ⇒ Node 报 `SyntaxError: Duplicate export`，
`leaves the marker on disk when the script itself fails` 这条用例当场抓住（marker 没落盘）；把 `describeStartupPhases` 提成导出时
**又犯了一次同一个错**，同一条用例第二次抓住。修法与判定都在同一轮里 —— 这条用例的价值不在它能测出格式漂移，而在它**真的会跑起脚本**。
