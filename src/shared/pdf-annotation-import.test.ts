import { describe, expect, it } from 'vitest'

import { validatePdfAnnotationContent } from './pdf-annotations'
import {
  PDF_EMBEDDED_MAX_QUOTE_CHARS,
  mapEmbeddedPdfAnnotation,
  summarizeEmbeddedImport,
  textUnderBoxes,
  type PdfEmbeddedAnnotation,
  type PdfEmbeddedAnnotationMapping,
  type PdfImportedPage
} from './pdf-annotation-import'
import type { PdfTextItem } from './pdf-table-extraction'

// The mapping rules, with no PDF involved: what a file's annotation becomes, and — just as much the
// point — the named reason for every annotation it does not become. The real-parser side of the same
// rules lives in src/main/references/pdf-annotation-import.test.ts.

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792

const item = (text: string, x: number, y: number, width = 120, height = 12): PdfTextItem => ({
  text,
  x,
  y,
  width,
  height
})

const page = (overrides: Partial<PdfImportedPage> = {}): PdfImportedPage => ({
  number: 1,
  width: PAGE_WIDTH,
  height: PAGE_HEIGHT,
  rotate: 0,
  items: [item('Highlighted passage sits here.', 72, 700, 160.74)],
  ...overrides
})

// The shape pdf.js hands back for /QuadPoints: an indexed object (a Float32Array crosses the worker
// boundary that way), NOT an array. Getting this wrong is how a "quad points" implementation that
// only accepts arrays silently falls back to the rectangle on every real file.
const quadPointsObject = (...numbers: number[]): Record<string, number> =>
  Object.fromEntries(numbers.map((value, index) => [String(index), value]))

/** upper-left, upper-right, lower-left, lower-right — the order PDF 32000-1 specifies. */
const quad = (x1: number, y1: number, x2: number, y2: number): number[] => [
  x1,
  y2,
  x2,
  y2,
  x1,
  y1,
  x2,
  y1
]

const highlight = (overrides: Partial<PdfEmbeddedAnnotation> = {}): PdfEmbeddedAnnotation => ({
  page: 1,
  subtype: 'Highlight',
  rect: [72, 698, 320, 714],
  quadPoints: quadPointsObject(...quad(72, 698, 320, 714)),
  contents: '',
  flags: 0,
  ...overrides
})

const mapped = (annotation: PdfEmbeddedAnnotation, target = page()): PdfEmbeddedAnnotationMapping =>
  mapEmbeddedPdfAnnotation(annotation, target)

type MappedOk = Extract<PdfEmbeddedAnnotationMapping, { ok: true }>
type MappedSkip = Extract<PdfEmbeddedAnnotationMapping, { ok: false }>

const expectOk = (mapping: PdfEmbeddedAnnotationMapping): MappedOk => {
  if (!mapping.ok) throw new Error(`expected a mapping, got a skip: ${mapping.detail}`)
  return mapping
}

const expectSkip = (mapping: PdfEmbeddedAnnotationMapping): MappedSkip => {
  if (mapping.ok) throw new Error(`expected a skip, got kind ${mapping.kind}`)
  return mapping
}

describe('mapping a file annotation to one of ours', () => {
  it('turns a highlight into a text-range anchored on the page with the passage it covers', () => {
    const mapping = expectOk(mapped(highlight({ contents: 'important' })))

    expect(mapping.kind).toBe('highlight')
    expect(mapping.content.body).toBe('important')
    expect(mapping.content.selector).toEqual({
      version: 1,
      shape: 'text-range',
      page: 1,
      rects: [{ x: 0.1176, y: 0.0985, width: 0.4052, height: 0.0202 }],
      quote: 'Highlighted passage sits here.'
    })
    // The store's own consistency rule, applied to what this module produces.
    expect(validatePdfAnnotationContent(mapping.content)).toBeUndefined()
  })

  it('gives each markup subtype the kind that matches it', () => {
    const kinds = ['Highlight', 'Underline', 'Squiggly', 'StrikeOut'].map(
      (subtype) => expectOk(mapped(highlight({ subtype }))).kind
    )

    expect(kinds).toEqual(['highlight', 'underline', 'squiggly', 'strikethrough'])
  })

  // The file's corners may be written in any order within a quad; the anchor is the box they enclose,
  // so a scrambled order must land on the same rectangle rather than a degenerate one.
  it('does not care in which order a quad lists its corners', () => {
    const square = quad(72, 698, 320, 714)
    const scrambled = [
      square[4]!,
      square[5]!,
      square[0]!,
      square[1]!,
      square[6]!,
      square[7]!,
      square[2]!,
      square[3]!
    ]

    const straight = expectOk(mapped(highlight()))
    const shuffled = expectOk(mapped(highlight({ quadPoints: scrambled })))

    expect(shuffled.content.selector).toEqual(straight.content.selector)
  })

  it('anchors a markup the file wrote with only a rectangle, which the parser hides from a display read', () => {
    const mapping = expectOk(mapped(highlight({ quadPoints: null })))

    expect(mapping.content.selector).toMatchObject({
      shape: 'text-range',
      rects: [{ x: 0.1176, y: 0.0985, width: 0.4052, height: 0.0202 }]
    })
    expect((mapping.content.selector as { quote: string }).quote).toBe(
      'Highlighted passage sits here.'
    )
  })

  it('keeps every line of a multi-line selection, in the file’s order', () => {
    const mapping = expectOk(
      mapped(
        highlight({
          rect: [72, 654, 320, 714],
          quadPoints: quadPointsObject(...quad(72, 694, 320, 714), ...quad(72, 654, 320, 674))
        }),
        page({
          items: [item('first line', 72, 700, 90), item('second line', 72, 660, 96)]
        })
      )
    )

    expect((mapping.content.selector as { rects: unknown[] }).rects).toHaveLength(2)
    expect((mapping.content.selector as { quote: string }).quote).toBe('first line second line')
  })

  it('reads a region as an area and a sticky note as a page note with its text', () => {
    const area = expectOk(
      mapped(
        { page: 1, subtype: 'Square', rect: [400, 420, 560, 480], contents: 'figure 2' },
        page()
      )
    )
    const note = expectOk(
      mapped(
        { page: 1, subtype: 'Text', rect: [560, 700, 582, 720], contents: 'read this again' },
        page()
      )
    )

    expect(area.content.selector).toEqual({
      version: 1,
      shape: 'area',
      page: 1,
      rect: { x: 0.6536, y: 0.3939, width: 0.2614, height: 0.0758 }
    })
    expect(area.content.body).toBe('figure 2')
    expect(note.kind).toBe('page-note')
    expect(note.content.body).toBe('read this again')
    expect(note.content.selector).toEqual({
      version: 1,
      shape: 'page-note',
      page: 1,
      anchorRect: { x: 0.915, y: 0.0909, width: 0.0359, height: 0.0253 }
    })
  })

  // A note is its text: the little rectangle the file drew for its icon is not worth refusing it over,
  // but an anchor nobody can see is not worth inventing either.
  it('imports a note with no placeable anchor rather than dropping the note', () => {
    const mapping = expectOk(
      mapped({ page: 1, subtype: 'Text', rect: [10, 10, 10, 10], contents: 'no icon box' }, page())
    )

    expect(mapping.content.selector).toEqual({ version: 1, shape: 'page-note', page: 1 })
    expect(mapping.content.body).toBe('no icon box')
  })
})

describe('what an imported annotation refuses to do', () => {
  it('names a subtype it has no counterpart for, instead of forcing it into one', () => {
    const mapping = expectSkip(mapped({ page: 1, subtype: 'Ink', rect: [10, 10, 60, 60] }))

    expect(mapping.reason).toBe('unsupported-subtype')
    expect(mapping.subtype).toBe('Ink')
    expect(mapping.detail).toContain('"Ink"')
    expect(mapping.detail).toContain('Highlight, Underline, Squiggly, StrikeOut, Square, Text')
  })

  it('ignores neither markup the file hides nor markup it marks not-for-view', () => {
    for (const flags of [2, 32, 2 | 4]) {
      const mapping = expectSkip(mapped(highlight({ flags })))

      expect(mapping.reason).toBe('not-displayed')
      expect(mapping.detail).toContain(`annotation flags ${flags}`)
    }
    // Anything else — including 0, which is what a file's /F 1 (invisible) arrives as — is imported.
    expect(expectOk(mapped(highlight({ flags: 4 }))).kind).toBe('highlight')
  })

  it('refuses to place markup from a rotated page rather than guessing where it belongs', () => {
    const mapping = expectSkip(mapped(highlight(), page({ rotate: 90 })))

    expect(mapping.reason).toBe('rotated-page')
    expect(mapping.detail).toContain('rotated 90°')
  })

  it('refuses markup with no extent, markup with no page, and geometry that is not numbers', () => {
    const flat = expectSkip(mapped(highlight({ rect: [70, 698, 70, 714], quadPoints: null })))
    const unreadable = expectSkip(
      mapped(highlight({ rect: [70, 698, 300, '674'], quadPoints: 'nonsense' }))
    )
    const worthless = expectSkip(
      mapped({ page: 1, subtype: 'Square', rect: [400, 420, 400, 480] }, page())
    )
    const nowhere = expectSkip(
      mapEmbeddedPdfAnnotation({ page: 9, subtype: 'Square', rect: [1, 1, 2, 2] }, undefined)
    )

    expect(flat.reason).toBe('degenerate-geometry')
    expect(unreadable.reason).toBe('degenerate-geometry')
    expect(worthless.reason).toBe('degenerate-geometry')
    expect(worthless.detail).toContain('would mark nothing')
    expect(nowhere.reason).toBe('unknown-page')
    expect(nowhere.detail).toContain('page 9')
  })

  // A page whose box the parser could not measure: nothing on it can be normalized, and a coordinate
  // divided by a zero-width page is not an anchor anybody can use.
  it('refuses every markup on a page with no measurable box', () => {
    const whole = page({ width: 0, height: 0 })

    expect(expectSkip(mapped(highlight(), whole)).reason).toBe('degenerate-geometry')
    expect(
      expectSkip(mapped({ page: 1, subtype: 'Square', rect: [1, 1, 2, 2] }, whole)).reason
    ).toBe('degenerate-geometry')
  })

  it('falls back to the rectangle when a quad value is not a coordinate list at all', () => {
    const mapping = expectOk(mapped(highlight({ quadPoints: 42 })))

    expect((mapping.content.selector as { shape: string }).shape).toBe('text-range')
    expect((mapping.content.selector as { quote: string }).quote).toBe(
      'Highlighted passage sits here.'
    )
  })

  it('says so when a markup covers no text, rather than anchoring it on nothing', () => {
    const mapping = expectSkip(mapped(highlight({ rect: [80, 120, 300, 140], quadPoints: null })))

    expect(mapping.reason).toBe('no-text-under-markup')
    expect(mapping.detail).toContain('page 1')
  })

  it('says so when a note carries no text', () => {
    const mapping = expectSkip(
      mapped({ page: 1, subtype: 'Text', rect: [560, 700, 582, 720], contents: '   ' })
    )

    expect(mapping.reason).toBe('empty-note')
  })
})

describe('reading the passage a markup covers', () => {
  it('collects the covered items in reading order and normalizes the whitespace', () => {
    const quote = textUnderBoxes(
      [{ x1: 70, y1: 650, x2: 400, y2: 716 }],
      [
        item(' second ', 80, 660),
        item('First', 72, 700),
        item(' line', 120, 700),
        item('far away', 72, 300)
      ]
    )

    expect(quote).toBe('First line second')
  })

  it('counts an item as covered when it only touches the box within the tolerance', () => {
    // The line's box is [70, 82] x [700, 712]; the markup sits one point below and above it.
    const items = [item('touching line', 72, 700, 10, 12)]

    expect(textUnderBoxes([{ x1: 70, y1: 699, x2: 200, y2: 713 }], items)).toBe('touching line')
    expect(textUnderBoxes([{ x1: 70, y1: 690, x2: 200, y2: 698 }], items)).toBe('')
  })

  it('bounds the passage one markup can push into the store', () => {
    const long = 'x'.repeat(PDF_EMBEDDED_MAX_QUOTE_CHARS + 500)
    const mapping = expectOk(mapped(highlight(), page({ items: [item(long, 72, 700, 3000)] })))

    expect((mapping.content.selector as { quote: string }).quote).toHaveLength(
      PDF_EMBEDDED_MAX_QUOTE_CHARS
    )
  })
})

describe('summarizing what an import did', () => {
  it('counts the imported kinds and groups what was left behind by subtype and reason', () => {
    const summary = summarizeEmbeddedImport([
      mapped(highlight()),
      mapped(highlight({ subtype: 'Underline' })),
      mapped(highlight({ subtype: 'Highlight', flags: 2 })),
      mapped(highlight({ subtype: 'Highlight', flags: 32 })),
      mapped({ page: 1, subtype: 'Ink', rect: [1, 1, 2, 2] }),
      mapped({ page: 1, subtype: 'FreeText', rect: [1, 1, 2, 2] })
    ])

    expect(summary.imported).toBe(2)
    expect(summary.kinds).toEqual([
      { kind: 'highlight', count: 1 },
      { kind: 'underline', count: 1 }
    ])
    expect(summary.skipped).toEqual([
      expect.objectContaining({ subtype: 'Highlight', reason: 'not-displayed', count: 2 }),
      expect.objectContaining({ subtype: 'Ink', reason: 'unsupported-subtype', count: 1 }),
      expect.objectContaining({ subtype: 'FreeText', reason: 'unsupported-subtype', count: 1 })
    ])
  })

  it('is empty — not undefined — for a file that carried no annotations at all', () => {
    expect(summarizeEmbeddedImport([])).toEqual({ imported: 0, kinds: [], skipped: [] })
  })
})
