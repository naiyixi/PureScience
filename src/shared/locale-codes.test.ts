import { describe, expect, it } from 'vitest'

import { APP_MENU_LABELS, appMenuLabelsForLocale } from './app-menu-labels'
import {
  SUPPORTED_LOCALE_CODES,
  localeCodeFromTag,
  localeCodeFromTagOrUndefined
} from './locale-codes'
import { TRAY_LABELS, trayLabelsForLocale } from './tray-labels'

// The nine languages are one set shared by the renderer dictionaries, the native menu/tray tables and
// the served pages. These assertions are the runtime half of the compile-time gate: the types say a
// table cannot be short a language, and these say a table that *has* nine keys really translated them
// instead of pasting the English row nine times.

describe('the shipped language set', () => {
  it('holds nine distinct codes, each of which resolves to itself', () => {
    expect(SUPPORTED_LOCALE_CODES.length).toBe(9)
    expect(new Set(SUPPORTED_LOCALE_CODES).size).toBe(9)
    for (const code of SUPPORTED_LOCALE_CODES) {
      expect(localeCodeFromTag(code)).toBe(code)
    }
  })

  it('keeps every table keyed by exactly that set', () => {
    const expected = [...SUPPORTED_LOCALE_CODES].sort()
    expect(Object.keys(TRAY_LABELS).sort()).toEqual(expected)
    expect(Object.keys(APP_MENU_LABELS).sort()).toEqual(expected)
  })
})

describe('localeCodeFromTag', () => {
  it('reads Traditional Chinese from the script subtag and from the regions that write it', () => {
    for (const tag of ['zh-Hant', 'zh-Hant-TW', 'zh-TW', 'zh-HK', 'zh-MO', 'zh_TW', 'ZH-TW']) {
      expect(localeCodeFromTag(tag)).toBe('zh-Hant')
    }
  })

  it('keeps Simplified Chinese for the rest of the zh tags', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-Hans', 'zh-Hans-CN', 'zh-SG']) {
      expect(localeCodeFromTag(tag)).toBe('zh')
    }
  })

  it('maps the other shipped languages by primary subtag', () => {
    expect(localeCodeFromTag('en-US')).toBe('en')
    expect(localeCodeFromTag('ja-JP')).toBe('ja')
    expect(localeCodeFromTag('ko-KR')).toBe('ko')
    expect(localeCodeFromTag('fr-CA')).toBe('fr')
    expect(localeCodeFromTag('de-DE')).toBe('de')
    expect(localeCodeFromTag('es-419')).toBe('es')
    expect(localeCodeFromTag('ru-RU')).toBe('ru')
  })

  it('answers undefined for a language this product does not ship, and English when it must draw', () => {
    for (const tag of ['pt-BR', 'ar-EG', 'klingon', '']) {
      expect(localeCodeFromTagOrUndefined(tag)).toBeUndefined()
      expect(localeCodeFromTag(tag)).toBe('en')
    }
  })
})

describe('native tables under every shipped language', () => {
  // A fallback is indistinguishable from a translation at the call site, so the check has to be about
  // the content: for every language other than English at least one label must differ from English.
  const differs = (a: Record<string, string>, b: Record<string, string>): boolean =>
    Object.keys(a).some((key) => a[key] !== b[key])

  it('gives the tray a real translation for each of the eight non-English languages', () => {
    const english = trayLabelsForLocale('en')
    for (const code of SUPPORTED_LOCALE_CODES) {
      const labels = trayLabelsForLocale(code)
      expect(labels.show.length).toBeGreaterThan(0)
      if (code === 'en') {
        expect(labels).toEqual(english)
      } else {
        expect(differs(labels, english)).toBe(true)
      }
    }
  })

  it('gives the application menu a real translation for each of the eight non-English languages', () => {
    const english = appMenuLabelsForLocale('en')
    for (const code of SUPPORTED_LOCALE_CODES) {
      const labels = appMenuLabelsForLocale(code)
      expect(labels.file.length).toBeGreaterThan(0)
      if (code === 'en') {
        expect(labels).toEqual(english)
      } else {
        expect(differs(labels, english)).toBe(true)
      }
    }
  })

  it('has the tray and the menu answer from the same code for the same tag', () => {
    // Both delegate to the shared cascade now; before that they disagreed on zh-MO (the menu drew
    // Traditional, the tray and the native dialogs drew Simplified). Comparing table identity per tag
    // is what makes that impossible to reintroduce in one of them alone.
    for (const tag of ['zh-MO', 'zh-TW', 'zh-CN', 'pt-BR', 'ja-JP', 'en-GB', '']) {
      const code = localeCodeFromTag(tag)
      expect(trayLabelsForLocale(tag)).toBe(trayLabelsForLocale(code))
      expect(appMenuLabelsForLocale(tag)).toBe(appMenuLabelsForLocale(code))
    }
  })
})
