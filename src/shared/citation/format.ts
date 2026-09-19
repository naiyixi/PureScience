// Citation entry points: reference record -> citation item -> formatted string, plus the
// multi-style comparison that makes this layer useful in a submission workflow (one record, several
// styles side by side, each with the fields it could not print).

import { formatGbt7714 } from '../references'
import { BUILTIN_CITATION_STYLES } from './builtin-styles'
import type {
  CitationFieldKey,
  CitationFormatContext,
  CitationItem,
  CitationItemType,
  CitationStyleDefinition
} from './types'

export type CitationSourceRecord = {
  title: string
  authors: readonly { name: string }[]
  venue?: string | undefined
  year?: number | undefined
  volume?: string | undefined
  issue?: string | undefined
  pages?: string | undefined
  publisher?: string | undefined
  itemType?: string | undefined
  doi?: string | undefined
  arxivId?: string | undefined
  pmid?: string | undefined
  pmcid?: string | undefined
  url?: string | undefined
}

const CITATION_ITEM_TYPES: readonly CitationItemType[] = [
  'journal-article',
  'conference-paper',
  'preprint',
  'book',
  'chapter',
  'report',
  'dataset',
  'thesis',
  'web',
  'unknown'
]

export const isCitationItemType = (value: string): value is CitationItemType =>
  (CITATION_ITEM_TYPES as readonly string[]).includes(value)

// The type a record implies when it does not declare one. Deliberately conservative: a venue means
// "serial", an arXiv id without a venue means "preprint", and everything else stays unknown so a
// style's own fallback (rather than our guess) decides the presentation.
export const inferCitationItemType = (reference: CitationSourceRecord): CitationItemType => {
  if (reference.itemType && isCitationItemType(reference.itemType)) return reference.itemType
  if (reference.venue?.trim()) return 'journal-article'
  if (reference.arxivId?.trim()) return 'preprint'
  if (reference.url?.trim()) return 'web'
  return 'unknown'
}

export const citationItemFromReference = (reference: CitationSourceRecord): CitationItem => ({
  title: reference.title,
  authors: reference.authors,
  containerTitle: reference.venue?.trim() || undefined,
  year: reference.year,
  volume: reference.volume?.trim() || undefined,
  issue: reference.issue?.trim() || undefined,
  pages: reference.pages?.trim() || undefined,
  publisher: reference.publisher?.trim() || undefined,
  doi: reference.doi?.trim() || undefined,
  arxivId: reference.arxivId?.trim() || undefined,
  pmid: reference.pmid?.trim() || undefined,
  pmcid: reference.pmcid?.trim() || undefined,
  url: reference.url?.trim() || undefined,
  itemType: inferCitationItemType(reference)
})

export type CitationStyleSummary = Omit<CitationStyleDefinition, 'format'>

export const summarizeCitationStyle = (style: CitationStyleDefinition): CitationStyleSummary => {
  const { format: _format, ...summary } = style
  return summary
}

// Imported styles are appended after the built-ins and can never shadow a built-in id: a style
// document that claims a built-in id is rejected at import time (see csl.ts).
export const resolveCitationStyles = (
  imported: readonly CitationStyleDefinition[] = []
): readonly CitationStyleDefinition[] => {
  const builtinIds = new Set(BUILTIN_CITATION_STYLES.map((style) => style.id))
  return [...BUILTIN_CITATION_STYLES, ...imported.filter((style) => !builtinIds.has(style.id))]
}

export const findCitationStyle = (
  styleId: string,
  imported: readonly CitationStyleDefinition[] = []
): CitationStyleDefinition | undefined =>
  resolveCitationStyles(imported).find((style) => style.id === styleId)

export const DEFAULT_CITATION_STYLE_ID = 'gbt7714-2015'

export type FormattedCitation = {
  styleId: string
  styleLabel: string
  text: string
  warnings: readonly string[]
}

const MISSING_FIELD_PREFIX = 'field:'

export const missingFieldsFromWarnings = (
  warnings: readonly string[]
): readonly CitationFieldKey[] =>
  warnings
    .filter((warning) => warning.startsWith(MISSING_FIELD_PREFIX))
    .map((warning) => warning.slice(MISSING_FIELD_PREFIX.length) as CitationFieldKey)

export const formatCitation = (
  item: CitationItem,
  styleId: string,
  context: CitationFormatContext = {},
  imported: readonly CitationStyleDefinition[] = []
): FormattedCitation => {
  const style = findCitationStyle(styleId, imported)
  if (!style) {
    // An unknown style id is reported, never silently rendered in some default style: the caller
    // asked for a specific convention and must know it could not be honoured.
    return {
      styleId,
      styleLabel: styleId,
      text: '',
      warnings: ['style:unknown']
    }
  }
  return formatWithStyle(item, style, context)
}

const formatWithStyle = (
  item: CitationItem,
  style: CitationStyleDefinition,
  context: CitationFormatContext
): FormattedCitation => {
  // GB/T 7714 keeps its long-standing implementation for records the rich fields say nothing about;
  // the style layer only takes over once volume/issue/pages/publisher/type carry information the
  // legacy path cannot express. This keeps every citation that existed before this layer byte-stable.
  if (style.id === 'gbt7714-2015' && !hasRichBibliographicFields(item)) {
    const legacy = formatGbt7714(
      {
        title: item.title,
        authors: [...item.authors],
        venue: item.containerTitle,
        year: item.year,
        doi: item.doi,
        arxivId: item.arxivId,
        pmid: item.pmid,
        pmcid: item.pmcid
      },
      { retrievedAt: context.retrievedAt }
    )
    const warnings = item.year ? [] : ['field:year']
    return { styleId: style.id, styleLabel: style.label, text: legacy, warnings: [...warnings] }
  }
  const formatted = style.format(item, context)
  return {
    styleId: style.id,
    styleLabel: style.label,
    text: formatted.text,
    warnings: formatted.warnings
  }
}

export const hasRichBibliographicFields = (item: CitationItem): boolean =>
  Boolean(item.volume?.trim() || item.issue?.trim() || item.pages?.trim() || item.publisher?.trim())

// Formats one record in several styles at once — the comparison view's data source.
export const compareCitationStyles = (
  item: CitationItem,
  styleIds: readonly string[],
  context: CitationFormatContext = {},
  imported: readonly CitationStyleDefinition[] = []
): FormattedCitation[] =>
  styleIds.map((styleId) => formatCitation(item, styleId, context, imported))

export const formatCitationList = (
  items: readonly CitationItem[],
  styleId: string,
  context: CitationFormatContext = {},
  imported: readonly CitationStyleDefinition[] = []
): string => {
  const style = findCitationStyle(styleId, imported)
  const numeric = style?.family === 'numeric'
  return items
    .map((item, index) => {
      const formatted = formatCitation(item, styleId, { ...context, index: index + 1 }, imported)
      // Numeric conventions are read as a numbered list; author-date entries are not numbered.
      return numeric ? `[${index + 1}] ${formatted.text}` : formatted.text
    })
    .join('\n')
}

export const citationStyleWarningsForItem = (
  item: CitationItem,
  styleId: string,
  imported: readonly CitationStyleDefinition[] = []
): readonly string[] => formatCitation(item, styleId, {}, imported).warnings

export { BUILTIN_CITATION_STYLES }
