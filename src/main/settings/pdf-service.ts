// PDF-explore persistence + parsing: the store behind pdf_open / pdf_pages / pdf_outline /
// pdf_scan. Opening a PDF parses it with pdfjs (reusing the uploads text-extraction path),
// extracts the bookmark outline, and persists the full page-text array as one JSON file under
// the data root — so a 50-page paper costs zero context until pages are explicitly read. The
// scan ranking is a lightweight term-frequency scorer (no external model), good enough to
// locate "where does this paper mention dataset X".

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type {
  PdfOpenResult,
  PdfOutlineEntry,
  PdfOutlineResult,
  PdfPageScanHit,
  PdfPagesResult,
  PdfScanResult,
  RegisteredPdf
} from '../../shared/pdf'
import {
  PDF_MAX_PAGE_TEXT_CHARS,
  PDF_MAX_PAGES,
  PDF_MAX_TOTAL_CHARS,
  PDF_SCAN_RESULT_LIMIT,
  PDF_SCAN_SNIPPET_CHARS
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

export type PdfServiceOptions = {
  storageRoot: string
  // Resolves a project-relative or absolute path to an on-disk file path. Absent ⇒ relative
  // paths resolve against storageRoot.
  resolvePath?: (path: string) => Promise<string | undefined>
  // Injectable PDF parser (tests); defaults to the pdfjs implementation.
  parsePdf?: (
    filePath: string
  ) => Promise<{ pages: string[]; outline: PdfOutlineEntry[]; title: string }>
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

  // Opens (parses + persists) a PDF. Returns the outline-level summary; page text stays on disk.
  async open(path: string, projectId = ''): Promise<PdfOpenResult> {
    const resolved = await this.resolveSourcePath(path)
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
const parsePdf = async (
  filePath: string
): Promise<{ pages: string[]; outline: PdfOutlineEntry[]; title: string }> => {
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
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      page.cleanup()
      const pageText = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join('')
        .trim()
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
      title: basename(filePath).replace(/\.pdf$/i, '')
    }
  } finally {
    await document.destroy().catch(() => undefined)
  }
}

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
