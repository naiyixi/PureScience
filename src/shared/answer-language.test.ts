import { describe, expect, it } from 'vitest'

import { answerLanguageDirective, answerLanguageForUiLanguage } from './answer-language'

describe('answer language', () => {
  it('resolves the interface language tags the renderer actually reports', () => {
    expect(answerLanguageForUiLanguage('zh-CN')).toBe('zh')
    expect(answerLanguageForUiLanguage('zh')).toBe('zh')
    expect(answerLanguageForUiLanguage('zh-Hans')).toBe('zh')
    expect(answerLanguageForUiLanguage('zh-TW')).toBe('zh-Hant')
    expect(answerLanguageForUiLanguage('zh-Hant')).toBe('zh-Hant')
    expect(answerLanguageForUiLanguage('ja-JP')).toBe('ja')
    expect(answerLanguageForUiLanguage('de_DE')).toBe('de')
  })

  it('injects nothing for an unsupported or missing tag', () => {
    // A Portuguese reader must not be told to answer in English: an absent fact injects no instruction.
    expect(answerLanguageForUiLanguage('pt-BR')).toBeUndefined()
    expect(answerLanguageForUiLanguage('')).toBeUndefined()
    expect(answerLanguageForUiLanguage(undefined)).toBeUndefined()
    expect(answerLanguageDirective('pt-BR')).toBeNull()
    expect(answerLanguageDirective(undefined)).toBeNull()
  })

  it('names the answer language with its own endonym and forbids switching mid-answer', () => {
    const directive = answerLanguageDirective('zh-CN')

    expect(directive).toContain('简体中文')
    expect(directive).toContain('Simplified Chinese')
    // The two clauses that stop the observed drift: translating identifiers, and following English
    // tool output into an English answer.
    expect(directive).toContain('verbatim')
    expect(directive).toMatch(/never answer in English/)
    expect(directive).toMatch(/never mix two languages/)
  })

  it('does not repeat the name when the target language is English', () => {
    expect(answerLanguageDirective('en-US')).toContain('in English.')
    expect(answerLanguageDirective('en-US')).not.toContain('English (English)')
  })

  it('gives Traditional Chinese speakers Traditional Chinese', () => {
    expect(answerLanguageDirective('zh-HK')).toContain('繁體中文')
    expect(answerLanguageDirective('zh-HK')).not.toContain('简体中文')
  })
})
