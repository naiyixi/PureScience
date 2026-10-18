// @vitest-environment jsdom
// Narrowing and reordering the source list. Three things this file pins, each of which has looked fine on
// screen while being wrong:
//
//   * the rows are filtered BEFORE paging, so "select all on this page" can only reach rows the reader can
//     see — the opposite order leaves ticks pointing at rows a filter has since hidden;
//   * a filter that matches nothing says so instead of borrowing the empty-register sentence, because those
//     two states lead to different actions (register something vs. widen the filter);
//   * the count line appears only while a filter is on, so it stays a reading rather than decoration.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { KnowledgeSource } from '../../../../shared/knowledge'

// Without this flag React's `act` is a no-op, so a click would not flush before the assertion reads the DOM.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const labels: Record<string, string> = {
  'settings.knowledge.title': 'Knowledge',
  'settings.knowledge.description': 'Sources this workspace has registered.',
  'settings.knowledge.sources': 'Registered sources',
  'settings.knowledge.refresh': 'Refresh',
  'settings.knowledge.sweep': 'Clean unused copies',
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
  'settings.knowledge.searchAction': 'Search',
  'settings.knowledge.remove': 'Remove {label}',
  'settings.knowledge.selectSource': 'Select {label}',
  'settings.knowledge.selectPageAll': 'Select all on this page',
  'settings.knowledge.removeFailed': 'That source could not be removed.',
  'settings.knowledge.loadFailed': 'The source record could not be read.',
  'settings.knowledge.filterLabel': 'Filter sources',
  'settings.knowledge.filterPlaceholder': 'Name or location',
  'settings.knowledge.previous': 'Previous',
  'settings.knowledge.next': 'Next',
  'settings.knowledge.page': 'Page {page} of {pages}',
  'settings.knowledge.selectedCount': 'Selected {count}',
  'settings.knowledge.bulkRemove': 'Remove selected',
  'settings.knowledge.filterKind': 'Filter by kind',
  'settings.knowledge.kindAll': 'All kinds',
  'settings.knowledge.sort': 'Sort',
  'settings.knowledge.sortStore': 'Registration order',
  'settings.knowledge.sortLabel': 'Name',
  'settings.knowledge.sortBytes': 'Size, largest first',
  'settings.knowledge.filteredCount': 'Showing {shown} of {total}',
  'settings.knowledge.noMatches': 'No sources match this filter.'
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

const source = (id: string, overrides: Partial<KnowledgeSource> = {}): KnowledgeSource => ({
  id,
  kind: 'file',
  location: `/tmp/${id}.md`,
  label: `${id}.md`,
  fingerprint: { algorithm: 'sha256', value: 'a'.repeat(64), bytes: 10 },
  registeredAt: 1,
  updatedAt: 1,
  ...overrides
})

const mockApi = (sources: KnowledgeSource[]): void => {
  ;(window as unknown as { api: unknown }).api = {
    knowledge: {
      listSources: vi.fn(async () => ({ sources, unreadable: false })),
      registerSource: vi.fn(async () => []),
      removeSource: vi.fn(),
      removeSources: vi.fn(),
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
}

// React listens for the native setter, so setting `value` directly would be swallowed: the value has to go
// through the prototype's setter and then the event React actually subscribes to.
const setValue = async (
  element: HTMLInputElement | HTMLSelectElement | null,
  value: string
): Promise<void> => {
  if (!element) throw new Error('control not found')
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  await act(async () => {
    setter?.call(element, value)
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })
    )
  })
}

const rowLabels = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll('ul.divide-y li span.font-medium')).map(
    (node) => node.textContent ?? ''
  )

describe('KnowledgePanel filter and sort', () => {
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

  const renderPanel = async (sources: KnowledgeSource[]): Promise<void> => {
    mockApi(sources)
    await act(async () => {
      root.render(<KnowledgePanel />)
    })
  }

  it('narrows to the matching rows and says how many of how many are shown', async () => {
    await renderPanel([source('alpha'), source('beta'), source('gamma')])
    expect(rowLabels(container)).toEqual(['alpha.md', 'beta.md', 'gamma.md'])
    // Nothing is narrowed yet, so there is no count to print.
    expect(container.querySelector('[data-testid="knowledge-filter-count"]')).toBeNull()

    await setValue(
      container.querySelector<HTMLInputElement>('[data-testid="knowledge-filter-text"]'),
      'BET'
    )

    expect(rowLabels(container)).toEqual(['beta.md'])
    expect(container.querySelector('[data-testid="knowledge-filter-count"]')?.textContent).toBe(
      'Showing 1 of 3'
    )
  })

  it('matches a location, not just the label a row prints', async () => {
    await renderPanel([
      source('alpha'),
      source('remote', { kind: 'url', location: 'https://example.org/egfr-cohort', label: 'EGFR' })
    ])
    await setValue(
      container.querySelector<HTMLInputElement>('[data-testid="knowledge-filter-text"]'),
      'example.org'
    )
    expect(rowLabels(container)).toEqual(['EGFR'])
  })

  it('narrows by kind', async () => {
    await renderPanel([
      source('alpha'),
      source('remote', { kind: 'url', location: 'https://example.org/x', label: 'Remote' })
    ])
    await setValue(
      container.querySelector<HTMLSelectElement>('[data-testid="knowledge-filter-kind"]'),
      'url'
    )
    expect(rowLabels(container)).toEqual(['Remote'])
  })

  it('says nothing matched instead of claiming the register is empty', async () => {
    await renderPanel([source('alpha'), source('beta')])
    await setValue(
      container.querySelector<HTMLInputElement>('[data-testid="knowledge-filter-text"]'),
      'no-such-source'
    )

    expect(container.querySelector('[data-testid="knowledge-no-matches"]')?.textContent).toBe(
      'No sources match this filter.'
    )
    // The empty-register sentence describes a different fact and must not stand in for this one.
    expect(container.textContent).not.toContain('No sources registered yet.')
    expect(container.querySelector('[data-testid="knowledge-filter-count"]')?.textContent).toBe(
      'Showing 0 of 2'
    )
  })

  it('reorders by size, largest first', async () => {
    await renderPanel([
      source('alpha', {
        fingerprint: { algorithm: 'sha256', value: 'a'.repeat(64), bytes: 10 }
      }),
      source('beta', { fingerprint: { algorithm: 'sha256', value: 'b'.repeat(64), bytes: 900 } }),
      source('gamma', { fingerprint: { algorithm: 'sha256', value: 'c'.repeat(64), bytes: 40 } })
    ])
    expect(rowLabels(container)).toEqual(['alpha.md', 'beta.md', 'gamma.md'])

    await setValue(
      container.querySelector<HTMLSelectElement>('[data-testid="knowledge-sort"]'),
      'bytes'
    )

    expect(rowLabels(container)).toEqual(['beta.md', 'gamma.md', 'alpha.md'])
  })

  it('goes back to the first page when a filter changes the list under it', async () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      source(`row-${String(index).padStart(2, '0')}`)
    )
    await renderPanel(many)

    const next = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Next'
    )
    await act(async () => {
      next?.click()
    })
    // Page two holds the last five rows; the first row is not on screen.
    expect(rowLabels(container)).toEqual([
      'row-20.md',
      'row-21.md',
      'row-22.md',
      'row-23.md',
      'row-24.md'
    ])

    await setValue(
      container.querySelector<HTMLInputElement>('[data-testid="knowledge-filter-text"]'),
      'row-03'
    )

    // The narrowed list has one page; a saved index of 1 would have opened past its end.
    expect(rowLabels(container)).toEqual(['row-03.md'])
    expect(container.querySelector('[data-testid="knowledge-pager"]')).toBeNull()
  })

  it('selects rows of the narrowed page only', async () => {
    await renderPanel([source('alpha'), source('beta')])
    await setValue(
      container.querySelector<HTMLInputElement>('[data-testid="knowledge-filter-text"]'),
      'alpha'
    )
    await act(async () => {
      container.querySelector<HTMLInputElement>('[data-testid="knowledge-select-page"]')?.click()
    })
    expect(container.textContent).toContain('Selected 1')
  })
})
