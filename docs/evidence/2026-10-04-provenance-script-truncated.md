# 溯源「脚本被截短」+ 共享运行单元格的徽章 —— 证据（2026-10-04）

## 两个发现（同一处代码，两件事）

普查命中 `scriptTruncated` 后逐层读下去，落在一处共用的运行单元格 `NotebookDialogCell`
（`SessionNotebookDialog.tsx:42`，**会话笔记本弹窗与溯源面板的执行页共用**）：

1. **被截短的脚本当作完整脚本展示**：主进程存下的是**截短后的 `script`**，与原脚本不同即打
   `scriptTruncated: true`（`provenance-repository.ts:1046-1053`）；而面板的投影 `toNotebookRun`
   （`ArtifactProvenancePanel.tsx:122`）**把它丢掉了** ⇒ 单元格展示（并被 `.ipynb` 导出携带，
   导出拼单元格的代码在 `:257` 用 `run.script`）的是一段**残缺脚本，却无人告知**。
   注意这与「执行证据被上限截断」不是同一件事：后者已有带数字的提示（`:1204-1210`，
   `omittedLeadingRunCount/omittedOutputCount/omittedInputCount`），而**脚本本身**被截没有。
2. **同一种「把非失败说成 error」的第二个实例**：该单元格（`:66-73`）与我上一轮修的
   `NotebookPreview` 一样，把 `failed | timeout | interrupted` 一律印成 `error`——而领域层明说
   app-terminated 中断**不是失败**（`repository.ts:273`）。

## 改法

- **提示上屏**：单元格新增可选 `scriptTruncated`，为真时在代码块上方给出
  `data-testid="session-notebook-cell-script-truncated"` 的提示（1 键 × 9 语：`artifact.scriptTruncated`）；
  面板投影把标记**带出来**并传给单元格。
- **徽章按状态分说**，且**抽成一个共享函数** `problemBadgeLabel`（`notebook-cell-utils.ts`）——
  两处单元格（预览面与弹窗面）从此**不可能各说一套**；`failed ⇒ error / error (line N)`、
  `timeout ⇒ timed out`、`interrupted ⇒ interrupted — <具名原因>`。原徽章文案是硬编码英文，一并收入
  上一轮已加的 5 键（`ws.notebookRun*`）。

## 读数

```
[dialog-cell-badge]  interrupted — the app closed before it finished
[dialog-cell-script] This script was shortened before it was stored — it is not the whole script.
Test Files  4 passed (4)
     Tests  44 passed (44)
```

- 新组件级用例（`NotebookDialogCell.render.test.tsx`，3 支）：中断徽章（不含 error）、真失败仍是
  `error`、截短提示出现/不出现；
- 同批 4 个测试文件（含预览面、弹窗面、溯源面板）**44 passed**；`translation-quality` **42 passed**；
  `typecheck:web` **0**；`eslint` 0 problems。

## 过程中的两个坑

1. **脚本插 i18n 的锚点必须在「整条条目之后」**：`artifact.reconstructionBounded` 是跨行写法
   （值在下一行），我按「键行之后插入」把九份字典**全部**打断（测试直接 collection 失败）。
   修法：先移出我的行，再走到锚点值行之后插入；修完门禁 42 passed。**下次插值一律先看锚点是不是跨行。**
2. **溯源面板的执行页在我这次的夹具路径下没有渲染单元格**（诊断读数 `cells=0`，标签已切到
   Execution Log，页面文本只有头部与 `notebook-run-2`）。我**没有继续深挖**，因此：

## 未取（具名，未放宽断言）

- **面板级（Execution Log 里单元格出现截短提示）这一条没有运行时测试**：我写了两条面板级用例，
  在 `cells=0` 的情况下无法成立，已**撤掉**（不留假装通过的空壳）。它覆盖的接线是一行
  （`toNotebookRun` 带出标记 → 传给单元格），由类型检查保证；**行为**由组件级用例覆盖。
  补法：先弄清该夹具为何不渲染单元格（`cells=0`），再补面板级断言。
- **真窗口读数**未取（需一条被截短的长脚本运行）。
