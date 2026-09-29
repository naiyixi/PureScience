import { isBookmarkRect } from './bookmark'
import type {
  PdfAnnotationAnchorState,
  PdfAnnotationKind,
  PdfAnnotationSelector
} from './pdf-annotations'

// Exporting a file version's annotations (文档标注层 A4), as TWO INDEPENDENT CHANNELS:
//
//   * `annotated-pdf` — the markup of one file version is written into a COPY of that version's bytes.
//     The copy is what carries the markup; the file version the reader annotated is opened for READING
//     and is never opened for writing. That is the red line this module is built around;
//   * `notes` — a plain-text list of the same annotations (kind, page, the passage quoted, the version
//     each one was drawn on), written as its own file and producing no PDF at all.
//
// The two channels share nothing but the read they start from: each one is triggered on its own, lands
// its own artifact on disk, and neither is a precondition of the other.
//
// Everything in this module is pure and renderer-safe — no node builtins, no pdfjs — so the two rules
// that matter are assertable without a window, a file system or a database:
//
//   1. the annotated copy is built by APPENDING an incremental update section to the version's bytes.
//      The source bytes become the first bytes of the copy, unchanged; the update adds the annotation
//      dictionaries and re-states the page dictionaries that reference them. Nothing is ever spliced
//      into the middle of the source, so a copy can never be mistaken for an in-place rewrite;
//   2. what cannot be carried across is NAMED rather than dropped. An annotation drawn on other bytes,
//      a document-level note (it names no page), a page the file rotates (its coordinates would land
//      elsewhere) and a page whose dictionary cannot be re-stated are all counted and reported with a
//      reason, so "burned 7 of 9" is a statement a reader can act on.

// --- the two channels ------------------------------------------------------------------------------

export const PDF_ANNOTATION_EXPORT_CHANNELS = ['annotated-pdf', 'notes'] as const
export type PdfAnnotationExportChannel = (typeof PDF_ANNOTATION_EXPORT_CHANNELS)[number]

export const isPdfAnnotationExportChannel = (value: string): value is PdfAnnotationExportChannel =>
  (PDF_ANNOTATION_EXPORT_CHANNELS as readonly string[]).includes(value)

/**
 * Where an export came from — the facts that tie a file on disk back to the annotation store.
 *
 * The version id and the content checksum are the SAME pair the annotations are anchored by (A1), which
 * is what makes an exported file answerable: "these notes are the annotations of THESE bytes" is a
 * checkable claim, and an export whose checksum does not match the version it names is a defect rather
 * than a judgement call.
 */
export type PdfAnnotationExportProvenance = {
  projectId: string
  sessionId: string
  sourceFileId: string
  versionId: string
  /** The version's content checksum, as the version authority recorded it (sha256 hex, lowercase). */
  checksum: string
  exportedAt: number
}

// --- what an export answers with --------------------------------------------------------------------

// A refusal is a value rather than a throw: every one of these is something the reader has to be told in
// the same panel, and a channel that wrote nothing must never look like a channel that wrote.
export const PDF_ANNOTATION_EXPORT_FAILURE_CODES = [
  'missing-anchor', // the request named no file version to export from
  'checksum-mismatch', // the bytes on disk are not the version the request named
  'unreadable-source', // the version's file could not be read
  'not-a-pdf', // the bytes are not a PDF at all
  'unsupported-pdf-structure', // a PDF this build cannot append to (no classic cross-reference table)
  'nothing-to-export', // this version carries no annotation of its own to write
  'source-changed', // the version's file no longer hashes to what it did before the export
  'write-failed' // the destination could not be written
] as const
export type PdfAnnotationExportFailureCode = (typeof PDF_ANNOTATION_EXPORT_FAILURE_CODES)[number]

export type PdfAnnotationCopyRefusal = {
  status: 'refused'
  code: PdfAnnotationExportFailureCode
  message: string
}

/** One kind and how many annotations of it a channel carried. */
export type PdfAnnotationExportKindCount = { kind: PdfAnnotationKind; count: number }

/**
 * The name stamped into a copy as the author of its annotation dictionaries. An exported PDF that is
 * opened a year later says where its markup came from, not just that it has some.
 */
export const PDF_ANNOTATION_EXPORT_AUTHOR = 'PureScience'

const pad = (value: number): string => String(value).padStart(2, '0')

/** `D:YYYYMMDDHHmmSSZ` — the PDF date form, UTC, as the spec defines it. */
export const pdfDateStamp = (timestamp: number): string => {
  const at = new Date(timestamp)
  return (
    `D:${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`
  )
}

// --- byte helpers: latin1 is the identity mapping, on purpose ---------------------------------------

// The bytes are scanned as one character per byte. `TextDecoder('latin1')` is NOT used: the WHATWG
// label resolves to windows-1252, which maps 0x80..0x9F onto punctuation — a page dictionary carrying
// one of those bytes would come back out of a round trip with a different byte in it. This mapping is
// the byte value itself, so any slice decoded here re-encodes to exactly the bytes it came from.
const DECODE_CHUNK = 8192

export const decodeLatin1 = (bytes: Uint8Array): string => {
  let text = ''
  for (let start = 0; start < bytes.length; start += DECODE_CHUNK) {
    text += String.fromCharCode(...bytes.subarray(start, start + DECODE_CHUNK))
  }
  return text
}

export const encodeLatin1 = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff
  return bytes
}

// --- the burn plan -----------------------------------------------------------------------------------

/**
 * Why one annotation is not written into the copy. Named, and reported with a count, because a copy
 * that quietly carries eight of nine markups is the failure this list exists to prevent.
 */
export const PDF_ANNOTATION_BURN_SKIP_REASONS = [
  'another-version', // anchored to other bytes: it was never drawn on the bytes being copied
  'document-level', // a document note names no page, so there is no page to attach it to
  'unknown-page', // it names a page this file does not have
  'rotated-page', // the page is displayed rotated, so the coordinates would land elsewhere
  'degenerate-geometry', // its shape has no extent on the page, so it would mark nothing
  'unplaceable-page' // the page's dictionary could not be re-stated with the markup attached
] as const
export type PdfAnnotationBurnSkipReason = (typeof PDF_ANNOTATION_BURN_SKIP_REASONS)[number]

export type PdfAnnotationBurnSkip = {
  reason: PdfAnnotationBurnSkipReason
  count: number
  /** The first occurrence's explanation, in full: what was left out and why. */
  detail: string
}

/** One page as this file states it: the box the reader sees, and the object holding its dictionary. */
export type PdfPageGeometry = {
  /** 1-based, in the order the page tree lists them. */
  number: number
  width: number
  height: number
  rotate: number
  /** The object number of the page dictionary — the object an incremental update has to re-state. */
  objectNumber: number
  generation: number
}

/** What one annotation becomes: which page, and the dictionary that carries it. */
export type PdfAnnotationBurnEntry = {
  kind: PdfAnnotationKind
  page: number
  /** The annotation dictionary, WITHOUT the enclosing `<<` `>>`. */
  objectBody: string
}

export type PdfAnnotationBurnPlan = {
  /** The annotations of this file version, of which `burnedCount` will be written into the copy. */
  considered: number
  burnedCount: number
  burned: readonly PdfAnnotationBurnEntry[]
  kinds: readonly PdfAnnotationExportKindCount[]
  skipped: readonly PdfAnnotationBurnSkip[]
}

/**
 * An annotation as the burn decides about it: its kind, its selector, its text, and how its anchor
 * compares to the version being copied. Structurally the same shape the annotation surface reads, so
 * the main process passes its own read straight through.
 */
export type PdfAnnotationBurnCandidate = {
  kind: PdfAnnotationKind
  selector: PdfAnnotationSelector
  body: string
  anchorState: PdfAnnotationAnchorState
}

// The /Subtype each of our kinds is written as — the same vocabulary the import channel reads, so a copy
// this channel writes is a file the import can read back. A document note has no page and therefore no
// subtype in a copy: it is reported as `document-level` rather than attached to page one.
export const PDF_ANNOTATION_KIND_SUBTYPES: Readonly<Record<PdfAnnotationKind, string>> = {
  highlight: 'Highlight',
  underline: 'Underline',
  squiggly: 'Squiggly',
  strikethrough: 'StrikeOut',
  area: 'Square',
  'page-note': 'Text',
  'document-note': 'Text'
}

// The colour each kind is drawn in. Fixed per kind rather than carried on the annotation: a reader
// opening two copies sees the same convention for the same kind, and no colour is invented at export.
const KIND_COLOURS: Readonly<Record<PdfAnnotationKind, readonly [number, number, number]>> = {
  highlight: [1, 0.85, 0],
  underline: [0.8, 0.1, 0.1],
  squiggly: [0.8, 0.45, 0],
  strikethrough: [0.25, 0.25, 0.25],
  area: [0.1, 0.45, 0.9],
  'page-note': [0.9, 0.75, 0.1],
  'document-note': [0.9, 0.75, 0.1]
}

// The annotation flag every burned markup carries: Print (bit 3). Without it the markup is on screen but
// missing from anything printed, which is not what "the markup is in the file" should mean.
const PRINTABLE_FLAG = 4

// A page note with no placed anchor needs somewhere to sit: the top-right corner of the page, where a
// reader's own app puts an unplaced sticky note.
const NOTE_FALLBACK_PT = 22

const round2 = (value: number): number => Math.round(value * 100) / 100

const pdfNumber = (value: number): string => {
  const rounded = round2(value)
  if (rounded === 0) return '0'
  const text = String(rounded)
  // `String` reaches for exponential notation below 1e-6, which is not a PDF number.
  return text.includes('e') ? rounded.toFixed(2) : text
}

const pdfArray = (values: readonly number[]): string => `[${values.map(pdfNumber).join(' ')}]`

/**
 * A PDF string. Printable ASCII goes in as a literal with the three characters that would end or nest
 * one escaped; anything else is written as UTF-16BE in a hex string with the byte-order mark, which is
 * the only form in which a note written in Chinese, Greek or Arabic survives a viewer that reads the
 * file without a font map. A quote taken off a paper's own text layer reaches here often enough that
 * guessing would be a defect rather than a nicety.
 */
export const pdfString = (value: string): string => {
  let ascii = true
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code > 0x7e) {
      ascii = false
      break
    }
  }

  if (ascii) {
    return `(${value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')})`
  }

  let hex = 'feff'
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint > 0xffff) {
      const offset = codePoint - 0x10000
      hex += (0xd800 + (offset >> 10)).toString(16).padStart(4, '0')
      hex += (0xdc00 + (offset & 0x3ff)).toString(16).padStart(4, '0')
      continue
    }
    hex += codePoint.toString(16).padStart(4, '0')
  }
  return `<${hex}>`
}

// The page box in user space (points, origin bottom-left) a normalized 0..1 rectangle maps onto.
// `BookmarkRect` is measured from the TOP-LEFT of the displayed page — the coordinate every PDF surface
// in this app already uses — so the y axis flips exactly once, here.
const userSpaceBox = (
  rect: { x: number; y: number; width: number; height: number },
  page: PdfPageGeometry
): readonly [number, number, number, number] => [
  round2(rect.x * page.width),
  round2(page.height - (rect.y + rect.height) * page.height),
  round2((rect.x + rect.width) * page.width),
  round2(page.height - rect.y * page.height)
]

// One quadrilateral per rectangle, in the corner order the spec lists for /QuadPoints.
const quadPointsOf = (
  rects: readonly { x: number; y: number; width: number; height: number }[],
  page: PdfPageGeometry
): number[] =>
  rects.flatMap((rect) => {
    const [x1, y1, x2, y2] = userSpaceBox(rect, page)
    // (upper-left, upper-right, lower-left, lower-right): in user space y1 is the LOWER edge, so the
    // "upper" corners are the ones carrying y2.
    return [x1, y2, x2, y2, x1, y1, x2, y1]
  })

const isPositivePage = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1

const note = (
  reason: PdfAnnotationBurnSkipReason,
  detail: string,
  skipped: Map<PdfAnnotationBurnSkipReason, PdfAnnotationBurnSkip>
): void => {
  const existing = skipped.get(reason)
  skipped.set(
    reason,
    existing ? { ...existing, count: existing.count + 1 } : { reason, count: 1, detail }
  )
}

/**
 * Decides, for one file version's annotations, what a copy of that version will carry and what it will
 * not.
 *
 * The first rule is the one that keeps the anchor meaningful: only an annotation whose anchor state is
 * `current` is written. An annotation drawn on an earlier version of the file is NOT placed on these
 * bytes — the rectangle would be a guess about a layout that changed underneath it — and it is reported
 * as `another-version` rather than moved. The reader's own handling path for that state (re-anchor it,
 * or export the version it belongs to) is the one the panel already offers.
 */
export const planPdfAnnotationBurn = (input: {
  annotations: readonly PdfAnnotationBurnCandidate[]
  pages: readonly PdfPageGeometry[]
  /** Stamped on the dictionaries; passed in so the plan is a pure function of its inputs. */
  exportedAt: number
}): PdfAnnotationBurnPlan => {
  const pagesByNumber = new Map(input.pages.map((page) => [page.number, page]))
  const skipped = new Map<PdfAnnotationBurnSkipReason, PdfAnnotationBurnSkip>()
  const burned: PdfAnnotationBurnEntry[] = []
  const kindCounts = new Map<PdfAnnotationKind, number>()

  for (const annotation of input.annotations) {
    const kind = annotation.kind

    if (annotation.anchorState !== 'current') {
      note(
        'another-version',
        `This annotation is anchored to other bytes than the version being exported (${annotation.anchorState}), so it was not written into the copy: a region drawn on different bytes is not the same region. Export the version it was drawn on, or re-anchor it on this one first.`,
        skipped
      )
      continue
    }

    if (kind === 'document-note') {
      note(
        'document-level',
        'A "document-note" names the document rather than a page, so a copy of one version has no page to attach it to; its text is carried by the notes channel instead.',
        skipped
      )
      continue
    }

    const selector = annotation.selector as unknown as Record<string, unknown>
    const page = isPositivePage(selector.page) ? pagesByNumber.get(selector.page) : undefined
    if (!page) {
      note(
        'unknown-page',
        `A "${kind}" names page ${String(selector.page)}, which this file does not have; it was not written into the copy.`,
        skipped
      )
      continue
    }

    if (page.rotate % 360 !== 0) {
      note(
        'rotated-page',
        `Page ${page.number} is displayed rotated ${page.rotate}°, so the stored coordinates would land somewhere other than where they were drawn; the markup was left out rather than placed by guesswork.`,
        skipped
      )
      continue
    }

    const dictionary = annotationDictionary({
      annotation,
      kind,
      selector,
      page,
      exportedAt: input.exportedAt
    })
    if (!dictionary) {
      note(
        'degenerate-geometry',
        `A "${kind}" on page ${page.number} has no measurable extent on the page, so it would mark nothing in the copy.`,
        skipped
      )
      continue
    }

    burned.push({ kind, page: page.number, objectBody: dictionary })
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1)
  }

  return {
    considered: input.annotations.length,
    burnedCount: burned.length,
    burned,
    kinds: [...kindCounts.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind)),
    skipped: PDF_ANNOTATION_BURN_SKIP_REASONS.filter((reason) => skipped.has(reason)).map(
      (reason) => skipped.get(reason)!
    )
  }
}

// One annotation's dictionary, or undefined when its shape has no extent on the page.
const annotationDictionary = (input: {
  annotation: PdfAnnotationBurnCandidate
  kind: PdfAnnotationKind
  selector: Record<string, unknown>
  page: PdfPageGeometry
  exportedAt: number
}): string | undefined => {
  const { annotation, kind, selector, page } = input
  const subtype = PDF_ANNOTATION_KIND_SUBTYPES[kind]
  const author = ` /T ${pdfString(PDF_ANNOTATION_EXPORT_AUTHOR)} /M (${pdfDateStamp(input.exportedAt)})`
  const head = `/Type /Annot /Subtype /${subtype} /F ${PRINTABLE_FLAG} /C ${pdfArray(KIND_COLOURS[kind])}`
  const body = annotation.body.trim()
  const comment = body === '' ? '' : ` /Contents ${pdfString(body)}`

  if (kind === 'page-note') {
    // A note with no text annotates nothing; the store refuses one, so a copy must not invent it.
    if (body === '') return undefined
    const anchorRect = selector.anchorRect
    const rect = isBookmarkRect(anchorRect)
      ? userSpaceBox(anchorRect, page)
      : ([
          page.width - NOTE_FALLBACK_PT - 8,
          page.height - NOTE_FALLBACK_PT - 8,
          page.width - 8,
          page.height - 8
        ] as const)
    return `${head} /Name /Comment /Rect ${pdfArray(rect)}${comment}${author}`
  }

  if (kind === 'area') {
    const rect = selector.rect
    if (!isBookmarkRect(rect)) return undefined
    return `${head} /Rect ${pdfArray(userSpaceBox(rect, page))}${comment}${author}`
  }

  const rects = Array.isArray(selector.rects)
    ? selector.rects.filter((rect) => isBookmarkRect(rect))
    : []
  if (rects.length === 0) return undefined
  const quote = typeof selector.quote === 'string' ? selector.quote : ''

  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  const bounding = userSpaceBox(
    { x: left, y: top, width: right - left, height: bottom - top },
    page
  )
  // The quoted passage rides along as the annotation's own comment when the reader wrote none: a
  // highlight whose text is nowhere in the copy is one nobody can search for later.
  const contents = comment === '' ? ` /Contents ${pdfString(quote)}` : comment
  return (
    `${head} /Rect ${pdfArray(bounding)} /QuadPoints ${pdfArray(quadPointsOf(rects, page))}` +
    `${contents}${author}`
  )
}

// --- reading the structure an incremental update appends to -----------------------------------------

type PdfObject = { objectNumber: number; generation: number; body: string }

type PdfIndex = {
  pages: readonly PdfPageGeometry[]
  text: string
  /** Object number → byte offset, from the file's own cross-reference table. */
  offsets: ReadonlyMap<number, number>
  /** One past the highest object number the ORIGINAL file declares. */
  size: number
  root: { objectNumber: number; generation: number }
  previousStartXref: number
  /**
   * The trailer entries an incremental update has to carry forward, verbatim.
   *
   * A new trailer REPLACES the one before it as far as a reader is concerned: `/Info` left out here is
   * metadata the copy LOSES (title, author, producer), and a copy that quietly drops a paper's own title
   * is not a copy of it. `/ID` is carried for the same reason — a reader that matches documents by their
   * file identifier would otherwise treat the copy as a different document.
   */
  carriedTrailerEntries: string
}

const START_XREF = /startxref\s+(\d+)/g
const TRAILER_ROOT = /\/Root\s+(\d+)\s+(\d+)\s+R/
const TRAILER_SIZE = /\/Size\s+(\d+)/
const TRAILER_INFO = /\/Info\s+(\d+)\s+(\d+)\s+R/
const TRAILER_ID = /\/ID\s*(\[[^\]]*\])/
const TRAILER_ENCRYPT = /\/Encrypt\b/
const OBJECT_HEAD = /^(\d+)\s+(\d+)\s+obj\b/
const KIDS_ARRAY = /\/Kids\s*\[([^\]]*)\]/
/** The catalogue's pointer to the page tree root — the step from /Root into the pages themselves. */
const PAGES_REFERENCE = /\/Pages\s+(\d+)\s+(\d+)\s+R/
const INDIRECT_REFERENCE = /(\d+)\s+(\d+)\s+R/g
const MEDIA_BOX = /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/
const CROP_BOX = /\/CropBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/
const ROTATE = /\/Rotate\s+(-?\d+)/

/** The last `startxref` value: the entry point every incremental update has to chain from. */
const lastStartXref = (text: string): number | undefined => {
  let found: number | undefined
  for (const match of text.matchAll(START_XREF)) found = Number(match[1])
  return found !== undefined && Number.isFinite(found) ? found : undefined
}

const refusal = (
  code: PdfAnnotationExportFailureCode,
  message: string
): PdfAnnotationCopyRefusal => ({ status: 'refused', code, message })

/**
 * Reads the classic cross-reference table an incremental update appends to, then walks the page tree.
 *
 * A file whose cross-reference is a STREAM (the form PDF 1.5 and later write) is refused by NAME rather
 * than guessed at: appending a classic table that chains onto a stream is not something this build can
 * do correctly, and a copy that opens in some readers and not others is worse than a refusal a reader
 * can act on.
 */
const readIndex = (bytes: Uint8Array): PdfIndex | PdfAnnotationCopyRefusal => {
  const text = decodeLatin1(bytes)
  if (!text.startsWith('%PDF-')) {
    return refusal(
      'not-a-pdf',
      'These bytes do not begin with a PDF header, so no annotated copy can be made of them.'
    )
  }

  const previousStartXref = lastStartXref(text)
  if (previousStartXref === undefined) {
    return refusal(
      'unreadable-source',
      'This PDF carries no startxref, so its cross-reference table cannot be located and no annotation can be appended to it.'
    )
  }

  const offsets = new Map<number, number>()
  let cursor = previousStartXref
  if (!/^\s*xref\b/.test(text.slice(cursor, cursor + 8))) {
    return refusal(
      'unsupported-pdf-structure',
      'This PDF does not carry a classic cross-reference table (its cross-reference is written as a stream, which is the form PDF 1.5 and later use), so an annotated copy was not attempted.'
    )
  }

  cursor += text.slice(cursor).indexOf('xref') + 4
  for (;;) {
    if (/^\s*trailer\b/.test(text.slice(cursor))) break
    const header = /^\s*(\d+)\s+(\d+)\s*/.exec(text.slice(cursor))
    if (!header) break
    const first = Number(header[1])
    const count = Number(header[2])
    cursor += header[0].length
    for (let index = 0; index < count; index += 1) {
      const entry = /^\s*(\d{1,10})\s+(\d{1,5})\s+([nf])\s*/.exec(text.slice(cursor))
      if (!entry) {
        return refusal(
          'unsupported-pdf-structure',
          `The cross-reference table of this PDF is damaged at entry ${first + index}, so nothing was appended to it.`
        )
      }
      if (entry[3] === 'n') offsets.set(first + index, Number(entry[1]))
      cursor += entry[0].length
    }
  }

  if (offsets.size === 0) {
    return refusal(
      'unsupported-pdf-structure',
      'This PDF does not carry a classic cross-reference table, so an annotated copy was not attempted.'
    )
  }

  const trailerAt = text.indexOf('trailer', cursor)
  const trailerText = text.slice(trailerAt < 0 ? cursor : trailerAt)
  const root = TRAILER_ROOT.exec(trailerText)
  if (!root) {
    return refusal(
      'unsupported-pdf-structure',
      'This PDF\u2019s trailer names no document catalogue (/Root), so its page tree cannot be walked and an annotated copy was not attempted.'
    )
  }

  const readObject = (objectNumber: number): PdfObject | undefined => {
    const offset = offsets.get(objectNumber)
    if (offset === undefined) return undefined
    const head = OBJECT_HEAD.exec(text.slice(offset))
    if (!head || Number(head[1]) !== objectNumber) return undefined
    const bodyStart = offset + head[0].length
    const bodyEnd = text.indexOf('endobj', bodyStart)
    if (bodyEnd < 0) return undefined
    return {
      objectNumber,
      generation: Number(head[2]),
      body: text.slice(bodyStart, bodyEnd).trim()
    }
  }

  // The page tree, walked the way any reader walks it: a page box and a rotation set on a parent /Pages
  // node are INHERITED by its children, and the order of /Kids is the page order. A node that is neither
  // a /Kids container nor the catalogue's /Pages pointer is a page — /Type /Page is optional in the
  // wild, so it is not what decides.
  const pages: PdfPageGeometry[] = []
  const visited = new Set<number>()
  const walk = (
    objectNumber: number,
    generation: number,
    inherited: { box: RegExpExecArray | null; rotate: number },
    depth: number
  ): void => {
    if (depth > 32 || visited.has(objectNumber) || pages.length > 20_000) return
    visited.add(objectNumber)
    const object = readObject(objectNumber)
    if (!object) return

    // CropBox wins over MediaBox: that is the box a reader displays, and the box the renderer's own page
    // view uses, so a normalized rectangle means the same thing on both sides of the export.
    const box = CROP_BOX.exec(object.body) ?? MEDIA_BOX.exec(object.body) ?? inherited.box ?? null
    const rotate = Number(ROTATE.exec(object.body)?.[1] ?? inherited.rotate)

    const kids = KIDS_ARRAY.exec(object.body)
    if (kids) {
      for (const reference of kids[1]!.matchAll(INDIRECT_REFERENCE)) {
        walk(Number(reference[1]), Number(reference[2]), { box, rotate }, depth + 1)
      }
      return
    }

    const pagesReference = PAGES_REFERENCE.exec(object.body)
    if (pagesReference) {
      walk(Number(pagesReference[1]), Number(pagesReference[2]), { box, rotate }, depth + 1)
      return
    }

    pages.push({
      number: pages.length + 1,
      width: box ? Math.abs(Number(box[3]) - Number(box[1])) : 0,
      height: box ? Math.abs(Number(box[4]) - Number(box[2])) : 0,
      rotate: Number.isFinite(rotate) ? rotate : 0,
      objectNumber,
      generation
    })
  }

  walk(Number(root[1]), Number(root[2]), { box: null, rotate: 0 }, 0)
  if (pages.length === 0) {
    return refusal(
      'unsupported-pdf-structure',
      'This PDF\u2019s page tree yielded no pages, so there is nothing to attach an annotation to.'
    )
  }

  // Encryption is refused rather than worked around: appending plaintext annotation objects to an
  // encrypted file produces a document whose new objects are not protected the way the rest of it is —
  // a copy that opens in some readers and not others, and one nobody can tell is half-encrypted.
  if (TRAILER_ENCRYPT.test(trailerText)) {
    return refusal(
      'unsupported-pdf-structure',
      'This PDF is encrypted, so an annotation was not appended to it: the appended objects would not carry the file\u2019s protection, and a half-encrypted copy is worse than none.'
    )
  }

  let highest = 0
  for (const objectNumber of offsets.keys()) highest = Math.max(highest, objectNumber)
  const declared = Number(TRAILER_SIZE.exec(trailerText)?.[1] ?? 0)

  const info = TRAILER_INFO.exec(trailerText)
  const id = TRAILER_ID.exec(trailerText)
  const carriedTrailerEntries = `${info ? ` /Info ${info[1]} ${info[2]} R` : ''}${id ? ` /ID ${id[1]}` : ''}`

  return {
    pages,
    text,
    offsets,
    size: Math.max(declared, highest + 1),
    root: { objectNumber: Number(root[1]), generation: Number(root[2]) },
    previousStartXref,
    carriedTrailerEntries
  }
}

const locateObject = (index: PdfIndex, objectNumber: number): PdfObject | undefined => {
  const offset = index.offsets.get(objectNumber)
  if (offset === undefined) return undefined
  const head = OBJECT_HEAD.exec(index.text.slice(offset))
  if (!head || Number(head[1]) !== objectNumber) return undefined
  const bodyStart = offset + head[0].length
  const bodyEnd = index.text.indexOf('endobj', bodyStart)
  if (bodyEnd < 0) return undefined
  return {
    objectNumber,
    generation: Number(head[2]),
    body: index.text.slice(bodyStart, bodyEnd).trim()
  }
}

/** The pages of one version's bytes, in reading order — what a burn plan is decided against. */
export const readPdfPageGeometry = (
  bytes: Uint8Array
): { status: 'read'; pages: readonly PdfPageGeometry[] } | PdfAnnotationCopyRefusal => {
  const index = readIndex(bytes)
  if ('status' in index) return index
  return { status: 'read', pages: index.pages }
}

/**
 * Re-states one page dictionary with its markup attached. An existing /Annots array is APPENDED to,
 * never replaced: a source PDF that carries its own markup (the import channel exists for those) keeps
 * every annotation it already had, so the copy is a superset of the file rather than a replacement of
 * part of it. An /Annots written as a reference to an array object is refused by name — re-stating it
 * would mean rewriting that object too, which this build does not do.
 */
const attachAnnots = (body: string, references: readonly number[]): string | undefined => {
  const closeAt = body.lastIndexOf('>>')
  if (closeAt < 0) return undefined
  const list = references.map((number) => `${number} 0 R`).join(' ')
  const at = body.indexOf('/Annots')
  if (at < 0) return `${body.slice(0, closeAt)}/Annots [${list}] ${body.slice(closeAt)}`

  const open = body.indexOf('[', at)
  const close = open < 0 ? -1 : body.indexOf(']', open)
  if (open < 0 || close < 0) return undefined
  const separator = body.slice(open + 1, close).trim() === '' ? '' : ' '
  return `${body.slice(0, close)}${separator}${list} ${body.slice(close)}`
}

// Writes the appended section while tracking the byte offset of every object it emits — the numbers the
// new cross-reference section needs. Offsets are counted as bytes rather than characters because the
// page dictionaries being re-stated come from the source verbatim.
class ByteWriter {
  private readonly chunks: Uint8Array[] = []
  private readonly offsets = new Map<number, { offset: number; generation: number }>()
  length = 0

  push(chunk: string): number {
    const bytes = encodeLatin1(chunk)
    const offset = this.length
    this.chunks.push(bytes)
    this.length += bytes.length
    return offset
  }

  record(objectNumber: number, generation: number, offset: number): void {
    this.offsets.set(objectNumber, { offset, generation })
  }

  entries(): Array<[number, { offset: number; generation: number }]> {
    return [...this.offsets.entries()].sort(([left], [right]) => left - right)
  }

  collect(): Uint8Array {
    const out = new Uint8Array(this.length)
    let at = 0
    for (const chunk of this.chunks) {
      out.set(chunk, at)
      at += chunk.length
    }
    return out
  }
}

export type PdfAnnotationCopyResult =
  | {
      status: 'written'
      bytes: Uint8Array
      burned: PdfAnnotationBurnPlan
      pageCount: number
      /** The version's own bytes, copied verbatim, at the head of the copy. */
      sourceBytes: number
      appendedBytes: number
    }
  | PdfAnnotationCopyRefusal

/**
 * Builds the annotated copy: the version's own bytes, then an incremental update that adds one
 * annotation object per burned markup and re-states the page dictionaries that reference them.
 *
 * The source array is READ and never written to, and its bytes appear verbatim at the head of the copy.
 * Both facts are asserted where it counts rather than trusted: the export service hashes the version's
 * file before and after the copy is written and refuses to report success if the two differ.
 */
export const buildAnnotatedPdfCopy = (input: {
  source: Uint8Array
  annotations: readonly PdfAnnotationBurnCandidate[]
  exportedAt: number
}): PdfAnnotationCopyResult => {
  const index = readIndex(input.source)
  if ('status' in index) return index

  const plan = planPdfAnnotationBurn({
    annotations: input.annotations,
    pages: index.pages,
    exportedAt: input.exportedAt
  })
  if (plan.burnedCount === 0) {
    return refusal(
      'nothing-to-export',
      plan.skipped.length > 0
        ? `No annotation of this version can be written into a copy: ${plan.skipped
            .map((entry) => `${entry.reason} ×${entry.count}`)
            .join(', ')}.`
        : 'This version carries no annotations, so there is nothing to write into a copy.'
    )
  }

  const writer = new ByteWriter()
  // The appended section starts on a fresh line: the source may end without one, and where the version's
  // own bytes stop has to be visible.
  writer.push('\n')

  const refsByPage = new Map<number, number[]>()
  // Object numbers continue after the file's own, so nothing the source declares is shadowed.
  let nextObjectNumber = index.size + 1
  for (const entry of plan.burned) {
    const objectNumber = nextObjectNumber
    nextObjectNumber += 1
    const offset = writer.push(`${objectNumber} 0 obj\n`)
    writer.push(`<< ${entry.objectBody} >>\nendobj\n`)
    writer.record(objectNumber, 0, offset)
    refsByPage.set(entry.page, [...(refsByPage.get(entry.page) ?? []), objectNumber])
  }

  for (const page of index.pages) {
    const references = refsByPage.get(page.number)
    if (!references || references.length === 0) continue
    const object = locateObject(index, page.objectNumber)
    const updated = object ? attachAnnots(object.body, references) : undefined
    if (!object || !updated) {
      return refusal(
        'unsupported-pdf-structure',
        `Page ${page.number}\u2019s dictionary could not be re-stated with the markup attached, so no copy was made rather than one whose markup is not on the page.`
      )
    }
    const offset = writer.push(`${page.objectNumber} ${object.generation} obj\n`)
    writer.push(`${updated}\nendobj\n`)
    writer.record(page.objectNumber, object.generation, offset)
  }

  const xrefOffset = writer.push('xref\n')
  const entries = writer.entries()
  // Subsections of CONSECUTIVE object numbers, ascending — the shape a reader expects, and the shape
  // under which a file that appends twice stays readable.
  let runStart = 0
  while (runStart < entries.length) {
    let runEnd = runStart
    while (runEnd + 1 < entries.length && entries[runEnd + 1]![0] === entries[runEnd]![0] + 1) {
      runEnd += 1
    }
    writer.push(`${entries[runStart]![0]} ${runEnd - runStart + 1}\n`)
    for (let index2 = runStart; index2 <= runEnd; index2 += 1) {
      const entry = entries[index2]![1]
      writer.push(
        `${String(entry.offset).padStart(10, '0')} ${String(entry.generation).padStart(5, '0')} n \n`
      )
    }
    runStart = runEnd + 1
  }

  writer.push(
    `trailer\n<< /Size ${nextObjectNumber} /Root ${index.root.objectNumber} ${index.root.generation} R${index.carriedTrailerEntries} /Prev ${index.previousStartXref} >>\n`
  )
  writer.push(`startxref\n${xrefOffset}\n%%EOF\n`)

  const appended = writer.collect()
  const copy = new Uint8Array(input.source.length + appended.length)
  copy.set(input.source, 0)
  copy.set(appended, input.source.length)

  return {
    status: 'written',
    bytes: copy,
    burned: plan,
    pageCount: index.pages.length,
    sourceBytes: input.source.length,
    appendedBytes: appended.length
  }
}

// --- the notes channel ---------------------------------------------------------------------------------

/** One annotation as the notes file lists it. */
export type PdfAnnotationNotesEntry = {
  kind: PdfAnnotationKind
  /** Absent for a document note, which names the document rather than a page. */
  page?: number
  /** The file version this one was drawn on — the anchor, written into the file itself. */
  versionId: string
  /** The passage it quotes (a text markup) or the text it carries (a note). */
  text: string
  /** The reader's own comment, when the markup carries one. */
  body: string
  anchorState: PdfAnnotationAnchorState
}

export type PdfAnnotationNotes = {
  text: string
  /** Lines written, so a caller can state the size of what it wrote. */
  lines: number
  /** Lines that list one annotation: the count that has to match the store. */
  entryLines: number
}

/**
 * The `notes` channel: a plain-text list of one file's annotations, with the provenance that ties it
 * back to the store.
 *
 * Deliberately a list rather than a PDF: this is the channel for taking the markup OUT of the reader —
 * into a review note, a diff, a commit message — and it writes no PDF at all. Every entry names its
 * kind, its page, the version it was drawn on and how that anchor stands against the version being
 * exported, so a note belonging to other bytes is visible in the file rather than quietly missing.
 */
export const buildPdfAnnotationNotes = (input: {
  provenance: PdfAnnotationExportProvenance
  /** The annotations of the FILE, oldest first — the same set the surface lists. */
  entries: readonly PdfAnnotationNotesEntry[]
}): PdfAnnotationNotes => {
  const { provenance } = input
  const lines: string[] = [
    'PureScience PDF annotation notes',
    `project: ${provenance.projectId}`,
    `session: ${provenance.sessionId}`,
    `file: ${provenance.sourceFileId}`,
    `version: ${provenance.versionId}`,
    `checksum: sha256:${provenance.checksum}`,
    `exported-at: ${new Date(provenance.exportedAt).toISOString()}`,
    `annotations: ${input.entries.length}`,
    ''
  ]

  input.entries.forEach((entry, index) => {
    lines.push(
      `[${index + 1}] ${entry.kind} · page ${entry.page ?? '-'} · version ${entry.versionId} · ${entry.anchorState}`
    )
    lines.push(`    text: ${entry.text.replaceAll('\n', ' ').trim()}`)
    if (entry.body.trim() !== '') lines.push(`    note: ${entry.body.replaceAll('\n', ' ').trim()}`)
  })

  return {
    text: `${lines.join('\n')}\n`,
    lines: lines.length,
    entryLines: input.entries.length
  }
}

/** True when an exported name carries the PDF extension: the notes channel must never produce one. */
export const isPdfFileName = (name: string): boolean => name.toLowerCase().endsWith('.pdf')
