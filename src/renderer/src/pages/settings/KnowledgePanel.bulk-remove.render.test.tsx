// @vitest-environment jsdom
// Bulk removal is ONE store operation now, and the panel has to report it that way. Three things this file pins:
//
//   * the panel calls `removeSources` ONCE with every ticked id — a panel that looped single removals would still
//     look right on screen while losing the one-write property that made the batch atomic;
//   * a refusal means the batch was NOT applied, so the sentence must not imply partial progress. The old
//     "Removed 1; 1 refused" string described a loop and is gone from the dictionaries, so it must not reappear;
//   * the armed step still removes nothing on the first click.

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
  'settings.knowledge.bulkRemovedWithMissing':
    'Removed {count} source(s); pruned {pruned}; {missing} not registered.',
  'settings.knowledge.bulkNotApplied': 'The batch was not applied: {reason} Nothing was removed.'
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
  removeSources: ReturnType<typeof vi.fn>
  listSources: ReturnType<typeof vi.fn>
}

// A register with the real all-or-nothing property: a batch that contains a refused row removes NOTHING, and a
// batch that succeeds removes every row. That is what lets the assertions tell "removed" from "said it removed".
const mockApi = (ids: string[], refuse: string[] = []): Mocked => {
  let present = [...ids]
  const listSources = vi.fn(async () => ({
    sources: ids.filter((id) => present.includes(id)).map(source),
    unreadable: false
  }))
  const removeSources = vi.fn(async ({ sourceIds }: { sourceIds: string[] }) => {
    const refused = sourceIds.filter((id) => refuse.includes(id))
    if (refused.length > 0) {
      throw new Error(`Knowledge source refused (source-not-found): ${refused.join(',')}`)
    }
    const removed = sourceIds.filter((id) => present.includes(id))
    present = present.filter((id) => !sourceIds.includes(id))
    return {
      removed: removed.map(source),
      // One stored copy per removed source keeps the arithmetic the assertion checks honest.
      prunedContents: removed.map((id) => id.padEnd(64, 'b')),
      missing: sourceIds.filter((id) => !removed.includes(id))
    }
  })
  ;(window as unknown as { api: unknown }).api = {
    knowledge: {
      listSources,
      registerSource: vi.fn(async () => []),
      removeSource: vi.fn(),
      removeSources,
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
  return { removeSources, listSources }
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

  it('removes every ticked source in one store call and reports the copies that went with them', async () => {
    const api = mockApi(['s1', 's2', 's3'])
    await renderPanel()

    await click(container, '[data-testid="knowledge-select-row-s1"]')
    await click(container, '[data-testid="knowledge-select-row-s2"]')
    expect(container.textContent).toContain('Selected 2')

    await click(container, '[data-testid="knowledge-bulk-remove"]')
    await click(container, '[data-testid="knowledge-bulk-confirm"]')

    // One call, both ids: this is the property a loop cannot have and the reason the batch was rewritten.
    expect(api.removeSources).toHaveBeenCalledTimes(1)
    expect(api.removeSources).toHaveBeenCalledWith({ sourceIds: ['s1', 's2'] })
    expect(api.removeSources.mock.results[0]?.value).toBeInstanceOf(Promise)
    expect(container.textContent).toContain('Removed 2 source(s); 2 stored copy(ies) pruned.')
    // The list is re-read, not assumed: only the unticked source is left on screen.
    expect(api.listSources).toHaveBeenCalledTimes(2)
    expect(checkbox(container, 's1')).toBeNull()
    expect(checkbox(container, 's3')).not.toBeNull()
  })

  it('says the batch was not applied when a row is refused, and keeps every row ticked', async () => {
    mockApi(['s1', 's2'], ['s2'])
    await renderPanel()

    await click(container, '[data-testid="knowledge-select-row-s1"]')
    await click(container, '[data-testid="knowledge-select-row-s2"]')
    await click(container, '[data-testid="knowledge-bulk-remove"]')
    await click(container, '[data-testid="knowledge-bulk-confirm"]')

    expect(container.textContent).toContain('The batch was not applied')
    expect(container.textContent).toContain('Nothing was removed.')
    expect(container.textContent).toContain('source-not-found')
    // Both rows survive — the atomic promise cuts both ways — and both stay ticked so a retry is aimed at them.
    expect(checkbox(container, 's1')?.checked).toBe(true)
    expect(checkbox(container, 's2')?.checked).toBe(true)
    expect(container.textContent).toContain('Selected 2')
    // The retired partial-progress sentence must not come back through any path.
    expect(container.textContent).not.toContain('refused:')
  })

  it('removes nothing on the first click — the ticked set has to be confirmed once', async () => {
    const api = mockApi(['s1'])
    await renderPanel()

    await click(container, '[data-testid="knowledge-select-row-s1"]')
    await click(container, '[data-testid="knowledge-bulk-remove"]')

    expect(api.removeSources).not.toHaveBeenCalled()
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
