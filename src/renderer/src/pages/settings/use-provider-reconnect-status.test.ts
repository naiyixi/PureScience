// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AcpStateSnapshot } from '../../../../shared/acp'

import { useProviderReconnectStatus } from './use-provider-reconnect-status'

// The panel says "applied to the runtime" while a provider change is being taken through. That sentence
// is only true if it is driven by the real flag, so the flag's arrival (initial read and pushes) is what
// this pins — plus the case where the ACP surface is not there at all.

let container: HTMLDivElement
let root: Root
let pushed: ((state: AcpStateSnapshot) => void) | undefined

const snapshot = (pending?: boolean): AcpStateSnapshot =>
  ({ providerReconnectPending: pending }) as AcpStateSnapshot

const Probe = (): ReactElement => {
  const pending = useProviderReconnectStatus()
  return createElement('span', { 'data-testid': 'probe' }, pending ? 'pending' : 'idle')
}

const installAcp = (initial: AcpStateSnapshot | undefined): void => {
  pushed = undefined
  ;(window as unknown as { api: unknown }).api = {
    acp: {
      getState: vi.fn().mockResolvedValue(initial ?? snapshot(false)),
      onState: vi.fn((listener: (state: AcpStateSnapshot) => void) => {
        pushed = listener
        return () => {
          pushed = undefined
        }
      })
    }
  }
}

const render = async (): Promise<void> => {
  await act(async () => {
    root.render(createElement(Probe))
    await new Promise((resolve) => window.setTimeout(resolve, 20))
  })
}

const probeText = (): string | undefined =>
  document.body.querySelector('[data-testid="probe"]')?.textContent ?? undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('the provider reconnect notice', () => {
  it('says nothing while no provider change is being applied', async () => {
    installAcp(snapshot(false))
    await render()

    expect(probeText()).toBe('idle')
  })

  it('reports a reconnect that was already under way when the panel opened', async () => {
    installAcp(snapshot(true))
    await render()

    expect(probeText()).toBe('pending')
  })

  it('follows the runtime as the change is applied and then finishes', async () => {
    installAcp(snapshot(false))
    await render()
    expect(probeText()).toBe('idle')

    await act(async () => {
      pushed?.(snapshot(true))
      await new Promise((resolve) => window.setTimeout(resolve, 5))
    })
    expect(probeText()).toBe('pending')

    await act(async () => {
      pushed?.(snapshot(false))
      await new Promise((resolve) => window.setTimeout(resolve, 5))
    })
    expect(probeText()).toBe('idle')
  })

  it('stays silent where the ACP surface is absent instead of throwing', async () => {
    ;(window as unknown as { api: unknown }).api = { settings: {} }
    await render()

    expect(probeText()).toBe('idle')
  })
})
