import { normalizeTitleForDedupe } from './references'
import type { Reference, ReferenceItemType } from './references'

// Zotero hands a library over as CSL-JSON ("Export Library… → JSON"), which is the richest format it writes and
// the one that keeps DOI, abstract and container title intact. RIS and BibTeX exports lose fields this product
// shows, so they are not read here — a half-mapped import is worse than telling the reader which export to use.
//
// Nothing in this module touches the filesystem or the network: it takes the text of an export plus the records
// the project already holds, and returns what would be written and what was refused, field by field.
export type ZoteroImportSkipReason = 'not-an-object' | 'missing-title' | 'duplicate'

export type ZoteroImportSkip = {
  index: number
  reason: ZoteroImportSkipReason
  // The best name available for the refused item, so a preview can say which one it was.
  label: string
}

export type ZoteroImportRecord = {
  index: number
  title: string
  doi: string | undefined
  // What would be passed to `references.add`, without the project id (the caller owns that).
  input: {
    title: string
    authors: Array<{ name: string }>
    venue: string | undefined
    year: number | undefined
    volume: string | undefined
    issue: string | undefined
    pages: string | undefined
    publisher: string | undefined
    itemType: ReferenceItemType | undefined
    doi: string | undefined
    pmid: string | undefined
    url: string | undefined
    abstractSnippet: string | undefined
  }
}

export type ZoteroImportPlan = {
  records: ZoteroImportRecord[]
  skipped: ZoteroImportSkip[]
}

export const ZOTERO_IMPORT_LIMIT = 500

const CSL_ITEM_TYPES: Record<string, ReferenceItemType> = {
  'article-journal': 'journal-article',
  'paper-conference': 'conference-paper',
  article: 'journal-article',
  preprint: 'preprint',
  book: 'book',
  chapter: 'chapter',
  'chapter-alike': 'chapter',
  report: 'report',
  dataset: 'dataset',
  thesis: 'thesis',
  webpage: 'web',
  post: 'web',
  manuscript: 'preprint'
}

const asText = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

const normalizeDoi = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  const trimmed = value
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
  return trimmed === '' ? undefined : trimmed.toLowerCase()
}

const readYear = (item: Record<string, unknown>): number | undefined => {
  const issued = item.issued
  if (issued && typeof issued === 'object') {
    const parts = (issued as { 'date-parts'?: unknown })['date-parts']
    if (Array.isArray(parts) && Array.isArray(parts[0])) {
      const year = Number(parts[0][0])
      if (Number.isInteger(year) && year > 0 && year < 3000) return year
    }
    // CSL also allows a `literal` or a raw date string; only an explicit year is taken, never guessed.
    const literal = asText((issued as { literal?: unknown }).literal)
    const match = literal?.match(/\b(1[0-9]{3}|20[0-9]{2})\b/)
    if (match) return Number(match[1])
  }
  const raw = asText(item.issued) ?? asText(item.year)
  const match = raw?.match(/\b(1[0-9]{3}|20[0-9]{2})\b/)
  return match ? Number(match[1]) : undefined
}

const readAuthors = (item: Record<string, unknown>): Array<{ name: string }> => {
  const authors: Array<{ name: string }> = []
  for (const field of ['author', 'editor'] as const) {
    const value = item[field]
    if (!Array.isArray(value)) continue
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue
      const record = entry as { family?: unknown; given?: unknown; literal?: unknown }
      const literal = asText(record.literal)
      if (literal) {
        authors.push({ name: literal })
        continue
      }
      const family = asText(record.family)
      const given = asText(record.given)
      const name = [given, family].filter(Boolean).join(' ').trim()
      if (name) authors.push({ name })
    }
    if (authors.length > 0) break
  }
  return authors
}

const readItems = (text: string): unknown[] | { error: string } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { error: 'not-json' }
  }
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    const items = (parsed as { items?: unknown }).items
    if (Array.isArray(items)) return items
  }
  return { error: 'not-a-zotero-export' }
}

const labelOf = (item: Record<string, unknown>): string => {
  // Title first, then the identifier a reader can search for, then Zotero's own key. The key alone ("MISSING")
  // tells nobody which record was refused.
  const title = asText(item.title) ?? asText(item.name)
  if (title) return title
  return (
    asText(item.DOI) ?? asText(item.PMID) ?? asText(item.id) ?? asText(item.key) ?? '(untitled)'
  )
}

/**
 * Turns export text into the records that would be written. A record is refused, never repaired: an item with no
 * title cannot be cited, and an item whose DOI or title the project already holds is a duplicate — importing it
 * again would make the reading queue count the same work twice.
 */
export const planZoteroImport = (
  text: string,
  existing: readonly Reference[]
): ZoteroImportPlan | { error: string } => {
  const items = readItems(text)
  if (!Array.isArray(items)) return items

  const seenDois = new Set<string>()
  const seenTitles = new Set<string>()
  for (const reference of existing) {
    const doi = normalizeDoi(reference.doi)
    if (doi) seenDois.add(doi)
    const title = normalizeTitleForDedupe(reference.title ?? '')
    if (title) seenTitles.add(title)
  }

  const records: ZoteroImportRecord[] = []
  const skipped: ZoteroImportSkip[] = []

  items.slice(0, ZOTERO_IMPORT_LIMIT).forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      skipped.push({ index, reason: 'not-an-object', label: '(not an item)' })
      return
    }
    const item = raw as Record<string, unknown>
    const title = asText(item.title) ?? asText(item.name)
    if (!title) {
      skipped.push({ index, reason: 'missing-title', label: labelOf(item) })
      return
    }
    const doi = normalizeDoi(asText(item.DOI))
    const titleKey = normalizeTitleForDedupe(title)
    if ((doi && seenDois.has(doi)) || (titleKey && seenTitles.has(titleKey))) {
      skipped.push({ index, reason: 'duplicate', label: title })
      return
    }
    if (doi) seenDois.add(doi)
    if (titleKey) seenTitles.add(titleKey)

    const typeRaw = asText(item.type)
    const containerTitle = asText(item['container-title'])
    const publisher = asText(item.publisher)
    records.push({
      index,
      title,
      doi: asText(item.DOI),
      input: {
        title,
        authors: readAuthors(item),
        // A book's "venue" is its publisher; an article's is its container. Never both at once.
        venue: containerTitle ?? (typeRaw === 'book' ? publisher : undefined),
        year: readYear(item),
        volume: asText(item.volume),
        issue: asText(item.issue),
        pages: asText(item.page),
        publisher: publisher,
        itemType: typeRaw ? CSL_ITEM_TYPES[typeRaw] : undefined,
        doi: asText(item.DOI),
        pmid: asText(item.PMID),
        url: asText(item.URL),
        abstractSnippet: asText(item.abstract)
      }
    })
  })

  return { records, skipped }
}
