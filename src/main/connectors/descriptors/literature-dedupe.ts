// Deduplication for the multi-source literature search.
//
// One work can arrive from more than one source (arXiv and the OpenAlex graph overlap heavily for
// preprints), and the merged list used to count it twice — so `total_records` over-reported, and a
// reader scrolling the list saw the same paper twice under two source tags.
//
// The rules are deliberately conservative. A false merge deletes a real paper from the answer, which a
// reader cannot detect; a missed merge only costs a duplicated row, which is visible. So:
//
//   * DOI match wins when BOTH sides carry a DOI — the strongest identity available.
//   * Title match is the fallback for everything else: it requires the normalised titles to be equal AND
//     the years to be compatible (equal, or unknown on one side) AND that the two rows do not carry two
//     different DOIs (different DOIs on one title are different works: "Faculty Opinions recommendation of
//     X" series, publisher "Supplementary Data" records, an erratum and its article). When the folded row
//     is the one that has the DOI, the DOI is carried onto the kept row.
//   * Very short titles are never merged ("Editorial", "Introduction", "Correction").
//   * Nothing is merged on author lists, abstracts or fuzzy similarity.
//
// The kept record is the first one seen; the others are named on it under `also_in`, so the reader can
// still tell that the other source had it, and with which id.

export interface LiteratureDuplicateSource {
  source: string
  id: string | null
}

export interface LiteratureDedupeOutcome<T> {
  records: T[]
  /** Rows handed in, before merging. */
  before: number
  /** Rows returned. Always equals `records.length`. */
  after: number
  /** `before - after` — the number of rows that were folded into another one. */
  removed: number
  /** How many of those folds were decided by DOI. */
  byDoi: number
  /** How many of those folds were decided by title + year. */
  byTitle: number
}

/** Minimum normalised title length that may be merged on title alone (Latin script). */
const MIN_TITLE_KEY_LENGTH = 12
/**
 * Han-ideograph titles carry far more information per character, so the same guard is expressed as a
 * smaller count — 6 ideographs is already a specific title ("基于碱基编辑的基因治疗"), while "综述" is not.
 */
const MIN_TITLE_KEY_HAN = 6

/** DOI -> bare lowercase form: strips `https://doi.org/`, `http://dx.doi.org/`, `doi:` and case. */
export function bareDoiKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const bare = value
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .trim()
    .toLowerCase()
  return bare.length > 0 ? bare : null
}

/**
 * Title -> comparison key: lowercase, diacritics dropped, everything that is not a letter or digit
 * collapsed to a single space. Unicode-aware on purpose — Chinese titles must key correctly too.
 */
export function titleKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const folded = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  const hanCharacters = (folded.match(/\p{Script=Han}/gu) ?? []).length
  return folded.length >= MIN_TITLE_KEY_LENGTH || hanCharacters >= MIN_TITLE_KEY_HAN ? folded : null
}

/** Year of a record: `publication_year` when numeric, else the 4-digit year of `published`. */
export function recordYear(record: Record<string, unknown>): number | null {
  const direct = record.publication_year
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct
  if (typeof direct === 'string' && /^\d{4}$/.test(direct.trim())) return Number(direct.trim())
  const published = record.published
  if (typeof published === 'string') {
    const match = /^(\d{4})-/.exec(published.trim())
    if (match) return Number(match[1])
  }
  return null
}

const recordId = (record: Record<string, unknown>): string | null => {
  for (const field of ['arxiv_id', 'openalex_id', 'pmid', 'id']) {
    const value = record[field]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return null
}

/** Years are compatible when they are equal, or one side simply does not say. */
const yearsCompatible = (a: number | null, b: number | null): boolean =>
  a === null || b === null || a === b

/**
 * Folds records that describe the same work. Input order is preserved: the first occurrence of a work
 * keeps its position, and later occurrences are named on it under `also_in`.
 */
export function dedupeLiteratureRecords<T extends Record<string, unknown>>(
  records: readonly T[]
): LiteratureDedupeOutcome<T> {
  const kept: T[] = []
  const duplicates = new Map<number, LiteratureDuplicateSource[]>()
  const doiIndex = new Map<string, number>()
  const titleIndex = new Map<string, number[]>()
  let byDoi = 0
  let byTitle = 0

  const fold = (index: number, record: Record<string, unknown>): void => {
    const list = duplicates.get(index) ?? []
    list.push({ source: String(record.source ?? 'unknown'), id: recordId(record) })
    duplicates.set(index, list)
    // A work that arrives once with a DOI and once without it must leave the fold WITH the DOI: the
    // identifier is the more useful of the two, and dropping it would make the kept row less citable
    // than the row it replaced.
    const keptRecord = kept[index]
    if (keptRecord && !bareDoiKey(keptRecord.doi)) {
      const carried = bareDoiKey(record.doi)
      if (carried) {
        kept[index] = { ...keptRecord, doi: carried }
        doiIndex.set(carried, index)
      }
    }
  }

  records.forEach((record) => {
    const doi = bareDoiKey(record.doi)
    if (doi) {
      const existing = doiIndex.get(doi)
      if (existing !== undefined) {
        fold(existing, record)
        byDoi += 1
        return
      }
    }

    const key = titleKey(record.title)
    const year = recordYear(record)
    if (key) {
      // Title is the fallback identity: it fires when the DOI is absent on either side (arXiv reports the
      // journal DOI, not the arXiv DOI, so a preprint present in both sources often has a DOI on only one
      // side). Years must be compatible, so reprints stay separate.
      for (const index of titleIndex.get(key) ?? []) {
        const candidate = kept[index]
        if (!candidate) continue
        if (!yearsCompatible(recordYear(candidate), year)) continue
        // Two DIFFERENT DOIs on the same title are two different works (a "Faculty Opinions recommendation
        // of X" series, publisher "Supplementary Data" records, an erratum and its article). Only a side
        // that has no DOI may be folded on title alone.
        const candidateDoi = bareDoiKey(candidate.doi)
        if (doi && candidateDoi && doi !== candidateDoi) continue
        fold(index, record)
        byTitle += 1
        return
      }
    }

    const position = kept.length
    kept.push(record)
    if (doi) doiIndex.set(doi, position)
    if (key) titleIndex.set(key, [...(titleIndex.get(key) ?? []), position])
  })

  const merged = kept.map((record, index) => {
    const folded = duplicates.get(index)
    return folded && folded.length > 0 ? { ...record, also_in: folded } : record
  })

  return {
    records: merged,
    before: records.length,
    after: merged.length,
    removed: records.length - merged.length,
    byDoi,
    byTitle
  }
}
