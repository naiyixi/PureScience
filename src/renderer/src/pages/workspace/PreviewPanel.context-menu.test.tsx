// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PreviewTabContextMenu } from './PreviewPanel'

const tMock = vi.fn((key: string) => key)

vi.mock('@/i18n', () => ({
  useLanguage: () => ({ t: tMock, lang: 'en' })
}))

vi.mock('@/stores/navigation-store', () => ({
  useNavigationStore: (selector: (state: never) => unknown) => selector({ activeProjectId: 'p1' } as never)
}))

const fileTab = {
  id: 'tab-a',
  sessionId: 's1',
  title: 'alpha.txt',
  type: 'file' as const,
  path: '/tmp/alpha.txt',
  format: 'text' as const,
  name: 'alpha.txt'
}

let container: HTMLElement
let root: Root

const renderMenu = (overrides: Partial<Parameters<typeof PreviewTabContextMenu>[0]> = {}): void => {
  act(() => {
    root.render(
      <PreviewTabContextMenu
        x={40}
        y={60}
        tab={fileTab}
        onCloseTab={() => undefined}
        onCloseOthers={() => undefined}
        onDismiss={() => undefined}
        {...overrides}
      />
    )
  })
}

describe('PreviewTabContextMenu', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    tMock.mockClear()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders close, close-others, and file actions for a file tab', () => {
    renderMenu()
    const menu = document.body.querySelector('[role="menu"]')
    expect(menu).not.toBeNull()
    const items = [...document.body.querySelectorAll('[role="menuitem"]')].map((el) => (el.textContent ?? '').trim())
    expect(items).toContain('ws.previewTabClose')
    expect(items).toContain('ws.previewTabCloseOthers')
    expect(items).toContain('ws.previewTabCopyPath')
    expect(items).toContain('ws.previewTabDownload')
    expect(items).toContain('ws.previewTabSaveAsArtifact')
  })

  it('hides file-only actions for tool tabs', () => {
    renderMenu({
      tab: { id: 'tool-1', sessionId: 's1', title: 'files', type: 'tool', toolKind: 'files' }
    })
    const items = [...document.body.querySelectorAll('[role="menuitem"]')].map((el) => (el.textContent ?? '').trim())
    expect(items).toContain('ws.previewTabClose')
    expect(items).toContain('ws.previewTabCloseOthers')
    expect(items).not.toContain('ws.previewTabCopyPath')
    expect(items).not.toContain('ws.previewTabDownload')
    expect(items).not.toContain('ws.previewTabSaveAsArtifact')
  })

  it('invokes onCloseTab and dismisses when Close is clicked', () => {
    const onCloseTab = vi.fn()
    const onDismiss = vi.fn()
    renderMenu({ onCloseTab, onDismiss })
    const closeItem = [...document.body.querySelectorAll('[role="menuitem"]')].find(
      (el) => (el.textContent ?? '').trim() === 'ws.previewTabClose'
    )
    act(() => closeItem?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onCloseTab).toHaveBeenCalledWith('tab-a')
    expect(onDismiss).toHaveBeenCalled()
  })

  it('dismisses on Escape', () => {
    const onDismiss = vi.fn()
    renderMenu({ onDismiss })
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onDismiss).toHaveBeenCalled()
  })
})
