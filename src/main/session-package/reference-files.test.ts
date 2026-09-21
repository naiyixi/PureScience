import { describe, expect, it, vi } from 'vitest'

import { createSessionPackageReferenceFileLister } from './reference-files'

// The reference library's PDFs enter the package on the same terms as session files: bounded, uniquely
// named, and every item that did not travel is named rather than dropped.

const bytes = (size: number): Uint8Array => new Uint8Array(size).fill(65)

const attachment = (fileName: string, size: number) => ({
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
