# 引文样式名跟着界面语言走 + P0 车道那两条红（2026-10-17）

> 单元：认证车道（P0）连着两笔提交红在同一对 spec 上的归因与本批修复。两件事分开说清：
> ① 车道红**不是偶发** —— 两条 spec 点的是一个**产品已经改名的按钮**（v2.6.0 A2 的导出格式那片
> 把「按所选样式导出」改成「导出为 <格式>」），spec 没跟着改；
> ② 顺着失败快照又发现一处**真缺陷** —— 九个内置引文样式在**英文界面里显示中文名**。

## 一 车道红的证据（取自 CI 作业日志与失败快照）

- 提交 `e32a922b` 的 Nightly（run `39010815609`）里 `build / Build macos-arm64` 红在 P0 步骤：
  `95 passed / 2 failed / 12 skipped`，失败两条：
  - `e2e/certification/references-citation-styles.spec.ts:62` —— `locator.click` 等
    `getByRole('button', { name: 'Export in the selected style' })` 超时 30 s，**retry #1 同样红**
    ⇒ 不是抖动；
  - `e2e/certification/references-screening.spec.ts:49` —— 同一个按钮、同一种超时。
- 上一笔 `71460799` 的 Nightly（run `39006395576`）是同一对 spec、同一行 ⇒ 至少两笔连续红。
- 失败快照（artifact `p0-test-results-macos-arm64` 的 `error-context.md`）把那一屏照下来了：
  - 那个位置上的按钮实际叫 **`Export as PureScience Acceptance Style`**；
  - `Citation style` 选择器里的九个 option **全是中文**：`GB/T 7714-2015（顺序编码）`、`APA 第 7 版`、
    `Vancouver（NLM）`、`IEEE 第 11 版`、`Nature`、`AMA 第 11 版`、`Harvard（Cite Them Right 第 12 版）`、
    `Chicago 第 18 版（作者-年份）`、`MLA 第 9 版`；
  - 而同一个对话框的并排比较面板印的是**英文** `style.label`（`APA 7th`、`GB/T 7714-2015 (numeric)`）。

两处成因同源但性质不同：按钮名变了是**产品改进**（文案点出真正会写出的格式），spec 落后；样式名中文
是**产品缺陷**（`CitationStyleDefinition` 本来就同时带 `label` 与 `labelZh`，渲染层却无条件印 `labelZh`）。

## 二 改动

| 面 | 改动 |
| --- | --- |
| `src/shared/citation/types.ts` | 新增 `citationStyleLabel(style, language)`：中文界面（`zh`/`zh-Hant`）取 `labelZh`，其余（含没有语言提供者的渲染）取 `label` |
| `ReferencesLibraryDialog.tsx` | 语言从 `useLanguage()` 取；样式名收敛成一份 `styleLabelById` 映射，**选择器 / 导出按钮 / 复制引用的 tooltip / 并排比较** 四处都读它（原来三处各读各的字段，一处漏就成了这次的缺陷） |
| `ReferencesScreeningPanel.tsx` | 纳排面板自己的样式选择器同样改走 `citationStyleLabel` |
| 两个认证 spec | 按钮定位改成产品真名（`Export as …`），并把「按钮名点出所选样式」变成断言；比较面板的两条断言收窄到列表容器（新 `data-testid="citation-style-comparison"`）—— 因为选择器现在也带同样的英文名，不收窄就会命中它 |
| `references-citation-styles.spec.ts` | 新增**样式选择器讲界面语言**的真机断言：英文窗口里 `APA 7th` / `GB/T 7714-2015 (numeric)` 各恰一条，`APA 第 7 版` 一条都没有 |
| `src/shared/citation/types.test.ts` | 新用例 4 条：中文两语取中文名、其余七语取英文名、没有语言时回英文、导入样式两名同值 |

## 三 读数

| 项 | 读数 |
| --- | --- |
| 修复前（CI 快照）英文窗口的九个样式名 | 全中文（见上） |
| 修复后（真机读数 `[ic38]`，英文窗口） | `GB/T 7714-2015 (numeric)`、`APA 7th`、`Vancouver (NLM)`、`IEEE 11th`、`Nature`、`AMA 11th`、`Harvard (Cite Them Right 12th)`、`Chicago 18th (author-date)`、`MLA 9th` |
| 本地真机跑这两条 spec（`npx playwright test`，`--workers=1`） | **2 passed (20.8 s)** —— 含新增的语言断言与 `Export as PureScience Acceptance Style` 那条导出 |
| 全量单测 | `1339 passed / 16 skipped`（1355 文件）、`17035 passed / 207 skipped`（17242 例）、exit 0；比上一轮基线 **+1 文件 / +4 例**（正是本批新增的那份用例） |
| 双 typecheck | node `0`、web `0`（`--composite false`） |
| eslint（改动文件，`--no-cache`） | 0 error、0 warning |

## 四 边界

- **产品行为没动**：导出按钮印「导出为 <格式>」是 v2.6.0 A2 那片定的语义（「一条导出路径、三种格式」），
  本批只是把 spec 的定位改到它身上，并把「按钮名跟着选择变」写成断言 —— 比原来那句固定文案的断言更强。
- 顺带把 `复制引用` 的 tooltip 从固定的英文 `label` 改成同一份映射 ⇒ 中文界面下它也中文了（原来固定英文）。
- **没做**：`Import CSL style` 之后那些导入样式的名字来自文档自身（`label`/`labelZh` 同值），不涉语言选择。
- 车道层面：这两条 spec 只在 `macos-arm64` 的构建作业里执行，Windows 车道永远抓不到它们 —— 本批的
  真机读数取自本机（同一条 `playwright test` 入口、同一份 `build:e2e` 产物）。

## 五 复跑配方

```bash
npm run build:e2e                                   # 改了渲染层就必须重建，否则测的是旧包
npx playwright test e2e/certification/references-citation-styles.spec.ts \
                   e2e/certification/references-screening.spec.ts --workers=1
npx vitest run src/shared/citation src/renderer/src/components/references --maxWorkers=4
```
