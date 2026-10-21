# 2026-10-21 · 认证车道「窗口没出现」的证据链：先证明证据本身丢了

> 本文只记**读数**与由此得出的判据。结论分两层：一层是这次红**为什么无法归因**（已确证），
> 一层是红**本身**在做什么（有量化线索，**未**确证，故不写结论）。

## 一 这次红落在哪

| 项 | 读数 |
|---|---|
| 车道 | `Nightly`，run `39511096581`，提交 `26dd678b`（完整 40 位 `26dd678be91ea6f82c5397bf7356e37b653451a4`） |
| 失败作业 | 只有一个：`build / Build macos-arm64` |
| 失败步骤 | `Enforce platform certification`（第 23 步） |
| 同作业其余步骤 | `Build & package`、`Run P0 Electron certification`、`Run desktop visual regression`、`Smoke test macOS packages`、`Enforce the macOS Developer ID signature gate` 全部 success |
| 套件自身汇总 | **95 passed / 8 flaky / 1 failed / 11 skipped（56.9 min）** |
| 唯一 failed | `e2e/certification/search-index-coverage.spec.ts:33` —— 两次尝试同为 `firstWindow: Timeout 30000ms exceeded`，栈指向 `fixtures/electron-app.ts:280`，调用方是 `restart()`（`:560`） |
| 另一条车道 | `Windows Full Test` 同 SHA **success**（该车道不执行认证 spec） |

`Run P0 Electron certification` 显示 success 而 `Enforce platform certification` 失败，是这条车道的既有形状：
前者带 `continue-on-error`，判决由后者给出。**按技能纪律「归因取失败步骤清单里的第一环」**，这里第一环就是
认证套件自己的 `1 failed`，不是下游的裁决步骤。

## 二 想读证据时发现：证据在上一次启动时就被删了

下载该作业的 artifact `p0-test-results-macos-arm64`（4.5 MB）后逐一清点：

- `test-results/` 下**只有一个** `app-process.log`（305 行），文件头是**一次正常启动**，文件尾是
  `operation completed { operation: 'application-shutdown', phase: 'completed', durationMs: 65 }`；
  它属于**整轮最后那次启动**（`window-find-overlay`，该 spec 通过），**不是**失败的那次。
- 原因在夹具里：`APP_PROCESS_LOG_PATH` 是**单一固定路径**，每次 `launch()` 都以 `flags: 'w'` 打开
  ⇒ **下一次启动把上一次的日志截断**。失败的那次是 `restart()` 的第二段，它的日志被同一 spec 之后
  任何一次启动覆盖；本轮是整轮最后一次启动覆盖的。
- 失败尝试的 `trace.zip` 里只有一个 `stdout` 事件，内容就是夹具收尾那行
  `[e2e] app process output (2489 bytes)` —— **应用自己的输出一个字节都没有进 trace**。

⇒ §两百零五 §五 第 3 条写的「需要 `test-results/app-process.log`，下次该车道红时先取该 artifact」
**按那时的夹具是取不到的**：artifact 里确实有这个文件，但它装的是**成功那次**的输出。这一条到此确证。

## 三 能取到的替代读数：失败留下的唯一痕迹是字节数

夹具收尾时打印 `(N bytes)`，而那一行进了作业日志。整轮 121 次启动的字节数分布：

| 统计 | 值 |
|---|---|
| 中位数 | **8,607 B** |
| 最小 | 1,472 B |
| 最大 | 39,959 B |

把最小的六个与它们的 spec 对上，**正好是本轮全部出问题的那几个**：

| 字节数 | spec | 该 spec 在本轮的结局 |
|---|---|---|
| 1,472 | `pdf-annotation-layer.spec.ts:315` | flaky（重试过） |
| 2,226 | `pdf-table-panel-reasons.spec.ts:37` | flaky |
| **2,489** | `search-index-coverage.spec.ts:33` | **failed（两次尝试同形）** |
| **2,489** | `session-package-round-trip.spec.ts:62` | flaky |
| **2,489** | `storage-migration-unfinished.spec.ts:64` | flaky |
| 2,593 | `ro-crate-export.spec.ts:63` | flaky |

两件事只有这组数能说明：

1. **这些启动只写出正常启动的三成左右就再无输出**（中位数 8,607 B）⇒「窗口慢」这个解释缺少支撑：
   窗口之前的部分**也没有写完**。
2. **三个不同 spec 的字节数完全相同（2,489）** ⇒ 那三次停在启动里**同一处**，是确定性的截断点，
   不是「慢一点」。对照一份完整启动日志（10,757 B），2,489 B 处大致落在
   `session-persistence` 的 hydration 早段、`install-lifecycle`（该步实测 3,859 ms）与
   `session-hydration`（473 ms）完成**之前**。

**边界（不许读成更强）**：不同启动的根路径不同，字节数不能逐字节对齐到某一行 ⇒ 上面对「停在哪一段」只能
说到**段落级**；也**没有**据此判定成因（进程退出？卡在某个 step？两条都符合现有读数）。所以本轮**不改产品代码**，
也不加超时。

## 四 这一轮改成什么（让下一次红自带证据）

| 位置 | 改动 |
|---|---|
| `e2e/fixtures/app-process-log.ts`（新） | 纯函数：启动日志命名（序号 + spec 标题 + 重试号）、日志首部（哪次启动 / pid / 两个根 / 时间）、退出态措辞、失败文案、有界读尾部（64 KB / 20 行）；`raceWindowAgainstExit` 与 `openWindowOrNameFailure` 把「等窗口」与「等进程退出」放在一起 |
| `e2e/fixtures/electron-app.ts` | 每次 `launch()` 写**自己的**文件 `test-results/app-process/<序号>-<spec slug>[-retryN].log`（另镜像一份到旧的固定路径，习惯不变）；`openMainWindow` 不再裸等 `firstWindow`：进程先退出就**立刻失败并给出退出码/信号 + 该次日志尾部**，超时则**保留原超时原因并说明「进程仍在运行」** |
| `test/app-process-log.test.ts`（新，15 例） | 命名的序号/重试/长标题截断、退出态措辞、文案含路径与尾部、空尾部不打印空段、竞态两条分支、`openWindowOrNameFailure` 三条分支（含**「进程已退出时不花 30 s」**，断言 <1 s）、尾部读取对真实文件与缺失文件两态 |

判据：失败信息必须能回答三个问题 —— **哪次启动**（文件名 + 首部）、**进程死了还是活着**（`exited (code=…, signal=…)` / `is still running`）、**它最后写了什么**（尾部原文）。

## 五 未办（每条带解封条件）

1. **这九条红的成因**：`blocked-by` = 需要下一轮该车道红时**按新命名读那次启动自己的日志**；本轮没有任何一次
   真机重跑（内存闸门：空闲页 5,042 ≈ 78 MB、`swap used 12.95 G / 14.34 G`，机器上跑着打包版实例、dev Electron
   与桌面会话）。解封后第一步：取 `test-results/app-process/` 下**那次**的日志，看它是「退出」还是「停在某一步」。
2. **`Run P0 Electron certification` 步骤显示 success 而套件有 1 failed**：这属该车道的既有设计
   （`continue-on-error` + 下游裁决），但「步骤绿点与真判决不同形」本身容易误读；要不要让它自己的红显式化，
   属车道设计决定，本轮不动 `.github/**`（受保护）。
3. **`firstWindow` 的 30 s 是否需要动**：**不动**。在拿到第 1 条之前加大超时等于把一条未知成因的红改成更慢的红。
