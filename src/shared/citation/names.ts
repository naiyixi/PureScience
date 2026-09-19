// Author-name and locator helpers shared by every citation style.
//
// Name handling is deliberately script-aware: CJK names are printed verbatim (family name first, as
// captured) while Latin names are decomposed into family + given parts. We never re-case or
// transliterate a name: the record's own spelling wins.

const CJK_SCRIPT_RE = /[\u3400-\u9fff]/

export const hasCjkScript = (value: string): boolean => CJK_SCRIPT_RE.test(value)

export type ParsedName = {
  family: string
  given: string
  // True when the source already spelled the name family-first ("Zhang, Wei" or a CJK name), which
  // means the style must not re-order it.
  familyFirst: boolean
}

// Parses one recorded author name. Accepts "Given Family", "Family, Given", and CJK names.
export const parseAuthorName = (raw: string): ParsedName => {
  const name = raw.trim()
  if (!name) return { family: '', given: '', familyFirst: false }
  if (hasCjkScript(name)) return { family: name, given: '', familyFirst: true }

  const commaParts = name
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  if (commaParts.length >= 2) {
    return { family: commaParts[0], given: commaParts.slice(1).join(' '), familyFirst: true }
  }

  const words = name.split(/\s+/).filter(Boolean)
  if (words.length === 1) return { family: words[0], given: '', familyFirst: false }
  return {
    family: words[words.length - 1],
    given: words.slice(0, -1).join(' '),
    familyFirst: false
  }
}

// "Wei Zhang" -> "WZ" (Vancouver/AMA), "W. Z." (APA), "W. Z." with trailing dot handling done by the
// caller. `withPeriods` controls the dotted form; `joined` controls the separator.
export const initialsOf = (
  given: string,
  options: { withPeriods?: boolean; joined?: string } = {}
): string => {
  const words = given.split(/[\s-]+/).filter(Boolean)
  const separator = options.joined ?? (options.withPeriods ? ' ' : '')
  return words
    .map((word) => {
      const letter = word[0]?.toUpperCase() ?? ''
      return options.withPeriods ? `${letter}.` : letter
    })
    .filter(Boolean)
    .join(separator)
}

// APA / Chicago style: "Zhang, W." or "Zhang, W. J."
export const familyThenInitials = (name: ParsedName): string => {
  if (name.familyFirst || !name.given) return name.family
  const initials = initialsOf(name.given, { withPeriods: true, joined: ' ' })
  return initials ? `${name.family}, ${initials}` : name.family
}

// Vancouver / AMA style: "Zhang W" (no periods, no comma).
export const familyThenTightInitials = (name: ParsedName): string => {
  if (name.familyFirst || !name.given) return name.family
  return `${name.family} ${initialsOf(name.given).slice(0, 2)}`.trim()
}

// IEEE style: "W. Zhang".
export const initialsThenFamily = (name: ParsedName): string => {
  if (name.familyFirst || !name.given) return name.family
  return `${initialsOf(name.given, { withPeriods: true, joined: ' ' })} ${name.family}`
}

// Western author lists > N authors are truncated per style; `etAl` carries the style's own wording.
export const joinAuthorList = (
  authors: readonly { name: string }[],
  render: (name: ParsedName) => string,
  options: { max?: number; etAl?: string; delimiter?: string; finalDelimiter?: string } = {}
): string => {
  if (authors.length === 0) return ''
  const rendered = authors.map((author) => render(parseAuthorName(author.name)))
  const max = options.max ?? rendered.length
  const delimiter = options.delimiter ?? ', '
  const head = rendered.slice(0, max)
  if (rendered.length <= max) {
    if (rendered.length === 1 || !options.finalDelimiter) return rendered.join(delimiter)
    return `${rendered.slice(0, -1).join(delimiter)}${options.finalDelimiter}${rendered[rendered.length - 1]}`
  }
  return `${head.join(delimiter)}${options.etAl ?? ' et al.'}`
}

export const locatorFor = (item: {
  doi?: string
  arxivId?: string
  pmid?: string
  pmcid?: string
  url?: string
}): string => {
  if (item.doi?.trim()) return `https://doi.org/${item.doi.trim()}`
  if (item.arxivId?.trim()) return `https://arxiv.org/abs/${item.arxivId.trim()}`
  if (item.pmid?.trim()) return `https://pubmed.ncbi.nlm.nih.gov/${item.pmid.trim()}/`
  if (item.pmcid?.trim()) return `https://www.ncbi.nlm.nih.gov/pmc/articles/${item.pmcid.trim()}/`
  return item.url?.trim() ?? ''
}

// Drops empty segments and joins the survivors, so a missing field never leaves a dangling comma.
export const joinSegments = (segments: readonly (string | undefined)[], separator = ' '): string =>
  segments
    .map((segment) => segment?.trim() ?? '')
    .filter(Boolean)
    .join(separator)

export const volumeIssuePages = (
  item: CitationItemFields,
  format: { volumePrefix?: string; issuePrefix?: string; pagesPrefix?: string; separator?: string }
): string => {
  const volume = item.volume?.trim()
  const issue = item.issue?.trim()
  const pages = item.pages?.trim()
  if (!volume && !issue && !pages) return ''
  const volumePart = volume ? `${format.volumePrefix ?? ''}${volume}` : ''
  const issuePart = issue ? `${volumePart ? '' : ''}(${issue})` : ''
  const head = `${volumePart}${issuePart}`
  const pagesPart = pages ? `${format.pagesPrefix ?? ''}${pages}` : ''
  return joinSegments([head, pagesPart], format.separator ?? (head && pagesPart ? ', ' : ' '))
}

type CitationItemFields = {
  volume?: string
  issue?: string
  pages?: string
}
