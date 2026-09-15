// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionPackageImportDialog } from './SessionPackageImportDialog'

let container: HTMLDivElement
let root: Root
const previewPackage = vi.fn()
const importPackage = vi.fn()
const onImported = vi.fn()
const onClose = vi.fn()

const acceptedPreview = {
  accepted: true,
  packagePath: '/tmp/mpro.science',
  described: {
    formatVersion: 1,
    mode: 'full',
    session: { id: 'source-session', title: 'Mpro 模拟', projectId: 'source-project' },
    appVersion: '1.59.0',
    exportedAt: '2026-09-15T00:00:00.000Z',
    counts: { messages: 47, citations: 2, reviewFindings: 6, verificationRecords: 0, files: 31 },
    assertion: { origin: 'source-party', locallyVerified: false },
    notes: ['environment-lock-unavailable']
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  ;(window as unknown as { api: unknown }).api = { sessions: { previewPackage, importPackage } }
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.clearAllMocks()
})

const render = (targetProjectId = 'target-project'): void => {
  act(() => {
    root.render(
      <SessionPackageImportDialog
        open
        targetProjectId={targetProjectId}
        onClose={onClose}
        onImported={onImported}
      />
    )
  })
}

const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const button = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.includes(label)
  )
  if (!found) throw new Error(`no button matching ${label}`)
  return found as HTMLButtonElement
}

const click = async (label: string): Promise<void> => {
  await act(async () => {
    button(label).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

describe('session package import dialog', () => {
  it('states the read-only posture before anything is imported', () => {
    render()
    const text = container.textContent ?? ''
    expect(text).toMatch(/read-only|只读/)
    // Nothing was imported by simply opening the dialog.
    expect(importPackage).not.toHaveBeenCalled()
    expect(previewPackage).not.toHaveBeenCalled()
  })

  it('previews, then imports the very file the preview described', async () => {
    previewPackage.mockResolvedValue(acceptedPreview)
    importPackage.mockResolvedValue({
      ok: true,
      sessionId: 'imported-session',
      posture: {
        readOnly: true,
        executeAllowed: false,
        continueAllowed: false,
        verificationLabel: 'source-party'
      },
      notes: []
    })
    render('target-project')

    await click('Choose a package')
    expect(previewPackage).toHaveBeenCalledTimes(1)
    const previewed = container.textContent ?? ''
    expect(previewed).toContain('Mpro 模拟')
    expect(previewed).toContain('47')
    expect(previewed).toMatch(/source party|来源方|sender/)
    expect(previewed).toContain('environment-lock-unavailable')

    await click('Import')
    expect(importPackage).toHaveBeenCalledWith({
      packagePath: '/tmp/mpro.science',
      confirm: { targetProjectId: 'target-project' }
    })
    expect(onImported).toHaveBeenCalledWith('imported-session')
    expect(container.textContent).toContain('imported-session')
  })

  it('reports a refused package by name and imports nothing', async () => {
    previewPackage.mockResolvedValue({ accepted: false, reason: 'required-evidence-missing' })
    render()

    await click('Choose a package')
    expect(container.textContent).toContain('required-evidence-missing')
    expect(button('Import').disabled).toBe(true)
    await click('Import')
    expect(importPackage).not.toHaveBeenCalled()
  })

  it('treats a closed picker as no choice at all, not as a refusal', async () => {
    previewPackage.mockResolvedValue(null)
    render()

    await click('Choose a package')
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/cannot be imported|不能导入/)
    expect(button('Import').disabled).toBe(true)
  })

  it('shows why an import was refused even after an accepted preview', async () => {
    previewPackage.mockResolvedValue(acceptedPreview)
    importPackage.mockResolvedValue({ ok: false, reason: 'write-failed' })
    render()

    await click('Choose a package')
    await click('Import')
    expect(container.textContent).toContain('write-failed')
    expect(onImported).not.toHaveBeenCalled()
  })
})
