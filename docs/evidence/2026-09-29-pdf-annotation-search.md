# 文档标注层 A5 实机验收存档（2026-09-29）

本档只记录**跑出来的东西**：每条数字后面都能追到一条命令、一处断言或一个由本次运行写出的文件。
没有真机来源的，明确写成「仅单测钉住」或「本机未能产生」，不补数字。

- 仓库：`/Users/totota/PureScience`
- 基线提交：`eab869aa`（A4 已完成并已推）+ 其后的 `811979a7`（CHANGELOG 排期条目）+ **本次 A5 未提交改动**（工作区内）
- 环境：macOS 27.0 · Node v22.22.3 · Electron 43（`npm run build:e2e`）· Playwright 1.62.1 · purescience 1.75.0
- 规格：`docs/plan-2026-09-29-pdf-annotations.md`（A5 = 检索 + 证据/引文链接线 + 「不进模型上下文」的测试约束）

---

## 1. 可复现命令

```bash
# 0) 构建主进程/渲染面产物（e2e 拉的是 out/）
npm run build:e2e

# 1) 真机 e2e：A5 新用例（原始读数由 PURESCIENCE_EVIDENCE_DIR 打开）
PURESCIENCE_EVIDENCE_DIR=/Users/totota/PureScience/docs/evidence \
  npx playwright test e2e/certification/pdf-annotation-search-evidence.spec.ts \
    --retries=0 --repeat-each=2

# 2) 受影响单测目录（两批）
npx vitest run src/main/search src/shared src/main/references src/preload \
  src/main/ipc-handler-registry.test.ts src/main/application-command-composition.test.ts \
  src/main/host-application-commands.test.ts src/main/renderer-broadcast.test.ts
npx vitest run src/renderer/src/components/global-search \
  src/renderer/src/pages/workspace/previews src/main/acp

# 3) 契约 / 计数门禁 + 既有标注线回归
npx vitest run src/shared/renderer-contract-catalog.test.ts src/preload/index.test.ts \
  src/main/application-command-composition.test.ts src/main/host-application-commands.test.ts \
  src/main/ipc-handler-registry.test.ts src/main/references/pdf-annotation-service.test.ts \
  src/main/references/pdf-annotation-import.test.ts src/main/references/pdf-annotation-export.test.ts \
  src/shared/pdf-annotation-export.test.ts

# 4) 门禁
npm run typecheck
npm run i18n:coverage -- --min 100
npm run check:web-api-map
npx prettier --check <改动文件>
npx eslint <改动文件>
git add -A && bash scripts/pre-push-checks.sh
```

`PURESCIENCE_EVIDENCE_DIR` 只在设置时写盘（下面 §3 的读数文件），CI 跑同一批规格时不落任何文件。

---

## 2. 真机 e2e：用例名与耗时（本次归档运行，逐字）

```
Running 2 tests using 1 worker

  ✓  1 e2e/certification/pdf-annotation-search-evidence.spec.ts:213:5 › finds a note through the global search, cites its file version, and reads only stored text (9.9s)
  ✓  2 e2e/certification/pdf-annotation-search-evidence.spec.ts:213:5 › finds a note through the global search, cites its file version, and reads only stored text (9.7s)

  2 passed (20.2s)
```

真实路径：真窗口 → 真 IPC → 真项目库 → 真的托管文件。唯一被替身接管的是原生对话框与 Agent 后端（既有的 e2e 夹具）。

---

## 3. 原始读数（本次运行写出，`docs/evidence/2026-09-29-pdf-annotation-search.txt`）

写标注走的是**面板自己的工具条**（便签工具 → 点页面 → 输入 → 保存），不是直接调 API。

| 读数                 | 本次真机值                                                                    |
| -------------------- | ----------------------------------------------------------------------------- |
| 标注种类             | `page-note`                                                                   |
| 标注正文             | `"E2E sentinel: the effect is large."`（全项目只此一处）                     |
| 版本（版本权威解析） | `b94a780f-18bb-4384-ac12-b2bac6e57b4b`                                        |
| checksum             | `sha256:8ab6d242d6445ff581f30994352b29e0a875546fcb095bf81b58fbd33a7abf36`     |
| 引文行 data-status   | `record`                                                                      |
| 引文行 data-page     | `1`                                                                           |
| 引文行 data-rect-count | `1`                                                                         |
| 引文行 data-quote    | `""`（便签不引原文，记录如实为空而不是编一个）                                |
| 检索（仅 `annotations` 作用域）命中 | 1                                                                  |
| 命中的字段           | `body`                                                                        |
| 命中的文件名         | `region-evidence.pdf`                                                         |
| 命中携带的锚点       | 与面板显示的**同一版本、同一 checksum**（`true`）                             |
| scan 报告            | `sessions=0 messages=0 files=0 references=0 annotations=1`                     |
| 语料＝库内            | `1 vs 1` ⇒ `true`                                                            |
| **负控制**：检索 PDF 文本层里的 `"Measured response"` | 命中 **0**，同一次扫描仍载入 **1** 条标注、`notes` 为空 |
| 面板策略声明         | `"Annotations are used for search and citation only — they are never assembled into a model’s context."` |
| 检索后库内           | `{current:1, versionChanged:0, checksumMismatch:0}`，锚点未变 `true`          |

**负控制之所以成立**：`"Measured response"` 是夹具 PDF 自己文本层里的图注（见 `e2e/fixtures/fake-opencode.mjs`
的 `minimalPdfContent`），从未被存成标注。若语料由解析 PDF 得来，它必然命中；它没命中，而同一查询的
`scan.annotations` 仍是 1（语料非空），所以这是「这条字符串不在语料里」，不是「语料是空的」。

---

## 4. 红线 3（标注不进模型上下文）：钉在哪条路径、哪条断言

**这是三条路径里的两条真实模型输入装配路径，都用差分证明隔离，而不是口头声称。**

新增 `src/main/acp/pdf-annotation-model-input-boundary.test.ts`（5 用例，全绿）。

### 路径一 · 交互轮次的模型输入

- 装配点：`AcpPromptContentOwner.prepare`（`src/main/acp/prompt-content-owner.ts`）——把一个回合的附件
  变成送给 Agent 的 content blocks；PDF 正文**只**经 `extractPdfText`
  （`src/main/uploads/attachment-media.ts`）进入内容。
- 断言（用例 `sends the PDF text layer and none of the markup, on the real attachment path`）：
  用**真 UploadRepository + 真附件路径**把带标注的 PDF 作为 `currentUploads` 送进去，然后
  1. 送出的内容**必须包含**该 PDF 自己的文本层（`Highlighted passage sits here.` / `Second page marked passage.`）——证明这条路没有把 PDF 整个丢掉（否则「不含标注」是为错误的理由成立的）；
  2. 送出的内容**必须不含**夹具里三条标注正文中的任何一条（`Keep this: the effect is large.` / `Region of interest: figure 2.` / `Page note from the reader.`）。
- 另有一条更底层的断言（`extracts no annotation text at all, even though the parser sees the annotation dictionaries`）
  直接钉住抽取器：`extractPdfText` 的输出含页面文本、**不含**任何标注正文，也不含夹具里那条
  「画在空白处」与「被文件标记为隐藏」的 `/Contents`。

### 路径二 · 文献分诊的模型输入

- 装配点：`assembleScreeningEvidence`（决定给模型看哪些文本）→ `assembleScreeningPrompt`
  （渲染成提示词，分指令区与数据区）。
- 断言（用例 `builds the model prompt from the record and its extracted text, with no markup in either zone`）：
  喂进去的 full text 就是路径一那个抽取器的输出，然后
  `assembled.prompt` / `instructionZone` / `dataZone` **三处都不得含任何标注正文**，而记录标题与证据文本**必须在**。

### 差分：为什么这不是「夹具恰好没东西可泄漏」

- 先跑 `readPdfEmbeddedAnnotations`（**A2 自己的标注读取器**）读同一份字节，断言那三个字符串**确实在文件里**
  且被逐字读出。上面的「不含」因此是在一个真的带有这些文本的文件上成立的。
- 再闭合另一面：同样的文本**能被检索语料读到**（同文件第三个 describe）：应用**真的持有**它们，
  只是不把它们装配进模型输入。

### 负控制（单测与真机都有）

- 单测：`extractPdfText` 对夹具的输出不含 `over blank space` / `hidden from every viewer`（文件里有、文本层没有）。
- 真机：见 §3 的 `"Measured response"` 0 命中。
- 语料模块 `src/main/search/annotation-corpus.ts` 的**依赖被逐条枚举并钉死**：`pdfjs-dist` / `node:fs` /
  `node:fs/promises` / 附件抽取器 / 标注导入器 / 标注导出器物**全在禁列**，且当前依赖清单被精确断言
  （`annotation-corpus.test.ts` 的 `the corpus module never parses a PDF`）。想往索引里加 PDF 文本，
  必须先动这份清单——这是可执行的，不是注释。

---

## 5. 受影响单测目录（本次实跑）

```
# 批一：main 侧（检索 / shared / 文献 / preload / 契约）
 Test Files  127 passed | 1 skipped (128)
      Tests  1457 passed | 1 skipped (1458)

# 批二：renderer 侧（全局检索 / 预览渲染器）+ acp（红线用例所在）
 Test Files  127 passed (127)
      Tests  1747 passed (1747)
```

契约 / 计数门禁那一组（9 文件）：

```
 Test Files  9 passed (9)
      Tests  151 passed (151)
```

本次新增/改写的用例文件：

- `src/main/acp/pdf-annotation-model-input-boundary.test.ts`（新，5 用例：红线 3）
- `src/main/search/annotation-corpus.test.ts`（新，8 用例：语料＝已存文本、上界、不解析 PDF 的依赖钉死）
- `src/main/search/global-search-annotations.test.ts`（新，11 用例：作用域命中、锚点随行、四条诚实读数、项目隔离）
- `src/shared/pdf-annotation-citation.test.ts`（新，15 用例：引用记录四要素、具名拒绝、与分诊范围对齐）
- `src/renderer/src/pages/workspace/previews/renderers/PdfAnnotationPanel.citation.test.tsx`（新，5 用例：引文行 + 9 语言声明）
- `src/renderer/src/components/global-search/GlobalSearchDialog.annotations.test.tsx`（新，3 用例：作用域标签、版本/页码、两条诚实提示）
- `src/main/references/pdf-annotation-repository.test.ts`（+5 用例：多锚点只读有界读；内存台账相应支持 `OR`/`take`）

全量套件（本机，最终一次改动之后）：

```
$ npx vitest run --maxWorkers=4
 Test Files  1147 passed | 15 skipped (1162)
      Tests  14952 passed | 191 skipped (15143)
```

---

## 6. 门禁（本次实跑尾部）

```
$ npm run typecheck
> tsc --noEmit -p tsconfig.node.json --composite false   (无输出)
> tsc --noEmit -p tsconfig.web.json  --composite false   (无输出)

$ npm run i18n:coverage -- --min 100
en source keys: 3196
en/zh/zh-Hant/ja/ko/fr/de/es/ru  keys=3196  coverage=100.0%
OK (all >= 100%)

$ npm run check:web-api-map
> node scripts/generate-web-api-map.mjs --check          (无输出即通过)

$ npx prettier --check <改动文件>
All matched files use Prettier code style!

$ npx eslint <改动文件>
✖ 1 problem (0 errors, 1 warning)
  1 warning 在 src/renderer/src/components/global-search/palette-commands.test.ts
  —— 该文件**本次未改动**（`git status` 不在改动清单内），为既有 warning。

$ git add -A && bash scripts/pre-push-checks.sh
  ✓ git 跟踪范围零命中
  ✓ README 版本横幅 v1.75.0
  ✓ CHANGELOG 已有 v1.75.0 条目
  ✓ v1.75.0 已发布到 GitHub Releases
  ✓ README 头部锚点双语一致
[pre-push] 全部通过。
```

**渠道计数门禁零改动**：本片**未新增 IPC 渠道**（检索复用既有 `search:query`，只在请求/响应契约上新增
`annotations` 作用域与命中溯源字段；引文是渲染层纯函数），所以 `web-api-map.generated.ts`、
`renderer-contract-catalog.test.ts`、`preload/index.test.ts` 的计数断言**全部原样通过**——这正是
「若新增渠道则同步门禁」的相反情形，写在这里以免读者以为漏做了。

---

## 7. 本机未能产生 / 未验证的点（如实列出）

1. **真机没有直接观测模型调用**：窗口里没有可抓的模型输入句柄，`window.api` 也不暴露送模型的 payload。
   因此红线 3 的**可执行**证据是 §4 那两条**真实装配路径**的单测；真机提供的是**界面声明可见**
   （`pdf-annotation-model-context-policy`）+ 「语料＝已存文本、库内有几条就扫几条」的读数。
   若要把「不进模型上下文」也做成真机断言，需要先有一个可观测的模型输入出口（例如把
   `AcpPromptPreparationOwner` 的组装结果做成可读事件），那是另一处改动。
2. **跨平台未实测**：本次只在 macOS 27.0 上跑。i18n 与路径相关断言都未在 Windows/Linux 上验证。
3. **只跑了一种标注**：真机只创建了 `page-note`（带 `anchorRect` 的一种）。区域框在 A4 用例里覆盖，
   文本类标注（`highlight` 等，带 `quote`）在单测里覆盖，但**真机上没有**走「选中文本产生 quote」这条路，
   所以 `data-quote` 非空这条读数只有单测来源。
4. **引文链与分诊导出的联调只有单测来源，未接界面入口**：`alignPdfAnnotationCitationsWithScreeningExport`
   的输入是调用方给的 `referenceId` + 分诊的 `ScreeningExportScope`。本轮**故意没有**把它接进
   `ReferencesScreeningPanel` 的导出：那会改写 S4 已冻结的导出文件内容（「不碰 screening-* 的已冻结语义」），
   也会把 A4 已冻结的「两条独立通道」变成三条——两者都是本片的硬约束。因此它现在是**可被调用的共享能力**
   + **面板上一条引文行**（真机已断言）。真机上也没有跑「文献库 PDF 上画标注 → 导出引文」这条端到端
   （需要先把 PDF 附到文献记录、再在预览里标注并进分诊集合）。
   已核实**接线在渲染层是可行的**（`Reference.pdfManagedFileId` 是 `ProjectFileItem.id`，而 artifact 项的
   `sourceFileId` / `sourceVersionId` 正是标注的锚点），所以补的是一个界面入口，不是新的数据通路。
5. **上界**：搜索语料上界 500 条（`GLOBAL_SEARCH_MAX_SCANNED_ANNOTATIONS`），锚点列表沿用项目文件索引的
   5 页 × 100（`GLOBAL_SEARCH_FILE_LIST_MAX_PAGES`）。超过时以 `annotations-bounded` 具名告知，
   但**没有做过 500 条以上的真机压测**。
6. **跨平台未实测**：全量套件与真机都只在 macOS 27.0 上跑过。翻译门禁有一条既有规则「各语言取值不得与
   英文相同」，本片为 `gs.contentScopeAnnotation` 在 fr/de 的合法借词「Annotation」登记了一个**同形词白名单**
   条目（`translation-quality.test.ts` 的 `LATIN_COGNATES`）并写明理由——若复核认为该词应硬译，改这一处即可。
