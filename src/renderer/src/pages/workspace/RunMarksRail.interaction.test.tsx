// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Controllable stand-ins for the shadcn message-scroller context the rail reads.
const mocks = vi.hoisted(() => ({
  scrollToMessage: vi.fn(() => false),
  visibleMessageIds: [] as string[]
}))

vi.mock('@/components/ui/message-scroller', () => ({
  useMessageScroller: () => ({
    scrollToEnd: () => false,
    scrollToMessage: mocks.scrollToMessage,
    scrollToStart: () => false
  }),
  useMessageScrollerVisibility: () => ({
    currentAnchorId: null,
    visibleMessageIds: mocks.visibleMessageIds
  })
}))

import { RunMarksRail, RUN_MARKS_MIN_TURNS } from './RunMarksRail'

const renderRail = (userMessageIds: string[]): HTMLElement => {
  const container = document.createElement('div')
  document.body.appendChild(container)

  act(() => {
    createRoot(container).render(<RunMarksRail userMessageIds={userMessageIds} />)
  })
  return container
}

const makeIds = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `user-message-${index + 1}`)

describe('RunMarksRail', () => {
  beforeEach(() => {
    mocks.scrollToMessage.mockClear()
    mocks.visibleMessageIds = []
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('is hidden below the turn threshold', () => {
    const container = renderRail(makeIds(RUN_MARKS_MIN_TURNS - 1))
    expect(container.querySelector('[data-testid="run-marks-rail"]')).toBeNull()
  })

  it('renders one dot per user message at or above the threshold', () => {
    const ids = makeIds(RUN_MARKS_MIN_TURNS)
    const container = renderRail(ids)

    const rail = container.querySelector('[data-testid="run-marks-rail"]')
    expect(rail).not.toBeNull()
    expect(container.querySelectorAll('[data-testid="run-mark"]')).toHaveLength(ids.length)
  })

  it('jumps to the matching turn when a dot is clicked', () => {
    const ids = makeIds(12)
    const container = renderRail(ids)

    const dots = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="run-mark"]')
    )
    act(() => {
      dots[7]?.click()
    })
    expect(mocks.scrollToMessage).toHaveBeenCalledWith('user-message-8', {
      align: 'start',
      behavior: 'smooth'
    })
  })

  it('highlights the last user turn currently visible', () => {
    const ids = makeIds(10)
    mocks.visibleMessageIds = ['user-message-1', 'user-message-2', 'user-message-3']
    const container = renderRail(ids)

    const dots = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="run-mark"]')
    )
    const activeDots = dots.filter((dot) => dot.dataset.active === 'true')
    expect(activeDots).toHaveLength(1)
    // user-message-3 is the last visible turn → index 2.
    expect(dots.indexOf(activeDots[0]!)).toBe(2)
  })

  it('marks each dot with an accessible turn label', () => {
    const container = renderRail(makeIds(9))
    const dots = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="run-mark"]')
    )
    expect(dots[0]?.getAttribute('aria-label')).toBe('Jump to turn 1')
    expect(dots[8]?.getAttribute('aria-label')).toBe('Jump to turn 9')
  })
})
