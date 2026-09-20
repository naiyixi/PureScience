import {
  hypergeometricUpperTail,
  runGeneSetEnrichment,
  type EnrichmentCorrection,
  type EnrichmentTermInput
} from '../../../shared/gene-set-enrichment'
import type { ToolContext, ToolDescriptor } from '../types'

// g:Profiler g:GOSt, with the enrichment recomputed here.
//
// The audit's requirement for this capability is that the service's word is not the result: the
// numbers must be reproducible locally. So this tool has two modes and returns the same envelope for both.
//
//  - Offline: the caller passes the annotation (term -> genes). Everything is computed by
//    `shared/gene-set-enrichment`: hypergeometric tail, the named correction, the effect size. No network.
//  - Service: the caller passes genes only. g:Profiler is asked for the enriched terms, and then each
//    returned row is recomputed locally from the sizes the service reports (intersection, term size,
//    effective domain size, query size). A row whose two p-values disagree beyond tolerance is reported
//    as such rather than quietly accepted.
//
// Either way the answer carries the background that was used and the correction that was applied, and the
// Chinese summary describes only what was actually computed here.
const GPROFILER_BASE = 'https://biit.cs.ut.ee/gprofiler/api/gost/profile/'
const DEFAULT_SOURCES = ['GO:BP', 'GO:MF', 'GO:CC', 'KEGG', 'REAC'] as const
// Service and local p-values are computed from the same four integers, so they should agree to rounding;
// anything wider than this is a disagreement worth naming rather than a rounding artefact.
const P_VALUE_TOLERANCE = 1e-6

type GprofilerRow = {
  native?: string
  name?: string
  source?: string
  p_value?: number
  term_size?: number
  query_size?: number
  intersection_size?: number
  effective_domain_size?: number
  significant?: boolean
}

const asCorrection = (value: unknown): EnrichmentCorrection => {
  const normalized = String(value ?? 'benjamini-hochberg').toLowerCase()
  if (normalized === 'bonferroni') return 'bonferroni'
  if (normalized === 'none') return 'none'
  return 'benjamini-hochberg'
}

const serviceCorrectionMethod = (correction: EnrichmentCorrection): string =>
  correction === 'bonferroni' ? 'bonferroni' : correction === 'none' ? 'none' : 'fdr'

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((entry) => String(entry).trim()).filter((entry) => entry !== '') : []

export const GENES_GPROFILER_TOOLS: ToolDescriptor[] = [
  {
    id: 'gene_set_enrichment',
    connector: 'genes',
    description:
      'Gene-set enrichment (GO terms / pathways) for a gene list. Offline mode: pass `annotation` (an array of {term, name?, genes}) and everything is computed locally — hypergeometric p, the named multiple-testing correction, fold enrichment — with the background stated in the result. Service mode: pass only `genes` and g:Profiler is queried, after which every returned term is recomputed locally from the sizes the service reports and any row where the two p-values disagree is listed in `mismatches` with both numbers. Add `background_genes` (a user universe) or `background_size` (a declared one) whenever the default background is not what you mean; the answer always says which background and which correction produced it.',
    input: {
      type: 'object',
      properties: {
        genes: { type: 'array', items: { type: 'string' }, description: 'Query genes (symbols).' },
        annotation: {
          type: 'array',
          description:
            'Offline mode: terms with their member genes. When given, no network call is made.',
          items: {
            type: 'object',
            properties: {
              term: { type: 'string' },
              name: { type: 'string' },
              genes: { type: 'array', items: { type: 'string' } }
            },
            required: ['term', 'genes']
          }
        },
        background_genes: { type: 'array', items: { type: 'string' } },
        background_size: { type: 'number', description: 'Declared background size when no gene list is given.' },
        organism: { type: 'string', description: 'Default "hsapiens".' },
        sources: { type: 'array', items: { type: 'string' }, description: 'Default GO:BP, GO:MF, GO:CC, KEGG, REAC.' },
        correction: {
          type: 'string',
          enum: ['benjamini-hochberg', 'bonferroni', 'none'],
          description: 'Default benjamini-hochberg.'
        },
        alpha: { type: 'number', description: 'Significance threshold, default 0.05.' },
        min_overlap: { type: 'number', description: 'Skip terms with fewer overlapping genes, default 1.' }
      },
      required: ['genes']
    },
    returns:
      'Offline -> {mode:"offline", background:{...}, correction:{...}, results:[{term,name,overlap,termSize,foldEnrichment,pValue,adjustedP,genes}], counts, summary:{zh,notes}}. Service -> {mode:"service", service:{terms_returned, correction}, background, correction, results:[{term,name,source,p_value_service,p_value_local,agrees,term_size,intersection_size}], mismatches:[...], summary:{zh,notes}}.',
    example:
      'const result = await host.mcp("genes", "gene_set_enrichment", {"genes": ["TP53", "BRCA1"], "correction": "benjamini-hochberg"})',
    run: async (ctx: ToolContext, a: Record<string, unknown>) => {
      const genes = stringList(a.genes)
      if (genes.length === 0) throw new Error('gene_set_enrichment needs at least one gene.')

      const correction = asCorrection(a.correction)
      const alpha = typeof a.alpha === 'number' && a.alpha > 0 && a.alpha <= 1 ? a.alpha : 0.05
      const minOverlap = typeof a.min_overlap === 'number' && a.min_overlap > 0 ? a.min_overlap : 1
      const backgroundGenes = stringList(a.background_genes)
      const declaredSize = typeof a.background_size === 'number' ? a.background_size : undefined
      const annotation = Array.isArray(a.annotation) ? a.annotation : undefined

      // ---- offline: the annotation is the input, and nothing leaves the machine ---------------------
      if (annotation) {
        const terms: EnrichmentTermInput[] = annotation.map((raw) => {
          const entry = raw as { term?: unknown; name?: unknown; genes?: unknown }
          return {
            term: String(entry.term ?? ''),
            ...(entry.name === undefined ? {} : { name: String(entry.name) }),
            genes: stringList(entry.genes)
          }
        })
        const outcome = runGeneSetEnrichment({
          genes,
          terms,
          background:
            backgroundGenes.length > 0
              ? { kind: 'user', genes: backgroundGenes, description: '调用方提供的背景基因集' }
              : {
                  kind: 'declared-size',
                  size: declaredSize ?? 0,
                  description:
                    declaredSize === undefined
                      ? '未声明背景大小（结果中的 p 值不可用）'
                      : '调用方声明的背景大小'
                },
          correction,
          alpha,
          minOverlap
        })
        return { mode: 'offline', network: false, ...outcome }
      }

      // ---- service: ask g:Profiler, then check its arithmetic against ours ------------------------
      const body = {
        organism: typeof a.organism === 'string' && a.organism !== '' ? a.organism : 'hsapiens',
        query: genes,
        sources: stringList(a.sources).length > 0 ? stringList(a.sources) : [...DEFAULT_SOURCES],
        user_threshold: alpha,
        significance_threshold_method: serviceCorrectionMethod(correction),
        no_evidences: true,
        ...(backgroundGenes.length > 0 ? { domain_scope: 'custom', background: backgroundGenes } : {})
      }
      const raw = (await ctx.postJson(GPROFILER_BASE, body)) as { result?: GprofilerRow[] }
      const rows = Array.isArray(raw.result) ? raw.result : []

      const results: Record<string, unknown>[] = []
      const mismatches: Record<string, unknown>[] = []
      for (const row of rows) {
        const term = String(row.native ?? row.name ?? '').trim()
        if (term === '') continue
        const intersection = Number(row.intersection_size)
        const termSize = Number(row.term_size)
        const querySize = Number(row.query_size)
        const domainSize = Number(row.effective_domain_size)
        const serviceP = Number(row.p_value)
        const computable = [intersection, termSize, querySize, domainSize].every((value) =>
          Number.isFinite(value)
        )
        // Fail closed: without all four sizes there is nothing to recompute, and saying so is the point.
        const localP = computable
          ? hypergeometricUpperTail(intersection, domainSize, termSize, querySize)
          : undefined
        const agrees =
          localP === undefined || !Number.isFinite(serviceP)
            ? false
            : Math.abs(localP - serviceP) <= P_VALUE_TOLERANCE * Math.max(1, serviceP)
        results.push({
          term,
          ...(row.name === undefined ? {} : { name: row.name }),
          ...(row.source === undefined ? {} : { source: row.source }),
          ...(Number.isFinite(serviceP) ? { p_value_service: serviceP } : {}),
          ...(localP === undefined ? {} : { p_value_local: localP }),
          agrees,
          recomputed: computable,
          term_size: termSize,
          intersection_size: intersection,
          query_size: querySize,
          effective_domain_size: domainSize
        })
        if (computable && !agrees) {
          mismatches.push({ term, p_value_service: serviceP, p_value_local: localP })
        }
      }

      const notes = [
        '服务端结果已按它自己报告的四个整数在本地重算；agrees=false 的行说明两侧 p 值不一致。',
        correction === 'none'
          ? '未做多重检验校正：服务端返回的是原始 p 值。'
          : `多重检验校正：${correction}（请求以服务端的 ${serviceCorrectionMethod(correction)} 提交）。`
      ]
      if (results.some((row) => row.recomputed === false)) {
        notes.push('部分条目缺少重算所需的尺寸字段，本地无法复算（recomputed=false），未计一致性。')
      }
      if (backgroundGenes.length > 0) {
        notes.push('背景由调用方提供（domain_scope=custom），已随请求提交。')
      } else {
        notes.push('背景为 g:Profiler 的默认注释域；若与研究设计不符，请显式给 background_genes。')
      }
      if (declaredSize !== undefined) {
        notes.push('本次请求未使用 background_size：服务模式只用 background_genes 或默认域。')
      }

      return {
        mode: 'service',
        network: true,
        service: { termsReturned: rows.length, correction: serviceCorrectionMethod(correction) },
        background: {
          kind: backgroundGenes.length > 0 ? 'user' : 'service-default',
          size: backgroundGenes.length > 0 ? backgroundGenes.length : null,
          source: backgroundGenes.length > 0 ? 'user' : 'declared'
        },
        correction: { method: correction, alpha, applied: correction !== 'none' },
        recomputable: { method: 'hypergeometric', tail: 'greater', where: 'local' },
        results,
        mismatches,
        summary: {
          zh: `服务端返回 ${rows.length} 个条目，本地按同样四个整数复算，${results.filter((row) => row.agrees).length} 个一致、${mismatches.length} 个不一致。校正方式：${correction}，α=${alpha}。`,
          notes
        }
      }
    }
  }
]
