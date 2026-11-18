// EndNote tagged (.enw) and MEDLINE (.nbib) import — the two plain-text exports the RIS reader does not
// cover, and the ones a reader gets when they pick "EndNote" or "PubMed / MEDLINE" in a database's export
// menu instead of RIS.
//
// The output is deliberately the same shape `parseRis` produces, so one plan builder serves all three
// dialects: the duplicate rule, the 500-record limit and the "what was refused" reporting exist once.
//
// Rules (identical to the RIS side):
//   1. A field is written only when the record carries it — no DOI is never turned into one derived from the
//      title.
//   2. What cannot be read is reported with the line that carried it, never dropped silently.
//   3. The same bytes give the same records in the same order.
//
// Dialect notes that cost me a round trip each:
//   - EndNote tags are `%` + one letter (`%0 Journal Article`, `%A 张三`), records separated by a blank line.
//     A tag may repeat (authors, keywords) and a value may wrap onto an unindented line; both are folded back.
//   - MEDLINE tags are at most four characters wide plus `- `, and **continuation lines are indented**, which
//     is the opposite of EndNote and the reason one parser cannot be bent into the other.

import type { CitationItem, CitationItemType } from './types'
import type { RisImportResult, RisImportedRecord, RisSkippedRecord } from './ris-import'

const clean = (value: string): string => value.replace(/\s+/gu, ' ').trim()

const yearOf = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const match = /(1[5-9]\d{2}|20\d{2})/u.exec(raw)
  if (match?.[1] === undefined) return undefined
  const year = Number(match[1])
  return Number.isFinite(year) ? year : undefined
}

const pagesOf = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined
  const value = clean(raw)
  return value.length === 0 ? undefined : value.replace(/[–—]/gu, '-')
}

const doiOf = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined
  const value = clean(raw)
    .replace(/^https?:\/\/(dx\.)?doi\.org\//iu, '')
    .replace(/^doi:\s*/iu, '')
    .replace(/\s*\[(doi|pii)\]\s*$/iu, '')
    .trim()
  // MEDLINE writes publisher item identifiers in the same tags as DOIs (`LID - 88/4/401M [pii]`), and every
  // real DOI starts with `10.`. Anything else is not an identifier we can resolve, so it is left absent
  // rather than stored as a DOI that would 404 on the resolver.
  return /^10\.\S+/u.test(value) ? value : undefined
}

// EndNote's own type words. Anything else keeps its raw word and is typed `unknown`, never coerced into a
// neighbouring type: calling a standard a journal article would put a wrong citation on the page.
const ENDNOTE_TYPE_MAP: Record<string, CitationItemType> = {
  'journal article': 'journal-article',
  'magazine article': 'journal-article',
  'newspaper article': 'web',
  'conference paper': 'conference-paper',
  'conference proceedings': 'conference-paper',
  book: 'book',
  'edited book': 'book',
  'book section': 'chapter',
  'electronic book': 'book',
  'electronic article': 'journal-article',
  thesis: 'thesis',
  report: 'report',
  'web page': 'web',
  dataset: 'dataset',
  preprint: 'preprint',
  generic: 'unknown'
}

// MEDLINE's `PT  -` words, mapped only where the word really names our type.
const MEDLINE_TYPE_MAP: Record<string, CitationItemType> = {
  'journal article': 'journal-article',
  review: 'journal-article',
  'clinical trial': 'journal-article',
  'randomized controlled trial': 'journal-article',
  'meta-analysis': 'journal-article',
  preprint: 'preprint',
  dataset: 'dataset'
}

type TaggedRecord = {
  startLine: number
  /** Tag → its values in file order (EndNote repeats tags, MEDLINE repeats `AU`). */
  tags: Map<string, string[]>
}

const pushTag = (record: TaggedRecord, tag: string, value: string): void => {
  const existing = record.tags.get(tag)
  if (existing) existing.push(value)
  else record.tags.set(tag, [value])
}

const firstOf = (record: TaggedRecord, tags: readonly string[]): string | undefined => {
  for (const tag of tags) {
    const values = record.tags.get(tag)
    const value = values?.[0]
    if (value !== undefined && value.trim() !== '') return value.trim()
  }
  return undefined
}

// The first identifier that is really a DOI, across every tag and every value that carries one. MEDLINE can
// put a `[pii]` in `LID` and the DOI in `AID`, so taking the first value outright would lose the DOI.
const doiFrom = (record: TaggedRecord, tags: readonly string[]): string | undefined => {
  for (const tag of tags) {
    for (const raw of record.tags.get(tag) ?? []) {
      const doi = doiOf(raw)
      if (doi !== undefined) return doi
    }
  }
  return undefined
}

const allOf = (record: TaggedRecord, tags: readonly string[]): string[] => {
  const values: string[] = []
  for (const tag of tags) values.push(...(record.tags.get(tag) ?? []))
  return values.map((value) => clean(value)).filter((value) => value !== '')
}

const toRecord = (
  record: TaggedRecord,
  options: {
    typeMap: Record<string, CitationItemType>
    typeTags: readonly string[]
    titleTags: readonly string[]
    authorTags: readonly string[]
    containerTags: readonly string[]
    yearTags: readonly string[]
    abstractTags: readonly string[]
    keywordTags: readonly string[]
    doiTags: readonly string[]
    urlTags: readonly string[]
    publisherTags: readonly string[]
    volumeTags: readonly string[]
    issueTags: readonly string[]
    pageTags: readonly string[]
    pmidTags: readonly string[]
    unmappedTags: Record<string, number>
    unmappedTypes: Record<string, number>
  }
): RisImportedRecord[] => {
  const title = firstOf(record, options.titleTags)
  if (title === undefined) return []

  for (const tag of record.tags.keys()) {
    const known =
      options.typeTags.includes(tag) ||
      options.titleTags.includes(tag) ||
      options.authorTags.includes(tag) ||
      options.containerTags.includes(tag) ||
      options.yearTags.includes(tag) ||
      options.abstractTags.includes(tag) ||
      options.keywordTags.includes(tag) ||
      options.doiTags.includes(tag) ||
      options.urlTags.includes(tag) ||
      options.publisherTags.includes(tag) ||
      options.volumeTags.includes(tag) ||
      options.issueTags.includes(tag) ||
      options.pageTags.includes(tag) ||
      options.pmidTags.includes(tag)
    if (!known) options.unmappedTags[tag] = (options.unmappedTags[tag] ?? 0) + 1
  }

  const rawType = firstOf(record, options.typeTags)
  const mapped = rawType === undefined ? undefined : options.typeMap[rawType.toLowerCase()]
  if (rawType !== undefined && mapped === undefined) {
    options.unmappedTypes[rawType] = (options.unmappedTypes[rawType] ?? 0) + 1
  }

  const item: CitationItem = {
    title: clean(title),
    authors: allOf(record, options.authorTags).map((name) => ({ name })),
    ...(firstOf(record, options.containerTags) === undefined
      ? {}
      : { containerTitle: clean(firstOf(record, options.containerTags) as string) }),
    ...(yearOf(firstOf(record, options.yearTags)) === undefined
      ? {}
      : { year: yearOf(firstOf(record, options.yearTags)) }),
    ...(firstOf(record, options.volumeTags) === undefined
      ? {}
      : { volume: clean(firstOf(record, options.volumeTags) as string) }),
    ...(firstOf(record, options.issueTags) === undefined
      ? {}
      : { issue: clean(firstOf(record, options.issueTags) as string) }),
    ...(pagesOf(firstOf(record, options.pageTags)) === undefined
      ? {}
      : { pages: pagesOf(firstOf(record, options.pageTags)) }),
    ...(firstOf(record, options.publisherTags) === undefined
      ? {}
      : { publisher: clean(firstOf(record, options.publisherTags) as string) }),
    ...(doiFrom(record, options.doiTags) === undefined
      ? {}
      : { doi: doiFrom(record, options.doiTags) }),
    ...(firstOf(record, options.pmidTags) === undefined
      ? {}
      : { pmid: clean(firstOf(record, options.pmidTags) as string) }),
    ...(firstOf(record, options.urlTags) === undefined
      ? {}
      : { url: clean(firstOf(record, options.urlTags) as string) }),
    ...(mapped === undefined ? {} : { itemType: mapped })
  }

  const abstract = firstOf(record, options.abstractTags)
  return [
    {
      item,
      abstract: abstract === undefined ? '' : clean(abstract),
      keywords: allOf(record, options.keywordTags),
      ...(rawType === undefined ? {} : { rawType })
    }
  ]
}

/**
 * EndNote tagged export. Tags are `%` + one character; a record starts at `%0` and ends at a blank line.
 * Values wrap onto continuation lines often enough (long titles, abstracts) that folding them back matters:
 * a title split across two lines is still one title.
 */
export const parseEndNoteTagged = (text: string): RisImportResult => {
  const records: TaggedRecord[] = []
  const skipped: RisSkippedRecord[] = []
  let current: TaggedRecord | undefined
  let lastTag: string | undefined

  const lines = text.split(/\r?\n/u)
  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1
    const line = rawLine.replace(/\uFEFF/gu, '')
    if (line.trim() === '') {
      // A blank line closes the record under construction; the next tag starts a new one.
      current = undefined
      lastTag = undefined
      return
    }
    const match = /^%(\S)\s?(.*)$/u.exec(line)
    if (match === null) {
      // A non-tag line belongs to the value above it (wrapped value), not to a new field.
      if (current !== undefined && lastTag !== undefined) {
        const values = current.tags.get(lastTag)
        const last = values?.[values.length - 1]
        if (values !== undefined && last !== undefined)
          values[values.length - 1] = `${last} ${line.trim()}`
        return
      }
      skipped.push({
        line: lineNumber,
        reason: 'unparsable-line',
        detail: line.trim().slice(0, 160)
      })
      return
    }
    const tag = match[1] as string
    const value = match[2] ?? ''
    if (tag === '0' || current === undefined) {
      current = { startLine: lineNumber, tags: new Map() }
      records.push(current)
    }
    pushTag(current, tag, value)
    lastTag = tag
  })

  const unmappedTags: Record<string, number> = {}
  const unmappedTypes: Record<string, number> = {}
  const imported: RisImportedRecord[] = []
  for (const record of records) {
    const rows = toRecord(record, {
      typeMap: ENDNOTE_TYPE_MAP,
      typeTags: ['0'],
      titleTags: ['T'],
      authorTags: ['A'],
      containerTags: ['J', 'B'],
      yearTags: ['D'],
      abstractTags: ['X'],
      keywordTags: ['K'],
      doiTags: ['R'],
      urlTags: ['U'],
      publisherTags: ['I'],
      volumeTags: ['V'],
      issueTags: ['N'],
      pageTags: ['P'],
      pmidTags: ['M'],
      unmappedTags,
      unmappedTypes
    })
    if (rows.length === 0) {
      skipped.push({
        line: record.startLine,
        reason: 'no-title',
        detail: `EndNote record at line ${record.startLine}`
      })
      continue
    }
    imported.push(...rows)
  }

  return { records: imported, skipped, unmappedTags, unmappedTypes }
}

/**
 * MEDLINE / PubMed "Format: MEDLINE" export (`.nbib`). Tags are up to four characters followed by `- `, and
 * continuation lines are **indented** — the opposite of EndNote, which is why this is a second parser rather
 * than a table of tag names.
 */
export const parseMedline = (text: string): RisImportResult => {
  const records: TaggedRecord[] = []
  const skipped: RisSkippedRecord[] = []
  let current: TaggedRecord | undefined
  let lastTag: string | undefined

  const lines = text.split(/\r?\n/u)
  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1
    const line = rawLine.replace(/\uFEFF/gu, '')
    if (line.trim() === '') {
      current = undefined
      lastTag = undefined
      return
    }
    if (/^\s/u.test(line)) {
      if (current !== undefined && lastTag !== undefined) {
        const values = current.tags.get(lastTag)
        const last = values?.[values.length - 1]
        if (values !== undefined && last !== undefined)
          values[values.length - 1] = `${last} ${line.trim()}`
        return
      }
      skipped.push({
        line: lineNumber,
        reason: 'unparsable-line',
        detail: line.trim().slice(0, 160)
      })
      return
    }
    const match = /^([A-Z]{2,4})\s*-\s?(.*)$/u.exec(line)
    if (match === null) {
      skipped.push({
        line: lineNumber,
        reason: 'unparsable-line',
        detail: line.trim().slice(0, 160)
      })
      return
    }
    const tag = match[1] as string
    const value = match[2] ?? ''
    if (tag === 'PMID') current = { startLine: lineNumber, tags: new Map() }
    if (current === undefined) {
      skipped.push({ line: lineNumber, reason: 'not-a-record', detail: line.trim().slice(0, 160) })
      return
    }
    if (tag === 'PMID' && records[records.length - 1] !== current) records.push(current)
    pushTag(current, tag, value)
    lastTag = tag
  })

  const unmappedTags: Record<string, number> = {}
  const unmappedTypes: Record<string, number> = {}
  const imported: RisImportedRecord[] = []
  for (const record of records) {
    const rows = toRecord(record, {
      typeMap: MEDLINE_TYPE_MAP,
      typeTags: ['PT'],
      titleTags: ['TI'],
      authorTags: ['AU'],
      containerTags: ['JT', 'TA'],
      yearTags: ['DP'],
      abstractTags: ['AB'],
      keywordTags: ['OT'],
      doiTags: ['LID', 'AID'],
      urlTags: ['URL'],
      publisherTags: [],
      volumeTags: ['VI'],
      issueTags: ['IP'],
      pageTags: ['PG'],
      pmidTags: ['PMID'],
      unmappedTags,
      unmappedTypes
    })
    if (rows.length === 0) {
      skipped.push({
        line: record.startLine,
        reason: 'no-title',
        detail: `MEDLINE record at line ${record.startLine}`
      })
      continue
    }
    imported.push(...rows)
  }

  return { records: imported, skipped, unmappedTags, unmappedTypes }
}

/** True when the text looks like an EndNote tagged export. Detection is by content, never by file name. */
export const looksLikeEndNote = (text: string): boolean =>
  /^%\S\s/u.test(text.replace(/^\uFEFF/u, '').trimStart())

/** True when the text looks like a MEDLINE export: a `PMID- ` (or another 2–4 letter tag) first line. */
export const looksLikeMedline = (text: string): boolean =>
  /^[A-Z]{2,4}\s*-\s/u.test(text.replace(/^\uFEFF/u, '').trimStart())
