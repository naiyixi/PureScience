import { de } from './de'
import { en } from './en'
import { es } from './es'
import { fr } from './fr'
import { ja } from './ja'
import { ko } from './ko'
import { ru } from './ru'
import { zh } from './zh'
import { zhHant } from './zh-Hant'

export type Language = 'zh' | 'zh-Hant' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'ru'

export type TranslationKey = keyof typeof en

// Every dictionary is a PARTIAL map over the English keys: a missing key falls back to English, so a
// newly added key never leaves a language with a blank/garbled string. This mirrors the reference
// product's i18n mechanism (English strings as keys + English fallback) and lets each language ship
// incrementally.
type Dictionary = Partial<Record<TranslationKey, string>>

export const dictionaries: Record<Language, Dictionary> = {
  zh,
  'zh-Hant': zhHant,
  en,
  ja,
  ko,
  fr,
  de,
  es,
  ru
}

export type LanguageInfo = {
  id: Language
  // Native endonym shown in the language picker (e.g. 繁體中文 for zh-Hant).
  label: string
}

// The ordered language list rendered by the settings picker. Native endonyms only — a user who cannot
// read English should still find their language.
export const LANGUAGES: readonly LanguageInfo[] = [
  { id: 'zh', label: '简体中文' },
  { id: 'zh-Hant', label: '繁體中文' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
  { id: 'ko', label: '한국어' },
  { id: 'fr', label: 'Français' },
  { id: 'de', label: 'Deutsch' },
  { id: 'es', label: 'Español' },
  { id: 'ru', label: 'Русский' }
]

// Document-level locale tag for each supported language (drives spellcheck/direction hints).
export const LOCALE_TAG: Record<Language, string> = {
  zh: 'zh-CN',
  'zh-Hant': 'zh-TW',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  fr: 'fr',
  de: 'de',
  es: 'es',
  ru: 'ru'
}

// Maps the browser's navigator.language (e.g. 'zh-TW', 'ja-JP') onto the supported set.
export const languageFromLocale = (locale: string): Language | undefined => {
  const normalized = locale.toLowerCase()
  if (normalized.startsWith('zh')) {
    if (normalized.includes('tw') || normalized.includes('hk') || normalized.includes('hant')) {
      return 'zh-Hant'
    }
    return 'zh'
  }
  if (normalized.startsWith('ja')) return 'ja'
  if (normalized.startsWith('ko')) return 'ko'
  if (normalized.startsWith('fr')) return 'fr'
  if (normalized.startsWith('de')) return 'de'
  if (normalized.startsWith('es')) return 'es'
  if (normalized.startsWith('ru')) return 'ru'
  return undefined
}
