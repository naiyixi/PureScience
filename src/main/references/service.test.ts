import { describe, expect, it, vi } from 'vitest'

import { ReferenceService, fetchReferenceByIdentifier, findDuplicateCandidates } from './service'
import type { ReferenceRepository } from './repository'
import type { Reference } from '../../shared/references'

const refFixture = (overrides: Partial<Reference> = {}): Reference => ({
  id: 'ref-1',
  projectId: 'proj-1',
  title: 'Attention is all you need',
  authors: [{ name: 'Ashish Vaswani' }],
  venue: 'NeurIPS',
  year: 2017,
  doi: '10.5555/3295222.3295349',
  pmid: undefined,
  pmcid: undefined,
  arxivId: undefined,
  url: undefined,
  abstractSnippet: undefined,
  sourceConnector: 'openalex',
  sourceRecordId: undefined,
  citationKey: 'Vaswani2017',
  provenance: undefined,
  pdfManagedFileId: undefined,
  notes: undefined,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const makeRepo = (existing: Reference[] = []): ReferenceRepository & Record<string, unknown> => {
  const rows = [...existing]
  const repo: Record<string, unknown> = {
    listReferences: vi.fn(() => Promise.resolve([...rows])),
    getReference: vi.fn((id: string) => Promise.resolve(rows.find((r) => r.id === id) ?? null)),
    createReference: vi.fn((input: Parameters<ReferenceRepository['createReference']>[0]) => {
      const record = refFixture({
        id: `ref-${rows.length + 1}`,
        projectId: input.projectId,
        title: input.title,
        authors: input.authors ?? [],
        doi: input.doi,
        citationKey: input.citationKey
      })
      rows.push(record)
      return Promise.resolve(record)
    }),
    deleteReference: vi.fn((id: string) => {
      const index = rows.findIndex((r) => r.id === id)
      if (index >= 0) rows.splice(index, 1)
      return Promise.resolve()
    }),
    updateReference: vi.fn(
      (id: string, changes: { notes?: string; provenance?: Reference['provenance'] }) => {
        const record = rows.find((r) => r.id === id)
        if (record) {
          if (changes.notes !== undefined) record.notes = changes.notes
          if (changes.provenance !== undefined) record.provenance = changes.provenance
        }
        return Promise.resolve()
      }
    ),
    attachPdf: vi.fn((id: string, pdfManagedFileId: string | null) => {
      const record = rows.find((r) => r.id === id)
      if (record) record.pdfManagedFileId = pdfManagedFileId ?? undefined
      return Promise.resolve(record ?? null)
    }),
    listMemberships: vi.fn(() => Promise.resolve([])),
    addToCollection: vi.fn((collectionId: string, referenceId: string, note?: string) =>
      Promise.resolve({
        id: `item-${collectionId}-${referenceId}`,
        collectionId,
        referenceId,
        note: note ?? undefined,
        sortIndex: 0,
        createdAt: 1
      })
    ),
    removeFromCollection: vi.fn(() => Promise.resolve()),
    listCollections: vi.fn(() => Promise.resolve([])),
    createCollection: vi.fn(),
    deleteCollection: vi.fn(() => Promise.resolve())
  }
  return repo as ReferenceRepository & Record<string, unknown>
}

const input = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  projectId: 'proj-1',
  title: 'Attention is all you need',
  authors: [{ name: 'Ashish Vaswani' }],
  year: 2017,
  doi: '10.5555/3295222.3295349',
  ...overrides
})

describe('findDuplicateCandidates', () => {
  it('flags same DOI and normalized-title collisions', () => {
    const existing = [
      refFixture(),
      refFixture({ id: 'ref-2', title: 'A totally different paper', doi: '10.1/x' })
    ]
    const byDoi = findDuplicateCandidates(input() as never, existing)
    expect(byDoi.map((r) => r.id)).toEqual(['ref-1'])
    const byTitle = findDuplicateCandidates(
      input({ doi: undefined, title: 'The Attention Is All You Need!' }) as never,
      existing
    )
    expect(byTitle.map((r) => r.id)).toEqual(['ref-1'])
  })
})

describe('ReferenceService.addReference', () => {
  it('creates with an auto citation key', async () => {
    const repo = makeRepo()
    const service = new ReferenceService(repo as unknown as ReferenceRepository)
    const result = await service.addReference(input() as never)
    expect(result.status).toBe('created')
    if (result.status === 'created') expect(result.reference.citationKey).toBe('Vaswani2017')
  })

  it('returns duplicate instead of writing when a DOI already exists', async () => {
    const repo = makeRepo([refFixture()])
    const service = new ReferenceService(repo as unknown as ReferenceRepository)
    const result = await service.addReference(input({ title: 'Same paper again' }) as never)
    expect(result.status).toBe('duplicate')
    expect(repo.createReference).not.toHaveBeenCalled()
  })

  it('suffixes citation keys on collision within the project', async () => {
    const repo = makeRepo([refFixture()])
    const service = new ReferenceService(repo as unknown as ReferenceRepository)
    const result = await service.addReference(
      input({ doi: undefined, title: 'Second paper same author year' }) as never
    )
    expect(result.status).toBe('created')
    if (result.status === 'created') expect(result.reference.citationKey).toBe('Vaswani20171')
  })
})

describe('ReferenceService.createCollection', () => {
  it('rejects a duplicate collection name with a readable error', async () => {
    const repo = makeRepo()
    ;(repo.listCollections as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'col-1', projectId: 'proj-1', name: 'Transformers', createdAt: 1, updatedAt: 1 }
    ])
    const service = new ReferenceService(repo as unknown as ReferenceRepository)
    await expect(
      service.createCollection({ projectId: 'proj-1', name: 'Transformers' })
    ).rejects.toThrow(/already exists/i)
  })
})

describe('ReferenceService.mergeReferences', () => {
  it('moves memberships, merges notes/provenance, and deletes duplicates', async () => {
    const repo = makeRepo([
      refFixture({
        id: 'keeper',
        notes: 'keep me',
        provenance: { connector: 'arxiv', fetchedAt: 't1' }
      }),
      refFixture({
        id: 'dup',
        doi: undefined,
        title: 'Attention is all you need (same)',
        notes: 'extra note',
        provenance: { connector: 'openalex', fetchedAt: 't2', snapshotJson: 'x'.repeat(500) }
      })
    ])
    ;(repo.listMemberships as ReturnType<typeof vi.fn>).mockResolvedValue([
      { collectionId: 'col-1', note: 'primary' }
    ])
    const service = new ReferenceService(repo as unknown as ReferenceRepository)

    const merged = await service.mergeReferences('keeper', ['dup'])

    expect(merged.notes).toContain('keep me')
    expect(merged.notes).toContain('extra note')
    expect(repo.addToCollection).toHaveBeenCalledWith('col-1', 'keeper', 'primary')
    expect(repo.removeFromCollection).toHaveBeenCalledWith('col-1', 'dup')
    expect(repo.deleteReference).toHaveBeenCalledWith('dup')
    expect(merged.provenance?.snapshotJson).toBe('x'.repeat(500))
  })
})

describe('fetchReferenceByIdentifier', () => {
  it('resolves a DOI through OpenAlex', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            results: [
              {
                title: 'The Paper',
                publication_year: 2024,
                doi: 'https://doi.org/10.1/abc',
                authorships: [{ author: { display_name: 'Alice Zhang' } }],
                primary_location: { source: { display_name: 'Journal of X' } }
              }
            ]
          })
      } as Response)
    )
    const result = await fetchReferenceByIdentifier('doi', '10.1/abc', {
      fetchImpl: fetchImpl as never
    })
    expect(result?.title).toBe('The Paper')
    expect(result?.doi).toBe('10.1/abc')
    expect(result?.venue).toBe('Journal of X')
    expect(result?.provenance?.connector).toBe('openalex')
  })

  it('returns null on a non-OK response', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: false } as Response))
    const result = await fetchReferenceByIdentifier('pmid', '123', {
      fetchImpl: fetchImpl as never
    })
    expect(result).toBeNull()
  })

  it('resolves a PMID through NCBI esummary JSON', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            result: {
              uids: ['42'],
              '42': { title: 'NCBI Paper', pubdate: '2023 Jan', authors: [{ name: 'Bo Li' }] }
            }
          })
      } as Response)
    )
    const result = await fetchReferenceByIdentifier('pmid', '42', {
      fetchImpl: fetchImpl as never
    })
    expect(result?.title).toBe('NCBI Paper')
    expect(result?.year).toBe(2023)
    expect(result?.pmid).toBe('42')
  })
})

describe('ReferenceService PDF attachment', () => {
  it('attaches a managed PDF id and reports the updated reference', async () => {
    const existing = refFixture({ id: 'ref-1', title: 'Paper' })
    const repo = makeRepo([existing])
    const service = new ReferenceService(repo as unknown as ReferenceRepository)

    const updated = await service.attachPdf('ref-1', 'file-pdf-9')
    expect(updated.id).toBe('ref-1')
    expect(updated.pdfManagedFileId).toBe('file-pdf-9')
    expect(repo.getReference).toHaveBeenCalledWith('ref-1')
    expect(repo.attachPdf).toHaveBeenCalledWith('ref-1', 'file-pdf-9')
  })

  it('detaches by writing null through the repository', async () => {
    const existing = refFixture({ id: 'ref-1', title: 'Paper', pdfManagedFileId: 'file-pdf-9' })
    const repo = makeRepo([existing])
    const service = new ReferenceService(repo as unknown as ReferenceRepository)

    const updated = await service.detachPdf('ref-1')
    expect(updated.pdfManagedFileId).toBeUndefined()
    expect(repo.attachPdf).toHaveBeenCalledWith('ref-1', null)
  })

  it('rejects attaching when the reference does not exist', async () => {
    const repo = makeRepo([])
    const service = new ReferenceService(repo as unknown as ReferenceRepository)
    await expect(service.attachPdf('missing', 'file-pdf-9')).rejects.toThrow('Reference not found.')
    expect(repo.attachPdf).not.toHaveBeenCalled()
  })
})
