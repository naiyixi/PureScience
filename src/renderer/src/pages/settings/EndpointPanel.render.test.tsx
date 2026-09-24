// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ManagedEndpointView } from '../../../../shared/endpoint'

vi.mock('@/i18n', () => ({
  useLanguage: () => {
    const labels: Record<string, string> = {
      'settings.endpointsDesc': 'Local model services.',
      'settings.endpointsRefresh': 'Refresh',
      'settings.endpointsNew': 'Register service',
      'settings.endpointsLoading': 'Loading…',
      'settings.endpointsEmpty': 'No services yet.',
      'settings.endpointsEmptyHint': 'Register one to start.',
      'settings.endpointsLive': 'live',
      'settings.endpointsStarting': 'starting',
      'settings.endpointsFailed': 'failed',
      'settings.endpointsStopped': 'stopped',
      'settings.endpointsStart': 'Start',
      'settings.endpointsPause': 'Stop',
      'settings.endpointsStop': 'Stop',
      'settings.endpointsDelete': 'Remove',
      'settings.endpointsApprove': 'Approve scripts',
      'settings.endpointsPending': 'needs approval',
      'settings.endpointsApproveScripts': 'Scripts awaiting approval',
      'settings.endpointsApproveHint': 'Approve the exact bytes below, or remove the service.',
      'settings.endpointsApproveMissing': 'That service is no longer registered; refresh the list.',
      'settings.endpointsStartScript': 'start',
      'settings.endpointsStopScript': 'stop',
      'settings.endpointsLivePath': 'live'
    }
    return { t: (key: string): string => labels[key] ?? key }
  }
}))

const { EndpointPanel } = await import('./EndpointPanel')

const endpoint = (overrides: Partial<ManagedEndpointView>): ManagedEndpointView => ({
  name: 'echo-service',
  url: 'http://127.0.0.1:8901',
  port: 8901,
  skillName: 'echo-api',
  startScript: 'run --port $HOST_PORT',
  stopScript: 'stop --port $HOST_PORT',
  livePath: '/health/ready',
  approvedScriptHash: 'a'.repeat(64),
  state: 'stopped',
  stateChangedAt: null,
  lastError: null,
  transcript: null,
  createdAt: 1,
  updatedAt: 1,
  approved: false,
  ...overrides
})

// One mutable list behind both calls, so the panel's reload sees what the approval changed.
const mockApi = (
  items: ManagedEndpointView[],
  approveResult = true
): { approve: ReturnType<typeof vi.fn>; listAll: ReturnType<typeof vi.fn> } => {
  let current = items
  const approve = vi.fn(async (name: string) => {
    if (!approveResult) return false
    current = current.map((item) => (item.name === name ? { ...item, approved: true } : item))
    return true
  })
  const listAll = vi.fn(async () => current)
  ;(window as unknown as { api: unknown }).api = {
    endpoint: {
      listAll,
      register: vi.fn(async () => ({ endpoint: current[0], newlyApproved: false })),
      approve,
      start: vi.fn(async () => current[0]),
      stop: vi.fn(async () => current[0]),
      remove: vi.fn(async () => true)
    }
  }
  return { approve, listAll }
}

describe('EndpointPanel approval entry', () => {
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
  })

  const renderPanel = async (): Promise<void> => {
    await act(async () => {
      root.render(<EndpointPanel />)
    })
  }

  it('says a service is unapproved, shows the exact bytes, and refuses to start it', async () => {
    mockApi([endpoint({})])
    await renderPanel()

    expect(container.querySelector('[data-testid="endpoint-approval-badge"]')?.textContent).toBe(
      'needs approval'
    )
    // What is being approved has to be visible before approving it.
    const disclosure = container.querySelector('[data-testid="endpoint-approval-scripts"]')
    expect(disclosure?.textContent).toContain('run --port $HOST_PORT')
    expect(disclosure?.textContent).toContain('stop --port $HOST_PORT')

    const start = container.querySelector<HTMLButtonElement>('[aria-label="Start"]')
    expect(start?.disabled).toBe(true)
    expect(container.querySelector('[data-testid="endpoint-approve"]')).toBeTruthy()
  })

  it('approving pins the scripts through the command and clears the pending state', async () => {
    const api = mockApi([endpoint({})])
    await renderPanel()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="endpoint-approve"]')?.click()
    })

    expect(api.approve).toHaveBeenCalledWith('echo-service')
    expect(container.querySelector('[data-testid="endpoint-approval-badge"]')).toBeNull()
    expect(container.querySelector('[data-testid="endpoint-approve"]')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Start"]')?.disabled).toBe(false)
  })

  it('offers no approval action when the bytes are already pinned', async () => {
    mockApi([endpoint({ approved: true })])
    await renderPanel()

    expect(container.querySelector('[data-testid="endpoint-approval-badge"]')).toBeNull()
    expect(container.querySelector('[data-testid="endpoint-approve"]')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Start"]')?.disabled).toBe(false)
  })

  it('tells the reader to refresh when the service disappeared before approving', async () => {
    mockApi([endpoint({})], false)
    await renderPanel()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="endpoint-approve"]')?.click()
    })

    expect(container.textContent).toContain('no longer registered')
    // The list is reloaded either way, so the panel never shows a stale pending service.
    expect(container.querySelector('[data-testid="endpoint-approval-badge"]')).toBeTruthy()
  })
})
