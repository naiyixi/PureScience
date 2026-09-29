import type { Reference } from '../../shared/references'

// A bounded, key-addressed cache of the PDF body text one reference's decision is assembled from.
//
// Why this exists rather than a plain pass-through: the panel that shows a collection's screening reads
// every member's evidence to state its freshness reasons (which is the only honest way to say
// 'input-changed'), and it does that again on every progress poll while a pass is running. Re-extracting
// each PDF per poll would turn a 4-second pass into minutes of redundant parsing — and the extractor
// WRITES a parsed document per call, so repeating it also grows the storage root.
//
// The key is the record's own content identity — id, updatedAt, the attached managed file and its
// content fingerprint. Any of those changing is a different key, so a re-attached, re-fingerprinted or
// edited record is never served stale text. The fingerprint is what makes an in-place file swap visible
// without a restart.
export type ScreeningFullTextReader = (reference: Reference) => Promise<string | null>

export type ScreeningFullTextCache = {
  /** Reads through the cache; `null` means "no readable text on hand", never an error. */
  read: ScreeningFullTextReader
  /** Drops one record's entry — used after a pass so the next read sees what the run just read. */
  forget: (referenceId: string) => void
  size: () => number
}

export const screeningFullTextCacheKey = (reference: Reference): string =>
  [
    reference.id,
    reference.updatedAt,
    reference.pdfManagedFileId ?? 'none',
    reference.pdfContentHash ?? 'unhashed'
  ].join('|')

export const createScreeningFullTextCache = (
  read: ScreeningFullTextReader,
  maxEntries = 128
): ScreeningFullTextCache => {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error(
      `The screening full-text cache needs a positive size, got ${String(maxEntries)}.`
    )
  }
  // Insertion-ordered, so the oldest key is the first entry — enough for a bounded cache whose entries
  // are all equally cheap to rebuild.
  const entries = new Map<string, Promise<string | null>>()

  const readThrough: ScreeningFullTextReader = async (reference) => {
    const key = screeningFullTextCacheKey(reference)
    const cached = entries.get(key)
    if (cached) return cached
    // The promise is cached, not its value: four concurrent records asking for the same text share one
    // extraction, and a rejection is evicted so a transient read failure is retried rather than
    // remembered forever.
    const pending = read(reference).catch((error: unknown) => {
      entries.delete(key)
      throw error
    })
    entries.set(key, pending)
    if (entries.size > maxEntries) {
      const oldest = entries.keys().next()
      if (!oldest.done && oldest.value !== key) entries.delete(oldest.value)
    }
    return pending
  }

  return {
    read: readThrough,
    forget: (referenceId) => {
      for (const key of [...entries.keys()]) {
        if (key.startsWith(`${referenceId}|`)) entries.delete(key)
      }
    },
    size: () => entries.size
  }
}
