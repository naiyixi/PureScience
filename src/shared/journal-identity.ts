// Journal identity normalization (R2). Shared, because two layers have to agree on what "the same journal"
// is: the repository that stores journals, and the import path that decides whether a row's identifier and
// name are usable at all. Two copies of this rule would drift into two vocabularies, and a drifting identity
// rule silently changes which venue a number is attached to.

// Case, punctuation and whitespace only. Deliberately no fuzzy step (no stemming, no token sorting, no
// edit distance): those would merge "Nature" with "Nature Communications", which is a false fact. Diacritics
// are folded because "München" and "Munchen" are the same place spelled by two type systems, not two venues.
// Letters and numbers are kept in EVERY script, not just ASCII: an ASCII-only class folds
// "中国科学：生命科学" to the EMPTY string, which made every non-Latin venue unnameable. Found on the real
// machine — a table with the 期刊名称 header we map imported zero rows, each refused with "requires a usable
// venue name". Full-width and half-width punctuation both become a word boundary, so "中国科学：生命科学" and
// "中国科学:生命科学" are one journal spelled two ways, the same argument as the diacritics above.
export const normalizeJournalName = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining marks
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ') // anything that is not a letter or a number → word boundary
    .trim()
    .replace(/\s+/g, ' ')

// ISSNs arrive printed both as `1234-5679` and as `12345679`, and some sources carry an `issn:` prefix.
// Only a well-formed 8-character ISSN is accepted (7 digits + digit-or-X check digit); anything else is
// reported as absent rather than repaired, because a repaired identifier is a fabricated one.
export const normalizeIssn = (value: string | null | undefined): string | undefined => {
  if (!value) return undefined
  const cleaned = value
    .trim()
    .replace(/^issn[:\s]*/i, '')
    .replace(/\s+/g, '')
  const bare = cleaned.replace(/-/g, '')
  if (!/^\d{7}[\dX]$/i.test(bare)) return undefined

  return `${bare.slice(0, 4)}-${bare.slice(4)}`.toUpperCase()
}
