// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CredentialTestResult, CredentialView } from '../../../../shared/settings'
import { CredentialsPanel } from './CredentialsPanel'

let container: HTMLDivElement
let root: Root

const savedView: CredentialView = {
  id: 'cred-1',
  serviceId: 'github',
  name: 'GitHub',
  hasSecret: true,
  createdAt: 1751932800000,
  updatedAt: 1751932800000
}

const createTestResult = (overrides: Partial<CredentialTestResult> = {}): CredentialTestResult => ({
  ok: false,
  message: 'GitHub rejected the token (unauthorized).',
  kind: 'auth',
  ...overrides
})

const setCredentialMock = vi.fn()
const testCredentialMock = vi.fn()

beforeEach(() => {
  setCredentialMock.mockReset()
  testCredentialMock.mockReset()
  setCredentialMock.mockResolvedValue(savedView)
  testCredentialMock.mockResolvedValue(createTestResult())

  window.api = {
    settings: {
      getCredentials: vi.fn().mockResolvedValue([savedView]),
      setCredential: setCredentialMock,
      testCredential: testCredentialMock,
      deleteCredential: vi.fn().mockResolvedValue([])
    }
  } as unknown as typeof window.api
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  // @ts-expect-error test-only cleanup
  delete window.api
})

const render = (): void => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<CredentialsPanel />)
  })
}

const openEditor = async (): Promise<void> => {
  let edit = container.querySelector<HTMLButtonElement>('[data-slot="credential-edit"]')
  if (!edit) {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    edit = container.querySelector<HTMLButtonElement>('[data-slot="credential-edit"]')
  }
  if (!edit) throw new Error('edit button not found')
  await act(async () => {
    edit.click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const fillSecret = (value: string): void => {
  const input = container.querySelector<HTMLInputElement>('[data-slot="credential-secret-input"]')
  if (!input) throw new Error('secret input not found')
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('CredentialsPanel guided recovery', () => {
  it('stays open with recovery guidance when the post-save re-probe fails', async () => {
    render()
    await openEditor()
    fillSecret('ghp_invalid')
    const save = container.querySelector<HTMLButtonElement>('[data-slot="credential-save-button"]')
    if (!save) throw new Error('save button not found')
    await act(async () => {
      save.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(setCredentialMock).toHaveBeenCalledWith(
      expect.objectContaining({ secret: 'ghp_invalid' })
    )
    expect(testCredentialMock).toHaveBeenCalledWith({ id: 'cred-1', secret: 'ghp_invalid' })
    expect(container.querySelector('[data-slot="credential-test-result"]')).not.toBeNull()
  })

  it('closes the editor when the post-save re-probe succeeds', async () => {
    testCredentialMock.mockResolvedValue({ ok: true, message: 'GitHub token is valid.' })
    render()
    await openEditor()
    fillSecret('ghp_valid')
    const save = container.querySelector<HTMLButtonElement>('[data-slot="credential-save-button"]')
    if (!save) throw new Error('save button not found')
    await act(async () => {
      save.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('[data-slot="credential-editor"]')).toBeNull()
  })
})
