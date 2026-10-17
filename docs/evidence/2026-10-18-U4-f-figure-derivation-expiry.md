# U4-f 证据档：换输入 / 换模型版本 ⇒ 旧派生结果被标过期

日期：2026-10-18（执行器轮次）
提交：见本轮推送（`git log --oneline origin/main -1`）

## 一 缺口是什么（读源，不是推测）

插图派生（`figure-derivation`）这一类记录早就把「这段结果由什么产出」拆成两样落盘：

- `inputFingerprint`：页面 / 框 / 图注 / 图内文字 / 具体那一行的输入指纹（`sha256:<64 hex>`，外部可复算）；
- `modelRevision`：产出它的模型版本（化学一路是「引擎@版本」）。

而 `src/shared/figure-observation.ts` 的字段注释里写着读侧会「据此把旧结果标过期」——**全树没有这个判决函数**：
`grep -rn "figureDerivationStatus\|superseded" src/` 在改动前零命中（`supersededBy` 只出现在别名血缘那一域）。

同一处还有第十六种形状的第二半：`modelRevision` 在契约里（`FigureDerivationObservation.modelRevision?`）、
面板也照着渲染，但**生产里从来没有写入方** —— `onFigureDerivation` 的记录调用没有传它。于是即便加判决，
「换模型版本」那一路也永远比不出来（读侧有、写侧从来没有写入方）。

## 二 交付（17 文件，+445 / −13）

| 面 | 改动 |
| --- | --- |
| 共享判决 | `src/shared/figure-observation.ts`：新增 `FigureDerivationStatus`、`figureDerivationModelRevision()`、`figureDerivationStatuses(rows)`。同一张图＝页 + 图序；按**日志顺序**（追加顺序即时间顺序，不拿时间戳排——同毫秒两条会互相盖掉）与**最新一条**比：输入指纹不同 ⇒ `input-changed`；指纹同而模型版本不同 ⇒ `model-revision-changed`；两样都同 ⇒ 仍 `current`（同一份输入同一批模型再算一次，结论没变）；非派生行返回 `undefined`（**缺席 ≠ 通过**是结构性的） |
| 契约 | `src/shared/artifact-provenance.ts`：`RecordedStructureObservation.figureDerivationStatus?`，只出现在派生行上 |
| 读侧接线 | `src/main/artifacts/provenance-repository.ts`：判决用**整本日志**算（后一次派生常落在本版窗口之外，按窗口算会把该标过期的全判成 `current`），再挂到窗口内的行上；窗口语义（`projectStructureObservationWindow`）一字未动 |
| 写侧补口 | `src/main/ipc.ts`：记录时写入 `modelRevision`；确定性一路（图内数值取自文字层、库号查真库）**没有模型** ⇒ 缺席，不造版本号 |
| 界面 | `ArtifactProvenancePanel.tsx`：过期行渲染 `data-testid="artifact-figure-observations-superseded"` 徽标 + 原因句 + 取代时刻；`current` 不渲染 |
| 九语种 | 2 键 × 9 语言（`add-i18n-keys.py` 写入并自证九文件齐全），zh ≠ en，zh-Hant 繁体 |

## 三 门禁读数（全部实跑；数字取自最后一次改动之后）

| 项 | 读数 |
| --- | --- |
| 定向 vitest（7 文件） | **145 passed**：判决矩阵 7 条（无后续 / 换输入 / 换版本 / 两样都同 / 非派生行 / 同毫秒顺序 / 跨窗口推翻）、1 条「版本写出之后那次派生照样推翻它」的整日志读数、1 条面板徽标 + 「`current` 无徽标」 |
| `tsc --noEmit -p tsconfig.node.json --composite false` | 0 error |
| `tsc --noEmit -p tsconfig.web.json --composite false` | 0 error |
| `eslint --no-cache`（本次 17 文件） | 0 problem（首轮 2 条缺显式返回类型，已按报错改测试助手，**未放宽规则**） |
| i18n 套件 | 52 passed（九语齐全、zh ≠ en、zh-Hant 繁体） |
| 全量 vitest（改过 `src/shared/**` 的跨层结果类型 ⇒ 按纪律跑全量） | 见本档末「补记」 |

## 四 边界（不许读成更强）

- **真机窗口读数尚未取**：本条新增的徽标是渲染层可见面，按红线要以真窗口取证（一条既有会话里同一张图两次派生、
  第二次改框或改引擎版本）。本轮未取，**具名立案**：下一轮用认证 spec 或既有 e2e 夹具补，取不到就拿不到。
- 判决只比「同一张图的最后一次派生」。同一张图在**两个不同会话/版本窗口**里各派生一次时，判决按该会话自己的
  日志算（每份日志独立成账），跨会话的推翻不在本单元的口径内。
- 「输入指纹」的配方未改；本单元不改变什么算输入，只改变「旧结果还站不站得住」的判决与呈现。
