import { describe, expect, it, vi } from 'vitest'

import {
  createSessionPackageReferenceFileLister,
  createSessionPackageReferenceLibrary,
  currentReferencePdfId
} from './reference-files'

// The reference library's PDFs enter the package on the same terms as session files: bounded, uniquely
// named, and every item that did not travel is named rather than dropped.

const bytes = (size: number): Uint8Array => new Uint8Array(size).fill(65)

const attachment = (
  fileName: string,
  size: number
): { referenceId: string; fileName: string; bytes: Uint8Array } => ({
  referenceId: `ref-${fileName}`,
  fileName,
  bytes: bytes(size)
})

describe('session package reference files', () => {
  it('carries attachments under the references directory', async () => {
    const lister = createSessionPackageReferenceFileLister({
      listReferenceAttachments: async () => ({
        attachments: [attachment('nirmatrelvir.pdf', 12), attachment('mpro.pdf', 8)],
        unreadable: []
      }),
      countReferenceAttachments: async () => 2,
      maxFileBytes: 1024
    })

    const result = await lister.listReferenceFiles({ projectId: 'p1' })

    expect(result.files.map((file) => file.path)).toEqual([
      'references/nirmatrelvir.pdf',
      'references/mpro.pdf'
    ])
    expect(result.files[0]?.contents.byteLength).toBe(12)
    expect(result.unreadable).toEqual([])
  })

  it('names an oversized PDF instead of writing half of it', async () => {
    const lister = createSessionPackageReferenceFileLister({
      listReferenceAttachments: async () => ({
        attachments: [attachment('huge.pdf', 4096)],
        unreadable: []
      }),
      countReferenceAttachments: async () => 1,
      maxFileBytes: 1024
    })

    const result = await lister.listReferenceFiles({ projectId: 'p1' })

    expect(result.files).toEqual([])
    expect(result.unreadable).toEqual(['references/huge.pdf'])
  })

  it('gives two PDFs with the same file name distinct paths', async () => {
    const lister = createSessionPackageReferenceFileLister({
      listReferenceAttachments: async () => ({
        attachments: [attachment('paper.pdf', 4), attachment('paper.pdf', 6)],
        unreadable: []
      }),
      countReferenceAttachments: async () => 2,
      maxFileBytes: 1024
    })

    const result = await lister.listReferenceFiles({ projectId: 'p1' })

    // Neither overwrites the other, and neither disappears.
    expect(result.files.map((file) => file.path)).toEqual([
      'references/paper.pdf',
      // The suffix lands after the extension, exactly as the session-file lister does it.
      'references/paper.pdf~2'
    ])
    expect(result.unreadable).toEqual([])
  })

  it('passes on what the library could not read, and counts without reading', async () => {
    const countReferenceAttachments = vi.fn(async () => 3)
    const lister = createSessionPackageReferenceFileLister({
      listReferenceAttachments: async () => ({
        attachments: [],
        unreadable: ['references/missing.pdf']
      }),
      countReferenceAttachments,
      maxFileBytes: 1024
    })

    const listed = await lister.listReferenceFiles({ projectId: 'p1' })
    expect(listed.unreadable).toEqual(['references/missing.pdf'])

    // An essential package names how many PDFs it left behind without reading a single byte.
    expect(await lister.countReferenceFiles({ projectId: 'p1' })).toBe(3)
    expect(countReferenceAttachments).toHaveBeenCalledWith({ projectId: 'p1' })
  })
})

// The library side, driven by the shape the app actually stores: a reference ROW carries the PDF that is
// currently attached, and the history table holds only files that were superseded. The first version of
// this wiring asked the history table for the current file, found nothing, and exported every package
// with zero papers — while these unit tests stayed green because the port's fixture supplied the
// attachment directly. These tests use the real shape so that cannot happen again.
describe('session package reference library', () => {
  it('carries the PDF a reference row points at when the history table has no rows for it', async () => {
    const readManagedFileBytes = vi.fn(async () => bytes(2215244))
    const library = createSessionPackageReferenceLibrary({
      listReferences: async () => [
        { id: 'ref-1', title: 'Attention Is All You Need', pdfManagedFileId: 'upload:abc' }
      ],
      readManagedFileBytes,
      maxFileBytes: 25 * 1024 * 1024
    })

    const { attachments, unreadable } = await library.listReferenceAttachments({
      projectId: 'p1',
      maxBytes: 25 * 1024 * 1024
    })

    expect(attachments).toHaveLength(1)
    expect(attachments[0]?.referenceId).toBe('ref-1')
    expect(attachments[0]?.fileName).toBe('Attention Is All You Need.pdf')
    expect(attachments[0]?.bytes.byteLength).toBe(2215244)
    expect(readManagedFileBytes).toHaveBeenCalledWith('p1', 'upload:abc')
    expect(unreadable).toEqual([])
  })

  it('ignores records with no attached PDF and never reads for them', async () => {
    const readManagedFileBytes = vi.fn(async () => bytes(8))
    const library = createSessionPackageReferenceLibrary({
      listReferences: async () => [
        { id: 'ref-1', title: 'No file' },
        { id: 'ref-2', title: 'Detached', pdfManagedFileId: null },
        { id: 'ref-3', title: 'Has file', pdfManagedFileId: 'upload:xyz' }
      ],
      readManagedFileBytes,
      maxFileBytes: 1024
    })

    const { attachments } = await library.listReferenceAttachments({
      projectId: 'p1',
      maxBytes: 1024
    })

    expect(attachments.map((entry) => entry.referenceId)).toEqual(['ref-3'])
    expect(readManagedFileBytes).toHaveBeenCalledTimes(1)
  })

  it('names a PDF it could not read instead of dropping it', async () => {
    const library = createSessionPackageReferenceLibrary({
      listReferences: async () => [
        { id: 'ref-1', title: 'Gone', pdfManagedFileId: 'upload:missing' }
      ],
      readManagedFileBytes: async () => null,
      maxFileBytes: 1024
    })

    const { attachments, unreadable } = await library.listReferenceAttachments({
      projectId: 'p1',
      maxBytes: 1024
    })

    expect(attachments).toEqual([])
    expect(unreadable).toEqual(['references/Gone.pdf'])
  })

  it('names an oversized PDF rather than carrying half of it', async () => {
    const library = createSessionPackageReferenceLibrary({
      listReferences: async () => [{ id: 'ref-1', title: 'Huge', pdfManagedFileId: 'upload:big' }],
      readManagedFileBytes: async () => bytes(4096),
      maxFileBytes: 1024
    })

    const { attachments, unreadable } = await library.listReferenceAttachments({
      projectId: 'p1',
      maxBytes: 1024
    })

    expect(attachments).toEqual([])
    expect(unreadable).toEqual(['references/Huge.pdf'])
  })

  it('keeps a path-safe name and falls back to the id when a record has no title', async () => {
    const library = createSessionPackageReferenceLibrary({
      listReferences: async () => [
        { id: 'ref-1', title: 'A/B: study?', pdfManagedFileId: 'upload:a' },
        { id: 'ref-2', pdfManagedFileId: 'upload:b' }
      ],
      readManagedFileBytes: async () => bytes(4),
      maxFileBytes: 1024
    })

    const { attachments } = await library.listReferenceAttachments({
      projectId: 'p1',
      maxBytes: 1024
    })

    expect(attachments.map((entry) => entry.fileName)).toEqual(['A_B_ study_.pdf', 'ref-2.pdf'])
  })

  it('counts the records that have a PDF without reading any bytes', async () => {
    const readManagedFileBytes = vi.fn(async () => bytes(4))
    const library = createSessionPackageReferenceLibrary({
      listReferences: async () => [
        { id: 'ref-1', title: 'One', pdfManagedFileId: 'upload:a' },
        { id: 'ref-2', title: 'Two', pdfManagedFileId: 'upload:b' },
        { id: 'ref-3', title: 'None' }
      ],
      readManagedFileBytes,
      maxFileBytes: 1024
    })

    expect(await library.countReferenceAttachments({ projectId: 'p1' })).toBe(2)
    expect(readManagedFileBytes).not.toHaveBeenCalled()
  })
})

describe('currentReferencePdfId', () => {
  it('reads the attachment off the reference row, which is where the app keeps the current one', () => {
    expect(currentReferencePdfId({ pdfManagedFileId: 'upload:abc' })).toBe('upload:abc')
    expect(currentReferencePdfId({ pdfManagedFileId: null })).toBeUndefined()
    expect(currentReferencePdfId({})).toBeUndefined()
  })
})
