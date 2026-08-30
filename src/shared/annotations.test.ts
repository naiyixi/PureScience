import { describe, expect, it } from 'vitest'

import {
  ANNOTATION_MIN_REGION_EDGE,
  formatAnnotationPromptBlock,
  isValidAnnotationRegion
} from './annotations'

describe('formatAnnotationPromptBlock', () => {
  it('wraps the selected text in a cited annotation block', () => {
    expect(
      formatAnnotationPromptBlock({
        id: 'a1',
        kind: 'text',
        source: '转录',
        text: '对比两组表达量',
        createdAt: 1
      })
    ).toBe('<annotation source="转录">\n对比两组表达量\n</annotation>')
  })

  it('escapes markup characters in the source label', () => {
    expect(
      formatAnnotationPromptBlock({
        id: 'a2',
        kind: 'text',
        source: 'file <a.txt> & "notes"',
        text: 'x',
        createdAt: 1
      }).split('\n')[0]
    ).toBe('<annotation source="file &lt;a.txt&gt; &amp; &quot;notes&quot;">')
  })

  it('keeps multi-line selections intact', () => {
    const out = formatAnnotationPromptBlock({
      id: 'a3',
      kind: 'text',
      source: 's',
      text: 'line1\nline2\nline3',
      createdAt: 1
    })
    expect(out).toContain('line1\nline2\nline3')
  })

  it('renders image region annotations with a normalized region attribute', () => {
    const out = formatAnnotationPromptBlock({
      id: 'a4',
      kind: 'image',
      source: 'gel.jpg',
      image: { mediaPath: 'img-42', width: 800, height: 600 },
      region: { x: 0.25, y: 0.1, width: 0.5, height: 0.33 },
      createdAt: 1
    })
    expect(out.split('\n')[0]).toBe(
      '<annotation source="gel.jpg" kind="image" region="0.250,0.100,0.500,0.330">'
    )
    expect(out).toContain('source image: img-42')
  })
})

describe('isValidAnnotationRegion', () => {
  it('accepts well-formed normalized regions', () => {
    expect(isValidAnnotationRegion({ x: 0, y: 0, width: 1, height: 1 })).toBe(true)
    expect(isValidAnnotationRegion({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 })).toBe(true)
  })

  it('rejects out-of-bounds, inverted, NaN and undersized regions', () => {
    expect(isValidAnnotationRegion({ x: -0.1, y: 0, width: 0.5, height: 0.5 })).toBe(false)
    expect(isValidAnnotationRegion({ x: 0, y: 0, width: 1.1, height: 0.5 })).toBe(false)
    expect(isValidAnnotationRegion({ x: 0.6, y: 0, width: 0.5, height: 0.5 })).toBe(false)
    expect(isValidAnnotationRegion({ x: 0, y: 0, width: -0.3, height: 0.5 })).toBe(false)
    expect(isValidAnnotationRegion({ x: 0, y: 0, width: NaN, height: 0.5 })).toBe(false)
    expect(isValidAnnotationRegion({ x: 0, y: 0, width: 0.5, height: '0.5' })).toBe(false)
    expect(isValidAnnotationRegion(null)).toBe(false)
    expect(isValidAnnotationRegion({ x: 0, y: 0 })).toBe(false)
    expect(
      isValidAnnotationRegion({
        x: 0,
        y: 0,
        width: ANNOTATION_MIN_REGION_EDGE / 2,
        height: 0.5
      })
    ).toBe(false)
  })
})
