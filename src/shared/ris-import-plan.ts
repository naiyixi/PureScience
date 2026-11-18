// One import entry point for the reference library, over two export dialects.
//
// Zotero's JSON export keeps every field we show, so it stays the preferred path. RIS is what the Chinese
// databases write (CNKI, 万方, 维普, NoteExpress, EndNote) — a reader who has just searched 知网 has a .ris
// file and nothing else. Reading both behind one plan keeps the dialog's write loop, its duplicate rule and
// its "what was refused, and why" reporting in one place instead of two.

import { normalizeTitleForDedupe } from './references'
import { parseRis, type RisImportResult } from './citation/ris-import'
import {
  looksLikeEndNote,
  looksLikeMedline,
  parseEndNoteTagged,
  parseMedline
} from './citation/tagged-import'
import {
  planZoteroImport,
  type ZoteroImportPlan,
  type ZoteroImportRecord,
  type ZoteroImportSkip
} from './zotero-import'
import type { Reference, ReferenceItemType } from './references'

export type ReferenceImportFormat = 'zotero-json' | 'ris' | 'endnote' | 'medline'

export type ReferenceImportPlan = ZoteroImportPlan & {
  /** Which dialect the text was read as — the dialog says so rather than guessing silently. */
  format: ReferenceImportFormat
  /** Records the file carried but the plan left out, with the parser's own reason (`no-title`, …). */
  refused: Array<{ line: number; reason: string; detail: string }>
}

/** What the plan needs to know about the library: enough to refuse a duplicate, nothing more. */
export type ExistingReference = { title: string; doi?: string | null }

const IMPORT_LIMIT = 500

const TY_LINE = /^\s*TY {2}-/mu

/**
 * Reads either dialect. Detection is by content, not extension: a .txt holding RIS and a .ris holding
 * Zotero JSON both happen, and refusing a file because of its name would be a self-inflicted failure.
 */
export const planReferenceImport = (
  text: string,
  existing: readonly ExistingReference[]
): ReferenceImportPlan | { error: 'not-an-export' } => {
  const trimmed = text.replace(/^\uFEFF/u, '').trimStart()

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const plan = planZoteroImport(text, existing as unknown as readonly Reference[])
    // `planZoteroImport` hands back whatever the JSON held when it is not a list of items; a plan without
    // a records array is not a plan, and saying so here keeps the dialog from reporting a TypeError.
    if ('error' in plan || !Array.isArray((plan as { records?: unknown }).records)) {
      return { error: 'not-an-export' }
    }
    return { ...plan, format: 'zotero-json', refused: [] }
  }

  // RIS first: it is the dialect every Chinese database offers, and its `TY  -` opener cannot occur in the
  // other two. EndNote (`%0`) and MEDLINE (`PMID- `) follow by content, never by extension.
  if (TY_LINE.test(trimmed)) return { ...planRisImport(trimmed, existing), format: 'ris' as const }
  if (looksLikeEndNote(trimmed)) {
    return {
      ...planParsedImport(parseEndNoteTagged(trimmed), existing),
      format: 'endnote' as const
    }
  }
  if (looksLikeMedline(trimmed)) {
    return { ...planParsedImport(parseMedline(trimmed), existing), format: 'medline' as const }
  }
  return { error: 'not-an-export' }
}

const RIS_TO_REFERENCE_TYPE: Record<string, ReferenceItemType> = {
  'journal-article': 'journal-article',
  'conference-paper': 'conference-paper',
  preprint: 'preprint',
  book: 'book',
  chapter: 'chapter',
  report: 'report',
  dataset: 'dataset',
  thesis: 'thesis',
  web: 'web'
  // No entry for 'unknown': the library's types have no "other", and claiming one would be inventing a
  // type the file did not state. An unmapped record is stored with no item type at all.
}

/**
 * The title key used to refuse duplicates. `normalizeTitleForDedupe` handles case and punctuation, but a
 * Chinese title is the same title with or without the spaces an exporter put between its words — so the
 * spaces go too, or 另一篇没有 DOI 的中文论文和已入库的 另一篇没有DOI的中文论文 would both survive.
 */
const titleKey = (title: string): string => normalizeTitleForDedupe(title).replace(/\s+/gu, '')

const dedupeKeysOf = (existing: readonly ExistingReference[]): Set<string> => {
  const keys = new Set<string>()
  for (const item of existing) {
    const doi = item.doi?.trim().toLowerCase()
    if (doi !== undefined && doi.length > 0) keys.add(`doi:${doi}`)
    const title = titleKey(item.title)
    if (title.length > 0) keys.add(`title:${title}`)
  }
  return keys
}

/**
 * RIS → the same plan shape the Zotero path produces. A record is refused, never repaired: no title means
 * no record, and a duplicate means the library already has it. The limit is shared with the Zotero path so
 * one import can never write an unbounded number of records.
 */
export const planRisImport = (
  text: string,
  existing: readonly ExistingReference[]
): ZoteroImportPlan & { refused: ReferenceImportPlan['refused'] } =>
  planParsedImport(parseRis(text), existing)

/**
 * One plan builder for every tagged dialect. RIS, EndNote and MEDLINE all parse down to the same records, so
 * the duplicate rule, the limit and the refusal reporting are written once — a second copy is a second place
 * for the duplicate rule to drift.
 */
export const planParsedImport = (
  parsed: RisImportResult,
  existing: readonly ExistingReference[]
): ZoteroImportPlan & { refused: ReferenceImportPlan['refused'] } => {
  const keys = dedupeKeysOf(existing)

  const records: ZoteroImportRecord[] = []
  const skipped: ZoteroImportSkip[] = []

  parsed.records.forEach((record, index) => {
    const { item } = record
    const doi = item.doi?.trim().toLowerCase()

    const duplicate =
      (doi !== undefined && doi.length > 0 && keys.has(`doi:${doi}`)) ||
      keys.has(`title:${titleKey(item.title)}`)

    if (duplicate) {
      skipped.push({ index, reason: 'duplicate', label: item.title })
      return
    }
    if (records.length >= IMPORT_LIMIT) {
      skipped.push({ index, reason: 'duplicate', label: item.title })
      return
    }

    if (doi !== undefined && doi.length > 0) keys.add(`doi:${doi}`)
    keys.add(`title:${titleKey(item.title)}`)

    records.push({
      index,
      title: item.title,
      doi: item.doi,
      input: {
        title: item.title,
        authors: item.authors.map((author) => ({ name: author.name })),
        venue: item.containerTitle,
        year: item.year,
        volume: item.volume,
        issue: item.issue,
        pages: item.pages,
        publisher: item.publisher,
        itemType: item.itemType === undefined ? undefined : RIS_TO_REFERENCE_TYPE[item.itemType],
        doi: item.doi,
        pmid: item.pmid,
        url: item.url,
        abstractSnippet: record.abstract.length === 0 ? undefined : record.abstract.slice(0, 400)
      }
    })
  })

  return {
    records,
    skipped,
    refused: parsed.skipped.map((entry) => ({
      line: entry.line,
      reason: entry.reason,
      detail: entry.detail
    }))
  }
}
