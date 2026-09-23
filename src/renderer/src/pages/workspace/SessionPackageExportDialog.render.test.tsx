// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionPackageExportDialog } from './SessionPackageExportDialog'
import type { ChatSession } from '@/stores/session-store'

let container: HTMLDivElement
let root: Root
const exportPackage = vi.fn()
const onClose = vi.fn()
const onExported = vi.fn()

const session = { id: 'session-1', title: 'Mpro 模拟' } as unknown as ChatSession

const render = async (target: ChatSession | null): Promise<void> => {
  await act(async () => {
    root.render(
      <SessionPackageExportDialog
        projectId="project-1"
        session={target ?? undefined}
        onClose={onClose}
        onExported={onExported}
      />
    )
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  ;(window as unknown as { api: unknown }).api = { sessions: { exportPackage } }
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  exportPackage.mockReset()
  onClose.mockReset()
  onExported.mockReset()
})

describe('SessionPackageExportDialog', () => {
  it('renders nothing at all without a session', async () => {
    await render(null)

    // The panel is not mounted at all: Radix unmounts closed content, so nothing can be clicked into
    // exporting whatever session happened to be behind it.
    expect(container.querySelector('[data-testid="package-export-submit"]')).toBeNull()
    expect(exportPackage).not.toHaveBeenCalled()
  })

  it('exports the chosen mode and names what the package left out', async () => {
    exportPackage.mockResolvedValue({
      ok: true,
      path: '/tmp/out/mpro.science',
      bytes: 2048,
      notes: ['reference-pdfs-not-requested:3', 'unknown-note-code']
    })
    await render(session)

    const full = container.querySelector('input[value="full"]')
    await act(async () => {
      full?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      container
        .querySelector('[data-testid="package-export-submit"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(exportPackage).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      mode: 'full'
    })
    const result = container.querySelector('[data-testid="package-export-result"]')
    expect(result?.textContent).toContain('Wrote mpro.science (2 KB).')
    // The count the package named is carried into the sentence, not dropped.
    expect(result?.textContent).toContain('3 reference PDFs left behind by the essentials mode')
    // An unrecognised note is shown as itself rather than swallowed into a generic apology.
    expect(result?.textContent).toContain('unknown-note-code')
    expect(onExported).toHaveBeenCalledWith('/tmp/out/mpro.science')
  })

  it('reports a named failure instead of a generic apology', async () => {
    exportPackage.mockResolvedValue({ ok: false, error: 'session-unreadable' })
    await render(session)

    await act(async () => {
      container
        .querySelector('[data-testid="package-export-submit"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="package-export-failure"]')?.textContent).toBe(
      'The session could not be read.'
    )
    expect(container.querySelector('[data-testid="package-export-result"]')).toBeNull()
  })

  it('treats a closed save sheet as a decision, not a failure', async () => {
    exportPackage.mockResolvedValue({ ok: false, error: 'cancelled' })
    await render(session)

    await act(async () => {
      container
        .querySelector('[data-testid="package-export-submit"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(onClose).toHaveBeenCalled()
    expect(container.querySelector('[data-testid="package-export-failure"]')).toBeNull()
  })
})
