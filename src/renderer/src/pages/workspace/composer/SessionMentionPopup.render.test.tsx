// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LanguageProvider } from '@/i18n'
import type { ChatSession } from '@/stores/session-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'

import { SessionMentionPopup } from './SessionMentionPopup'

let container: HTMLDivElement
let root: Root

const session = (id: string, title: string, updatedAt: number): ChatSession =>
  ({
    id,
    projectId: 'project-a',
    title,
    cwd: '/workspace',
    status: 'idle',
    createdAt: updatedAt,
    updatedAt,
    messages: [],
    artifacts: []
  }) as ChatSession

beforeEach(() => {
  useSessionStore.setState({
    ...createInitialSessionState(),
    sessions: [
      session('session-old', 'Older session', 1),
      session('session-new', 'Newest session', 2)
    ]
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

const options = (): HTMLElement[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'))

const selectedOption = (): HTMLElement | undefined =>
  options().find((option) => option.getAttribute('aria-selected') === 'true')

const pressKey = (key: string): void => {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

const renderPopup = async ({
  query = '',
  excludeId,
  onSelect = vi.fn(),
  onClose = vi.fn()
}: {
  query?: string
  excludeId?: string
  onSelect?: (value: unknown) => void
  onClose?: () => void
} = {}): Promise<void> => {
  await act(async () => {
    root.render(
      <LanguageProvider>
        <SessionMentionPopup
          query={query}
          excludeId={excludeId}
          onSelect={onSelect}
          onClose={onClose}
        />
      </LanguageProvider>
    )
    await Promise.resolve()
  })
}

describe('SessionMentionPopup', () => {
  it('lists sessions newest-first as one selectable row each', async () => {
    await renderPopup()

    const rows = options()
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Newest session')
    expect(rows[1].textContent).toContain('Older session')
  })

  it('selects the highlighted session on Enter', async () => {
    const onSelect = vi.fn()
    await renderPopup({ onSelect })

    pressKey('Enter')

    expect(onSelect).toHaveBeenCalledWith({ id: 'session-new', title: 'Newest session' })
  })

  it('moves the highlight with the arrow keys and wraps at both ends', async () => {
    const onSelect = vi.fn()
    await renderPopup({ onSelect })

    pressKey('ArrowDown')
    expect(selectedOption()?.textContent).toContain('Older session')

    // Down from the last row wraps to the first.
    pressKey('ArrowDown')
    expect(selectedOption()?.textContent).toContain('Newest session')

    // Up from the first row wraps to the last.
    pressKey('ArrowUp')
    expect(selectedOption()?.textContent).toContain('Older session')

    // The highlight is what Enter acts on.
    pressKey('Enter')
    expect(onSelect).toHaveBeenCalledWith({ id: 'session-old', title: 'Older session' })
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    await renderPopup({ onClose })

    pressKey('Escape')

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('dismisses the picker on Enter when nothing matches so the key is never dead', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    return renderPopup({ query: 'no-such-session', onSelect, onClose }).then(() => {
      expect(options()).toHaveLength(0)

      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      act(() => {
        document.dispatchEvent(event)
      })

      // Enter neither selects nor silently disappears: it closes the picker, and it is claimed so
      // the editor does not submit the raw #query token in the same keystroke.
      expect(onSelect).not.toHaveBeenCalled()
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(event.defaultPrevented).toBe(true)
    })
  })

  it('claims Enter and Escape while it is open', async () => {
    await renderPopup()

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => {
      document.dispatchEvent(enter)
      document.dispatchEvent(escape)
    })

    expect(enter.defaultPrevented).toBe(true)
    expect(escape.defaultPrevented).toBe(true)
  })

  it('selects a row on click', async () => {
    const onSelect = vi.fn()
    await renderPopup({ onSelect })

    act(() => options()[1].click())

    expect(onSelect).toHaveBeenCalledWith({ id: 'session-old', title: 'Older session' })
  })

  it('never lists the session it is opened from', async () => {
    await renderPopup({ excludeId: 'session-new' })

    const rows = options()
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Older session')
  })

  it('falls back to an untitled label for a session without a title', async () => {
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [session('session-untitled', '', 1)]
    })
    const onSelect = vi.fn()

    await renderPopup({ onSelect })
    pressKey('Enter')

    expect(onSelect).toHaveBeenCalledWith({ id: 'session-untitled', title: '(untitled session)' })
  })
})
