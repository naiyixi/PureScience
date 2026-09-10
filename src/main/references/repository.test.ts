import { describe, expect, it, vi, type Mock } from 'vitest'

import { ReferenceRepository, type ReferenceClient } from './repository'
import type { CreateReferenceInput } from '../../shared/references'
import { citationKeyFrom, normalizeTitleForDedupe } from '../../shared/references'

const rowFixture = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'ref-1',
  projectId: 'proj-1',
  title: 'Attention is all you need',
  authorsJson: '[{"name":"Ashish Vaswani"}]',
  venue: 'NeurIPS',
  year: 2017,
  doi: '10.5555/3295222.3295349',
  pmid: null,
  pmcid: null,
  arxivId: null,
  url: null,
  abstractSnippet: null,
  sourceConnector: 'openalex',
  sourceRecordId: null,
  citationKey: 'Vaswani2017',
  provenanceJson: null,
  pdfManagedFileId: null,
  pdfContentHash: null,
  notes: null,
  createdAt: new Date(1710000000000),
  updatedAt: new Date(1710000000100),
  ...overrides
})

const collectionRowFixture = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  id: 'col-1',
  projectId: 'proj-1',
  name: 'Transformers',
  description: null,
  createdAt: new Date(1710000000000),
  updatedAt: new Date(1710000000100),
  ...overrides
})

const itemRowFixture = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'item-1',
  collectionId: 'col-1',
  referenceId: 'ref-1',
  note: null,
  sortIndex: 0,
  createdAt: new Date(1710000000000),
  ...overrides
})

const createMockClient = (): {
  client: ReferenceClient
  m: Record<string, Mock>
} => {
  const m: Record<string, Mock> = {
    referenceFindMany: vi.fn(() => Promise.resolve([])),
    referenceFindUnique: vi.fn(() => Promise.resolve(null)),
    referenceCreate: vi.fn(),
    referenceDelete: vi.fn(() => Promise.resolve()),
    referenceDeleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
    referenceUpdate: vi.fn(() => Promise.resolve(null)),
    collectionFindMany: vi.fn(() => Promise.resolve([])),
    collectionCreate: vi.fn(),
    collectionDelete: vi.fn(() => Promise.resolve()),
    itemFindMany: vi.fn(() => Promise.resolve([])),
    itemFindUnique: vi.fn(() => Promise.resolve(null)),
    itemFindFirst: vi.fn(() => Promise.resolve(null)),
    itemCreate: vi.fn(),
    itemDeleteMany: vi.fn(() => Promise.resolve({ count: 0 }))
  }
  const client = {
    reference: {
      findMany: m.referenceFindMany,
      findUnique: m.referenceFindUnique,
      create: m.referenceCreate,
      delete: m.referenceDelete,
      deleteMany: m.referenceDeleteMany,
      update: m.referenceUpdate
    },
    referenceCollection: {
      findMany: m.collectionFindMany,
      create: m.collectionCreate,
      delete: m.collectionDelete
    },
    collectionItem: {
      findMany: m.itemFindMany,
      findUnique: m.itemFindUnique,
      findFirst: m.itemFindFirst,
      create: m.itemCreate,
      deleteMany: m.itemDeleteMany
    }
  } as unknown as ReferenceClient
  return { client, m }
}

const createInput = (overrides: Partial<CreateReferenceInput> = {}): CreateReferenceInput => ({
  projectId: 'proj-1',
  title: 'Attention is all you need',
  authors: [{ name: 'Ashish Vaswani' }],
  venue: 'NeurIPS',
  year: 2017,
  doi: '10.5555/3295222.3295349',
  sourceConnector: 'openalex',
  ...overrides
})

describe('citationKeyFrom / normalizeTitleForDedupe', () => {
  it('derives FirstAuthorYear keys and folds lead-ins for dedupe', () => {
    expect(citationKeyFrom(createInput())).toBe('Vaswani2017')
    expect(citationKeyFrom(createInput({ year: undefined }))).toBe('Vaswani')
    expect(citationKeyFrom(createInput({ authors: [] }))).toBe('Ref2017')
    expect(normalizeTitleForDedupe('The Attention Is All You Need!')).toBe(
      'attention is all you need'
    )
  })
})

describe('ReferenceRepository', () => {
  it('lists references newest-first for a project', async () => {
    const { client, m } = createMockClient()
    m.referenceFindMany.mockResolvedValue([rowFixture()])
    const repository = new ReferenceRepository(() => Promise.resolve(client))

    await expect(repository.listReferences('proj-1')).resolves.toMatchObject([
      { id: 'ref-1', citationKey: 'Vaswani2017', authors: [{ name: 'Ashish Vaswani' }] }
    ])
    expect(m.referenceFindMany).toHaveBeenCalledWith({
      where: { projectId: 'proj-1' },
      orderBy: { createdAt: 'desc' }
    })
  })

  it('creates a reference with serialized authors/provenance and trimmed identifiers', async () => {
    const { client, m } = createMockClient()
    m.referenceCreate.mockResolvedValue(rowFixture())
    const repository = new ReferenceRepository(() => Promise.resolve(client))

    await repository.createReference({
      ...createInput({ doi: '  10.1/ABC  ' }),
      citationKey: 'Vaswani2017'
    })

    const call = m.referenceCreate.mock.calls[0]![0] as { data: Record<string, unknown> }
    expect(call.data.doi).toBe('10.1/ABC')
    expect(call.data.authorsJson).toBe('[{"name":"Ashish Vaswani"}]')
    expect(call.data.citationKey).toBe('Vaswani2017')
    expect(call.data.sourceConnector).toBe('openalex')
  })

  it('deletes membership rows before the reference row', async () => {
    const { client, m } = createMockClient()
    const repository = new ReferenceRepository(() => Promise.resolve(client))

    await repository.deleteReference('ref-1')

    expect(m.itemDeleteMany).toHaveBeenCalledWith({
      where: { referenceId: 'ref-1' }
    })
    expect(m.referenceDelete).toHaveBeenCalledWith({ where: { id: 'ref-1' } })
  })

  it('lists collections for a project', async () => {
    const { client, m } = createMockClient()
    m.collectionFindMany.mockResolvedValue([collectionRowFixture()])
    const repository = new ReferenceRepository(() => Promise.resolve(client))

    await expect(repository.listCollections('proj-1')).resolves.toMatchObject([
      { id: 'col-1', name: 'Transformers' }
    ])
  })

  it('creates a collection', async () => {
    const { client, m } = createMockClient()
    m.collectionCreate.mockResolvedValue(collectionRowFixture())
    const repository = new ReferenceRepository(() => Promise.resolve(client))

    await repository.createCollection({ projectId: 'proj-1', name: '  Transformers  ' })

    const call = m.collectionCreate.mock.calls[0]![0] as { data: Record<string, unknown> }
    expect(call.data.name).toBe('Transformers')
  })

  it('returns an existing membership row instead of duplicating, else appends at next sortIndex', async () => {
    const { client, m } = createMockClient()
    m.itemFindUnique.mockResolvedValueOnce(itemRowFixture())
    const repository = new ReferenceRepository(() => Promise.resolve(client))
    const existing = await repository.addToCollection('col-1', 'ref-1')
    expect(existing.id).toBe('item-1')
    expect(m.itemCreate).not.toHaveBeenCalled()

    m.itemFindUnique.mockResolvedValue(null)
    m.itemFindFirst.mockResolvedValue(itemRowFixture({ sortIndex: 2 }))
    m.itemCreate.mockResolvedValue(itemRowFixture({ id: 'item-2', sortIndex: 3 }))
    const appended = await repository.addToCollection('col-1', 'ref-2')
    expect(appended.sortIndex).toBe(3)
    const call = m.itemCreate.mock.calls[0]![0] as {
      data: Record<string, unknown>
    }
    expect(call.data.sortIndex).toBe(3)
  })

  it('removes an item from a collection', async () => {
    const { client, m } = createMockClient()
    const repository = new ReferenceRepository(() => Promise.resolve(client))

    await repository.removeFromCollection('col-1', 'ref-1')

    expect(m.itemDeleteMany).toHaveBeenCalledWith({
      where: { collectionId: 'col-1', referenceId: 'ref-1' }
    })
  })

  it('attaches and detaches the page-annotation PDF backing a reference', async () => {
    const { client, m } = createMockClient()
    const repository = new ReferenceRepository(() => Promise.resolve(client))

    m.referenceUpdate.mockResolvedValue(rowFixture({ pdfManagedFileId: 'file-pdf-1' }))
    await expect(repository.attachPdf('ref-1', 'file-pdf-1')).resolves.toMatchObject({
      id: 'ref-1',
      pdfManagedFileId: 'file-pdf-1'
    })
    expect(m.referenceUpdate).toHaveBeenCalledWith({
      where: { id: 'ref-1' },
      data: { pdfManagedFileId: 'file-pdf-1', pdfContentHash: null }
    })

    m.referenceUpdate.mockResolvedValue(rowFixture({ pdfManagedFileId: null }))
    await expect(repository.attachPdf('ref-1', null)).resolves.toMatchObject({
      id: 'ref-1',
      pdfManagedFileId: undefined
    })
    expect(m.referenceUpdate).toHaveBeenLastCalledWith({
      where: { id: 'ref-1' },
      data: { pdfManagedFileId: null, pdfContentHash: null }
    })
  })
})
