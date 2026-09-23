// @vitest-environment jsdom
// Render + interaction tests for the reference library's collection lifecycle: a collection could be
// created and filled, but never emptied or deleted from the UI. These pin the two controls that close
// the loop, and the empty state a selected-but-empty collection gets instead of the generic one.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', () => ({
  useLanguage: () => {
    const labels: Record<string, string> = {
      'references.title': 'References',
      'references.close': 'Close',
      'references.allItems': 'All items ({n})',
      'references.empty': 'Import via an identifier above, or add your first reference manually.',
      'references.collectionNewPlaceholder': 'New collection…',
      'references.collectionDeleteLabel': 'Delete collection {name}',
      'references.collectionDeleteConfirm': 'Delete “{name}”? Its references stay in the library.',
      'references.collectionDeleted': 'Collection “{name}” deleted',
      'references.collectionRemoveShort': 'Remove',
      'references.collectionRemoveItem': 'Remove from {name}',
      'references.removedFromCollection': 'Removed from “{name}”',
      'references.collectionEmpty': 'No references in this collection yet.',
      'references.collectionEmptyHint':
        'Open All items and use the collection menu on a reference to put it here.',
      'references.removeReference': 'Remove reference',
      'common.delete': 'Delete',
      'common.cancel': 'Cancel'
    }

    return {
      t: (key: string, vars?: Record<string, string | number>): string => {
        const template = labels[key] ?? key
        if (!vars) return template

        return Object.entries(vars).reduce(
          (text, [name, value]) => text.replace(`{${name}}`, String(value)),
          template
        )
      }
    }
  }
}))

const { ReferencesLibraryDialog } = await import('./ReferencesLibraryDialog')
import type { Reference, ReferenceCollection } from '../../../../shared/references'

const collection: ReferenceCollection = {
  id: 'collection-1',
  projectId: 'project-1',
  name: 'Variant screens',
  description: undefined,
  createdAt: 1,
  updatedAt: 1
}

const emptyCollection: ReferenceCollection = {
  ...collection,
  id: 'collection-2',
  name: 'Empty one'
}

const reference: Reference = {
  id: 'reference-1',
  projectId: 'project-1',
  title: 'A screen for variants',
  authors: [{ name: 'A. Author' }],
  venue: 'Journal',
  year: 2026,
  doi: undefined,
  pmid: undefined,
  pmcid: undefined,
  arxivId: undefined,
  url: undefined,
  abstractSnippet: undefined,
  sourceConnector: 'manual',
  sourceRecordId: undefined,
  citationKey: 'Author2026',
  provenance: undefined,
  pdfManagedFileId: undefined,
  notes: undefined,
  collectionIds: ['collection-1'],
  createdAt: 1,
  updatedAt: 1
}

describe('ReferencesLibraryDialog collections', () => {
  let container: HTMLDivElement
  let root: Root

  const findButton = (name: string | RegExp): HTMLButtonElement => {
    // Radix renders the dialog into a portal on document.body, not into the container div.
    const buttons = Array.from(document.querySelectorAll('button'))
    const match = buttons.find((button) => {
      const label = `${button.textContent ?? ''} ${button.getAttribute('aria-label') ?? ''} ${
        button.getAttribute('title') ?? ''
      }`
      return typeof name === 'string' ? label.includes(name) : name.test(label)
    })
    if (!match) throw new Error(`no button matching ${String(name)}`)

    return match
  }

  // The trash button's accessible name contains "Delete", so the confirmation's own button is found
  // by exact text instead.
  const findExactButton = (label: string): HTMLButtonElement => {
    const match = Array.from(document.querySelectorAll('button')).find(
      (button) => (button.textContent ?? '').trim() === label
    )
    if (!match) throw new Error(`no button whose text is exactly ${label}`)

    return match
  }

  const flush = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve()
    })
  }

  const render = async (): Promise<void> => {
    await act(async () => {
      root.render(<ReferencesLibraryDialog open projectId="project-1" onClose={() => {}} />)
    })
    await flush()
    await flush()
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    window.api = {
      references: {
        list: vi.fn().mockResolvedValue([reference]),
        listCollections: vi.fn().mockResolvedValue([collection, emptyCollection]),
        listCitationStyles: vi.fn().mockResolvedValue([]),
        createCollection: vi.fn().mockResolvedValue({ id: 'collection-3' }),
        deleteCollection: vi.fn().mockResolvedValue(undefined),
        addToCollection: vi.fn().mockResolvedValue(undefined),
        removeFromCollection: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined)
      }
    } as unknown as typeof window.api
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.removeAttribute('style')
  })

  it('asks once before deleting a collection and says the references survive', async () => {
    await render()

    act(() => findButton('Delete collection Variant screens').click())
    expect(document.body.textContent).toContain(
      'Delete “Variant screens”? Its references stay in the library.'
    )
    expect(window.api.references.deleteCollection).not.toHaveBeenCalled()

    await act(async () => {
      findExactButton('Delete').click()
      await Promise.resolve()
    })
    await flush()

    expect(window.api.references.deleteCollection).toHaveBeenCalledWith('collection-1')
    expect(document.body.textContent).toContain('Collection “Variant screens” deleted')
  })

  it('keeps the collection when the confirmation is declined', async () => {
    await render()

    act(() => findButton('Delete collection Variant screens').click())
    await act(async () => {
      findExactButton('Cancel').click()
      await Promise.resolve()
    })

    expect(window.api.references.deleteCollection).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Delete “Variant screens”?')
  })

  it('removes a reference from the open collection with the pairing the backend expects', async () => {
    await render()

    await act(async () => {
      findButton('Variant screens').click()
      await Promise.resolve()
    })
    await flush()
    // The row only offers this while a collection is open — in All items there is nothing to remove.
    expect(document.querySelector('[title="Remove from Variant screens"]')).not.toBeNull()

    await act(async () => {
      findButton('Remove from Variant screens').click()
      await Promise.resolve()
    })
    await flush()

    expect(window.api.references.removeFromCollection).toHaveBeenCalledWith(
      'collection-1',
      'reference-1'
    )
    expect(document.body.textContent).toContain('Removed from “Variant screens”')
  })

  it('gives a selected empty collection its own empty state, not the library-wide one', async () => {
    await render()

    await act(async () => {
      findButton('Empty one').click()
      await Promise.resolve()
    })
    await flush()

    expect(document.body.textContent).toContain('No references in this collection yet.')
    expect(document.body.textContent).toContain(
      'Open All items and use the collection menu on a reference to put it here.'
    )
    expect(document.body.textContent).not.toContain('Import via an identifier above')
  })
})
