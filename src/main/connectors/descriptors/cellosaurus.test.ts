import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { CELLOSAURUS_TOOLS } from './cellosaurus'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => CELLOSAURUS_TOOLS.find((t) => t.id === id)!

const okJson = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response
const notFound = (): Response =>
  ({
    ok: false,
    status: 404,
    headers: { get: () => null },
    json: async () => ({})
  }) as unknown as Response

const run = async (
  args: Record<string, unknown>,
  responses: Response[]
): Promise<{ out: Record<string, unknown>; urls: string[] }> => {
  const fetchImpl = vi.fn()
  for (const r of responses) fetchImpl.mockResolvedValueOnce(r)
  const out = (await new ParserEngine({ fetchImpl }).call(
    tool('get_cellosaurus_cell_line'),
    args,
    {}
  )) as Record<string, unknown>
  return { out, urls: fetchImpl.mock.calls.map((c) => c[0] as string) }
}

const BASE = 'https://api.cellosaurus.org'

// Live 2026-10 KB (CVCL_0372) record, trimmed to the fields the tool reads. KB is the canonical
// contaminated/misidentified line: its comment block carries a "Problematic cell line" annotation.
const KB = {
  'accession-list': [{ type: 'primary', value: 'CVCL_0372' }],
  'name-list': [
    { type: 'identifier', value: 'KB' },
    { type: 'synonym', value: 'HeLa-KB' },
    { type: 'synonym', value: 'Strain KB' }
  ],
  category: 'Cancer cell line',
  age: '',
  sex: 'Female',
  'species-list': [{ accession: '9606', database: 'NCBI_TaxID', label: 'Homo sapiens (Human)' }],
  'disease-list': [{ accession: 'C27677', database: 'NCIt', label: 'Endocervical adenocarcinoma' }],
  'comment-list': [
    { category: 'Population', value: 'African American' },
    {
      category: 'Problematic cell line',
      value:
        'Contaminated. Shown to be a HeLa derivative. Originally thought to originate from an epidermal carcinoma of the mouth.'
    }
  ],
  'str-list': {
    'marker-list': [
      { id: 'Amelogenin', conflict: 'false', 'marker-data-list': [{ 'marker-alleles': 'X' }] },
      { id: 'D13S317', conflict: 'true', 'marker-data-list': [{ 'marker-alleles': '11,12' }] }
    ]
  },
  'child-list': [{}, {}],
  'reference-list': [{}, {}, {}]
}

describe('cancer_models / get_cellosaurus_cell_line', () => {
  it('accession mode: fetches the entry and reports identity + quality', async () => {
    const { out, urls } = await run({ cell_line: 'CVCL_0372' }, [
      okJson({ Cellosaurus: { 'cell-line-list': [KB] } })
    ])
    expect(urls[0]).toBe(`${BASE}/cell-line/CVCL_0372?format=json`)
    expect(out).toEqual({
      mode: 'accession',
      cell_line: 'CVCL_0372',
      accession: 'CVCL_0372',
      found: true,
      secondary_accessions: [],
      name: 'KB',
      synonyms: ['HeLa-KB', 'Strain KB'],
      category: 'Cancer cell line',
      age: '',
      sex: 'Female',
      species: [{ id: '9606', label: 'Homo sapiens (Human)' }],
      disease: [{ id: 'C27677', label: 'Endocervical adenocarcinoma' }],
      is_problematic: true,
      problematic_annotations: [
        {
          category: 'Problematic cell line',
          value:
            'Contaminated. Shown to be a HeLa derivative. Originally thought to originate from an epidermal carcinoma of the mouth.'
        }
      ],
      str_profile: { n_markers: 2, conflicting_markers: [{ id: 'D13S317', alleles: '11,12' }] },
      n_children: 2,
      n_references: 3,
      url: 'https://www.cellosaurus.org/CVCL_0372'
    })
  })

  it('normalises a lowercase accession before the request', async () => {
    const { urls } = await run({ cell_line: 'cvcl_0372' }, [
      okJson({ Cellosaurus: { 'cell-line-list': [KB] } })
    ])
    expect(urls[0]).toBe(`${BASE}/cell-line/CVCL_0372?format=json`)
  })

  it('names an unknown accession (found:false) instead of a false empty search', async () => {
    const { out, urls } = await run({ cell_line: 'CVCL_9999' }, [notFound()])
    expect(urls[0]).toBe(`${BASE}/cell-line/CVCL_9999?format=json`)
    expect(out).toEqual({
      mode: 'accession',
      cell_line: 'CVCL_9999',
      accession: 'CVCL_9999',
      found: false
    })
  })

  it('name mode: searches and returns compact rows with the quality flag', async () => {
    const other = {
      'accession-list': [{ type: 'primary', value: 'CVCL_R957' }],
      'name-list': [{ type: 'identifier', value: 'MDA-MB-435-BAG' }],
      category: 'Cancer cell line',
      sex: 'Female',
      'species-list': [
        { accession: '9606', database: 'NCBI_TaxID', label: 'Homo sapiens (Human)' }
      ],
      'disease-list': [{ accession: 'C9335', database: 'NCIt', label: 'Melanoma' }],
      'comment-list': [{ category: 'Problematic cell line', value: 'Misidentified.' }]
    }
    const { out, urls } = await run({ cell_line: 'MDA-MB-435', max_records: 2 }, [
      okJson({ Cellosaurus: { 'cell-line-list': [KB, other] } })
    ])
    expect(urls[0]).toBe(`${BASE}/search/cell-line?q=MDA-MB-435&format=json&rows=2`)
    expect(out).toMatchObject({
      mode: 'search',
      query: 'MDA-MB-435',
      n_returned: 2,
      truncated: true,
      cell_lines: [
        {
          accession: 'CVCL_0372',
          secondary_accessions: [],
          name: 'KB',
          category: 'Cancer cell line',
          species: ['Homo sapiens (Human)'],
          disease: ['Endocervical adenocarcinoma'],
          sex: 'Female',
          is_problematic: true
        },
        {
          accession: 'CVCL_R957',
          name: 'MDA-MB-435-BAG',
          is_problematic: true
        }
      ]
    })
    expect(String(out.note)).toContain('reports no total hit count')
  })

  it('refuses an empty cell_line before the request', async () => {
    await expect(run({ cell_line: '  ' }, [])).rejects.toThrow(/cell_line is required/)
  })

  it('registers the tool under the cancer_models connector', () => {
    expect(tool('get_cellosaurus_cell_line').connector).toBe('cancer_models')
  })
})

// Live self-test against the real Cellosaurus service. Off by default; run with LIVE_API=1.
describe.skipIf(!process.env.LIVE_API)('cancer_models / get_cellosaurus_cell_line (LIVE)', () => {
  it('fetches the real HeLa entry with a quality block', async () => {
    const out = (await new ParserEngine({ timeoutMs: 120_000 }).call(
      tool('get_cellosaurus_cell_line'),
      { cell_line: 'CVCL_0030' },
      {}
    )) as Record<string, unknown>
    expect(out.found).toBe(true)
    expect(out.accession).toBe('CVCL_0030')
    expect((out.str_profile as Record<string, unknown>).n_markers).toBeGreaterThan(0)
  }, 60_000)

  it('searches by name and flags problematic lines', async () => {
    const out = (await new ParserEngine({ timeoutMs: 120_000 }).call(
      tool('get_cellosaurus_cell_line'),
      { cell_line: 'KB', max_records: 5 },
      {}
    )) as Record<string, unknown>
    expect(out.mode).toBe('search')
    expect(Number(out.n_returned)).toBeGreaterThan(0)
    expect(String(out.note)).toContain('no total hit count')
  }, 60_000)
})
