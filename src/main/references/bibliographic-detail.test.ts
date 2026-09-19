import { describe, expect, it, vi } from 'vitest'

import { ReferenceService, openAlexBibliographicDetail, pubmedBibliographicDetail } from './service'
import type { CreateReferenceInput } from '../../shared/references'

describe('OpenAlex bibliographic detail', () => {
  it('reads the volume, issue, page range, publisher and article type', () => {
    expect(
      openAlexBibliographicDetail({
        type: 'article',
        biblio: { volume: '21', issue: '3', first_page: '145', last_page: '158' },
        primary_location: {
          source: { type: 'journal', host_organization_name: 'Springer Nature' }
        }
      })
    ).toEqual({
      volume: '21',
      issue: '3',
      pages: '145-158',
      publisher: 'Springer Nature',
      itemType: 'journal-article'
    })
  })

  it('keeps a single page as one value and reports a conference source as such', () => {
    expect(
      openAlexBibliographicDetail({
        type: 'article',
        biblio: { first_page: 'e12345', last_page: 'e12345' },
        primary_location: { source: { type: 'conference' } }
      })
    ).toEqual({
      volume: undefined,
      issue: undefined,
      pages: 'e12345',
      publisher: undefined,
      itemType: 'conference-paper'
    })
  })

  it('labels preprints, chapters, books, datasets, theses and reports', () => {
    const typeOf = (type: string): string | undefined =>
      openAlexBibliographicDetail({ type })?.itemType
    expect(typeOf('preprint')).toBe('preprint')
    expect(typeOf('book-chapter')).toBe('chapter')
    expect(typeOf('book')).toBe('book')
    expect(typeOf('dataset')).toBe('dataset')
    expect(typeOf('dissertation')).toBe('thesis')
    expect(typeOf('report')).toBe('report')
    expect(typeOf('review')).toBe('journal-article')
    expect(typeOf('other')).toBeUndefined()
  })

  it('leaves absent fields absent instead of inventing them', () => {
    expect(openAlexBibliographicDetail({})).toEqual({
      volume: undefined,
      issue: undefined,
      pages: undefined,
      publisher: undefined,
      itemType: undefined
    })
  })
})

describe('PubMed bibliographic detail', () => {
  it('reads the journal citation block and the journal-article type', () => {
    expect(
      pubmedBibliographicDetail({
        volume: '382',
        issue: '6690',
        pages: '1123-1130',
        pubtype: ['Journal Article']
      })
    ).toEqual({
      volume: '382',
      issue: '6690',
      pages: '1123-1130',
      itemType: 'journal-article'
    })
  })

  it('recognizes non-article record types and trims blank values away', () => {
    expect(pubmedBibliographicDetail({ pubtype: ['Book'] }).itemType).toBe('book')
    expect(pubmedBibliographicDetail({ pubtype: ['Preprint'] }).itemType).toBe('preprint')
    expect(pubmedBibliographicDetail({ pubtype: ['Dataset'] }).itemType).toBe('dataset')
    expect(pubmedBibliographicDetail({ volume: '   ' }).volume).toBeUndefined()
    expect(pubmedBibliographicDetail({}).itemType).toBeUndefined()
  })
})

describe('the library keeps the detail it looked up', () => {
  it('passes volume, issue, pages, publisher and item type through to the repository', async () => {
    const captured: CreateReferenceInput[] = []
    const repository = {
      listReferences: vi.fn(async () => []),
      createReference: vi.fn(async (input: CreateReferenceInput & { citationKey: string }) => {
        captured.push(input)
        return {
          id: 'ref-1',
          projectId: input.projectId,
          title: input.title,
          authors: input.authors ?? [],
          venue: input.venue,
          year: input.year,
          volume: input.volume,
          issue: input.issue,
          pages: input.pages,
          publisher: input.publisher,
          itemType: input.itemType,
          doi: input.doi,
          pmid: input.pmid,
          pmcid: input.pmcid,
          arxivId: input.arxivId,
          url: input.url,
          abstractSnippet: undefined,
          sourceConnector: input.sourceConnector ?? 'manual',
          sourceRecordId: undefined,
          citationKey: input.citationKey,
          provenance: input.provenance,
          pdfManagedFileId: undefined,
          notes: undefined,
          createdAt: 1,
          updatedAt: 1
        }
      })
    }
    const service = new ReferenceService(repository as never)
    await service.addReference({
      projectId: 'proj-1',
      title: 'Deep learning for protein design',
      authors: [{ name: 'Wei Zhang' }],
      venue: 'Nature Methods',
      year: 2024,
      volume: '21',
      issue: '3',
      pages: '145-158',
      publisher: 'Springer Nature',
      itemType: 'journal-article',
      doi: '10.1038/s41592-024-01234-5'
    })
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      volume: '21',
      issue: '3',
      pages: '145-158',
      publisher: 'Springer Nature',
      itemType: 'journal-article'
    })
  })
})
