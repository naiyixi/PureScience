import { describe, expect, it } from 'vitest'

import {
  NEUTRAL_BACKGROUND_DELIVERY_LABELS,
  type BackgroundDeliveryLabels
} from './background-delivery'
import {
  BACKGROUND_DELIVERY_LABELS_BY_LOCALE,
  backgroundDeliveryLabelsFor
} from './background-delivery-labels'

// Mirrors src/renderer/src/i18n/languages.ts: every language the interface ships, and nothing else.
const SHIPPED_LOCALES = ['en', 'zh', 'zh-Hant', 'ja', 'ko', 'fr', 'de', 'es', 'ru']

const stateKeys = Object.keys(NEUTRAL_BACKGROUND_DELIVERY_LABELS.stateNames)
const reasonKeys = Object.keys(NEUTRAL_BACKGROUND_DELIVERY_LABELS.reasonNames)

describe('background delivery labels', () => {
  it('ships exactly the languages the interface ships', () => {
    expect(Object.keys(BACKGROUND_DELIVERY_LABELS_BY_LOCALE).sort()).toEqual(
      [...SHIPPED_LOCALES].sort()
    )
  })

  it('names every state and every reason in every language, with no blank text', () => {
    for (const [locale, labels] of Object.entries(BACKGROUND_DELIVERY_LABELS_BY_LOCALE)) {
      expect(Object.keys(labels.stateNames).sort(), locale).toEqual([...stateKeys].sort())
      expect(Object.keys(labels.reasonNames).sort(), locale).toEqual([...reasonKeys].sort())
      const strings = [
        labels.header,
        labels.state,
        labels.job,
        labels.files,
        labels.fingerprint,
        labels.reason,
        labels.continuation,
        labels.noResult,
        ...Object.values(labels.stateNames),
        ...Object.values(labels.reasonNames)
      ]
      for (const text of strings) {
        expect(text.trim().length, `${locale}: ${JSON.stringify(text)}`).toBeGreaterThan(0)
      }
    }
  })

  // A translation that is still the English sentence is an untranslated stub, which is exactly what
  // "the continuation follows the interface language" is supposed to rule out.
  it('is actually translated off English', () => {
    for (const locale of SHIPPED_LOCALES.filter((key) => key !== 'en')) {
      const labels = BACKGROUND_DELIVERY_LABELS_BY_LOCALE[locale]
      expect(labels.header, locale).not.toBe(NEUTRAL_BACKGROUND_DELIVERY_LABELS.header)
      expect(labels.continuation, locale).not.toBe(NEUTRAL_BACKGROUND_DELIVERY_LABELS.continuation)
      expect(labels.noResult, locale).not.toBe(NEUTRAL_BACKGROUND_DELIVERY_LABELS.noResult)
    }
  })

  it('resolves a stored tag to the closest shipped language', () => {
    const is = (locale: string | undefined, expected: BackgroundDeliveryLabels): void => {
      expect(backgroundDeliveryLabelsFor(locale), String(locale)).toBe(expected)
    }
    const byLocale = BACKGROUND_DELIVERY_LABELS_BY_LOCALE
    is('zh', byLocale.zh)
    is('zh-CN', byLocale.zh)
    is('zh-Hans-CN', byLocale.zh)
    is('zh-Hant', byLocale['zh-Hant'])
    is('zh-TW', byLocale['zh-Hant'])
    is('zh-HK', byLocale['zh-Hant'])
    is('ja-JP', byLocale.ja)
    is('ko_KR', byLocale.ko)
    is('de-AT', byLocale.de)
    is('ru-RU', byLocale.ru)
    is('EN-us', byLocale.en)
    is(undefined, byLocale.en)
    is('', byLocale.en)
    is('   ', byLocale.en)
    // An unrecognized language never renders as a half-empty record: it falls back to English.
    is('pt-BR', byLocale.en)
  })
})
