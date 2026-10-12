# A1 第二片 —— 翻译引擎接上真消费方：agent 的 `pdf_translate`（2026-10-13）

> 上一片（`429b3bec`）交付了段落级译文记录与可续跑引擎，但**全树没有任何生产消费方**（只有它自己的用例在调）——
> 按本仓「提交里不留死代码」的口径，那只是「已建、未接线」。本片把它接成一条真通路：**agent 的 PDF 工具面上多一个
> `pdf_translate`**，走的是应用已有的 PDF 能力面（`pdf_open`/`pdf_pages`/… 同一族），主进程解析 + 落盘 + 单写者。

## 一 链路（三层各自的前置都在）

| 层 | 落点 | 内容 |
| --- | --- | --- |
| 工具身份与结果契约 | `src/shared/pdf.ts` | `PDF_TRANSLATE_TOOL_NAME = 'pdf_translate'`、`PDF_TRANSLATE_TOOL_DESCRIPTION`、`PdfTranslateResult` / `PdfTranslatedPage` / `PdfTranslatedParagraph` / `PdfTranslationRestored`（`none` 分支带可选 `detail`，好让「读失败」与「还没翻」分开）；并把入口写进 `PDF_MCP_SYSTEM_PROMPT_APPEND`（agent 侧可发现性：工具名、用途、「会续跑」） |
| 工具面 | `src/main/settings/pdf-mcp-server.ts` | schema（`doc_id` + 可选 `target_language`）、`pdfTranslateToolDefinition`、`registerTool`、`runPdfMcpServer` 里经 `callPdfRpc('pdfTranslate', …)` 转发；注册数 6 → **7**（用例已同步改计数） |
| RPC 方法 | `src/main/notebook/local-rpc-server.ts` | `pdfTranslate` 加进 `PDF_RPC_METHODS`；`pdf.translate(...)` 进 pdf 选项接口；参数**校验不强制转换**（空 `targetLanguage` 具名拒绝，不回落成别人没要的语言） |
| 装配 | `src/main/ipc.ts`（pdf 适配块） | 读**整份**文档页文本 → `runDocumentTranslation(...)`，checkpoint 落在**与 PDF 库同一个数据根**（`resolveDataRoot()`，store 自己加 `translations/`）；`not-configured` / `empty-source` 两种拒绝在此**抛出**（工具面拿到具名错误，而不是一份「0 段已翻译」） |
| 编排 | `src/main/translation/document-translation.ts`（新） | 页文本 → 段落单元 → **跑在既有运行器 `run-translation.ts` 之上**（不并行第二套引擎）→ 再读 checkpoint 给出**逐段**列表 |
| 段落来源 | `src/shared/translation-units.ts` | `segmentPageIntoTranslationUnits` 现在从 `pdfPageTextParagraphs()` 取段落（见第二节第 2 条） |

**模型目标**：新增 `SettingsService.resolveAuxiliaryChatTarget()`（`src/main/settings/service.ts`）—— 把用户**正在跑**的
provider + model（`providers.resolveActiveModel()`，与运行时同一个解析器）解析成确切的 `/chat/completions` 端点 + key
（`providers.resolveProvider()` 给明文 key、`openAiChatCompletionsUrl()` 拼端点）。**没配 provider 就具名拒绝**
（`No provider and model are configured for translation…`），绝不回落成一个猜的端点。

**短语料（工具描述与 `emptyPages`）**：无文本层的页（扫描件）**不产出段落并被列名**；未翻译的段落一律带
`status` + 具名 `reason`（`not-attempted` / provider 原话 / `empty-translation`），**绝不渲染成空串**——这一条与
A6「具名缺态」同一条原则，先落在工具面。

## 二 实现中抓到并当批修掉的两条（都只有真接线才看得见）

### 1 页范围会让「续跑」恒失效，还会删掉别人的记录（第一版的设计缺陷）

**第一版**给工具加了 `start`/`end` 页范围，`documentPages` 只传被请求的那几页。自测用例「只重译被改动的那一段」
**当场红**（`expected ['p1#1','p1#2'] to deeply equal ['p1#2']`），顺着读数查到两个真问题：

1. checkpoint 的**文档身份哈希**取的是调用方传进来的页文本 ⇒ 按范围调用时哈希每次不同 ⇒
   `checkpointAppliesTo` 判 `source-content-changed` ⇒ **每次都整份重译**，「续跑」在真实用法里恒不成立；
2. 引擎的 plan 会把「当前源里已无对应段落的记录」当 `removed` **删掉** ⇒ 按范围调用会**删掉范围外那些页**的译文记录
   （那些段落并没有消失，只是这次没被请求）。

⇒ 终态：**运行的工作单元就是整份文档**。工具只收 `doc_id` + `target_language`，装配处读整份页文本；
`DocumentTranslationInput.documentPages` 的契约写明「必须传整份」，并在装配处注明理由。**代价**：不能只译几页
（成本控制缺一个入口）；**收益**：不会出现「续跑失效」与「静默删掉别人译好的记录」这两种**只有真实调用才暴露**的失真。

### 2 段落边界不能有两套（上一轮计划档点名要核的那一条）

§六十 五.2 要求「动手前先核 `translation-units.ts` 现在的切分输入来自哪里，避免两套切分并存」。核对结果：
`segmentPageIntoTranslationUnits` 自己按 `/\n\s*\n/` 切一次，而页文本层（§六十 新建的 `pdf-page-text.ts`）也用同一条空行
规则给出 `pdfPageTextParagraphs()` —— **同一个规则两份实现**（而 `pdfPageTextParagraphs` 当时除自己的用例**没有生产消费方**，
正是「新增导出无人调用」那一形状）。⇒ 落地：切分器改为**调用** `pdfPageTextParagraphs()`（再按单元自己的
`normalizeTranslationSource` 归一，哈希不变），并加一条**对值**用例把两侧钉在一起
（`segmentPageIntoTranslationUnits(1, assemblePdfPageText(runs)).map(u => u.text)` 必须等于 `pdfPageTextParagraphs(pageText)`）。
行为不变（既有用例全绿），边界只剩一份来源。

## 三 读数（全部实跑）

### 3.1 真数据读数（真 PDF + 应用自己的 `PdfService` + 真 pdfjs + 隔离根持久化 + **跨进程**读回）

夹具 `/tmp/pdfprobe/doc.pdf`（上一轮由 `cupsfilter` 生成的真 PDF，125 run / 10 个行尾标记），解析走 **`PdfService` 默认的 `parsePdf`（未注入、真 pdfjs）**；
根 = `/tmp/ps-translate-live`（隔离，非真实数据根）。探针件为**临时**文件（已删），读数落 `/tmp/ps-translate-live/readings.jsonl`。
模型端点是唯一被替换的接缝（真调会花用户额度）：替身按请求作答 `【译】<原文>`。

| 读数 | 值 |
| --- | --- |
| 真 PDF 解析 | `PROBE_PDF {"pageCount":1,"pages":1}` |
| 首次翻译 | `PROBE_WRITE {"paragraphCount":5,"translated":5,"reused":0,"failed":[],"stopped":null,"restored":{"state":"none","reason":"no-checkpoint"},"emptyPages":[],"requestsSent":5,"checkpointPath":"/tmp/ps-translate-live/translations/f99fc7ed….json"}` |
| 段落身份与原文（真跑产出，逐段） | `p1#1 'Abstract'` / `p1#2 'We report a reproducible pipeline for profiling the main…'` / `p1#3 'Results'` / `p1#4 'Site Value Uncertainty control 12.4 0.3 treated 9.8 0.2…'` / `p1#5 'The table above summarises the three measurements.'` ⇒ 与 §六十 那份页文本读数的「英文页 5 段」一致 |
| **跨进程**读回（第二个 vitest 进程，同根、真 pdfjs 再解析同一份 PDF） | `PROBE_DISK {"exists":true,"state":"ok","recordCount":5, sampleRecord {id:p1#1, sourceHash:fdf12ba1…, status:translated, text:'【译】Abstract'}}` |
| **跨进程**续跑 | `PROBE_READ {"reused":5,"translated":0,"failed":[],"restored":{"state":"partial","records":5},"firstTranslation":"【译】Abstract"}`；该进程的 fetch 替身**一被调用就抛**，一次都没抛 ⇒ 复用来自盘上的文件，不是进程内记忆 |
| checkpoint 文件（**手读盘**复核，不走 store） | `version=1`、`source={kind:'pdf', id:'probe-doc', contentHash:'4f13a6de…'}`、5 条记录各带 `sourceHash` |

### 3.2 离线可判的性质（单元套件，全部实跑）

| 性质 | 读数 |
| --- | --- |
| 段落身份稳定 + 报告 = 落盘真相 | 列表与**手读盘**的记录逐条同状态；`checkpointPath` 就是那个文件；`translated+reused+failed+skipped == paragraphCount` |
| 续跑不重发 | 第二次运行 **0 次请求**、`reused=2/translated=0`、`restored={partial, records}`，且译文仍是**第一次**那份（第二次替身会答 `译2:…`，出现即说明重发过） |
| 文档文本改了 | `restored={state:'none', reason:'source-content-changed'}`（具名「没有续跑及其原因」），两段都重发 |
| 换 docId 同内容 | `restored={state:'none', reason:'no-checkpoint'}`、`reused=0` ⇒ checkpoint 按文档身份隔离 |
| 中途停机 | `stopped='requested'`、`skipped=2`，未触及的两段各带 `status='failed'` + `reason='not-attempted'` |
| 失败段落 | `failed=[{id:'p1#1',reason:'http-error (500): model endpoint unavailable'}]`，下次重跑**重新发它** |
| 空文本层页 | `emptyPages=[2]`、该页不产出段落 |
| checkpoint 存在但读不出 | `restored={state:'none', reason:'unreadable', detail:'invalid-json'}` ⇒「读失败」与「还没翻」分开命名，并当轮重译修好 |
| **拒绝**：没有模型端点 | `{ok:false, reason:'not-configured'}`、**一次请求都没发**、盘上**没有**任何文件（不是一个空 checkpoint） |
| **拒绝**：整份没有段落 | `{ok:false, reason:'empty-source'}`、0 请求、盘上无文件 |
| 端点解析（`resolveAuxiliaryChatTarget`） | 未配置 ⇒ `undefined`；官方 DeepSeek 活跃 ⇒ `https://api.deepseek.com/v1/chat/completions` + 活跃模型 + 明文 key；自建网关根 ⇒ `https://gw.example.com/v1/chat/completions`（无 key 就不带 key） |
| 工具面 | 7 个工具注册齐（原 6 + `pdf_translate`）；只传 `doc_id` 时**不带任何调用方没给的选项**；`target_language` 原样透传 |
| **变异验证**（把「报告从 store 读回」改成空记录集） | `document-translation.test.ts` **10 条里 6 条红** ⇒ 新用例不是空跑 |

## 四 门禁读数（取最后一次改动之后）

| 环 | 读数 |
| --- | --- |
| 定向 `vitest`（translation + shared translation-units/pdf-page-text/pdf + settings pdf-mcp-server/service/service.providers/ipc/pdf-ipc + notebook local-rpc-server） | **13 文件 / 415 passed**，exit 0 |
| `tsc` node / web（`--composite false`） | **exit 0 / exit 0**（各自单独取退出码） |
| `eslint --no-cache`（本批 11 个文件） | **0 error**；`src/main/ipc.ts:2064` 的 1 条 prettier 警告是 **HEAD 上既有的漂移**（`git show HEAD:src/main/ipc.ts` 交 prettier 就不合格，且不在本批 hunk 里）⇒ 不并入本批 |
| `prettier --check`（本批 11 文件） | CLEAN（先跑出 2 文件未格式化，`--write` 后就地修掉） |
| 全量 `vitest` / `pre-push-checks` / 隔离门禁 | 见本轮汇报（门禁在**本提交的隔离工作树**上跑） |

## 五 刻意的边界（不许读成「已做」）

1. **没有 Electron/窗口读数**：内存闸门（开工空闲物理页 ≈ 65 MB）⇒ 未起 Electron。本片真机侧的证据是
   上表那条**离线真链路 + 跨进程**读数（真 pdfjs + 应用自己的服务 + 真落盘），**没有**走 MCP/IPC 传输层，也不冒充窗口读数。
2. **没有对真 provider 发过一次请求**（会花用户额度）⇒「真模型译出一段中文」**未取**，具名立案。配方：内存宽松时起隔离实例，
   `pdf_open` 一份真 PDF → `pdf_translate(doc_id, 'Simplified Chinese')` → 断言段落有译文、且第二次调用 `reused` 等于段落数。
3. **不能只译几页**（见第二节 1 的取舍）；A2 三模式阅读等界面面由会话侧推进。
4. 段落单元**不是**「原文段落」的完美重建：它由页文本层的段落规则给出（页内最紧行距 × 1.5 判段）；A4 术语一致性 /
   A5 参考文献保真由判据层交付（`b0ba0ed0` / `9078a2d3`）。
5. 探针踩到的一条**工具卫生**：把「写半场」与「读半场」放进**同一次** `vitest` 调用（两个 worker、同一个根）时，
   `TranslationCheckpointStore` 的临时文件名由 `now()`（毫秒）派生 ⇒ 同一毫秒内两个写入者撞名 `EEXIST`
   （该失败是**夹具**的，不是产品缺陷：生产里同一份文档只有一个写入者）。⇒ 半场探针必须**分开跑**。
