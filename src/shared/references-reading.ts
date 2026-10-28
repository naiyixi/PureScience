// Reading state of a library record (B3): unread / reading / read.
//
// Why three values and not a boolean: `reading` is a different instruction from `unread` ("continue" versus
// "start"), and the callout this feature exists for — a record the manuscript cites but nobody has read —
// must not count a record someone is halfway through as untouched. A record with no stored value is
// `unread`: the column is additive, so every record imported before this layer keeps its meaning.

export const REFERENCE_READING_STATUSES = ['unread', 'reading', 'read'] as const

export type ReferenceReadingStatus = (typeof REFERENCE_READING_STATUSES)[number]

/** The library's filter: three states, `any` so the control can be cleared, and the callout's own view —
 *  "cited but not read" — which is not the same set as `unread` (a record someone is halfway through is
 *  cited and not read, yet it is not unread). Count and filter therefore use one predicate. */
export type ReferenceReadingFilter = 'any' | ReferenceReadingStatus | 'cited-not-read'

export const referenceReadingStatusOf = (
  value: string | null | undefined
): ReferenceReadingStatus =>
  (REFERENCE_READING_STATUSES as readonly string[]).includes(value ?? '')
    ? (value as ReferenceReadingStatus)
    : 'unread'

/** What the callout counts: cited by the manuscript, and not yet read. `reading` counts — it is not read. */
export const isCitedNotRead = (row: {
  citedAt?: number | null
  readingStatus?: string | null
}): boolean => row.citedAt != null && referenceReadingStatusOf(row.readingStatus) !== 'read'

export const countCitedNotRead = (
  rows: readonly { citedAt?: number | null; readingStatus?: string | null }[]
): number => rows.reduce((total, row) => (isCitedNotRead(row) ? total + 1 : total), 0)

/** The library's one filter predicate, so the toolbar and the callout cannot disagree about what it shows. */
export const matchesReadingFilter = (
  row: { readingStatus?: string | null; citedAt?: number | null },
  filter: ReferenceReadingFilter
): boolean => {
  if (filter === 'any') return true
  if (filter === 'cited-not-read') return isCitedNotRead(row)
  return referenceReadingStatusOf(row.readingStatus) === filter
}
