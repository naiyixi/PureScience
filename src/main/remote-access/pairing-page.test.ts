import { beforeEach, describe, expect, it, vi } from 'vitest'

const getLocale = vi.fn<() => string>(() => 'en-US')

vi.mock('electron', () => ({
  app: {
    getLocale: () => getLocale()
  }
}))

const { renderPairingPage } = await import('./pairing-page')
const { NATIVE_LOCALE_CODES } = await import('../native-locale')

const render = (): string =>
  renderPairingPage({
    code: '4821-9930',
    browser: 'Safari',
    platform: 'iPhone',
    expiresAt: Date.now() + 60_000
  }).html

beforeEach(() => {
  getLocale.mockReset()
  getLocale.mockReturnValue('en-US')
})

describe('renderPairingPage', () => {
  it('keeps the English page byte-for-byte, so the existing pins still hold', () => {
    const html = render()
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('<title>Connect to PureScience</title>')
    expect(html).toContain('Approve this browser')
    expect(html).toContain('aria-label="Pairing code"')
    expect(html).toContain('<span>Waiting for approval…</span>')
    expect(html).toContain('setStatus(\'rejected\', "This request was rejected.");')
    expect(html).toContain(
      'setStatus(\'rejected\', "This pairing code has expired. Refresh the page to try again.");'
    )
  })

  it('serves the reader their own language, in the markup and in the page script', () => {
    getLocale.mockReturnValue('zh-TW')
    const html = render()
    expect(html).toContain('<html lang="zh-Hant">')
    expect(html).toContain('批准此瀏覽器')
    expect(html).toContain('等待批准…')
    expect(html).toContain('setStatus(\'rejected\', "此配對碼已過期。重新整理頁面後再試。");')

    getLocale.mockReturnValue('zh-CN')
    expect(render()).toContain('批准此浏览器')
    expect(render()).toContain('<html lang="zh">')

    getLocale.mockReturnValue('ja-JP')
    expect(render()).toContain('このブラウザーを承認')

    getLocale.mockReturnValue('fr-FR')
    expect(render()).toContain('Approuver ce navigateur')
  })

  it('leaves no shipped language on the English copy', () => {
    for (const code of NATIVE_LOCALE_CODES) {
      getLocale.mockReturnValue(code)
      const html = render()
      if (code === 'en') {
        expect(html).toContain('Approve this browser')
        continue
      }
      expect(html, `${code} fell back to English`).not.toContain('Approve this browser')
      expect(html).not.toContain('Waiting for approval…')
      expect(html).toContain(`<html lang="${code}">`)
    }
  })

  it('still escapes what the request carries', () => {
    const html = renderPairingPage({
      code: '<script>alert(1)</script>',
      browser: '"Safari"',
      platform: 'iPhone',
      expiresAt: Date.now() + 60_000
    }).html
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&quot;Safari&quot;')
  })
})
