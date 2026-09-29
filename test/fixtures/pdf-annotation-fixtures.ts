import { createHash } from 'node:crypto'

// PDF fixtures for the annotation-import tests (文档标注层 A2), built here rather than checked in as
// binaries: a PDF is text, and a thirty-line writer produces one small enough to read in a diff. Every
// fixture goes through the REAL parser in the tests that use it — nothing in this file mocks or
// pre-chews what the parser is supposed to see.
//
// The writer is the smallest thing that is a valid PDF: a catalog, a page tree, one Helvetica font, a
// content stream of `BT /F1 12 Tf x y Td (text) Tj ET` runs, annotation dictionaries, and a correct
// xref table (offsets are computed as the bytes are appended, so the file opens in any viewer).
//
// Object numbering is fixed so an annotation can point at another one (/Popup → /Parent):
//   1 catalog · 2 pages · 3 font · per page i: 4 + 2i page, 5 + 2i content · annotations after that.

export type FixtureTextLine = { text: string; x: number; y: number; size?: number }

export type FixtureAnnotation = {
  /** The annotation body WITHOUT the enclosing << >>, written verbatim into the file. */
  dict: string
  /** Written as /F when given: the file's own annotation flags (0x02 hidden, 0x20 no-view). */
  flags?: number
}

export type FixturePage = {
  lines: readonly FixtureTextLine[]
  annotations?: readonly FixtureAnnotation[]
  /** Written as /Rotate when non-zero. */
  rotate?: number
}

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792

/** The page box every fixture uses, in PDF user space (points, origin at the bottom-left). */
export const FIXTURE_PAGE_SIZE = { width: PAGE_WIDTH, height: PAGE_HEIGHT }

const escapeLiteralString = (value: string): string =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')

/** `/QuadPoints` for one axis-aligned box: four corners, in the order the spec lists them. */
export const quadPoints = (x1: number, y1: number, x2: number, y2: number): string =>
  `${x1} ${y2} ${x2} ${y2} ${x1} ${y1} ${x2} ${y1}`

/** A markup quad that comfortably contains a 12 pt line of text, the way a reader's app writes it. */
export const lineQuad = (x: number, baseline: number, size = 12): string =>
  quadPoints(x - 1, baseline - 1, x + 250, baseline + size + 1)

/**
 * Token for "the object number of the first annotation", for annotations that reference another one
 * (/Popup → /Parent). Replaced while the file is assembled, so adding a page cannot quietly break the
 * reference the way a hard-coded number would.
 */
const FIRST_ANNOTATION = '#first-annotation#'

/**
 * Builds the bytes of a one-or-more-page PDF. Deterministic: the same pages produce byte-identical
 * output (no /ID, no timestamps), which is what makes "the same file imported twice" a real assertion.
 */
export const buildPdf = (pages: readonly FixturePage[]): Uint8Array => {
  const firstAnnotationNumber = 4 + 2 * pages.length
  let annotationNumber = firstAnnotationNumber

  const objects: string[] = []
  const pageRefs = pages.map((_, index) => `${4 + 2 * index} 0 R`).join(' ')
  objects.push('<< /Type /Catalog /Pages 2 0 R >>') // 1
  objects.push(`<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`) // 2
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>') // 3

  const annotationObjectNumbers: number[][] = []
  for (const page of pages) {
    const numbers: number[] = []
    for (let i = 0; i < (page.annotations?.length ?? 0); i += 1) {
      numbers.push(annotationNumber)
      annotationNumber += 1
    }
    annotationObjectNumbers.push(numbers)
  }

  // Two passes, because the object number of every annotation must be known (and must actually be the
  // number the file assigns it) before the page dictionaries that reference them are written. Writing
  // them interleaved is how a file ends up pointing at the wrong object — which parses "mostly fine"
  // and loses exactly the annotations at the seam.
  for (const [index, page] of pages.entries()) {
    const content = page.lines
      .map(
        (line) =>
          `BT /F1 ${line.size ?? 12} Tf ${line.x} ${line.y} Td (${escapeLiteralString(line.text)}) Tj ET\n`
      )
      .join('')
    const numbers = annotationObjectNumbers[index] ?? []

    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `${page.rotate ? `/Rotate ${page.rotate} ` : ''}` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * index} 0 R` +
        `${numbers.length ? ` /Annots [${numbers.map((number) => `${number} 0 R`).join(' ')}]` : ''} >>`
    )
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`)
  }

  for (const page of pages) {
    for (const annotation of page.annotations ?? []) {
      objects.push(
        `<< /Type /Annot ${annotation.dict.replaceAll(FIRST_ANNOTATION, String(firstAnnotationNumber))}` +
          `${annotation.flags ? ` /F ${annotation.flags}` : ''} >>`
      )
    }
  }

  let source = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const [index, body] of objects.entries()) {
    offsets.push(source.length)
    source += `${index + 1} 0 obj\n${body}\nendobj\n`
  }
  const xrefOffset = source.length
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  source += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`

  return new TextEncoder().encode(source)
}

// --- the fixtures ----------------------------------------------------------------------------------

// The lines the annotated fixture draws, named so a test can say which passage a markup covers without
// repeating the string. Their baselines are 40 pt apart, far enough that one markup's quad cannot reach
// a neighbouring line.
export const FIXTURE_LINES = {
  highlighted: { text: 'Highlighted passage sits here.', x: 72, y: 700 },
  rectOnly: { text: 'Rectangle only markup line.', x: 72, y: 660 },
  underlined: { text: 'Underlined passage sits here.', x: 72, y: 620 },
  squiggly: { text: 'Squiggly passage sits here.', x: 72, y: 580 },
  struck: { text: 'Struck through passage here.', x: 72, y: 540 },
  emptyArea: { text: 'Nothing is marked on this line.', x: 72, y: 500 },
  secondPage: { text: 'Second page marked passage.', x: 72, y: 700 }
} as const

export const FIXTURE_HIGHLIGHT_COMMENT = 'Keep this: the effect is large.'
export const FIXTURE_AREA_COMMENT = 'Region of interest: figure 2.'
export const FIXTURE_NOTE_TEXT = 'Page note from the reader.'
export const FIXTURE_LINK_URL = 'https://example.org/paper'

/**
 * One page of text carrying one of every kind this channel imports, plus every reason it does not:
 *
 *   imported  · Highlight (with a comment), Highlight written as /Rect only, Underline, Squiggly,
 *               StrikeOut, Square (a region), Text (a page note)
 *   skipped   · Highlight over a blank part of the page (no text to quote)
 *               Text with no /Contents (a note with nothing in it)
 *               Highlight marked hidden (/F 2) and Highlight marked no-view (/F 32)
 *               Ink, Circle, Link, Popup, and one annotation with no /Subtype at all
 *               (no counterpart in our kinds)
 *
 * A second page carries one highlight, so page numbering is exercised rather than assumed.
 */
export const annotatedPdfFixture = (): Uint8Array =>
  buildPdf([
    {
      lines: Object.values(FIXTURE_LINES).filter((line) => line !== FIXTURE_LINES.secondPage),
      annotations: [
        // 1: the highlight the Popup below belongs to.
        {
          dict: `/Subtype /Highlight /Rect [72 698 320 714] /QuadPoints [${lineQuad(
            FIXTURE_LINES.highlighted.x,
            FIXTURE_LINES.highlighted.y
          )}] /Contents (${FIXTURE_HIGHLIGHT_COMMENT}) /T (reader-a) /C [1 0.8 0]`
        },
        // 2: a reader that wrote /Rect and no /QuadPoints. pdf.js's display intent hides this one
        // silently; the importer anchors it on the rectangle the file did write.
        {
          dict: `/Subtype /Highlight /Rect [70 658 300 674] /Contents (no quads in this file)`
        },
        {
          dict: `/Subtype /Underline /Rect [72 618 300 634] /QuadPoints [${lineQuad(
            FIXTURE_LINES.underlined.x,
            FIXTURE_LINES.underlined.y
          )}]`
        },
        {
          dict: `/Subtype /Squiggly /Rect [72 578 300 594] /QuadPoints [${lineQuad(
            FIXTURE_LINES.squiggly.x,
            FIXTURE_LINES.squiggly.y
          )}]`
        },
        {
          dict: `/Subtype /StrikeOut /Rect [72 538 300 554] /QuadPoints [${lineQuad(
            FIXTURE_LINES.struck.x,
            FIXTURE_LINES.struck.y
          )}]`
        },
        { dict: `/Subtype /Square /Rect [400 420 560 480] /Contents (${FIXTURE_AREA_COMMENT})` },
        { dict: `/Subtype /Text /Rect [560 700 582 720] /Contents (${FIXTURE_NOTE_TEXT})` },
        // Supported subtype, nothing under it: the page's lower half carries no text.
        {
          dict: `/Subtype /Highlight /Rect [80 120 300 140] /QuadPoints [${quadPoints(80, 120, 300, 140)}] /Contents (over blank space)`
        },
        // A note with no text: nothing to store, and nothing to invent.
        { dict: `/Subtype /Text /Rect [560 660 582 680]` },
        // Markup the file itself does not show: named and skipped, never imported behind the reader's back.
        {
          flags: 2,
          dict: `/Subtype /Highlight /Rect [72 498 300 514] /QuadPoints [${lineQuad(
            FIXTURE_LINES.emptyArea.x,
            FIXTURE_LINES.emptyArea.y
          )}] /Contents (hidden from every viewer)`
        },
        {
          flags: 32,
          dict: `/Subtype /Highlight /Rect [72 458 300 474] /QuadPoints [${quadPoints(71, 457, 322, 475)}] /Contents (not for view)`
        },
        {
          dict: `/Subtype /Ink /Rect [100 60 200 100] /InkList [100 60 200 100 150 80] /Contents (a drawn line)`
        },
        {
          dict: `/Subtype /Circle /Rect [400 300 480 360] /Contents (a circle is not a rectangle)`
        },
        { dict: `/Subtype /Link /Rect [72 40 200 60] /A << /S /URI /URI (${FIXTURE_LINK_URL}) >>` },
        // An annotation dictionary with no /Subtype at all: the file is malformed and the parser still
        // hands it over, so it is labelled and reported rather than dropped for lack of a name.
        { dict: '/Rect [10 10 20 20]' },
        { dict: `/Subtype /Popup /Rect [320 700 520 780] /Parent ${FIRST_ANNOTATION} 0 R` }
      ]
    },
    {
      lines: [FIXTURE_LINES.secondPage],
      annotations: [
        {
          dict: `/Subtype /Highlight /Rect [72 698 320 714] /QuadPoints [${lineQuad(
            FIXTURE_LINES.secondPage.x,
            FIXTURE_LINES.secondPage.y
          )}] /Contents (page two)`
        }
      ]
    }
  ])

/** The same page of text, with no annotations at all. */
export const plainPdfFixture = (): Uint8Array =>
  buildPdf([
    {
      lines: [
        { text: 'A page with no markup on it.', x: 72, y: 700 },
        { text: 'The reader never annotated this one.', x: 72, y: 660 }
      ]
    }
  ])

/** A page whose only annotations are subtypes this build does not import. */
export const unsupportedOnlyPdfFixture = (): Uint8Array =>
  buildPdf([
    {
      lines: [{ text: 'Marked only with shapes we do not store.', x: 72, y: 700 }],
      annotations: [
        { dict: `/Subtype /Ink /Rect [100 60 200 100] /InkList [100 60 200 100 150 80]` },
        { dict: `/Subtype /Circle /Rect [400 300 480 360]` },
        { dict: `/Subtype /FreeText /Rect [72 500 300 540] /Contents (drawn text)` }
      ]
    }
  ])

/** A page the file rotates when it is displayed: coordinates are refused rather than guessed at. */
export const rotatedPdfFixture = (): Uint8Array =>
  buildPdf([
    {
      rotate: 90,
      lines: [FIXTURE_LINES.secondPage],
      annotations: [
        {
          dict: `/Subtype /Highlight /Rect [72 698 320 714] /QuadPoints [${lineQuad(
            FIXTURE_LINES.secondPage.x,
            FIXTURE_LINES.secondPage.y
          )}] /Contents (on a rotated page)`
        }
      ]
    }
  ])

/**
 * A damaged file: the annotated fixture with its xref table, trailer and %%EOF cut off — the shape a
 * truncated download or a half-written copy takes, and one no viewer can open either.
 */
export const damagedPdfFixture = (): Uint8Array => {
  const bytes = annotatedPdfFixture()
  const xrefAt = new TextDecoder('latin1').decode(bytes).lastIndexOf('\nxref\n')
  return bytes.slice(0, xrefAt <= 0 ? bytes.length - 40 : xrefAt + 1)
}

/** sha256 of a fixture's bytes — the checksum a managed version of that file would carry. */
export const sha256HexOf = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')
