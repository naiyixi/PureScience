// @vitest-environment jsdom
// Render + interaction tests for the reference library's collection lifecycle: a collection could be
// created and filled, but never emptied or deleted from the UI. These pin the two controls that close
// the loop, and the empty state a selected-but-empty collection gets instead of the generic one.
//
// The PDF picker's labels are pinned the same way: every one of them is read back through t(), so a
// hardcoded Chinese string (the state this area shipped in) renders the key or Chinese text and fails
// the assertion instead of reaching a non-Chinese interface.

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
      'references.pdfImport.open': 'Import PDFs',
      'references.pdfImport.titleAttach': 'Choose the PDF to attach to this record',
      'references.pdfImport.titleBatch': 'Import from project PDFs (selected {n})',
      'references.pdfImport.stop': 'Stop',
      'references.pdfImport.empty': 'No PDF files in this project.',
      'references.pdfImport.attachSelected': 'Attach to this record ({n})',
      'references.pdfImport.asNewRecords': 'Import as new records ({n})',
      'references.pdfImport.summary': 'Imported {imported} PDF file(s).',
      'references.pdfImport.summaryWithFailures':
        'Imported {imported} PDF file(s), {failed} failed.',
      'references.pdfImport.summaryStopped': 'Stopped · imported {imported} PDF file(s).',
      'references.pdfImport.summaryStoppedWithFailures':
        'Stopped · imported {imported} PDF file(s), {failed} failed.',
      'references.attachPdf': 'Attach PDF',
      'references.attachmentCurrent': 'current',
      'references.attachmentReplacedOn': 'replaced {date}',
      'references.attachmentAttachedOn': 'attached {date}',
      'references.addedToCollection': 'Added to collection.',
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
  // The PDF-picker channels are held as local mocks so a test can re-point them (an empty project, a
  // candidate list) and read back exactly what the picker asked the backend to do.
  let listFiles: ReturnType<typeof vi.fn>
  let addReference: ReturnType<typeof vi.fn>
  let attachPdf: ReturnType<typeof vi.fn>

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
    listFiles = vi.fn().mockResolvedValue({
      items: [{ id: 'file-1', name: 'table-evidence.pdf', mimeType: 'application/pdf' }],
      nextCursor: undefined
    })
    addReference = vi.fn().mockResolvedValue({
      status: 'created',
      reference: { id: 'reference-2', title: 'table evidence' },
      duplicateOf: []
    })
    attachPdf = vi.fn().mockResolvedValue(undefined)
    window.api = {
      references: {
        list: vi.fn().mockResolvedValue([reference]),
        listCollections: vi.fn().mockResolvedValue([collection, emptyCollection]),
        listCitationStyles: vi.fn().mockResolvedValue([]),
        createCollection: vi.fn().mockResolvedValue({ id: 'collection-3' }),
        deleteCollection: vi.fn().mockResolvedValue(undefined),
        addToCollection: vi.fn().mockResolvedValue(undefined),
        removeFromCollection: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        add: addReference,
        attachPdf
      },
      projectFiles: { listFiles }
    } as unknown as typeof window.api
  })

  // IC25: the attachment history the repository already sends with the list. Its semantics decide the shape —
  // `pdfVersions` holds the versions a later attachment displaced (the current one is on the record itself,
  // named by the chip), so one replacement is enough to have something to show.
  it('shows the attachment history once a PDF has been replaced (IC25)', async () => {
    vi.mocked(window.api.references.list).mockResolvedValue([
      {
        ...reference,
        pdfManagedFileId: 'managed-new',
        pdfVersions: [
          {
            id: 'version-1',
            managedFileId: 'managed-old',
            contentHash: 'aaaaaaaa11',
            attachedAt: Date.UTC(2026, 8, 1),
            replacedAt: Date.UTC(2026, 9, 5)
          }
        ]
      }
    ] as never)

    await render()

    const history = document.querySelector('[data-testid="reference-attachment-history"]')
    expect(history).not.toBeNull()
    const text = history?.textContent ?? ''
    // The displaced version: when it was replaced, when it had been attached, and its own hash prefix.
    expect(text).toContain('replaced 2026-10-05')
    expect(text).toContain('attached 2026-09-01')
    expect(text).toContain('aaaaaaaa')
    // The current attachment is named on the chip instead (the newest version is not in this list).
    expect(document.body.textContent).toContain('current')
  })

  it('stays quiet for a record that never had a PDF replaced (IC25)', async () => {
    vi.mocked(window.api.references.list).mockResolvedValue([
      { ...reference, pdfManagedFileId: 'managed-only' }
    ] as never)

    await render()

    expect(document.querySelector('[data-testid="reference-attachment-history"]')).toBeNull()
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

  it('imports a project PDF through the picker, asking the file index one allowed page', async () => {
    await render()

    act(() => findButton('Import PDFs').click())
    await flush()

    // The picker names itself and the selection count through t(), lists the project's PDF, and asks
    // the file index for a page it will accept (a larger limit is rejected outright, which is how this
    // button used to report an empty project).
    expect(document.body.textContent).toContain('Import from project PDFs (selected 0)')
    expect(document.body.textContent).toContain('table-evidence.pdf')
    expect(listFiles).toHaveBeenCalledWith({
      projectId: 'project-1',
      collection: { kind: 'all' },
      limit: 100
    })

    const checkbox = document.querySelector<HTMLInputElement>('label input[type="checkbox"]')
    expect(checkbox).not.toBeNull()
    await act(async () => {
      checkbox?.click()
    })
    await flush()
    expect(document.body.textContent).toContain('Import as new records (1)')

    await act(async () => {
      findButton('Import as new records (1)').click()
      await Promise.resolve()
    })
    await flush()
    await flush()

    // The record is titled from the file name, and the file is attached to that very record.
    expect(addReference).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1', title: 'table evidence' })
    )
    expect(attachPdf).toHaveBeenCalledWith('reference-2', 'file-1')
    expect(document.body.textContent).toContain('Imported 1 PDF file(s).')
  })

  it('says an empty project has no PDFs in the interface language, and closes on Cancel', async () => {
    listFiles.mockResolvedValue({ items: [], nextCursor: undefined })
    await render()

    act(() => findButton('Import PDFs').click())
    await flush()

    expect(document.body.textContent).toContain('No PDF files in this project.')
    // Not one of this area's former hardcoded strings survives anywhere in the dialog (the citation
    // style names above are the backend's own labelZh, not UI copy). Each of these used to be written
    // into the JSX and reached every non-Chinese interface verbatim.
    for (const former of [
      '项目内没有 PDF 文件。',
      '选择要挂到该条目的 PDF',
      '从项目 PDF 批量入册',
      '入册为新记录',
      '挂到该条目',
      'PDF 入册',
      '已导入',
      '已停止',
      '停止'
    ]) {
      expect(document.body.textContent).not.toContain(former)
    }

    act(() => findExactButton('Cancel').click())
    await flush()
    expect(document.body.textContent).not.toContain('No PDF files in this project.')
  })

  it('attaches the picked PDF to the record whose own button opened the picker', async () => {
    await render()

    act(() => findButton('Attach PDF').click())
    await flush()
    expect(document.body.textContent).toContain('Choose the PDF to attach to this record')
    expect(document.body.textContent).toContain('table-evidence.pdf')
    expect(listFiles).toHaveBeenCalledTimes(1)

    const checkbox = document.querySelector<HTMLInputElement>('label input[type="checkbox"]')
    await act(async () => {
      checkbox?.click()
    })
    await flush()
    expect(document.body.textContent).toContain('Attach to this record (1)')

    await act(async () => {
      findButton('Attach to this record (1)').click()
      await Promise.resolve()
    })
    await flush()
    await flush()

    // The row that asked for the picker is the row that gets the file.
    expect(attachPdf).toHaveBeenCalledWith('reference-1', 'file-1')
    expect(addReference).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Added to collection.')
  })
})
