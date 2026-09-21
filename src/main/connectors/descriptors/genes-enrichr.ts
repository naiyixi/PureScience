import type { ToolContext, ToolDescriptor } from '../types'

// Gene-set enrichment against a curated library service.
//
// The service ranks terms in a named library for a gene list and returns nine-field rows: rank, term,
// p-value, z-score, combined score, the overlapping genes, an adjusted p-value and the two deprecated
// p-value fields. It does NOT return the sizes behind those numbers (library term size, query size,
// background size), so the tail probability cannot be recomputed here. That is a real difference from the
// local engine, and this tool says so instead of implying it verified anything: the numbers come back as
// the service's numbers, with the correction the service applied named as the service's, and every term
// carries `recomputed: false` plus the reason.
//
// What it does check locally is the one thing it can: the rows it accepts must be about the list we sent.
// Every gene the service lists as overlapping has to be one of our query genes — a stranger means the
// answer belongs to a different list (a stale or borrowed id), which is refused rather than reported.
//
// Wire facts, verified against the live service rather than assumed:
//   - the list has to be sent as multipart/form-data; a urlencoded body answers 400 with an HTML error page
//     while the same fields sent as multipart answer 200
//   - the success body is JSON but its content type says text/html, so it is parsed as text, never trusted
//     to `response.json()`
//   - `enrich` returns an object keyed by the library name, whose value is an array of rows

const ENRICHR_ADD_LIST_URL = 'https://maayanlab.cloud/Enrichr/addList'
const ENRICHR_ENRICH_URL = 'https://maayanlab.cloud/Enrichr/enrich'

const DEFAULT_LIBRARIES = ['GO_Biological_Process_2023'] as const
const DEFAULT_ALPHA = 0.05
const DEFAULT_MAX_TERMS = 50
const MAX_LIBRARIES = 5

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => String(item).trim()).filter((item) => item !== '') : []

const asNumber = (value: unknown): number | undefined => {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

type LibraryOutcome = {
  library: string
  terms: readonly EnrichmentTerm[]
  /** Rows the service returned that could not be read as a term row. Counted, never silently dropped. */
  malformedRows: number
  /** The service's own field for the correction it applied, when it says one. */
  error?: string
}

type EnrichmentTerm = {
  term: string
  library: string
  rank: number
  pValue: number
  adjustedPValue?: number
  zScore?: number
  combinedScore?: number
  overlap: number
  overlapGenes: readonly string[]
  /** Always false here: the service reports no counts, so nothing about its p-values can be recomputed. */
  recomputed: false
  recomputeReason: string
}

// Thrown when a row's overlapping genes are not the genes we submitted. This is not a per-library failure to
// record beside the others: an answer about a different list means the handle we are querying is not ours, so
// the call stops.
class SubmissionMismatchError extends Error {}

const NOT_RECOMPUTED_REASON =
  'the service reports no set sizes, so this p-value cannot be recomputed locally'

const postList = async (genes: readonly string[]): Promise<number> => {
  const form = new FormData()
  form.set('list', genes.join('\n'))
  form.set('description', 'PureScience gene list')

  const response = await fetch(ENRICHR_ADD_LIST_URL, { method: 'POST', body: form })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `the library service refused the gene list (HTTP ${response.status}): ${text.slice(0, 200)}`
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('the library service answered with something that is not JSON')
  }
  const id = asNumber((parsed as { userListId?: unknown }).userListId)
  if (id === undefined) {
    throw new Error('the library service did not return a user list id for the submitted genes')
  }
  return id
}

const fetchLibrary = async (userListId: number, library: string): Promise<unknown> => {
  const url = `${ENRICHR_ENRICH_URL}?userListId=${encodeURIComponent(String(userListId))}&backgroundType=${encodeURIComponent(library)}`
  const response = await fetch(url)
  // The body is JSON with a text/html content type, so it is read as text on purpose.
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `the library service refused the ${library} lookup (HTTP ${response.status}): ${text.slice(0, 200)}`
    )
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`the ${library} lookup answered with something that is not JSON`)
  }
}

const readTerms = (
  payload: unknown,
  library: string,
  queryGenes: ReadonlySet<string>
): Pick<LibraryOutcome, 'terms' | 'malformedRows'> => {
  const rows = (payload as Record<string, unknown>)[library]
  if (!Array.isArray(rows)) {
    throw new Error(
      `the ${library} lookup did not carry a term list for that library (keys: ${Object.keys(
        (payload ?? {}) as Record<string, unknown>
      ).join(', ') || 'none'})`
    )
  }

  const terms: EnrichmentTerm[] = []
  let malformedRows = 0
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) {
      malformedRows += 1
      continue
    }
    const [rank, term, pValue, zScore, combinedScore, rawGenes] = row as unknown[]
    const overlapGenes = stringList(rawGenes)
    const strangers = overlapGenes.filter((gene) => !queryGenes.has(gene))
    if (strangers.length > 0) {
      // The answer is about a list we did not send. Refusing beats reporting it against our genes.
      throw new SubmissionMismatchError(
        `the ${library} lookup listed overlapping genes that were not in the submitted list: ${strangers
          .slice(0, 5)
          .join(', ')}`
      )
    }
    terms.push({
      term: String(term ?? ''),
      library,
      rank: asNumber(rank) ?? terms.length + 1,
      pValue: asNumber(pValue) ?? Number.NaN,
      ...(asNumber(row[6]) === undefined ? {} : { adjustedPValue: asNumber(row[6]) }),
      ...(asNumber(zScore) === undefined ? {} : { zScore: asNumber(zScore) }),
      ...(asNumber(combinedScore) === undefined ? {} : { combinedScore: asNumber(combinedScore) }),
      overlap: overlapGenes.length,
      overlapGenes,
      recomputed: false,
      recomputeReason: NOT_RECOMPUTED_REASON
    })
  }

  return { terms, malformedRows }
}

export const GENES_ENRICHR_TOOLS: ToolDescriptor[] = [
  {
    id: 'gene_set_enrichment_libraries',
    connector: 'genes',
    description:
      'Ranked gene-set enrichment for a gene list against curated library services, one library per call group (default GO_Biological_Process_2023). The service returns the p-value, adjusted p-value, z-score, combined score and overlapping genes for each term, and this tool reports them as the service reports them: it does not recompute the tail probability, because the service publishes no set sizes, and every term says `recomputed: false` with that reason. It does verify the one thing it can locally — the overlapping genes it accepts must all be genes you submitted, otherwise the answer belongs to a different list and the call fails by name. Terms are filtered by `alpha` against the service\'s adjusted p-value and counted, never dropped silently.',
    input: {
      type: 'object',
      properties: {
        genes: { type: 'array', items: { type: 'string' }, description: 'Query genes (symbols).' },
        libraries: {
          type: 'array',
          items: { type: 'string' },
          description: 'One to five library names, default ["GO_Biological_Process_2023"].'
        },
        alpha: { type: 'number', description: 'Keep terms at or below this adjusted p-value. Default 0.05.' },
        min_overlap: { type: 'number', description: 'Skip terms with fewer overlapping genes. Default 1.' },
        max_terms: { type: 'number', description: 'Cap kept terms per library. Default 50.' }
      },
      required: ['genes']
    },
    returns:
      '{mode:"service", service:{name,user_list_id,libraries}, terms:[{term,library,rank,pValue,adjustedPValue,zScore,combinedScore,overlap,overlapGenes,recomputed:false,recomputeReason}], counts:{returned,kept,filtered,malformedRows,truncated}, perLibrary:[{library,returned,kept,error?}], summary:{zh,notes}}.',
    example:
      'const result = await host.mcp("genes", "gene_set_enrichment_libraries", {"genes": ["TP53", "BRCA1"], "libraries": ["GO_Biological_Process_2023"]})',
    run: async (ctx: ToolContext, a: Record<string, unknown>) => {
      void ctx
      const genes = stringList(a.genes)
      if (genes.length === 0) {
        throw new Error('gene_set_enrichment_libraries needs at least one gene.')
      }
      const requested = stringList(a.libraries)
      const libraries = (requested.length > 0 ? requested : [...DEFAULT_LIBRARIES]).slice(
        0,
        MAX_LIBRARIES
      )
      const truncationNote =
        requested.length > MAX_LIBRARIES
          ? `Only the first ${MAX_LIBRARIES} of ${requested.length} requested libraries were queried.`
          : undefined

      const alpha = asNumber(a.alpha) ?? DEFAULT_ALPHA
      const minOverlap = Math.max(1, Math.floor(asNumber(a.min_overlap) ?? 1))
      const maxTerms = Math.max(1, Math.floor(asNumber(a.max_terms) ?? DEFAULT_MAX_TERMS))

      const queryGenes = new Set(genes)
      const userListId = await postList(genes)

      const outcomes: LibraryOutcome[] = []
      for (const library of libraries) {
        try {
          const payload = await fetchLibrary(userListId, library)
          const { terms, malformedRows } = readTerms(payload, library, queryGenes)
          outcomes.push({ library, terms, malformedRows })
        } catch (error) {
          if (error instanceof SubmissionMismatchError) throw error
          // One library failing is named and counted: the others still answer.
          outcomes.push({
            library,
            terms: [],
            malformedRows: 0,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }

      let filtered = 0
      let truncated = 0
      const terms: EnrichmentTerm[] = []
      const perLibrary = outcomes.map((outcome) => {
        const kept: EnrichmentTerm[] = []
        for (const term of outcome.terms) {
          if (term.overlap < minOverlap) {
            filtered += 1
            continue
          }
          const threshold = term.adjustedPValue ?? term.pValue
          if (Number.isFinite(threshold) && threshold > alpha) {
            filtered += 1
            continue
          }
          kept.push(term)
        }
        kept.sort((left, right) => left.pValue - right.pValue)
        const capped = kept.slice(0, maxTerms)
        truncated += kept.length - capped.length
        terms.push(...capped)
        return {
          library: outcome.library,
          returned: outcome.terms.length,
          kept: capped.length,
          ...(outcome.error === undefined ? {} : { error: outcome.error })
        }
      })

      const failed = perLibrary.filter((entry) => entry.error !== undefined)
      const notes = [
        'These p-values are the service\'s own: neither the term sizes nor the background size are published, so nothing here can be recomputed locally.',
        'Every kept term says recomputed:false for that reason; the local engine is the tool to use when a recomputable tail probability matters.',
        ...(filtered > 0
          ? [`${filtered} term(s) were filtered out by alpha or min_overlap and are counted, not dropped silently.`]
          : []),
        ...(truncated > 0 ? [`${truncated} term(s) were cut by the per-library cap.`] : []),
        ...(truncationNote === undefined ? [] : [truncationNote]),
        ...(failed.length > 0
          ? [`${failed.length} library lookup(s) failed and are named in perLibrary: ${failed
              .map((entry) => entry.library)
              .join(', ')}.`]
          : [])
      ]

      return {
        mode: 'service',
        service: { name: 'gene-set library service', userListId, libraries },
        terms,
        counts: {
          returned: perLibrary.reduce((total, entry) => total + entry.returned, 0),
          kept: terms.length,
          filtered,
          malformedRows: outcomes.reduce((total, entry) => total + entry.malformedRows, 0),
          truncated,
          librariesFailed: failed.length
        },
        perLibrary,
        summary: {
          zh: `${libraries.join('、')} 共返回 ${perLibrary.reduce((total, entry) => total + entry.returned, 0)} 个条目，保留 ${terms.length} 个；这些 p 值是服务方给出的，未在本地复算。`,
          notes
        }
      }
    }
  }
]
