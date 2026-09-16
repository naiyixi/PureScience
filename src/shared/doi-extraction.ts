// DOIs as they appear in the wild: inside PDFs, they are wrapped in punctuation, split across line
// breaks, prefixed with a resolver URL, or followed by the next sentence without a space. A pattern
// that only matches the clean form finds almost none of them, and one that is too eager happily
// reports `10.1016/j.cell.2023.01.001.` as the DOI *including* the full stop.
//
// The rule here: find the canonical prefix (`10.` + a 4-9 digit registrant), take everything that can
// legitimately belong to a DOI suffix, and then trim the punctuation that belongs to the prose rather
// than to the identifier. Normalisation strips the resolver prefix and compares case-insensitively,
// because the same DOI cited two ways must not become two references.

/**
 * DOI suffix characters: letters, digits and the punctuation the standard allows inside a suffix.
 * Angle brackets are treated as delimiters rather than suffix characters: they do appear in one legacy
 * form (SICI), but the same characters also open markup, and swallowing `<a href=…` into an identifier
 * would produce a DOI that resolves to nothing (or, worse, to something else). A SICI DOI is therefore
 * captured up to its first angle bracket — a truncated identifier that fails to resolve and is reported
 * by name, instead of a fabricated one that appears to work.
 */
const DOI_CANDIDATE = /\b10\.\d{4,9}\/[^\s"'<>]+/g

/** Control characters never belong to a DOI; a stray one means the text layer is broken, not the suffix. */
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => character.charCodeAt(0) < 32)

/** Trailing characters that belong to the sentence, never to a DOI suffix. */
const TRAILING_PROSE = /[.,;:)\]}>'"]+$/
/** A closing bracket is part of the DOI when an opening one was part of it (e.g. `...10.1/x(y)`). */
const BRACKET_PAIRS: readonly [string, string][] = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}']
]

const trimTrailingProse = (candidate: string): string => {
  let value = candidate
  for (;;) {
    const withoutProse = value.replace(TRAILING_PROSE, '')
    if (withoutProse !== value) {
      value = withoutProse
      continue
    }
    const pair = BRACKET_PAIRS.find(([, close]) => value.endsWith(close))
    if (!pair) return value
    const [open, close] = pair
    // `(2020) 10.1/x(y` — an unbalanced closer is prose; a balanced one is part of the suffix.
    const opened = value.split(open).length - 1
    const closed = value.split(close).length - 1
    if (closed <= opened) return value
    value = value.slice(0, -1)
  }
}

/**
 * A suffix may contain dots (`10.1016/j.cell.2023.01.001`), so a trailing `.` alone is not a boundary —
 * but a dot followed by a capitalised word is: no real suffix ends in `.Jones`, and a PDF's text layer
 * happily glues the next sentence's first word onto the identifier when the line break is lost.
 */
const TRAILING_SENTENCE_WORD = /\.[A-Z][a-z]+$/
/**
 * A single capital that directly follows a digit or lowercase letter and is followed by whitespace and
 * a lowercase word is the next word's first letter, fused on by a lost line break (`…/abc1234A work`
 * is the identifier followed by `A work`). Two or more capitals, or a capital in the middle of a token,
 * are left alone: `10.1038/ABC123` is a real suffix shape.
 */
const SINGLE_FUSED_INITIAL = /[a-z0-9][A-Z]$/

/** Strips a resolver prefix (`https://doi.org/`, `doi:`) and trailing prose punctuation. */
export const normalizeDoi = (value: string): string => {
  const trimmed = value
    .trim()
    .replace(/^doi:\s*/i, '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
  return trimTrailingProse(trimmed)
}

/**
 * Every distinct DOI in a piece of text, in the order it appears. Duplicates that differ only by
 * resolver prefix or case collapse into the first form seen, so a PDF that cites the same paper twice
 * yields one entry.
 */
export const extractDois = (text: string | undefined | null): string[] => {
  if (!text) return []
  const seen = new Map<string, string>()
  for (const match of text.matchAll(DOI_CANDIDATE)) {
    let doi = normalizeDoi(match[0])
    // Text layers join lines without a space, so the identifier can end up fused to the next word. If
    // the character following the match begins a word (a lowercase letter), the capital letters it
    // swallowed were that word's start, not part of the suffix: `…/science.abc1234A work` is
    // `…/science.abc1234` followed by `A work`.
    // Whitespace, then a lowercase word: whatever capital the identifier swallowed was that word's
    // first letter (see SINGLE_FUSED_INITIAL).
    const following = text.slice(match.index + match[0].length)
    if (/^\s[a-z]/.test(following)) {
      doi = doi.replace(SINGLE_FUSED_INITIAL, (value) => value.slice(0, -1))
    }
    doi = doi.replace(TRAILING_SENTENCE_WORD, '')
    doi = normalizeDoi(doi)
    if (!isPlausibleDoi(doi)) continue
    const key = doi.toLowerCase()
    if (!seen.has(key)) seen.set(key, doi)
  }
  return [...seen.values()]
}

/**
 * A candidate is plausible when the canonical prefix survived trimming and the suffix still carries
 * something identifiable. `10.1016/` alone is a truncated match, not a DOI: reporting it would send a
 * resolver after a paper that cannot exist.
 */
export const isPlausibleDoi = (value: string): boolean => {
  if (hasControlCharacter(value)) return false
  const match = /^10\.(\d{4,9})\/(.+)$/.exec(value)
  if (!match) return false
  // The suffix needs at least one alphanumeric character; `---` or `.` is punctuation noise.
  return /[A-Za-z0-9]/.test(match[2])
}

/** Same paper, different citation form? Compare normalised. */
export const isSameDoi = (left: string, right: string): boolean =>
  normalizeDoi(left).toLowerCase() === normalizeDoi(right).toLowerCase()
