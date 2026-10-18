// @vitest-environment jsdom
// The sweep's UX is two sentences that must not be interchangeable: "there was nothing to delete" and "one copy
// would not delete, it is still on disk". A panel that showed either as the other would report a clean disk it
// never verified, so both are asserted here, plus the count/bytes sentence for the ordinary case.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { KnowledgeCopySweep, KnowledgeSource } from '../../../../shared/knowledge'

// `t` is created ONCE here rather than inside `useLanguage`: a fresh `t` per render is a fresh dependency for
// every effect that lists it, and this panel's initial read would then re-run on every render.
const labels: Record<string, string> = {
  'settings.knowledge.title': 'Knowledge',
  'settings.knowledge.description': 'Sources this workspace has registered.',
  'settings.knowledge.sources': 'Registered sources',
  'settings.knowledge.refresh': 'Refresh',
  'settings.knowledge.sweep': 'Clean unused copies',
  'settings.knowledge.swept': 'Deleted {count} unused copy(ies), freed {bytes} byte(s).',
  'settings.knowledge.sweptPartial':
    'Deleted {count} unused copy(ies); {failed} could not be deleted and are still on disk.',
  'settings.knowledge.sweptNone': 'No unused copies to delete.',
  'settings.knowledge.sweepFailed': 'The unused copies could not be swept.',
  'settings.knowledge.loading': 'Reading the source record…',
  'settings.knowledge.empty': 'No sources registered yet.',
  'settings.knowledge.register': 'Register a source',
  'settings.knowledge.kind': 'Source kind',
  'settings.knowledge.kindFile': 'File',
  'settings.knowledge.kindFolder': 'Folder',
  'settings.knowledge.kindUrl': 'URL',
  'settings.knowledge.location': 'Source location',
  'settings.knowledge.registerAction': 'Register',
  'settings.knowledge.registerHint': 'A local path must sit inside the data root.',
  'settings.knowledge.search': 'Search',
  'settings.knowledge.query': 'Search query',
  'settings.knowledge.searchAction': 'Search'
}
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

const source = (overrides: Partial<KnowledgeSource> = {}): KnowledgeSource => ({
  id: 'source-1',
  kind: 'url',
  location: 'https://example.org/cohort',
  finalUrl: 'https://example.org/cohort',
  label: 'https://example.org/cohort',
  fingerprint: { algorithm: 'sha256', value: 'a'.repeat(64), bytes: 85 },
  registeredAt: 1,
  updatedAt: 1,
  ...overrides
})

const mockApi = (sweep: KnowledgeCopySweep | Error): { sweepCopies: ReturnType<typeof vi.fn> } => {
  const sweepCopies = vi.fn(async () => {
    if (sweep instanceof Error) throw sweep
    return sweep
  })
  ;(window as unknown as { api: unknown }).api = {
    knowledge: {
      listSources: vi.fn(async () => ({ sources: [source()], unreadable: false })),
      registerSource: vi.fn(async () => [source()]),
      removeSource: vi.fn(async () => ({ removed: source(), prunedContents: [] })),
      sweepCopies,
      search: vi.fn(async () => ({
        status: 'ok',
        mode: 'lexical',
        verification: 'not-configured',
        coverage: { indexed: 1, pending: 0 },
        results: []
      }))
    }
  }
  return { sweepCopies }
}

describe('KnowledgePanel copy sweep', () => {
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
  const clickSweep = async (): Promise<void> => {
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="knowledge-sweep"]')?.click()
    })
  }

  it('reports how many copies it deleted and how many bytes that freed', async () => {
    const api = mockApi({
      scanned: 3,
      kept: 1,
      removed: ['b'.repeat(64), 'c'.repeat(64)],
      failed: [],
      bytesFreed: 1234,
      ignored: 0
    })
    await renderPanel()

    await clickSweep()

    expect(api.sweepCopies).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Deleted 2 unused copy(ies), freed 1234 byte(s).')
  })

  it('says there was nothing to delete rather than claiming a cleanup', async () => {
    mockApi({ scanned: 1, kept: 1, removed: [], failed: [], bytesFreed: 0, ignored: 0 })
    await renderPanel()

    await clickSweep()

    expect(container.textContent).toContain('No unused copies to delete.')
  })

  it('names the copies that stayed on disk instead of reporting a clean sweep', async () => {
    mockApi({
      scanned: 2,
      kept: 0,
      removed: ['b'.repeat(64)],
      failed: ['c'.repeat(64)],
      bytesFreed: 10,
      ignored: 0
    })
    await renderPanel()

    await clickSweep()

    expect(container.textContent).toContain(
      'Deleted 1 unused copy(ies); 1 could not be deleted and are still on disk.'
    )
    expect(container.textContent).not.toContain('No unused copies to delete.')
  })

  it('shows the store’s own refusal when the sweep is refused', async () => {
    mockApi(
      new Error(
        'Knowledge source refused (record-unreadable): The source record could not be read.'
      )
    )
    await renderPanel()

    await clickSweep()

    expect(container.textContent).toContain('record-unreadable')
    expect(container.textContent).not.toContain('Deleted')
  })
})
