import { describe, expect, it } from 'vitest'

import { citationStyleLabel } from './types'

// The catalogue carries one name per language for every built-in style. The picker, the export button,
// the copy tooltip and the side-by-side comparison all go through this one accessor, so the rule that
// decides which name a window shows is worth pinning on its own: a Chinese name reaching an English
// window is a localization defect a reader sees immediately, and one that no formatting test catches.
const style = { label: 'APA 7th', labelZh: 'APA 第 7 版' }

describe('citationStyleLabel', () => {
  it('names a style in the language the window is being read in', () => {
    expect(citationStyleLabel(style, 'zh')).toBe('APA 第 7 版')
    expect(citationStyleLabel(style, 'zh-Hant')).toBe('APA 第 7 版')
  })

  it('leaves every other interface with the English catalogue name', () => {
    for (const language of ['en', 'ja', 'ko', 'fr', 'de', 'es', 'ru']) {
      expect(citationStyleLabel(style, language)).toBe('APA 7th')
    }
  })

  it('falls back to English when there is no language at all', () => {
    // A render without a language provider (and the dictionaries themselves) fall back to English, so
    // the name must follow that same fallback rather than showing `undefined` or the Chinese field.
    expect(citationStyleLabel(style, undefined)).toBe('APA 7th')
  })

  it('is the same name for an imported style, which derives both fields from its own document', () => {
    const imported = {
      label: 'PureScience Acceptance Style',
      labelZh: 'PureScience Acceptance Style'
    }
    expect(citationStyleLabel(imported, 'zh')).toBe('PureScience Acceptance Style')
    expect(citationStyleLabel(imported, 'en')).toBe('PureScience Acceptance Style')
  })
})
