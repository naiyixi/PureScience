import { describe, expect, it } from 'vitest'

import type { Reference } from './references'
import { referenceSearchTerms, searchReferences } from './reference-search'

const build = (overrides: Partial<Reference>): Reference => ({
  id: 'ref-1',
  projectId: 'project-1',
  title: 'Untitled',
  authors: [{ name: 'Someone' }],
  venue: undefined,
  year: undefined,
  doi: undefined,
  pmid: undefined,
  pmcid: undefined,
  arxivId: undefined,
  url: undefined,
  abstractSnippet: undefined,
  sourceConnector: 'manual',
  sourceRecordId: undefined,
  citationKey: 'Someone2024',
  provenance: undefined,
  pdfManagedFileId: undefined,
  notes: undefined,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

describe('referenceSearchTerms', () => {
  it('folds case, drops blanks and collapses duplicates', () => {
    expect(referenceSearchTerms('  Chen   chen  2023 ')).toEqual(['chen', '2023'])
    expect(referenceSearchTerms('   ')).toEqual([])
  })
})

describe('searchReferences', () => {
  const references: Reference[] = [
    build({
      id: 'gpc',
      title: 'GPCR activation pathways under biased agonism',
      authors: [{ name: 'Chen Wei' }],
      venue: 'Nature',
      year: 2023,
      doi: '10.1038/gpcr.2023',
      abstractSnippet: 'We measured pathway bias across twenty receptor variants.'
    }),
    build({
      id: 'kinase',
      title: 'Kinase DFG flip energetics',
      authors: [{ name: 'Chen Wei' }],
      venue: 'Cell',
      year: 2019,
      doi: '10.1016/kinase.2019',
      abstractSnippet: 'A metastable well explains the DFG flip.'
    }),
    build({
      id: 'unrelated',
      title: 'Lyophilisation and the hydration shell',
      authors: [{ name: 'Park Min' }],
      venue: 'J Pharm Sci',
      year: 2021,
      doi: '10.1002/lyo.2021'
    })
  ]

  it('searches nothing for a blank query — the caller keeps its own list', () => {
    expect(searchReferences(references, '   ')).toEqual([])
  })

  it('requires every term (AND), not any of them', () => {
    const both = searchReferences(references, 'chen 2023')
    expect(both.map((result) => result.reference.id)).toEqual(['gpc'])

    const titleOnly = searchReferences(references, 'chen dfg')
    expect(titleOnly.map((result) => result.reference.id)).toEqual(['kinase'])
  })

  it('ranks a title hit above an abstract-only hit', () => {
    const byTitle = searchReferences(references, 'dfg')
    const byAbstract = searchReferences(references, 'metastable')
    expect(byTitle[0]?.reference.id).toBe('kinase')
    expect(byAbstract[0]?.reference.id).toBe('kinase')
    expect(byTitle[0]?.score).toBeGreaterThan(byAbstract[0]?.score ?? 0)
  })

  it('attributes a hit to the field it came from, with a window around it', () => {
    const [doi] = searchReferences(references, '10.1038')
    expect(doi?.matches[0]?.field).toBe('doi')

    const [author] = searchReferences(references, 'park')
    expect(author?.matches[0]?.field).toBe('authors')

    const long = build({
      id: 'long',
      title: 'Long abstract',
      abstractSnippet: `${'x'.repeat(200)}hydration shell${'y'.repeat(200)}`
    })
    const [hit] = searchReferences([long], 'hydration')
    expect(hit?.matches[0]?.field).toBe('abstract')
    // The window is cut down to the hit, not the whole abstract — otherwise the row carries 400 characters.
    expect(hit?.matches[0]?.snippet).toContain('hydration')
    expect((hit?.matches[0]?.snippet ?? '').length).toBeLessThan(200)
    expect(hit?.matches[0]?.snippet.startsWith('…')).toBe(true)
  })

  it('searches the year as a field of its own', () => {
    expect(searchReferences(references, '2019').map((result) => result.reference.id)).toEqual([
      'kinase'
    ])
  })

  it('orders equal scores by recency, then by title', () => {
    const same = [
      build({ id: 'older', title: 'Same words here', year: 2018 }),
      build({ id: 'newer', title: 'Same words here', year: 2024 }),
      build({ id: 'alpha', title: 'Aaa words here', year: 2024 })
    ]
    expect(searchReferences(same, 'words').map((result) => result.reference.id)).toEqual([
      'alpha',
      'newer',
      'older'
    ])
  })
})
