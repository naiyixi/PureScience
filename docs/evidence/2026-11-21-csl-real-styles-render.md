# 真实 CSL 样式的渲染读数（2026-11-21）——三种「把字段印两遍」的缺陷与一处过期自陈

一句话：用 8 份真实的公开发布样式走产品自己的导入与渲染路径，**修复前有四种样式把同一个字段印了两遍**
（IEEE 把一卷一期印成 `21 21, 21, 3 3`，Chicago 把年份印两次），而导入时的保真探针对它们一律报
`fidelity=verified`；README 里那句「八种真实样式五种通过、三种标草稿」是 2026-09-20 的旧读数，
当天 16:34 的替换（substitute）修复之后已经不成立，现读数**八种全部 verified**。

## 一 方法与可复现

- 样式来源：CSL 公开样式仓库 `citation-style-language/styles`，commit `15ea5749688396c9352b01b7641bcc5fe1b77da5`。
  取的是 2026-09-20 那次探针记录里的同一批八个样式（其中 `mla.csl` 已改名为
  `modern-language-association.csl`，`vancouver.csl` 现为 `elsevier-vancouver.csl`，样式自报 id 与旧记录一致）。
- 每份字节的 sha256（我方对「发什么就核什么」的口径，可逐份复核）：

| 文件 | sha256（前 16） | 样式 id |
| --- | --- | --- |
| `american-medical-association.csl` | `d70f843d93c2b1e8` | `american-medical-association` |
| `apa.csl` | `3917def5fc951b10` | `apa` |
| `chicago-author-date.csl` | `002fade78d7e4fe9` | `chicago-author-date` |
| `elsevier-vancouver.csl` | `005e915c3419eb2b` | `elsevier-vancouver` |
| `harvard-cite-them-right.csl` | `0ca3d2c7c881cd98` | `harvard-cite-them-right` |
| `ieee.csl` | `b4c7619fc16c45a3` | `ieee` |
| `modern-language-association.csl` | `e1432698ef28938d` | `modern-language-association` |
| `nature.csl` | `15b1272a3c360168` | `nature` |

- 两条读数通道，都调用产品自己的代码（与窗口用的是同一对函数 `importCslStyle` + `formatCitation`）：
  1. **真库探针**：`PURESCIENCE_CSL_PROBE_DIR=<那八份文件> npx vitest run src/main/references/citation-style-probe.test.ts`
     —— 用应用自己的 schema bootstrap 建真 SQLite，经 `CitationStyleService` 导入、持久化、重导入替换、删除。
  2. **逐份渲染对照**：同一份 item（Zhang/Chen/Smith/Huang，Nature Methods 2024;21(3):145-158）分别走九种内置样式与八种导入样式。

- 修复前（`csl.ts` 未改）与修复后的探针都是一次跑完、无 skip。

## 二 缺陷与修法（三个，都是「字段进了错的位置」）

| # | 形状 | 读源 | 修法 |
| --- | --- | --- | --- |
| 1 | `<text term="volume"/>` 这类**标签节点**被当成同名变量渲染 | `csl.ts` 的 `renderNode`：`node.variable ?? node.term` ⇒ 打印 `variables['volume']` | 只有带 `variable` 的 text 节点才取变量；`term` 节点输出空，并在导入报告里具名 `text:term` |
| 2 | 任何 `<date variable="X">` 都渲染 `item.year` | `renderDate` 不读 `node.variable`，恒用 `state.item.year` | 只认记录真有的两个日期：`issued`（记录的年份）与 `accessed`（`retrievedAt` 的年份）；其余日期变量输出空 |
| 3 | `<label>` 在「支持的构造」清单里，渲染恒为空串 | `SUPPORTED_ELEMENTS` 含 `label`，而 `renderNode` 的 `label` 分支 `return ''` | 从支持清单移除 ⇒ 导入报告具名 `label`（不再声称支持一个从不渲染的构造） |

## 三 修复前后的逐条渲染（同一份 item，逐字）

| 样式 | 修复前 | 修复后 |
| --- | --- | --- |
| IEEE | `… Nature Methods, 21 21, 21, 3 3, 145-158, 2024, doi: …` | `… Nature Methods, 21, 3, 145-158, 2024, doi: …` |
| Chicago (author-date) | `… M. Huang(2024) 2024“Deep learning …”Nature Methods 21(3): …` | `… M. Huang2024“Deep learning …”Nature Methods 21(3): …` |
| MLA | `… “Deep learning …”. 2024. Nature Methods, 21, 3, 2024, 145-158, …` | `… “Deep learning …”. Nature Methods, 21, 3, 2024, 145-158, …` |
| APA | `… 145-158.https://doi.org/…(as, 2024)` | `… 145-158.https://doi.org/…(as)` |
| AMA / elsevier-vancouver / harvard / nature | 不变 | 不变 |

四种有重复的样式修复后不再重复；把「探针」升级后再跑，八种仍是 `verified`（新检查见下一节）。

## 四 探针升级：存在 ≠ 保真

旧探针只查「标题、作者姓、年份、页码**是否出现**」。IEEE 把一卷一期印成 `12 12, 12, 3 3` 时，
它要查的每一个值都在（而且都在两遍），于是被判 `verified` —— 这正是这条缺陷能长期存活的原因。

修法两条（都在 `probeCslStyleFidelity`）：

- 检索时间戳改到**另一个年份**（`2019-05-04`）：否则「访问日期」的年份与出版年相同，一个把出版年印两遍的样式
  看起来像只印了一次日期。
- 新增**重复检查**：探针 item 的卷（12）、期（3）、页（45-67）、年（2026）在同一份渲染里出现多于一次 ⇒
  `duplicate:volume` 一类具名注记，保真度降为 `partial`。

用例：`src/shared/citation/csl.test.ts` 新增两条（term 节点不打印数值 + 标签具名；日期变量各印各的），
另加一条钉住重复检查（同一字段印两遍 ⇒ `partial` + `duplicate:volume`）。

## 五 仍然存在的（具名，未修）

这四条是**不同机制**，本轮没有动，逐条留读数与位置：

1. **`vol.` / `no.` / `pp.` 这类标签仍然不出现**（IEEE 现在是 `21, 3, 145-158` 而不是 `vol. 21, no. 3, pp. 145-158`）。
   原因是本渲染器不带**任何 locale 词条**（`<locale><terms>` 在导入报告里早已具名 `terms`/`term`，本轮又把
   `text:term` 与 `label` 补进同一份清单）。补它等于自带一份语言词表——中文样式要的是「第 21 卷」，不是 `vol.`，
   所以这不是加一句英文就能正确的事，留给「按样式的 default-locale 取词条」那一版。
2. **字段之间的分隔符丢失**：AMA 印成 `Nature Methods2024;21(3)`（期刊与年份之间没有 `. `），
   APA 印成 `145-158.https://doi.org/…`（DOI 前没有空格）。这不是本轮改动的后果（修复前逐字相同），
   机制在**宏展开后的分组**：真实样式把「期刊 + 年」放在带 `delimiter=". "` 的组里，而展开后那层分隔符没有生效。
   没有定因之前不猜，单独立案。
3. **APA 残留一个 `(as)` 片段**：它来自样式里「原始出处」那一段（`<text value="as"/>` + `original-date` +
   `original-publisher`）。本轮把 `original-date` 借来的出版年去掉了，于是从 `(as, 2024)` 变成 `(as)`——
   年份不再是错的，但这一段本不该对期刊论文出现，说明**分支选择**有误（`<choose>` 把不该走的分支走成了）。
   与第 2 条同一族（条件/分组），一并立案。
4. **作者姓名形态**：导入样式印 `W. Zhang`，内置样式印 `Zhang, W.`（`name-as-sort-order` 有读取，但
   `initialize-with` 与逗号序的组合与真实样式不一致）。属观感与规范细节，未取到「哪种更对」的判据前不动。

## 六 边界

- 探针是**真 SQLite + 真样式的原始字节 + 产品自己的 service/format 路径**，不是窗口截图。
  窗口侧已有认证 spec `e2e/certification/references-citation-styles.spec.ts`（导入→按样式选择→并排比较→导出，
  断言读屏文案与导出回执），但它用的是**自写的样式文档**（夹具不带第三方文件），不覆盖真实第三方样式的排版细节。
  因此本文的结论只到「产品自己的导入与渲染函数对真实样式给出什么字符串」这一层。
- 本轮**没有**验证「在窗口里看到的引用条目与这里逐字相同」；窗口读数是另一条通道，未取。
- 八个样式的主样式文件各自还带 `dependent` 兄弟样式，本轮只取这八份主文件，不声称覆盖 1 万个样式。
