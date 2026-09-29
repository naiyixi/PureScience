# 文档标注层 A4 实机验收存档（2026-09-29）

本档只记录**跑出来的东西**：每条数字后面都能追到一条命令、一处断言或一个由本次运行写出的文件。
没有真机来源的，明确写成「仅单测钉住」或「本机未能产生」，不补数字。

- 仓库：`/Users/totota/PureScience`
- 基线提交：`7da214a`（A3 已完成并已推）+ **本次 A4 未提交改动**（工作区内）
- 环境：macOS 27.0 · Node v22.22.3 · Electron 43（`npm run build:e2e`）· Playwright 1.62.1
- 规格：`docs/plan-2026-09-29-pdf-annotations.md`（A4 = 两条导出通道 + 字节级断言）

---

## 1. 可复现命令

```bash
# 0) 构建主进程/渲染面产物（e2e 拉的是 out/）
npm run build:e2e

# 1) 真机 e2e：A4 新用例 + A3 回归（字节级读数由 PURESCIENCE_EVIDENCE_DIR 打开）
PURESCIENCE_EVIDENCE_DIR=/Users/totota/PureScience/docs/evidence \
  npx playwright test \
    e2e/certification/pdf-annotation-export.spec.ts \
    e2e/certification/pdf-annotation-layer.spec.ts --retries=0

# 2) 受影响单测目录
npx vitest run src/main/references src/shared src/preload \
  src/main/application-command-composition.test.ts src/renderer/src/i18n \
  src/renderer/src/pages/workspace/previews

# 3) 门禁
npm run typecheck
npm run i18n:coverage -- --min 100
npm run check:web-api-map
npx prettier --check <改动文件>
npx eslint <改动文件>
```

`PURESCIENCE_EVIDENCE_DIR` 只在设置时写盘（下面 §3 的读数文件），CI 跑同一批规格时不落任何文件。

---

## 2. 真机 e2e：用例名与耗时（本次归档运行，逐字）

A4 单独：

```
Running 1 test using 1 worker

  ✓  1 e2e/certification/pdf-annotation-export.spec.ts:126:5 › writes an annotated copy and a notes list, and never touches the version it exports from (9.7s)

  1 passed (10.1s)
```

与 A3 三条一起跑（回归，最终一次构建的源码）：

```
Running 4 tests using 1 worker

  ✓  1 e2e/certification/pdf-annotation-export.spec.ts:126:5 › writes an annotated copy and a notes list, and never touches the version it exports from (10.2s)
  ✓  2 e2e/certification/pdf-annotation-layer.spec.ts:120:5 › keeps a drawn annotation on its own file version, across an Electron relaunch (13.2s)
  ✓  3 e2e/certification/pdf-annotation-layer.spec.ts:204:5 › imports the markup a PDF carries, names what it skipped, and never claims an import that wrote nothing (10.2s)
  ✓  4 e2e/certification/pdf-annotation-layer.spec.ts:281:5 › keeps an annotation on the bytes it was drawn on when the file moves on, and re-anchors only on demand (8.2s)

  4 passed (42.2s)
```

跑的是真窗口 + 真 IPC + 真 SQLite 库 + **真文件**：PDF 由仓库既有 e2e 假 Agent 通过 app 自己的 artifact
工具写出，标注在界面里用鼠标拖出来，`resolveVersionFile` 走的是 artifact 版本溯源仓库的同一条解析路径。

---

## 3. 字节级红线：源文件导出前后 sha256（同一个文件，两条通道）

下面这些数字由本次运行写进 `docs/evidence/2026-09-29-pdf-annotation-export-bytes.txt`（只在设了
`PURESCIENCE_EVIDENCE_DIR` 时写；重跑会覆盖成那一次的数字）。源文件在磁盘上按**内容摘要**定位
（存储根下所有 `*.pdf` 里字节 sha256 等于 app 解出来的版本锚点者），在两条通道运行**之前**取一次 sha256，
两条通道都跑完**之后**再取一次。下面只写**跨运行稳定**的那几个（源文件 834 字节、摘要 `8ab6d242…`）；
每次运行会变的（version id、临时路径、副本/清单自身的 sha256）在读数文件里逐字存档：

```
文件: …/artifacts/<artifact-id>/e2e-session-1/message-…/region-evidence.pdf
  bytes: 834
  sha256 导出前: 8ab6d242d6445ff581f30994352b29e0a875546fcb095bf81b58fbd33a7abf36
  sha256 两条通道之后: 8ab6d242d6445ff581f30994352b29e0a875546fcb095bf81b58fbd33a7abf36
  unchanged: true
  同时 equals 库里的版本锚点（界面 data-anchor-checksum 也是这个数）: true
```

三点值得单独说，因为「不变」有三种误判方式：

1. **导出前的 sha256 与库里的版本锚点是同一个数**（`8ab6d242…`），导出前的 sha256 与导出后的 sha256 也是同一个数 ——
   不是「两个哈希恰好相等」，是「库锚点、导出前、导出后」三处同一值；
2. 通道 ① 的收据里也带这三个数（界面上的 `data-checksum-before` / `data-checksum-after` / `data-anchor-checksum`），
   e2e 逐个断言与上面同值 —— 应用自己也算了一遍，且主进程在写出副本后**重新从磁盘读回再哈希**，不等就不报成功；
3. 同一目录里没有任何其它文件被写出（`readdir` 断言只有一个副本），notes 通道**不打开源文件**（收据 `sourceBytes: null`）。

### 副本确实带了标注（同一份文件的副本）

```
channel 1 - annotated copy:
  path: …/region-evidence (annotated).pdf
  bytes: 1239                     ← 源 834 字节 + 追加 405 字节
  source bytes carried verbatim at the head: 834
  appended bytes: 405
  head is byte-for-byte the source: true
  copy carries "/Subtype /Square": true
  copy carries "/Annots [": true
  source carries "/Subtype /Square": false
  source carries "/Annots [": false
```

副本的判据是三重的，不是「文件变大了」：

1. 副本前 834 字节与源字节**逐个相等**（`Buffer.equals`，`true`）—— 增量更新是**追加**，源字节就是副本的头；
2. 副本里出现标注字典（`/Subtype /Square`、`/Subtype /Annot`、`/Annots [`），**源里一个都没有**；
3. 副本新增了一个 cross-reference 段，其 trailer 的 `/Prev` 指回源文件自己的 `startxref`
   （`/trailer\n<< \/Size \d+ \/Root \d+ \d+ R \/Prev \d+ >>/` 断言），所以源里声明的对象在副本里依旧可解析。

> 副本自身的 sha256 每次运行都不同（读数文件里那次是 `09920809…`；同一份源码重跑会得到别的值）：
> 标注字典带 `/M (D:…)` 写出时刻，且拖出来的矩形每次略有差异。上表里跨运行稳定的是**源**的 834 字节与
> 它的 `8ab6d242…`，以及「副本 = 源 + 405 字节追加」。

另有四条只在单测里钉住、本档不冒充真机读数：

- **副本是解析器认得的 PDF**：`src/main/references/pdf-annotation-export.test.ts` 把副本交给 app 自己的
  pdf.js 适配器（`readPdfEmbeddedAnnotations`）读回，得到 1 条 `Square`、page 1、Rect `[153, 198, 459, 396]`
  （0.25–0.75 × 0.5–0.75 of 612×792，逐值取整后相等）；
- **源 PDF 自带的标注不被覆盖**：源页面已有 `/Annots [7 0 R]` 时，副本里变成两个引用（追加，不替换）；
- **trailer 要素被带到副本**：源 trailer 里有 `/Info` / `/ID` 时，副本的 new trailer 也带（否则副本会丢掉
  标题作者这类元数据）/（`src/shared/pdf-annotation-export.test.ts`）；
- **加密 PDF 按名拒绝**：trailer 带 `/Encrypt` 时不出副本（`unsupported-pdf-structure`），
  免得生成一份「新对象没被加密」的半加密文件。

### notes 通道不产生 PDF 副本

```
channel 2 - notes list:
  path: …/region-evidence (annotations).txt
  bytes: 405
  starts with %PDF-: false
  entry lines: 1 (the store holds 1)
  carries "/Subtype": false

export directory after both channels: region-evidence (annotated).pdf, region-evidence (annotations).txt
copy unchanged by channel 2: true
```

- 收据里 `copy === null`（界面 `data-testid=pdf-annotation-export-copy` 计数为 0），并有一行
  「This channel writes no PDF」；
- 导出目录里**只有**通道 ① 的副本与这次清单两个文件：notes 通道没有生成任何 PDF；
- 「条数与库内一致」是对着 `pdfAnnotations.list` 的答案比的：清单里的条目行数 = 库内该文件的标注数（都是 1）。

---

## 4. 溯源

两次导出的收据都带 `provenance = { projectId, sessionId, sourceFileId, versionId, checksum, exportedAt }`，
其中 `versionId` 是 artifact 版本 id、`checksum` 是版本权威解析出的内容 sha256 —— 与 A1 的版本锚定是同一对数
（e2e 断言 `data-anchor-checksum` 等于库里读出的 `anchor.checksum`）。notes 文件头部同样写着这几个事实
（`project/session/file/version/checksum/exported-at/annotations`），所以离开 app 之后仍然能对上版本。

副本内部也带溯源：每个标注字典带 `/T (PureScience)` 与 `/M (D:YYYYMMDDHHmmSSZ)`。

---

## 5. 门禁读数（本次运行）

```
en source keys: 3181
zh / zh-Hant / ja / ko / fr / de / es / ru   keys= 3181  coverage=100.0%
OK (all >= 100%)

$ npm run check:web-api-map      → 无输出，退出码 0
$ npm run typecheck              → 通过（node + web）
$ npx eslint <改动文件>           → 无输出，退出码 0
$ npx prettier --check <改动文件> → All matched files use Prettier code style!
$ npm run test:gate              → 1140 passed | 1 failed（唯一失败是本片漏改的一处计数，
                                   改完在该文件单跑 7 passed；见下表最后一行）
```

契约/计数门禁（都是真跑出来的增量）：

| 门禁                                          | 位置                                                                | 变化                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 渲染面契约清单                                | `src/shared/renderer-contract-catalog.test.ts`                      | 446 → 448 条，invoke 342 → 344，localWeb 372 → 374，远端 rejecting-stub 114 → 116 |
| 主进程命令总数（启动时认证，错了 app 起不来） | `src/main/application-command-composition.ts`                       | internal 336 → 338，local Web 334 → 336，远端 fail-closed 114 → 116               |
| 主进程命令组                                  | `src/main/host-application-commands.test.ts`                        | 82 → 84 个通道，本地专用 54 → 56                                                  |
| preload 桥                                    | `src/preload/index.test.ts`                                         | 219 → 221，请求面 181 → 183                                                       |
| 渲染面跨面清单                                | `src/shared/renderer-surface-inventory.test.ts`                     | 446 → 448，remote local-only 114 → 116                                            |
| Web 面参数形状                                | `src/renderer/web/renderer-argument-shape-characterization.test.ts` | 372 → 374                                                                         |
| 入口层覆盖                                    | `src/shared/renderer-contract-entry-coverage.test.ts`               | 两个新通道被窗口调用，无遗留                                                      |

> 注意：`INTERNAL_COMMAND_COUNT` 这一类数字**只在 app 启动时才认证**，单测全绿也不代表能启动。
> 本次是先跑真机 e2e 撞出 `Application command inventory mismatch: expected 336 commands, received 338`，
> 改完数字后重新 `npm run build:e2e` 才起来的 —— 这也是为什么这批数字必须跟着 e2e 一起改。

---

## 6. 本机未能验证 / 不确定的点

1. **落到第三方阅读器里的观感**：本机只读了副本的字节与 pdf.js 的解析结果，没有在 Adobe / 预览.app 里
   打开副本看排版。Rect/QuadPoints 的坐标换算（归一化 → 用户空间，y 轴翻转一次）在单测里钉住了数值，
   但「看起来位置对不对」未验证。
2. **跨平台**：只在 macOS 27.0 上跑过。Windows/Linux 上 `dialog.showSaveDialog` 的 filters 行为与路径
   分隔符未验证（文件名清洗按码点过滤 `/\:*?"<>|` 与 0x1f 以下控制字符，未在 Windows 实机确认）。
3. **不含 classic xref 的 PDF**（xref stream，PDF 1.5+ 常见）：通道 ① 会按名拒绝
   （`unsupported-pdf-structure`），没有做 xref stream 的追加写入。本次 fixture 与仓库自产 PDF 都是
   classic xref，所以「真实论文 PDF 能不能导出副本」这件事**本机没有实测过**。
4. **大文件**：导出要把源字节读进内存并整体 latin1 解码一次以定位页面字典；几十 MB 的 PDF 没测过
   耗时与峰值内存。
5. **并发两条通道**：e2e 是先后跑两条通道；同时点两个按钮会让一个处于 running（另一个按钮禁用），
   未做并发压测。
6. **只在一个页面、一种标注上跑过真机**：e2e 拖的是区域框（`Square`）。高亮/下划线（`QuadPoints`）、
   页面便签（`Text`）与多页场景只有单测覆盖，真机未跑。
7. **A5 的两件事未动**：标注进全局检索、证据/引文链，以及「不进模型上下文」的测试约束 —— 本片没碰。
