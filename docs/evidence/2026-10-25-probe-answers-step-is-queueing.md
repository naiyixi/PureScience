# `load-probe-answers` 的 107/189 ms 不是文件，是主线程排队

**读数来源**：`compose runtime steps`（改完项目库与技能目录之后，它成了这两次启动里最慢的一项）。

```
runId 2efe78f0  load-probe-answers=107ms  （open-project-db=125ms）
runId 8cd93762  load-probe-answers=189ms  （open-project-db=127ms）
```

**这一步做的全部事情**（`src/main/ipc.ts:614`）：`probeAnswerStore.load()` → 一次 `readFile` + `JSON.parse`。

**文件本身**：`~/.purescience/settings/probe-answers.json`，**550 字节 / 6 条**。实测连读 5 次：

```
0.08 / 0.08 / 0.06 / 0.09 / 0.19 ms
```

**结论**：107/189 ms 里没有一毫秒花在这个文件上。`composeSteps.step` 计的是「从调用到 Promise 落地」
的墙钟，主线程正忙着别的步骤（同一批里 `open-project-db` 打开引擎、`restore-notification-inbox` 读库）时，
一个 0.08 ms 的读也会量成一百多毫秒。同一台机器上它 107 → 189 ms 的抖动，与代码无关。

**因此不做优化**：没有可压缩的工作。要把它归因清楚，需要的是 `composeSteps.step` 对**每一步**都记
`cpuMs`/`cpuShare`（目前只有超过阈值的慢步骤才记，`diagnostics/compose-steps.ts` 属另一条在制单元）。

**顺带记下**：`open-project-db` 在同一批里稳定在 125–127 ms（快路径命中），不再出现 330 ms。
