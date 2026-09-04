import { describe, expect, it } from 'vitest'

import { localizeRemoteMessage, REMOTE_ERROR_KEYS } from './remote-error-catalog'

const zhT = (key: string): string =>
  ({ 'remoteError.appNotInstalled': '远程访问应用未安装。' })[key] ?? key

describe('remote-error-catalog', () => {
  it('maps every documented main-process message to a key', () => {
    expect(Object.keys(REMOTE_ERROR_KEYS).length).toBeGreaterThanOrEqual(33)
    for (const [message, key] of Object.entries(REMOTE_ERROR_KEYS)) {
      expect(message.length).toBeGreaterThan(10)
      expect(key.startsWith('remoteError.')).toBe(true)
    }
  })

  it('localizes a known message through the translator', () => {
    expect(
      localizeRemoteMessage(
        zhT,
        'The remote access app is not installed. Install the desktop app, sign in, then detect again.'
      )
    ).toBe('远程访问应用未安装。')
  })

  it('passes unmapped messages through unchanged', () => {
    expect(localizeRemoteMessage(zhT, 'Some OS-level error')).toBe('Some OS-level error')
  })
})
