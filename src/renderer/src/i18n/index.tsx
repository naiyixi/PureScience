import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import { dictionaries, LOCALE_TAG, languageFromLocale, type Language } from './languages'

export type { Language, LanguageInfo, TranslationKey } from './languages'

const STORAGE_KEY = 'purescience-language'

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

type LanguageContextValue = {
  lang: Language
  setLang: (lang: Language) => void
  // Optional interpolation variables replace `{name}` placeholders in the resolved string.
  t: (key: keyof typeof dictionaries.en, vars?: Record<string, string | number>) => string
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
        const text = dictionaries[lang][key] ?? dictionaries.en[key] ?? key
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
    t: (key) => dictionaries.en[key] ?? key
  }
}

// LanguageProvider is a context provider (JSX, must live in a .tsx); useLanguage is its public
// consumer hook and LanguageProvider is its only mount point, so both must export from this file.
// Splitting them would force every consumer through two imports for no HMR benefit.
// eslint-disable-next-line react-refresh/only-export-components
export { LanguageProvider, useLanguage }
