import type { ToolDescriptor } from '../types'

// MaveDB (Multiplexed Assays of Variant Effect) API. Two read paths back one tool:
//   POST /score-sets/search  {text|targets|authors, offset, limit} -> {scoreSets (ShortScoreSet[]), numScoreSets}
//   GET  /score-sets/?urns=<comma-separated URNs>                  -> ScoreSet[] (full records)
// A score-set record holds metadata and a variant COUNT (numVariants); the per-variant scores live in
// separate endpoints and are deliberately NOT fetched here — the result says so rather than implying
// it returned measurements. Each record's URN is translated into the MaveDB web URL a reader can open.
const MAVEDB_BASE = 'https://api.mavedb.org/api/v1'

type Obj = Record<string, unknown>
const asObj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const strList = (v: unknown): string[] =>
  asArr(v)
    .map((x) => str(x))
    .filter((s): s is string => Boolean(s))

function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  const base = Number.isFinite(n) && v != null && v !== '' ? Math.trunc(n) : def
  return Math.min(hi, Math.max(lo, base))
}

type MaveDbTargetGene = {
  name?: string
  category?: string
  targetAccession?: { accession?: string; gene?: string }
  externalIdentifiers?: Array<{
    identifier?: { dbName?: string; identifier?: string; url?: string }
  }>
}
type MaveDbPublication = { dbName?: string; identifier?: string; title?: string }
type MaveDbLicense = { shortName?: string; longName?: string; link?: string }
type MaveDbScoreSet = {
  urn?: string
  title?: string
  shortDescription?: string
  publishedDate?: string
  numVariants?: number
  private?: boolean
  targetGenes?: MaveDbTargetGene[]
  primaryPublicationIdentifiers?: MaveDbPublication[]
  license?: MaveDbLicense
}

// One score-set row. Keeps the URN (the stable identifier), the human web URL, the variant count and
// the target genes with their external accessions — the accession is what a reader can look up.
const scoreSetRow = (s: MaveDbScoreSet): Obj => {
  const urn = str(s.urn)
  const genes = asArr(s.targetGenes)
    .map(asObj)
    .map((g) => {
      const ta = asObj(g.targetAccession)
      const ext = asArr(g.externalIdentifiers)
        .map((e) => asObj(asObj(e).identifier))
        .map((i) => ({ db: str(i.dbName), id: str(i.identifier), url: str(i.url) }))
        .filter((i) => i.id)
      return {
        name: str(g.name),
        category: str(g.category),
        gene: str(ta.gene),
        accession: str(ta.accession),
        external_identifiers: ext
      }
    })
  const pubs = asArr(s.primaryPublicationIdentifiers)
    .map(asObj)
    .map((p) => ({
      db: str(p.dbName),
      identifier: str(p.identifier),
      title: str(p.title) ?? null
    }))
  const lic = asObj(s.license)
  return {
    urn,
    title: str(s.title),
    num_variants: typeof s.numVariants === 'number' ? s.numVariants : null,
    published_date: str(s.publishedDate) ?? null,
    short_description: str(s.shortDescription) ?? null,
    private: s.private === true,
    target_genes: genes,
    primary_publications: pubs,
    license: str(lic.shortName) ?? str(lic.longName) ?? null,
    mavedb_url: urn ? `https://www.mavedb.org/#/score-set/${urn}/` : null
  }
}

// MaveDB score-set discovery. One tool, two modes inferred from the args: fetch exact URNs, or search
// by free text / target gene / author. The service's `numScoreSets` is reported as the total so a
// capped page is visible as such.
export const VARIANTS_MAVEDB_TOOLS: ToolDescriptor[] = [
  {
    id: 'mavedb_search_score_sets',
    connector: 'variants',
    description:
      'Find MaveDB variant-effect score sets (deep mutational scanning / MAVE experiments). Two modes: pass `urns` to fetch exact score sets by MaveDB URN, or pass at least one of `text` / `targets` / `authors` to search. Returns score-set METADATA — URN, human web URL, variant count and target genes with their external accessions — not the per-variant scores. The service\'s `numScoreSets` total is reported beside `n_returned`/`truncated`. Args: urns (e.g. ["urn:mavedb:00000001-a-1"]); text (free text); targets (gene names, e.g. ["BRCA1"]); authors; limit (<=100); offset. Returns {mode, num_score_sets, offset, limit, n_returned, truncated, scores_included:false, score_sets:[...]}.',
    input: {
      type: 'object',
      properties: {
        urns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Fetch these exact score sets, e.g. ["urn:mavedb:00000001-a-1"].'
        },
        text: { type: 'string', description: 'Free-text search over MaveDB score sets.' },
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Target gene names/symbols, e.g. ["BRCA1"].'
        },
        authors: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer', default: 20 },
        offset: { type: 'integer', default: 0 }
      }
    },
    returns:
      '{mode:"urns"|"search", num_score_sets (service total; equals fetched count in urns mode), offset, limit, n_returned, truncated, scores_included:false, score_sets:[{urn, title, num_variants, published_date, short_description, private, target_genes:[{name, category, gene, accession, external_identifiers:[{db, id, url}]}], primary_publications:[{db, identifier, title}], license, mavedb_url}]}. Per-variant scores are NOT included — fetch them from the score-set\'s scores endpoint separately.',
    example:
      'const result = await host.mcp("variants", "mavedb_search_score_sets", {"targets": ["BRCA1"], "limit": 5})',
    run: async (ctx, a) => {
      const urns = strList(a.urns)
        .map((s) => s.trim())
        .filter(Boolean)
      const text = a.text != null ? String(a.text).trim() : ''
      const targets = strList(a.targets)
      const authors = strList(a.authors)
      const limit = clampInt(a.limit, 20, 1, 100)
      const offset = clampInt(a.offset, 0, 0, 1_000_000_000)

      if (!urns.length && !text && !targets.length && !authors.length)
        throw new Error(
          'provide `urns`, or at least one of `text`/`targets`/`authors` — refusing to return the entire catalogue'
        )

      let mode: 'urns' | 'search'
      let numScoreSets: number
      let rows: Obj[]
      if (urns.length) {
        mode = 'urns'
        const raw = await ctx.fetchJson(
          `${MAVEDB_BASE}/score-sets/?urns=${urns.map((u) => encodeURIComponent(u)).join(',')}`
        )
        rows = asArr(raw).map(asObj)
        numScoreSets = rows.length
        if (!rows.length) throw new Error(`no MaveDB score set found for: ${urns.join(', ')}`)
      } else {
        mode = 'search'
        const body: Obj = { offset, limit }
        if (text) body.text = text
        if (targets.length) body.targets = targets
        if (authors.length) body.authors = authors
        const raw = asObj(await ctx.postJson(`${MAVEDB_BASE}/score-sets/search`, body))
        rows = asArr(raw.scoreSets).map(asObj)
        numScoreSets = typeof raw.numScoreSets === 'number' ? raw.numScoreSets : rows.length
      }

      const scoreSets = rows.map((r) => scoreSetRow(r as MaveDbScoreSet))
      return {
        mode,
        num_score_sets: numScoreSets,
        offset: mode === 'search' ? offset : 0,
        limit: mode === 'search' ? limit : urns.length,
        n_returned: scoreSets.length,
        truncated: mode === 'search' ? numScoreSets > offset + scoreSets.length : false,
        scores_included: false,
        score_sets: scoreSets
      }
    }
  }
]
