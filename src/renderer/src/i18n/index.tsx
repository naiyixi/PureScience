import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import { en } from './en'
import { zh } from './zh'

export type Language = 'zh' | 'en'

export type TranslationKey = keyof typeof zh

type Dictionary = Record<TranslationKey, string>

const dictionaries: Record<Language, Dictionary> = { zh, en }

const STORAGE_KEY = 'purescience-language'

const detectInitialLanguage = (): Language => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'zh' || stored === 'en') return stored
    const system = window.navigator.language?.toLowerCase() ?? ''
    return system.startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'zh'
  }
}

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
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])

  const value = useMemo<LanguageContextValue>(
    () => ({
      lang,
      setLang: setLangState,
      t: (key, vars) => {
        const text = dictionaries[lang][key] ?? key
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

export { LanguageProvider, useLanguage }
export type { LanguageContextValue }
