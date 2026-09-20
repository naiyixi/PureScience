// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SessionInfoCard } from './SessionInfoCard'
import type { ChatSession } from '@/stores/session-store'

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
})
