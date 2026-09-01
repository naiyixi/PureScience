// Shared identity + prompt contract for the agent-facing PDF-explore MCP server. This is the
// "layered PDF reading" capability: instead of streaming a whole PDF into context (or reading
// one vision page that vanishes after the turn), the agent registers a PDF once (pdf_open) —
// the main process extracts selectable text, persists it page-by-page next to the session, and
// exposes a TOC (pdf_outline), ranged page reads (pdf_pages), and a relevance-ranked page scan
// (pdf_scan). A 50-page paper becomes a ~2 KB outline + targeted page reads instead of tens of
// thousands of context tokens. Mirrors the reference product's pdf-explore skill, adapted to
// the PureScience main-process architecture (JSON-file repository + local RPC + capability
// owner, same spine as routine/endpoint/annotation).

export const PDF_MCP_SERVER_NAME = 'purescience-pdf'

export const PDF_OPEN_TOOL_NAME = 'pdf_open'
export const PDF_PAGES_TOOL_NAME = 'pdf_pages'
export const PDF_OUTLINE_TOOL_NAME = 'pdf_outline'
export const PDF_SCAN_TOOL_NAME = 'pdf_scan'

export const PDF_OPEN_TOOL_DESCRIPTION =
  'Registers a PDF for layered reading: parses the file, extracts selectable text, persists ' +
  'every page to disk, and returns a document id plus the outline summary (title, page count, ' +
  'section headings with page numbers). The PDF text persists across turns — nothing goes into ' +
  'context until you explicitly read pages with pdf_pages. path is relative to the current ' +
  'project root (or an absolute path under an authorized root). Scanned/image-only PDFs ' +
  'without a text layer yield empty pages; use pdf_scan to find where the text is.'

export const PDF_PAGES_TOOL_DESCRIPTION =
  'Returns the raw text of a page range from a registered PDF (doc_id from pdf_open). Pages ' +
  'are 1-indexed; omit end to read a single page. Use it AFTER pdf_outline/pdf_scan to read ' +
  'exactly the pages you need — each page is ~1-3 KB of text, so reading a 10-page range is ' +
  'cheap, but a whole 50-page document is not.'

export const PDF_OUTLINE_TOOL_DESCRIPTION =
  'Returns the table of contents of a registered PDF: section titles with their page numbers ' +
  '(and nesting level, when the PDF has bookmarks). Use it to decide which pages to read — ' +
  'most papers put methods at a known section, and the outline tells you where that is.'

export const PDF_SCAN_TOOL_DESCRIPTION =
  'Scans a registered PDF for pages relevant to a query and returns them ranked by term ' +
  'frequency (case-insensitive word overlap, title words weighted). Each hit shows the page ' +
  'number, a relevance score, and a snippet of the best-matching line. Use it to locate ' +
  'specific content (a dataset name, a metric, a formula term) without reading the whole document.'

// Hard bounds for a registered PDF.
export const PDF_MAX_PAGE_TEXT_CHARS = 6000 // per page (pages beyond this are truncated)
export const PDF_MAX_TOTAL_CHARS = 1_000_000 // whole-document cap (protects the repository)
export const PDF_MAX_PAGES = 500
export const PDF_SCAN_RESULT_LIMIT = 12
export const PDF_SCAN_SNIPPET_CHARS = 160

export type PdfOutlineEntry = {
  title: string
  page: number // 1-indexed
  level: number
}

export type PdfPageScanHit = {
  page: number // 1-indexed
  score: number
  snippet: string
}

// Persisted shape of one registered PDF. Stored as one JSON file under the data root; the main
// process is the single writer.
export type RegisteredPdf = {
  docId: string
  projectId: string
  // The path the agent opened (project-relative or absolute, as given).
  sourcePath: string
  title: string
  pageCount: number
  // Bookmark-derived outline (may be empty for PDFs without bookmarks).
  outline: PdfOutlineEntry[]
  // Page texts, 1-indexed (index 0 = page 1). Empty string = no extractable text on that page.
  pages: string[]
  createdAt: number
}

export type PdfOpenResult = {
  doc: {
    docId: string
    title: string
    pageCount: number
    outline: PdfOutlineEntry[]
  }
  textPageCount: number
  emptyPageCount: number
}

export type PdfPagesResult = {
  docId: string
  start: number
  end: number
  pages: { page: number; text: string }[]
}

export type PdfOutlineResult = {
  docId: string
  title: string
  pageCount: number
  outline: PdfOutlineEntry[]
}

export type PdfScanResult = {
  docId: string
  query: string
  hits: PdfPageScanHit[]
}

// Rendered into the session prompt when the PDF MCP is available.
export const PDF_MCP_SYSTEM_PROMPT_APPEND = [
  '<purescience_pdf_instructions>',
  'For PDFs (papers, reports), use the pdf_* tools for LAYERED reading instead of streaming the ' +
    'whole file: pdf_open(path) registers the document (parsed text persists across turns — it ' +
    'never enters context by itself), pdf_outline(doc_id) gives the table of contents, ' +
    'pdf_scan(doc_id, query) finds the pages relevant to what you need, and pdf_pages(doc_id, ' +
    'start, end) reads exactly those pages as text.',
  'Recommended flow: pdf_open → pdf_outline → pdf_scan for the specific content you need → ' +
    'pdf_pages to read the relevant range. Read the abstract/introduction page first, then ' +
    'jump to methods/results via the outline — do not read a 50-page PDF page-by-page.',
  'Scanned PDFs without a text layer return empty pages; if pdf_scan shows no hits and pages ' +
    'are empty, tell the user the PDF is image-only and suggest OCR.',
  '</purescience_pdf_instructions>'
].join('\n')
