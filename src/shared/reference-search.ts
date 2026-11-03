import type { Reference } from './references'

// The library list already carries every record (title, authors, venue, abstract snippet, identifiers), so the
// search box reads it in memory instead of adding a round-trip per keystroke — the same reason the reading
// filter lives here. What this module adds is the part a bare substring test cannot do: say *which field* a hit
// came from, so a match on the DOI is not presented as if it were a match on the title.
export type ReferenceSearchField = 'title' | 'authors' | 'venue' | 'doi' | 'year' | 'abstract'

export type ReferenceSearchMatch = {
  field: ReferenceSearchField
  // The field's own text, trimmed to a window around the hit. Shown next to the field name, so a reader can
  // judge the match without opening the record.
  snippet: string
}

export type ReferenceSearchResult = {
  reference: Reference
  score: number
  matches: ReferenceSearchMatch[]
}

// A title hit says more about what the record is than an abstract hit does, and an identifier hit is exact —
// those weights are the whole reason this is not `filter(includes)`.
const FIELD_WEIGHTS: Record<ReferenceSearchField, number> = {
  title: 6,
  doi: 6,
  authors: 4,
  year: 4,
  venue: 3,
  abstract: 2
}

const SNIPPET_RADIUS = 48

const fieldsOf = (reference: Reference): Array<{ field: ReferenceSearchField; text: string }> => {
  const fields: Array<{ field: ReferenceSearchField; text: string }> = [
    { field: 'title', text: reference.title ?? '' }
  ]
  const authors = (reference.authors ?? [])
    .map((author) => (typeof author === 'string' ? author : (author?.name ?? '')))
    .filter(Boolean)
    .join(', ')
  if (authors) fields.push({ field: 'authors', text: authors })
  if (reference.venue) fields.push({ field: 'venue', text: reference.venue })
  if (reference.doi) fields.push({ field: 'doi', text: reference.doi })
  if (reference.year !== undefined && reference.year !== null) {
    fields.push({ field: 'year', text: String(reference.year) })
  }
  if (reference.abstractSnippet) fields.push({ field: 'abstract', text: reference.abstractSnippet })
  return fields
}

const windowsAround = (text: string, index: number, length: number): string => {
  const start = Math.max(0, index - SNIPPET_RADIUS)
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end).trim()}${suffix}`
}

/** Splits into terms: whitespace separates, case is folded, duplicates collapse. A blank query searches nothing. */
export const referenceSearchTerms = (query: string): string[] => {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const raw of query.trim().toLowerCase().split(/\s+/)) {
    if (raw.length === 0 || seen.has(raw)) continue
    seen.add(raw)
    terms.push(raw)
  }
  return terms
}

/**
 * Every term has to hit somewhere (AND, not OR): typing `chen 2023` should not surface every record by Chen
 * from any year. Each term contributes the weight of the strongest field it hit (plus one per extra occurrence,
 * capped at two) — so a record that matches both title and abstract outranks one that only matches the abstract.
 */
export const searchReferences = (
  references: readonly Reference[],
  query: string
): ReferenceSearchResult[] => {
  const terms = referenceSearchTerms(query)
  if (terms.length === 0) return []

  const results: ReferenceSearchResult[] = []
  for (const reference of references) {
    const fields = fieldsOf(reference).map((entry) => ({
      ...entry,
      lower: entry.text.toLowerCase()
    }))
    let score = 0
    const matches = new Map<ReferenceSearchField, ReferenceSearchMatch>()
    let matchedEveryTerm = true

    for (const term of terms) {
      let bestWeight = 0
      let extraOccurrences = 0
      for (const field of fields) {
        const index = field.lower.indexOf(term)
        if (index === -1) continue
        const weight = FIELD_WEIGHTS[field.field]
        bestWeight = Math.max(bestWeight, weight)
        let count = 1
        let cursor = index
        while (count < 3) {
          const next = field.lower.indexOf(term, cursor + term.length)
          if (next === -1) break
          count += 1
          cursor = next
        }
        extraOccurrences = Math.max(extraOccurrences, count - 1)
        if (!matches.has(field.field)) {
          matches.set(field.field, {
            field: field.field,
            snippet: windowsAround(field.text.trim(), index, term.length)
          })
        }
      }
      if (bestWeight === 0) {
        matchedEveryTerm = false
        break
      }
      score += bestWeight + Math.min(extraOccurrences, 2)
    }

    if (!matchedEveryTerm) continue
    results.push({
      reference,
      score,
      matches: [...matches.values()].sort(
        (left, right) => FIELD_WEIGHTS[right.field] - FIELD_WEIGHTS[left.field]
      )
    })
  }

  return results.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    const leftYear = left.reference.year ?? -Infinity
    const rightYear = right.reference.year ?? -Infinity
    if (rightYear !== leftYear) return rightYear > leftYear ? 1 : -1
    return (left.reference.title ?? '').localeCompare(right.reference.title ?? '')
  })
}
