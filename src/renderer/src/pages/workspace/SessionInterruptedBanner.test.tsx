// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionInterruptedBanner } from './SessionInterruptedBanner'

// React's act() refuses to run unless the environment opts in to act-aware scheduling.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  vi.clearAllMocks()
})

const getResumeButton = (): HTMLButtonElement => {
  const button = container.querySelector('[data-testid="session-interrupted-resume"]')
  if (!button) throw new Error('resume button not found')
  return button as HTMLButtonElement
}

describe('SessionInterruptedBanner', () => {
  it('shows the message and resumes when the enabled button is clicked', () => {
    const onResume = vi.fn()
    const onContinue = vi.fn()
    act(() => {
      root.render(
        <SessionInterruptedBanner
          message="Session was interrupted before the app closed."
          isDisabled={false}
          isResuming={false}
          isContinuing={false}
          canContinue
          onResume={onResume}
          onContinue={onContinue}
        />
      )
    })

    expect(container.textContent).toContain('Session was interrupted before the app closed.')
    const button = getResumeButton()
    expect(button.disabled).toBe(false)
    expect(button.textContent).toContain('Resume')

    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onResume).toHaveBeenCalledTimes(1)
  })

  it('disables the button and ignores clicks while a resume is in flight', () => {
    const onResume = vi.fn()
    const onContinue = vi.fn()
    act(() => {
      root.render(
        <SessionInterruptedBanner
          message="Interrupted."
          isDisabled={false}
          isResuming
          isContinuing={false}
          canContinue
          onResume={onResume}
          onContinue={onContinue}
        />
      )
    })

    const button = getResumeButton()
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('Resuming')

    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onResume).not.toHaveBeenCalled()
  })

  it('disables the button and ignores clicks while Session persistence is unavailable', () => {
    const onResume = vi.fn()
    const onContinue = vi.fn()
    act(() => {
      root.render(
        <SessionInterruptedBanner
          message="Interrupted."
          isDisabled
          isResuming={false}
          isContinuing={false}
          canContinue
          onResume={onResume}
          onContinue={onContinue}
        />
      )
    })

    const button = getResumeButton()
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('Resume')

    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onResume).not.toHaveBeenCalled()
  })
  it('continues the interrupted turn and leaves resume alone', () => {
    const onResume = vi.fn()
    const onContinue = vi.fn()
    act(() => {
      root.render(
        <SessionInterruptedBanner
          message="Session was interrupted before the app closed."
          isDisabled={false}
          isResuming={false}
          isContinuing={false}
          canContinue
          onResume={onResume}
          onContinue={onContinue}
        />
      )
    })

    // The difference between the two actions is on screen, not only in a tooltip.
    const hints = container.querySelector('[data-testid="session-interrupted-hints"]')?.textContent
    expect(hints).toContain('Continue picks the turn up where it stopped')
    expect(hints).toContain('Resume sends this message again as a new turn.')

    act(() => {
      ;(
        container.querySelector('[data-testid="session-interrupted-continue"]') as HTMLButtonElement
      ).click()
    })
    expect(onContinue).toHaveBeenCalledTimes(1)
    expect(onResume).not.toHaveBeenCalled()
  })

  it('offers no Continue when there is no unfinished turn, and says so', () => {
    const onResume = vi.fn()
    const onContinue = vi.fn()
    act(() => {
      root.render(
        <SessionInterruptedBanner
          message="Session was interrupted before the app closed."
          isDisabled={false}
          isResuming={false}
          isContinuing={false}
          canContinue={false}
          onResume={onResume}
          onContinue={onContinue}
        />
      )
    })

    const button = container.querySelector(
      '[data-testid="session-interrupted-continue"]'
    ) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-label')).toBe('There is no unfinished turn to pick up.')
    act(() => {
      button.click()
    })
    expect(onContinue).not.toHaveBeenCalled()
    expect(onResume).not.toHaveBeenCalled()
  })

  it('names why a continuation failed', () => {
    act(() => {
      root.render(
        <SessionInterruptedBanner
          message="Session was interrupted before the app closed."
          isDisabled={false}
          isResuming={false}
          isContinuing={false}
          canContinue
          continueError="The turn could not be continued: Interrupted Session could not be loaded."
          onResume={vi.fn()}
          onContinue={vi.fn()}
        />
      )
    })

    expect(container.querySelector('[data-testid="session-interrupted-error"]')?.textContent).toBe(
      'The turn could not be continued: Interrupted Session could not be loaded.'
    )
  })
})
