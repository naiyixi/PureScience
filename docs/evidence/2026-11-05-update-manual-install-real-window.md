# 更新链路的真机读数：安装包下载 → 摘要校验 → ready，以及 macOS「必须手动替换」那句

> 单元范围：用户在更新这条路上的两句承诺。① 打包版是 ad-hoc 签名，macOS 拒绝原地替换运行中的应用，
> 所以界面要说「下载安装包、自己替换」——这句话（`update.macManualInstallNote`）此前**只被渲染测试覆盖过，
> 从未在真窗口出现**；② 从清单到 `ready` 的整段（下载、流式 sha256、状态广播、对话框）没有真机读数，
> 既有规格停在 `available` 就断言完了。

## 零 同批发现并修掉的一处红：写死的发行版本号

`e2e/update-release-notes.spec.ts` 把待发行的版本写死成 `1.99.0`，而应用自身已经是 `2.26.0` ⇒
更新检查按 `isNewer` 判定「已是最新」，对话框根本不打开，本机实跑 **1 failed**，
报错是「找不到 `更新到 1.99.0` 按钮」，读起来像产品缺陷。两份规格改为从 `package.json` 的主版本号 +1 推导，
应用再不升级也不会把这两支规格悄悄变成「断言一个不存在的对话框」。

## 一 被替换的缝，与留下的真路径

| 项 | 是真的 | 唯一被替换的 |
| --- | --- | --- |
| 更新检查 / 下载 | `UpdateService`、`downloader`（流式写入 + 逐块 sha256）、状态广播、update store、对话框、Chromium 布局 | Electron `net.fetch` 收到的**字节**：`version.json` 与安装包本体都由夹具按路径名应答 |
| 保存位置 | 应用自己算默认文件名、自己走保存对话框 | 原生保存对话框（没有任何测试能操作它）——`stubSaveDialog` 指到隔离目录 |

安装包字节是规格自己造的 64 KiB 确定性数据，清单里的 `sha256` 由规格现算；**应用仍按清单摘要校验**，
摘要不对就是一次失败的下载（见第三节的变异自证）。所以「到达 `ready`」这件事本身证明了字节对得上。

## 二 读数（本机真窗口）

| 项 | 读数 |
| --- | --- |
| 命令 | `npx playwright test e2e/certification/update-manual-install.spec.ts e2e/update-release-notes.spec.ts --reporter=list`（先 `npm run build:e2e`，`✓ built in 21.30s`） |
| 判决 | **2 passed (12.0s)**，`EXIT=0`；本支 `1 passed (5.3s)` |
| 规格自己的读数 | `[update-cert] state=ready artifact=PureScience-3.0.0-arm64.dmg bytes=65536 sha256=755682d23142 installer=yes` |
| 主进程日志 | `[update] operation started { operation: 'update-download', strategy: 'manifest' }` → 四个阶段 `validate-source=1ms select-target=1ms prepare-target=1ms transfer=2ms` → `completed { result: 'ready' }` |
| 出网那一行 | `[http-request] req-86b3d206 …/releases/download/v3.0.0/PureScience-3.0.0-arm64.dmg -> 200` |
| 磁盘 | 目标文件 65 536 字节，摘要与清单逐字符相等；`.part` 兄弟文件不存在（流式写入收尾干净） |
| 上屏的三句 | 「Downloaded — click “Open installer” to finish updating.」+「Quit PureScience before installing — a running app cannot be replaced.」+「macOS builds are ad-hoc signed for now, so macOS refuses to replace a running app in place — download the installer and replace it by hand.」 |
| 动作按钮 | `Open installer` 在屏，`Restart to update` **恰好 0 个**（安装包路线不承诺原地重启） |

## 三 反向对照与变异自证

- **反向对照（同一支规格内）**：`available` 态下三句提示与 `Open installer` 全部计数为 0 —— 这些句子属于
  `ready`，不是「一有更新就出现」的装饰。
- **变异自证**：把清单里钉的摘要改成 `'b'.repeat(64)`（服务端字节不动），同一支规格 **1 failed**，
  停在「`update-ready-hint` 不可见」⇒ 这一次通过确实是「字节被哈希过」换来的，不是把状态机说服了。

## 四 边界（不许读成更强）

- 这支规格是 **macOS 专属**（`test.skip(process.platform !== 'darwin')`）；CI 上它只会在 `macos-arm64`
  的构建作业里被执行，其他平台的车道绿不构成它的证据。
- 三句文案是**逐字复制**进规格的：改文案就必须同步改这里，这是有意为之（规格要钉读者看到的话）。
- 没点 `Open installer`：那一步是 `shell.openPath`（打开真实安装包），规格不替用户启动安装器。
- 5.3 s 不是性能基线，只是这支规格的墙钟。

## 五 补上 v2.22 的完成判据：一次检查 = 一次请求，且更新作用域没有说过失败

排期档给这一版写的完成判据是「冷启动一次更新检查只打一次网络请求、无 error 级日志」，此前没有任何读数
（既有规格停在「对话打开」或「下载到 ready」，都不数请求）。现在同一支规格在 `ready` 之后补两件事：

- **计数口径**：读**本次启动自己那份被捕获的输出**（`app.currentLaunchLogPath`，即主进程日志的 console 镜像），
  而不是 `~/Library/Logs/PureScience/main.log` —— 后者在本机同时被常驻的 dev 实例写入，读到的一行可能属于
  另一个进程。基线取在点击 `Check now` **之前**，断言的是**增量恰好 1**，因此启动时那次自动检查不会混进来。
- **失败那一半**：更新作用域（`[update]`）在本窗口内不得出现 `error|failed|refus` 措辞。**具名边界**：console
  镜像不带 `level` 字段，所以这一半不是「没有 `level=error` 的记录」，而是「更新作用域没有说过失败」；
  要按 `level` 判定只能去读共享的 JSONL 主日志，而它在窗口期内被别的实例写入、本轮又正好到 5 MB 轮转线，
  读数不可归因，故不采用，也不把它写成已测。

读数（本机真窗口；`npm run build:e2e` 后 `npx playwright test e2e/certification/update-manual-install.spec.ts`）：

| 项 | 读数 |
| --- | --- |
| 规格自己打印 | `[update-cert] state=ready … manifestRequests=1 updateFailures=0` |
| 判决 | **1 passed (7.9 s)**，退出码 0 |
| 变异自证 | 把增量断言改成 `toBe(2)` 后重跑：`Expected: 2 / Received: 1` ⇒ 计数器确实只读到一次请求，断言不是恒真 |

**冷启动那一半（2026-11-06 补测）**：判据写的是「冷启动一次更新检查」，而上面那张表数的是读者点的那一次。
`scheduler.ts` 在启动时就 `void strategy.check()` 一次 ⇒ 冷启动自己那次也要数。同一支规格现在在点 `Check now`
**之前**先等这次自动检查落定（`expect.poll` 30 s 窗口，因为 onboarding 可能先完成、请求后到），断言
「本次启动自己的日志里清单请求恰为 1、`[update]` 无失败措辞」。读数：

```
[update-cert] state=ready … coldStartRequests=1 coldStartFailures=0 manifestRequests=1 updateFailures=0
1 passed (7.8s)
```

两半合起来才是判据的原话：**冷启动 1 次请求 + 读者那次 1 次请求，各自都没有失败记录**。口径同前：
计数只读本次启动自己的 console 镜像（别的实例写不进这份），失败仍按更新作用域的措辞判而非 `level=error`。

## 六 同批补上的一条死循环：检查没有自己的截止时间

「无 error 级日志」这条判据的反面是**根本没有日志**：`UpdateService.check` 只 `await` 清单请求，而
`manifest.ts` 给的 `AbortSignal.timeout(10_000)` 只保证「请求被叫停」，不保证那个 `await` 会落定
（重定向链在传输层内部处理、套接字半死时，abort 之后 promise 仍可能悬着）。悬着的代价是状态广播停在
`checking`：界面不报错、也不再提供重试，读者只能重启应用。

修法是给检查自己一条 15 s 的兜底期限（`CHECK_DEADLINE_MS`，让传输层自己的 10 s 先说话），超时即落成
**具名的失败**并照常记一条 `update-check / failed` 诊断。单测 `settles as a named failure when the
manifest fetch never settles`（假计时器把 15 001 ms 推过去，断言 `state=error`、错误句带 `did not settle
within 15000 ms`、广播收到 `error`、诊断里有 `update-check / failed`）。

**具名边界**：本轮**没有**复现出「真实请求悬停」那一次现场，因此这半的证据是**结构性的**——一个没有
结算上限的 `await` 会让状态永远停在 `checking`，这一点由代码形状可读；单测证明的是「期限到了会落成
具名失败」，不是「线上一定悬停」。要把它写实，得在断网/半死套接字的机器上跑一次打包版并留下日志，
那一份读数目前**没有**。
