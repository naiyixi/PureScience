import { beforeEach, describe, expect, it, vi } from 'vitest'

const getLocale = vi.fn<() => string>(() => 'en-US')

vi.mock('electron', () => ({
  app: {
    getLocale: () => getLocale()
  }
}))

const { NATIVE_LOCALE_CODES, nativeLocaleCodeFrom, nativeStringsFor } =
  await import('./native-locale')

beforeEach(() => {
  getLocale.mockReset()
  getLocale.mockReturnValue('en-US')
})

describe('nativeLocaleCodeFrom', () => {
  it('maps the tags Electron actually reports onto the nine languages', () => {
    expect(nativeLocaleCodeFrom('en-US')).toBe('en')
    expect(nativeLocaleCodeFrom('en')).toBe('en')
    expect(nativeLocaleCodeFrom('zh-CN')).toBe('zh')
    expect(nativeLocaleCodeFrom('zh')).toBe('zh')
    expect(nativeLocaleCodeFrom('zh-Hans-CN')).toBe('zh')
    expect(nativeLocaleCodeFrom('zh-Hant')).toBe('zh-Hant')
    expect(nativeLocaleCodeFrom('zh-TW')).toBe('zh-Hant')
    expect(nativeLocaleCodeFrom('zh-HK')).toBe('zh-Hant')
    expect(nativeLocaleCodeFrom('ja-JP')).toBe('ja')
    expect(nativeLocaleCodeFrom('ja')).toBe('ja')
    expect(nativeLocaleCodeFrom('ko-KR')).toBe('ko')
    expect(nativeLocaleCodeFrom('es-419')).toBe('es')
    expect(nativeLocaleCodeFrom('de-DE')).toBe('de')
    expect(nativeLocaleCodeFrom('fr-CA')).toBe('fr')
    expect(nativeLocaleCodeFrom('ru-RU')).toBe('ru')
  })

  it('lands on English for a language this app does not ship, never on an empty label', () => {
    expect(nativeLocaleCodeFrom('pt-BR')).toBe('en')
    expect(nativeLocaleCodeFrom('klingon')).toBe('en')
    expect(nativeLocaleCodeFrom('')).toBe('en')
  })

  it('is case-insensitive', () => {
    expect(nativeLocaleCodeFrom('ZH-TW')).toBe('zh-Hant')
    expect(nativeLocaleCodeFrom('JA-jp')).toBe('ja')
  })

  it('round-trips every shipped code, so the list and the cascade cannot drift apart', () => {
    const corpus = [
      ...NATIVE_LOCALE_CODES,
      'zh-CN',
      'zh-Hans',
      'zh-TW',
      'zh-HK',
      'en-GB',
      'pt-BR',
      'ar-EG',
      ''
    ]
    for (const tag of corpus) {
      const code = nativeLocaleCodeFrom(tag)
      expect(NATIVE_LOCALE_CODES).toContain(code)
      expect(nativeLocaleCodeFrom(code)).toBe(code)
    }
    expect(new Set(NATIVE_LOCALE_CODES).size).toBe(NATIVE_LOCALE_CODES.length)
    expect(NATIVE_LOCALE_CODES.length).toBe(9)
  })
})

describe('nativeStringsFor', () => {
  const map = {
    en: 'close this window',
    zh: '可以关闭此窗口',
    'zh-Hant': '可以關閉此視窗',
    ja: 'このウィンドウを閉じてください',
    ko: '이 창을 닫아도 됩니다',
    es: 'puede cerrar esta ventana',
    de: 'Sie können dieses Fenster schließen',
    fr: 'vous pouvez fermer cette fenêtre',
    ru: 'окно можно закрыть'
  }

  it('returns the row for the app locale Electron reports', () => {
    getLocale.mockReturnValue('ja-JP')
    expect(nativeStringsFor(map)).toBe(map.ja)

    getLocale.mockReturnValue('zh-TW')
    expect(nativeStringsFor(map)).toBe(map['zh-Hant'])

    getLocale.mockReturnValue('fr')
    expect(nativeStringsFor(map)).toBe(map.fr)
  })

  it('falls back to English when the locale cannot be read at all', () => {
    getLocale.mockImplementation(() => {
      throw new Error('no app in this process')
    })
    expect(nativeStringsFor(map)).toBe(map.en)
  })

  it('falls back to English for an unsupported locale', () => {
    getLocale.mockReturnValue('pt-BR')
    expect(nativeStringsFor(map)).toBe(map.en)
  })
})
