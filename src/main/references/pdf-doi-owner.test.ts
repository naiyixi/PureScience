import { describe, expect, it, vi } from 'vitest'

import type { CreateReferenceInput } from '../../shared/references'
import { createPdfDoiImportOwner, MAX_PAGES_SCANNED } from './pdf-doi-owner'

const reference = (doi: string): CreateReferenceInput =>
  ({ projectId: 'project-a', title: `Work ${doi}`, doi }) as CreateReferenceInput

const owner = (
  pageText: string,
  pageCount = 3
): {
  app: ReturnType<typeof createPdfDoiImportOwner>
  pages: ReturnType<typeof vi.fn>
} => {
  const pages = vi.fn().mockResolvedValue(pageText)
  return {
    pages,
    app: createPdfDoiImportOwner({
      pdf: { open: vi.fn().mockResolvedValue({ docId: 'doc-1', pageCount }), pages },
      references: {
        resolveByIdentifier: vi.fn(async (_kind, identifier) => reference(identifier)),
        addReference: vi.fn(async (value: CreateReferenceInput) => ({
          status: 'created' as const,
          referenceId: `ref:${value.doi}`
        }))
      }
    })
  }
}

describe('PDF → DOI import owner', () => {
  it('reads the document, resolves identifiers and writes them as references', async () => {
    const { app, pages } = owner('Refs: 10.1038/nature12373 and 10.1126/science.abc1234.')

    const result = await app.importFromPdf('project-a', '/papers/paper.pdf')

    expect(result.created).toBe(2)
    expect(pages).toHaveBeenCalledWith('doc-1', 1, 3)
  })

  // Citations live in the reference list as often as on page one, so a few pages are scanned — but not
  // an unbounded number, or importing from a thesis would read the whole thing.
  it('bounds the scan to a fixed number of pages', async () => {
    const pdf = {
      open: vi.fn().mockResolvedValue({ docId: 'doc-1', pageCount: 900 }),
      pages: vi.fn().mockResolvedValue('10.1038/nature12373')
    }
    const app = createPdfDoiImportOwner({
      pdf,
      references: {
        resolveByIdentifier: vi.fn(async (_kind, identifier: string) => reference(identifier)),
        addReference: vi.fn(async () => ({ status: 'created' as const, referenceId: 'ref:1' }))
      }
    })

    await app.importFromPdf('project-a', '/papers/thesis.pdf')

    expect(pdf.pages).toHaveBeenCalledWith('doc-1', 1, MAX_PAGES_SCANNED)
  })

  it('still scans a short document in full', async () => {
    const pdf = {
      open: vi.fn().mockResolvedValue({ docId: 'doc-1', pageCount: 2 }),
      pages: vi.fn().mockResolvedValue('10.1038/nature12373')
    }
    const app = createPdfDoiImportOwner({
      pdf,
      references: {
        resolveByIdentifier: vi.fn(async (_kind, identifier: string) => reference(identifier)),
        addReference: vi.fn(async () => ({ status: 'created' as const, referenceId: 'ref:1' }))
      }
    })

    await app.importFromPdf('project-a', '/papers/short.pdf')

    expect(pdf.pages).toHaveBeenCalledWith('doc-1', 1, 2)
  })
})
