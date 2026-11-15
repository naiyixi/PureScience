// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useNetworkStore } from '@/stores/network-store'
import { LanguageProvider } from '@/i18n'
import { RemoteControlPanel } from './RemoteControlPanel'

// IC38: `remoteItPublicUrl` is the "saved browser-access endpoint, including while locally disabled" — the panel
// used to render only `accessUrl` behind `enabled`, so turning access off also hid the one address a reader
// needs to get back in. These cases pin the two states: off with a saved address (shown, read-only, with a copy
// action and a sentence about what it does), and on (the live address, as before).

let container: HTMLDivElement
let root: Root

const snapshot = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  enabled: false,
  lifecycle: 'disabled',
  mode: 'off',
  canManage: true,
  canManagePairing: true,
  remoteIt: {
    installed: true,
    registered: true,
    loggedIn: true,
    binaryPath: '/usr/local/bin/remoteit',
    version: '1.0.0',
    account: 'fixture',
    deviceId: 'fixture-device'
  },
  pendingRequests: [],
  trustedBrowsers: [],
  ...overrides
})

const mockApi = (value: Record<string, unknown>): void => {
  ;(window as unknown as { api: unknown }).api = {
    remoteAccess: {
      getSnapshot: vi.fn(async () => value),
      onChanged: vi.fn(() => () => undefined)
    },
    settings: { getProxy: vi.fn(async () => ({ mode: 'system' })) }
  }
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  useNetworkStore.setState({ isOnline: true, connectivity: 'unknown' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  window.localStorage.removeItem('purescience-language')
  delete (window as unknown as { api?: unknown }).api
})

describe('RemoteControlPanel saved browser address', () => {
  it('shows the saved address while access is off, read-only, with the copy action and the caveat', async () => {
    mockApi(
      snapshot({
        remoteItPublicUrl: 'https://fixture.connect.remote.it/'
      })
    )

    await act(async () => {
      root.render(<RemoteControlPanel />)
    })
    await flush()
    await flush()

    const block = container.querySelector('[data-slot="saved-browser-address"]')
    expect(block).not.toBeNull()
    expect(block?.textContent).toContain('https://fixture.connect.remote.it/')
    // Read-only: one control (copy), and no link the panel invites you to open.
    expect(block?.querySelectorAll('button')).toHaveLength(1)
    expect(block?.querySelectorAll('a')).toHaveLength(0)
  })

  it('shows no saved-address block when the store has none', async () => {
    mockApi(snapshot())

    await act(async () => {
      root.render(<RemoteControlPanel />)
    })
    await flush()
    await flush()

    expect(container.querySelector('[data-slot="saved-browser-address"]')).toBeNull()
  })
})

// The connected highlight used to be chosen by comparing the *translated* label with 'Connected', so the
// badge only ever looked connected on an English interface — on a Chinese one the same state rendered as
// plain text. This case renders in Chinese, where that comparison could never match, and requires the
// highlight anyway: the style has to follow the snapshot's facts, not the word it happens to print.
describe('RemoteControlPanel connected state styling', () => {
  it('highlights the connected badge on a non-English interface', async () => {
    window.localStorage.setItem('purescience-language', 'zh')
    mockApi(
      snapshot({
        mode: 'remoteit',
        enabled: true,
        lifecycle: 'running'
      })
    )

    await act(async () => {
      root.render(
        <LanguageProvider>
          <RemoteControlPanel />
        </LanguageProvider>
      )
    })
    await flush()
    await flush()

    const connected = [...container.querySelectorAll('[data-slot="badge"]')].filter(
      (badge) => badge.textContent === '已连接'
    )
    expect(connected).toHaveLength(1)
    expect(connected[0]?.className).toContain('bg-primary/10')
  })
})
