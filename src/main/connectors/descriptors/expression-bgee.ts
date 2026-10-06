import type { ToolDescriptor } from '../types'

// Bgee (bgee.org) — cross-species gene-expression calls: one call per (gene, anatomical
// entity / cell type) carrying a service-scored expression level, its confidence and an FDR.
// The per-species JSON API lives at /api/index.php (the newer /api/gene/... paths 404).
//
// Verified live (2026-10):
//   GET /api/index.php?page=gene&action=expression&gene_id=ENSG00000141510&species_id=9606&display_type=json
//     -> { code, status, message, data: { requestedCallType, requestedDataTypes,
//          requestedConditionParameters, calls: [ { condition: { anatEntity|cellType },
//          expressionScore: { expressionScore, expressionScoreConfidence }, fdr, dataTypesWithData,
//          expressionState, expressionQuality, clusterIndex } ], gene: { geneId, name, species } } }
// Two facts drive the code below:
//   1. species_id is mandatory — omitting it returns HTTP 400 "Invalid species ID argument: null",
//      and an unknown gene returns HTTP 404. Both are named here before/after the call.
//   2. gene_id must be an Ensembl gene id; a bare symbol also 404s, which would read as "gene not
//      in Bgee" when it really means "wrong id space", so the id shape is checked locally first.
const BGEE = 'https://www.bgee.org/api/index.php'
const DEFAULT_MAX = 100
// Ensembl gene ids: ENSG00000141510 (human), ENSMUSG00000059552 (mouse).
const ENSEMBL_GENE = /^ENS[A-Z]*G\d{11}$/i

type BgeeEntity = { id?: string; name?: string }
type BgeeCondition = { anatEntity?: BgeeEntity; cellType?: BgeeEntity }
type BgeeCall = {
  condition?: BgeeCondition
  expressionScore?: { expressionScore?: string; expressionScoreConfidence?: string }
  fdr?: string
  dataTypesWithData?: string[]
  expressionState?: string
  expressionQuality?: string
  clusterIndex?: number
}
type BgeeGene = { geneId?: string; name?: string; species?: { id?: number; name?: string } }
type BgeeData = {
  requestedCallType?: string
  requestedDataTypes?: string[]
  requestedConditionParameters?: string[]
  calls?: BgeeCall[]
  gene?: BgeeGene
}
type BgeeEnvelope = { code?: number; status?: string; message?: string; data?: BgeeData }

export const EXPRESSION_BGEE_TOOLS: ToolDescriptor[] = [
  {
    id: 'bgee_gene_expression',
    connector: 'expression',
    description:
      'Cross-species gene-expression calls from Bgee: for one Ensembl gene id in one species, the anatomical-entity / cell-type conditions in which the gene is expressed (or not), each with Bgee\'s expression score, its confidence, FDR, expression quality class, and the supporting data types (RNA-Seq, EST, in situ, ...). Bgee requires an Ensembl gene id and an NCBI taxon id; a bad id shape is refused before the request instead of being read back as "not found".',
    input: {
      type: 'object',
      properties: {
        gene_id: {
          type: 'string',
          description: 'Ensembl gene id, e.g. ENSG00000141510 (human TP53)'
        },
        species_id: {
          type: 'string',
          description: "NCBI taxon id of the gene's species, e.g. 9606 (human), 10090 (mouse)"
        },
        max_records: { type: 'integer', default: 100 }
      },
      required: ['gene_id', 'species_id']
    },
    required: ['gene_id', 'species_id'],
    returns:
      '`{ gene: { id, name, species: { id, name } }, service_message, call_type, data_types, condition_parameters, total_calls, counts_by_state: { <state>: int }, truncated, calls: [ { anatomical_entity: { id, name } | null, cell_type: { id, name } | null, expression_state, expression_score, score_confidence, fdr, quality, data_types: [str], cluster_index } ] }` — `expression_score`, `score_confidence` and `fdr` are the service-reported strings, NOT recomputed locally. `calls` is capped at `max_records`.',
    example:
      'const result = await host.mcp("expression", "bgee_gene_expression", {"gene_id": "ENSG00000141510", "species_id": "9606"})',
    run: async (ctx, a) => {
      const geneId = String(a.gene_id ?? '')
        .trim()
        .toUpperCase()
      if (!geneId) throw new Error('gene_id is required')
      if (!ENSEMBL_GENE.test(geneId)) {
        throw new Error(
          `gene_id must be an Ensembl gene id (e.g. ENSG00000141510); got "${String(
            a.gene_id
          )}". Resolve the symbol to its Ensembl id first — Bgee answers a symbol with "not found", which would read as if the gene were absent.`
        )
      }
      const species = Number(a.species_id)
      if (!Number.isInteger(species) || species <= 0) {
        throw new Error(
          'species_id must be a positive NCBI taxon id (e.g. 9606 for human, 10090 for mouse)'
        )
      }
      const maxRecords = Math.max(1, Number(a.max_records ?? DEFAULT_MAX))

      const url =
        `${BGEE}?page=gene&action=expression&gene_id=${encodeURIComponent(geneId)}` +
        `&species_id=${species}&display_type=json`
      let env: BgeeEnvelope
      try {
        env = (await ctx.fetchJson(url)) as BgeeEnvelope
      } catch (err) {
        if (err instanceof Error && /HTTP 404/.test(err.message)) {
          throw new Error(`Gene ${geneId} is not in Bgee for species ${species} (HTTP 404)`)
        }
        throw err
      }
      const data = env.data ?? {}
      const calls = data.calls ?? []
      const countsByState: Record<string, number> = {}
      for (const c of calls) {
        const state = c.expressionState ?? 'unknown'
        countsByState[state] = (countsByState[state] ?? 0) + 1
      }

      return {
        gene: {
          id: data.gene?.geneId ?? geneId,
          name: data.gene?.name,
          species: { id: data.gene?.species?.id ?? species, name: data.gene?.species?.name }
        },
        service_message: env.message,
        call_type: data.requestedCallType,
        data_types: data.requestedDataTypes ?? [],
        condition_parameters: data.requestedConditionParameters ?? [],
        total_calls: calls.length,
        counts_by_state: countsByState,
        truncated: calls.length > maxRecords,
        note: 'expression_score, score_confidence and fdr are the values Bgee reports; Bgee returns no term/background sizes, so those numbers are NOT recomputed locally.',
        calls: calls.slice(0, maxRecords).map((c) => ({
          anatomical_entity: c.condition?.anatEntity
            ? { id: c.condition.anatEntity.id, name: c.condition.anatEntity.name }
            : null,
          cell_type: c.condition?.cellType
            ? { id: c.condition.cellType.id, name: c.condition.cellType.name }
            : null,
          expression_state: c.expressionState,
          expression_score: c.expressionScore?.expressionScore,
          score_confidence: c.expressionScore?.expressionScoreConfidence,
          fdr: c.fdr,
          quality: c.expressionQuality,
          data_types: c.dataTypesWithData ?? [],
          cluster_index: c.clusterIndex
        }))
      }
    }
  }
]
