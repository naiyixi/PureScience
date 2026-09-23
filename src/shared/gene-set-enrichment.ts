// Gene-set enrichment, computed here rather than taken on trust.
//
// The point of this module is the audit's third requirement: an enrichment result must be recomputable
// offline. So the arithmetic is local and complete — hypergeometric tail probability, a multiple-testing
// correction, and the effect size — and the result carries the two facts a reader needs to judge it: which
// background set was used (user-supplied or an explicitly declared size) and which correction was applied
// at which threshold. A bare p-value without those two is not a result, it is a number.
//
// Everything here is pure. The the services are the caller's problem; this file only has to be right.

export type EnrichmentBackground =
  | { kind: 'user'; genes: readonly string[]; description?: string }
  | { kind: 'declared-size'; size: number; description: string }

export type EnrichmentCorrection = 'benjamini-hochberg' | 'bonferroni' | 'none'

export type EnrichmentTermInput = {
  term: string
  /** The term's own name, when the source has one. Never translated here — see `summary.notes`. */
  name?: string
  genes: readonly string[]
}

export type EnrichmentInput = {
  genes: readonly string[]
  terms: readonly EnrichmentTermInput[]
  background: EnrichmentBackground
  correction: EnrichmentCorrection
  alpha: number
  /** Overlaps below this are not tested at all, and the count is reported. Defaults to 1. */
  minOverlap?: number
}

export type EnrichmentRow = {
  term: string
  name?: string
  /** Query genes that are in this term. */
  overlap: number
  /** Genes annotated to this term, within the background. */
  termSize: number
  querySize: number
  backgroundSize: number
  /** (overlap / querySize) / (termSize / backgroundSize); 0 when the term has nothing to divide by. */
  foldEnrichment: number
  /** Hypergeometric upper-tail probability: P(X >= overlap). */
  pValue: number
  /** After the declared correction. Equals `pValue` when the correction is 'none'. */
  adjustedP: number
  genes: string[]
}

export type EnrichmentOutcome = {
  background: {
    kind: EnrichmentBackground['kind']
    size: number
    description: string
    /** Which of the two the caller gave, said plainly so a report can quote it. */
    source: 'user' | 'declared'
  }
  correction: { method: EnrichmentCorrection; alpha: number; applied: boolean }
  recomputable: { method: 'hypergeometric'; tail: 'greater'; where: 'local' }
  results: EnrichmentRow[]
  counts: {
    terms: number
    tested: number
    significant: number
    skippedBelowMinOverlap: number
    queryGenes: number
    queryGenesInBackground: number
    queryGenesOutsideBackground: number
    duplicatesInQuery: number
  }
  /** A Chinese one-paragraph reading of the result, and the caveats that belong beside it. */
  summary: { zh: string; notes: string[] }
}

// ---- the arithmetic ---------------------------------------------------------------------------

// Lanczos approximation; enough digits for the sizes a gene list can reach.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7
] as const

export const logGamma = (value: number): number => {
  if (value < 0.5) {
    // Reflection formula keeps the series in its region of validity.
    return Math.log(Math.PI / Math.sin(Math.PI * value)) - logGamma(1 - value)
  }
  const z = value - 1
  let x = LANCZOS[0]
  for (let index = 1; index < LANCZOS.length; index += 1) x += LANCZOS[index] / (z + index)
  const t = z + LANCZOS.length - 1.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
}

export const logChoose = (n: number, k: number): number => {
  if (k < 0 || k > n) return Number.NEGATIVE_INFINITY
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1)
}

// P(X >= overlap) for X ~ Hypergeometric(backgroundSize, termSize, querySize). Summed in log space with a
// running log-sum-exp so a small tail does not collapse to zero before it is scaled.
export const hypergeometricUpperTail = (
  overlap: number,
  backgroundSize: number,
  termSize: number,
  querySize: number
): number => {
  const upper = Math.min(termSize, querySize)
  if (overlap <= 0) return 1
  if (overlap > upper) return 0
  let acc = Number.NEGATIVE_INFINITY
  for (let hits = overlap; hits <= upper; hits += 1) {
    const term = logChoose(termSize, hits) + logChoose(backgroundSize - termSize, querySize - hits)
    if (!Number.isFinite(term)) continue
    acc =
      acc === Number.NEGATIVE_INFINITY
        ? term
        : Math.max(acc, term) + Math.log1p(Math.exp(-Math.abs(acc - term)))
  }
  const total = logChoose(backgroundSize, querySize)
  if (!Number.isFinite(acc) || !Number.isFinite(total)) return Number.NaN
  return Math.min(1, Math.exp(acc - total))
}

const adjust = (pValues: readonly number[], method: EnrichmentCorrection): number[] => {
  if (method === 'none') return [...pValues]
  const total = pValues.length
  if (method === 'bonferroni') return pValues.map((value) => Math.min(1, value * total))
  // Benjamini–Hochberg, enforced monotone from the largest p upwards so the adjusted values never
  // increase as the raw p-values decrease.
  const order = pValues
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value)
  const adjusted = new Array<number>(total).fill(1)
  let running = 1
  for (let position = total - 1; position >= 0; position -= 1) {
    const { value, index } = order[position]
    running = Math.min(running, (value * total) / (position + 1))
    adjusted[index] = Math.min(1, running)
  }
  return adjusted
}

const CORRECTION_LABEL: Record<EnrichmentCorrection, string> = {
  'benjamini-hochberg': 'Benjamini–Hochberg FDR',
  bonferroni: 'Bonferroni',
  none: '未校正'
}

const formatP = (value: number): string => {
  if (!Number.isFinite(value)) return '不可计算'
  if (value === 0) return '<1e-300'
  if (value < 0.001) return value.toExponential(2)
  return value.toFixed(4)
}

export const runGeneSetEnrichment = (input: EnrichmentInput): EnrichmentOutcome => {
  const minOverlap = input.minOverlap ?? 1
  const notes: string[] = []

  const backgroundGenes = input.background.kind === 'user' ? input.background.genes : undefined
  const backgroundSet = backgroundGenes ? new Set(backgroundGenes) : undefined
  const backgroundSize =
    input.background.kind === 'user' ? (backgroundSet?.size ?? 0) : input.background.size
  const backgroundDescription =
    input.background.kind === 'user'
      ? (input.background.description ?? '调用方提供的背景基因集')
      : input.background.description

  const seen = new Set<string>()
  const query: string[] = []
  let duplicatesInQuery = 0
  for (const gene of input.genes) {
    const key = gene.trim()
    if (key === '') continue
    if (seen.has(key)) {
      duplicatesInQuery += 1
      continue
    }
    seen.add(key)
    query.push(key)
  }
  const queryInBackground = backgroundSet ? query.filter((gene) => backgroundSet.has(gene)) : query
  const outsideBackground = query.length - queryInBackground.length
  if (outsideBackground > 0) {
    notes.push(`查询基因中有 ${outsideBackground} 个不在背景集内，它们不参与本次计算。`)
  }
  const duplicatesInQueryNote = duplicatesInQuery
  if (duplicatesInQuery > 0)
    notes.push(`查询列表里有 ${duplicatesInQuery} 个重复基因，已按一次计。`)

  const querySize = queryInBackground.length
  const tested: EnrichmentRow[] = []
  let skippedBelowMinOverlap = 0

  for (const term of input.terms) {
    const termGenes = backgroundSet
      ? term.genes.filter((gene) => backgroundSet.has(gene.trim()))
      : term.genes
    const termSet = new Set(termGenes.map((gene) => gene.trim()).filter((gene) => gene !== ''))
    const overlapGenes = queryInBackground.filter((gene) => termSet.has(gene))
    if (overlapGenes.length < minOverlap) {
      skippedBelowMinOverlap += 1
      continue
    }
    const pValue = hypergeometricUpperTail(
      overlapGenes.length,
      backgroundSize,
      termSet.size,
      querySize
    )
    const expected = backgroundSize > 0 ? (querySize * termSet.size) / backgroundSize : 0
    tested.push({
      term: term.term,
      ...(term.name === undefined ? {} : { name: term.name }),
      overlap: overlapGenes.length,
      termSize: termSet.size,
      querySize,
      backgroundSize,
      foldEnrichment: expected > 0 ? overlapGenes.length / expected : 1,
      pValue,
      adjustedP: pValue, // replaced below, once every raw p-value is known
      genes: overlapGenes
    })
  }

  const adjusted = adjust(
    tested.map((row) => row.pValue),
    input.correction
  )
  tested.forEach((row, index) => {
    row.adjustedP = adjusted[index]
  })
  tested.sort((left, right) => left.adjustedP - right.adjustedP || left.pValue - right.pValue)

  const significant = tested.filter((row) => row.adjustedP <= input.alpha)
  if (skippedBelowMinOverlap > 0) {
    notes.push(`有 ${skippedBelowMinOverlap} 个条目因重叠基因数少于 ${minOverlap} 而未参与检验。`)
  }
  if (input.correction === 'none') {
    notes.push('未做多重检验校正：下表是原始 p 值，不能直接按 0.05 判显著。')
  }
  if (backgroundSize <= 0) {
    notes.push('背景集为空，p 值无意义；请给出背景基因集或明确的背景大小。')
  }
  notes.push('条目名称按来源原样保留，未做中文翻译；中文说明只描述本地的统计结果。')

  const strongest = significant[0]
  const summaryZh =
    `在 ${querySize} 个查询基因、背景 ${backgroundSize}（${backgroundDescription}）下，` +
    `共检验 ${tested.length} 个条目，${significant.length} 个通过 ${CORRECTION_LABEL[input.correction]} 校正（α=${input.alpha}）` +
    (strongest
      ? `；最强为 ${strongest.name ?? strongest.term}（重叠 ${strongest.overlap}/${querySize}，富集 ${strongest.foldEnrichment.toFixed(2)}×，校正后 p=${formatP(strongest.adjustedP)}）。`
      : '。')

  return {
    background: {
      kind: input.background.kind,
      size: backgroundSize,
      description: backgroundDescription,
      source: input.background.kind === 'user' ? 'user' : 'declared'
    },
    correction: {
      method: input.correction,
      alpha: input.alpha,
      applied: input.correction !== 'none'
    },
    recomputable: { method: 'hypergeometric', tail: 'greater', where: 'local' },
    results: tested,
    counts: {
      terms: input.terms.length,
      tested: tested.length,
      significant: significant.length,
      skippedBelowMinOverlap,
      queryGenes: query.length,
      queryGenesInBackground: querySize,
      queryGenesOutsideBackground: outsideBackground,
      duplicatesInQuery: duplicatesInQueryNote
    },
    summary: { zh: summaryZh, notes }
  }
}
