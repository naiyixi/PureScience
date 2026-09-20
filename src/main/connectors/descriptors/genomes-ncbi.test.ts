import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { ParserEngine } from '../engine'
import { GENOMES_NCBI_TOOLS } from './genomes-ncbi'

// What this file has to prove: a reference sequence comes back with a digest a caller can re-verify, and an
// assembly assertion is a refusal mechanism rather than a label. The digest is checked against an
// independently computed SHA-256 of the same text, and the mismatch case is checked to throw.

const FASTA_GRCH38 =
  '>NC_000007.14 Homo sapiens chromosome 7, GRCh38.p14 Primary Assembly\n' +
  'NNNNACGTACGTACGTACGTACGT\nACGTACGTNNNN\n'
const FASTA_GRCH37 =
  '>NC_000007.13 Homo sapiens chromosome 7, GRCh37.p13 Primary Assembly\nACGTACGT\n'

const textResponse = (body: string): Response =>
  ({ ok: true, status: 200, text: async () => body, json: async () => ({}) }) as unknown as Response

const jsonResponse = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response

const tool = (id: string): (typeof GENOMES_NCBI_TOOLS)[number] => {
  const found = GENOMES_NCBI_TOOLS.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`no tool ${id}`)
  return found
}

const run = (
  id: string,
  args: Record<string, unknown>,
  fetchImpl: ReturnType<typeof vi.fn>
): Promise<unknown> =>
  new ParserEngine({ fetchImpl: fetchImpl as unknown as typeof fetch, retries: 0 }).call(
    tool(id),
    args,
    {}
  )

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

describe('ncbi_reference_sequence', () => {
  it('returns the sequence with a digest that matches an independent computation', async () => {
    const fetchImpl = vi.fn(async () => textResponse(FASTA_GRCH38))
    const result = (await run('ncbi_reference_sequence', { accession: 'NC_000007.14' }, fetchImpl)) as Record<
      string,
      unknown
    >

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url] = fetchImpl.mock.calls[0] as unknown as [string]
    expect(url).toContain('efetch')
    expect(url).toContain('db=nuccore')
    expect(url).toContain('id=NC_000007.14')

    // Whitespace inside the FASTA is not part of the sequence, but it is part of the bytes we received —
    // the digest is over what arrived, which is what a re-fetch can compare against.
    expect(result.sha256).toBe(sha256(FASTA_GRCH38.trim()))
    expect(result.bytes).toBe(Buffer.byteLength(FASTA_GRCH38.trim(), 'utf8'))
    // 24 + 12 bases across the two lines.
    expect(result.length_bases).toBe(36)
    expect(result.sequence).toBe('NNNNACGTACGTACGTACGTACGTACGTACGTNNNN')
    expect(result.truncated).toBe(false)
    expect(result.assembly).toContain('GRCh38')
  })

  it('accepts an assembly assertion that the definition line agrees with', async () => {
    const fetchImpl = vi.fn(async () => textResponse(FASTA_GRCH38))
    const result = (await run(
      'ncbi_reference_sequence',
      { accession: 'NC_000007.14', assembly: 'GRCh38' },
      fetchImpl
    )) as Record<string, unknown>
    expect(result.assembly).toContain('GRCh38.p14')
  })

  // The assertion exists so that a GRCh37 sequence can never be handed back as GRCh38.
  it('refuses when the assembly the caller named is not what came back', async () => {
    const fetchImpl = vi.fn(async () => textResponse(FASTA_GRCH37))
    await expect(
      run('ncbi_reference_sequence', { accession: 'NC_000007.13', assembly: 'GRCh38' }, fetchImpl)
    ).rejects.toThrow(/does not match what NCBI returned/)
  })

  it('summarises a payload past the cap instead of presenting part of it as the whole', async () => {
    const long = `>NC_999999.1 long\n${'A'.repeat(300_000)}`
    const fetchImpl = vi.fn(async () => textResponse(long))
    const result = (await run('ncbi_reference_sequence', { accession: 'NC_999999.1' }, fetchImpl)) as Record<
      string,
      unknown
    >

    expect(result.truncated).toBe(true)
    expect(result.length_bases).toBe(300_000)
    expect(String(result.sequence).length).toBe(200_000)
    expect(result.sha256).toBe(sha256(long.trim()))
  })

  it('reports an empty answer rather than inventing a sequence', async () => {
    const fetchImpl = vi.fn(async () => textResponse(''))
    await expect(run('ncbi_reference_sequence', { accession: 'NOPE' }, fetchImpl)).rejects.toThrow(
      /returned no FASTA/
    )
  })
})

describe('ncbi_reference_region', () => {
  it('asks for the region and carries its coordinates into the result', async () => {
    const fetchImpl = vi.fn(async () => textResponse(FASTA_GRCH38))
    const result = (await run(
      'ncbi_reference_region',
      { accession: 'NC_000007.14', start: 117_199_500, stop: 117_200_000, assembly: 'GRCh38' },
      fetchImpl
    )) as Record<string, unknown>

    const [url] = fetchImpl.mock.calls[0] as unknown as [string]
    expect(url).toContain('seq_start=117199500')
    expect(url).toContain('seq_stop=117200000')
    expect(result).toMatchObject({ start: 117_199_500, stop: 117_200_000 })
    expect(result.assembly).toContain('GRCh38')
  })

  it('rejects coordinates that are not 1-based and ordered', async () => {
    const fetchImpl = vi.fn(async () => textResponse(FASTA_GRCH38))
    await expect(
      run('ncbi_reference_region', { accession: 'NC_000007.14', start: 0, stop: 10 }, fetchImpl)
    ).rejects.toThrow(/1-based coordinates/)
    await expect(
      run('ncbi_reference_region', { accession: 'NC_000007.14', start: 10, stop: 5 }, fetchImpl)
    ).rejects.toThrow(/start <= stop/)
  })
})

describe('ncbi_list_assemblies', () => {
  it('reports the assemblies a caller can then choose between explicitly', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        total_count: 3,
        reports: [
          {
            accession: 'GCF_000001405.40',
            assembly_info: {
              assembly_name: 'GRCh38.p14',
              assembly_level: 'Chromosome',
              refseq_category: 'reference genome',
              submission_date: '2022-02-03'
            },
            organism: { organism_name: 'Homo sapiens' }
          },
          {
            accession: 'GCF_000001405.25',
            assembly_info: { assembly_name: 'GRCh37.p13', assembly_level: 'Chromosome' },
            organism: { organism_name: 'Homo sapiens' }
          }
        ]
      })
    )

    const result = (await run('ncbi_list_assemblies', { taxon: 'human', limit: 5 }, fetchImpl)) as {
      assemblies: Array<Record<string, unknown>>
      total_reported: number
      truncated: boolean
    }

    expect(result.total_reported).toBe(3)
    expect(result.assemblies).toHaveLength(2)
    expect(result.assemblies[0]).toMatchObject({
      accession: 'GCF_000001405.40',
      assembly_name: 'GRCh38.p14',
      is_reference: true
    })
    expect(result.assemblies[1]).toMatchObject({ assembly_name: 'GRCh37.p13', is_reference: false })
    // The point of the tool: nothing here picks an assembly for the caller.
    expect(result.truncated).toBe(true)
  })
})
