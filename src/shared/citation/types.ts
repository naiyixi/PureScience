// Citation-style layer (v1.65 unit 1): one reference record can be rendered in several
// journal-ready styles, and an external CSL style can be imported — validated, attributed, and
// honest about what our engine does not support.
//
// Design rules that come from this repository's discipline rather than from the competitor:
//   1. A style never invents a field. Missing volume/pages simply drop the bracket that would hold
//      them; the format result reports the omission instead of printing a placeholder.
//   2. Anything we cannot render faithfully is named in `warnings` — silently-wrong output is the
//      one outcome that is never acceptable.
//   3. Imported styles keep their provenance (source, license, retrieval time) next to the style,
//      so a formatted list can always be traced back to the style document that produced it.

export type CitationItemType =
  | 'journal-article'
  | 'conference-paper'
  | 'preprint'
  | 'book'
  | 'chapter'
  | 'report'
  | 'dataset'
  | 'thesis'
  | 'web'
  | 'unknown'

// The field set the formatters may read. Everything is optional except the title: a library record
// that lacks a field renders as a shorter citation, never as a guessed one.
export type CitationItem = {
  title: string
  authors: readonly { name: string }[]
  containerTitle?: string
  year?: number
  volume?: string
  issue?: string
  pages?: string
  publisher?: string
  edition?: string
  doi?: string
  arxivId?: string
  pmid?: string
  pmcid?: string
  url?: string
  itemType?: CitationItemType
}

export type CitationFieldKey =
  'authors' | 'containerTitle' | 'year' | 'volume' | 'issue' | 'pages' | 'publisher' | 'doi'

export type CitationStyleFamily = 'numeric' | 'author-date'

export type CitationStyleSource = 'builtin' | 'imported'

// Provenance of an imported style document. `license` is required for imports: a style we cannot
// attribute is a style we do not install (same fail-closed rule as the skill trust contract).
export type CitationStyleProvenance = {
  fileName: string
  importedAt: number
  license: string
  sourceUrl?: string
  styleId?: string
  updated?: string
  defaultLocale?: string
  contentHash: string
}

export type CitationFormatContext = {
  // 1-based citation number for numeric styles; ignored by author-date styles.
  index?: number
  // Retrieval date (YYYY-MM-DD) for styles that print an access date for web-only records.
  retrievedAt?: string
}

export type CitationFormatResult = {
  text: string
  // Named, user-visible reasons why this render is not byte-faithful to the style's ideal output:
  // fields the record does not carry, and CSL constructs our engine skips. Empty means "faithful
  // within the field set the record provides".
  warnings: string[]
}

export type CitationStyleDefinition = {
  id: string
  label: string
  labelZh: string
  family: CitationStyleFamily
  locale: 'en' | 'zh'
  source: CitationStyleSource
  // Fields the style prints when present. Used by the UI to explain what a record is missing.
  uses: readonly CitationFieldKey[]
  license?: string
  provenance?: CitationStyleProvenance
  unsupportedElements?: readonly string[]
  format: (item: CitationItem, context: CitationFormatContext) => CitationFormatResult
}
