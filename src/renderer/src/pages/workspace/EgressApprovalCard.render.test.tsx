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
    // The fallback t() interpolates now (regression test in i18n-provider.test.tsx), so the banner
    // must carry the real host: a raw `{host}` in the DOM would mean interpolation regressed.
    expect(document.body.textContent).toContain('stats.example.com')
    expect(document.body.textContent).not.toContain('{host}')
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

  it('counts down the remaining validity it was handed, instead of leaving the reader to guess', () => {
    vi.useFakeTimers()
    try {
      act(() => {
        root.render(
          <EgressApprovalCard request={{ ...request, expiresInSec: 5 }} onRespond={vi.fn()} />
        )
      })
      const countdown = document.body.querySelector('[data-slot="egress-approval-countdown"]')
      expect(countdown?.textContent).toContain('expires in 5s')

      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(countdown?.textContent).toContain('expires in 3s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('states the timeout once the deadline passed, and offers no controls that could not settle anything', () => {
    act(() => {
      root.render(<EgressApprovalCard request={request} expired onRespond={vi.fn()} />)
    })

    const card = document.body.querySelector('[data-slot="egress-approval-card"]')
    expect(card?.getAttribute('data-expired')).toBe('true')
    // The deadline is named rather than left to the reader to infer from a card that vanished.
    expect(
      document.body.querySelector('[data-slot="egress-approval-expired"]')?.textContent
    ).toContain('This request expired before it was answered')
    // The host is still on screen (the reader can see what was refused) — but there is nothing to click.
    expect(document.body.textContent).toContain('stats.example.com')
    expect(document.body.querySelectorAll('button')).toHaveLength(0)
    expect(document.body.querySelector('[data-slot="egress-approval-countdown"]')).toBeNull()
  })
})
