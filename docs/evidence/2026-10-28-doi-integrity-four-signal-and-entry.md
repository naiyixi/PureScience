# B1 引文完整性：判定链路实测缺陷、修法与入口接线（2026-10-28）

## 0 一句话

`checkIntegrity` 三端通了但**窗口里没人调**（自带守卫 `renderer-contract-entry-coverage` 在全量套件里当场红了），
且判定器只读 `relation['is-retracted-by']` —— 真机抽样 **0/12** 命中，等于撤稿永远判不出来。
本次把两件事一起收口：四路信号判定（每条带证据类型）＋ 文献库真入口（按钮／摘要行／撤稿角标）。

## 1 缺陷一：判定器选错了判据（真机读数，可复现）

探测方式：Crossref 公共 API，`GET https://api.crossref.org/works/{doi}`，2026-10-28 22:52–22:56 CST，本机直连
（`crossref_http=200 time=0.94s`）。

### 1.1 五个已知条目

| DOI                             | 事实                   | `relation` | `update-to` | 标题前缀     |
| ------------------------------- | ---------------------- | ---------- | ----------- | ------------ |
| `10.1016/S0140-6736(97)11096-0` | Wakefield 1998，已撤稿 | 空         | 空          | `RETRACTED:` |
| `10.1126/science.1255484`       | LaCour 2014，已撤稿    | 空         | 空          | 无           |
| `10.1038/nature14539`           | 对照（干净）           | 空         | 空          | 无           |
| `10.1056/NEJMoa064135`          | 对照（干净）           | 空         | 空          | 无           |
| `10.1038/506150a`               | 对照（干净）           | 空         | 空          | 无           |

### 1.2 十二个工作区抽样（原作侧）

来源：`GET /works?filter=update-type:retraction&rows=20` 取撤稿通知 → 取其 `update-to` 指向的原作 DOI。

| 信号                             | 命中                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `relation['is-retracted-by']`    | **0 / 12**                                                                                             |
| 自身 `update-to` 含 `retraction` | 6 / 12                                                                                                 |
| 标题带撤稿标注                   | 9 / 12                                                                                                 |
| 三信号皆无                       | 3 / 12（`10.1538/expanim.54.1`、`10.1088/1742-6596/1873/1/012030`、`10.1088/1757-899x/1145/1/012031`） |

### 1.3 反向检索有货

`GET /works?filter=updates:<doi>`

| DOI                             | 命中通知                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `10.1016/S0140-6736(97)11096-0` | `10.1016/s0140-6736(04)15715-2`（Retraction of an interpretation）、`10.1016/s0140-6736(10)60175-4`（Retraction—Ileal-lymphoid-nodular hyperplasia） |
| `10.1538/expanim.54.1`          | `10.1538/expanim.54.1.r1`                                                                                                                            |
| `10.1126/science.1255484`       | 无（该条只能靠标题标注或其他来源）                                                                                                                   |

**结论**：只读 `relation` 的检查器会把这些撤稿论文全部报成 `clean` —— 这正是计划档里「代码中 `retraction` 命中 0」的根因，不是没测到，是判据选错。

## 2 修法：四路信号，每条判定带证据类型

`DoiIntegrityCheck` 新增 `evidence: 'relation' | 'update-to' | 'reverse-update' | 'title-label' | 'none'`，
按下列顺序取第一条命中的信号，并落库 `Reference.integrityEvidence`：

1. `relation['is-retracted-by' | 'is-corrected-by' | 'is-expression-of-concern-for']`（存在时最权威，
   真机上极少见）；
2. 记录自身 `update-to` 的 `type ∈ {retraction, withdrawal, expression-of-concern}`；
3. 反向检索 `filter=updates:<doi>`，只采纳 `update-to` 指回本 DOI 的通知；
4. 标题前缀标注（`RETRACTED` / `WITHDRAWN` / `Expression of concern`）—— 这是 Crossref 记录上出版方
   自己的标注，不是我方推断；**用锚定前缀**，所以「How retracted papers keep being cited」这类中段命中不误报。

失败口径不变且更严：主记录失败 ⇒ `unavailable`；**反向检索失败也 ⇒ `unavailable`**（`unavailable` 绝不当 `clean`）。
成本：干净记录每条 2 次请求（主 + 反向），有信号记录 1 次；串行、无 API key。

## 3 缺陷二：能力在窗口里没人调

全量套件（本地，2.19.0 树）实测：
`test Files 1 failed | 1414 passed`，唯一红是

```
FAIL src/shared/renderer-contract-entry-coverage.test.ts
  exposes every desktop surface the contract catalog declares
  expected [ 'references.checkIntegrity (references:check-integrity)' ] to deeply equal []
```

即：契约目录登记了通道、preload 也实现了，但 `src/renderer` 下零调用方。仓里自带的守卫抓到了它 ——
所以「六组接线」在原计划里并不完整。

## 4 入口接线（本次补的第七组）

`ReferencesLibraryDialog`：

- 打开文献库时读 `readIntegritySummary`（零网络），工具栏显示
  `已核验 {checked}/{total} 条 · 未确定判定 {gaps} 条 · 已判定撤稿 {retracted} 条`；读不到时显示
  「完整性判定不可读（这不等于"都没问题"）」而不是空白；
- 独立按钮「检查撤稿/更正」→ `checkIntegrity`，完成后重读摘要并显示
  `本轮检查 {checked} 条：撤稿 {retracted} 条，无法连上登记库 {unavailable} 条`；
  按钮旁常显成本提示（逐条串行、无 API key）；
- 列表里撤稿记录打红色角标「已撤稿」，角标 `title` 说明**依据哪一路信号**判的；
- 导出闸门（`ReferencesScreeningPanel`）不变：`retracted` 命中即拒绝导出并点名，三类 `gaps` 照常导出但逐条写明。

## 5 验证读数

| 检查                                                                         | 结果                                                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/main/references/doi-integrity.test.ts`                                  | 16 例（原 9 + 新增 7：反向检索、标题标注、表达关注、中段不误报、证据类型、去重、反向失败≠clean） |
| `src/main/references/doi-integrity-storage.test.ts`、`prisma-client.test.ts` | 通过（含运行时 DDL 标量列覆盖）                                                                  |
| `src/shared/renderer-contract-entry-coverage.test.ts`                        | 由红转绿（`checkIntegrity` 有了真入口）                                                          |
| `ReferencesLibraryDialog.render.test.tsx`                                    | 19 例（新增 3：开启即读摘要且不触发检查、按钮触发一次并写回摘要、撤稿行才带角标）                |
| `tsc -p tsconfig.node.json` / `tsc -p tsconfig.web.json`                     | 0 错（仅既有 TS6307 噪声）                                                                       |
| i18n                                                                         | 9 语文档齐：`references.integrity.*` 7 键 + `references.integrity.evidence.*` 5 键               |

## 6 尚未做（明确立案，不进「已完成」）

- **装机实测**：`/Applications/PureScience.app` 仍是上一版；本轮提交后需重装并在真实项目里跑一次
  「建项目 → 加 3 条 DOI（含 Wakefield）→ 点检查 → 看角标 → 导出被拒」的完整链路，读数落本篇追加节。
