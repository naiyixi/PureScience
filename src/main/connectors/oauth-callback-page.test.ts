import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OAuthCallbackServer } from './oauth-client'
import { NATIVE_LOCALE_CODES } from '../native-locale'

const getLocale = vi.fn<() => string>(() => 'en-US')

vi.mock('electron', () => ({
  app: {
    getLocale: () => getLocale()
  }
}))

let server: OAuthCallbackServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

beforeEach(() => {
  getLocale.mockReset()
  getLocale.mockReturnValue('en-US')
})

// Drives the real loopback listener the way the browser does, so the assertion is on the bytes the
// user actually sees rather than on a private render function.
const startServer = async (): Promise<string> => {
  server ??= new OAuthCallbackServer()
  return server.ensureStarted()
}

const hitUnknownState = async (): Promise<{ status: number; body: string }> => {
  const redirectUrl = await startServer()
  const response = await fetch(`${redirectUrl}?code=wrong&state=unknown`)
  return { status: response.status, body: await response.text() }
}

describe('OAuth callback page language', () => {
  it('keeps the English copy byte-for-byte for every outcome', async () => {
    const redirectUrl = await startServer()

    const waitingComplete = server?.waitFor('state-ok')
    const completeResponse = await fetch(`${redirectUrl}?code=code-1&state=state-ok`)
    const completeBody = await completeResponse.text()
    expect(completeResponse.status).toBe(200)
    expect(completeBody).toContain('<h1>Authorization complete</h1>')
    expect(completeBody).toContain('<p>You can close this window.</p>')
    expect(completeBody).toContain('<html lang="en">')
    await waitingComplete?.promise

    const waitingError = server?.waitFor('state-err')
    const failedResponse = await fetch(`${redirectUrl}?error=access_denied&state=state-err`)
    const failedBody = await failedResponse.text()
    expect(failedResponse.status).toBe(400)
    expect(failedBody).toContain('<h1>Authorization failed</h1>')
    expect(failedBody).toContain('<p>You can close this window.</p>')
    await waitingError?.promise

    const expired = await hitUnknownState()
    expect(expired.status).toBe(400)
    expect(expired.body).toContain('<h1>PureScience authorization expired</h1>')
    expect(expired.body).toContain('<p>You can close this window.</p>')
  })

  it('serves a reader of another language their own copy', async () => {
    getLocale.mockReturnValue('zh-TW')
    const expired = await hitUnknownState()
    expect(expired.body).toContain('<h1>PureScience 授權已過期</h1>')
    expect(expired.body).toContain('可以關閉此視窗。')
    expect(expired.body).toContain('<html lang="zh-Hant">')
    expect(expired.body).not.toContain('You can close this window.')

    getLocale.mockReturnValue('zh-CN')
    const zh = await hitUnknownState()
    expect(zh.body).toContain('PureScience 授权已过期')
    expect(zh.body).toContain('<html lang="zh">')

    getLocale.mockReturnValue('de-DE')
    const de = await hitUnknownState()
    expect(de.body).toContain('PureScience-Autorisierung abgelaufen')
    expect(de.body).toContain('<html lang="de">')
  })

  it('leaves no shipped language on the English copy', async () => {
    for (const code of NATIVE_LOCALE_CODES) {
      getLocale.mockReturnValue(code)
      const { body } = await hitUnknownState()
      expect(body).toContain(`<html lang="${code}">`)
      if (code === 'en') {
        expect(body).toContain('PureScience authorization expired')
        continue
      }
      expect(body, `${code} fell back to English`).not.toContain(
        'PureScience authorization expired'
      )
      expect(body).not.toContain('You can close this window.')
    }
  })
})
