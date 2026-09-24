// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog'

describe('KeyboardShortcutsDialog', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    // The sheet reads the modifier glyph from the host platform, like the app's native chords do.
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { platform: 'darwin' }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
  })

  it('shows the chords the app actually wires, in the platform modifier', async () => {
    await act(async () => {
      root.render(<KeyboardShortcutsDialog open onOpenChange={vi.fn()} />)
    })

    const palette = document.querySelector('[data-testid="shortcut-row-palette"]')
    expect(palette?.textContent).toContain('⌘')
    expect(palette?.textContent).toContain('K')

    // The two chords the discoverability audit asked to make visible: settings and the close ladder.
    const settings = document.querySelector('[data-testid="shortcut-row-settings"]')
    expect(settings?.textContent).toContain('⌘')
    expect(settings?.textContent).toContain(',')

    const close = document.querySelector('[data-testid="shortcut-row-close"]')
    expect(close?.textContent).toContain('⌘')
    expect(close?.textContent).toContain('W')

    expect(document.querySelectorAll('[data-testid^="shortcut-row-"]')).toHaveLength(6)
  })

  it('renders nothing while it is closed', async () => {
    await act(async () => {
      root.render(<KeyboardShortcutsDialog open={false} onOpenChange={vi.fn()} />)
    })
    expect(document.querySelector('[data-testid="keyboard-shortcuts-dialog"]')).toBeNull()
  })
})
