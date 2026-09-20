import { afterEach, describe, expect, it, vi } from 'vitest'

import { ParserEngine } from '../engine'
import { OMICS_ENA_TOOLS } from './omics-ena'

// Two things this file has to prove: the archive's own numbers are passed through as declared values rather
// than presented as verified, and reachability is checked with a HEAD that never reads a file body.

const RUN_ROW = {
  run_accession: 'ERR123456',
  study_accession: 'PRJEB12345',
  sample_accession: 'ERS111111',
  experiment_accession: 'ERX222222',
  scientific_name: 'Homo sapiens',
  library_strategy: 'WGS',
  library_layout: 'PAIRED',
  instrument_platform: 'ILLUMINA',
  instrument_model: 'Illumina NovaSeq 6000',
  read_count: '1000000',
  base_count: '150000000',
  fastq_ftp: 'ftp.sra.ebi.ac.uk/vol1/fastq/ERR123/ERR123456/ERR123456_1.fastq.gz;ftp.sra.ebi.ac.uk/vol1/fastq/ERR123/ERR123456/ERR123456_2.fastq.gz',
  fastq_bytes: '1234;5678',
  fastq_md5: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  first_public: '2024-01-05'
}

const textResponse = (body: string): Response =>
  ({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) }) as unknown as Response

const tool = (id: string): (typeof OMICS_ENA_TOOLS)[number] => {
  const found = OMICS_ENA_TOOLS.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`no tool ${id}`)
  return found
}

const run = (
  id: string,
  args: Record<string, unknown>,
  body: string
): Promise<unknown> =>
  new ParserEngine({
    fetchImpl: (async () => textResponse(body)) as unknown as typeof fetch,
    retries: 0
  }).call(tool(id), args, {})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ena_search_runs', () => {
  it('returns the run metadata with the archive’s declared sizes and digests', async () => {
    const result = (await run(
      'ena_search_runs',
      { query: 'study_accession=PRJEB12345', limit: 10 },
      JSON.stringify([RUN_ROW])
    )) as Record<string, unknown>

    const runs = result.runs as Array<Record<string, unknown>>
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      run_accession: 'ERR123456',
      study_accession: 'PRJEB12345',
      scientific_name: 'Homo sapiens',
      library_layout: 'PAIRED',
      read_count: 1_000_000,
      base_count: 150_000_000
    })
    // ftp hostnames become https URLs, and the parallel arrays stay aligned with them.
    expect(runs[0].fastq_urls).toEqual([
      'https://ftp.sra.ebi.ac.uk/vol1/fastq/ERR123/ERR123456/ERR123456_1.fastq.gz',
      'https://ftp.sra.ebi.ac.uk/vol1/fastq/ERR123/ERR123456/ERR123456_2.fastq.gz'
    ])
    expect(runs[0].declared_bytes).toEqual([1234, 5678])
    expect((runs[0].declared_md5 as string[])[0]).toBe('a'.repeat(32))
  })

  it('calls the declared checksums declared, not verified', async () => {
    const result = (await run('ena_search_runs', { query: 'run_accession=ERR123456' }, JSON.stringify([RUN_ROW]))) as {
      notes: string[]
    }
    expect(result.notes.join(' ')).toContain('不会替你验证')
  })

  it('flags a result that reached the limit rather than presenting it as complete', async () => {
    const rows = Array.from({ length: 3 }, () => RUN_ROW)
    const result = (await run('ena_search_runs', { query: 'tax_eq(9606)', limit: 3 }, JSON.stringify(rows))) as {
      returned: number
      truncated: boolean
      notes: string[]
    }
    expect(result.returned).toBe(3)
    expect(result.truncated).toBe(true)
    expect(result.notes.join(' ')).toContain('可能被截断')
  })

  it('reports an empty answer as empty rather than as an error', async () => {
    const result = (await run('ena_search_runs', { query: 'study_accession=PRJEB0' }, '')) as {
      returned: number
      runs: unknown[]
    }
    expect(result.returned).toBe(0)
    expect(result.runs).toEqual([])
  })
})

describe('ena_run_files', () => {
  const probeOf = (statuses: Record<string, { status: number; length: string }>): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { method?: string }) => {
        const answer = statuses[url] ?? { status: 404, length: '0' }
        return {
          ok: answer.status >= 200 && answer.status < 300,
          status: answer.status,
          headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? answer.length : null) },
          method: init.method
        }
      })
    )
  }

  it('probes each file with HEAD and matches the reported size against the declared one', async () => {
    probeOf({
      'https://ftp.sra.ebi.ac.uk/vol1/fastq/ERR123/ERR123456/ERR123456_1.fastq.gz': { status: 200, length: '1234' },
      'https://ftp.sra.ebi.ac.uk/vol1/fastq/ERR123/ERR123456/ERR123456_2.fastq.gz': { status: 200, length: '5678' }
    })

    const result = (await run('ena_run_files', { run_accession: 'ERR123456' }, JSON.stringify([RUN_ROW]))) as {
      files: Array<Record<string, unknown>>
      all_reachable: boolean
      bytes_match: boolean
      notes: string[]
    }

    expect(result.files).toHaveLength(2)
    expect(result.all_reachable).toBe(true)
    expect(result.bytes_match).toBe(true)
    expect(result.files[0]).toMatchObject({ declared_bytes: 1234, reachable: true, bytes_match_declared: true })
    // The probe must be a HEAD: reading the body would be the download this tool promises not to do.
    const calls = (globalThis.fetch as unknown as { mock: { calls: Array<[string, { method?: string }]> } }).mock.calls
    expect(calls.every(([, init]) => init?.method === 'HEAD')).toBe(true)
  })

  it('says when the server’s size disagrees with the declared one', async () => {
    probeOf({
      'https://ftp.sra.ebi.ac.uk/vol1/fastq/ERR123/ERR123456/ERR123456_1.fastq.gz': { status: 200, length: '9999' },
      'https://ftp.sra.ebi.ac.uk/vol1/fastq/ERR123/ERR123456/ERR123456_2.fastq.gz': { status: 200, length: '5678' }
    })

    const result = (await run('ena_run_files', { run_accession: 'ERR123456' }, JSON.stringify([RUN_ROW]))) as {
      bytes_match: boolean
      notes: string[]
    }

    expect(result.bytes_match).toBe(false)
    expect(result.notes.join(' ')).toContain('Content-Length 与 ENA 声明的字节数不一致')
  })

  it('reports unreachable files instead of promising a download that would fail', async () => {
    probeOf({
      'https://ftp.sra.ebi.ac.uk/vol1/fastq/ERR123/ERR123456/ERR123456_1.fastq.gz': { status: 200, length: '1234' },
      'https://ftp.sra.ebi.ac.uk/vol1/fastq/ERR123/ERR123456/ERR123456_2.fastq.gz': { status: 403, length: '0' }
    })

    const result = (await run('ena_run_files', { run_accession: 'ERR123456' }, JSON.stringify([RUN_ROW]))) as {
      all_reachable: boolean
      notes: string[]
    }

    expect(result.all_reachable).toBe(false)
    expect(result.notes.join(' ')).toContain('当前不可达')
  })

  it('treats a network failure as unreachable rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ETIMEDOUT')
      })
    )
    const result = (await run('ena_run_files', { run_accession: 'ERR123456' }, JSON.stringify([RUN_ROW]))) as {
      files: Array<Record<string, unknown>>
      all_reachable: boolean
    }
    expect(result.all_reachable).toBe(false)
    expect(result.files[0].reachable).toBe(false)
    expect(String(result.files[0].error)).toContain('ETIMEDOUT')
  })

  // verify=false must not be read as "everything is fine": unreachable here means unverified.
  it('marks files as unverified, not unreachable, when the probe was skipped', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const result = (await run(
      'ena_run_files',
      { run_accession: 'ERR123456', verify: false },
      JSON.stringify([RUN_ROW])
    )) as { files: Array<Record<string, unknown>>; notes: string[] }

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.files[0].reachable).toBe(false)
    expect(result.notes.join(' ')).toContain('未核验，非不可达')
  })

  it('fails clearly when the archive does not know the run', async () => {
    await expect(run('ena_run_files', { run_accession: 'ERR999999' }, '[]')).rejects.toThrow(
      /ENA has no run ERR999999/
    )
  })
})
