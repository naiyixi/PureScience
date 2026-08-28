// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', () => ({
  useLanguage: () => {
    const labels: Record<string, string> = {
      'settings.credentials': 'Credentials',
      'settings.credentialsDescription': 'Encrypted secrets.',
      'settings.credentialsSave': 'Save',
      'settings.credentialsTest': 'Test',
      'settings.credentialsDelete': 'Delete',
      'settings.credentialsEdit': 'Edit',
      'settings.credentialsSecretLabel': 'API key / token',
      'settings.credentialsSecretPlaceholder': 'Paste the secret…',
      'settings.credentialsUsernameLabel': 'Username / ID (optional)',
      'settings.credentialsUsernamePlaceholder': 'e.g. GitHub username',
      'settings.credentialsCustomNameLabel': 'Name',
      'settings.credentialsCustomNamePlaceholder': 'e.g. lab gateway',
      'settings.credentialsEmpty': 'No credential saved for this service yet.',
      'settings.credentialsSaved': 'Saved',
      'settings.credentialsNotConfigured': 'Not configured',
      'settings.credentialsDeleteTitle': 'Delete credential?',
      'settings.credentialsDeleteDescription': 'This removes the saved secret for {name}.',
      'settings.credentialsTestOk': 'Connected successfully.',
      'settings.credentialsTestFail': 'Connection failed: {message}',
      'settings.credentialsAddCustom': 'Add custom credential',
      'settings.credentialsServiceAws': 'AWS',
      'settings.credentialsServiceGithub': 'GitHub',
      'settings.credentialsServiceGcp': 'Google Cloud',
      'settings.credentialsServiceAzure': 'Azure',
      'settings.credentialsServiceModal': 'Modal',
      'settings.credentialsServiceNvidia': 'NVIDIA',
      'settings.credentialsServiceOpenalex': 'OpenAlex',
      'settings.credentialsServiceLiterature': 'Literature access',
      'settings.credentialsServiceCustom': 'Custom',
      'settings.memoryLoading': 'Loading…',
      'common.cancel': 'Cancel',
      'common.delete': 'Delete'
    }
    return { t: (key: string): string => labels[key] ?? key }
  }
}))

const { CredentialsPanel } = await import('./CredentialsPanel')

const credentialFixture = [
  {
    id: 'cred-1',
    serviceId: 'github',
    name: 'GitHub',
    username: 'zerolink',
    hint: 'ghp_…abcd',
    hasSecret: true,
    createdAt: 1,
    updatedAt: 2
  }
]

type Credential = (typeof credentialFixture)[number]

const mockApi = (
  overrides: Partial<{
    getCredentials: () => Promise<Credential[]>
    setCredential: (request: unknown) => Promise<Credential>
    deleteCredential: (id: string) => Promise<Credential[]>
    testCredential: (request: unknown) => Promise<{ ok: boolean; message: string }>
  }> = {}
): void => {
  ;(window as unknown as { api: unknown }).api = {
    settings: {
      getCredentials: vi.fn(async () => credentialFixture),
      setCredential: vi.fn(async (request: unknown) => ({
        id: 'cred-new',
        serviceId: (request as { serviceId: string }).serviceId,
        name: 'GitHub',
        username: 'zerolink',
        hint: 'sk-a…wxyz',
        hasSecret: true,
        createdAt: 1,
        updatedAt: 2
      })),
      deleteCredential: vi.fn(async () => []),
      testCredential: vi.fn(async () => ({ ok: true, message: 'GitHub token is valid.' })),
      ...overrides
    }
  }
}

describe('CredentialsPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    mockApi()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const renderPanel = (): Promise<void> =>
    act(async () => {
      root.render(<CredentialsPanel />)
    })

  it('renders the service catalog and an existing credential', async () => {
    await renderPanel()

    expect(container.textContent).toContain('GitHub')
    expect(container.textContent).toContain('zerolink')
    expect(container.textContent).toContain('ghp_…abcd')
    expect(container.textContent).toContain('Saved')
  })

  it('opens the editor for an empty service and saves a secret', async () => {
    await renderPanel()

    // AWS has no credential yet; its nav entry opens the editor.
    const awsNav = container.querySelector<HTMLButtonElement>('[data-slot="credential-nav-aws"]')
    await act(async () => {
      awsNav?.click()
    })
    expect(container.querySelector('[data-slot="credential-editor"]')).toBeTruthy()

    const secretInput = container.querySelector<HTMLInputElement>(
      '[data-slot="credential-secret-input"]'
    )
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(secretInput, 'AKIAEXAMPLE')
      secretInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-slot="credential-save-button"]')?.click()
    })

    const setCredential = window.api.settings.setCredential as unknown as ReturnType<typeof vi.fn>
    expect(setCredential).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: 'aws', secret: 'AKIAEXAMPLE' })
    )
  })

  it('deletes a credential after confirmation', async () => {
    await renderPanel()

    const deleteButton = container.querySelector<HTMLButtonElement>(
      '[data-slot="credential-delete"]'
    )
    await act(async () => {
      deleteButton?.click()
    })

    const confirmButton = document.body.querySelector<HTMLButtonElement>(
      '[data-slot="credential-delete-confirm"]'
    )
    expect(confirmButton).toBeTruthy()
    await act(async () => {
      confirmButton?.click()
    })

    const deleteCredential = window.api.settings.deleteCredential as unknown as ReturnType<
      typeof vi.fn
    >
    expect(deleteCredential).toHaveBeenCalledWith('cred-1')
  })
})
