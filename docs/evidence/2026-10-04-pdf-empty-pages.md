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

## 真机读数（已取，2026-10-04）

**夹具**：本机造的真「扫描件」——把一张 PNG 用 `sips -s format pdf` 转成 PDF，字节层面
`/Font: False`、`/Text: False`（无文字层）。**断言打在应用自己的测量上，不打在 mock 上**：

```
[pdf-scan] fixture /tmp/pdfscan/scan.pdf (642477 bytes)
[pdf-scan] {"ok":true,"pageCount":1,"textPageCount":0,"emptyPageCount":1}
1 passed (10.4s)          e2e/certification/pdf-scanned-pages.spec.ts
```

**顺带纠了我自己一个错**：第一版断言写死 `pageCount === 2`（我按文件里 `/Type /Page` 的出现次数粗算的），
跑出来是 **1 页**——**读数是对的、我的猜测是错的**。改成真正的不变量：
`pageCount > 0 && textPageCount === 0 && emptyPageCount === pageCount`（「没有一页带文字层」），
而不是一个从字节里猜出来的页数。

**仍未取的只剩显示层那一步**：把这份扫描件送进 `PdfExplorePanel`/`PdfTablePanel` 的**真窗口**读数
（需要走参考文献库的 PDF 选择器把文件纳入项目）。显示层行为由两个面板的渲染测试覆盖（19 passed），
事实层由本条真机读数覆盖。

