import type { ToolDescriptor } from '../types'

// Monarch Initiative Knowledge Graph association API (api.monarchinitiative.org/v3). The
// `/association` endpoint pages associations by subject/object with a mandatory `category` from a
// fixed biolink enum. This tool targets the PHENOTYPE association categories only, turning each
// association into one evidence row: the subject/object CURIEs WITH their human labels, the ECO
// evidence codes, the frequency/onset qualifiers and the primary knowledge source. The service
// reports its own `total`; `n_returned` and `truncated` are surfaced so a capped page is never
// mistaken for the whole answer.
const MONARCH_BASE = 'https://api.monarchinitiative.org/v3/api'

// Phenotype association categories accepted by the service (validated from its own enum error).
const PHENOTYPE_CATEGORIES = [
  'biolink:DiseaseToPhenotypicFeatureAssociation',
  'biolink:GeneToPhenotypicFeatureAssociation',
  'biolink:GenotypeToPhenotypicFeatureAssociation',
  'biolink:VariantToPhenotypicFeatureAssociation',
  'biolink:CaseToPhenotypicFeatureAssociation'
] as const

type Obj = Record<string, unknown>
const asObj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const strArr = (v: unknown): string[] =>
  asArr(v)
    .map((x) => (typeof x === 'string' ? x : undefined))
    .filter((s): s is string => Boolean(s))

function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  const base = Number.isFinite(n) && v != null && v !== '' ? Math.trunc(n) : def
  return Math.min(hi, Math.max(lo, base))
}

type MonarchAssociation = {
  id?: string
  category?: string
  predicate?: string
  subject?: string
  subject_label?: string
  subject_category?: string
  object?: string
  object_label?: string
  object_category?: string
  publications?: string[]
  has_evidence?: string[]
  frequency_qualifier?: string
  frequency_qualifier_label?: string
  onset_qualifier?: string
  onset_qualifier_label?: string
  sex_qualifier?: string
  sex_qualifier_label?: string
  negated?: boolean
  primary_knowledge_source?: string
  knowledge_level?: string
  aggregator_knowledge_source?: string[]
  has_count?: number | null
  has_percentage?: number | null
  has_total?: number | null
  evidence_count?: number | null
}

const associationRow = (it: MonarchAssociation): Obj => ({
  id: it.id,
  category: it.category,
  predicate: it.predicate,
  subject: it.subject,
  subject_label: it.subject_label ?? null,
  subject_category: it.subject_category ?? null,
  object: it.object,
  object_label: it.object_label ?? null,
  object_category: it.object_category ?? null,
  publications: strArr(it.publications),
  has_evidence: strArr(it.has_evidence),
  frequency_qualifier: it.frequency_qualifier ?? null,
  frequency_qualifier_label: it.frequency_qualifier_label ?? null,
  onset_qualifier: it.onset_qualifier ?? null,
  onset_qualifier_label: it.onset_qualifier_label ?? null,
  sex_qualifier: it.sex_qualifier ?? null,
  has_count: it.has_count ?? null,
  has_percentage: it.has_percentage ?? null,
  has_total: it.has_total ?? null,
  negated: it.negated ?? false,
  primary_knowledge_source: it.primary_knowledge_source ?? null,
  aggregator_knowledge_source: strArr(it.aggregator_knowledge_source),
  knowledge_level: it.knowledge_level ?? null,
  evidence_count: it.evidence_count ?? null
})

// Phenotype association evidence from Monarch. One tool: query by subject (disease/gene/variant CURIE)
// or object (phenotype CURIE, e.g. HP:0000768) and receive labelled, evidence-carrying rows.
export const GENES_MONARCH_TOOLS: ToolDescriptor[] = [
  {
    id: 'monarch_phenotype_associations',
    connector: 'genes',
    description:
      "Retrieve phenotype-association evidence from the Monarch Initiative Knowledge Graph. Query by `subject` (a disease/gene/genotype/variant CURIE, e.g. MONDO:0007947 or HGNC:1100) and/or `object` (a phenotype CURIE, e.g. HP:0000768), restricted to one phenotype association `category` (default DiseaseToPhenotypicFeatureAssociation). Every row keeps the subject/object CURIEs WITH their human labels, the ECO evidence codes, the frequency/onset qualifiers, negated flag, and the primary vs aggregator knowledge source — so the evidence provenance is on screen, not implied. The service's own `total` is reported alongside `n_returned`/`truncated`. At least one of subject/object is required. Returns {subject, object, category, total, offset, limit, n_returned, truncated, facet_fields, associations:[...]}.",
    input: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: 'Subject CURIE (disease/gene/genotype/variant), e.g. "MONDO:0007947".'
        },
        object: {
          type: 'string',
          description: 'Object phenotype CURIE, e.g. "HP:0000768".'
        },
        category: {
          type: 'string',
          enum: [...PHENOTYPE_CATEGORIES],
          default: 'biolink:DiseaseToPhenotypicFeatureAssociation'
        },
        limit: { type: 'integer', default: 20 },
        offset: { type: 'integer', default: 0 }
      }
    },
    returns:
      '{subject:str|null, object:str|null, category, total (service-reported), offset, limit, n_returned, truncated, facet_fields:[...], associations:[{id, category, predicate, subject, subject_label, subject_category, object, object_label, object_category, publications:[str], has_evidence:[str] (ECO codes), frequency_qualifier, frequency_qualifier_label, onset_qualifier, onset_qualifier_label, sex_qualifier, has_count, has_percentage, has_total, negated, primary_knowledge_source, aggregator_knowledge_source:[str], knowledge_level, evidence_count}]}.',
    example:
      'const result = await host.mcp("genes", "monarch_phenotype_associations", {"subject": "MONDO:0007947", "category": "biolink:DiseaseToPhenotypicFeatureAssociation", "limit": 5})',
    run: async (ctx, a) => {
      const subject = a.subject != null ? String(a.subject).trim() : ''
      const object = a.object != null ? String(a.object).trim() : ''
      if (!subject && !object)
        throw new Error(
          'at least one of subject (disease/gene CURIE) or object (phenotype CURIE) is required'
        )
      const category = a.category != null ? String(a.category).trim() : PHENOTYPE_CATEGORIES[0]
      if (!PHENOTYPE_CATEGORIES.includes(category as (typeof PHENOTYPE_CATEGORIES)[number]))
        throw new Error(
          `unknown phenotype association category '${category}'. Valid: ${PHENOTYPE_CATEGORIES.join(', ')}`
        )
      const limit = clampInt(a.limit, 20, 1, 500)
      const offset = clampInt(a.offset, 0, 0, 1_000_000_000)

      const params = [
        `category=${encodeURIComponent(category)}`,
        `limit=${limit}`,
        `offset=${offset}`
      ]
      if (subject) params.push(`subject=${encodeURIComponent(subject)}`)
      if (object) params.push(`object=${encodeURIComponent(object)}`)
      const resp = asObj(await ctx.fetchJson(`${MONARCH_BASE}/association?${params.join('&')}`))
      const items = asArr(resp.items).map((x) => associationRow(x as MonarchAssociation))
      const total = typeof resp.total === 'number' ? resp.total : items.length
      return {
        subject: subject || null,
        object: object || null,
        category,
        total,
        offset,
        limit,
        n_returned: items.length,
        truncated: total > offset + items.length,
        facet_fields: asArr(resp.facet_fields),
        associations: items
      }
    }
  }
]
