// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { SessionHoverCard } from './SessionHoverCard'
import type { ChatSession } from '@/stores/session-store'

const session: ChatSession = {
  id: 'session-1',
  projectId: 'default',
  title: 'Session title',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 0,
  updatedAt: 0
}

const renderCard = (anchor: { top: number; left: number; width: number; height: number }): HTMLElement => {
  const container = document.createElement('div')
  document.body.appendChild(container)

  act(() => {
    createRoot(container).render(<SessionHoverCard session={session} anchor={anchor} />)
  })

  const card = document.body.querySelector<HTMLElement>('[data-testid="session-hover-card"]')
  if (!card) throw new Error('Hover card did not render.')
  return card
}

describe('SessionHoverCard positioning', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('floats to the right of the row when it fits in the viewport', () => {
    const card = renderCard({ top: 40, left: 200, width: 220, height: 36 })
    expect(card.style.left).toBe('428px') // 200 + 220 + 8 gap
    expect(card.style.top).toBe('40px')
  })

  it('flips to the left when the card would overflow the window edge', () => {
    const card = renderCard({ top: 40, left: 800, width: 220, height: 36 })
    // 800 - 8 gap - 288 width = 504; jsdom viewport is 1024 wide so the right side overflows.
    expect(card.style.left).toBe('504px')
  })

  it('clamps vertically so a last-row card stays inside the window', () => {
    const card = renderCard({ top: 700, left: 200, width: 220, height: 36 })
    // 768 - 220 max height - 8 padding = 540
    expect(card.style.top).toBe('540px')
  })
})
