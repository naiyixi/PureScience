// BibTeX export (v2.6.0 A2). The same records, in the one format a reference manager imports
// without a style document.
//
// The module's three rules hold here as well:
//   1. A field we do not have is omitted, never guessed — and the omission is named in `warnings`
//      with the same `field:` prefix the style formatter uses, so one reader can report both.
//   2. A type we cannot map faithfully is named (`type:thesis-as-misc`) instead of being passed off
//      as something it is not; `phdthesis`/`mastersthesis` would claim a degree the record does not
//      carry.
//   3. Nothing depends on the clock or on map iteration order, so exporting the same list twice
//      produces the same bytes — the citation keys are derived from the records themselves.

import type { CitationItem, CitationItemType } from './types'
import type { FormattedCitation } from './format'

const BIBTEX_STYLE_ID = 'bibtex'
const BIBTEX_STYLE_LABEL = 'BibTeX'

const BIBTEX_TYPES: Record<CitationItemType, string> = {
  'journal-article': 'article',
  'conference-paper': 'inproceedings',
  preprint: 'misc',
  book: 'book',
  chapter: 'incollection',
  report: 'techreport',
  dataset: 'misc',
  thesis: 'misc',
  web: 'misc',
  unknown: 'misc'
}

const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/

const hasCjk = (value: string): boolean => CJK_PATTERN.test(value)

/** Characters TeX would otherwise read as markup inside a field value. */
const escapeBibTeX = (value: string): string => {
  let out = ''
  for (const character of value) {
    if (character === '\\') out += '\\textbackslash{}'
    else if (character === '{') out += '\\{'
    else if (character === '}') out += '\\}'
    else if (character === '&') out += '\\&'
    else if (character === '%') out += '\\%'
    else if (character === '$') out += '\\$'
    else if (character === '#') out += '\\#'
    else if (character === '_') out += '\\_'
    else if (character === '~') out += '\\textasciitilde{}'
    else if (character === '^') out += '\\textasciicircum{}'
    else out += character
  }
  return out
}

/** "Given Family" and "Family, Given" both become BibTeX's "Family, Given"; a CJK name is kept. */
export const bibtexAuthorName = (raw: string): string => {
  const name = raw.trim()
  if (!name || hasCjk(name)) return name
  const commaParts = name
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  if (commaParts.length >= 2) return `${commaParts[0]}, ${commaParts.slice(1).join(' ')}`
  const words = name.split(/\s+/).filter(Boolean)
  if (words.length === 1) return words[0]
  return `${words[words.length - 1]}, ${words.slice(0, -1).join(' ')}`
}

const familyName = (raw: string): string => {
  const name = raw.trim()
  if (!name) return ''
  if (hasCjk(name)) return name
  const commaParts = name.split(',').map((part) => part.trim())
  if (commaParts.length >= 2 && commaParts[0]) return commaParts[0]
  const words = name.split(/\s+/).filter(Boolean)
  return words.length > 0 ? words[words.length - 1] : ''
}

/** The first letter/CJK run in the title — BibTeX keys are read by people, so it stays readable. */
const firstTitleChunk = (title: string): string => {
  const match = title.match(/[A-Za-z]+|[\u3400-\u9fff]+/)
  return match ? match[0].toLowerCase() : ''
}

const keyBase = (item: CitationItem): string => {
  const firstAuthor = item.authors[0]?.name.trim() ?? ''
  const family = familyName(firstAuthor).replace(/[^A-Za-z\u3400-\u9fff]/g, '')
  const author = family || 'anon'
  const year = item.year === undefined ? 'nd' : String(item.year)
  return `${author}${year}${firstTitleChunk(item.title)}`
}

/** Keys stay stable across runs; a second record that would collide gets the next letter. */
const citationKeys = (items: readonly CitationItem[]): readonly string[] => {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const base = keyBase(item)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}${String.fromCharCode(96 + count)}`
  })
}

export const formatBibTeXEntry = (item: CitationItem, key?: string): FormattedCitation => {
  const warnings: string[] = []
  const itemType = item.itemType ?? 'unknown'
  if (itemType === 'thesis') warnings.push('type:thesis-as-misc')

  const fields: [string, string][] = []
  const push = (name: string, value: string | undefined): void => {
    const trimmed = value?.trim()
    if (trimmed) fields.push([name, trimmed])
  }

  const authors = item.authors
    .map((author) => bibtexAuthorName(author.name))
    .filter(Boolean)
    .join(' and ')
  if (authors) fields.push(['author', authors])
  else warnings.push('field:authors')

  push('title', item.title)
  if (item.containerTitle?.trim()) fields.push(['journal', item.containerTitle])
  else if (
    itemType === 'journal-article' ||
    itemType === 'conference-paper' ||
    itemType === 'chapter'
  )
    warnings.push('field:containerTitle')

  if (item.year !== undefined) fields.push(['year', String(item.year)])
  else warnings.push('field:year')

  if (item.volume?.trim()) fields.push(['volume', item.volume])
  if (item.issue?.trim()) fields.push(['number', item.issue])
  if (item.pages?.trim()) fields.push(['pages', item.pages.replace(/\s*-\s*/g, '--')])
  if (item.publisher?.trim()) fields.push(['publisher', item.publisher])
  if (item.edition?.trim()) fields.push(['edition', item.edition])
  if (item.doi?.trim()) fields.push(['doi', item.doi])
  if (item.url?.trim()) fields.push(['url', item.url])
  if (item.arxivId?.trim()) {
    fields.push(['eprint', item.arxivId])
    fields.push(['archivePrefix', 'arXiv'])
  }

  const entryKey = key ?? citationKeys([item])[0]
  const body = fields.map(([name, value]) => `  ${name} = {${escapeBibTeX(value)}}`).join(',\n')
  return {
    styleId: BIBTEX_STYLE_ID,
    styleLabel: BIBTEX_STYLE_LABEL,
    text: `@${BIBTEX_TYPES[itemType]}{${entryKey},\n${body}\n}`,
    warnings
  }
}

/** One entry per record, separated by a blank line; the list is byte-identical on every run. */
export const formatBibTeXList = (items: readonly CitationItem[]): string => {
  const keys = citationKeys(items)
  return items.map((item, index) => formatBibTeXEntry(item, keys[index]).text).join('\n\n')
}

export const BIBTEX_EXPORT = { styleId: BIBTEX_STYLE_ID, styleLabel: BIBTEX_STYLE_LABEL } as const
