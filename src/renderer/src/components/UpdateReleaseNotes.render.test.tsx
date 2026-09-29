// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LanguageProvider } from '@/i18n'
import { dictionaries, LANGUAGES, type Language } from '@/i18n/languages'
import { UpdateReleaseNotes } from './UpdateReleaseNotes'

// What this suite pins on the real DOM:
//   R1  nothing is dropped — unknown syntax, a very long line, blank runs, plain text and a
//       heading-only note all reach the reader;
//   R3  the structure is there (group title / numbered entries / entry subtitle) and the layout is
//       spill-proof: no `truncate`, every text node breaks long runs, `min-w-0` on the containers.
// The pixel-level proof for R3 (a real Chromium, Chinese UI, scrollWidth vs clientWidth) lives in
// e2e/update-release-notes.spec.ts — jsdom computes no layout, so this file asserts the DOM shape and
// the CSS contract that layout depends on.

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.localStorage.clear()
})

const render = (notes: string, language?: Language): void => {
  if (language) window.localStorage.setItem('purescience-language', language)
  act(() => {
    root.render(
      <LanguageProvider>
        <UpdateReleaseNotes notes={notes} />
      </LanguageProvider>
    )
  })
}

const at = (testId: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
const all = (testId: string): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`))

describe('UpdateReleaseNotes — structure', () => {
  it('renders a group title, numbered entries, and an entry subtitle with its sentence', () => {
    render(['## 新功能', '- **结构化更新说明**：分组标题 + 编号条目', '- 另一条'].join('\n'), 'zh')

    expect(at('release-note-group-title')?.textContent).toBe('新功能')
    const entries = all('release-note-entry')
    expect(entries).toHaveLength(2)
    expect(container.querySelectorAll('ol')).toHaveLength(1)
    expect(entries[0].querySelector('[data-testid="release-note-entry-title"]')?.textContent).toBe(
      '结构化更新说明：'
    )
    expect(entries[0].textContent).toContain('分组标题 + 编号条目')
  })

  it('labels a group the note author left unheaded with the dialog copy', () => {
    render('- 只有条目', 'zh')
    expect(at('release-note-group-title')?.textContent).toBe('亮点')
    expect(all('release-note-entry')).toHaveLength(1)
  })

  it('keeps the commit short SHA of a change reference in the rendered entry', () => {
    render('- 修完 `e4ff162` 上 windows-x64 构建成功（见 5ef94da）', 'zh')
    const text = at('release-note-entry')?.textContent ?? ''
    expect(text).toContain('e4ff162')
    expect(text).toContain('5ef94da')
    expect(text).toContain('修完 e4ff162 上 windows-x64 构建成功（见 5ef94da）')
  })
})

describe('UpdateReleaseNotes — R1: unknown syntax stays on screen', () => {
  it('renders syntax it has no rule for verbatim, line by line', () => {
    const notes = [
      '> 引用块',
      '| a | b |',
      '---',
      '~~删除线~~ [链接](https://example.com) <div>html</div>',
      '**未闭合的加粗'
    ].join('\n')
    render(notes, 'zh')
    for (const line of notes.split('\n')) expect(container.textContent).toContain(line)
    expect(all('release-note-entry')).toHaveLength(0)
  })

  it('keeps a very long unbroken line whole', () => {
    const long = `row ${'0123456789abcdef'.repeat(200)}`
    render(long, 'zh')
    expect(container.textContent).toContain(long)
    const paragraph = at('release-note-paragraph')
    expect(paragraph?.className).toContain('break-words')
    expect(paragraph?.className).toContain('[overflow-wrap:anywhere]')
  })

  it('keeps the neighbours of a blank run', () => {
    render('第一段\n\n\n\n第二段\n\n', 'zh')
    expect(container.textContent).toContain('第一段')
    expect(container.textContent).toContain('第二段')
  })

  it('renders plain text with no markup as a paragraph (no list is invented)', () => {
    render('Shiny new things', 'en')
    expect(container.textContent).toContain('Shiny new things')
    expect(container.querySelectorAll('ol')).toHaveLength(0)
    expect(at('release-note-group-title')?.textContent).toBe('Highlights')
  })

  it('renders a heading-only note without inventing entries', () => {
    render('## 修复', 'zh')
    expect(at('release-note-group-title')?.textContent).toBe('修复')
    expect(all('release-note-entry')).toHaveLength(0)
    expect(container.querySelectorAll('ol')).toHaveLength(0)
    expect(at('update-release-notes')).not.toBeNull()
  })

  it('falls back to the raw text when nothing can be structured', () => {
    render('   ', 'zh')
    expect(at('release-note-plain')).not.toBeNull()
    expect(at('update-release-notes')).toBeNull()
  })
})

describe('UpdateReleaseNotes — R3: worst-case Chinese copy is spill-proof', () => {
  const longChineseNote = [
    '## 修复',
    `- **中文最长的排版用例**：${'超长不可断行的内容'.repeat(1)}${'x'.repeat(2000)}`,
    '- 「下载更新」按钮上的体积与条目内的改动引用都必须在同一行内换行，不得溢出或截断。'
  ].join('\n')

  it('keeps every character of the longest note in the DOM (no truncation)', () => {
    render(longChineseNote, 'zh')
    const notes = at('update-release-notes')
    expect(notes?.textContent).toContain(`${'x'.repeat(2000)}`)
    expect(notes?.textContent).toContain('不得溢出或截断')
    // Nothing in the notes surface is allowed to ellipsize: `truncate`/`line-clamp` clips instead of
    // wrapping, which is exactly the failure mode this case exists for.
    expect(notes?.querySelectorAll('[class*="truncate"], [class*="line-clamp"]').length).toBe(0)
  })

  it('puts break-words + min-w-0 on every node that can grow with the text', () => {
    render(longChineseNote, 'zh')
    const nodes = [
      at('update-release-notes'),
      at('release-note-group'),
      at('release-note-group-title'),
      at('release-note-entry'),
      at('release-note-paragraph')
    ]
    for (const node of nodes) if (node) expect(node.className).toContain('min-w-0')
    for (const entry of all('release-note-entry')) {
      expect(entry.className).toContain('break-words')
      expect(entry.className).toContain('[overflow-wrap:anywhere]')
    }
    expect(at('release-note-group-title')?.className).toContain('[overflow-wrap:anywhere]')
  })

  it('takes the group label from every one of the 9 dictionaries', () => {
    // The label on an unheaded group is the only new copy this surface introduces: it must exist (and
    // be translated) in every shipped language, not fall back to English. The language is read when the
    // provider mounts, so each iteration gets a fresh root.
    for (const { id } of LANGUAGES) {
      act(() => root.unmount())
      root = createRoot(container)
      render('- 条目', id)
      const label = at('release-note-group-title')?.textContent
      expect(label).toBe(dictionaries[id]['update.notesHighlights'])
      expect(label).toBeTruthy()
    }
  })
})
