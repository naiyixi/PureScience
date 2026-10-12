// Rebuilds a page's text from pdfjs runs, keeping the line structure the runs carry.
//
// Why this exists: a text layer is a list of *runs*, not lines. pdfjs marks the run that ends a line with
// `hasEOL`, and spaces arrive as their own runs. Joining every run with an empty separator (the previous
// behaviour) therefore drops every line break — a real page came out as one run-on string in which the last
// word of each line was glued to the first word of the next ("…SARS-CoV-2with an explicit…"). That is not a
// cosmetic problem: paragraph units, sentence boundaries and any per-paragraph record depend on where the
// lines actually end. A second consumer depends on it too: the text-form table extraction clusters columns on
// runs of two or more spaces inside a line, so a page flattened into one line can never yield a candidate.
//
// The reconstruction is deliberately conservative — it only re-inserts breaks, it never rewrites the runs:
//   • a run with `hasEol`, or a run whose baseline moved by more than half a line, starts a new line;
//   • a line's own spacing is kept verbatim (leading and internal whitespace included: the column clustering
//     reads it). Only the whitespace at a line *end* is dropped, because the break replaces it — which is also
//     what keeps a line join from producing a double space;
//   • consecutive lines sharing a baseline are one visual line, so they are joined without a separator (pdfjs
//     does split mid-word when the font changes, and inserting a space there would corrupt the word);
//   • a gap wider than `PDF_PAGE_TEXT_PARAGRAPH_GAP_RATIO` times the page's own line pitch is a paragraph
//     break — the pitch is measured from the page (its tightest line spacing), never assumed;
//   • lines of one paragraph are joined into a single line, paragraphs are separated by a blank line. Line-level
//     layout belongs to the renderer, which has the geometry; this text is what a paragraph record hashes.
//
// Nothing here touches node:crypto or Electron: the caller supplies the runs, this module only orders them.

export type PdfTextRun = {
  text: string
  x: number
  y: number
  width: number
  height: number
  /** pdfjs's end-of-line marker. Absent on parsers that do not report it (the baseline rule then applies). */
  hasEol?: boolean
}

/** A gap this many times the page's median line pitch or wider separates paragraphs. */
export const PDF_PAGE_TEXT_PARAGRAPH_GAP_RATIO = 1.5

/** Two runs whose baselines are this close (relative to the line height) are on the same visual line. */
export const PDF_PAGE_TEXT_LINE_TOLERANCE_RATIO = 0.5

type Line = { y: number; text: string; height: number }

const collapseSpaces = (text: string): string => text.replace(/[^\S\n]+/g, ' ').trim()

const isCjk = (character: string): boolean => /[\u3000-\u9fff\uff00-\uffef]/.test(character)

/**
 * The separator between two lines of the same paragraph. A line break between two CJK characters is a
 * typesetting break, not a word boundary, so a space there would corrupt the sentence; Latin text needs the
 * space so the last word of one line and the first word of the next do not glue together.
 */
const lineSeparator = (left: string, right: string): string => {
  const last = left.slice(-1)
  const first = right.slice(0, 1)
  // A line that already carries its own leading whitespace needs no second space, and any amount of whitespace
  // is never a word boundary that has to be re-invented.
  if (first === '' || /\s/.test(first) || /\s/.test(last)) return ''
  return isCjk(last) && isCjk(first) ? '' : ' '
}

const finiteOrZero = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

/**
 * Reads pdfjs text items into runs. This is the one place that knows an item's shape, so the callers that
 * assemble text and the callers that position it cannot drift apart. Items without a string `str` (marked
 * content) are skipped; a missing or malformed transform means "no geometry", not a guess.
 */
export const pdfTextRunsFromItems = (items: readonly unknown[]): PdfTextRun[] => {
  const runs: PdfTextRun[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const candidate = item as {
      str?: unknown
      transform?: unknown
      width?: unknown
      height?: unknown
      hasEOL?: unknown
    }
    if (typeof candidate.str !== 'string') continue
    const transform = Array.isArray(candidate.transform) ? candidate.transform : []
    runs.push({
      text: candidate.str,
      x: finiteOrZero(transform[4]),
      y: finiteOrZero(transform[5]),
      width: finiteOrZero(candidate.width),
      height: finiteOrZero(candidate.height),
      hasEol: candidate.hasEOL === true
    })
  }
  return runs
}

/**
 * Assembles one page's text from its runs. Returns an empty string for a page with no usable runs — which is a
 * fact about the page (no text layer), not an empty translation.
 */
export const assemblePdfPageText = (runs: readonly PdfTextRun[]): string => {
  const lines: Line[] = []
  let current: Line | null = null
  let lineHeight = 0

  const flush = (): void => {
    if (current === null) return
    const text = current.text.trimEnd()
    if (text.trim() !== '') lines.push({ ...current, text })
    current = null
  }

  for (const run of runs) {
    if (typeof run.text !== 'string') continue
    if (run.height > 0)
      lineHeight = lineHeight === 0 ? run.height : Math.min(lineHeight, run.height)
    const tolerance =
      (lineHeight > 0 ? lineHeight : run.height > 0 ? run.height : 1) *
      PDF_PAGE_TEXT_LINE_TOLERANCE_RATIO
    const movedLine =
      current !== null &&
      Math.abs(current.y - run.y) > tolerance &&
      run.height > 0 &&
      current.height > 0
    if (current !== null && movedLine) flush()
    if (current === null) current = { y: run.y, text: '', height: run.height }
    // The run's own text is kept even when it also carries the end-of-line marker: some parsers put the last
    // word and the break on the same run, and dropping that text would lose the word.
    current.text += run.text
    if (run.hasEol === true) flush()
  }
  flush()

  if (lines.length === 0) return ''

  // Pitch: the TIGHTEST drop between consecutive lines on different baselines. The page's own line pitch is its
  // smallest spacing by definition — a paragraph is separated by more than that — while a median would be pulled
  // up by the very paragraph gaps it is meant to detect (measured on the real fixture: 19 lines, pitch 12,
  // paragraph gaps 24).
  const heights = lines.filter((line) => line.height > 0).map((line) => line.height)
  const reference = heights.length > 0 ? Math.min(...heights) : 0
  const drops: number[] = []
  for (let index = 0; index < lines.length - 1; index += 1) {
    const drop = lines[index]!.y - lines[index + 1]!.y
    if (drop > (reference > 0 ? reference : 1) * PDF_PAGE_TEXT_LINE_TOLERANCE_RATIO)
      drops.push(drop)
  }
  const pitch = drops.length > 0 ? Math.min(...drops) : 0
  const paragraphGap =
    pitch > 0 ? pitch * PDF_PAGE_TEXT_PARAGRAPH_GAP_RATIO : Number.POSITIVE_INFINITY

  const sameLineTolerance = reference > 0 ? reference * PDF_PAGE_TEXT_LINE_TOLERANCE_RATIO : 0

  const paragraphs: string[] = []
  let paragraph = lines[0]!.text
  let previous = lines[0]!
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!
    const drop = previous.y - line.y
    if (drop > paragraphGap) {
      paragraphs.push(paragraph)
      paragraph = line.text
    } else if (drop > sameLineTolerance) {
      paragraph = `${paragraph}${lineSeparator(paragraph, line.text)}${line.text}`
    } else {
      // Same visual line: pdfjs splits a word when the font changes, so no separator belongs here.
      paragraph = `${paragraph}${line.text}`
    }
    previous = line
  }
  paragraphs.push(paragraph)

  return paragraphs.join('\n\n')
}

/**
 * Paragraphs of an assembled page, in reading order. Blank lines separate them. This is the record layer: it
 * normalises the whitespace a paragraph key is hashed over, so a re-flowed line inside a paragraph is not a
 * change.
 */
export const pdfPageTextParagraphs = (pageText: string): string[] =>
  pageText
    .split(/\n\s*\n/)
    .map((paragraph) => collapseSpaces(paragraph))
    .filter((paragraph) => paragraph !== '')
