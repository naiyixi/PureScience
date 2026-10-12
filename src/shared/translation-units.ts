// Paragraph-level translation units and the resume plan for Chinese literature translation.
//
// A translated document is a *record per source paragraph*, never a blob: each record carries the paragraph's
// identity (stable id + page) and a hash of the source text it was produced from. That is what makes a resumed
// run honest — a record can only be reused when the source it was made from is byte-identical, so a paragraph
// that changed is re-translated instead of being reported as done.
//
// Nothing here touches node:crypto (this module is shared with the renderer, which never hashes): the recipe is
// published as constants plus `translationSourceHashInput`, and the main process performs the digest. Anyone
// holding a unit can therefore recompute the same hash outside the app.

export const TRANSLATION_RECORD_SCHEMA_VERSION = 1

// Published recipe: sha256 over UTF-8 of
//   `${TRANSLATION_SOURCE_HASH_RECIPE}\n${unitId}\n${normalizeTranslationSource(text)}\n`
// Terminated by a newline, and the recipe line is part of the input so a hash can never be confused with a
// digest computed for a different purpose over the same text.
export const TRANSLATION_SOURCE_HASH_RECIPE = 'purescience-translation-source-v1'

// A paragraph longer than this is split into parts, so no single unit can grow past what one request can carry.
export const TRANSLATION_UNIT_MAX_CHARS = 1200

export type TranslationUnit = {
  /** Stable, human-readable identity: `p<page>#<paragraph>` or `p<page>#<paragraph>.<part>`. */
  id: string
  page: number
  /** 1-based index of the paragraph inside its page. */
  paragraph: number
  /** 1-based index of the part when a long paragraph was split; absent when the paragraph fits one unit. */
  part?: number
  text: string
}

export type TranslationRecord = {
  id: string
  page: number
  /** Hash of the source text this record was produced from (see the recipe above). */
  sourceHash: string
  status: 'translated' | 'failed'
  /** Present only on `translated` records: never an empty string (an empty answer is a failure, not a result). */
  text?: string
  /** Named reason when `status` is `failed` — a bare boolean would lose why. */
  reason?: string
  updatedAt: number
}

export type TranslationReloadReason =
  // No record for this unit yet.
  | 'missing'
  // The paragraph changed since it was translated.
  | 'hash-changed'
  // A previous attempt failed and left no translation.
  | 'previous-attempt-failed'

export type TranslationPlan = {
  /** Units that still need a translation, each with why the stored record (if any) could not be reused. */
  toTranslate: { unit: TranslationUnit; reason: TranslationReloadReason }[]
  /** Units whose stored translation still matches the source — these are NOT re-sent. */
  reused: string[]
  /** Record ids with no unit in the current source (the document shrank): dropped, never silently kept. */
  removed: string[]
}

// Whitespace inside a unit is normalized before hashing and before sending, because a PDF text layer's line
// wrapping is not part of the sentence: re-extracting the same page with different wrapping must not look like
// an edit. Published so the digest is recomputable outside the app.
export const normalizeTranslationSource = (text: string): string => text.replace(/\s+/g, ' ').trim()

// The exact bytes a third party hashes to reproduce a record's `sourceHash`.
export const translationSourceHashInput = (unitId: string, text: string): string =>
  `${TRANSLATION_SOURCE_HASH_RECIPE}\n${unitId}\n${normalizeTranslationSource(text)}\n`

const splitLongParagraph = (text: string, maxChars: number): string[] => {
  const parts: string[] = []
  let rest = text
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    // Prefer a word boundary; fall back to a hard cut only when there is none (CJK text has no spaces).
    const boundary = window.lastIndexOf(' ')
    const cut = boundary > maxChars / 2 ? boundary : maxChars
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest !== '') parts.push(rest)
  return parts
}

/**
 * Splits one page's text layer into paragraph units. A page with no text yields zero units — that is a fact
 * about the page (no text layer) and is reported as such by the caller, never as an empty translation.
 */
export const segmentPageIntoTranslationUnits = (
  page: number,
  text: string,
  { maxChars = TRANSLATION_UNIT_MAX_CHARS }: { maxChars?: number } = {}
): TranslationUnit[] => {
  if (maxChars < 1) throw new Error('maxChars must be at least 1')
  const units: TranslationUnit[] = []
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => normalizeTranslationSource(paragraph))
    .filter((paragraph) => paragraph !== '')

  paragraphs.forEach((paragraph, index) => {
    const paragraphNumber = index + 1
    const parts = splitLongParagraph(paragraph, maxChars)
    if (parts.length <= 1) {
      units.push({
        id: `p${page}#${paragraphNumber}`,
        page,
        paragraph: paragraphNumber,
        text: paragraph
      })
      return
    }
    parts.forEach((part, partIndex) => {
      units.push({
        id: `p${page}#${paragraphNumber}.${partIndex + 1}`,
        page,
        paragraph: paragraphNumber,
        part: partIndex + 1,
        text: part
      })
    })
  })

  return units
}

/** Pages of the document that produced no unit at all — the pages with no usable text layer. */
export const pagesWithoutTranslationUnits = (
  pageCount: number,
  units: TranslationUnit[]
): number[] => {
  const seen = new Set(units.map((unit) => unit.page))
  const pages: number[] = []
  for (let page = 1; page <= pageCount; page += 1) if (!seen.has(page)) pages.push(page)
  return pages
}

/**
 * Decides, for the source as it stands now, which units must be sent and which stored translations still hold.
 * A record only counts as reusable when it is a successful translation whose source hash matches the current
 * text: a failed attempt and an edited paragraph both land in `toTranslate`, each with its own named reason.
 */
export const planTranslation = (
  units: TranslationUnit[],
  records: Record<string, TranslationRecord>,
  hashOf: (unit: TranslationUnit) => string
): TranslationPlan => {
  const plan: TranslationPlan = { toTranslate: [], reused: [], removed: [] }
  const seen = new Set<string>()

  for (const unit of units) {
    seen.add(unit.id)
    const record = records[unit.id]
    if (!record) {
      plan.toTranslate.push({ unit, reason: 'missing' })
      continue
    }
    if (record.status !== 'translated' || typeof record.text !== 'string' || record.text === '') {
      plan.toTranslate.push({ unit, reason: 'previous-attempt-failed' })
      continue
    }
    if (record.sourceHash !== hashOf(unit)) {
      plan.toTranslate.push({ unit, reason: 'hash-changed' })
      continue
    }
    plan.reused.push(unit.id)
  }

  for (const id of Object.keys(records)) if (!seen.has(id)) plan.removed.push(id)
  plan.removed.sort()

  return plan
}
