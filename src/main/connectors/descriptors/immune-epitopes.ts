// IEDB (Immune Epitope Database) — curated, published immune-epitope evidence.
//
// Protocol proven against the live service before this file was written (2026-10-08):
//   GET https://query-api.iedb.org/epitope_search?linear_sequence=eq.VTGPVAQLY&limit=3   -> 200, 1 row
//   GET …/tcell_search?structure_iri=eq.IEDB_EPITOPE:31803&limit=3&order=tcell_id.asc    -> 200, 3 rows,
//        every row's linear_sequence equal to the sequence of the epitope we filtered by (the filter IS
//        applied — verified with our own input, not assumed from the docs)
//   GET …/epitope_search?limit=1&offset=5            -> 400 "offset parameter without an order parameter"
//   GET …/epitope_search?nonexistent_col=eq.x&limit=1 -> 400 {"code":"42703"} column … does not exist
// Consequences baked into this descriptor:
//   * `order` is ALWAYS sent (the service refuses offset-paging without it), and only columns verified
//     against the live service are ever used as filters, so a rejected query can never masquerade as
//     "no evidence" — a 4xx makes the call FAIL (it does not come back as an empty result).
//   * The API returns a bare JSON array with NO total, so the tool asks for `max_rows + 1` and reports
//     `truncated` from whether that extra row existed — a real reading, not a guess.
//   * Service text fields carry HTML (`…<br/><strong>Positive</strong>`) — it is normalised here, and
//     the tool says so, instead of passing tags through as if they were content.
import type { ToolDescriptor } from '../types'

const BASE = 'https://query-api.iedb.org'

// The one-letter protein alphabet IEDB curates, plus the ambiguity codes its sequences use. Anything
// else is REFUSED BY NAME before a request is sent: sending a bad sequence and getting "no rows" reads
// as "your data is not in the database", which is a false statement about the user's input.
const PROTEIN_ALPHABET = new Set('ACDEFGHIKLMNPQRSTVWYBJOUXZ'.split(''))
const MAX_EPITOPE_LENGTH = 200

type NormalisedSequence = {
  sequence: string
  stripped_header_lines: number
  stripped_whitespace: number
}

const normaliseSequence = (raw: unknown): NormalisedSequence => {
  const text = String(raw ?? '')
  const lines = text.split(/\r?\n/)
  const headerLines = lines.filter((line) => line.trimStart().startsWith('>')).length
  const body = lines
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('')
    .replace(/\s+/g, '')
  const sequence = body.toUpperCase()
  if (sequence.length === 0) {
    throw new Error(
      'sequence is empty after removing whitespace and FASTA header lines; pass the peptide sequence itself.'
    )
  }
  if (sequence.length > MAX_EPITOPE_LENGTH) {
    throw new Error(
      `sequence is ${sequence.length} residues long, which is past this tool's ${MAX_EPITOPE_LENGTH}-residue limit for curated epitopes; search the structure databases for a whole protein instead.`
    )
  }
  for (let i = 0; i < sequence.length; i += 1) {
    if (!PROTEIN_ALPHABET.has(sequence[i]!)) {
      throw new Error(
        `sequence position ${i + 1} is "${sequence[i]}", which is not a one-letter amino-acid code (or an ambiguity code B/J/O/U/X/Z); this looks like a nucleotide or a framed-off sequence, so nothing was sent to IEDB.`
      )
    }
  }
  return {
    sequence,
    stripped_header_lines: headerLines,
    stripped_whitespace: text.length - body.length
  }
}

// IEDB returns curated prose with markup in it (`multimer/tetramer<br/>qualitative binding<br/><strong>Positive</strong>`).
const plain = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  const text = String(value)
    .replace(/<br\s*\/?>/gi, ' · ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 0 ? text : null
}

const list = (value: unknown): string[] => {
  if (value === null || value === undefined) return []
  const items = Array.isArray(value) ? value : [value]
  return items.map((item) => plain(item)).filter((item): item is string => item !== null)
}

const int = (value: unknown): number | null => {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

const maxRowsOf = (value: unknown, fallback: number, ceiling: number): number => {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > ceiling) {
    throw new Error(`max_rows must be an integer between 1 and ${ceiling} (got ${String(value)}).`)
  }
  return n
}

// One filter builder for both tools: only columns verified against the live service are accepted, and the
// value is percent-encoded so a sequence/IRI with punctuation cannot change the query's shape.
const filterFor = (column: string, value: string): string =>
  `${column}=eq.${encodeURIComponent(value)}`

const stripEmpty = (entries: Array<[string, unknown]>): string[] =>
  entries
    .filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0
    )
    .map(([key, value]) => `${key}=${value}`)

const EPITOPE_FIELDS = [
  'structure_id',
  'structure_iri',
  'structure_descriptions',
  'structure_type',
  'linear_sequence',
  'linear_sequence_length',
  'e_modification',
  'curated_source_antigens',
  'host_organism_names',
  'source_organism_names',
  'mhc_allele_names',
  'disease_names',
  'iedb_assay_ids',
  'iedb_assay_iris',
  'assay_names',
  'qualitative_measures',
  'reference_ids',
  'reference_iris'
].join(',')

// The columns are PER FAMILY, verified against the live service's own responses (86 columns on
// `tcell_search`, 85 on `bcell_search`): `tcell_search` alone has tcell_id / tcell_iri / mhc_restriction,
// `bcell_search` alone has bcell_id / bcell_iri. The service REJECTS the whole request with 42703 for a
// column that belongs to the other family ("column tcell_search.bcell_id does not exist",
// "column bcell_search.mhc_restriction does not exist") rather than ignoring it — both of those were
// caught by the live probe, not by the mocked request-shape tests.
const assayFieldsFor = (kind: 'tcell' | 'bcell'): string =>
  [
    kind === 'tcell' ? 'tcell_id' : 'bcell_id',
    kind === 'tcell' ? 'tcell_iri' : 'bcell_iri',
    'structure_id',
    'structure_iri',
    'linear_sequence',
    'structure_type',
    'curated_source_antigen',
    'reference_id',
    'reference_iri',
    'reference_type',
    'pubmed_id',
    'reference_authors',
    'reference_titles',
    'journal_name',
    'reference_dates',
    'assay_description',
    'immunization_description',
    'antigen_description',
    // MHC restriction is a T-cell concept; B-cell rows have no such column at all.
    ...(kind === 'tcell' ? ['mhc_restriction'] : []),
    'mhc_class',
    'mhc_allele_resolution',
    'mhc_allele_evidence',
    'qualitative_measure',
    'antibody_isotype',
    'direct_ex_vivo_bool'
  ].join(',')

const EPITOPE_ABSENCE_NOTE =
  'No curated epitope evidence matched this exact query. This is NOT evidence of absence: IEDB holds ' +
  'assays that were published and curated, so an unreported, unpublished or differently-annotated ' +
  'epitope has no row here — narrow the query (or drop a filter) before concluding anything from it.'

const noAssayNote = (kindsWithoutRows: string[]): string =>
  kindsWithoutRows.length === 0
    ? ''
    : `No curated ${kindsWithoutRows.join(' or ')} assay evidence matched this exact query. This is NOT ` +
      'evidence of absence (see the tools description): it says nothing about whether a response exists.'

const mapEpitopeRow = (raw: unknown): Record<string, unknown> => {
  const row = asRecord(raw)
  const antigens = (
    Array.isArray(row.curated_source_antigens) ? row.curated_source_antigens : []
  ).map((entry) => {
    const a = asRecord(entry)
    return {
      accession: plain(a.accession),
      name: plain(a.name),
      iri: plain(a.iri)
    }
  })
  return {
    epitope_id: int(row.structure_id),
    epitope_iri: plain(row.structure_iri),
    sequence: plain(row.linear_sequence),
    structure_type: plain(row.structure_type),
    sequence_length: int(row.linear_sequence_length),
    modified_residue: plain(row.e_modification),
    source_antigens: antigens,
    host_organisms: list(row.host_organism_names),
    source_organisms: list(row.source_organism_names),
    mhc_alleles: list(row.mhc_allele_names),
    diseases: list(row.disease_names),
    assay_iris: list(row.iedb_assay_iris),
    assay_names: list(row.assay_names),
    qualitative_measures: list(row.qualitative_measures),
    reference_iris: list(row.reference_iris)
  }
}

const mapAssayRow = (raw: unknown, kind: 'tcell' | 'bcell'): Record<string, unknown> => {
  const row = asRecord(raw)
  const pubmed = int(row.pubmed_id)
  return {
    kind,
    assay_id: int(kind === 'tcell' ? row.tcell_id : row.bcell_id),
    assay_iri: plain(kind === 'tcell' ? row.tcell_iri : row.bcell_iri),
    epitope_iri: plain(row.structure_iri),
    epitope_id: int(row.structure_id),
    sequence: plain(row.linear_sequence),
    structure_type: plain(row.structure_type),
    source_antigen: plain(row.curated_source_antigen),
    // The evidence a reader needs to judge the claim: how it was measured, in what context, and where it
    // was published. Markup is stripped and said to be stripped.
    method: plain(row.assay_description),
    qualitative_measure: plain(row.qualitative_measure),
    mhc: {
      class: plain(row.mhc_class),
      restriction: plain(row.mhc_restriction),
      allele_resolution: plain(row.mhc_allele_resolution),
      allele_evidence: plain(row.mhc_allele_evidence)
    },
    immunization: plain(row.immunization_description),
    antigen_description: plain(row.antigen_description),
    antibody_isotype: plain(row.antibody_isotype),
    direct_ex_vivo:
      row.direct_ex_vivo_bool === null || row.direct_ex_vivo_bool === undefined
        ? null
        : Number(row.direct_ex_vivo_bool) === 1,
    citation: {
      pubmed_id: pubmed,
      pubmed_url: pubmed === null ? null : `https://pubmed.ncbi.nlm.nih.gov/${pubmed}/`,
      reference_iri: plain(row.reference_iri),
      reference_type: plain(row.reference_type),
      journal: plain(row.journal_name),
      dates: plain(row.reference_dates),
      title: plain(row.reference_titles),
      authors: plain(row.reference_authors)
    }
  }
}

// `limit + 1` is what makes `truncated` a reading rather than a guess — the API reports no total.
const PAGE_ORDER = {
  epitope: 'structure_id.asc',
  tcell: 'tcell_id.asc',
  bcell: 'bcell_id.asc'
} as const

export const IMMUNE_EPITOPES_TOOLS: ToolDescriptor[] = [
  {
    id: 'iedb_search_epitopes',
    connector: 'immune_epitopes',
    description:
      'Search IEDB (Immune Epitope Database) for CURATED, PUBLISHED epitope evidence — which peptide ' +
      'was measured, against which source antigen and host, with which MHC alleles, and under which ' +
      'assay IRIs and references. Give a peptide sequence (FASTA headers, line breaks and lowercase are ' +
      'all accepted; anything that is not a one-letter amino-acid code is refused by name before a ' +
      'request is sent) or an IEDB epitope IRI (IEDB_EPITOPE:n) exactly as another row reported it. ' +
      'A query that matches nothing is reported as "no curated evidence found", which is NOT the same ' +
      'statement as "no immune response". Assay-level detail (method, host, PubMed citation) comes from ' +
      'iedb_search_assays; this tool is the epitope inventory.',
    input: {
      type: 'object',
      properties: {
        sequence: {
          type: 'string',
          description:
            "Peptide sequence in one-letter code (FASTA headers and line breaks are tolerated). Exact match against IEDB's curated epitopes."
        },
        structure_iri: {
          type: 'string',
          description:
            'IEDB epitope IRI as reported elsewhere, e.g. "IEDB_EPITOPE:31803". Mutually exclusive with sequence.'
        },
        max_rows: {
          type: 'number',
          description:
            'Maximum epitope rows to return (1-100, default 20). `truncated` says whether more matched.'
        }
      }
    },
    returns:
      '{filtered_by:[…], n_retrieved, truncated, rows:[{epitope_iri, epitope_id, sequence, structure_type, ' +
      'sequence_length, modified_residue, source_antigens:[{accession,name,iri}], host_organisms[], ' +
      'source_organisms[], mhc_alleles[], diseases[], assay_iris[], assay_names[], qualitative_measures[], ' +
      'reference_iris[]}], notes}. Service text is returned with its HTML markup stripped (note included).',
    example:
      'const result = await host.mcp("immune_epitopes", "iedb_search_epitopes", {"sequence": "KLEDLERDL", "max_rows": 5})',
    run: async (ctx, args) => {
      const sequenceArg = args.sequence === undefined ? undefined : String(args.sequence)
      const iriArg =
        args.structure_iri === undefined ? undefined : String(args.structure_iri).trim()
      if (sequenceArg && iriArg) {
        throw new Error(
          'Pass either sequence or structure_iri, not both — they are two ways to name one epitope.'
        )
      }
      if (!sequenceArg && !iriArg) {
        throw new Error(
          'Pass a peptide sequence or an IEDB epitope IRI (IEDB_EPITOPE:n) to search for.'
        )
      }
      const maxRows = maxRowsOf(args.max_rows, 20, 100)
      const notes: string[] = []
      const normalised = sequenceArg ? normaliseSequence(sequenceArg) : undefined
      if (
        normalised &&
        (normalised.stripped_header_lines > 0 || normalised.stripped_whitespace > 0)
      ) {
        notes.push(
          `Normalised the input: stripped ${normalised.stripped_header_lines} FASTA header line(s) and ${normalised.stripped_whitespace} whitespace character(s); searched for "${normalised.sequence}".`
        )
      }
      const filteredBy = stripEmpty([
        ['sequence', normalised?.sequence],
        ['structure_iri', iriArg]
      ])
      const query = [
        normalised
          ? filterFor('linear_sequence', normalised.sequence)
          : filterFor('structure_iri', iriArg!),
        `select=${EPITOPE_FIELDS}`,
        `limit=${maxRows + 1}`,
        `order=${PAGE_ORDER.epitope}`
      ].join('&')
      const raw = await ctx.fetchJson(`${BASE}/epitope_search?${query}`)
      const all = Array.isArray(raw) ? raw : []
      const page = all.slice(0, maxRows)
      notes.push(
        'Text fields from IEDB carry HTML markup (e.g. "<br/>", "<strong>"); it has been stripped, so the values read as prose.'
      )
      if (page.length === 0) notes.push(EPITOPE_ABSENCE_NOTE)
      return {
        filtered_by: filteredBy,
        search_mode: normalised ? 'exact peptide sequence' : 'epitope IRI',
        n_retrieved: page.length,
        truncated: all.length > maxRows,
        rows: page.map(mapEpitopeRow),
        notes
      }
    }
  },
  {
    id: 'iedb_search_assays',
    connector: 'immune_epitopes',
    description:
      'Read the ASSAY-level evidence IEDB curates for one epitope: how it was measured (assay ' +
      'description), which MHC context it was restricted to, whether the measure was positive or ' +
      'negative, and the publication behind it (PubMed id + journal + title). Ask for t-cell receptor ' +
      'evidence, b-cell/antibody evidence, or both — the two are counted separately, and a kind that ' +
      'returned nothing is named as "no curated <kind> assay evidence", which says nothing about ' +
      'whether such a response exists. Give the epitope by IRI (IEDB_EPITOPE:n) or by exact peptide ' +
      'sequence; anything that is not a one-letter amino-acid code is refused by name before a request ' +
      'is sent.',
    input: {
      type: 'object',
      properties: {
        structure_iri: {
          type: 'string',
          description: 'IEDB epitope IRI, e.g. "IEDB_EPITOPE:31803" (from iedb_search_epitopes).'
        },
        sequence: {
          type: 'string',
          description:
            'Peptide sequence in one-letter code (FASTA headers and line breaks tolerated).'
        },
        kind: {
          type: 'string',
          enum: ['tcell', 'bcell', 'both'],
          description:
            'Which receptor/assay family to read (default "both"). The two are counted separately.'
        },
        max_rows: {
          type: 'number',
          description:
            'Maximum rows PER KIND (1-100, default 20). Each kind reports its own `truncated`.'
        }
      }
    },
    returns:
      '{filtered_by, kind, n_retrieved:{tcell,bcell}, truncated:{tcell,bcell}, rows:[{kind, assay_iri, ' +
      'epitope_iri, sequence, source_antigen, method, qualitative_measure, mhc:{class,restriction,' +
      'allele_resolution,allele_evidence}, immunization, antigen_description, direct_ex_vivo, ' +
      'citation:{pubmed_id,pubmed_url,reference_iri,journal,dates,title,authors}}], notes}.',
    example:
      'const result = await host.mcp("immune_epitopes", "iedb_search_assays", {"structure_iri": "IEDB_EPITOPE:31803", "kind": "tcell", "max_rows": 10})',
    run: async (ctx, args) => {
      const sequenceArg = args.sequence === undefined ? undefined : String(args.sequence)
      const iriArg =
        args.structure_iri === undefined ? undefined : String(args.structure_iri).trim()
      if (sequenceArg && iriArg) {
        throw new Error(
          'Pass either sequence or structure_iri, not both — they are two ways to name one epitope.'
        )
      }
      if (!sequenceArg && !iriArg) {
        throw new Error(
          'Pass a peptide sequence or an IEDB epitope IRI (IEDB_EPITOPE:n) to read its assays.'
        )
      }
      const kindArg = args.kind === undefined ? 'both' : String(args.kind)
      if (kindArg !== 'tcell' && kindArg !== 'bcell' && kindArg !== 'both') {
        throw new Error(`kind must be "tcell", "bcell" or "both" (got "${kindArg}").`)
      }
      const maxRows = maxRowsOf(args.max_rows, 20, 100)
      const notes: string[] = []
      const normalised = sequenceArg ? normaliseSequence(sequenceArg) : undefined
      if (
        normalised &&
        (normalised.stripped_header_lines > 0 || normalised.stripped_whitespace > 0)
      ) {
        notes.push(
          `Normalised the input: stripped ${normalised.stripped_header_lines} FASTA header line(s) and ${normalised.stripped_whitespace} whitespace character(s); searched for "${normalised.sequence}".`
        )
      }
      const filter = normalised
        ? filterFor('linear_sequence', normalised.sequence)
        : filterFor('structure_iri', iriArg!)
      const kinds: Array<'tcell' | 'bcell'> =
        kindArg === 'both' ? ['tcell', 'bcell'] : [kindArg as 'tcell' | 'bcell']

      const rows: Array<Record<string, unknown>> = []
      const nRetrieved: Record<string, number> = { tcell: 0, bcell: 0 }
      const truncated: Record<string, boolean> = { tcell: false, bcell: false }
      const emptyKinds: string[] = []
      for (const kind of kinds) {
        const endpoint = kind === 'tcell' ? 'tcell_search' : 'bcell_search'
        const order = kind === 'tcell' ? PAGE_ORDER.tcell : PAGE_ORDER.bcell
        const raw = await ctx.fetchJson(
          `${BASE}/${endpoint}?${filter}&select=${assayFieldsFor(kind)}&limit=${maxRows + 1}&order=${order}`
        )
        const all = Array.isArray(raw) ? raw : []
        const page = all.slice(0, maxRows)
        nRetrieved[kind] = page.length
        truncated[kind] = all.length > maxRows
        if (page.length === 0) emptyKinds.push(kind === 'tcell' ? 't-cell' : 'b-cell')
        for (const row of page) rows.push(mapAssayRow(row, kind))
      }
      notes.push(
        'Text fields from IEDB carry HTML markup (e.g. "<br/>", "<strong>"); it has been stripped, so the values read as prose.'
      )
      const absence = noAssayNote(emptyKinds)
      if (absence) notes.push(absence)
      return {
        filtered_by: stripEmpty([
          ['sequence', normalised?.sequence],
          ['structure_iri', iriArg]
        ]),
        search_mode: normalised ? 'exact peptide sequence' : 'epitope IRI',
        kind: kindArg,
        n_retrieved: nRetrieved,
        truncated,
        rows,
        notes
      }
    }
  }
]
