import { describe, expect, it } from 'vitest'

import {
  assembleBilingualMarkdown,
  planTranslationBatches,
  splitTranslatablePages,
  type PdfTranslationPage
} from './pdf-bilingual'

const page = (pageNumber: number, text: string): PdfTranslationPage => ({ pageNumber, text })

describe('splitTranslatablePages', () => {
  it('separates pages with no text layer instead of paying to translate nothing', () => {
    const result = splitTranslatablePages([page(1, 'Abstract'), page(2, '   '), page(3, 'Methods')])

    expect(result.translatable.map((p) => p.pageNumber)).toEqual([1, 3])
    expect(result.unreadable).toEqual([2])
  })
})

describe('planTranslationBatches', () => {
  it('keeps page order and never exceeds the budget', () => {
    const batches = planTranslationBatches(
      [page(1, 'a'.repeat(60)), page(2, 'b'.repeat(60)), page(3, 'c'.repeat(10))],
      125
    )

    // 60 + 60 fits; adding page 3 would make 130 > 125, so it starts the next batch.
    expect(batches.map((b) => b.pages.map((p) => p.pageNumber))).toEqual([[1, 2], [3]])
    expect(batches.every((b) => b.charCount <= 125)).toBe(true)
  })

  it('lets one oversized page travel alone rather than truncating it', () => {
    const batches = planTranslationBatches([page(1, 'x'.repeat(500))], 100)

    expect(batches).toHaveLength(1)
    expect(batches[0]?.pages[0]?.text).toHaveLength(500)
  })

  it('refuses a nonsense budget instead of producing an unbounded batch', () => {
    expect(() => planTranslationBatches([page(1, 'a')], 0)).toThrow(/positive number/)
  })
})

describe('assembleBilingualMarkdown', () => {
  it('puts the original above the translation and anchors both to a page', () => {
    const markdown = assembleBilingualMarkdown({
      title: 'A paper',
      pages: [{ pageNumber: 2, original: 'Second page text.', translated: '第二页正文。' }]
    })

    expect(markdown).toContain('## Page 2')
    expect(markdown.indexOf('Second page text.')).toBeLessThan(markdown.indexOf('第二页正文。'))
  })

  it('states why a page has no translation instead of leaving a blank', () => {
    const markdown = assembleBilingualMarkdown({
      title: 'A paper',
      pages: [
        { pageNumber: 1, original: 'Scanned figure page', translated: null },
        { pageNumber: 3, original: 'Body text', translated: null }
      ],
      unreadablePages: [1]
    })

    expect(markdown).toContain('no text layer')
    expect(markdown).toContain('no translation was returned')
  })

  it('sorts pages even when the caller hands them out of order', () => {
    const markdown = assembleBilingualMarkdown({
      title: 'A paper',
      pages: [
        { pageNumber: 3, original: 'third', translated: '三' },
        { pageNumber: 1, original: 'first', translated: '一' }
      ]
    })

    expect(markdown.indexOf('## Page 1')).toBeLessThan(markdown.indexOf('## Page 3'))
  })
})
