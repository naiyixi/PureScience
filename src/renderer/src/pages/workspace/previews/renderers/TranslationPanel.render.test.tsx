// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LanguageProvider } from '@/i18n'
import type { TranslationPageStatus } from '../../../../../../shared/translation-page-status'
import type {
  ReadingRow,
  TranslationReadingMode
} from '../../../../../../shared/translation-reading'
import type { TerminologyDeviation } from '../../../../../../shared/translation-terminology'
import { TranslationPanel } from './TranslationPanel'

// The reading panel (A 线), rendered: three modes, the four cell states, the per-page statuses, a named
// terminology deviation, and the A3 jump-back. Copy is asserted against the real dictionary (the provider
// falls back to English in a bare jsdom), because what a reader learns here is the wording — a data
// attribute alone would not prove the states are told apart.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const row = (overrides: Partial<ReadingRow> = {}): ReadingRow => ({
  rowIndex: 0,
  unitId: 'p1#1',
  page: 1,
  paragraph: 1,
  source: 'First paragraph.',
  translation: { kind: 'translated', text: '第一段。' },
  ...overrides
})

const rows: ReadingRow[] = [
  row(),
  row({
    rowIndex: 1,
    unitId: 'p1#2',
    paragraph: 2,
    source: 'Second paragraph.',
    translation: { kind: 'missing' }
  }),
  row({
    rowIndex: 2,
    unitId: 'p1#3',
    paragraph: 3,
    source: 'Third paragraph.',
    translation: { kind: 'failed', reason: '端点超时' }
  }),
  row({
    rowIndex: 3,
    unitId: 'kept-p1#4',
    paragraph: 4,
    source: '[1] Smith J. A trial of aspirin. 2001;345(3): 245-253.',
    translation: { kind: 'kept' }
  })
]

/** 受控组件 + 真实状态：模式的切换要真的换列，而不是只回一个回调。 */
const Harness = ({
  initialMode = 'contrast',
  ...props
}: {
  initialMode?: TranslationReadingMode
  rows?: readonly ReadingRow[]
  pageStatuses?: readonly TranslationPageStatus[]
  terminologyDeviations?: readonly TerminologyDeviation[]
  onExportContrast?: () => void
}): React.JSX.Element => {
  const [mode, setMode] = useState<TranslationReadingMode>(initialMode)
  return <TranslationPanel rows={rows} mode={mode} onModeChange={setMode} {...props} />
}

let mounted = false

/** 每次调用都用一个**全新的 root**：卸载过的 root 再 render 会抛「Cannot update an unmounted root」。 */
const render = (ui: React.ReactNode = <Harness />): void => {
  if (mounted) {
    act(() => {
      root.unmount()
    })
    container.remove()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  mounted = true
  act(() => {
    root.render(<LanguageProvider>{ui}</LanguageProvider>)
  })
}

const item = (selector: string): HTMLElement | null =>
  container.querySelector(selector) as HTMLElement | null

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  if (mounted) {
    act(() => {
      root.unmount()
    })
  }
  mounted = false
  container.remove()
})

describe('A 线阅读面板（受控：行/状态/偏离/模式都由父层给）', () => {
  it('三种模式切换会真的换列：原文模式只有原文，译文模式只有译文，对照两列都在', () => {
    render(<Harness initialMode="source" />)
    expect(item('[data-slot="translation-source-p1#2"]')).not.toBeNull()
    expect(item('[data-slot="translation-cell-p1#2"]')).toBeNull()

    act(() => {
      item('[data-slot="translation-mode-translated"]')?.click()
    })
    expect(item('[data-slot="translation-source-p1#2"]')).toBeNull()
    expect(item('[data-slot="translation-cell-p1#2"]')).not.toBeNull()

    act(() => {
      item('[data-slot="translation-mode-contrast"]')?.click()
    })
    expect(item('[data-slot="translation-source-p1#2"]')).not.toBeNull()
    expect(item('[data-slot="translation-cell-p1#2"]')).not.toBeNull()
    expect(item('[data-slot="translation-mode-contrast"]')?.getAttribute('data-selected')).toBe(
      'true'
    )
  })

  it('未译 / 失败 / 保留各说各的（不合成一句「没有译文」）', () => {
    render()
    expect(item('[data-slot="translation-cell-p1#1"]')?.textContent).toContain('第一段。')
    expect(item('[data-slot="translation-cell-p1#2"]')?.textContent).toContain(
      'no translation for this paragraph yet'
    )
    expect(item('[data-slot="translation-cell-p1#3"]')?.textContent).toContain('translation failed')
    expect(item('[data-slot="translation-cell-p1#3"]')?.textContent).toContain('端点超时')
    expect(item('[data-slot="translation-cell-kept-p1#4"]')?.textContent).toContain(
      'kept as the original (references are not translated)'
    )
    // 三种状态在 DOM 上也各是各的（不只是措辞不同）。
    expect(item('[data-slot="translation-cell-p1#2"]')?.getAttribute('data-kind')).toBe('missing')
    expect(item('[data-slot="translation-cell-p1#3"]')?.getAttribute('data-kind')).toBe('failed')
    expect(item('[data-slot="translation-cell-kept-p1#4"]')?.getAttribute('data-kind')).toBe('kept')
  })

  it('A3 回跳：点译文格子标出**同一行**的原文格子，再点一次取消', () => {
    render()
    expect(item('[data-slot="translation-source-p1#2"]')?.getAttribute('data-highlighted')).toBe(
      'false'
    )

    act(() => {
      item('[data-slot="translation-cell-p1#2"]')?.click()
    })
    expect(item('[data-slot="translation-source-p1#2"]')?.getAttribute('data-highlighted')).toBe(
      'true'
    )
    // 只标这一行。
    expect(item('[data-slot="translation-source-p1#1"]')?.getAttribute('data-highlighted')).toBe(
      'false'
    )

    act(() => {
      item('[data-slot="translation-cell-p1#2"]')?.click()
    })
    expect(item('[data-slot="translation-source-p1#2"]')?.getAttribute('data-highlighted')).toBe(
      'false'
    )
  })

  it('A6 逐页状态：没文本层的页与还没翻的页在屏上是两句不同的话', () => {
    render(
      <Harness
        pageStatuses={[
          {
            page: 1,
            kind: 'partial',
            paragraphs: 4,
            translated: 1,
            failed: 1,
            missing: 1,
            labelKey: 'translation.page.partial'
          },
          {
            page: 2,
            kind: 'no-text-layer',
            paragraphs: 0,
            translated: 0,
            failed: 0,
            missing: 0,
            labelKey: 'translation.page.noTextLayer'
          },
          {
            page: 3,
            kind: 'untranslated',
            paragraphs: 2,
            translated: 0,
            failed: 0,
            missing: 2,
            labelKey: 'translation.page.untranslated'
          }
        ]}
      />
    )
    const noTextLayer = item('[data-slot="translation-page-status-2"]')
    const untranslated = item('[data-slot="translation-page-status-3"]')
    expect(noTextLayer?.textContent).toContain('no text layer on this page — not translated')
    // 「0/0」配上「没有文本层」—— 数字与话一起上屏，读者能复查。
    expect(noTextLayer?.textContent).toContain('0/0')
    expect(noTextLayer?.getAttribute('data-kind')).toBe('no-text-layer')
    expect(untranslated?.textContent).toContain('not translated yet')
    expect(untranslated?.textContent).toContain('0/2')
    expect(untranslated?.getAttribute('data-kind')).toBe('untranslated')
  })

  it('A4 术语偏离按段落具名上屏（术语 + 认可的写法）', () => {
    render(
      <Harness
        terminologyDeviations={[
          { unitId: 'p1#1', english: 'aspirin', accepted: ['阿司匹林', '乙酰水杨酸'] }
        ]}
      />
    )
    const deviation = item('[data-slot="translation-deviation-p1#1"]')
    expect(deviation?.textContent).toContain('aspirin')
    expect(deviation?.textContent).toContain('阿司匹林 / 乙酰水杨酸')
    // 没偏离的段落不显示这一行。
    expect(item('[data-slot="translation-deviation-p1#2"]')).toBeNull()
  })

  it('A7 导出按钮：接上了才有、有行才显示、点了会回调；没接就完全不渲染', () => {
    const onExport = vi.fn()
    render(<Harness onExportContrast={onExport} />)
    act(() => {
      item('[data-slot="translation-export"]')?.click()
    })
    expect(onExport).toHaveBeenCalledTimes(1)

    // 没接上导出 ⇒ 不渲染这个按钮（不做一个点了没反应的控件）。
    render(<Harness />)
    expect(item('[data-slot="translation-export"]')).toBeNull()

    // 一行都没有 ⇒ 也没有可导出的东西。
    render(<Harness rows={[]} onExportContrast={onExport} />)
    expect(item('[data-slot="translation-export"]')).toBeNull()
  })
})
