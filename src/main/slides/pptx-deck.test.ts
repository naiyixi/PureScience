import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import {
  buildPptxDeck,
  PPTX_DECK_MAX_BULLETS_PER_SECTION,
  PPTX_DECK_MAX_SECTIONS,
  PPTX_DECK_MAX_TEXT_CHARS,
  PPTX_DECK_MAX_TOTAL_TEXT_CHARS,
  type PptxDeckInput
} from './pptx-deck'

const outline = (overrides: Partial<PptxDeckInput> = {}): PptxDeckInput => ({
  title: 'Deck title',
  sections: [{ heading: 'First', bullets: ['one', 'two'] }],
  ...overrides
})

const read = (input: PptxDeckInput): Record<string, string> => {
  const result = buildPptxDeck(input)
  if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal}`)

  const entries = unzipSync(result.bytes)

  return Object.fromEntries(
    Object.entries(entries).map(([path, bytes]) => [path, strFromU8(bytes)])
  )
}

describe('buildPptxDeck', () => {
  it('writes a complete package: content types, package rels, core properties and one part per slide', () => {
    const files = read(
      outline({
        sections: [
          { heading: 'One', bullets: [] },
          { heading: 'Two', bullets: ['a'] }
        ]
      })
    )

    // One title slide plus one slide per section.
    expect(
      Object.keys(files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/u.test(path))
    ).toHaveLength(3)
    expect(files['[Content_Types].xml']).toContain('/ppt/slides/slide3.xml')
    expect(files['_rels/.rels']).toContain('ppt/presentation.xml')
    expect(files['docProps/core.xml']).toContain('Deck title')
    expect(files['ppt/presentation.xml']).toContain('<p:sldId id="258" r:id="rId4"/>')
    expect(files['ppt/_rels/presentation.xml.rels']).toContain('Target="slides/slide3.xml"')
    // Every slide points at the blank layout, and the master owns both the layout and the theme.
    expect(files['ppt/slides/_rels/slide1.xml.rels']).toContain('../slideLayouts/slideLayout1.xml')
    expect(files['ppt/slideMasters/_rels/slideMaster1.xml.rels']).toContain('../theme/theme1.xml')
  })

  it('keeps the text the caller wrote, including CJK and characters that must be escaped in XML', () => {
    const files = read(
      outline({
        title: '中文标题 & <tag>',
        subtitle: '副标题',
        sections: [{ heading: 'A & B', bullets: ['x < y', "quote \" and 'apostrophe'"] }]
      })
    )

    const first = files['ppt/slides/slide1.xml']
    expect(first).toContain('中文标题 &amp; &lt;tag&gt;')
    expect(first).toContain('副标题')

    const body = files['ppt/slides/slide2.xml']
    expect(body).toContain('A &amp; B')
    expect(body).toContain('x &lt; y')
    expect(body).toContain('quote &quot; and &apos;apostrophe&apos;')
    // The raw characters never reach the part unescaped — that would be a corrupt document.
    expect(body).not.toContain('< y')
  })

  it('does not invent an author, a date or a company when the caller has none', () => {
    const files = read(outline())

    expect(files['docProps/core.xml']).not.toContain('dc:creator')
    expect(files['docProps/core.xml']).not.toContain('dcterms:created')
    expect(files['docProps/core.xml']).not.toContain('dcterms:modified')
    expect(files['docProps/core.xml']).not.toContain('lastModifiedBy')
  })

  it('writes dc:creator when the caller supplied an author', () => {
    const files = read(outline({ author: 'Some Institute' }))

    expect(files['docProps/core.xml']).toContain('<dc:creator>Some Institute</dc:creator>')
  })

  it('is a function of the input only: the same outline yields byte-identical packages', () => {
    const first = buildPptxDeck(outline({ author: 'A' }))
    const second = buildPptxDeck(outline({ author: 'A' }))

    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(Buffer.compare(Buffer.from(first.bytes), Buffer.from(second.bytes))).toBe(0)
  })

  it('uses a 16:9 slide size and one bullet paragraph per bullet', () => {
    const files = read(outline({ sections: [{ heading: 'Numbers', bullets: ['1', '2', '3'] }] }))

    expect(files['ppt/presentation.xml']).toContain('<p:sldSz cx="12192000" cy="6858000"/>')
    const slide = files['ppt/slides/slide2.xml']
    expect(slide.match(/<a:buChar char="&#8226;"\/>/gu)).toHaveLength(3)
  })

  it('still writes a slide for a section with no bullets', () => {
    const files = read(outline({ sections: [{ heading: 'Heading only', bullets: [] }] }))

    expect(files['ppt/slides/slide2.xml']).toContain('Heading only')
    expect(files['ppt/slides/slide2.xml']).not.toContain('buChar')
  })
})

describe('buildPptxDeck refusals', () => {
  it('refuses an empty title', () => {
    const result = buildPptxDeck(outline({ title: '   ' }))

    expect(result).toMatchObject({ ok: false, refusal: 'title-empty' })
  })

  it('refuses a deck with no sections', () => {
    const result = buildPptxDeck(outline({ sections: [] }))

    expect(result).toMatchObject({ ok: false, refusal: 'sections-empty' })
  })

  it('refuses a section with an empty heading and names which one', () => {
    const result = buildPptxDeck(
      outline({
        sections: [
          { heading: 'Fine', bullets: [] },
          { heading: '  ', bullets: [] }
        ]
      })
    )

    expect(result).toMatchObject({ ok: false, refusal: 'section-heading-empty' })
    if (!result.ok) expect(result.detail).toContain('Section 2')
  })

  it('refuses more sections than one deck carries, naming the bound', () => {
    const result = buildPptxDeck(
      outline({
        sections: Array.from({ length: PPTX_DECK_MAX_SECTIONS + 1 }, (_value, index) => ({
          heading: `S${index}`,
          bullets: []
        }))
      })
    )

    expect(result).toMatchObject({ ok: false, refusal: 'too-many-sections' })
    if (!result.ok) expect(result.detail).toContain(String(PPTX_DECK_MAX_SECTIONS))
  })

  it('refuses a section with too many bullets and tells the caller to split it', () => {
    const result = buildPptxDeck(
      outline({
        sections: [
          {
            heading: 'Crowded',
            bullets: Array.from({ length: PPTX_DECK_MAX_BULLETS_PER_SECTION + 1 }, () => 'b')
          }
        ]
      })
    )

    expect(result).toMatchObject({ ok: false, refusal: 'too-many-bullets' })
    if (!result.ok) expect(result.detail).toContain('Split it into two sections.')
  })

  it('refuses an overlong line instead of truncating it', () => {
    const result = buildPptxDeck(
      outline({ sections: [{ heading: 'H', bullets: ['x'.repeat(PPTX_DECK_MAX_TEXT_CHARS + 1)] }] })
    )

    expect(result).toMatchObject({ ok: false, refusal: 'text-too-long' })
  })

  it('refuses a deck past the total text bound', () => {
    const line = 'y'.repeat(PPTX_DECK_MAX_TEXT_CHARS)
    const perSection = Math.ceil(PPTX_DECK_MAX_TOTAL_TEXT_CHARS / PPTX_DECK_MAX_TEXT_CHARS) + 1
    const result = buildPptxDeck(
      outline({
        sections: Array.from({ length: perSection }, (_value, index) => ({
          heading: `S${index}`,
          bullets: [line]
        }))
      })
    )

    expect(result).toMatchObject({ ok: false, refusal: 'deck-too-large' })
  })
})
