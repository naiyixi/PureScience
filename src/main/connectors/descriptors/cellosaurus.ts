import type { ToolDescriptor } from '../types'

// Cellosaurus (SIB) — the reference knowledge base for cell-line identity and quality: names and
// synonyms, primary + secondary RRID-style accessions, species, disease, sex, and the two quality
// signals that matter when reusing a line — the STR profile (with per-marker conflict flags) and
// the curated "Problematic cell line" annotations (misidentified / contaminated / discontinued).
//
// Verified live (2026-10): GET /cell-line/CVCL_0372?format=json and GET /search/cell-line?q=HeLa&
//   format=json&rows=2 both answer { Cellosaurus: { "cell-line-list": [ ... ], "publication-list": [ ... ] } }.
// The search envelope carries NO total hit count, so a search result is only ever "this page".
const CELLOSAURUS = 'https://api.cellosaurus.org'
const DEFAULT_MAX = 10
// Cellosaurus accessions: CVCL_0030, CVCL_B1IJ, CVCL_R957, ...
const ACCESSION = /^CVCL_[A-Z0-9]{4}$/i

type Xref = { accession?: string; database?: string; label?: string }
type NameEntry = { type?: string; value?: string }
type AccessionEntry = { type?: string; value?: string }
type CommentEntry = { category?: string; value?: string }
type StrMarker = {
  id?: string
  conflict?: string | boolean
  'marker-data-list'?: Array<{ 'marker-alleles'?: string }>
}
type CellLine = {
  'accession-list'?: AccessionEntry[]
  'name-list'?: NameEntry[]
  category?: string
  age?: string
  sex?: string
  'species-list'?: Xref[]
  'disease-list'?: Xref[]
  'comment-list'?: CommentEntry[]
  'str-list'?: { 'marker-list'?: StrMarker[] }
  'child-list'?: unknown[]
  'reference-list'?: unknown[]
}
type CellosaurusEnvelope = {
  Cellosaurus?: { 'cell-line-list'?: CellLine[] }
  code?: number
  message?: string
}

const primaryAccession = (l: CellLine): string | undefined =>
  (l['accession-list'] ?? []).find((x) => x.type === 'primary')?.value
const allAccessions = (l: CellLine): string[] =>
  (l['accession-list'] ?? []).map((x) => x.value).filter((v): v is string => !!v)
const identifierName = (l: CellLine): string | undefined =>
  (l['name-list'] ?? []).find((n) => n.type === 'identifier')?.value ??
  (l['name-list'] ?? [])[0]?.value
const synonyms = (l: CellLine): string[] =>
  (l['name-list'] ?? [])
    .filter((n) => n.type !== 'identifier')
    .map((n) => n.value)
    .filter((v): v is string => !!v)

// The curated quality flag lives in a comment whose category is exactly "Problematic cell line".
const problematicNotes = (l: CellLine): CommentEntry[] =>
  (l['comment-list'] ?? []).filter(
    (c) => (c.category ?? '').toLowerCase() === 'problematic cell line'
  )
const isProblematic = (l: CellLine): boolean => problematicNotes(l).length > 0

const strMarkers = (l: CellLine): StrMarker[] => l['str-list']?.['marker-list'] ?? []
const strConflicts = (l: CellLine): Array<{ id?: string; alleles?: string }> =>
  strMarkers(l)
    .filter((m) => String(m.conflict).toLowerCase() === 'true')
    .map((m) => ({ id: m.id, alleles: m['marker-data-list']?.[0]?.['marker-alleles'] }))

const refList = (xs?: Xref[]): Array<{ id?: string; label?: string }> =>
  (xs ?? []).map((x) => ({ id: x.accession, label: x.label ?? x.database }))

// Compact row for name-search results (no STR/child/xref bulk).
function summary(l: CellLine): Record<string, unknown> {
  const primary = primaryAccession(l)
  return {
    accession: primary,
    secondary_accessions: allAccessions(l).filter((a) => a !== primary),
    name: identifierName(l),
    category: l.category,
    species: (l['species-list'] ?? []).map((x) => x.label ?? x.database),
    disease: (l['disease-list'] ?? []).map((x) => x.label ?? x.database),
    sex: l.sex,
    is_problematic: isProblematic(l)
  }
}

export const CELLOSAURUS_TOOLS: ToolDescriptor[] = [
  {
    id: 'get_cellosaurus_cell_line',
    connector: 'cancer_models',
    description:
      'Cellosaurus cell-line identity and quality. Pass a Cellosaurus accession (e.g. CVCL_0030) to fetch one entry, or a free-text name (e.g. HeLa) to search. An accession lookup returns names/synonyms, primary + secondary accessions, species, disease, sex, the number of descendant lines, and an explicit quality block: whether the line carries a curated "Problematic cell line" annotation (misidentified/contaminated) and the conflicting STR markers in its profile. A name search returns compact rows with the same quality flag.',
    input: {
      type: 'object',
      properties: {
        cell_line: {
          type: 'string',
          description: 'A Cellosaurus accession (CVCL_0030) or a name/synonym (HeLa)'
        },
        max_records: {
          type: 'integer',
          default: 10,
          description: 'Max rows for a name search (ignored for an accession lookup).'
        }
      },
      required: ['cell_line']
    },
    required: ['cell_line'],
    returns:
      'Accession mode: `{ mode: "accession", cell_line, accession, found: true, secondary_accessions: [str], name, synonyms: [str], category, age, sex, species: [{id,label}], disease: [{id,label}], is_problematic, problematic_annotations: [{category,value}], str_profile: { n_markers, conflicting_markers: [{id,alleles}] }, n_children, n_references, url }` (or `{ mode: "accession", cell_line, accession, found: false }` when unknown). Name mode: `{ mode: "search", query, n_returned, truncated, note, cell_lines: [{ accession, secondary_accessions, name, category, species: [str], disease: [str], sex, is_problematic }] }` — the search endpoint reports no total, so `n_returned` is only the rows on this page.',
    example:
      'const result = await host.mcp("cancer_models", "get_cellosaurus_cell_line", {"cell_line": "CVCL_0030"})',
    run: async (ctx, a) => {
      const input = String(a.cell_line ?? '').trim()
      if (!input) {
        throw new Error(
          'cell_line is required (a Cellosaurus accession like CVCL_0030, or a name like HeLa)'
        )
      }
      const maxRecords = Math.max(1, Number(a.max_records ?? DEFAULT_MAX))

      // Accession-shaped input is fetched directly; a wrong/unknown accession is named (found:false)
      // rather than silently falling through to a name search that would read as "no matches".
      if (ACCESSION.test(input)) {
        const accession = input.toUpperCase()
        let env: CellosaurusEnvelope
        try {
          env = (await ctx.fetchJson(
            `${CELLOSAURUS}/cell-line/${encodeURIComponent(accession)}?format=json`
          )) as CellosaurusEnvelope
        } catch (err) {
          if (err instanceof Error && /HTTP 404/.test(err.message)) {
            return { mode: 'accession', cell_line: input, accession, found: false }
          }
          throw err
        }
        const line = env.Cellosaurus?.['cell-line-list']?.[0]
        if (!line) return { mode: 'accession', cell_line: input, accession, found: false }
        const primary = primaryAccession(line) ?? accession
        return {
          mode: 'accession',
          cell_line: input,
          accession: primary,
          found: true,
          secondary_accessions: allAccessions(line).filter((x) => x !== primary),
          name: identifierName(line),
          synonyms: synonyms(line),
          category: line.category,
          age: line.age,
          sex: line.sex,
          species: refList(line['species-list']),
          disease: refList(line['disease-list']),
          is_problematic: isProblematic(line),
          problematic_annotations: problematicNotes(line).map((c) => ({
            category: c.category,
            value: c.value
          })),
          str_profile: {
            n_markers: strMarkers(line).length,
            conflicting_markers: strConflicts(line)
          },
          n_children: (line['child-list'] ?? []).length,
          n_references: (line['reference-list'] ?? []).length,
          url: `https://www.cellosaurus.org/${primary}`
        }
      }

      const env = (await ctx.fetchJson(
        `${CELLOSAURUS}/search/cell-line?q=${encodeURIComponent(input)}&format=json&rows=${maxRecords}`
      )) as CellosaurusEnvelope
      const rows = (env.Cellosaurus?.['cell-line-list'] ?? []).slice(0, maxRecords)
      return {
        mode: 'search',
        query: input,
        n_returned: rows.length,
        truncated: rows.length >= maxRecords,
        note: 'The Cellosaurus search endpoint reports no total hit count — `n_returned` is the rows on this page; raise max_records to see more.',
        cell_lines: rows.map(summary)
      }
    }
  }
]
