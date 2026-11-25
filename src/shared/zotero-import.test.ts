import { describe, expect, it } from 'vitest'

import type { Reference } from './references'
import { planZoteroImport, ZOTERO_IMPORT_LIMIT } from './zotero-import'

const existing = (overrides: Partial<Reference>): Reference => ({
  id: 'ref-1',
  projectId: 'project-1',
  title: 'Existing work',
  authors: [{ name: 'A. Author' }],
  venue: undefined,
  year: 2020,
  doi: undefined,
  pmid: undefined,
  pmcid: undefined,
  arxivId: undefined,
  url: undefined,
  abstractSnippet: undefined,
  sourceConnector: 'manual',
  sourceRecordId: undefined,
  citationKey: 'Author2020',
  provenance: undefined,
  pdfManagedFileId: undefined,
  notes: undefined,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

// A Zotero JSON export is an array of CSL items; this fixture is the shape the app really receives.
const exportText = JSON.stringify([
  {
    id: 'ABCD1234',
    type: 'article-journal',
    title: 'Biased agonism at the GPCR interface',
    author: [
      { family: 'Chen', given: 'Wei' },
      { literal: 'The Consortium' }
    ],
    'container-title': 'Nature',
    issued: { 'date-parts': [[2023, 4, 2]] },
    volume: '615',
    issue: '7952',
    page: '100-112',
    DOI: 'https://doi.org/10.1038/S41586-023-0001-2',
    PMID: '37000000',
    URL: 'https://example.org/gpcr',
    abstract: 'We measured pathway bias across twenty receptor variants.'
  },
  {
    id: 'EFGH5678',
    type: 'book',
    title: 'Statistical mechanics of binding',
    author: [{ family: 'Park', given: 'Min' }],
    publisher: 'Cold Spring Harbor Press',
    issued: { literal: '2019' }
  },
  { id: 'MISSING', type: 'article-journal', DOI: '10.1000/no-title' },
  'not-an-item',
  {
    id: 'DUP',
    type: 'article-journal',
    title: 'Biased agonism at the GPCR interface (again)',
    DOI: 'https://doi.org/10.1038/s41586-023-0001-2'
  }
])

describe('planZoteroImport', () => {
  it('maps CSL fields onto the record the library writes', () => {
    const plan = planZoteroImport(exportText, [])
    if ('error' in plan) throw new Error(plan.error)

    expect(plan.records).toHaveLength(2)
    const [article, book] = plan.records

    expect(article?.input).toMatchObject({
      title: 'Biased agonism at the GPCR interface',
      authors: [{ name: 'Wei Chen' }, { name: 'The Consortium' }],
      venue: 'Nature',
      year: 2023,
      volume: '615',
      issue: '7952',
      pages: '100-112',
      itemType: 'journal-article',
      pmid: '37000000',
      url: 'https://example.org/gpcr',
      abstractSnippet: 'We measured pathway bias across twenty receptor variants.'
    })
    // The DOI is kept as Zotero wrote it; only the duplicate key is normalised.
    expect(article?.doi).toBe('https://doi.org/10.1038/S41586-023-0001-2')

    // A book has no container title: its venue is the publisher, and the year comes from `issued.literal`.
    expect(book?.input.venue).toBe('Cold Spring Harbor Press')
    expect(book?.input.year).toBe(2019)
    expect(book?.input.itemType).toBe('book')
  })

  it('refuses rather than repairs: no title, not an item, and the duplicate inside the export itself', () => {
    const plan = planZoteroImport(exportText, [])
    if ('error' in plan) throw new Error(plan.error)

    expect(plan.skipped.map((entry) => entry.reason)).toEqual([
      'missing-title',
      'not-an-object',
      'duplicate'
    ])
    expect(plan.skipped[0]?.label).toBe('10.1000/no-title')
  })

  it('treats a DOI the project already holds as a duplicate, whatever the URL prefix or case', () => {
    const plan = planZoteroImport(exportText, [
      existing({ doi: '10.1038/s41586-023-0001-2' })
    ])
    if ('error' in plan) throw new Error(plan.error)

    expect(plan.records.map((record) => record.input.title)).toEqual([
      'Statistical mechanics of binding'
    ])
    expect(plan.skipped.map((entry) => entry.reason)).toContain('duplicate')
  })

  it('falls back to the normalised title when the DOI is missing', () => {
    const text = JSON.stringify([{ type: 'book', title: '  Binding   MECHANICS ' }])
    const plan = planZoteroImport(text, [existing({ title: 'binding mechanics' })])
    if ('error' in plan) throw new Error(plan.error)

    expect(plan.records).toHaveLength(0)
    expect(plan.skipped[0]?.reason).toBe('duplicate')
  })

  it('accepts the wrapper object Zotero writes for a saved search, and says so when the text is not JSON', () => {
    const wrapped = planZoteroImport(JSON.stringify({ items: [{ title: 'Wrapped' }] }), [])
    if ('error' in wrapped) throw new Error(wrapped.error)
    expect(wrapped.records[0]?.input.title).toBe('Wrapped')

    expect(planZoteroImport('{oops', [])).toEqual({ error: 'not-json' })
    expect(planZoteroImport(JSON.stringify({ nope: true }), [])).toEqual({
      error: 'not-a-zotero-export'
    })
  })

  it('caps a very large export instead of writing an unbounded number of rows', () => {
    const many = Array.from({ length: ZOTERO_IMPORT_LIMIT + 25 }, (_, index) => ({
      title: `Record ${index}`
    }))
    const plan = planZoteroImport(JSON.stringify(many), [])
    if ('error' in plan) throw new Error(plan.error)

    expect(plan.records).toHaveLength(ZOTERO_IMPORT_LIMIT)
  })
})
