import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import { en } from './en'
import { zh } from './zh'
import { zhHant } from './zh-Hant'
import { ja } from './ja'
import { ko } from './ko'
import { fr } from './fr'
import { de } from './de'
import { es } from './es'
import { ru } from './ru'

export type Language = 'zh' | 'zh-Hant' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'ru'

export type TranslationKey = keyof typeof en

// Every dictionary is a PARTIAL map over the English keys: a missing key falls back to English, so a
// newly added key never leaves a language with a blank/garbled string. This mirrors the reference
// product's i18n mechanism (English strings as keys + English fallback) and lets each language ship
// incrementally.
type Dictionary = Partial<Record<TranslationKey, string>>

const dictionaries: Record<Language, Dictionary> = { zh, 'zh-Hant': zhHant, en, ja, ko, fr, de, es, ru }

const STORAGE_KEY = 'purescience-language'

// Maps the browser's navigator.language (e.g. 'zh-TW', 'ja-JP') onto the supported set.
const languageFromLocale = (locale: string): Language | undefined => {
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

const detectInitialLanguage = (): Language => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored && stored in dictionaries) return stored as Language
    const system = window.navigator.language ?? ''
    return languageFromLocale(system) ?? 'en'
  } catch {
    return 'en'
  }
}

// Document-level locale tag for each supported language (drives spellcheck/direction hints).
const LOCALE_TAG: Record<Language, string> = {
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

type LanguageContextValue = {
  lang: Language
  setLang: (lang: Language) => void
  // Optional interpolation variables replace `{name}` placeholders in the resolved string.
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string
}

const LanguageContext = createContext<LanguageContextValue | null>(null)

const LanguageProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const [lang, setLangState] = useState<Language>(detectInitialLanguage)

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, lang)
    } catch {
      // storage unavailable — keep the in-memory selection
    }
    document.documentElement.lang = LOCALE_TAG[lang]
  }, [lang])

  const value = useMemo<LanguageContextValue>(
    () => ({
      lang,
      setLang: setLangState,
      t: (key, vars) => {
        const text = dictionaries[lang][key] ?? en[key] ?? key
        if (!vars) return text
        return text.replace(/\{(\w+)\}/g, (match, name: string) =>
          name in vars ? String(vars[name]) : match
        )
      }
    }),
    [lang]
  )

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

const useLanguage = (): LanguageContextValue => {
  // 某些测试/渲染环境 (如 react 双实例或非 jsdom 渲染) 会让 useContext 抛错; 容错回退英文,
  // 真实 app 始终有 LanguageProvider。
  try {
    const ctx = useContext(LanguageContext)
    if (ctx) return ctx
  } catch {
    // fall through to the English default
  }
  return {
    lang: 'en',
    setLang: () => {},
    t: (key) => en[key] ?? key
  }
}

export { LanguageProvider, useLanguage }
