import { describe, expect, it } from 'vitest'

import { SUPPORTED_LOCALE_CODES } from '../../../shared/locale-codes'

import {
  LANGUAGES,
  LOCALE_TAG,
  dictionaries,
  languageFromLocale,
  resolveSystemLanguage
} from './languages'

// The renderer used to spell the nine languages out itself. It now takes them from
// `src/shared/locale-codes.ts`, which the native menu/tray tables and the served pages also read — so
// these assertions pin the three places that must move together: the dictionary map, the picker list
// and the per-language document tag.
describe('shipped languages', () => {
  it('keys the dictionaries by exactly the shared set', () => {
    expect(Object.keys(dictionaries).sort()).toEqual([...SUPPORTED_LOCALE_CODES].sort())
  })

  it('offers every shipped language in the picker, in the same order as the shared list', () => {
    expect(LANGUAGES.map((entry) => entry.id)).toEqual([...SUPPORTED_LOCALE_CODES])
  })

  it('has a document locale tag for every shipped language', () => {
    expect(Object.keys(LOCALE_TAG).sort()).toEqual([...SUPPORTED_LOCALE_CODES].sort())
  })
})

describe('languageFromLocale', () => {
  it('maps the tags a browser reports', () => {
    expect(languageFromLocale('zh-CN')).toBe('zh')
    expect(languageFromLocale('zh-TW')).toBe('zh-Hant')
    expect(languageFromLocale('zh-HK')).toBe('zh-Hant')
    // Macau writes Traditional Chinese. This used to answer Simplified here while the native menu drew
    // Traditional for the same OS locale; both now come from one cascade.
    expect(languageFromLocale('zh-MO')).toBe('zh-Hant')
    expect(languageFromLocale('ja-JP')).toBe('ja')
    expect(languageFromLocale('de-DE')).toBe('de')
    expect(languageFromLocale('pt-BR')).toBeUndefined()
  })

  it('resolves the system preference to English when the browser asks for a language we do not ship', () => {
    // jsdom's navigator.language is 'en-US' unless a test says otherwise, which is exactly the
    // unsupported-falls-back-to-English path.
    expect(SUPPORTED_LOCALE_CODES).toContain(resolveSystemLanguage())
  })
})
