// The built-in citation styles.
//
// Every formatter is written against the recorded field set only: when a record has no volume, the
// volume slot disappears rather than printing "vol. " with nothing after it. Each style also declares
// `uses`, which drives the "this record is missing X" report the UI shows next to a formatted list.
//
// Warning tokens are machine-readable (`field:volume`, `style:no-access-date`) so the renderer can
// translate them; unknown tokens are surfaced verbatim rather than dropped.

import {
  familyThenInitials,
  familyThenTightInitials,
  hasCjkScript,
  initialsOf,
  initialsThenFamily,
  joinAuthorList,
  joinSegments,
  locatorFor,
  parseAuthorName,
  type ParsedName
} from './names'
import type {
  CitationFieldKey,
  CitationFormatContext,
  CitationFormatResult,
  CitationItem,
  CitationStyleDefinition
} from './types'

const missingFieldWarnings = (item: CitationItem, keys: readonly CitationFieldKey[]): string[] => {
  const present: Record<CitationFieldKey, boolean> = {
    authors: item.authors.length > 0,
    containerTitle: Boolean(item.containerTitle?.trim()),
    year: typeof item.year === 'number',
    volume: Boolean(item.volume?.trim()),
    issue: Boolean(item.issue?.trim()),
    pages: Boolean(item.pages?.trim()),
    publisher: Boolean(item.publisher?.trim()),
    doi: Boolean(item.doi?.trim())
  }
  return keys.filter((key) => !present[key]).map((key) => `field:${key}`)
}

const result = (text: string, warnings: readonly string[] = []): CitationFormatResult => ({
  text: text.trim(),
  warnings: [...warnings]
})

// ---- GB/T 7714-2015 (顺序编码制) ------------------------------------------------------------
// Chinese-journal practice style; the record's own script decides the truncation wording (等/et al.).
const gbtTypeTag = (item: CitationItem): string => {
  switch (item.itemType) {
    case 'journal-article':
      return '[J]'
    case 'conference-paper':
      return '[C]'
    case 'book':
    case 'chapter':
      return '[M]'
    case 'thesis':
      return '[D]'
    case 'report':
      return '[R]'
    case 'dataset':
      return '[DS]'
    default:
      // Preprint / web / unknown records are located by a resolvable link, which GB/T tags [EB/OL].
      return '[EB/OL]'
  }
}

const gbtAuthors = (authors: readonly { name: string }[]): string => {
  if (authors.length === 0) return ''
  const names = authors.map((author) => {
    const parsed = parseAuthorName(author.name)
    if (parsed.familyFirst || !parsed.given) return parsed.family
    const initials = initialsOf(parsed.given, { withPeriods: true, joined: ' ' })
    return initials ? `${parsed.family} ${initials}` : parsed.family
  })
  if (names.length <= 3) return names.join(', ').replace(/\.$/, '')
  const ellipsis = hasCjkScript(names[0]) ? ', 等' : ' et al.'
  return `${names.slice(0, 3).join(', ')}${ellipsis}`
}

const formatGbt7714Style = (
  item: CitationItem,
  context: CitationFormatContext
): CitationFormatResult => {
  const authors = gbtAuthors(item.authors)
  const title = item.title.trim()
  const tag = gbtTypeTag(item)
  const warnings = missingFieldWarnings(item, ['year'])
  const lead = authors ? `${authors.replace(/\.$/, '')}. ${title}${tag}` : `${title}${tag}`

  const container = item.containerTitle?.trim()
  const isSerial = item.itemType === 'journal-article' || Boolean(container)
  if (isSerial && container) {
    // 作者. 题名[J]. 刊名, 年, 卷(期): 页码. DOI
    const tail = joinSegments(
      [
        item.year ? `, ${item.year}` : '',
        item.volume?.trim() ? `, ${item.volume.trim()}` : '',
        item.issue?.trim() ? `(${item.issue.trim()})` : '',
        item.pages?.trim() ? `: ${item.pages.trim()}` : ''
      ],
      ''
    )
    const doi = item.doi?.trim() ? ` ${item.doi.trim()}` : ''
    return result(`${lead}. ${container}${tail}.${doi}`, warnings)
  }

  if (item.itemType === 'book' || item.itemType === 'chapter' || item.itemType === 'report') {
    const publisher = item.publisher?.trim()
    return result(
      `${lead}. ${joinSegments([publisher, item.year ? String(item.year) : ''], ', ')}.`,
      warnings
    )
  }

  // Online / preprint / unknown: 出版年[引用日期]. 获取路径.
  const year = item.year ? String(item.year) : ''
  const retrieved = context.retrievedAt ? `[${context.retrievedAt}]` : ''
  const locator = locatorFor(item)
  const closing = item.year || context.retrievedAt ? '.' : ''
  return result(
    `${lead}. ${joinSegments([year, retrieved, closing ? `${closing} ${locator}`.trim() : locator])}`,
    locator ? warnings : [...warnings, 'style:no-locator']
  )
}

// ---- Vancouver (NLM / Elsevier) ------------------------------------------------------------
const vancouverAuthors = (authors: readonly { name: string }[]): string =>
  joinAuthorList(authors, familyThenTightInitials, {
    max: 6,
    etAl: ', et al.',
    delimiter: ', '
  })

const formatVancouver = (item: CitationItem): CitationFormatResult => {
  const authors = vancouverAuthors(item.authors)
  const container = item.containerTitle?.trim()
  // NLM: 2024;21(3):145-158.
  const serial = item.volume?.trim()
    ? `${item.volume.trim()}${item.issue?.trim() ? `(${item.issue.trim()})` : ''}`
    : item.issue?.trim()
      ? `(${item.issue.trim()})`
      : ''
  const imprint = joinSegments(
    [
      item.year ? `${item.year}${serial ? `;${serial}` : ''}` : serial,
      item.pages?.trim() ? `:${item.pages.trim()}` : ''
    ],
    ''
  )
  const doi = item.doi?.trim() ? `doi: ${item.doi.trim()}.` : ''
  const head = authors ? `${authors}.` : ''
  const body = container
    ? joinSegments([`${item.title.trim()}.`, `${container}.`])
    : `${item.title.trim()}.`
  return result(
    joinSegments([head, body, imprint ? `${imprint}.` : '', doi]),
    missingFieldWarnings(item, ['year', 'containerTitle'])
  )
}

// ---- APA 7th ------------------------------------------------------------------------------
const apaAuthors = (authors: readonly { name: string }[]): string => {
  if (authors.length === 0) return ''
  const rendered = authors.map((author) => familyThenInitials(parseAuthorName(author.name)))
  if (rendered.length === 1) return rendered[0]
  const ampersand = rendered.length === 2 ? ' & ' : ', & '
  return `${rendered.slice(0, -1).join(', ')}${ampersand}${rendered[rendered.length - 1]}`
}

const formatApa7 = (item: CitationItem): CitationFormatResult => {
  const authors = apaAuthors(item.authors)
  const year = item.year ? `(${item.year}).` : '(n.d.).'
  const title = `${item.title.trim()}.`
  const container = item.containerTitle?.trim()
  // APA journal block: Journal, 12(3), 45-67.
  const volume = item.volume?.trim()
  const issue = item.issue?.trim()
  const pages = item.pages?.trim()
  const serial = container
    ? [
        container,
        volume ? `, ${volume}${issue ? `(${issue})` : ''}` : issue ? ` (${issue})` : '',
        pages ? `, ${pages}` : ''
      ].join('') + '.'
    : ''
  const locator = item.doi?.trim() ? `https://doi.org/${item.doi.trim()}` : (item.url?.trim() ?? '')
  return result(
    joinSegments([authors, year, title, serial, locator]),
    missingFieldWarnings(item, item.year ? ['containerTitle'] : ['year', 'containerTitle'])
  )
}

// ---- MLA 9th ------------------------------------------------------------------------------
const mlaAuthors = (authors: readonly { name: string }[]): string => {
  if (authors.length === 0) return ''
  const first = parseAuthorName(authors[0].name)
  const firstRendered = first.given ? `${first.family}, ${first.given}` : first.family
  const rest = authors.slice(1).map((author) => {
    const parsed = parseAuthorName(author.name)
    return parsed.given ? `${parsed.given} ${parsed.family}` : parsed.family
  })
  if (rest.length === 0) return firstRendered
  if (rest.length === 1) return `${firstRendered}, and ${rest[0]}`
  // MLA inverts only the first name: the rest stay in normal order, with "and" before the last.
  return `${firstRendered}, ${rest.slice(0, -1).join(', ')}, and ${rest[rest.length - 1]}`
}

const formatMla9 = (item: CitationItem): CitationFormatResult => {
  const authors = mlaAuthors(item.authors)
  const title = `"${item.title.trim()}."`
  // MLA core elements: container, vol., no., date, pp. — present ones joined with commas.
  const clauses = [
    item.containerTitle?.trim(),
    item.volume?.trim() ? `vol. ${item.volume.trim()}` : undefined,
    item.issue?.trim() ? `no. ${item.issue.trim()}` : undefined,
    item.year ? String(item.year) : undefined,
    item.pages?.trim() ? `pp. ${item.pages.trim()}` : undefined
  ].filter((clause): clause is string => Boolean(clause))
  const body = clauses.length ? `${clauses.join(', ')}.` : ''
  const locator = locatorFor(item)
  return result(
    joinSegments([authors ? `${authors}.` : '', title, body, locator]),
    missingFieldWarnings(item, ['year', 'containerTitle'])
  )
}

// ---- Chicago 18th (author-date) -----------------------------------------------------------
const chicagoAuthors = (authors: readonly { name: string }[]): string => {
  if (authors.length === 0) return ''
  const first = parseAuthorName(authors[0].name)
  const firstRendered = first.given ? `${first.family}, ${first.given}` : first.family
  const rest = authors.slice(1).map((author) => {
    const parsed: ParsedName = parseAuthorName(author.name)
    return parsed.given ? `${parsed.given} ${parsed.family}` : parsed.family
  })
  if (rest.length === 0) return firstRendered
  return rest.length === 1
    ? `${firstRendered}, and ${rest[0]}`
    : `${firstRendered}, ${rest.slice(0, -1).join(', ')}, and ${rest[rest.length - 1]}`
}

const formatChicago18 = (item: CitationItem): CitationFormatResult => {
  const authors = chicagoAuthors(item.authors)
  const container = item.containerTitle?.trim()
  // Chicago author-date: Nature Methods 21 (3): 145-158.
  const serial = container
    ? `${container}${item.volume?.trim() ? ` ${item.volume.trim()}` : ''}${
        item.issue?.trim() ? ` (${item.issue.trim()})` : ''
      }${item.pages?.trim() ? `: ${item.pages.trim()}` : ''}`
    : ''
  const locator = item.doi?.trim() ? `https://doi.org/${item.doi.trim()}.` : ''
  return result(
    joinSegments([
      authors ? `${authors}.` : '',
      item.year ? `${item.year}.` : 'n.d.',
      `"${item.title.trim()}."`,
      serial ? `${serial}.` : '',
      locator
    ]),
    missingFieldWarnings(item, ['year', 'containerTitle'])
  )
}

// ---- IEEE 11th ----------------------------------------------------------------------------
const ieeeAuthors = (authors: readonly { name: string }[]): string => {
  if (authors.length === 0) return ''
  const rendered = authors.map((author) => initialsThenFamily(parseAuthorName(author.name)))
  if (rendered.length === 1) return rendered[0]
  return `${rendered.slice(0, -1).join(', ')} and ${rendered[rendered.length - 1]}`
}

const formatIeee11 = (item: CitationItem, context: CitationFormatContext): CitationFormatResult => {
  const authors = ieeeAuthors(item.authors)
  const container = item.containerTitle?.trim()
  const number = context.index ? `[${context.index}] ` : ''
  const details = joinSegments(
    [
      item.volume?.trim() ? `vol. ${item.volume.trim()}` : '',
      item.issue?.trim() ? `no. ${item.issue.trim()}` : '',
      item.pages?.trim() ? `pp. ${item.pages.trim()}` : '',
      item.year ? String(item.year) : ''
    ],
    ', '
  )
  return result(
    `${number}${joinSegments([
      authors ? `${authors},` : '',
      `"${item.title.trim()},"`,
      container ? `${container},` : '',
      details ? `${details}.` : ''
    ])}`,
    missingFieldWarnings(item, ['year', 'containerTitle'])
  )
}

// ---- Nature -------------------------------------------------------------------------------
const natureAuthors = (authors: readonly { name: string }[]): string => {
  if (authors.length === 0) return ''
  const rendered = authors.map((author) => familyThenInitials(parseAuthorName(author.name)))
  if (rendered.length <= 5) {
    if (rendered.length === 1) return rendered[0]
    return `${rendered.slice(0, -1).join(', ')} & ${rendered[rendered.length - 1]}`
  }
  return `${rendered.slice(0, 5).join(', ')} et al.`
}

const formatNature = (item: CitationItem): CitationFormatResult => {
  const authors = natureAuthors(item.authors)
  const container = item.containerTitle?.trim()
  // Nature: Journal 12, 45-67 (2020).
  const details = [item.volume?.trim(), item.pages?.trim()]
    .filter((part): part is string => Boolean(part))
    .join(', ')
  const imprint = joinSegments([container ?? '', details])
  return result(
    joinSegments([
      authors ? `${authors.replace(/\.$/, '')}.` : '',
      `${item.title.trim()}.`,
      imprint ? `${imprint}` : '',
      item.year ? `(${item.year}).` : ''
    ]),
    missingFieldWarnings(item, ['year', 'containerTitle'])
  )
}

// ---- AMA 11th -----------------------------------------------------------------------------
const amaAuthors = (authors: readonly { name: string }[]): string =>
  joinAuthorList(authors, familyThenTightInitials, { max: 6, etAl: ', et al.' })

const formatAma11 = (item: CitationItem): CitationFormatResult => {
  const authors = amaAuthors(item.authors)
  const container = item.containerTitle?.trim()
  // AMA: 2024;21(3):145-158.
  const serial = item.volume?.trim()
    ? `${item.volume.trim()}${item.issue?.trim() ? `(${item.issue.trim()})` : ''}`
    : item.issue?.trim()
      ? `(${item.issue.trim()})`
      : ''
  const imprint = joinSegments(
    [
      item.year ? `${item.year}${serial ? `;${serial}` : ''}` : serial,
      item.pages?.trim() ? `:${item.pages.trim()}` : ''
    ],
    ''
  )
  const doi = item.doi?.trim() ? `doi:${item.doi.trim()}` : ''
  return result(
    joinSegments([
      authors ? `${authors}.` : '',
      `${item.title.trim()}.`,
      container ? `${container}.` : '',
      imprint ? `${imprint}.` : '',
      doi
    ]),
    missingFieldWarnings(item, ['year', 'containerTitle'])
  )
}

// ---- Harvard (Cite Them Right, 12th) ------------------------------------------------------
const harvardAuthors = (authors: readonly { name: string }[]): string => {
  if (authors.length === 0) return ''
  const rendered = authors.map((author) => familyThenInitials(parseAuthorName(author.name)))
  if (rendered.length === 1) return rendered[0]
  if (rendered.length === 2) return `${rendered[0]} and ${rendered[1]}`
  return `${rendered.slice(0, -1).join(', ')} and ${rendered[rendered.length - 1]}`
}

const formatHarvardCtr = (item: CitationItem): CitationFormatResult => {
  const authors = harvardAuthors(item.authors)
  const container = item.containerTitle?.trim()
  const serial = joinSegments(
    [item.volume?.trim() ?? '', item.issue?.trim() ? `(${item.issue.trim()})` : ''],
    ''
  )
  const pages = item.pages?.trim() ? `pp. ${item.pages.trim()}` : ''
  // Cite Them Right: Author, A. (2020) 'Title', Journal, 12(3), pp. 45-67.
  const source = [container, serial, pages]
    .filter((part): part is string => Boolean(part))
    .join(', ')
  const doi = item.doi?.trim() ? `doi: ${item.doi.trim()}.` : ''
  return result(
    joinSegments([
      authors,
      item.year ? `(${item.year})` : '(no date)',
      `'${item.title.trim()}'${source ? `, ${source}` : ''}.`,
      doi
    ]),
    missingFieldWarnings(item, ['year', 'containerTitle'])
  )
}

// The catalogue order is the picker order: Chinese-journal practice leads (this library's primary
// audience), then the Western styles most often demanded by submission systems.
export const BUILTIN_CITATION_STYLES: readonly CitationStyleDefinition[] = [
  {
    id: 'gbt7714-2015',
    label: 'GB/T 7714-2015 (numeric)',
    labelZh: 'GB/T 7714-2015（顺序编码）',
    family: 'numeric',
    locale: 'zh',
    source: 'builtin',
    uses: ['authors', 'containerTitle', 'year', 'volume', 'issue', 'pages', 'doi'],
    format: formatGbt7714Style
  },
  {
    id: 'apa-7',
    label: 'APA 7th',
    labelZh: 'APA 第 7 版',
    family: 'author-date',
    locale: 'en',
    source: 'builtin',
    uses: ['authors', 'containerTitle', 'year', 'volume', 'issue', 'pages', 'doi'],
    format: formatApa7
  },
  {
    id: 'vancouver-nlm',
    label: 'Vancouver (NLM)',
    labelZh: 'Vancouver（NLM）',
    family: 'numeric',
    locale: 'en',
    source: 'builtin',
    uses: ['authors', 'containerTitle', 'year', 'volume', 'issue', 'pages', 'doi'],
    format: formatVancouver
  },
  {
    id: 'ieee-11',
    label: 'IEEE 11th',
    labelZh: 'IEEE 第 11 版',
    family: 'numeric',
    locale: 'en',
    source: 'builtin',
    uses: ['authors', 'containerTitle', 'year', 'volume', 'issue', 'pages'],
    format: formatIeee11
  },
  {
    id: 'nature',
    label: 'Nature',
    labelZh: 'Nature',
    family: 'numeric',
    locale: 'en',
    source: 'builtin',
    uses: ['authors', 'containerTitle', 'year', 'volume', 'pages'],
    format: formatNature
  },
  {
    id: 'ama-11',
    label: 'AMA 11th',
    labelZh: 'AMA 第 11 版',
    family: 'numeric',
    locale: 'en',
    source: 'builtin',
    uses: ['authors', 'containerTitle', 'year', 'volume', 'issue', 'pages', 'doi'],
    format: formatAma11
  },
  {
    id: 'harvard-ctr-12',
    label: 'Harvard (Cite Them Right 12th)',
    labelZh: 'Harvard（Cite Them Right 第 12 版）',
    family: 'author-date',
    locale: 'en',
    source: 'builtin',
    uses: ['authors', 'containerTitle', 'year', 'volume', 'issue', 'pages', 'doi'],
    format: formatHarvardCtr
  },
  {
    id: 'chicago-18-author-date',
    label: 'Chicago 18th (author-date)',
    labelZh: 'Chicago 第 18 版（作者-年份）',
    family: 'author-date',
    locale: 'en',
    source: 'builtin',
    uses: ['authors', 'containerTitle', 'year', 'volume', 'issue', 'pages', 'doi'],
    format: formatChicago18
  },
  {
    id: 'mla-9',
    label: 'MLA 9th',
    labelZh: 'MLA 第 9 版',
    family: 'author-date',
    locale: 'en',
    source: 'builtin',
    uses: ['authors', 'containerTitle', 'year', 'volume', 'issue', 'pages'],
    format: formatMla9
  }
]

export const isNumericStyle = (style: CitationStyleDefinition): boolean =>
  style.family === 'numeric'
