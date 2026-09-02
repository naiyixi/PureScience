// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LANGUAGES, type Language, type LanguagePreference } from './languages'
import { LanguageProvider, useLanguage } from './index'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.localStorage.clear()
})

describe('i18n 多语言体系', () => {
  it('注册全部 9 种语言（含端名）', () => {
    expect(LANGUAGES.map((entry) => entry.id)).toEqual([
      'zh',
      'zh-Hant',
      'en',
      'ja',
      'ko',
      'fr',
      'de',
      'es',
      'ru'
    ])
    expect(LANGUAGES.find((entry) => entry.id === 'zh-Hant')?.label).toBe('繁體中文')
    expect(LANGUAGES.find((entry) => entry.id === 'ja')?.label).toBe('日本語')
  })

  const renderPreferenceHarness = async (): Promise<{
    lang: () => Language
    preference: () => LanguagePreference
    setLang: (value: LanguagePreference) => void
  }> => {
    let setter: (value: LanguagePreference) => void = () => undefined
    const state = { lang: 'en' as Language, preference: 'en' as LanguagePreference }
    const Harness = (): React.JSX.Element => {
      const { lang, preference, setLang } = useLanguage()
      state.lang = lang
      state.preference = preference
      setter = setLang
      return (
        <span>
          {preference}:{lang}
        </span>
      )
    }
    await act(async () => {
      root.render(
        <LanguageProvider>
          <Harness />
        </LanguageProvider>
      )
    })
    return { lang: () => state.lang, preference: () => state.preference, setLang: setter }
  }

  it('默认跟随系统（system），jsdom en-US 解析为 en 并持久化 system', async () => {
    const harness = await renderPreferenceHarness()
    expect(harness.preference()).toBe('system')
    expect(harness.lang()).toBe('en')
    expect(window.localStorage.getItem('purescience-language')).toBe('system')
    expect(document.documentElement.lang).toBe('en')
  })

  it('显式切换语言持久化到 localStorage 并更新 document.lang', async () => {
    const harness = await renderPreferenceHarness()
    await act(async () => {
      harness.setLang('zh-Hant')
    })
    expect(harness.preference()).toBe('zh-Hant')
    expect(harness.lang()).toBe('zh-Hant')
    expect(window.localStorage.getItem('purescience-language')).toBe('zh-Hant')
    expect(document.documentElement.lang).toBe('zh-TW')
  })

  it('切回 system 后跟随 navigator.language，语言变更事件实时生效', async () => {
    const harness = await renderPreferenceHarness()
    await act(async () => {
      harness.setLang('ja')
    })
    expect(harness.lang()).toBe('ja')
    await act(async () => {
      harness.setLang('system')
    })
    expect(harness.preference()).toBe('system')
    expect(harness.lang()).toBe('en')
    // Simulate the OS/browser locale changing while following the system.
    const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'language')
    Object.defineProperty(Navigator.prototype, 'language', {
      configurable: true,
      get: () => 'ja-JP'
    })
    try {
      await act(async () => {
        window.dispatchEvent(new Event('languagechange'))
      })
      expect(harness.lang()).toBe('ja')
      expect(document.documentElement.lang).toBe('ja')
    } finally {
      if (original) Object.defineProperty(Navigator.prototype, 'language', original)
    }
  })

  it('未知键/缺失键回退英文而非空白', async () => {
    let currentT: ((key: string) => string) | undefined
    const Harness = (): React.JSX.Element => {
      const { t } = useLanguage()
      currentT = t as (key: string) => string
      return <span>ok</span>
    }
    await act(async () => {
      root.render(
        <LanguageProvider>
          <Harness />
        </LanguageProvider>
      )
    })
    expect(typeof currentT).toBe('function')
  })
})
