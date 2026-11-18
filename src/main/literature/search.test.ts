import { describe, expect, it, vi } from 'vitest'

import { tagText, tagTexts, decodeXmlEntities, attributeOf } from './xml-fields'
import {
  asDoi,
  crossrefWorkToRecord,
  formatCitation,
  parseArxivFeed,
  parsePubMedXmlAbstracts,
  parsePubMedSummary,
  searchLiterature,
  type FetchLike
} from './search'

// Fixtures are the shapes these APIs actually return, trimmed to the fields the reader uses. The two cases that
// cost real debugging time are in here: a MEDLINE abstract whose continuation lines must fold back, and a
// Crossref record whose abstract arrives wrapped in JATS tags.
const ESUMMARY = JSON.stringify({
  result: {
    uids: ['38123456', '33567185'],
    38123456: {
      title: 'Development of a Rapid Adeno-Associated Virus Identity Testing Platform.',
      pubdate: '2023 Dec 15',
      fulljournalname: 'Journal of proteome research',
      volume: '23',
      issue: '1',
      pages: '161-74',
      authors: [{ name: 'Zhang S' }, { name: 'Li Y' }],
      articleids: [
        { idtype: 'pubmed', value: '38123456' },
        { idtype: 'doi', value: '10.1021/acs.jproteome.3c00513' },
        { idtype: 'pmc', value: 'PMC10776890' }
      ]
    },
    33567185: {
      title: 'Once-Weekly Semaglutide in Adults with Overweight or Obesity.',
      pubdate: '2021',
      fulljournalname: 'The New England journal of medicine',
      volume: '384',
      issue: '11',
      pages: '989-1002',
      authors: [{ name: 'Wilding JPH' }],
      articleids: [{ idtype: 'pubmed', value: '33567185' }]
    }
  }
})

// `efetch … retmode=xml`, the shape the reader parses. The pretty text view has no field markers at all, so
// using it left every record as `Metadata only` — that regression is why this fixture is XML.
const ABSTRACT_XML = `<?xml version="1.0" ?>
<PubmedArticleSet>
<PubmedArticle>
  <MedlineCitation>
    <PMID Version="1">38123456</PMID>
    <Article>
      <Abstract>
        <AbstractText>Adeno-associated virus vectors are widely used in gene therapy.</AbstractText>
        <AbstractText Label="METHODS">Existing identity testing relies on labour-intensive methods.</AbstractText>
        <AbstractText Label="RESULTS">Here we describe a rapid platform.</AbstractText>
      </Abstract>
    </Article>
  </MedlineCitation>
</PubmedArticle>
</PubmedArticleSet>`

const ARXIV_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2103.14030v1</id>
    <published>2021-03-25T17:34:14Z</published>
    <title>Masked Autoencoders Are Scalable Vision Learners</title>
    <summary>This paper shows a simple self-supervised approach.</summary>
    <author><name>Kaiming He</name></author>
    <author><name>Xinlei Chen</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v5</id>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All You Need</title>
    <summary>We propose a new simple network architecture.</summary>
    <author><name>Ashish Vaswani</name></author>
  </entry>
</feed>`

describe('xml-fields', () => {
  it('reads namespaced tags and decodes entities', () => {
    const xml = '<ns0:JournalTitle>J &amp; K</ns0:JournalTitle>'
    expect(tagText(xml, 'JournalTitle')).toBe('J & K')
    expect(decodeXmlEntities('a &#x4E2D; b &#25991;')).toBe('a 中 b 文')
  })

  it('lists repeated tags in order and reads an attribute', () => {
    expect(tagTexts('<a>x</a><b><a>y</a></b>', 'a')).toEqual(['x', 'y'])
    expect(attributeOf('<link href="https://example.org/x"/>', 'link', 'href')).toBe(
      'https://example.org/x'
    )
  })
})

describe('PubMed', () => {
  it('reads the summary JSON into records, keeping DOI and PMC id apart', () => {
    const records = parsePubMedSummary(ESUMMARY)
    expect(records).toHaveLength(2)
    expect(records[0]?.title).toContain('Adeno-Associated Virus')
    expect(records[0]?.doi).toBe('10.1021/acs.jproteome.3c00513')
    expect(records[0]?.pmcid).toBe('PMC10776890')
    expect(records[0]?.year).toBe(2023)
    expect(records[0]?.pages).toBe('161-74')
    expect(records[0]?.read).toBe('Metadata only')
    expect(records[1]?.doi).toBeUndefined()
  })

  it('reads the abstract out of the XML, keeping its section labels', () => {
    const abstracts = parsePubMedXmlAbstracts(ABSTRACT_XML)
    const abstract = abstracts.get('38123456')
    expect(abstract).toContain('Adeno-associated virus vectors')
    expect(abstract).toContain('METHODS: Existing identity testing')
    expect(abstract).toContain('RESULTS: Here we describe a rapid platform.')
  })
})

describe('arXiv', () => {
  it('reads title, authors, id, year and abstract from the Atom feed', () => {
    const records = parseArxivFeed(ARXIV_FEED)
    expect(records).toHaveLength(2)
    expect(records[0]?.title).toBe('Masked Autoencoders Are Scalable Vision Learners')
    expect(records[0]?.authors).toEqual(['Kaiming He', 'Xinlei Chen'])
    expect(records[0]?.arxivId).toBe('2103.14030v1')
    expect(records[0]?.year).toBe(2021)
    expect(records[0]?.url).toBe('http://arxiv.org/abs/2103.14030v1')
    expect(records[0]?.read).toBe('Abstract')
  })
})

describe('Crossref and identifiers', () => {
  it('strips JATS tags from an abstract and builds a DOI url', () => {
    const record = crossrefWorkToRecord({
      DOI: '10.1056/NEJMoa2034577',
      title: ['Safety and Efficacy of the BNT162b2 mRNA Covid-19 Vaccine'],
      author: [{ given: 'Fernando P.', family: 'Polack' }],
      issued: { 'date-parts': [[2020, 12, 31]] },
      'container-title': ['New England Journal of Medicine'],
      volume: '383',
      issue: '27',
      page: '2603-2615',
      abstract: '<jats:p>BACKGROUND</jats:p><jats:p>Vaccines are needed.</jats:p>'
    })
    expect(record?.abstract).toBe('BACKGROUND Vaccines are needed.')
    expect(record?.url).toBe('https://doi.org/10.1056/NEJMoa2034577')
    expect(record?.authors).toEqual(['Fernando P. Polack'])
    expect(record?.year).toBe(2020)
  })

  // The pii trap, again: a value that is not a `10.` identifier is not a DOI, whatever label it arrived under.
  it('refuses an identifier that is not a DOI', () => {
    expect(asDoi('88/4/401M [pii]')).toBeUndefined()
    expect(asDoi('https://doi.org/10.1038/527S101a')).toBe('10.1038/527S101a')
    expect(asDoi(' doi: 10.1000/x ')).toBe('10.1000/x')
  })
})

describe('searchLiterature', () => {
  const fetchReturning = (routes: Record<string, string>): FetchLike =>
    (async (url: string) => {
      const key = Object.keys(routes).find((fragment) => url.includes(fragment))
      if (key === undefined)
        return { ok: false, status: 404, text: async () => '', json: async () => undefined }
      return {
        ok: true,
        status: 200,
        text: async () => routes[key] as string,
        json: async () => JSON.parse(routes[key] as string)
      }
    }) as FetchLike

  it('merges the sources and reports nothing when all of them answer', async () => {
    const result = await searchLiterature({
      query: 'adeno-associated virus',
      sources: ['pubmed', 'arxiv'],
      fetchImpl: fetchReturning({
        esearch: JSON.stringify({ esearchresult: { idlist: ['38123456', '33567185'] } }),
        esummary: ESUMMARY,
        efetch: ABSTRACT_XML,
        'export.arxiv.org': ARXIV_FEED
      })
    })

    expect(result.errors).toEqual([])
    expect(result.records.length).toBe(4)
    // The abstract round trip upgraded exactly the record that had one.
    expect(result.records.find((record) => record.pmid === '38123456')?.read).toBe('Abstract')
    expect(result.records.find((record) => record.pmid === '33567185')?.read).toBe('Metadata only')
  })

  it('keeps the records from the source that answered when another fails', async () => {
    const result = await searchLiterature({
      query: 'transformer',
      sources: ['pubmed', 'arxiv'],
      fetchImpl: fetchReturning({ 'export.arxiv.org': ARXIV_FEED })
    })
    expect(result.records).toHaveLength(2)
    expect(result.errors.map((error) => error.source)).toEqual(['pubmed'])
  })

  it('treats a DOI query as a lookup, not a full-text search', async () => {
    const fetchImpl = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          message: {
            DOI: '10.1056/NEJMoa2034577',
            title: ['Safety and Efficacy'],
            'container-title': ['NEJM']
          }
        }),
      json: async () => undefined
    }))
    const result = await searchLiterature({
      query: '10.1056/NEJMoa2034577',
      fetchImpl: fetchImpl as never
    })
    expect(result.records).toHaveLength(1)
    expect(result.records[0]?.source).toBe('crossref')
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('api.crossref.org/works/10.1056')
  })
})

describe('formatCitation', () => {
  it('writes only what the record has, and says et al past three authors', () => {
    const citation = formatCitation({
      source: 'pubmed',
      title: 'A title',
      authors: ['A One', 'B Two', 'C Three', 'D Four'],
      year: 2024,
      venue: 'A Journal',
      volume: '12',
      issue: '3',
      pages: '1-9',
      doi: '10.1000/x',
      pmid: '1',
      pmcid: undefined,
      arxivId: undefined,
      url: 'https://example.org',
      abstract: undefined,
      read: 'Metadata only'
    })
    expect(citation).toBe(
      'A One, B Two, C Three, et al. A title. A Journal. 2024. 12(3). 1-9. doi:10.1000/x.'
    )
  })
})
