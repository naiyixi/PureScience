// PDF-explore persistence + parsing: the store behind pdf_open / pdf_pages / pdf_outline /
// pdf_scan. Opening a PDF parses it with pdfjs (reusing the uploads text-extraction path),
// extracts the bookmark outline, and persists the full page-text array as one JSON file under
// the data root — so a 50-page paper costs zero context until pages are explicitly read. The
// scan ranking is a lightweight term-frequency scorer (no external model), good enough to
// locate "where does this paper mention dataset X".

import { createHash } from 'node:crypto'

import { parseArtifactVersionLocator } from '../../shared/artifact-provenance'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import {
  auditPdfTableCandidateForUse,
  explainTableRejection,
  extractPdfTableCandidates,
  extractPdfTableCandidatesFromText,
  toMarkdownTable,
  toHtmlTable,
  toTsv,
  type PdfTableCandidate,
  type PdfTableRejection,
  type PdfTextItem
} from '../../shared/pdf-table-extraction'
import {
  auditPdfFigureForUse,
  extractPdfFigureCandidates,
  pdfImagePlacementsFromOperations,
  pdfVectorFigurePlacementsFromOperations,
  type PdfImagePlacement,
  type PdfPaintOperation
} from '../../shared/pdf-figure-extraction'
import {
  normalizePageOrientation,
  type AxisAlignedRotation,
  type PdfPlacedTextItem,
  type PdfTextMatrix
} from '../../shared/pdf-page-rotation'
import { assemblePdfPageText, pdfTextRunsFromItems } from '../../shared/pdf-page-text'
import { figureUnderstandingFor } from '../../shared/figure-understanding'
import { applyAccessionLookups, deriveFromFigure } from '../../shared/figure-derivation'
import type { FigureDerivation } from '../../shared/figure-derivation'
import type { AccessionLookupOutcome } from '../../shared/figure-accession'
import type { FigureAccession, FigureClass } from '../../shared/figure-understanding'
import type { FigureDerivationInput } from '../../shared/figure-observation'
import type {
  PdfOpenResult,
  PdfOutlineEntry,
  PdfOutlineResult,
  PdfPageScanHit,
  PdfPagesResult,
  PdfRotatedPage,
  PdfScanResult,
  PdfTableCandidateForAgent,
  PdfTablesResult,
  RegisteredPdf
} from '../../shared/pdf'
import type { PdfFigureForAgent, PdfFiguresResult } from '../../shared/pdf'
import { PDF_FIGURES_MAX_FIGURES } from '../../shared/pdf'
import {
  PDF_MAX_PAGE_TEXT_CHARS,
  PDF_MAX_PAGES,
  PDF_MAX_TOTAL_CHARS,
  PDF_SCAN_RESULT_LIMIT,
  PDF_SCAN_SNIPPET_CHARS,
  PDF_TABLES_MAX_CANDIDATES
} from '../../shared/pdf'

const PDFS_DIR = '.pdfs'

export class PdfValidationError extends Error {
  readonly code: 'not_found' | 'invalid_path' | 'too_large' | 'too_many_pages'

  constructor(code: PdfValidationError['code'], message: string) {
    super(message)
    this.name = 'PdfValidationError'
    this.code = code
  }
}

/**
 * U4-d：一条插图派生结果**由谁记账**。端口拿到的是「输入 + 判定 + 派生」这三样，**输入指纹由记账方
 * 计算**（配方在 shared，摘要在主进程算）—— 这样 PdfService 不必认识那条溯源面的哈希实现。
 */
export type FigureDerivationRecord = FigureDerivationInput & {
  sessionId: string
  index: number
  figureClass: FigureClass | 'undetermined'
  derivation: FigureDerivation
}

export type PdfServiceOptions = {
  storageRoot: string
  /**
   * 有插图被判定并派生时调一次。**只在文档带着来源会话时调**：没有会话就没有账可记（不是失败）。
   * 调用方负责把这条记进**既有**那条结构观察溯源面（与选择/测量同一条账）。
   */
  onFigureDerivation?: (record: FigureDerivationRecord) => void
  /**
   * 按图上的库号取**真实数据**（U4-b）。缺席 = 这条路没接线，派生会**具名**说「没接」而不是静默省略。
   * 请求本身不在这里做：装配点注入的实现跑在主进程的受管取数路径上（遵应用与系统的代理设置）。
   */
  lookupAccession?: (accession: FigureAccession) => Promise<AccessionLookupOutcome>
  // Resolves a project-relative or absolute path to an on-disk file path. Absent ⇒ relative
  // paths resolve against storageRoot.
  resolvePath?: (path: string) => Promise<string | undefined>
  // Resolves an Artifact Version locator (or a Session-relative artifact path) to a file on disk. Absent ⇒
  // only filesystem paths can be read, which is what a caller with no Session has.
  resolveSessionArtifactPath?: (
    projectId: string,
    sessionId: string,
    path: string
  ) => Promise<string>
  // Injectable PDF parser (tests); defaults to the pdfjs implementation.
  parsePdf?: (filePath: string) => Promise<{
    pages: string[]
    outline: PdfOutlineEntry[]
    title: string
    /**
     * Positioned items per page, when the parser can produce them. Optional on purpose: the text table
     * extraction is a strictly weaker method, and a parser that cannot position items must not pretend it
     * can (see the method named on each candidate).
     */
    items?: PdfTextItem[][]
    images?: PdfImagePlacement[][]
    /** 路径几何聚出来的候选（矢量画的图），与 `images` 并列。缺席 = 这个解析器不读操作符。 */
    vectors?: PdfImagePlacement[][]
    /**
     * The content-stream rotation the parser normalized away, one entry per page (0 = the page was already
     * upright). Optional for the same reason `items` is: a parser that does not read text matrices has no
     * rotation to report, and must not claim one.
     */
    pageRotations?: AxisAlignedRotation[]
  }>
  now?: () => number
}

export class PdfService {
  private readonly now: () => number

  constructor(private readonly options: PdfServiceOptions) {
    this.now = options.now ?? (() => Date.now())
  }

  private docPath(docId: string): string {
    return join(this.options.storageRoot, PDFS_DIR, `${docId}.json`)
  }

  private async readDoc(docId: string): Promise<RegisteredPdf | null> {
    try {
      const raw = await readFile(this.docPath(docId), 'utf8')
      const parsed = JSON.parse(raw) as unknown
      return isRegisteredPdf(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  private async writeDoc(doc: RegisteredPdf): Promise<void> {
    const target = this.docPath(doc.docId)
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.${crypto.randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(doc), { encoding: 'utf8', flag: 'wx' })
    await rename(temp, target)
  }

  /**
   * The doc id for a file this service has already registered, else a fresh registration.
   *
   * A doc id is minted from `path + Date.now()`, so opening the same file twice yields two identities —
   * and everything keyed by the id (a translation checkpoint, for one) then describes a document that
   * no longer exists, or is silently lost. Callers that come back to the same file (a reader pressing
   * "translate" again, a second open of the same attachment) must therefore go through here.
   *
   * Matching is on the caller's own path string plus the project: the same file registered under two
   * projects is two registrations on purpose, because a document's readers are per project.
   */
  async ensureDoc(
    path: string,
    projectId = '',
    sessionId?: string
  ): Promise<{ docId: string; pageCount: number; reused: boolean }> {
    const existing = await this.findDocByPath(path, projectId)
    if (existing) {
      return { docId: existing.docId, pageCount: existing.pageCount, reused: true }
    }
    const opened = await this.open(path, projectId, sessionId)
    return { docId: opened.doc.docId, pageCount: opened.doc.pageCount, reused: false }
  }

  /** The newest registration for this path in this project, or null. Unreadable files are skipped, not thrown. */
  private async findDocByPath(path: string, projectId: string): Promise<RegisteredPdf | null> {
    let entries: string[]
    try {
      entries = await readdir(join(this.options.storageRoot, PDFS_DIR))
    } catch {
      return null
    }
    let newest: RegisteredPdf | null = null
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const doc = await this.readDoc(entry.slice(0, -'.json'.length))
      if (!doc) continue
      if (doc.sourcePath !== path || doc.projectId !== projectId) continue
      if (!newest || doc.createdAt > newest.createdAt) newest = doc
    }
    return newest
  }

  // Opens (parses + persists) a PDF. Returns the outline-level summary; page text stays on disk.
  async open(path: string, projectId = '', sessionId?: string): Promise<PdfOpenResult> {
    const resolved = await this.resolveInputPath(path, projectId, sessionId)
    if (!resolved) {
      throw new PdfValidationError('invalid_path', `Cannot resolve PDF path: ${path}`)
    }
    const { pages: rawPages, outline, title } = await (this.options.parsePdf ?? parsePdf)(resolved)
    if (rawPages.length > PDF_MAX_PAGES) {
      throw new PdfValidationError(
        'too_many_pages',
        `PDF has ${rawPages.length} pages, exceeding the ${PDF_MAX_PAGES}-page limit.`
      )
    }
    const pages = rawPages.map((page) => page.slice(0, PDF_MAX_PAGE_TEXT_CHARS))
    const totalChars = pages.reduce((sum, page) => sum + page.length, 0)
    if (totalChars > PDF_MAX_TOTAL_CHARS) {
      throw new PdfValidationError(
        'too_large',
        `PDF text is ${totalChars} chars, exceeding the ${PDF_MAX_TOTAL_CHARS}-char limit.`
      )
    }

    const docId = createHash('sha256').update(`${path}:${Date.now()}`).digest('hex').slice(0, 16)
    const doc: RegisteredPdf = {
      docId,
      projectId,
      sourcePath: path,
      ...(sessionId ? { sourceSessionId: sessionId } : {}),
      title,
      pageCount: pages.length,
      outline,
      pages,
      createdAt: this.now()
    }
    await this.writeDoc(doc)

    const textPageCount = pages.filter((page) => page.length > 0).length
    return {
      doc: { docId, title, pageCount: pages.length, outline },
      textPageCount,
      emptyPageCount: pages.length - textPageCount
    }
  }

  async pages(docId: string, start: number, end?: number): Promise<PdfPagesResult> {
    const doc = await this.requireDoc(docId)
    const clampedStart = Math.max(1, start)
    const clampedEnd = Math.min(doc.pageCount, end ?? clampedStart)
    if (clampedStart > doc.pageCount) {
      throw new PdfValidationError(
        'not_found',
        `Page ${start} is out of range (1-${doc.pageCount}).`
      )
    }
    const result: PdfPagesResult = {
      docId,
      start: clampedStart,
      end: clampedEnd,
      pages: []
    }
    for (let page = clampedStart; page <= clampedEnd; page += 1) {
      result.pages.push({ page, text: doc.pages[page - 1] ?? '' })
    }
    return result
  }

  async outline(docId: string): Promise<PdfOutlineResult> {
    const doc = await this.requireDoc(docId)
    return { docId, title: doc.title, pageCount: doc.pageCount, outline: doc.outline }
  }

  // Table candidates from the PDF's own text layer. Nothing here is a verified transcription, so every
  // candidate says which method produced it, how confident that method is, and what a reader must still do
  // before using it. Geometry (row/column clustering) is used when the parser can position items; the
  // whitespace method is named as the weaker claim it is.
  async tables(docId: string, page?: number): Promise<PdfTablesResult> {
    const doc = await this.requireDoc(docId)
    if (page !== undefined && (page < 1 || page > doc.pageCount)) {
      throw new PdfValidationError('not_found', `Page ${String(page)} is outside this document.`)
    }
    const sourcePath = await this.resolveInputPath(
      doc.sourcePath,
      doc.projectId,
      doc.sourceSessionId
    )
    if (!sourcePath)
      throw new PdfValidationError('not_found', `Source file is unavailable: ${doc.sourcePath}`)
    const parse = this.options.parsePdf ?? parsePdf
    const parsed = await parse(sourcePath)
    const first = page ?? 1
    const last = page ?? parsed.pages.length
    const candidates: PdfTableCandidateForAgent[] = []
    // Why a scanned page produced nothing. Collected for the pages the reader looked at, and attached to
    // the result ONLY when the whole scan found no candidate: next to a real table the reasons would be
    // noise, and a reader who got candidates is not asking why other pages have none.
    const rejectedPages: PdfTableRejection[] = []
    // Pages whose content stream was rotated (and so had their coordinates rewritten to upright before
    // anything was measured). Reported whether or not a candidate came off them: a table read from a
    // rotated page is exactly the case where the numbers look shifted against the page as displayed.
    const rotatedPages: PdfRotatedPage[] = []
    let scannedPages = 0
    for (let pageNumber = first; pageNumber <= last; pageNumber += 1) {
      if (candidates.length >= PDF_TABLES_MAX_CANDIDATES) break
      scannedPages += 1
      const rotation = parsed.pageRotations?.[pageNumber - 1] ?? 0
      if (rotation !== 0) rotatedPages.push({ page: pageNumber, rotation })
      const items = parsed.items?.[pageNumber - 1]
      const pageText = parsed.pages[pageNumber - 1] ?? ''
      const positioned = items && items.length > 0 ? items : undefined
      const found: PdfTableCandidate[] = positioned
        ? extractPdfTableCandidates(pageNumber, positioned)
        : pageText.trim() === ''
          ? []
          : extractPdfTableCandidatesFromText(pageNumber, pageText)
      if (found.length === 0) {
        rejectedPages.push(
          explainTableRejection(pageNumber, {
            ...(positioned ? { items: positioned } : {}),
            pageText
          })
        )
        continue
      }
      for (const candidate of found) {
        if (candidates.length >= PDF_TABLES_MAX_CANDIDATES) break
        candidates.push({
          page: candidate.page,
          status: candidate.status,
          method: candidate.method,
          rows: candidate.rows,
          columnCount: candidate.columnCount,
          confidence: candidate.confidence,
          markdown: toMarkdownTable(candidate),
          tsv: toTsv(candidate),
          html: toHtmlTable(candidate),
          warnings: auditPdfTableCandidateForUse(candidate)
        })
      }
    }
    return {
      docId,
      ...(page === undefined ? {} : { page }),
      scannedPages,
      candidates,
      ...(rotatedPages.length > 0 ? { rotatedPages } : {}),
      ...(candidates.length === 0 && rejectedPages.length > 0 ? { rejectedPages } : {})
    }
  }

  /**
   * 库号 → 真实记录。只升级「库号在图上、查询口没接」这一种拒答；查询口缺席 ⇒ 一个字都不动（保持具名
   * 说「没接」），查询抛错 ⇒ 也算**查不动**（不是因为异常而把这一路悄悄抹掉）。
   */
  private async withAccessionLookups(derivation: FigureDerivation): Promise<FigureDerivation> {
    const lookup = this.options.lookupAccession
    if (!lookup) return derivation
    if (derivation.kind !== 'refused' || derivation.reason !== 'accession-lookup-not-wired') {
      return derivation
    }
    const accessions = derivation.accessions ?? []
    if (accessions.length === 0) return derivation
    const outcomes: AccessionLookupOutcome[] = []
    for (const accession of accessions) {
      try {
        outcomes.push(await lookup(accession))
      } catch (error) {
        outcomes.push({
          state: 'unavailable',
          id: accession.id,
          reason: error instanceof Error ? error.message : 'the lookup threw'
        })
      }
    }
    return applyAccessionLookups(derivation, outcomes)
  }

  async figures(docId: string, page?: number): Promise<PdfFiguresResult> {
    const doc = await this.requireDoc(docId)
    if (page !== undefined && (page < 1 || page > doc.pageCount)) {
      throw new PdfValidationError('not_found', `Page ${String(page)} is outside this document.`)
    }
    const sourcePath = await this.resolveInputPath(
      doc.sourcePath,
      doc.projectId,
      doc.sourceSessionId
    )
    if (!sourcePath)
      throw new PdfValidationError('not_found', `Source file is unavailable: ${doc.sourcePath}`)

    const parse = this.options.parsePdf ?? parsePdf
    const parsed = await parse(sourcePath)
    const first = page ?? 1
    const last = page ?? parsed.pages.length
    const figures: PdfFigureForAgent[] = []
    let skippedSmall = 0
    let withoutCaption = 0
    let scannedPages = 0

    for (let pageNumber = first; pageNumber <= last; pageNumber += 1) {
      if (figures.length >= PDF_FIGURES_MAX_FIGURES) break
      scannedPages += 1
      const images = parsed.images?.[pageNumber - 1] ?? []
      const vectors = parsed.vectors?.[pageNumber - 1] ?? []
      // 只按图像判空页会**整页漏掉矢量画的图** —— 那些页恰恰是森林图/决策树所在页。
      if (images.length === 0 && vectors.length === 0) continue
      const items = parsed.items?.[pageNumber - 1] ?? []
      const extraction = extractPdfFigureCandidates({
        page: pageNumber,
        images,
        ...(vectors.length === 0 ? {} : { vector: vectors }),
        items
      })
      skippedSmall += extraction.skippedSmall
      withoutCaption += extraction.withoutCaption
      for (const figure of extraction.figures) {
        if (figures.length >= PDF_FIGURES_MAX_FIGURES) break
        const caption = figure.caption
        const inside = itemsInsideFigure(items, figure)
        const understanding = figureUnderstandingFor({
          ...(caption === undefined ? {} : { caption }),
          inFigureText: inside.map((item) => item.text)
        })
        // 纯函数先给出「这一类允许派生什么」；库号那一路再**换成库里真取的记录**（查询口缺席时保持具名拒答）。
        const derivation = await this.withAccessionLookups(
          deriveFromFigure({ understanding, inFigureText: inside })
        )
        figures.push({
          page: figure.page,
          index: figure.index,
          bbox: { x: figure.x, y: figure.y, width: figure.width, height: figure.height },
          // 候选从哪来：图像放置，还是页面的路径几何。读者要能分辨，否则矢量簇会被当成一张位图。
          origin: figure.origin,
          ...(caption === undefined ? {} : { caption }),
          captionSource: figure.captionSource,
          // 插图理解的第一层（U4）：按类别分派。凭的是文档自己给出的两样东西 —— 图注，与**落在图框内**
          // 的文字项（轴标注、试剂/取代基记号）。判不出就写 `undetermined` 并给出具名理由：这张图不是
          // 「还没判」，而是「凭现有证据判不出」，两者不能共用一个形状。
          understanding,
          // 第二层（U4）：这一类允许派生什么。图表给图框内的数值（每项带来源几何）；其余三类给**具名
          // 拒答**并写明缺什么 —— 拒答也出现在结果里，否则「空」会被读成「没什么可派的」。
          derivation,
          warnings: auditPdfFigureForUse(figure)
        })
        // 记账只发生在文档知道自己来自哪一次会话时；失败/没有会话都不影响这次读取。
        if (this.options.onFigureDerivation && doc.sourceSessionId) {
          this.options.onFigureDerivation({
            sessionId: doc.sourceSessionId,
            page: figure.page,
            index: figure.index,
            bbox: { x: figure.x, y: figure.y, width: figure.width, height: figure.height },
            ...(caption === undefined ? {} : { caption }),
            inFigureText: inside.map((item) => item.text),
            figureClass: understanding.verdict.class,
            derivation
          })
        }
      }
    }

    return {
      docId,
      ...(page === undefined ? {} : { page }),
      scannedPages,
      figures,
      skippedSmall,
      withoutCaption
    }
  }

  async scan(docId: string, query: string): Promise<PdfScanResult> {
    const doc = await this.requireDoc(docId)
    const terms = tokenize(query)
    if (terms.length === 0) {
      return { docId, query, hits: [] }
    }

    const scored: { page: number; score: number; snippet: string }[] = []
    for (let index = 0; index < doc.pages.length; index += 1) {
      const page = doc.pages[index]
      if (!page) continue
      const pageTerms = tokenize(page)
      if (pageTerms.length === 0) continue
      const counts = new Map<string, number>()
      for (const term of pageTerms) counts.set(term, (counts.get(term) ?? 0) + 1)

      let score = 0
      for (const term of terms) {
        const count = counts.get(term) ?? 0
        if (count > 0) score += Math.log(1 + count) * (count > 1 ? 1.5 : 1)
      }
      if (score === 0) continue
      scored.push({ page: index + 1, score, snippet: bestSnippet(page, terms) })
    }

    scored.sort((a, b) => b.score - a.score)
    const hits: PdfPageScanHit[] = scored
      .slice(0, PDF_SCAN_RESULT_LIMIT)
      .map(({ page, score, snippet }) => ({ page, score: Math.round(score * 100) / 100, snippet }))
    return { docId, query, hits }
  }

  private async requireDoc(docId: string): Promise<RegisteredPdf> {
    const doc = await this.readDoc(docId)
    if (!doc) {
      throw new PdfValidationError('not_found', `No registered PDF with doc_id ${docId}.`)
    }
    return doc
  }

  // A Version locator is an opaque identity, not a path: it has to be resolved to that Version's file before
  // anything can be read from it, and the locator itself knows which Session it belongs to.
  private async resolveInputPath(
    path: string,
    projectId: string,
    sessionId?: string
  ): Promise<string | undefined> {
    const resolveArtifact = this.options.resolveSessionArtifactPath
    if (resolveArtifact && sessionId && parseArtifactVersionLocator(path)) {
      return resolveArtifact(projectId, sessionId, path)
    }
    return this.resolveSourcePath(path)
  }

  private async resolveSourcePath(path: string): Promise<string | undefined> {
    if (this.options.resolvePath) {
      return this.options.resolvePath(path)
    }
    if (path.startsWith('/')) return path
    // Default: resolve relative paths against the storage root (tests / headless).
    return join(this.options.storageRoot, path)
  }
}

// Parses a PDF with pdfjs: per-page text + bookmark outline + title.
/** 图框内文字项四边各留一个点：图内的轴标注常压在边框上，而它们正是判类别的证据。 */
const FIGURE_TEXT_TOLERANCE = 1

/**
 * 落在图框内的文字项（PDF 用户空间，原点左下）。**只取图内**：图注本身由抽取器单独给出，两者在
 * 判定里分属不同来源（`caption` / `in-figure-text`），读者据此知道是哪一边投的票。返回**带几何的项**
 * 而不是纯文本：图表一路的派生要把每一项的来源（它印在哪一行、印在哪）原样带出去。
 */
const itemsInsideFigure = (
  items: readonly PdfTextItem[],
  figure: { x: number; y: number; width: number; height: number }
): PdfTextItem[] =>
  items.filter(
    (item) =>
      item.text.trim() !== '' &&
      item.x >= figure.x - FIGURE_TEXT_TOLERANCE &&
      item.x + item.width <= figure.x + figure.width + FIGURE_TEXT_TOLERANCE &&
      item.y >= figure.y - FIGURE_TEXT_TOLERANCE &&
      item.y + item.height <= figure.y + figure.height + FIGURE_TEXT_TOLERANCE
  )

const parsePdf = async (
  filePath: string
): Promise<{
  pages: string[]
  outline: PdfOutlineEntry[]
  title: string
  /** Absent on the paths that stop before the text layer could be read. */
  items?: PdfTextItem[][]
  images?: PdfImagePlacement[][]
  /** 路径几何聚出来的候选：矢量画的图只存在于这里（与 `images` 并列，都来自同一趟操作符读取）。 */
  vectors?: PdfImagePlacement[][]
  /** One entry per page: the content-stream rotation that was normalized away (0 = already upright). */
  pageRotations?: AxisAlignedRotation[]
}> => {
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const { readFile } = await import('node:fs/promises')

  const require = createRequire(import.meta.url)
  const packageDir = dirname(require.resolve('pdfjs-dist/package.json'))
  const cMapUrl = `${pathToFileURL(join(packageDir, 'cmaps')).href}/`
  const standardFontDataUrl = `${pathToFileURL(join(packageDir, 'standard_fonts')).href}/`

  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as typeof import('pdfjs-dist')
  const fileData = await readFile(filePath)
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(fileData),
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0
  })
  const document = await loadingTask.promise

  try {
    const pages: string[] = []
    const itemsPerPage: PdfTextItem[][] = []
    const pageRotations: AxisAlignedRotation[] = []
    const imagesPerPage: PdfImagePlacement[][] = []
    // 路径几何聚出来的候选，与图像候选并行：矢量画的图只存在于这里（见 shared 里的聚簇函数）。
    const vectorsPerPage: PdfImagePlacement[][] = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      page.cleanup()
      const placed: PdfPlacedTextItem[] = []
      for (const item of content.items) {
        if (!('str' in item) || item.str.trim() === '') continue
        const transform = Array.isArray(item.transform) ? item.transform : []
        const matrix: PdfTextMatrix = [
          finiteOrZero(transform[0]),
          finiteOrZero(transform[1]),
          finiteOrZero(transform[2]),
          finiteOrZero(transform[3]),
          finiteOrZero(transform[4]),
          finiteOrZero(transform[5])
        ]
        placed.push({
          item: {
            text: item.str,
            x: matrix[4],
            y: matrix[5],
            width: typeof item.width === 'number' ? item.width : 0,
            height: typeof item.height === 'number' ? item.height : 0
          },
          matrix
        })
      }
      // A page whose content stream is rotated is turned back to upright HERE, before any geometry
      // consumer sees it: rows, columns, captions and figures all rest on "left edge, baseline, width",
      // which a rotated text matrix falsifies. The rotation travels with the parse so a reader can be
      // told the coordinates were rewritten.
      const oriented = normalizePageOrientation(placed)
      itemsPerPage.push(oriented.items)
      pageRotations.push(oriented.reading.rotation)

      // The same pass that reads the text reads the page's images: a figure is an image placement plus
      // whatever label the document put near it, so the placements travel with the items.
      const placements: PdfImagePlacement[] = []
      const vectorPlacements: PdfImagePlacement[] = []
      try {
        const operators = await page.getOperatorList()
        const operations: PdfPaintOperation[] = []
        for (let index = 0; index < operators.fnArray.length; index += 1) {
          const fn = operators.fnArray[index]
          const args = operators.argsArray[index]
          if (fn === pdfjs.OPS.transform) {
            const matrix = Array.isArray(args) ? args.map((value) => Number(value)) : []
            if (matrix.length >= 6 && matrix.every((value) => Number.isFinite(value))) {
              operations.push({
                kind: 'transform',
                matrix: [matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]]
              })
            }
            continue
          }
          if (
            fn === pdfjs.OPS.paintImageXObject ||
            fn === pdfjs.OPS.paintInlineImageXObject ||
            fn === pdfjs.OPS.paintImageMaskXObject
          ) {
            operations.push({ kind: 'image' })
            continue
          }
          if (fn === pdfjs.OPS.constructPath) {
            // args = [坐标个数, [打包流], bbox]。打包流是**码+坐标**的混合（见 shared 里的文法注释，按
            // 「恰好读完」在真机语料上证过），所以这里只做拆包，不做语义假设。
            const pathArgs = Array.isArray(args) ? args : []
            const packed = pathArgs[1]
            const raw: unknown = Array.isArray(packed) ? packed[0] : packed
            const values = ArrayBuffer.isView(raw)
              ? Array.from(raw as unknown as ArrayLike<number>)
              : Array.isArray(raw)
                ? (raw as unknown[]).map((value) => Number(value))
                : []
            const numbers = values
              .map((value) => Number(value))
              .filter((value) => Number.isFinite(value))
            if (numbers.length >= 3) operations.push({ kind: 'path', points: numbers })
          }
        }
        placements.push(...pdfImagePlacementsFromOperations(operations))
        const view = Array.isArray(page.view) ? page.view : []
        if (view.length >= 4) {
          vectorPlacements.push(
            ...pdfVectorFigurePlacementsFromOperations(operations, {
              width: Math.abs(Number(view[2]) - Number(view[0])),
              height: Math.abs(Number(view[3]) - Number(view[1]))
            }).placements
          )
        }
      } catch {
        // Images are best-effort: a page whose operators cannot be read still yields its text.
      }
      imagesPerPage.push(placements)
      vectorsPerPage.push(vectorPlacements)
      // The page text is assembled from the SAME pass, but from every run pdfjs reported — including the
      // whitespace-only runs the positioned list above drops, because a space is its own item and dropping it
      // would glue words together. `hasEOL` is what carries the line ends (see `assemblePdfPageText`); without
      // it this page used to come out as one run-on string.
      const pageText = assemblePdfPageText(pdfTextRunsFromItems(content.items)).trim()
      pages.push(pageText)
    }

    const outline: PdfOutlineEntry[] = []
    try {
      const items = await document.getOutline()
      if (Array.isArray(items)) {
        const collect = async (entries: typeof items, level: number): Promise<void> => {
          for (const entry of entries) {
            if (typeof entry.title !== 'string' || !entry.title.trim()) continue
            outline.push({
              title: entry.title.trim().slice(0, 200),
              page: await resolveDestPage(entry.dest, document),
              level
            })
            if (Array.isArray(entry.items) && entry.items.length > 0) {
              await collect(entry.items, level + 1)
            }
          }
        }
        await collect(items, 1)
      }
    } catch {
      // Outline extraction is best-effort.
    }

    return {
      pages,
      outline,
      title: basename(filePath).replace(/\.pdf$/i, ''),
      // The positioned items travel with the page texts: the table extraction needs coordinates, and the
      // text path that other readers use is unaffected by carrying them.
      items: itemsPerPage,
      images: imagesPerPage,
      vectors: vectorsPerPage,
      // Pages whose coordinates were rotated back to upright, so the caller can say so instead of
      // handing back numbers that silently disagree with the page as displayed.
      pageRotations
    }
  } finally {
    await document.destroy().catch(() => undefined)
  }
}

const finiteOrZero = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

// Resolves an outline destination to a 1-indexed page number (best effort).
const resolveDestPage = async (
  dest: unknown,
  document: { getPageIndex: (ref: never) => Promise<number> }
): Promise<number> => {
  try {
    if (Array.isArray(dest) && dest.length > 0) {
      const ref = dest[0]
      if (ref && typeof ref === 'object' && 'num' in (ref as object) && 'gen' in (ref as object)) {
        const pageIndex = await document.getPageIndex(ref as never)
        return pageIndex + 1
      }
    }
  } catch {
    // Fall through to the default.
  }
  return 1
}

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1)

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'are',
  'was',
  'were',
  'have',
  'has',
  'had',
  'not',
  'but',
  'its',
  'their',
  'them',
  'they',
  'you',
  'our',
  'all',
  'can',
  'will',
  'into',
  'over',
  'than',
  'then',
  'such',
  'also',
  'using',
  'used',
  'use',
  'per',
  'via',
  'etc'
])

const bestSnippet = (page: string, terms: string[]): string => {
  const lower = page.toLowerCase()
  const targetTerms = terms.filter((term) => !STOPWORDS.has(term))
  const needles = targetTerms.length > 0 ? targetTerms : terms
  let bestIndex = -1
  for (const needle of needles) {
    const index = lower.indexOf(needle)
    if (index >= 0 && (bestIndex === -1 || index < bestIndex)) bestIndex = index
  }
  if (bestIndex === -1) return page.slice(0, PDF_SCAN_SNIPPET_CHARS)
  const start = Math.max(0, bestIndex - Math.floor(PDF_SCAN_SNIPPET_CHARS / 3))
  const snippet = page.slice(start, start + PDF_SCAN_SNIPPET_CHARS)
  return snippet.length < page.length ? `${snippet.trim()}…` : snippet.trim()
}

const isRegisteredPdf = (value: unknown): value is RegisteredPdf => {
  if (typeof value !== 'object' || value === null) return false
  const doc = value as Record<string, unknown>
  return (
    typeof doc.docId === 'string' &&
    typeof doc.projectId === 'string' &&
    typeof doc.pageCount === 'number' &&
    Array.isArray(doc.pages) &&
    doc.pages.every((page) => typeof page === 'string')
  )
}
