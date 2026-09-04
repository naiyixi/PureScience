import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import {
  dictionaries,
  LOCALE_TAG,
  resolveSystemLanguage,
  type Language,
  type LanguagePreference
} from './languages'
import { setUiLocale } from '@/lib/ui-locale'
import { setRelativeTimeLanguage } from '@/lib/format-relative-time'

export type { Language, LanguageInfo, LanguagePreference, TranslationKey } from './languages'

// Holds the *preference* ('system' or an explicit language). The context below additionally exposes
// the resolved concrete language so consumers render through one `lang` value.
const STORAGE_KEY = 'purescience-language'

const readStoredPreference = (): LanguagePreference => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'system') return 'system'
    if (stored && stored in dictionaries) return stored as Language
  } catch {
    // storage unavailable — fall through to the system default
  }
  // Default follows the system so the first launch matches the OS language (mirrors the reference
  // product's DEFAULT_LANGUAGE_PREFERENCE = 'system').
  return 'system'
}

type LanguageContextValue = {
  // The concrete language currently in effect ('system' has already been resolved against the
  // runtime locale). Consumers should render from this value.
  lang: Language
  // The stored preference ('system' or an explicit language) for pickers that show a checkmark.
  preference: LanguagePreference
  setLang: (preference: LanguagePreference) => void
  // Optional interpolation variables replace `{name}` placeholders in the resolved string.
  t: (key: keyof typeof dictionaries.en, vars?: Record<string, string | number>) => string
}

const LanguageContext = createContext<LanguageContextValue | null>(null)

const LanguageProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const [preference, setPreference] = useState<LanguagePreference>(readStoredPreference)
  // The live system language; only consulted while preference === 'system'. Re-resolved when the
  // runtime fires `languagechange` (OS/browser locale change), so "follow system" keeps working
  // without a reload.
  const [systemLang, setSystemLang] = useState<Language>(resolveSystemLanguage)

  const lang: Language = preference === 'system' ? systemLang : preference

  useEffect(() => {
    const onLanguageChange = (): void => setSystemLang(resolveSystemLanguage())
    window.addEventListener('languagechange', onLanguageChange)
    return () => window.removeEventListener('languagechange', onLanguageChange)
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, preference)
    } catch {
      // storage unavailable — keep the in-memory selection
    }
    // lang is derived; recompute on preference change is enough — document.lang follows the effect
    // below which depends on `lang`.
  }, [preference])

  useEffect(() => {
    document.documentElement.lang = LOCALE_TAG[lang]
    // Dense relative labels ("2周" vs "2w") follow the same concrete language.
    setRelativeTimeLanguage(lang)
    setUiLocale(LOCALE_TAG[lang])
  }, [lang])

  const value = useMemo<LanguageContextValue>(
    () => ({
      lang,
      preference,
      setLang: setPreference,
      t: (key, vars) => {
        const text = dictionaries[lang][key] ?? dictionaries.en[key] ?? key
        if (!vars) return text
        return text.replace(/\{(\w+)\}/g, (match, name: string) =>
          name in vars ? String(vars[name]) : match
        )
      }
    }),
    [lang, preference]
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
    preference: 'en',
    setLang: () => {},
    t: (key) => dictionaries.en[key] ?? key
  }
}

// LanguageProvider is a context provider (JSX, must live in a .tsx); useLanguage is its public
// consumer hook and LanguageProvider is its only mount point, so both must export from this file.
// Splitting them would force every consumer through two imports for no HMR benefit.
// eslint-disable-next-line react-refresh/only-export-components
export { LanguageProvider, useLanguage }
