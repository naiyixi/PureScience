// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', () => ({
  useLanguage: () => {
    const labels: Record<string, string> = {
      'settings.network': 'Network',
      'settings.egressTitle': 'Network egress allowlist',
      'settings.egressDescription': 'Restrict child processes.',
      'settings.egressEnabled': 'Restrict process network access',
      'settings.egressGroupLiterature': 'Literature & repositories',
      'settings.egressGroupGenomics': 'Genomics',
      'settings.egressGroupStructures': 'Structures',
      'settings.egressGroupClinical': 'Clinical',
      'settings.egressGroupBioinformatics': 'Bioinformatics',
      'settings.egressGroupRepositories': 'Repositories',
      'settings.egressCustomDomains': 'Custom domains',
      'settings.egressCustomPlaceholder': 'example.com',
      'settings.egressAddDomain': 'Add domain',
      'settings.egressRemoveDomain': 'Remove domain',
      'settings.egressNoCustom': 'No custom domains yet.',
      'settings.proxyTitle': 'Proxy',
      'settings.proxyModeSystem': 'Follow system',
      'settings.proxyModeManual': 'Manual configuration',
      'settings.loading': 'Loading…'
    }
    return { t: (key: string): string => labels[key] ?? key }
  }
}))

const { NetworkPanel } = await import('./NetworkPanel')
const { useNetworkStore } = await import('@/stores/network-store')

// The panel's store + settings store both read window.api; stub them minimal.
const mockApi = (egress = { enabled: false, groups: {}, customDomains: [] }): void => {
  let current = egress
  ;(window as unknown as { api: unknown }).api = {
    network: { getInfo: vi.fn(async () => ({ connectionType: 'wifi', ipAddress: null })) },
    settings: {
      getEgress: vi.fn(async () => current),
      setEgress: vi.fn(async (next: unknown) => {
        current = next as typeof egress
        return current
      }),
      getPackageMirror: vi.fn(async () => ({})),
      setPackageMirror: vi.fn(async () => ({})),
      getProxy: vi.fn(async () => ({ mode: 'system' })),
      setProxy: vi.fn(async (next: unknown) => next)
    }
  }
}

describe('NetworkPanel egress section', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    mockApi()
    useNetworkStore.setState({ isOnline: true, connectivity: 'unknown' })
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
      root.render(<NetworkPanel view={{ kind: 'list' }} onNavigate={() => undefined} />)
    })

  it('renders the egress section with a disabled master switch', async () => {
    await renderPanel()

    const section = container.querySelector('[data-slot="egress-section"]')
    expect(section).toBeTruthy()
    const master = container.querySelector<HTMLButtonElement>('[data-slot="egress-master-switch"]')
    expect(master?.getAttribute('aria-checked')).toBe('false')
    // Groups are hidden until enabled.
    expect(container.querySelector('[data-slot="egress-group-literature"]')).toBeNull()
  })

  it('enabling the switch reveals the 6 domain groups and persists', async () => {
    await renderPanel()

    const master = container.querySelector<HTMLButtonElement>('[data-slot="egress-master-switch"]')
    await act(async () => {
      master?.click()
    })

    const setEgress = window.api.settings.setEgress as unknown as ReturnType<typeof vi.fn>
    expect(setEgress).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }))
    expect(container.querySelector('[data-slot="egress-group-literature"]')).toBeTruthy()
    expect(container.querySelector('[data-slot="egress-group-repositories"]')).toBeTruthy()
  })

  it('adds and removes a custom domain', async () => {
    await renderPanel()

    // Enable first.
    const master = container.querySelector<HTMLButtonElement>('[data-slot="egress-master-switch"]')
    await act(async () => {
      master?.click()
    })

    // Type a domain + click Add.
    const input = container.querySelector<HTMLInputElement>('[data-slot="egress-domain-input"]')
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(input, 'lab.example.com')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-slot="egress-add-domain"]')?.click()
    })

    const setEgress = window.api.settings.setEgress as unknown as ReturnType<typeof vi.fn>
    const last = setEgress.mock.calls.at(-1)?.[0]
    expect(last.customDomains).toContain('lab.example.com')
    expect(container.textContent).toContain('lab.example.com')

    // Remove it.
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-slot="egress-remove-lab.example.com"]')
        ?.click()
    })
    const afterRemove = setEgress.mock.calls.at(-1)?.[0]
    expect(afterRemove.customDomains).not.toContain('lab.example.com')
  })

  it('configures and persists a manual proxy from the proxy section', async () => {
    await renderPanel()

    // Switch to manual configuration; the fields appear.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-slot="proxy-mode-manual"]')?.click()
    })
    expect(container.querySelector('[data-slot="proxy-manual-fields"]')).toBeTruthy()

    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    const type = (slot: string, value: string): void => {
      void act(async () => {
        const input = container.querySelector<HTMLInputElement>(`[data-slot="${slot}"]`)
        valueSetter?.call(input, value)
        input?.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    type('proxy-host', '127.0.0.1')
    type('proxy-port', '7890')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-slot="proxy-save"]')?.click()
    })

    const setProxy = window.api.settings.setProxy as unknown as ReturnType<typeof vi.fn>
    expect(setProxy).toHaveBeenCalledWith({
      mode: 'manual',
      manual: { type: 'http', host: '127.0.0.1', port: 7890 }
    })
  })
})
