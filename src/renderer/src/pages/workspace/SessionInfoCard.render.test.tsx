// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SessionInfoCard } from './SessionInfoCard'
import { drainWorkspaceRuntimeEventsForPersistence } from '../../lib/acp/useWorkspaceAgentRuntime'
import { flushSessionPersistence } from '../../lib/session-persistence/session-persistence'
import type { ChatSession } from '@/stores/session-store'

// The measurement must push pending writes down before it reads the document, so the two calls that do it
// are spies here; everything else in these modules stays real.
vi.mock('../../lib/acp/useWorkspaceAgentRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/acp/useWorkspaceAgentRuntime')>()),
  drainWorkspaceRuntimeEventsForPersistence: vi.fn(async () => undefined)
}))
vi.mock('../../lib/session-persistence/session-persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/session-persistence/session-persistence')>()),
  flushSessionPersistence: vi.fn(async () => undefined)
}))

// Counts are read from the same messages the transcript renders, so the card cannot disagree with
// what the reader sees — this test pins that, plus the pin's persistence and the evidence hand-off.

const session = (overrides: Partial<ChatSession> = {}): ChatSession =>
  ({
    id: 'session-1',
    projectId: 'default',
    title: 'Deep learning for protein design',
    description: 'A short description',
    cwd: '/workspace',
    status: 'idle',
    messages: [
      { id: 'm1', role: 'user', content: 'do the thing', status: 'complete', artifacts: [] },
      {
        id: 'm2',
        role: 'agent',
        content: 'done',
        status: 'complete',
        artifacts: [
          { id: 'artifact-1', name: 'figure.png' },
          { id: 'artifact-2', name: 'table.csv' }
        ]
      },
      { id: 'm3', role: 'agent', content: 'and again', status: 'complete', artifacts: [] }
    ],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_900_000,
    ...overrides
  }) as ChatSession

const roots: Array<() => void> = []

// React tracks a controlled input's value on the element, so assigning `.value` alone never fires the
// element's change handler — the native setter has to be used and the element's own event dispatched.
const setNativeValue = (element: HTMLInputElement | HTMLSelectElement, value: string): void => {
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
}

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

const rowValue = (container: HTMLElement, label: string): string | undefined => {
  const rows = [...container.querySelectorAll('div')]
  for (const row of rows) {
    const term = row.querySelector('dt')
    if (term?.textContent !== label) continue
    const value = row.querySelector('dd')
    if (value) return value.textContent ?? undefined
  }
  return undefined
}

afterEach(() => {
  while (roots.length > 0) roots.pop()?.()
  window.localStorage.clear()
})

describe('session information card', () => {
  it('counts messages, agent replies and distinct artifacts from the transcript itself', () => {
    const container = mount(<SessionInfoCard session={session()} onClose={() => undefined} />)
    const labels = [...container.querySelectorAll('dt')].map((term) => term.textContent)
    expect(labels).toContain('Messages')
    expect(rowValue(container, 'Messages')).toBe('3')
    expect(rowValue(container, 'Agent replies')).toBe('2')
    expect(rowValue(container, 'Artifacts')).toBe('2')
  })

  it('keeps the pin as a view preference that survives a remount', () => {
    const first = mount(<SessionInfoCard session={session()} onClose={() => undefined} />)
    const card = first.querySelector('[data-slot="session-info-card"]')
    expect(card?.getAttribute('data-pinned')).toBe('false')
    const pinButton = first.querySelector('button[aria-label="Pin"]') as HTMLButtonElement
    act(() => {
      pinButton.click()
    })
    expect(
      first.querySelector('[data-slot="session-info-card"]')?.getAttribute('data-pinned')
    ).toBe('true')
    expect(window.localStorage.getItem('purescience.sessionInfoCard.pinned.session-1')).toBe('true')

    const second = mount(<SessionInfoCard session={session()} onClose={() => undefined} />)
    expect(
      second.querySelector('[data-slot="session-info-card"]')?.getAttribute('data-pinned')
    ).toBe('true')
  })

  it('hands the evidence surface over and closes itself', () => {
    const onOpenEvidence = vi.fn()
    const onClose = vi.fn()
    const container = mount(
      <SessionInfoCard session={session()} onOpenEvidence={onOpenEvidence} onClose={onClose} />
    )
    const evidence = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Open evidence')
    ) as HTMLButtonElement
    act(() => {
      evidence.click()
    })
    expect(onOpenEvidence).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // The transcript is persisted asynchronously, so a document read taken while a reply is still in flight
  // reports a copy that omits it — the preview would under-count what is already on screen. That is how the
  // fork certification spec failed on a slow runner; the order below is the fix.
  it('drains and flushes the transcript before reading the document it measures', async () => {
    const order: string[] = []
    const measured = session({ id: 'session-flush-order' })
    const api = {
      sessions: {
        readDocument: async (): Promise<unknown> => {
          order.push('read')
          return {
            ...measured,
            messages: measured.messages,
            activities: [],
            createdAt: 1,
            updatedAt: 2
          }
        },
        saveSession: async (): Promise<void> => undefined
      }
    }
    const previous = (window as unknown as { api?: unknown }).api
    ;(window as unknown as { api: unknown }).api = api
    vi.mocked(drainWorkspaceRuntimeEventsForPersistence).mockImplementation(async () => {
      order.push('drain')
    })
    vi.mocked(flushSessionPersistence).mockImplementation(async () => {
      order.push('flush')
    })
    try {
      const container = mount(<SessionInfoCard session={measured} onClose={() => {}} />)
      await act(async () => {
        container
          .querySelector('[data-slot="session-fork-measure"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await vi.waitFor(() => {
        expect(order).toContain('read')
      })
      // IC52: the card also reads the document once at mount for its read-only replay section. The
      // property this case pins is about the MEASUREMENT — whatever else reads, the measurement's read
      // must come after both the drain and the flush — so the sequence is asserted as: the card's own
      // read first, then the measurement's read behind drain + flush. Naming the extra read keeps this
      // exact rather than merely tolerant.
      expect(order[0]).toBe('read')
      expect(order.slice(1)).toEqual(['drain', 'flush', 'read'])
    } finally {
      ;(window as unknown as { api: unknown }).api = previous
    }
  })

  // The card is re-mounted while it is open (a session update re-renders the mount site), which the
  // packaged app showed by losing a freshly measured fork plan. The numbers are the reader's work, so
  // they are kept per session and a fresh instance must show them again.
  it('keeps a measured fork plan across a re-mount of the card', async () => {
    const forked = session({ id: 'session-remount' })
    const saved: unknown[] = []
    const api = {
      sessions: {
        readDocument: async (): Promise<unknown> => ({
          ...forked,
          title: 'Deep learning for protein design',
          messages: forked.messages,
          activities: [],
          createdAt: 1,
          updatedAt: 2
        }),
        saveSession: async (document: unknown): Promise<void> => {
          saved.push(document)
        }
      }
    }
    const previous = (window as unknown as { api?: unknown }).api
    ;(window as unknown as { api: unknown }).api = api
    try {
      const element = <SessionInfoCard session={forked} onClose={() => {}} />
      const first = mount(element)
      await act(async () => {
        first
          .querySelector('[data-slot="session-fork-measure"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await vi.waitFor(() => {
        expect(first.textContent).toContain('The copy will hold')
      })

      // A second instance for the same session — what a re-mount produces.
      const second = mount(element)
      expect(second.textContent).toContain('The copy will hold')
      expect(second.querySelector('[data-slot="session-fork-manifest"]')).not.toBeNull()
    } finally {
      ;(window as unknown as { api: unknown }).api = previous
    }
  })
  it('lists the images this session had translated, read-only and payload-free', async () => {
    const previous = (window as unknown as { api?: unknown }).api
    ;(window as unknown as { api: unknown }).api = {
      diagnostics: {
        listVisionEvidence: vi.fn(async () => [
          {
            id: 'identity-1',
            projectId: 'default',
            sessionId: 'session-1',
            sourceKind: 'upload-version',
            mimeType: 'image/png',
            imageChecksum: 'a'.repeat(64),
            extractorFingerprint: 'b'.repeat(64),
            evidenceSchemaVersion: 3,
            createdAt: '2026-10-05T00:00:00.000Z',
            updatedAt: '2026-10-05T00:00:00.000Z'
          }
        ])
      }
    }
    try {
      const container = mount(<SessionInfoCard session={session()} onClose={() => {}} />)
      await vi.waitFor(() => {
        expect(container.querySelector('[data-slot="session-info-vision-evidence"]')).not.toBeNull()
      })

      const item = container.querySelector('[data-slot="session-info-vision-evidence-item"]')
      expect(item?.textContent).toContain('a'.repeat(12))
      expect(item?.textContent).toContain('image/png')
      expect(item?.textContent).toContain('b'.repeat(12))
      expect(item?.textContent).toContain('v3')
      // A statement about what happened, not a control: nothing to press, nothing to open.
      expect(item?.querySelectorAll('button')).toHaveLength(0)
      expect(item?.querySelectorAll('a')).toHaveLength(0)
    } finally {
      ;(window as unknown as { api: unknown }).api = previous
    }
  })

  it('shows no vision section when the read fails, instead of an empty list', async () => {
    // "Not known" and "translated nothing" must not look the same: a failed read renders no section at all.
    const previous = (window as unknown as { api?: unknown }).api
    ;(window as unknown as { api: unknown }).api = {
      diagnostics: {
        listVisionEvidence: vi.fn(async () => Promise.reject(new Error('unavailable')))
      }
    }
    try {
      const container = mount(<SessionInfoCard session={session()} onClose={() => {}} />)
      await act(async () => {
        await Promise.resolve()
      })
      expect(container.querySelector('[data-slot="session-info-vision-evidence"]')).toBeNull()
    } finally {
      ;(window as unknown as { api: unknown }).api = previous
    }
  })

  it('offers the verification checklist even before this session has a review', async () => {
    // U18: the reviewer surface used to be reachable only from an existing review, so a session without
    // one could not be checked at all. The card's entry is the session itself, and it reports that it was
    // pressed before closing so the caller can open the surface.
    const onOpenReview = vi.fn()
    const onClose = vi.fn()
    const container = mount(
      <SessionInfoCard session={session()} onOpenReview={onOpenReview} onClose={onClose} />
    )

    const entry = container.querySelector<HTMLButtonElement>(
      '[data-testid="session-info-open-review"]'
    )
    expect(entry).not.toBeNull()

    await act(async () => {
      entry?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onOpenReview).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // IC52 stage 1: the card lists the session's own steps, read-only. Steps come from the document the app
  // itself wrote — one per user prompt, plus one per recorded tool activity — and nothing in the section
  // can change anything.
  it('lists the session steps read-only, naming a tool call that is not attached to a prompt', async () => {
    const saveSession = vi.fn(async (): Promise<void> => undefined)
    const api = {
      sessions: {
        readDocument: async (): Promise<unknown> => ({
          messages: [
            {
              id: 'm1',
              role: 'user',
              content: 'do the thing',
              status: 'complete',
              eventIds: [],
              artifactIds: ['artifact-1']
            }
          ],
          activities: [
            {
              id: 'a1',
              kind: 'tool',
              title: 'Run python',
              promptMessageId: 'm1',
              status: 'completed',
              sortIndex: 0,
              eventIds: [],
              providerToolName: 'run_python',
              toolLocations: [{ path: '/tmp/out.csv' }],
              terminalExitCode: 0,
              terminalOutput: 'wrote 12 rows',
              createdAt: 1
            },
            {
              id: 'a2',
              kind: 'tool',
              title: 'Orphaned call',
              promptMessageId: 'm-gone',
              status: 'failed',
              sortIndex: 1,
              eventIds: [],
              createdAt: 2
            }
          ]
        }),
        saveSession
      }
    }
    const previous = (window as unknown as { api?: unknown }).api
    ;(window as unknown as { api: unknown }).api = api
    try {
      const container = mount(<SessionInfoCard session={session()} onClose={() => {}} />)
      await vi.waitFor(() => {
        expect(container.querySelector('[data-slot="session-replay-steps"]')).not.toBeNull()
      })

      const steps = [...container.querySelectorAll('[data-slot="replay-step"]')]
      expect(steps.map((step) => step.getAttribute('data-replay-step-kind'))).toEqual([
        'prompt',
        'tool',
        'tool'
      ])
      // The recorded provider tool name is what a reader recognises; the status is the session's own.
      expect(steps[1]?.textContent).toContain('run_python')
      expect(steps[1]?.textContent).toContain('completed')
      // The angles this step was recorded with: the files it touched, its exit code, its output excerpt.
      expect(steps[1]?.textContent).toContain('1 file')
      expect(steps[1]?.textContent).toContain('exit 0')
      expect(steps[1]?.textContent).toContain('wrote 12 rows')
      // And the prompt carries its artifact references.
      expect(steps[0]?.textContent).toContain('1 artifact')
      // A step whose prompt is gone is still listed, and says so instead of being dropped.
      expect(steps[2]?.textContent).toContain('not attached')
      // That same step recorded nothing beyond its title, so it says so rather than looking blank.
      expect(steps[2]?.querySelector('[data-slot="replay-step-no-record"]')).not.toBeNull()
      // And the recorded step does not claim it: a step with detail has no such line.
      expect(steps[1]?.querySelector('[data-slot="replay-step-no-record"]')).toBeNull()

      // Read-only by the channel it reaches for: rendering the card writes nothing — the only channel the
      // replay surface calls is the document read. `saveSession` exists on the stub but is not touched
      // until the reader acts on the fork control.
      expect(saveSession).not.toHaveBeenCalled()

      const section = container.querySelector('[data-slot="session-replay-steps"]')
      expect(section?.querySelectorAll('button, input, select, textarea')).toHaveLength(0)
    } finally {
      ;(window as unknown as { api: unknown }).api = previous
    }
  })

  // "Not known" must not look like "nothing": a document that is not there shows no section at all,
  // rather than an empty list that would read as "this session did nothing".
  it('shows no replay section when the session document is not there', async () => {
    const api = {
      sessions: {
        readDocument: async (): Promise<undefined> => undefined,
        saveSession: async (): Promise<void> => undefined
      }
    }
    const previous = (window as unknown as { api?: unknown }).api
    ;(window as unknown as { api: unknown }).api = api
    try {
      const container = mount(<SessionInfoCard session={session()} onClose={() => {}} />)
      await act(async () => {
        await Promise.resolve()
      })
      expect(container.querySelector('[data-slot="session-info-card"]')).not.toBeNull()
      expect(container.querySelector('[data-slot="session-replay-steps"]')).toBeNull()
    } finally {
      ;(window as unknown as { api: unknown }).api = previous
    }
  })

  // IC52 stage 2: asking about one step is answered from that step's own record, every fact naming the field
  // it was read from — and a question the record cannot answer is said, not answered around.
  it('answers a question about a step from that step’s record, naming the field', async () => {
    const api = {
      sessions: {
        readDocument: async (): Promise<unknown> => ({
          messages: [
            { id: 'm1', role: 'user', content: 'do the thing', status: 'complete', eventIds: [] }
          ],
          activities: [
            {
              id: 'a1',
              kind: 'tool',
              title: 'Run python',
              promptMessageId: 'm1',
              status: 'completed',
              sortIndex: 0,
              eventIds: [],
              providerToolName: 'run_python',
              toolLocations: [{ path: '/tmp/out.csv' }],
              createdAt: 1
            }
          ]
        }),
        saveSession: async (): Promise<void> => undefined
      }
    }
    const previous = (window as unknown as { api?: unknown }).api
    ;(window as unknown as { api: unknown }).api = api
    try {
      const container = mount(<SessionInfoCard session={session()} onClose={() => {}} />)
      await vi.waitFor(() => {
        expect(container.querySelector('[data-slot="session-replay-ask"]')).not.toBeNull()
      })

      const select = container.querySelector(
        '[data-slot="session-replay-ask"] select'
      ) as HTMLSelectElement
      setNativeValue(select, 'tool:a1')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      const input = container.querySelector(
        '[data-slot="session-replay-ask"] input'
      ) as HTMLInputElement
      setNativeValue(input, 'which files did it touch?')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[data-slot="session-replay-ask-submit"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      const facts = [...container.querySelectorAll('[data-slot="replay-answer-fact"]')]
      expect(facts).toHaveLength(1)
      // The value the session recorded, and the field it came from.
      expect(facts[0]?.textContent).toContain('1')
      expect(facts[0]?.textContent).toContain('toolLocations')
    } finally {
      ;(window as unknown as { api: unknown }).api = previous
    }
  })

  it('says so when the step’s record cannot answer the question', async () => {
    const api = {
      sessions: {
        readDocument: async (): Promise<unknown> => ({
          messages: [
            { id: 'm1', role: 'user', content: 'do the thing', status: 'complete', eventIds: [] }
          ],
          activities: [
            {
              id: 'a1',
              kind: 'tool',
              title: 'Run python',
              promptMessageId: 'm1',
              status: 'completed',
              sortIndex: 0,
              eventIds: [],
              createdAt: 1
            }
          ]
        }),
        saveSession: async (): Promise<void> => undefined
      }
    }
    const previous = (window as unknown as { api?: unknown }).api
    ;(window as unknown as { api: unknown }).api = api
    try {
      const container = mount(<SessionInfoCard session={session()} onClose={() => {}} />)
      await vi.waitFor(() => {
        expect(container.querySelector('[data-slot="session-replay-ask"]')).not.toBeNull()
      })

      const select = container.querySelector(
        '[data-slot="session-replay-ask"] select'
      ) as HTMLSelectElement
      setNativeValue(select, 'tool:a1')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      const input = container.querySelector(
        '[data-slot="session-replay-ask"] input'
      ) as HTMLInputElement
      setNativeValue(input, 'is this statistically significant?')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[data-slot="session-replay-ask-submit"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(container.querySelector('[data-slot="session-replay-ask-unanswered"]')).not.toBeNull()
      expect(container.querySelector('[data-slot="session-replay-ask-answer"]')).toBeNull()
    } finally {
      ;(window as unknown as { api: unknown }).api = previous
    }
  })
})
