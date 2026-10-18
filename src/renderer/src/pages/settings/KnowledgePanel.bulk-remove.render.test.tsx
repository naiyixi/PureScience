// @vitest-environment jsdom
// A bulk removal is N single-row removals, and the panel has to report it that way: the count of what went through,
// the copies that went with them, and — when one refuses — which one refused while staying ticked. A run that said
// "removed" for a row still on screen would be the panel claiming work it did not do.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { KnowledgeSource } from '../../../../shared/knowledge'

const labels: Record<string, string> = {
  'settings.knowledge.title': 'Knowledge',
  'settings.knowledge.sources': 'Registered sources',
  'settings.knowledge.refresh': 'Refresh',
  'settings.knowledge.sweep': 'Clean unused copies',
  'settings.knowledge.loading': 'Reading the source record…',
  'settings.knowledge.empty': 'No sources registered yet.',
  'settings.knowledge.remove': 'Remove {label}',
  'settings.knowledge.removeFailed': 'That source could not be removed.',
  'settings.knowledge.loadFailed': 'The source record could not be read.',
  'settings.knowledge.selectSource': 'Select {label}',
  'settings.knowledge.selectPageAll': 'Select all on this page',
  'settings.knowledge.selectedCount': 'Selected {count}',
  'settings.knowledge.bulkRemove': 'Remove selected',
  'settings.knowledge.bulkRemoveConfirm': 'Confirm removing {count} source(s)',
  'settings.knowledge.bulkRemoveCancel': 'Cancel',
  'settings.knowledge.bulkRemoved': 'Removed {count} source(s); {pruned} stored copy(ies) pruned.',
  'settings.knowledge.bulkRemovePartial': 'Removed {count} source(s); {failed} refused: {reason}'
}
// Created ONCE: a fresh `t` per render is a fresh dependency for the load effect, which would then re-run forever.
const t = (key: string, vars?: Record<string, string>): string => {
  const template = labels[key] ?? key
  if (!vars) return template
  return Object.entries(vars).reduce(
    (text, [name, value]) => text.split(`{${name}}`).join(value),
    template
  )
}

vi.mock('@/i18n', () => ({ useLanguage: () => ({ t }) }))

const { KnowledgePanel } = await import('./KnowledgePanel')

const source = (id: string): KnowledgeSource => ({
  id,
  kind: 'file',
  location: `/tmp/${id}.txt`,
  label: `${id}.txt`,
  fingerprint: { algorithm: 'sha256', value: id.padEnd(64, 'a').slice(0, 64), bytes: 10 },
  registeredAt: 1,
  updatedAt: 1
})

type Mocked = {
  removeSource: ReturnType<typeof vi.fn>
  listSources: ReturnType<typeof vi.fn>
}

// A register that behaves like the real one: a removed row is gone from the next read, and a refused row is still
// there — which is what lets the assertions tell "removed" apart from "said it removed".
const mockApi = (ids: string[], refuse: string[] = []): Mocked => {
  const present = [...ids]
  const listSources = vi.fn(async () => ({
    sources: ids.filter((id) => present.includes(id)).map(source),
    unreadable: false
  }))
  const removeSource = vi.fn(async ({ sourceId }: { sourceId: string }) => {
    if (refuse.includes(sourceId)) {
      throw new Error('Knowledge source refused (source-not-found): no such source')
    }
    const index = present.indexOf(sourceId)
    const removed = present[index]
    if (!removed) throw new Error('missing source')
    present.splice(index, 1)
    // One stored copy per removed source keeps the aggregate honest arithmetic the assertion can check.
    return { removed: source(sourceId), prunedContents: [sourceId.padEnd(64, 'b')] }
  })
  ;(window as unknown as { api: unknown }).api = {
    knowledge: {
      listSources,
      registerSource: vi.fn(async () => []),
      removeSource,
      sweepCopies: vi.fn(async () => ({
        scanned: 0,
        kept: 0,
        removed: [],
        mismatched: [],
        failed: [],
        bytesFreed: 0,
        ignored: 0
      })),
      search: vi.fn(async () => ({
        status: 'ok',
        mode: 'lexical',
        verification: 'not-configured',
        coverage: { indexed: 0, pending: 0 },
        results: []
      }))
    }
  }
  return { removeSource, listSources }
}

const click = async (container: HTMLElement, selector: string): Promise<void> => {
  await act(async () => {
    container.querySelector<HTMLInputElement>(selector)?.click()
  })
}

const checkbox = (container: HTMLElement, id: string): HTMLInputElement | null =>
  container.querySelector<HTMLInputElement>(`[data-testid="knowledge-select-row-${id}"]`)

describe('KnowledgePanel bulk removal', () => {
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
  })

  const renderPanel = async (): Promise<void> => {
    await act(async () => {
      root.render(<KnowledgePanel />)
    })
  }

  it('removes every ticked source and reports the copies that went with them', async () => {
    const api = mockApi(['s1', 's2', 's3'])
    await renderPanel()

    await click(container, '[data-testid="knowledge-select-row-s1"]')
    await click(container, '[data-testid="knowledge-select-row-s2"]')
    expect(container.textContent).toContain('Selected 2')

    await click(container, '[data-testid="knowledge-bulk-remove"]')
    await click(container, '[data-testid="knowledge-bulk-confirm"]')

    expect(api.removeSource).toHaveBeenCalledTimes(2)
    expect(api.removeSource).toHaveBeenCalledWith({ sourceId: 's1' })
    expect(api.removeSource).toHaveBeenCalledWith({ sourceId: 's2' })
    expect(container.textContent).toContain('Removed 2 source(s); 2 stored copy(ies) pruned.')
    // The list is re-read, not assumed: only the unticked source is left on screen.
    expect(api.listSources).toHaveBeenCalledTimes(2)
    expect(checkbox(container, 's1')).toBeNull()
    expect(checkbox(container, 's3')).not.toBeNull()
  })

  it('keeps the refused row ticked and names it, instead of reporting a clean run', async () => {
    mockApi(['s1', 's2'], ['s2'])
    await renderPanel()

    await click(container, '[data-testid="knowledge-select-row-s1"]')
    await click(container, '[data-testid="knowledge-select-row-s2"]')
    await click(container, '[data-testid="knowledge-bulk-remove"]')
    await click(container, '[data-testid="knowledge-bulk-confirm"]')

    expect(container.textContent).toContain('Removed 1 source(s); 1 refused: s2.txt:')
    expect(container.textContent).toContain('source-not-found')
    // Still there, and still ticked — the retry needs to be aimed at exactly this row.
    expect(checkbox(container, 's2')?.checked).toBe(true)
    expect(container.textContent).toContain('Selected 1')
  })

  it('removes nothing on the first click — the ticked set has to be confirmed once', async () => {
    const api = mockApi(['s1'])
    await renderPanel()

    await click(container, '[data-testid="knowledge-select-row-s1"]')
    await click(container, '[data-testid="knowledge-bulk-remove"]')

    expect(api.removeSource).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="knowledge-bulk-confirm"]')).not.toBeNull()
  })

  it('selects the rows on screen and can clear them again', async () => {
    mockApi(['s1', 's2'])
    await renderPanel()

    await click(container, '[data-testid="knowledge-select-page"]')
    expect(checkbox(container, 's1')?.checked).toBe(true)
    expect(checkbox(container, 's2')?.checked).toBe(true)
    expect(container.textContent).toContain('Selected 2')

    await click(container, '[data-testid="knowledge-select-page"]')
    expect(checkbox(container, 's1')?.checked).toBe(false)
    expect(container.querySelector('[data-testid="knowledge-bulk-bar"]')).toBeNull()
  })
})
