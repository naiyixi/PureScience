// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', () => ({
  useLanguage: () => {
    const labels: Record<string, string> = {
      'protection.intro': 'Intro',
      'protection.weakestLinkNote': 'Weakest link',
      'protection.capabilityTitle': 'This machine',
      'protection.capabilityPlatform': 'Platform',
      'protection.capabilityOsWriteGuard': 'OS write-guard',
      'protection.capabilityOsWriteGuardAvailable': 'available',
      'protection.capabilityOsWriteGuardUnsupported': 'not applicable',
      'protection.capabilityOsWriteGuardComponentMissing': 'missing component',
      'protection.capabilityNetworkAllowlist': 'Network filtering',
      'protection.enabled': 'on',
      'protection.disabled': 'off',
      'protection.matrixTitle': 'Protection matrix',
      'protection.scopeFilesystem': 'Filesystem',
      'protection.scopeFilesystemProtected': 'runtime write-protected',
      'protection.scopeFilesystemUnrestricted': 'unrestricted',
      'protection.scopeNetwork': 'Network',
      'protection.scopeNetworkAllowlist': 'allowlist only',
      'protection.scopeNetworkUnrestricted': 'unfiltered',
      'protection.noAppliedLayers': 'No applied layers',
      'protection.repairLabel': 'Fix',
      'protection.surfaceNotebook': 'Notebook kernel',
      'protection.surfaceShell': 'Terminal command',
      'protection.surfaceBackgroundJob': 'Background job',
      'protection.surfaceRemoteHost': 'Remote host',
      'protection.levelOsSandbox': 'OS sandbox',
      'protection.levelNetworkAllowlist': 'Network allowlist only',
      'protection.levelUnprotected': 'Unprotected',
      'protection.layerMacosSeatbeltRuntimeWrite': 'macOS runtime write-guard',
      'protection.layerEgressAllowlist': 'Network allowlist proxy',
      'protection.layerManagedRuntimeMutationGuard': 'Runtime-mutation semantic guard',
      'protection.unmetNetworkAllowlistDisabled': 'Egress not filtered',
      'protection.unmetOsSandboxUnavailablePlatform': 'No OS guard here',
      'protection.unmetOsSandboxComponentMissing': 'Component missing',
      'protection.unmetRemoteExecutionHasNoLocalProtection': 'Remote has no local protection',
      'protection.unmetProtectionUnresolved': 'Unresolved',
      'protection.repairEnableNetworkAllowlist': 'Enable the allowlist',
      'protection.repairRunLocally': 'Run locally',
      'protection.repairPlatformHasNoOsSandbox': 'No OS sandbox adapter',
      'protection.policyTitle': 'Remote execution without protection',
      'protection.policyHint': 'Policy hint',
      'protection.policyConfirm': 'Ask every time',
      'protection.policyConfirmHint': 'Confirm hint',
      'protection.policyRemembered': 'Remembered approvals may cover it',
      'protection.policyRememberedHint': 'Remembered hint',
      'protection.policyDeny': 'Refuse',
      'protection.policyDenyHint': 'Deny hint',
      'protection.loading': 'Loading…',
      'protection.loadError': 'Matrix unavailable',
      'protection.reload': 'Try again'
    }
    return { t: (key: string): string => labels[key] ?? key }
  }
}))

const { ExecutionProtectionPanel } = await import('./ExecutionProtectionPanel')
const { resolveExecutionProtection } = await import('../../../../shared/execution-protection')

const snapshotFor = (
  surface: 'notebook' | 'shell' | 'background-job' | 'remote-host',
  networkAllowlistEnabled: boolean
): ReturnType<typeof resolveExecutionProtection> =>
  resolveExecutionProtection({
    surface,
    platform: 'darwin',
    networkAllowlistEnabled,
    osWriteGuardAvailable: true,
    capturedAt: 1_700_000_000_000
  })

const matrixFor = (
  policy: 'confirm' | 'remembered' | 'deny'
): {
  platform: string
  capturedAt: number
  osWriteGuard: {
    platform: string
    component: string
    componentPresent: boolean
    available: boolean
  }
  networkAllowlist: { enabled: boolean }
  surfaces: ReturnType<typeof resolveExecutionProtection>[]
  remoteUnprotectedPolicy: 'confirm' | 'remembered' | 'deny'
} => ({
  platform: 'darwin',
  capturedAt: 1_700_000_000_000,
  osWriteGuard: {
    platform: 'darwin',
    component: '/usr/bin/sandbox-exec',
    componentPresent: true,
    available: true
  },
  networkAllowlist: { enabled: true },
  surfaces: [
    snapshotFor('notebook', true),
    snapshotFor('shell', false),
    snapshotFor('background-job', true),
    snapshotFor('remote-host', true)
  ],
  remoteUnprotectedPolicy: policy
})

// The component reads the bridge through window.api?.settings.executionProtection; like the other
// settings panels, a missing bridge must render a readable state rather than an empty matrix.
const mockApi = (
  policy: 'confirm' | 'remembered' | 'deny' = 'confirm'
): { read: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> } => {
  let current = policy
  const read = vi.fn(async () => ({ matrix: matrixFor(current) }))
  const write = vi.fn(async (request: { action: string; policy?: typeof current }) => {
    if (request.action === 'set-remote-policy' && request.policy) current = request.policy
    return { matrix: matrixFor(current) }
  })
  ;(window as unknown as { api: unknown }).api = {
    settings: {
      executionProtection: (request: { action: string; policy?: typeof current }) =>
        request.action === 'set-remote-policy' ? write(request) : read()
    }
  }
  return { read, write }
}

describe('ExecutionProtectionPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    delete (window as unknown as { api?: unknown }).api
  })

  const render = (): Promise<void> =>
    act(async () => {
      root.render(<ExecutionProtectionPanel />)
    })

  it('renders one row per execution surface with its level and both axes', async () => {
    const { read } = mockApi()
    await render()

    expect(read).toHaveBeenCalledWith()
    for (const surface of ['notebook', 'shell', 'background-job', 'remote-host']) {
      expect(container.querySelector(`[data-slot="protection-row-${surface}"]`)).not.toBeNull()
    }
    // The local notebook runs sandboxed, the terminal does not (allowlist off), and both remote
    // surfaces are unprotected no matter how the local allowlist is set.
    expect(
      container.querySelector('[data-slot="protection-level-notebook"]')?.textContent
    ).toContain('OS sandbox')
    expect(container.querySelector('[data-slot="protection-level-shell"]')?.textContent).toContain(
      'Unprotected'
    )
    expect(
      container.querySelector('[data-slot="protection-level-remote-host"]')?.textContent
    ).toContain('Unprotected')
    // The downgraded terminal still reports its filesystem write-guard: a level must never erase a
    // protection that is still in force.
    expect(
      container.querySelector('[data-slot="protection-scope-filesystem-shell"]')?.textContent
    ).toContain('runtime write-protected')
  })

  it('names the gap and the repair step instead of only showing a lower level', async () => {
    mockApi()
    await render()

    expect(
      container.querySelector('[data-slot="protection-unmet-network-allowlist-disabled"]')
        ?.textContent
    ).toContain('Egress not filtered')
    expect(
      container.querySelector('[data-slot="protection-repair-enable-network-allowlist"]')
        ?.textContent
    ).toContain('Enable the allowlist')
    expect(
      container.querySelector(
        '[data-slot="protection-unmet-remote-execution-has-no-local-protection"]'
      )?.textContent
    ).toContain('Remote has no local protection')
  })

  it('reports this machine capability next to the matrix', async () => {
    mockApi()
    await render()

    const capability = container.querySelector('[data-slot="protection-capability"]')?.textContent
    expect(capability).toContain('darwin')
    expect(capability).toContain('available')
    expect(capability).toContain('on')
  })

  it('writes the remote policy and re-renders from the returned matrix', async () => {
    const { write } = mockApi('confirm')
    await render()

    const denyRadio = container.querySelector<HTMLInputElement>(
      '[data-slot="protection-policy-deny"] input'
    )
    expect(denyRadio?.checked).toBe(false)

    await act(async () => {
      denyRadio?.click()
    })

    expect(write).toHaveBeenCalledWith({ action: 'set-remote-policy', policy: 'deny' })
    expect(
      container.querySelector<HTMLInputElement>('[data-slot="protection-policy-deny"] input')
        ?.checked
    ).toBe(true)
  })

  it('says the matrix is unavailable when there is no bridge', async () => {
    await render()

    expect(container.querySelector('[data-slot="protection-unavailable"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="protection-panel"]')).toBeNull()
  })
})
