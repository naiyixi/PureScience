// RIS export (v2.6.0 A2). Same records, the interchange format most reference managers import.
//
// Rules, unchanged from the rest of this module:
//   1. A tag is written only when the record carries the value; nothing is padded with a guess.
//   2. A type without a faithful RIS mapping is named in `warnings` (`type:thesis-as-thes` is
//      faithful; `type:unknown-as-gen` is the one that says "we had to pick").
//   3. Output is deterministic: tags in a fixed order, records separated by exactly one blank line.

import type { CitationItem, CitationItemType } from './types'
import type { FormattedCitation } from './format'

const RIS_STYLE_ID = 'ris'
const RIS_STYLE_LABEL = 'RIS'

const RIS_TYPES: Record<CitationItemType, string> = {
  'journal-article': 'JOUR',
  'conference-paper': 'CPAPER',
  preprint: 'GEN',
  book: 'BOOK',
  chapter: 'CHAP',
  report: 'RPRT',
  dataset: 'DATA',
  thesis: 'THES',
  web: 'ELEC',
  unknown: 'GEN'
}

const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/

const risAuthorName = (raw: string): string => {
  const name = raw.trim()
  if (!name || CJK_PATTERN.test(name)) return name
  const commaParts = name
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  if (commaParts.length >= 2) return `${commaParts[0]}, ${commaParts.slice(1).join(' ')}`
  const words = name.split(/\s+/).filter(Boolean)
  if (words.length === 1) return words[0]
  return `${words[words.length - 1]}, ${words.slice(0, -1).join(' ')}`
}

const tag = (name: string, value: string): string => `${name}  - ${value}`

export const formatRisEntry = (item: CitationItem): FormattedCitation => {
  const warnings: string[] = []
  const itemType = item.itemType ?? 'unknown'
  if (itemType === 'unknown') warnings.push('type:unknown-as-gen')

  const lines: string[] = [tag('TY', RIS_TYPES[itemType])]

  const authors = item.authors.map((author) => risAuthorName(author.name)).filter(Boolean)
  if (authors.length > 0) for (const author of authors) lines.push(tag('AU', author))
  else warnings.push('field:authors')

  lines.push(tag('TI', item.title))

  if (item.containerTitle?.trim()) lines.push(tag('T2', item.containerTitle))
  else if (
    itemType === 'journal-article' ||
    itemType === 'conference-paper' ||
    itemType === 'chapter'
  )
    warnings.push('field:containerTitle')

  if (item.year !== undefined) lines.push(tag('PY', String(item.year)))
  else warnings.push('field:year')

  if (item.volume?.trim()) lines.push(tag('VL', item.volume))
  if (item.issue?.trim()) lines.push(tag('IS', item.issue))
  const pages = item.pages?.trim()
  if (pages) {
    const [start, end] = pages.split(/\s*-\s*/, 2)
    if (start) lines.push(tag('SP', start))
    if (end) lines.push(tag('EP', end))
  }
  if (item.publisher?.trim()) lines.push(tag('PB', item.publisher))
  if (item.edition?.trim()) lines.push(tag('ET', item.edition))
  if (item.doi?.trim()) lines.push(tag('DO', item.doi))
  if (item.url?.trim()) lines.push(tag('UR', item.url))
  if (item.arxivId?.trim()) {
    lines.push(tag('AN', `arXiv:${item.arxivId}`))
    lines.push(tag('M3', 'Preprint'))
  }
  if (item.pmid?.trim()) lines.push(tag('AN', `PMID:${item.pmid}`))

  lines.push(tag('ER', ''))
  return {
    styleId: RIS_STYLE_ID,
    styleLabel: RIS_STYLE_LABEL,
    text: `${lines.join('\n')}\n`,
    warnings
  }
}

/** One record per reference, separated by a blank line — what reference managers read. */
export const formatRisList = (items: readonly CitationItem[]): string =>
  items.map((item) => formatRisEntry(item).text).join('\n')

export const RIS_EXPORT = { styleId: RIS_STYLE_ID, styleLabel: RIS_STYLE_LABEL } as const
