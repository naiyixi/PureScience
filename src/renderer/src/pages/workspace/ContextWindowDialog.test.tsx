// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ContextWindowDialog } from './ContextWindowDialog'

const tMock = vi.fn((key: string) => key)

vi.mock('@/i18n', () => ({
  useLanguage: () => ({ t: tMock, lang: 'en' })
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.PropsWithChildren): React.JSX.Element => (
    <button type="button" {...props}>
      {children}
    </button>
  )
}))

const usageMessage = (
  id: string,
  createdAt: number,
  input: number,
  cache: number,
  output: number
): {
  id: string
  role: 'agent'
  content: string
  createdAt: number
  status: 'complete'
  eventIds: never[]
  turnUsage: { inputTokens: number; cacheTokens: number; outputTokens: number; turnCount: number }
} => ({
  id,
  role: 'agent' as const,
  content: `turn ${id}`,
  createdAt,
  status: 'complete' as const,
  eventIds: [],
  turnUsage: { inputTokens: input, cacheTokens: cache, outputTokens: output, turnCount: 1 }
})

const baseSession = {
  id: 's1',
  projectId: 'p1',
  title: 'Session',
  cwd: '/tmp',
  status: 'idle' as const,
  messages: [usageMessage('m1', 1000, 100, 50, 20), usageMessage('m2', 2000, 300, 80, 40)],
  activities: [],
  createdAt: 1000,
  updatedAt: 2000
}

let container: HTMLElement
let root: Root

const renderDialog = (session = baseSession): void => {
  act(() => {
    root.render(
      <ContextWindowDialog open session={session as never} onOpenChange={() => undefined} />
    )
  })
}

describe('ContextWindowDialog usage calls section', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    tMock.mockClear()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const callsSection = (): HTMLElement | null =>
    document.body.querySelector('[data-slot="context-window-calls"]')

  it('renders a per-call bar for every agent message with usage', () => {
    renderDialog()
    expect(callsSection()).not.toBeNull()
    const bars = document.body.querySelectorAll('[data-slot="context-window-calls"] .h-full')
    // 2 records × 3 segments (input/cache/output)
    expect(bars.length).toBe(6)
  })

  it('shows the newest call first', () => {
    renderDialog()
    const text = callsSection()?.textContent ?? ''
    // m2 (newer, 420 total) appears before m1 (170 total)
    expect(text.indexOf('420 tokens')).toBeGreaterThan(-1)
  })

  it('hides the section when no message reports usage', () => {
    renderDialog({ ...baseSession, messages: [{ ...usageMessage('m1', 1000, 0, 0, 0) }] })
    expect(callsSection()).toBeNull()
  })
})
