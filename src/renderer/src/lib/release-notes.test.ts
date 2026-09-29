import { describe, expect, it } from 'vitest'

import { parseReleaseNoteSpans, parseReleaseNotes, type ReleaseNotesDoc } from './release-notes'

// The parser is the R1 guard: a note the renderer does not understand must arrive at the reader
// unchanged. These cases pin "no content loss" directly — every source line lands in exactly one node,
// and the only characters that may differ between a rendered node and its source line are the markup
// delimiters that were actually interpreted (`#`, `- `, `**`, backticks). Everything else survives,
// including syntax the renderer has no rule for.

const nonBlankLines = (text: string): string[] =>
  text.split('\n').filter((line) => line.trim() !== '')

// Source line → what the reader must see from it: the marker gone, the payload untouched.
const withoutMarkers = (line: string): string =>
  line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+•]\s+/, '')

const stripDelimiters = (text: string): string => text.replace(/\*\*/g, '').replace(/`/g, '')

// Every node's visible text, in document order (heading title, paragraphs, entry subtitle+description).
const nodeTexts = (doc: ReleaseNotesDoc): string[] =>
  doc.groups.flatMap((group) => [
    ...(group.title === undefined ? [] : [group.title]),
    ...group.blocks.map((block) =>
      block.kind === 'paragraph'
        ? block.spans.map((span) => span.text).join('')
        : `${block.title ?? ''}${block.body.map((span) => span.text).join('')}`
    )
  ])

describe('parseReleaseNotes — nothing is dropped (R1)', () => {
  const source = [
    '# 亮点',
    '',
    '- **结构化更新说明**：分组标题 + 编号条目，改动引用 `5ef94da`。',
    '> 引用块不是子集语法，原样显示',
    '| 表头 | 表头 |',
    '- 纯文本条目',
    '1. 手写编号保持原样',
    '**未闭合的加粗',
    '',
    '   ',
    '结尾纯文本',
    ''
  ].join('\n')

  it('every non-blank source line lands in the document, in order', () => {
    const doc = parseReleaseNotes(source)
    expect(doc.lines).toEqual(nonBlankLines(source))
  })

  it('every source line payload reaches the rendered text', () => {
    const doc = parseReleaseNotes(source)
    const rendered = nodeTexts(doc)
    // Compare with delimiters removed on both sides: an interpreted `**`/backtick pair disappears from
    // the render, and an unpaired `**` stays. Either way the payload characters must all be there.
    const renderedBlob = stripDelimiters(rendered.join('\n'))
    for (const line of nonBlankLines(source)) {
      expect(renderedBlob).toContain(stripDelimiters(withoutMarkers(line)))
    }
    // The syntax the renderer has no rule for is on screen verbatim — unpaired `**` included.
    const renderedText = rendered.join('\n')
    expect(renderedText).toContain('> 引用块不是子集语法，原样显示')
    expect(renderedText).toContain('| 表头 | 表头 |')
    expect(renderedText).toContain('1. 手写编号保持原样')
    expect(renderedText).toContain('**未闭合的加粗')
    expect(renderedText).toContain('结尾纯文本')
    // And the interpreted subset is not silently rewritten either.
    expect(renderedText).toContain('结构化更新说明：分组标题 + 编号条目，改动引用 5ef94da。')
  })

  it('keeps every paragraph span run rejoining into its own source lines', () => {
    const doc = parseReleaseNotes(source)
    const paragraphs = doc.groups.flatMap((group) =>
      group.blocks.filter((block) => block.kind === 'paragraph')
    )
    expect(paragraphs.length).toBeGreaterThan(0)
    for (const paragraph of paragraphs) {
      expect(stripDelimiters(paragraph.spans.map((span) => span.text).join('\n'))).toBe(
        stripDelimiters(paragraph.lines.join('\n'))
      )
    }
  })

  it('keeps a very long unbroken line whole', () => {
    const long = `token ${'abcdef0123456789'.repeat(320)}`
    const doc = parseReleaseNotes(long)
    const paragraph = doc.groups[0].blocks[0]
    expect(paragraph.kind).toBe('paragraph')
    if (paragraph.kind !== 'paragraph') throw new Error('expected a paragraph')
    expect(paragraph.spans.map((span) => span.text).join('')).toBe(long)
    expect(doc.lines).toEqual([long])
  })

  it('treats a blank run as a separator without merging or losing neighbours', () => {
    const doc = parseReleaseNotes('第一段\n\n\n\n第二段\n\n')
    expect(doc.lines).toEqual(['第一段', '第二段'])
    expect(doc.groups).toHaveLength(1)
    expect(nodeTexts(doc)).toEqual(['第一段', '第二段'])
  })

  it('returns an empty document for blank input instead of inventing structure', () => {
    const doc = parseReleaseNotes('\n   \n\t\n')
    expect(doc.groups).toEqual([])
    expect(doc.lines).toEqual([])
  })

  it('keeps a heading-only group (no entries) as written', () => {
    const doc = parseReleaseNotes('## 修复\n')
    expect(doc.groups).toHaveLength(1)
    expect(doc.groups[0].title).toBe('修复')
    expect(doc.groups[0].blocks).toEqual([])
  })

  it('does not read unknown markup as content', () => {
    const source = '~~删除线~~ [链接](https://example.com) --- <div>html</div> _斜体_'
    const spans = parseReleaseNoteSpans(source)
    expect(spans.map((span) => span.text).join('')).toBe(source)
    expect(spans.every((span) => span.kind === 'text' || span.kind === 'ref')).toBe(true)
  })
})

describe('parseReleaseNotes — interpreted subset', () => {
  it('reads headings as group titles and bullets as entries, in source order', () => {
    const doc = parseReleaseNotes(
      ['## 新功能', '- 第一项', '- 第二项', '## 修复', '- 修好了一件事'].join('\n')
    )
    expect(doc.groups.map((group) => group.title)).toEqual(['新功能', '修复'])
    expect(doc.groups.map((group) => group.blocks.length)).toEqual([2, 1])
    expect(doc.groups[0].blocks[0].kind).toBe('entry')
  })

  it('leaves a group unheaded when the notes start with content', () => {
    const doc = parseReleaseNotes('- 只有条目')
    expect(doc.groups).toHaveLength(1)
    expect(doc.groups[0].title).toBeUndefined()
  })

  it('promotes a leading bold run to the entry subtitle and absorbs the joining colon', () => {
    const doc = parseReleaseNotes('- **支持包**：交出去之前先证明它是干净的')
    const entry = doc.groups[0].blocks[0]
    if (entry.kind !== 'entry') throw new Error('expected an entry')
    expect(entry.title).toBe('支持包：')
    expect(entry.body).toEqual([{ kind: 'text', text: '交出去之前先证明它是干净的' }])
  })

  it('keeps bold inside the description when it is not the lead', () => {
    const doc = parseReleaseNotes('- 诊断支持包：成品包在离开设备前**解回来逐文件自检**')
    const entry = doc.groups[0].blocks[0]
    if (entry.kind !== 'entry') throw new Error('expected an entry')
    expect(entry.title).toBeUndefined()
    expect(entry.body).toEqual([
      { kind: 'text', text: '诊断支持包：成品包在离开设备前' },
      { kind: 'strong', text: '解回来逐文件自检' }
    ])
  })

  it('marks inline code and commit short SHAs without altering the text', () => {
    const doc = parseReleaseNotes('- 修完 `e4ff162` 上 windows-x64 构建成功')
    const entry = doc.groups[0].blocks[0]
    if (entry.kind !== 'entry') throw new Error('expected an entry')
    expect(entry.body).toEqual([
      { kind: 'text', text: '修完 ' },
      { kind: 'code', text: 'e4ff162' },
      { kind: 'text', text: ' 上 windows-x64 构建成功' }
    ])

    expect(parseReleaseNoteSpans('在 5ef94da 上全绿')).toEqual([
      { kind: 'text', text: '在 ' },
      { kind: 'ref', text: '5ef94da' },
      { kind: 'text', text: ' 上全绿' }
    ])
  })

  it('does not mistake an ordinary hex-ish word for a commit reference', () => {
    expect(parseReleaseNoteSpans('facade deadbeef')).toEqual([
      { kind: 'text', text: 'facade deadbeef' }
    ])
  })

  it('keeps a paragraph between two lists so the on-screen order is the source order', () => {
    const doc = parseReleaseNotes(['- 一', '中间的说明', '- 二'].join('\n'))
    expect(doc.groups[0].blocks.map((block) => block.kind)).toEqual(['entry', 'paragraph', 'entry'])
  })

  it('keeps a hand-numbered ordered line verbatim (never renumbered)', () => {
    const doc = parseReleaseNotes('1. 第一步')
    const block = doc.groups[0].blocks[0]
    expect(block.kind).toBe('paragraph')
    if (block.kind !== 'paragraph') throw new Error('expected a paragraph')
    expect(block.lines).toEqual(['1. 第一步'])
  })
})
