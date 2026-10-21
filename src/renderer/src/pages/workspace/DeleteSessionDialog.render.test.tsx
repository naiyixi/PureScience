// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DeleteSessionDialog } from './DeleteSessionDialog'
import type { ChatSession } from '@/stores/session-store'
import type { SessionNotebookUsage } from '../../../../shared/session-persistence'

/**
 * How long a coordination wait may take.
 *
 * Every `vi.waitFor` here waits for the side effect of work already in flight (the confirmation's own read
 * resolving, then the sentence it produces reaching the DOM), never for something that may never happen.
 * 30 s is this repository's window for load-sensitive waits and stays well below vitest's per-test timeout,
 * so a genuinely stuck assertion still fails instead of hanging.
 */
const COORDINATION_WINDOW_MS = 30_000

const session = (overrides: Partial<ChatSession> = {}): ChatSession =>
  ({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Single-cell atlas',
    description: '',
    cwd: '/workspace',
    status: 'idle',
    messages: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_900_000,
    ...overrides
  }) as ChatSession

const roots: Array<() => void> = []

const mount = (element: React.JSX.Element): HTMLElement => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(element)
  })
  roots.push(() => {
    act(() => root.unmount())
    container.remove()
  })
  return container
}

// Radix portals the dialog into document.body, so the assertions read from there rather than from the
// container the element was mounted in.
const runDataLine = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[data-slot="delete-session-run-data"]')

const stubRead = (
  implementation: () => Promise<SessionNotebookUsage>
): ReturnType<typeof vi.fn> => {
  const read = vi.fn(implementation)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { sessions: { readNotebookUsage: read } }
  })
  return read
}

afterEach(() => {
  while (roots.length > 0) roots.pop()?.()
  document.body.innerHTML = ''
  Reflect.deleteProperty(window, 'api')
})

describe('the delete-session confirmation names the run data it takes with it', () => {
  it('prints the measured size, and asks for that session specifically', async () => {
    const read = stubRead(async () => ({ state: 'measured', bytes: 1_572_864 }))

    mount(
      <DeleteSessionDialog
        session={session()}
        canDelete
        onCancel={() => undefined}
        onConfirmDelete={() => undefined}
      />
    )

    await vi.waitFor(() => expect(runDataLine()).not.toBeNull(), {
      timeout: COORDINATION_WINDOW_MS
    })
    expect(read).toHaveBeenCalledWith({ projectId: 'project-1', sessionId: 'session-1' })
    expect(runDataLine()?.textContent).toContain('1.5 MB')
    // The existing promise about artifacts is unchanged; this line is additive, not a replacement.
    expect(document.body.textContent).toContain('Artifacts created in this session will remain')
  })

  it('says a session with no run data has none, rather than showing a zero', async () => {
    stubRead(async () => ({ state: 'absent' }))

    mount(
      <DeleteSessionDialog
        session={session()}
        canDelete
        onCancel={() => undefined}
        onConfirmDelete={() => undefined}
      />
    )

    await vi.waitFor(() => expect(runDataLine()).not.toBeNull(), {
      timeout: COORDINATION_WINDOW_MS
    })
    expect(runDataLine()?.textContent).toContain('produced no notebook run data')
  })

  it('says the size could not be measured when the read fails, instead of saying nothing', async () => {
    stubRead(async () => Promise.reject(new Error('EACCES')))

    mount(
      <DeleteSessionDialog
        session={session()}
        canDelete
        onCancel={() => undefined}
        onConfirmDelete={() => undefined}
      />
    )

    await vi.waitFor(() => expect(runDataLine()).not.toBeNull(), {
      timeout: COORDINATION_WINDOW_MS
    })
    expect(runDataLine()?.textContent).toContain('could not be measured')
  })

  it('claims nothing while the reading is still in flight', async () => {
    let resolveRead: ((usage: SessionNotebookUsage) => void) | undefined
    stubRead(
      () =>
        new Promise<SessionNotebookUsage>((resolve) => {
          resolveRead = resolve
        })
    )

    mount(
      <DeleteSessionDialog
        session={session()}
        canDelete
        onCancel={() => undefined}
        onConfirmDelete={() => undefined}
      />
    )

    // Before the answer arrives there is no reading, so there is no sentence about one — printing "no run
    // data" here would be the "nothing to lose" claim made on the strength of a request, not a measurement.
    expect(runDataLine()).toBeNull()
    expect(document.body.textContent).toContain('Delete Session?')

    await act(async () => {
      resolveRead?.({ state: 'measured', bytes: 4096 })
    })
    await vi.waitFor(() => expect(runDataLine()).not.toBeNull(), {
      timeout: COORDINATION_WINDOW_MS
    })
    expect(runDataLine()?.textContent).toContain('4.0 KB')
  })
})
