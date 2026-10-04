# PDF：把「有多少页根本没有可取文本」说出来 —— 证据（2026-10-04）

## 先记本轮的三判结果（两个假阳性 + 一个真缺口）

| 候选 | 判定 | 依据 |
| --- | --- | --- |
| `validationFailed`（功能模型提供方事实） | **假缺口，划掉** | 它被当成**解析的输入**：`shared/function-models.ts:110-111` —— `if (provider.validationFailed) return { override: null, unusable: ['provider-unverified'] }` ⇒ 事实以**具名理由** `provider-unverified` 上屏（面板本就在印这一档）。布尔本身是内部输入，渲染层不读是对的 |
| `boundConversationsUnavailable`（专才删除卡载荷） | **假缺口，划掉** | 两处产出点**恒为 `true`**（`specialist-approval-presentation.ts:32`、`specialist-approval-gateway.ts:85`，注释写明「绑定会话一律解析为不可用，且不静默切到主 Agent」）⇒ 是**常量**而非逐实例事实，读不读没有差别 |
| **`emptyPageCount`（PDF 打开结果）** | **真缺口** | 见下 |

> 这是普查里抓到的**第三、第四个假阳性**（前两个：`deferredReason`、以及更早那次）。**教训固定下来**：
> 「渲染层零读」只说明**字段**没被读，**不说明事实没上屏**——先查这个字段有没有被折进一个
> 具名理由或另一个已上屏的字段（`grep` 该字段在 shared 里的消费者），再判缺口。

## 真缺口

`PdfOpenResult`（`shared/pdf.ts:86-95`）带 `textPageCount` 与 `emptyPageCount`，由
`pdf-service.ts:174-179` 算出（`emptyPageCount = pages.length - textPageCount`），经 `pdf:open` 同时发给
渲染层与 agent。而**两个消费它的面板都只取 `opened.doc.docId`**，把这两个数整个丢掉：

- `PdfExplorePanel.tsx:65`（大纲/图）
- `PdfTablePanel.tsx:65`（表格）

⇒ 一份**扫描版 PDF** 打开后：大纲空、图空、表格「未找到」，读者会以为工具坏了——
而**根本原因（整页没有文字层）app 早就量出来了**，只是没说。
同页的两个面板**都在报「跳过了什么」**（`scannedPages` / `skippedSmall` / `withoutCaption` /
`rejectedPages` / `rotatedPages`）——**唯独漏了这一条**。

## 改法

两个面板都把 `opened.emptyPageCount`（表格面板另带 `opened.doc.pageCount`）带进状态，并在结果区报出来：

- `data-testid="pdf-explore-empty-pages"`（在「大纲」标题下）
- `data-testid="pdf-table-empty-pages"`（**在「未找到」那句之前**——原因先于判决）

新增 1 键 × 9 语：`pdf.emptyPages`，带 `{empty}` 与 `{total}`；仅在 `emptyPageCount > 0` 时出现。

## 读数

```
PdfExplorePanel.render.test.tsx + PdfTablePanel.render.test.tsx   →  2 passed / 19 passed
```

新增 4 条断言（两个面板各两条）：
① `emptyPageCount: 9 / pageCount: 12` ⇒ 提示出现且**两个数字都在屏上**；
② `emptyPageCount: 0` ⇒ 提示**不出现**；
③（表格面板）提示出现时**「未找到」那句仍在**——是**补上原因**，不是替换判决。

其他：`translation-quality` **42 passed**；`typecheck:web` **0**；`eslint` 0 problems。

## 未取（具名）

**真窗口读数未取**：需要一份**真扫描版 PDF**（纯图像、无文字层）打开这两个面板看提示。
本轮验证停在真实组件的渲染测试（真面板 + 真语言提供者 + 真实 mock 载荷形状）。
