# H2 —— DOCX 表格保真：把「字面写的规则」和「屏上画出来的规则」放在一起对比

日期：2026-10-30 · 单元：v2.21.0 / H2（DOCX 表格/边框/版式保真口径）
落点：`src/renderer/src/pages/workspace/previews/docx-table-borders.ts`（新增）
接线：`office-renderers.ts` 的 docx 分支 + `office-package.ts` 的 `readDocxPartText`
对比用例：`docx-table-borders.test.ts`（**真 `docx-preview`、真 docx 字节，无替身**）

## 一 缺口是什么（先用真渲染量出来，不靠读代码猜）

预览用的第三方渲染器把「表格外框」与「格子之间的规则」折成同一套样式。三种最常见的写法各错一处：

| 文档写法 | 渲染器给的结果（**改之前实测**） | 读者看到的失真 |
| --- | --- | --- |
| 表只声明 `insideH`/`insideV`（只画格子内部） | 四个格子的四条边**一条都没有**（`border-*-style` 为空） | 一张应该有细网格的表成了无框表 |
| 外框双线 3pt 绿 + 内部单线 0.5pt 灰 | 内部边也画成 **`3pt double #00aa00`** | 网格与外框一样重，表读起来像换了排版 |
| 表只写 `tblStyle="TableGrid"`（Word 最常见的「网格表」） | **全部无边**（渲染器不解析表样式的 `tblBorders`） | 报告里最常见的表格直接失去全部框线 |

同一批读数里两条**没有**失真、因此不该被我们重画的：单元格自己声明的 `tcBorders`（实测 `3pt solid #0000ff` 被正确画出）、纵向合并（`rowspan=2` 正确、续行渲染成 `display:none` 的隐藏格）。

## 二 修法与判据

`readDocxTableFacts(documentXml, stylesXml)` 读文档里的**字面规则**：每张表的六个边（外框四边 +
`insideH`/`insideV`），表自己没写时按 `tblStyle` 去 `styles.xml` 解析（只解析一层，样式继承链
不猜）；每个单元格的格子坐标（`gridSpan`、`vMerge` 的起始/续行）、以及单元格自己写的四边。

`applyDocxTableBorders(root, facts)` 按**渲染出来的格子几何**（`rowspan`/`colspan`、隐藏格跳过）
判断每条边是「外框」还是「内部」，再落成内联样式：

- 第 0 行的上边、最后一行的下边、第 0 列的左边、最后一列的右边 ⇒ 用外框那条规则；
- 其余 ⇒ 用 `insideH`/`insideV`；
- **单元格自己写了的边优先**（`tcBorders` 胜过表规则）；
- **表里一条规则都没写 ⇒ 一个像素也不动**（保真不是「替作者发明框线」）。

失败策略：这一段永远不许拖垮预览 —— 读不到 `word/document.xml` 时打一条**具名** warn
（`docx table rules not read (document part unavailable)`）再按渲染器给的样式照常显示；整段抛错
只 warn 不抛。成功时打一条 `console.info('[office-preview] docx table borders reconciled', { … })`，
带 `tablesInSource / tablesRendered / tablesReconciled / cellsTouched / edgesApplied / unpairedCells`
六个计数 —— 有读数才知道它真的干了活、而不是静默跳过。

**不许猜的两种情形**：渲染格子数与文档格子数对不上（渲染器对网格的理解与文档不同）时，
`unpairedCells` 记差额、**不做逐格覆盖**（只落表级规则），不把规则错位安到别的格子上。

## 三 对比用例（9 条，全绿）

`npx vitest run src/renderer/src/pages/workspace/previews/docx-table-borders.test.ts` → **9 passed**。

用例自带「改之前」的读数（`expect(renderedEdge(…)).toBe('none')` 等），所以它同时是**缺口证据**
与**修好后的判据**；每条断言写的是文档字面值（`1pt dotted #ff00ff`、`3pt double #00aa00`、
`0.5pt solid #999999`、`0.5pt solid #000000`），不是把实现里算出来的东西再断言一遍。

| 用例 | 判据 |
| --- | --- |
| 只声明内部规则 | 内部四条边 `1pt dotted #ff00ff`；外框仍 `none`；`edgesApplied 8`、`cellsTouched 4` |
| 外框重、网格细 | 内部 `0.5pt solid #999999`、外框 `3pt double #00aa00`；`edgesApplied 16` |
| 只写表样式 | 改之前四边全 `none`；改之后 `0.5pt solid #000000`（`auto` → 黑） |
| 单元格自带规则 | 该格右边保持 `3pt solid #0000ff`，邻格左边仍是表的 `0.5pt solid #999999` |
| 表里没有任何规则 | `tablesReconciled 0`、`edgesApplied 0`、四边仍 `none` |
| 纵向合并 | 文档里 3 个格子、合并格 `rowSpan 2`；合并格的下边是**外框** `3pt double #00aa00`、右边是内部 `0.5pt solid #999999`；隐藏续行格不进规则表 |
| 网格对不上 | `unpairedCells 1`，且表级规则仍照常落（不猜测性覆盖） |
| `readDocxPartText` | 有的部件返回文本、没有的返回 `undefined`；不是包的字节返回 `undefined` 而不抛 |

配套回归：`npx vitest run src/renderer/src/pages/workspace/previews src/renderer/src/office-preview`
→ **43 files / 353 passed**（预览家族全绿，含既有 12 条被替身驱动的 docx 缩放/链接用例）。

## 四 边界（不许读成更强）

1. **没有真窗口读数**。上面所有读数来自 jsdom + 真 `docx-preview` + 真 docx 字节，**不是**真机窗口里
   的 office 预览 OOPIF。真机取证要一支认证 spec（`e2e/certification/` 目前**没有** office 预览的用例），
   本轮未做，已立案为下一步：夹具新增「按提示写一份带表格的 docx 产物」→ 真窗口点
   `Preview generated file …` → `page.frameLocator('[data-office-preview-frame]')` 读 `toHaveCSS`。
2. **测试里的 docx 用 stored（不压缩）条目**：jsdom 的 `Blob.stream()` 不是 Node 流，真预览走的
   deflate 解压路径在这个环境里跑不起来。压缩路径由产品自己的 `validateOfficePackage` 在每次预览中走到
   （它对每个条目都做一次解压），不是本单元新引入的。
3. **样式只解析一层**：`basedOn` 继承链没有解析；那种表的结论是「没有规则」，与「表里没写」同形，
   预览保持渲染器原样。
4. 上/下/左/右之外还有 `tblCellMar`（格内边距）、`tblInd`（整表缩进）两类版式量，本轮**没做**：
   渲染器当前行为未量，先不声称。
