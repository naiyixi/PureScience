// @vitest-environment jsdom
// Render + interaction tests for the VerificationChecklistPanel (session-level aggregation of
// every warn/fail claim across all reviews). Verifies: empty state, claim rows with verdict
// badges, reflag/assessment meta, Mark addressed → Reopen round-trip through the review store.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VerificationChecklist, VerificationChecklistItem } from '../../../../shared/reviewer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// --- store mock ---
const mutateChecklist = vi.fn()
const loadChecklist = vi.fn()
let checklistFixture: VerificationChecklist = {
  projectId: 'project-1',
  sessionId: 'session-1',
  items: []
}

vi.mock('@/stores/review-store', () => ({
  useReviewStore: (selector: (state: unknown) => unknown) =>
    selector({
      getChecklist: () => checklistFixture,
      loadChecklist,
      mutateChecklist
    })
}))

import { VerificationChecklistPanel } from './VerificationChecklistPanel'

const makeItem = (overrides: Partial<VerificationChecklistItem>): VerificationChecklistItem => ({
  rootFindingId: 'finding-1',
  claim: 'Agent claimed to run the test but no tool call exists',
  latestStatus: 'fail',
  latestEvidence: 'msg[2] tool_result shows exit code 127 — command not found',
  resolution: 'open',
  reflagCount: 0,
  firstReviewId: 'review-1',
  firstTurnMessageId: 'msg-1',
  firstReviewedAt: 1000,
  latestReviewId: 'review-1',
  latestTurnMessageId: 'msg-1',
  lastReviewedAt: 1000,
  assessmentCount: 1,
  latestLocator: {
    blockRef: { messageId: 'msg-2', blockIndex: 1 },
    contentHash: 'abc123'
  },
  ...overrides
})

let container: HTMLElement
let root: Root

const renderPanel = (): void => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      <VerificationChecklistPanel
        projectId="project-1"
        sessionId="session-1"
        onGoToTranscript={vi.fn()}
      />
    )
  })
}

const panelText = (): string => container.textContent ?? ''

beforeEach(() => {
  checklistFixture = { projectId: 'project-1', sessionId: 'session-1', items: [] }
  mutateChecklist.mockReset()
  loadChecklist.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('VerificationChecklistPanel', () => {
  it('loads the checklist on mount', () => {
    renderPanel()
    expect(loadChecklist).toHaveBeenCalledWith('session-1', 'project-1')
  })

  it('renders the empty state when the session has no claims', () => {
    renderPanel()
    expect(container.querySelector('[data-testid="checklist-empty"]')).not.toBeNull()
    expect(panelText()).toContain('0 open of 0 claims')
  })

  it('renders each claim with verdict badge, evidence, and meta', () => {
    checklistFixture = {
      projectId: 'project-1',
      sessionId: 'session-1',
      items: [
        makeItem({}),
        makeItem({
          rootFindingId: 'finding-2',
          claim: 'Row count verified as 33',
          latestStatus: 'warn',
          latestEvidence: 'Counted 32 rows from artifact-csv; agent reported 33.',
          resolution: 'resolved',
          reflagCount: 2,
          assessmentCount: 3
        })
      ]
    }
    renderPanel()

    const rows = container.querySelectorAll('[data-testid="checklist-claim"]')
    expect(rows).toHaveLength(2)

    const first = rows[0] as HTMLElement
    expect(first.textContent).toContain('fail')
    expect(first.textContent).toContain('Agent claimed to run the test')
    expect(first.textContent).toContain('exit code 127')
    expect(first.textContent).toContain('assessed ×1')
    expect(first.getAttribute('data-resolution')).toBe('open')

    const second = rows[1] as HTMLElement
    expect(second.textContent).toContain('warn')
    expect(second.textContent).toContain('Row count verified as 33')
    expect(second.textContent).toContain('re-flagged ×2')
    expect(second.textContent).toContain('assessed ×3')
    expect(second.getAttribute('data-resolution')).toBe('resolved')
  })

  it('shows the open-claim count in the header', () => {
    checklistFixture = {
      projectId: 'project-1',
      sessionId: 'session-1',
      items: [
        makeItem({}),
        makeItem({ rootFindingId: 'finding-2', resolution: 'resolved' }),
        makeItem({ rootFindingId: 'finding-3', resolution: 'unaddressed' })
      ]
    }
    renderPanel()
    expect(panelText()).toContain('2 open of 3 claims')
  })

  it('marks a claim addressed via the store mutation and reloads', () => {
    checklistFixture = {
      projectId: 'project-1',
      sessionId: 'session-1',
      items: [makeItem({})]
    }
    mutateChecklist.mockResolvedValue(undefined)
    loadChecklist.mockResolvedValue(undefined)
    renderPanel()

    const markButton = container.querySelector('[data-testid="checklist-mark-addressed"]')
    expect(markButton).not.toBeNull()
    act(() => {
      ;(markButton as HTMLButtonElement).click()
    })

    expect(mutateChecklist).toHaveBeenCalledWith({
      projectId: 'project-1',
      appSessionId: 'session-1',
      rootFindingId: 'finding-1',
      resolution: 'resolved'
    })
  })

  it('offers Reopen on a resolved claim and flips it back to open', () => {
    checklistFixture = {
      projectId: 'project-1',
      sessionId: 'session-1',
      items: [makeItem({ resolution: 'resolved' })]
    }
    mutateChecklist.mockResolvedValue(undefined)
    renderPanel()

    const reopenButton = container.querySelector('[data-testid="checklist-reopen"]')
    expect(reopenButton).not.toBeNull()
    act(() => {
      ;(reopenButton as HTMLButtonElement).click()
    })

    expect(mutateChecklist).toHaveBeenCalledWith({
      projectId: 'project-1',
      appSessionId: 'session-1',
      rootFindingId: 'finding-1',
      resolution: 'open'
    })
  })

  it('renders the Go to transcript action on every claim', () => {
    checklistFixture = {
      projectId: 'project-1',
      sessionId: 'session-1',
      items: [makeItem({})]
    }
    renderPanel()
    expect(container.querySelector('[data-testid="checklist-go-transcript"]')).not.toBeNull()
  })
})
