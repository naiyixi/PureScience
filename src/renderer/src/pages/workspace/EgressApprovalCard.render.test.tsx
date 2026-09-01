// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EgressApprovalRequest } from '../../../../shared/egress'
import { EgressApprovalCard } from './EgressApprovalCard'

let container: HTMLDivElement
let root: Root

const request: EgressApprovalRequest = {
  requestId: 'egress-1',
  host: 'stats.example.com',
  method: 'GET',
  path: '/metrics',
  expiresInSec: 60
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('EgressApprovalCard', () => {
  it('renders the blocked host and the three decision actions', () => {
    act(() => {
      root.render(<EgressApprovalCard request={request} onRespond={vi.fn()} />)
    })

    expect(document.body.textContent).toContain('Network access blocked')
    // The test environment's fallback t() does not interpolate, so the raw {host} placeholder
    // is what renders here; the path and actions still resolve.
    expect(document.body.textContent).toContain('{host}')
    expect(document.body.textContent).toContain('/metrics')
    expect(document.body.textContent).toContain('Deny')
    expect(document.body.textContent).toContain('Allow once')
    expect(document.body.textContent).toContain('Always allow')
  })

  it('reports the decision for the exact request id', () => {
    const onRespond = vi.fn()
    act(() => {
      root.render(<EgressApprovalCard request={request} onRespond={onRespond} />)
    })

    const buttons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    const deny = buttons.find((button) => button.textContent?.trim() === 'Deny')
    const allowOnce = buttons.find((button) => button.textContent?.trim() === 'Allow once')
    const allowAlways = buttons.find((button) => button.textContent?.trim() === 'Always allow')

    act(() => deny?.click())
    expect(onRespond).toHaveBeenCalledWith('egress-1', 'deny')
    act(() => allowOnce?.click())
    expect(onRespond).toHaveBeenCalledWith('egress-1', 'allow_once')
    act(() => allowAlways?.click())
    expect(onRespond).toHaveBeenCalledWith('egress-1', 'allow_always')
  })

  it('shows the CONNECT note only for tunnel requests', () => {
    act(() => {
      root.render(
        <EgressApprovalCard
          request={{ ...request, method: 'CONNECT', path: 'stats.example.com:443' }}
          onRespond={vi.fn()}
        />
      )
    })
    expect(document.body.textContent).toContain('This applies to this one connection attempt only.')
  })
})
