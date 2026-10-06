import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { OMICS_ARCHIVES_TOOLS } from './omics-archives'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => OMICS_ARCHIVES_TOOLS.find((t) => t.id === id)!

const jsonRes = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    headers: { get: () => null }
  }) as unknown as Response
const textRes = (body: string): Response =>
  ({
    ok: true,
    status: 200,
    text: async () => body,
    headers: { get: () => null }
  }) as unknown as Response
const errRes = (status: number): Response =>
  ({ ok: false, status, headers: { get: () => null } }) as unknown as Response
const engine = (fetchImpl: typeof fetch): ParserEngine =>
  new ParserEngine({ fetchImpl, retries: 0 })

type MwbOut = {
  input: string
  value: string
  count: number
  returned: number
  truncated: boolean
  studies: Array<{ study_id?: string; study_title?: string }>
}
type GeoFile = {
  role: string
  declared_size: string
  declared_size_bytes_approx: number
  url: string
}
type GeoOut = {
  downloaded: boolean
  size_source: string
  n_found: number
  invalid: Array<{ accession: string; reason: string }>
  errors: Array<{ accession: string; error: string }>
  records: Array<{
    accession: string
    ftp_dir: string
    matrix: { present: boolean; n_files: number; files: GeoFile[] }
    supplementary: { present: boolean; n_files: number; files: Array<{ role: string }> }
    total_declared_bytes_approx: number
  }>
}

// ---- Metabolomics Workbench ------------------------------------------------------------------

describe('metabolomics_workbench_search_studies', () => {
  it('repacks the index-keyed object in numeric order and surfaces the applied filter', async () => {
    const payload = {
      '1': {
        study_id: 'ST000001',
        study_title: 'A',
        species: 'Arabidopsis thaliana',
        study_url: 'https://x/1'
      },
      '2': {
        study_id: 'ST000002',
        study_title: 'B',
        species: 'Homo sapiens',
        study_url: 'https://x/2'
      }
    }
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(payload))
    const out = (await engine(fetchImpl).call(
      tool('metabolomics_workbench_search_studies'),
      { input: 'study_title', value: 'cancer' },
      {}
    )) as MwbOut

    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toBe('https://www.metabolomicsworkbench.org/rest/study/study_title/cancer/summary')
    expect(out.input).toBe('study_title')
    expect(out.value).toBe('cancer')
    expect(out.count).toBe(2)
    expect(out.returned).toBe(2)
    expect(out.truncated).toBe(false)
    expect(out.studies[0].study_id).toBe('ST000001')
  })

  it('caps returned rows and flags truncation (3 rows, limit 1 => 2 truncated)', async () => {
    const payload = { '1': { study_id: 'ST1' }, '2': { study_id: 'ST2' }, '3': { study_id: 'ST3' } }
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(payload))
    const out = (await engine(fetchImpl).call(
      tool('metabolomics_workbench_search_studies'),
      { input: 'institute', value: 'UC Davis', limit: 1 },
      {}
    )) as MwbOut
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/institute/UC%20Davis/summary')
    expect(out.count).toBe(3)
    expect(out.returned).toBe(1)
    expect(out.truncated).toBe(true)
  })

  it('handles a single study object for a study_id lookup and empty array answers', async () => {
    const single = { study_id: 'ST000001', study_title: 'Fatb', species: 'Arabidopsis thaliana' }
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(single))
    const out = (await engine(fetchImpl).call(
      tool('metabolomics_workbench_search_studies'),
      { input: 'study_id', value: 'ST000001' },
      {}
    )) as MwbOut
    expect(out.count).toBe(1)
    expect(out.studies[0].study_title).toBe('Fatb')

    const empty = vi.fn().mockResolvedValue(jsonRes([]))
    const out2 = (await engine(empty).call(
      tool('metabolomics_workbench_search_studies'),
      { input: 'last_name', value: 'Nobody' },
      {}
    )) as MwbOut
    expect(out2.count).toBe(0)
    expect(out2.studies).toEqual([])
  })

  it('rejects an unknown input field by name with the valid list', async () => {
    const fetchImpl = vi.fn()
    await expect(
      engine(fetchImpl).call(
        tool('metabolomics_workbench_search_studies'),
        { input: 'bogus', value: 'x' },
        {}
      )
    ).rejects.toThrow(/unknown Metabolomics Workbench input 'bogus'/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// ---- GEO matrix discovery --------------------------------------------------------------------

const MATRIX_HTML = `<pre>
<a href="/geo/series/GSE131nnn/">Parent Directory</a>                             -   
<a href="GSE131907_series_matrix.txt.gz">GSE131907_series_matrix.txt.gz</a>   2026-09-25 01:01  6.2K  
</pre>`
const SUPPL_HTML = `<pre>
<a href="/geo/series/GSE131nnn/">Parent Directory</a>                                                             -   
<a href="GSE131907_Lung_Cancer_Feature_Summary.xlsx">GSE131907_Lung_Cancer_Feature_Summary.xlsx</a>             2021-01-18 22:37   19K  
<a href="GSE131907_Lung_Cancer_normalized_log2TPM_matrix.txt.gz">GSE131907_Lung_Cancer_normalized_log2TPM_matrix.txt.gz</a> 2019-05-29 12:17  2.9G  
<a href="GSE131907_RAW.tar">GSE131907_RAW.tar</a> 2020-01-01 00:00 10M  
</pre>`

const geoFetch = (url: string): Response =>
  url.includes('/matrix/')
    ? textRes(MATRIX_HTML)
    : url.includes('/suppl/')
      ? textRes(SUPPL_HTML)
      : errRes(404)

describe('geo_discover_matrix_files', () => {
  it('derives the GSEnnn FTP path, parses both directories and reports declared sizes without downloading', async () => {
    const fetchImpl = vi.fn(async (url: string) => geoFetch(url))
    const out = (await engine(fetchImpl as unknown as typeof fetch).call(
      tool('geo_discover_matrix_files'),
      { accessions: ['GSE131907'] },
      {}
    )) as GeoOut

    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE131nnn/GSE131907/matrix/'
    )
    expect(out.downloaded).toBe(false)
    expect(out.size_source).toBe('ftp_directory_index')
    expect(out.n_found).toBe(1)
    const rec = out.records[0]
    expect(rec.ftp_dir).toBe('https://ftp.ncbi.nlm.nih.gov/geo/series/GSE131nnn/GSE131907')
    expect(rec.matrix.present).toBe(true)
    expect(rec.matrix.n_files).toBe(1)
    expect(rec.matrix.files[0].role).toBe('series_matrix')
    expect(rec.matrix.files[0].declared_size).toBe('6.2K')
    expect(rec.matrix.files[0].declared_size_bytes_approx).toBe(6349)
    expect(rec.matrix.files[0].url).toBe(
      'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE131nnn/GSE131907/matrix/GSE131907_series_matrix.txt.gz'
    )
    expect(rec.supplementary.present).toBe(true)
    expect(rec.supplementary.n_files).toBe(3)
    expect(rec.supplementary.files.map((f) => f.role)).toEqual([
      'document',
      'processed_matrix',
      'raw_data_archive'
    ])
    // 6.2K + 19K + 2.9G + 10M (K=1024): 6349 + 19456 + 3113851290 + 10485760
    expect(rec.total_declared_bytes_approx).toBe(3124362855)
  })

  it('records malformed accessions by name (with position) and keeps processing the valid ones', async () => {
    const fetchImpl = vi.fn(async (url: string) => geoFetch(url))
    const out = (await engine(fetchImpl as unknown as typeof fetch).call(
      tool('geo_discover_matrix_files'),
      { accessions: ['GSE12A', 'foo', 'GSE131907'] },
      {}
    )) as GeoOut

    expect(out.invalid.length).toBe(2)
    expect(out.invalid[0].accession).toBe('GSE12A')
    expect(out.invalid[0].reason).toContain('"A" at position 6')
    expect(out.invalid[1].reason).toContain('"GSE" prefix')
    expect(out.n_found).toBe(1)
    expect(out.records[0].accession).toBe('GSE131907')
  })

  it('reports an absent directory as present:false rather than failing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errRes(404))
    const out = (await engine(fetchImpl).call(
      tool('geo_discover_matrix_files'),
      { accessions: ['GSE131907'] },
      {}
    )) as GeoOut
    expect(out.records[0].matrix).toEqual({ present: false, n_files: 0, files: [] })
    expect(out.records[0].supplementary.present).toBe(false)
    expect(out.errors).toEqual([])
  })

  it('names a per-accession failure and continues', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errRes(500))
    const out = (await engine(fetchImpl).call(
      tool('geo_discover_matrix_files'),
      { accessions: ['GSE131907'] },
      {}
    )) as GeoOut
    expect(out.n_found).toBe(0)
    expect(out.errors.length).toBe(1)
    expect(out.errors[0].accession).toBe('GSE131907')
    expect(out.errors[0].error).toContain('HTTP 500')
  })
})
