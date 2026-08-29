// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceSidebar } from './WorkspaceSidebar'
import type { ChatSession } from '@/stores/session-store'

// Session hover preview card: dwell opens, leave closes, scroll dismisses, long titles scroll.

const HOVER_OPEN_DELAY_MS = 250
const HOVER_CLOSE_DELAY_MS = 150

const createSession = (overrides: Partial<ChatSession>): ChatSession => ({
  id: 'session-1',
  projectId: 'default',
  title: 'Analysis session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

const renderSidebar = (sessions: ChatSession[]): HTMLDivElement => {
  const container = document.createElement('div')
  document.body.appendChild(container)

  act(() => {
    createRoot(container).render(
      <WorkspaceSidebar
        projectName="Example project"
        sessions={sessions}
        activeSessionId={sessions[0]?.id}
        canCreateConversation
        canMutateConversations
        canDeleteConversations
        onGoHome={vi.fn()}
        onNewConversation={vi.fn()}
        isFilesOpen={false}
        onOpenFiles={vi.fn()}
        onOpenSession={vi.fn()}
        onRenameSession={vi.fn()}
        canDownloadArtifacts
        onDownloadArtifacts={vi.fn()}
        onViewNotebook={vi.fn()}
        onExportSession={vi.fn()}
        onTogglePin={vi.fn()}
        onDeleteSession={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    )
  })

  return container
}

const dispatchMouseEnter = (row: HTMLElement): void => {
  // React synthesizes mouseenter from bubbling mouseover events in jsdom.
  row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
}

const dispatchMouseLeave = (row: HTMLElement): void => {
  row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
}

const getSessionRow = (container: HTMLElement, index = 0): HTMLElement => {
  const rows = container.querySelectorAll('button[aria-current]')
  const row = rows[index]?.closest('div.group')
  if (!(row instanceof HTMLElement)) throw new Error('Session row not found.')
  return row
}

describe('WorkspaceSidebar session hover card', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('opens a preview card after a deliberate dwell showing title and description', () => {
    const container = renderSidebar([
      createSession({
        id: 'session-a',
        title: 'EGFR resistance analysis',
        description: 'Mutations after osimertinib treatment in the FLAURA2 cohort.'
      })
    ])
    const row = getSessionRow(container)

    act(() => {
      dispatchMouseEnter(row)
    })
    expect(document.body.querySelector('[data-testid="session-hover-card"]')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS)
    })
    const card = document.body.querySelector('[data-testid="session-hover-card"]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('EGFR resistance analysis')
    expect(card?.textContent).toContain('FLAURA2 cohort')
  })

  it('closes the card after the leave grace delay', () => {
    const container = renderSidebar([createSession({ id: 'session-a', title: 'Quick check' })])
    const row = getSessionRow(container)

    act(() => {
      dispatchMouseEnter(row)
      vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS)
    })
    expect(document.body.querySelector('[data-testid="session-hover-card"]')).not.toBeNull()

    act(() => {
      dispatchMouseLeave(row)
      vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS)
    })
    expect(document.body.querySelector('[data-testid="session-hover-card"]')).toBeNull()
  })

  it('does not flash a card for a fast sweep across a row', () => {
    const container = renderSidebar([createSession({ id: 'session-a', title: 'Sweep past' })])
    const row = getSessionRow(container)

    act(() => {
      dispatchMouseEnter(row)
      vi.advanceTimersByTime(60)
      dispatchMouseLeave(row)
    })
    expect(document.body.querySelector('[data-testid="session-hover-card"]')).toBeNull()
  })

  it('dismisses an open card when the session list scrolls', () => {
    const container = renderSidebar([createSession({ id: 'session-a', title: 'Scrolling away' })])
    const row = getSessionRow(container)

    act(() => {
      dispatchMouseEnter(row)
      vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS)
    })
    expect(document.body.querySelector('[data-testid="session-hover-card"]')).not.toBeNull()

    const scroller = container.querySelector('.overflow-y-auto')
    expect(scroller).not.toBeNull()
    act(() => {
      scroller?.dispatchEvent(new Event('scroll'))
    })
    expect(document.body.querySelector('[data-testid="session-hover-card"]')).toBeNull()
  })

  it('omits the description block for sessions without one', () => {
    const container = renderSidebar([createSession({ id: 'session-a', title: 'No description' })])
    const row = getSessionRow(container)

    act(() => {
      dispatchMouseEnter(row)
      vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS)
    })
    const card = document.body.querySelector('[data-testid="session-hover-card"]')
    expect(card).not.toBeNull()
    expect(card?.querySelector('[data-testid="session-hover-card-description"]')).toBeNull()
  })
})
