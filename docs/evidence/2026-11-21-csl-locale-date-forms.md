# CSL 日期不再只剩年份：`Accessed: Nov. 21, 2026` 与「[2026-11-21]」

2026-11-21。上一份证据档（`2026-11-21-csl-locale-terms.md` §五）把「locale 的日期形式仍未读取、
`date:default-year` / `date:no-parts` 照旧具名」记为**已立案、未修**。这一篇是那一版：`<date>` 节点
要么按样式自己声明的 parts 渲染，要么按**locale 自己的日期格式**渲染，两者都从公开 locale 文件逐字取。

## 一 修法（两处，都在 `src/shared/citation/`）

| # | 原来的形状 | 现在的形状 |
| --- | --- | --- |
| 1 | 不带 `<date-part>` 的 `<date>` 只印**年份**，并在导入报告里记 `date:no-parts` + `date:default-year`（把我们的替代说成样式的选择） | 按 `form="text"` / `form="numeric"` 取 locale 的日期格式（月份词、顺序、`年`/`月`/`日` 与 `/`、`-` 一并取）；`form` 缺省按 `text`；只有 locale 与样式都给不出该格式时才具名 |
| 2 | `<date-part name="month"/>` / `name="day"` 一律输出空串（注释写「由调用方报告」，实际没有任何调用方报告） | 按值渲染：月份默认印 **locale 的月份词**（`form="short"` 印缩写、`numeric` / `numeric-leading-zeros` 印数字），日印数字（样式要前导零就给前导零）；值里没有的部分**不印、也不编**。`date-parts="year"` 之类按 CSL 收窄 parts |

- 月份词来自两份公开 locale 文件（下表），`month-01`…`month-12` 的长/短两种形式逐字抄写；中文表里的
  `一月`/`1月` 与英文表里的 `January`/`Jan.` 各 24 条，缺一条也不会回落到另一种语言。
- 样式自己的 `<locale><date form="…">` 覆盖在**导入时**折进程序（与词条同一处折叠），所以程序存下来
  以后每次渲染都按该样式自己的格式走——不是渲染时再猜。

## 二 词条与格式的来源（不编词，逐份核字节）

| 文件 | sha256 |
| --- | --- |
| `locales-en-US.xml`（`citation-style-language/locales` master，2026-11-21 取） | `ac864c7c21166b4390d82c31792cdc509400727fa0060b43d8aa17e07f9cb079` |
| `locales-zh-CN.xml`（同上） | `95cebc667f2da8fb5b9864e49941e3f867d59f79feba929bc58e8ed6bfd4d582` |

两份的 sha256 与上一份证据档记录的**完全一致**（同一份字节，不是重新抓了一版）。取到的原文：

- en-US `text`：`month`（后缀空格）`day`（后缀 `, `）`year`；`numeric`：`month`/`day` 前导零 + `/`，再 `year`。
- zh-CN `text`：`year`+`年`、`month`（numeric）+`月`、`day`+`日`；`numeric`：`year`、`month`/`day` 前导零且前缀 `-`。

## 三 读数（真样式，产品自己的导入/渲染路径，修复前后现取）

九份样式：公开样式仓库 `citation-style-language/styles`（上一份证据档记录的 commit `15ea5749…`）里的
八份 + 中文 GB/T 7714-2015（numeric）那一份。**修复前**一列是在 `54cae4d1` 的隔离工作树里跑**同一份探针**
得到的，不是照抄旧文档。记录是一条 web 条目（有 `url`、`issued` 年、检索日 `2026-11-21`）。

| 文件 | sha256（前 16） | 修复前 | 修复后 |
| --- | --- | --- | --- |
| `ieee.csl` | `b4c7619fc16c45a3` | `… Nature Methods. Accessed: 2026. Available: …` | `… Nature Methods. Accessed: Nov. 21, 2026. Available: …` |
| `gbt7714.csl`（zh-CN） | `d9cd04f94bc21a99` | `… 2024: 145-158[2026]. …` | `… 2024: 145-158[2026-11-21]. …` |

- **其余七份逐字节不变**（AMA `d70f843d93c2b1e8` / APA `3917def5fc951b10` / Chicago `002fade78d7e4fe9` /
  elsevier-vancouver `005e915c3419eb2b` / harvard `0ca3d2c7c881cd98` / MLA `e1432698ef28938d` /
  nature `15b1272a3c360168`）：同一份探针在修复前后跑出的九段文本 `diff` 只有上面那两行。它们本来就不给
  这条 web 记录印检索日（走 DOI/URL 分支），而 `issued` 只有年份——按 CSL，年份-only 的日期在 text 格式下
  也只剩年份，所以那七份本来就该一模一样。
- 两份样式改的是**它们自己的** `text` 格式，读数正是这一点：IEEE 的 `<locale xml:lang="en">` 把月份改成缩写
  （`Nov.`）、日改成前导零；GB/T 7714 的 `<locale xml:lang="zh">` 给出「年-月-日」的中文写法与 numeric 的
  `2026-11-21`。两者都只有真的读样式自己的 locale 覆盖才印得出来。

## 四 门禁与边界

- 定向：`src/shared/citation` + `src/main/references` **35 文件 / 473 例通过（1 skipped）**；本条新增 7 例
  （en text / en numeric / zh text+numeric / 样式覆盖两种顺序 / `date-parts` 收窄与「年份-only 不编月份」 /
  不可渲染的 part form 具名；另加一条经过 `CitationStyleService` 的**存盘程序**往返读数）。
- `typecheck:node` + `typecheck:web` 均 **0**；`eslint --no-cache` 四个改动文件 **0 problem**。
- 边界（这一版没做的）：
  1. **记录的数据模型仍只有年份**：`issued` 没有月/日，所以 issued 上的「完整日期」只会印年份（这与 CSL
     对 year-only 日期的行为一致，不是我方截断）；要印出版月/日得先让记录侧存下来（`CitationItem` 与导入
     链路都要动），不在本轮。
  2. 枚举外的 `day` 形式（`ordinal` 等）具名 `date-part:day:ordinal`，仍印数字；月份 `form="verb"` 未做。
  3. `range-delimiter`、`<date>` 的区间（同一个节点渲染一整个日期区间）未实现。
  4. 月/日只从 `accessed` 的 ISO 串（`YYYY-MM-DD`）解析；其它日期变量（`original-date`、`event-date`）仍不提供。
  5. 仍未与第二台引擎逐条对拍（与上一轮同一处未做项）。
