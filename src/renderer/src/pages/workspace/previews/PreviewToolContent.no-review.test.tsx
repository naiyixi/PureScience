// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useNavigationStore } from '@/stores/navigation-store'
import { useReviewStore } from '@/stores/review-store'
import { useSessionStore } from '@/stores/session-store'

import { PreviewToolContent } from '../previews/PreviewToolContent'

// U18: the reviewer surface has to be reachable BEFORE a review exists — the entry is the session itself,
// and the surface has to say why the checks tab is not there yet instead of rendering as if broken.
const reviewerItem = {
  id: 'tool:session-1:reviewer',
  sessionId: 'session-1',
  type: 'tool' as const,
  toolKind: 'reviewer' as const,
  title: 'Session Reviewer',
  reviewerSessionId: 'session-1'
}

describe('reviewer surface without a review', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useReviewStore.setState({ reviewsBySession: {} })
    useNavigationStore.setState({ activeProjectId: 'project-1' })
    useSessionStore.setState({ sessions: [] })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('keeps the session-scoped tabs and explains the missing checks tab', async () => {
    await act(async () => {
      root.render(<PreviewToolContent item={reviewerItem} />)
    })

    expect(document.querySelector('[data-testid="reviewer-tab-checklist"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="reviewer-tab-context"]')).not.toBeNull()
    // The checks tab is the one that needs a review row, so it is the one that is absent.
    expect(document.querySelector('[data-testid="reviewer-tab-checks"]')).toBeNull()
    expect(document.querySelector('[data-testid="reviewer-no-review"]')?.textContent).toContain(
      'No review'
    )
  })

  it('switches to the folded-context tab without needing a review', async () => {
    await act(async () => {
      root.render(<PreviewToolContent item={reviewerItem} />)
    })

    const contextTab = document.querySelector<HTMLButtonElement>(
      '[data-testid="reviewer-tab-context"]'
    )
    await act(async () => {
      contextTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(contextTab?.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('[data-testid="reviewer-no-review"]')).not.toBeNull()

    const checklistTab = document.querySelector<HTMLButtonElement>(
      '[data-testid="reviewer-tab-checklist"]'
    )
    await act(async () => {
      checklistTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(checklistTab?.getAttribute('aria-pressed')).toBe('true')
  })
})
