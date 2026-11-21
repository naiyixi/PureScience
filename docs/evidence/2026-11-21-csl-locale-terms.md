# CSL 标签终于从样式自己的 locale 取词：`vol. 21, no. 3, pp. 145-158` 与「卷 3」「2 版」

2026-11-21。上一份证据档（`2026-11-21-csl-real-styles-render.md` §五·1）把「`vol.`/`no.`/`pp.` 这类标签
仍然不出现」记为**已立案、未修**，理由是「本渲染器不带任何 locale 词条……留给『按样式的 default-locale 取词条』
那一版」。这一篇就是那一版：标签与术语节点现在从**样式自己声明的 locale** 取词，取不到就具名，不印英文。

## 一 修法（三处，都在 `src/shared/citation/`）

| # | 原来的形状 | 现在的形状 |
| --- | --- | --- |
| 1 | 渲染器不带任何 locale 词条 ⇒ `<label>` 恒为空串、`<text term>` 恒为空串，两者只在导入报告里具名 | 新增 `csl-locale-terms.ts`：内置 en-US / zh-CN 的**标签词条**（volume / issue / page / edition / chapter / section / paragraph / and / in / et-al / accessed / page-range-delimiter），每个词条带 single / multiple 两种数；渲染器按 `CslProgram.locale`（即样式的 `default-locale`）取表 |
| 2 | `<label variable="page">` 无论内容都输出空 | 按变量值判数：页区间 `145-158` ⇒ 复数（`pp.`），单个卷号 `21` ⇒ 单数（`vol.`）；`plural="always"/"never"` 显式覆盖；变量为空时**不印标签**（`pp.` 后面没有页码就是噪声） |
| 3 | 样式自带的 `<locale><terms>` 完全不读（导入报告里把 `terms`/`term` 当「不支持的构造」列出） | 导入时按 `xml:lang` 与 `default-locale` 的**语言部分**匹配（`zh` 命中 `zh-CN`，无 `xml:lang` 的块对所有语言生效），把覆盖值折进词表；`<locale>/<terms>/<term>/<single>/<multiple>` 不再算「跳过的构造」 |
| 4 | `<text term="no-such-term">` 与 `<label variable="locator">` 以前笼统记成 `text:term` / `label` | 现在**逐条具名**：`term:<name>` / `label:<variable>`；`<names>` 里的 `<label>`（`eds.` 这类角色词）另记 `label:names`——它确实没实现 |

顺带补齐一处同源缺口：`renderVariables()` 从来不提供 `edition`，于是 `<number variable="edition"/>` 与
`<label variable="edition">` 在任何样式里都拿不到值（实测 GB/T 书型记录修复前少印了「2 版」）。

## 二 词条的来源（不编词，逐份核字节）

两份公开 locale 文件，只取本渲染器支持的构造能到达的词条（整份约 30 KB/语言，不整份入仓）：

| 文件 | commit | sha256 |
| --- | --- | --- |
| `locales-en-US.xml` | `citation-style-language/locales` 仓库 master（2026-11-21 取） | `ac864c7c21166b4390d82c31792cdc509400727fa0060b43d8aa17e07f9cb079` |
| `locales-zh-CN.xml` | 同上 | `95cebc667f2da8fb5b9864e49941e3f867d59f79feba929bc58e8ed6bfd4d582` |

逐个词条按文件里的原文抄写（`vol.`/`vols.`、`no.`/`nos.`、`p.`/`pp.`、`ed.`/`eds.`、`卷`、`期`、`页`、`版本`/`版`、
`等`、`和`、`收入`、`见于`、en `–` / zh `～`）。**中文表里没有的词条不会回落到英文**——那会把一条英文标签
印进中文条目里，比不印更难发现。

## 三 读数（真样式、产品自己的导入/渲染路径）

样式：公开样式仓库 `citation-style-language/styles` commit `15ea5749688396c9352b01b7641bcc5fe1b77da5`，
加上中文 GB/T 7714-2015（numeric）那一份。逐份 sha256（前 16 位即可与上一份证据档对照）：

| 文件 | sha256（前 16） | 修复前 | 修复后 |
| --- | --- | --- | --- |
| `ieee.csl` | `b4c7619fc16c45a3` | `… Nature Methods, 21, 3, 145-158, 2024, doi: …` | `… Nature Methods, vol. 21, no. 3, pp. 145-158, 2024, doi: …` |
| `modern-language-association.csl` | `e1432698ef28938d` | `… Nature Methods, 21, 3, 2024, 145-158, …` | `… Nature Methods, vol. 21, no. 3, 2024, pp. 145-158, …` |
| `harvard-cite-them-right.csl` | `0ca3d2c7c881cd98` | `… Nature Methods, 21(3), 145-158. …` | `… Nature Methods, 21(3), pp. 145-158. …` |
| `gbt.csl`（中文，书型记录） | `d9cd04f94bc21a99` | `李航, 王伟. 机器学习方法: 3. 清华大学出版社, 2012: 45-67.` | `李航, 王伟. 机器学习方法: 卷 3. 2 版. 清华大学出版社, 2012: 45-67.` |

- 「修复前」两列是**现取**的：在 `HEAD`（`ce5e8baa`）的隔离工作树里跑同一份临时探针，不是照抄旧文档。
- 其余五份样式（AMA / APA / Chicago / elsevier-vancouver / nature）逐字不变——它们本来就不给这些字段加标签。
- 九份文档在真 SQLite（应用自己的 schema bootstrap）里经 `CitationStyleService` 导入、持久化、渲染、重导入替换、
  删除：**9 imported / 9 rows / replacedExisting=true / 删除后 8 行**，九份 `fidelity=verified`、无 skip。

## 四 导入报告的变化（更细，不是更松）

- 少了三类噪声：`terms`、`term`、`single`、`multiple` 不再算「不支持的构造」（现在真的被读取）。
- 多了逐条具名：APA 报出 `term:no date`、`term:retrieved`、`term:at` 等它用到而词表没有的词；IEEE 报 `term:online`、
  `term:video`；任何样式里的 `<label variable="locator">` 报 `label:locator`。
- 这意味着**保真判据没有被放宽**：`fidelity` 仍是「规范探针记录能否被这份样式复现」，与标签是否印出无关。

## 五 边界（这一版没做的）

- 只带 12 个词条，不是整份 locale：`term:by`、`term:circa`、`term:preprint`、`term:no date` 一类仍具名不印。
- **locale 的日期形式**（`<locale><date form="text">`）仍未读取，`date:default-year` / `date:no-parts` 照旧具名；
  GB/T 的「年-月-日」中文写法因此仍未按 locale 走。
- `<names>` 里的角色标签（`eds.` / `trans.`）未实现，具名 `label:names`。
- `<sort>`、`locator` 变量、`macro-depth` 截断仍是既有具名缺口，不在本轮。
- 本轮的词表覆盖是**声明式**的（`csl-locale-terms.ts` 的一张表 + 样式覆盖），没有跑 citeproc-js 之类的第二台引擎逐条对拍；
  上一轮的分隔符/分组语义那一批才是对拍过的。若要给「词条取值与官方 locale 一致」上更硬的证据，做法是拿同一批样式
  在第二台引擎上渲染同一份记录逐字比较——记在这里，未做。
