import { describe, expect, it } from 'vitest'

import { formatAnnotationPromptBlock } from './annotations'

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
})
