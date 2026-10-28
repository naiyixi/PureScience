// Citation discovery (B2): what a record cites, and who cites it — with a reason for every row.
//
// Why this module exists: the library could say what a record IS, but not where it sits in the
// literature. The two useful directions are "its references" and "the works citing it", and the
// second one is how a reader finds a result that came after the paper in hand.
//
// WHY THE CHINESE-SOURCE TEST IS THREE SIGNALS AND NOT ONE. Measured against OpenAlex on
// 2026-10-29: `filter=language:zh` returns 607,608 works, but the field is noisy — of the six
// most-cited works labelled `language: zh`, none had a Chinese title (a JAMA 1968 paper on coma,
// an Elsevier physics paper, a statistics guide, "Post-Fordism", …), and the top hit — a Chinese
// Medical Association article — carries an ENGLISH title with its DOI naming the journal. So a
// test that reads only `language` reports foreign papers as Chinese sources, and a test that reads
// only the title misses the largest Chinese publisher in the index. Each row therefore records
// WHICH criterion fired:
//
//   * `title-han`        — the title itself is written in Han characters (measured ratio 0.74–1.00
//                          on real Chinese titles, 0.00 on the mislabelled ones above).
//   * `doi-prefix`       — the DOI's registrant prefix belongs to a Chinese publisher. Only
//                          prefixes observed in a live query are listed; adding one without a probe
//                          would be a guess, and a guess here becomes a false claim on screen.
//   * `journal-language` — the journal record OpenAlex holds for the work says `zh`.
//
// The honest consequence: a work may be Chinese with none of the three firing (an English-titled
// paper from a Chinese group with no journal record). We report the signals, never a bare
// "Chinese / not Chinese" verdict.

export const CITATION_DIRECTIONS = ['references', 'citations'] as const

/** `references` = what this work cites; `citations` = the works that cite it. */
export type CitationDirection = (typeof CITATION_DIRECTIONS)[number]

/** Three states, because "we could not reach the index" is not "nothing cites this work". */
export type CitationDiscoveryStatus = 'found' | 'empty' | 'unavailable'

export type ChineseSourceSignal = 'title-han' | 'doi-prefix' | 'journal-language'

/** Registrant prefixes of Chinese publishers, each observed in a live OpenAlex query (2026-10-29):
 *  10.3760 / 10.3321 — Chinese Medical Association journals; 10.11946 — 中国科技期刊研究. */
export const CHINESE_DOI_PREFIXES: readonly string[] = ['10.3760', '10.3321', '10.11946']

/** A title counts as Han-written when at least this share of its visible characters are Han.
 *  Measured separation was wide (0.74+ versus 0.00), so the exact cut is not load-bearing. */
const HAN_TITLE_THRESHOLD = 0.3

/** The reasons a row can carry. Codes only: the surface owns the words (nine languages), so a
 *  translated sentence can never drift from the signal that produced it. */
export const CITATION_REASON_CODES = [
  'from-references',
  'cited-by-others',
  'chinese-title',
  'chinese-doi-prefix',
  'chinese-journal',
  'no-chinese-signal'
] as const

export type CitationReasonCode = (typeof CITATION_REASON_CODES)[number]

export type CitationCandidate = {
  /** OpenAlex work id without the URL part (e.g. `W2919115771`) — the stable handle. */
  openAlexId: string
  doi?: string
  title: string
  year?: number
  /** As the source labels it. Deliberately NOT part of the Chinese test: see the module comment. */
  language?: string
  /** Which criteria fired, in the fixed order of `ChineseSourceSignal`. */
  chineseSignals: ChineseSourceSignal[]
  /** The page a reader can open to judge the row themselves. */
  sourceUrl: string
}

export type CitationDiscoveryResult = {
  status: CitationDiscoveryStatus
  direction: CitationDirection
  referenceId: string
  /** The DOI the query ran on (normalized, lowercase, no resolver prefix). */
  doi: string
  /** What the source says the whole set is, when it says. `null` = it did not say. */
  total: number | null
  /** How many rows we actually read. The surface must be able to say "only the first N". */
  examined: number
  candidates: CitationCandidate[]
  /** Counted from `candidates`, not from `total`: it describes what is on screen. */
  chineseCount: number
  sourceUrl: string
  checkedAt: string
  /** True when a page of the walk failed and `candidates` is a partial read. */
  incomplete: boolean
  /** Named reason, present when `status === 'unavailable'` or when `incomplete`. */
  error?: string
}

const HAN = /\p{Script=Han}/u

/** Share of non-space characters that are Han. Zero for an empty title (no evidence, not "no Han"). */
export const hanRatio = (text: string): number => {
  const visible = Array.from(text.replace(/\s+/g, ''))
  if (visible.length === 0) return 0
  let han = 0
  for (const char of visible) if (HAN.test(char)) han += 1
  return han / visible.length
}

/** `10.3760/j:issn:…` → `10.3760`. Empty when the string does not start like a DOI. */
export const doiPrefix = (doi: string | null | undefined): string => {
  const match = (doi ?? '').trim().match(/^(10\.\d{4,9})\//)
  return match ? match[1] : ''
}

/** The registrant prefix, if it is one we have observed a Chinese publisher behind. */
export const chineseDoiPrefix = (doi: string | null | undefined): string => {
  const prefix = doiPrefix(doi)
  return CHINESE_DOI_PREFIXES.includes(prefix) ? prefix : ''
}

/** Every criterion that fired, in a fixed order so two runs on one row print the same reason. */
export const chineseSignalsFor = (row: {
  title?: string | null
  doi?: string | null
  journalLanguage?: string | null
}): ChineseSourceSignal[] => {
  const signals: ChineseSourceSignal[] = []
  if (hanRatio(row.title ?? '') >= HAN_TITLE_THRESHOLD) signals.push('title-han')
  if (chineseDoiPrefix(row.doi)) signals.push('doi-prefix')
  if ((row.journalLanguage ?? '').trim().toLowerCase() === 'zh') signals.push('journal-language')
  return signals
}

export const isChineseSource = (candidate: Pick<CitationCandidate, 'chineseSignals'>): boolean =>
  candidate.chineseSignals.length > 0

export const countChinese = (candidates: readonly CitationCandidate[]): number =>
  candidates.reduce((total, candidate) => (isChineseSource(candidate) ? total + 1 : total), 0)

/** The row's reason paragraph, as codes the surface translates and joins. The direction clause is
 *  always first, so a row can never be read outside the query that produced it. */
export const citationReasonCodes = (input: {
  direction: CitationDirection
  candidate: Pick<CitationCandidate, 'chineseSignals'>
}): CitationReasonCode[] => {
  const codes: CitationReasonCode[] = [
    input.direction === 'references' ? 'from-references' : 'cited-by-others'
  ]
  for (const signal of input.candidate.chineseSignals) {
    if (signal === 'title-han') codes.push('chinese-title')
    else if (signal === 'doi-prefix') codes.push('chinese-doi-prefix')
    else codes.push('chinese-journal')
  }
  if (input.candidate.chineseSignals.length === 0) codes.push('no-chinese-signal')
  return codes
}

export const isCitationDirection = (value: unknown): value is CitationDirection =>
  (CITATION_DIRECTIONS as readonly unknown[]).includes(value)
