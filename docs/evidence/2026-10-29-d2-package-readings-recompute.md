# D2 — 包内读数与「导入后逐字段复算」：真机读数

日期 2026-10-29 20:3x CST｜同一份用例 `e2e/certification/session-package-three-surfaces.spec.ts`
（`1 passed (33.3s)`，真窗口 + 真 HTTP + 真 CLI）｜读数 `test-results/d1-session-package/readings.json`

## 1 这条验收在证什么

D1 让包能从三端进出；D2 要的是**包里的数字可以被复算，并且复算的结论留得下来**。之前的状况：

- 成本摘要（`manifest.usage`）与工具调用读数（`manifest.toolReadings` + `evidence/tool-calls.json`）
  在**预览**里已经逐字段核对过（不一致的包直接 `manifest-invalid`）；
- 但**导入结果与导入记录里没有这个结论** —— 用户/脚本事后问「这个包的数字核对过没有、哪几项对上了」
  无从回答，只能重新走一遍预览。

本轮补的是后半段：导入时把复算结论写进结果与记录，并在会话上的只读横幅里显示。

## 2 改了什么

| 位置                                             | 改变                                                                                                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionPackageImportPreview.described.readings` | 预览就带出逐字段结论（成本 / 工具调用）                                                                                                                                |
| `SessionPackageImportResult.readings`            | 导入结果带同一份结论（CLI/HTTP 直接可读）                                                                                                                              |
| `SessionPackageImportRecord.readings`（可选）    | 落盘到 `sessions/<project>/<id>.import.json`，重启后仍可读；缺字段 = 老记录，绝不读成一致                                                                              |
| `SessionPackageUsageComparison` 的 `match`       | 从 `{ state:'match' }` 改成 `{ state:'match', derived }` —— 只回一个 match 而不带数，接收端仍然不知道这个包花了多少                                                    |
| `readings.toolCallsDeclared`                     | 工具读数声明原样带出。`toolCalls: match` **只**说明「声明与字节一致」；声明本身可能是 `absent:no-tool-calls` / `absent:not-collected`，两者都不能显示成「核对过 N 条」 |
| `SessionImportPostureBanner`                     | 会话上多两行读数（有 `included` 声明时才显示工具行），无读数时明说「没有复算」                                                                                         |

区分两种「一致」：**usage 的 match 是「数算过且相等」，toolCalls 的 match 只是「声明与字节相符」**。
界面与 CLI 都按这个区分渲染，用例 `SessionImportPostureBanner.render.test.tsx` 钉死。

## 3 真机读数（本轮）

CLI 导入同一条链（`purescience package import web.science --project <id> --json`，233 ms）：

```json
"readings": {
  "usage": { "state": "match",
             "derived": { "turns": 1, "inputTokens": 0, "outputTokens": 0, "turnsWithoutUsage": 0 } },
  "toolCalls": { "state": "match", "rows": 0, "unnamed": 0 },
  "toolCallsDeclared": { "recipe": "tool-call-readings:v1", "state": "absent:no-tool-calls", "unnamed": 0 }
}
```

- **usage `match`**：包内 `manifest.usage` 与按 `conversation.json` 复算的结果逐字段相等（turns 1，
  input/output 0，无「没有成本记录」的轮次 —— 这条会话的 agent 回合没有 usage 记录，派生器按规则报 0 并
  把未记录轮次分开计，这里 `turnsWithoutUsage: 0` 是因为该回合被 `turnUsageUnavailable` 明确标注）。
- **toolCalls `match` + `absent:no-tool-calls`**：清单声明「这次没调工具」，包内也确实没有那份文件，
  两者相符；因此**没有**任何「核对过 0 条工具调用」的说法，横幅不显示工具行。
- 导入记录 `sessions/<project>/<imported-id>.import.json` 里的 `readings` 与结果**逐字段相等**
  （用例断言 `persistedRecord.readings === imported.readings`）⇒ 结论不依赖计算它的那个进程。

## 4 有工具调用的包怎么读

真机会话（e2e 的确定性 fake agent）不产生工具调用，所以「有行数」的那一路由用例钉住，不是靠推断：

- `src/main/session-package/import.test.ts` › _reports what it recomputed_ —— 一个带 `evidence/tool-calls.json`
  （1 行、`sha256` 逐字节算出）的包，预览给出
  `toolCalls: { state:'match', rows:1, unnamed:0 }` + `toolCallsDeclared.state:'included'`，
  usage 给出 `{ turns:1, inputTokens:1200, outputTokens:300, turnsWithoutUsage:0 }`；
- `SessionImportPostureBanner.render.test.tsx` › 三例：有读数时显示数字、无读数时说「没有复算」、
  声明为 `absent:not-collected` 时**不显示**行数。

## 5 未做/不做

- 会话包**不含** `activities` 原文（工具活动在导出时就剥成消息上的投影），所以读数只能来自导出方采到的
  `tool-call-readings`；接收端复算的是「声明 vs 包内字节」，不是「把工具重跑一遍」。这条口径写在
  `shared/tool-call-readings.ts` 顶部的配方里，第三方不看代码也能复算。
