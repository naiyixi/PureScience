# PDF 页文本的行与段落（A1 前置缺陷修复）

> 单元：把「页文本拼装」从 `join('')` 换成保留行结构的单一来源。
> 起点提交：`88b865b0`（本轮开工时的 HEAD）。本档随修复同批提交。

## 一 缺陷与机制（对源核实，非推断）

渲染层与主进程各有**一个**「把 pdfjs 的 text items 拼成整页文本」的站点，两处都是同一行写法：

| 站点 | 旧写法 | 消费者 |
| --- | --- | --- |
| `src/main/settings/pdf-service.ts:516`（修复前） | `content.items.map((i) => ('str' in i ? i.str : '')).join('').trim()` | `pdf_open` / `pdf_pages` 的页文本、`pdf_scan` 的页内检索与摘要、以及**文本式表格候选** `extractPdfTableCandidatesFromText` |
| `src/main/uploads/attachment-media.ts:289`（修复前） | 同上 | 附件 PDF 交给模型的抽取文本 |

pdfjs 用 `hasEOL` 标记行尾、把**空格单独作为一个 item**发出（本页实测：125 个 run 里 111 个是纯空白 run）。
`join('')` 于是把整页压成一行，且**行尾词与下一行首词直接粘住**。

- 全树 grep `hasEOL`：**0 命中**（修复前）——行结构信息一直在，只是没有任何地方读它。
- 后果不止观感：段落单元、句边界、任何「按段落」的记录都依赖行尾；文本式表格候选按 `minGapSpaces = 2` 在**行内**聚列，页被压成一行时它永远看不到行。
- 第三处 `getTextContent` 消费者（`src/main/references/pdf-embedded-annotation-reader.ts:167`）**不是**同类：它保留带坐标的 items 用于引文定位，不做文本拼装 ⇒ 不需改。
- 渲染层 `PdfPreview.tsx:362` 也读 items，但只把每个 run 摆成可选文本层的 span（绝对坐标定位、按约定跳过纯空白 run），**不做整页拼装** ⇒ 刻意不动（换掉它会改选择行为，与本缺陷无关）。

## 二 修复形状（单一来源 + 只重插断点）

新增 `src/shared/pdf-page-text.ts`（无 `node:crypto` / 无 Electron 依赖，主进程与渲染层都可用）：

- `pdfTextRunsFromItems(items)`：**唯一**知道 pdfjs item 形状的地方（两处调用点不再各写一份 `'str' in item` 转换）；无 `str` 的标记内容跳过，transform 缺失/畸形记 0 而不是猜坐标，`hasEOL` 缺省即「未知」。
- `assemblePdfPageText(runs)`：只**重插断点**，不改写 run 文本。
  - 行尾信号：`hasEOL`；缺它时按基线位移 > 半行高回退。
  - 行内间距**逐字保留**（对齐列/两端对齐的多空格是文本式聚列的输入）；只丢**行尾**空白，因为断点取代了它——这也保证行间接合处不会出现双空格。
  - 同一基线的续 run 直接相接（pdfjs 换字体时会劈词，插空格会毁掉词）。
  - 段落间距 = 该页**自己最紧行距** × 1.5（不假设），页内同一段落的行并成一行、段落之间空行。
  - CJK 两行之间**不插空格**（中文断行不是词边界）。
- `pdfPageTextParagraphs(pageText)`：记录层（归一空白 + 去空），供「按段落建记录」的消费者用（本轮尚无消费者，见第五节）。

修复后 `pdf-service.ts` 的页文本 = `assemblePdfPageText(pdfTextRunsFromItems(content.items)).trim()`，`attachment-media.ts` 同形；两处的**定位用** items（表格/图形提取）仍走原有 `placed` 列表，一个字段未动。

## 三 真数据读数（真 PDF + 应用自己的解析函数）

夹具由系统自带 PDF 过滤器生成（`/usr/sbin/cupsfilter -m application/pdf`），解析走 **`PdfService` 未注入解析器的默认路径** ⇒ 跑的就是应用自己那条 `parsePdf`，再经 `pages()` 从**持久化**读回（工作根为临时隔离目录）。

### 3.1 英文 + 对齐列页（1 页 / 125 run / 10 个行尾标记）

| 读数 | 旧 (`join('')`) | 新（本模块） |
| --- | --- | --- |
| 页文本 | `AbstractWe report a reproducible pipeline … of SARS-CoV-2with an explicit solvent model. … within 0.35 nm ofthe reference crystal pose.ResultsSite Value Uncertaintycontrol 12.4 0.3treated …` | `Abstract\n\nWe report … of SARS-CoV-2 with an explicit solvent model. … within 0.35 nm of the reference crystal pose.\n\nResults\n\nSite Value Uncertainty control 12.4 0.3 treated 9.8 0.2 reference 15.1 0.4\n\nThe table above summarises the three measurements.` |
| 段落数 | —（无断点可言） | **5**（Abstract / 正文 / Results / 表体 / 收尾句） |
| 粘词 | `SARS-CoV-2with`、`ofthe` | 无 |
| 长度 | 402 | 416 |
| 文本式表格候选 | **0** | **0** |

**如实说明这张表**：本夹具的列间距**不是**空白 run（实测 `runsWith2PlusSpaces = 0`），所以「保留行内空白」这条改动**在这一页上没有改变**文本式聚列的结果——两个 0 都不是本模块造成的。表格的主路径是**带坐标的** `extractPdfTableCandidates`（本页定位 items 不受影响）；文本式候选只在解析器给不出坐标时才用得上。所以：保留行内空白是**契约正确性**（不替来源改写文本），不是本轮拿到的收益，别把它写成收益。
`service text equals shared assembly: true` —— 服务产出的页文本与共享模块逐字相同（接线到位，服务没有另算一份）。

### 3.2 中文页（1 页 / 34 run / 4 个行尾标记）

| 读数 | 旧 | 新 |
| --- | --- | --- |
| 段落数 | —（`摘要我们报告了…` 标题被粘进正文） | **4**（摘要 / 正文 / 方法 / 正文） |
| 页文本 | `摘要我们报告了⼀条…结合模式。该流程将⼝袋定构象附近。⽅法受体制备使⽤…` | `摘要\n\n我们报告了…结合模式。该流程将⼝袋定构象附近。\n\n⽅法\n\n受体制备使⽤…` |
| 汉字之间被插入空格 | 否 | **否**（CJK 两行接合按约定不插空格；`SARS-CoV-2` 两侧的拉丁空格保留） |

**同页发现（与本改动无关、先记不算立案）**：该 PDF 的字体 ToUnicode 把若干汉字映射成**康熙部首**码位（`⼀ U+2F00`、`⽤ U+2F44`、`⽅ U+2F45`、`⼝ U+2F51`、`⽔ U+2F54`、`⼦ U+2F59`、`⼒ U+2F92`、`⾏ U+2F98` 一类），新旧两种拼装都一样。这是夹具 PDF 字体的问题（真文献多半正常映射），但中文检索若命中率异常，这里是第一个该看的地方——**先量再说**，本轮不据此改代码。

## 四 用例与变异读数（证明断言不是空跑）

| 用例 | 位置 | 变异（把源码回退成 `join('')`） |
| --- | --- | --- |
| 页文本保留真实行结构 | `src/main/settings/pdf-service.page-text.test.ts`（新文件，3 条；**不经注入解析器**，用桩 pdfjs 走真 `parsePdf`，再经 `pages()` 从盘上读回） | `expected 'AbstractWe report a pipeline.It runs …' to be 'Abstract\n\nWe report a pipeline. It …'` ⇒ 2 failed / 1 passed |
| 无 `hasEOL` 时按基线回退 | 同上 | 同上（红） |
| 无文本层的页仍是空页 | 同上 | 绿（不受影响，正是该有的形状） |
| 附件抽取保留行 | `src/main/uploads/attachment-media.test.ts`（+1 条） | `expected '--- Page 1 ---\nMethodsWe ran it.Rece…' to be '--- Page 1 ---\nMethods\n\nWe ran it.…'` ⇒ 1 failed |
| 模块级契约（13 条，含**真实页 run 内嵌夹具**） | `src/shared/pdf-page-text.test.ts` | 真实夹具的段落读数：19 行 / 行距 12 / 段落间隔 24 ⇒ 6 段 |

`vitest` 只转译不做类型检查，所以两个新测试文件另行过 `tsc`（见计划档 §六十 门禁表）。

## 五 刻意没做的（不许读成「已做」）

1. **无 Electron 真窗口读数**：本轮开工内存闸门读数见计划档 §六十（空闲物理页 ≈ 69 MB / swap 已用 5.4 GB of 6.1 GB），本机历史有堆把机器打崩的前例 ⇒ 未做 `build:e2e` + 起窗。上面 3.1/3.2 是**应用自己的解析函数 + 真 PDF** 的读数（不是单测夹具），但**不是**窗口里的读数，如实标注。
2. **旋转页无真夹具**：模块的几何规则读的是它收到的 run 的坐标；无法用一个真旋转页取数，故未对 `/Rotate` 页面做真读数（该分支不是新加的分支——拼装对所有页走同一条路，没有旋转专用分支）。
3. **不猜字母**：页边劈词（`def inition`、`res olution`）按原样保留——去连字符是另一件事，需要语言字典与判定，本模块不做，已写成用例钉住。
4. **`pdfPageTextParagraphs` 目前无生产消费者**：本轮的接线只到「页文本」。按段落建记录（段落单元/指纹/译文记录）属批 A 的下一片，索引与用途写在计划档 §六十；本模块不是死代码（两个生产站点已在用），段落层是它的公开一半。
