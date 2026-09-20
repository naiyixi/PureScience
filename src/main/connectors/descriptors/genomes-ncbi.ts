import { createHash } from 'node:crypto'

import type { ToolContext, ToolDescriptor } from '../types'

// NCBI reference sequences and assemblies — with the two facts this repository insists on: what was
// fetched, and what it hashes to.
//
// Three rules shape this file:
//   1. A reference sequence is never returned without its size and its SHA-256. The digest is over the
//      exact bytes that were received, so a caller can re-fetch and compare rather than trust a label.
//   2. An assembly is never assumed. `assembly` is optional but, when given, the returned definition line
//      must actually name it — a request that says GRCh38 and comes back GRCh37 fails closed instead of
//      quietly labelling a GRCh37 sequence as GRCh38. The result always carries the assembly the server
//      itself reported, so a silent default is impossible on this side.
//   3. What was not returned is said out loud: a payload past the character cap is reported as truncated
//      (with its hash and true length still present), because a silently shortened sequence is a wrong
//      sequence.
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi'
const DATASETS = 'https://api.ncbi.nlm.nih.gov/datasets/v2alpha/genome/taxon'

// Beyond this the payload is summarised rather than pasted into a result.
const MAX_SEQUENCE_CHARS = 200_000
const DEFAULT_TAXON = 'human'

type FastaSummary = {
  identifier: string
  defline: string
  length: number
  sha256: string
  bytes: number
  sequence: string
  truncated: boolean
}

const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const summarizeFasta = (text: string): FastaSummary => {
  const trimmed = text.trim()
  const newline = trimmed.indexOf('\n')
  const defline = (newline === -1 ? trimmed : trimmed.slice(0, newline)).replace(/^>/, '').trim()
  const sequence = (newline === -1 ? '' : trimmed.slice(newline + 1)).replace(/\s+/g, '')
  const truncated = sequence.length > MAX_SEQUENCE_CHARS
  return {
    identifier: defline.split(/\s+/)[0] ?? '',
    defline,
    length: sequence.length,
    sha256: sha256Hex(trimmed),
    bytes: Buffer.byteLength(trimmed, 'utf8'),
    sequence: truncated ? sequence.slice(0, MAX_SEQUENCE_CHARS) : sequence,
    truncated
  }
}

// The assembly as the definition line names it. Chromosome records spell it out bare
// ("Homo sapiens chromosome 7, GRCh38.p14 Primary Assembly"); some records wrap it in parentheses. Both
// are read, and a definition line that names no assembly yields undefined — which is why an assertion
// against such a record fails rather than passing on the benefit of the doubt.
const assemblyOf = (defline: string): string | undefined => {
  const parenthesised = defline.match(/\((GRCh\d+(?:\.p\d+)?[^)]*)\)/i)
  if (parenthesised) return parenthesised[1].trim()
  const bare = defline.match(/GRCh\d+(?:\.p\d+)?/i)
  return bare ? bare[0] : undefined
}

const assertAssembly = (summary: FastaSummary, expected: unknown): void => {
  if (expected === undefined || expected === '') return
  const wanted = String(expected).trim().toLowerCase()
  const actual = assemblyOf(summary.defline)
  const haystack = `${summary.defline} ${actual ?? ''}`.toLowerCase()
  if (!haystack.includes(wanted)) {
    throw new Error(
      `The requested assembly ${String(expected)} does not match what NCBI returned (${actual ?? 'no assembly named in the definition line'}): ${summary.defline}. Refusing rather than labelling a sequence with an assembly it was not fetched from.`
    )
  }
}

const fetchFasta = async (
  ctx: ToolContext,
  params: { accession: string; db: string; start?: number; stop?: number }
): Promise<FastaSummary> => {
  const query = new URLSearchParams({
    db: params.db,
    id: params.accession,
    rettype: 'fasta',
    retmode: 'text',
    ...(params.start === undefined ? {} : { seq_start: String(params.start) }),
    ...(params.stop === undefined ? {} : { seq_stop: String(params.stop) })
  })
  const text = await ctx.fetchText(`${EUTILS}?${query.toString()}`)
  if (text.trim() === '' || !text.includes('>')) {
    throw new Error(
      `NCBI returned no FASTA for ${params.accession} (db=${params.db}${params.start === undefined ? '' : `, ${String(params.start)}-${String(params.stop)}`}).`
    )
  }
  return summarizeFasta(text)
}

export const GENOMES_NCBI_TOOLS: ToolDescriptor[] = [
  {
    id: 'ncbi_reference_sequence',
    connector: 'genomes',
    description:
      'Fetch a reference sequence from NCBI (RefSeq/GenBank accessions: NC_000007.14, NM_000546.6, NP_000537.3, CM000663.2 ...) and return it with its size and SHA-256 over the exact bytes received. Pass `assembly` (e.g. "GRCh38" or "GRCh37") to assert which assembly the accession is supposed to belong to: if the definition line NCBI returns does not name it, the call fails instead of labelling a sequence with an assembly it did not come from. `db` defaults to nuccore; use `protein` for protein accessions. Sequences beyond 200k bases are summarised: length, sha256 and bytes are still the full payload\u2019s, `truncated` is true, and the sequence itself is cut — a shortened sequence is never presented as the whole one.',
    input: {
      type: 'object',
      properties: {
        accession: { type: 'string', description: 'RefSeq/GenBank accession, e.g. NC_000007.14.' },
        assembly: {
          type: 'string',
          description: 'Optional assertion, e.g. "GRCh38" — mismatches fail closed.'
        },
        db: { type: 'string', description: 'nuccore (default) or protein.' },
        max_chars: { type: 'number', description: 'Override the 200000-character summary cap.' }
      },
      required: ['accession']
    },
    returns:
      '{accession_requested, identifier, defline, assembly (as the defline names it, when it does), length_bases, sha256, bytes, sequence, truncated}.',
    example:
      'const result = await host.mcp("genomes", "ncbi_reference_sequence", {"accession": "NM_000546.6", "assembly": "GRCh38"})',
    run: async (ctx: ToolContext, a: Record<string, unknown>) => {
      const accession = String(a.accession ?? '').trim()
      if (accession === '') throw new Error('ncbi_reference_sequence needs an accession.')
      const summary = await fetchFasta(ctx, { accession, db: String(a.db ?? 'nuccore') })
      assertAssembly(summary, a.assembly)
      const assembly = assemblyOf(summary.defline)
      return {
        accession_requested: accession,
        identifier: summary.identifier,
        defline: summary.defline,
        ...(assembly === undefined ? {} : { assembly }),
        length_bases: summary.length,
        sha256: summary.sha256,
        bytes: summary.bytes,
        sequence: summary.sequence,
        truncated: summary.truncated
      }
    }
  },
  {
    id: 'ncbi_reference_region',
    connector: 'genomes',
    description:
      'Fetch one region of a reference sequence by 1-based coordinates (seq_start/seq_stop), e.g. a chromosome window, and return it with its size and SHA-256. Because a coordinate only means something against a specific assembly, pass `assembly` ("GRCh38", "GRCh37", …) whenever the coordinates came from a paper or a genome browser: the definition line must name it or the call fails. Note that the accession itself pins the assembly (NC_000007.14 is GRCh38 chromosome 7, NC_000007.13 is GRCh37), so the assertion is what keeps a GRCh37 coordinate from being read against GRCh38.',
    input: {
      type: 'object',
      properties: {
        accession: { type: 'string', description: 'Chromosome/reference accession, e.g. NC_000007.14.' },
        start: { type: 'number', description: '1-based inclusive start.' },
        stop: { type: 'number', description: '1-based inclusive stop.' },
        assembly: { type: 'string', description: 'Optional assertion; mismatches fail closed.' },
        db: { type: 'string', description: 'nuccore (default).' }
      },
      required: ['accession', 'start', 'stop']
    },
    returns:
      '{accession_requested, start, stop, defline, assembly (when the defline names it), length_bases (the region\u2019s own length), sha256, bytes, sequence, truncated}.',
    example:
      'const result = await host.mcp("genomes", "ncbi_reference_region", {"accession": "NC_000007.14", "start": 117199500, "stop": 117200000, "assembly": "GRCh38"})',
    run: async (ctx: ToolContext, a: Record<string, unknown>) => {
      const accession = String(a.accession ?? '').trim()
      const start = Number(a.start)
      const stop = Number(a.stop)
      if (accession === '') throw new Error('ncbi_reference_region needs an accession.')
      if (!Number.isInteger(start) || !Number.isInteger(stop) || start < 1 || stop < start) {
        throw new Error('ncbi_reference_region needs 1-based coordinates with start <= stop.')
      }
      const region = await fetchFasta(ctx, {
        accession,
        db: String(a.db ?? 'nuccore'),
        start,
        stop
      })
      assertAssembly(region, a.assembly)
      const assembly = assemblyOf(region.defline)
      return {
        accession_requested: accession,
        start,
        stop,
        defline: region.defline,
        ...(assembly === undefined ? {} : { assembly }),
        length_bases: region.length,
        sha256: region.sha256,
        bytes: region.bytes,
        sequence: region.sequence,
        truncated: region.truncated
      }
    }
  },
  {
    id: 'ncbi_list_assemblies',
    connector: 'genomes',
    description:
      'List the assemblies NCBI holds for a taxon (default human), so an assembly is chosen rather than assumed: each row carries its accession, assembly name (GRCh38.p14, GRCh37.p13, T2T-CHM13v2.0 …), assembly level and whether it is the reference one. Use the assembly_name/accession from here as the explicit choice for the other reference tools; nothing in this connector defaults to GRCh37 or GRCh38 on your behalf.',
    input: {
      type: 'object',
      properties: {
        taxon: { type: 'string', description: 'Taxon name or id, default "human".' },
        limit: { type: 'number', description: 'Rows to return, default 20.' }
      }
    },
    returns:
      '{taxon, total_reported, assemblies:[{accession, assembly_name, assembly_level, is_reference, submission_date, organism}], truncated}.',
    example:
      'const result = await host.mcp("genomes", "ncbi_list_assemblies", {"taxon": "human", "limit": 10})',
    run: async (ctx: ToolContext, a: Record<string, unknown>) => {
      const taxon = String(a.taxon ?? DEFAULT_TAXON).trim() || DEFAULT_TAXON
      const limit = Number.isFinite(Number(a.limit)) && Number(a.limit) > 0 ? Number(a.limit) : 20
      const raw = (await ctx.fetchJson(
        `${DATASETS}/${encodeURIComponent(taxon)}/dataset_report?page_size=${String(Math.min(limit, 100))}`
      )) as {
        reports?: Array<{
          accession?: string
          assembly_info?: {
            assembly_name?: string
            assembly_level?: string
            refseq_category?: string
            submission_date?: string
          }
          organism?: { organism_name?: string }
        }>
        total_count?: number
      }
      const reports = Array.isArray(raw.reports) ? raw.reports : []
      const assemblies = reports.slice(0, limit).map((report) => ({
        accession: report.accession ?? '',
        assembly_name: report.assembly_info?.assembly_name ?? '',
        assembly_level: report.assembly_info?.assembly_level ?? '',
        is_reference: (report.assembly_info?.refseq_category ?? '') === 'reference genome',
        submission_date: report.assembly_info?.submission_date ?? '',
        organism: report.organism?.organism_name ?? ''
      }))
      const total = typeof raw.total_count === 'number' ? raw.total_count : reports.length
      return {
        taxon,
        total_reported: total,
        assemblies,
        truncated: total > assemblies.length
      }
    }
  }
]
