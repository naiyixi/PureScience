// RIS import — the other half of `ris.ts`. The export side exists because RIS is what reference managers
// read; this side exists because RIS is what **Chinese** databases write. CNKI, 万方, 维普, NoteExpress
// and EndNote all hand the user a .ris/.txt file, and until now the only way in was to retype the record.
//
// Rules, the same three the export side keeps:
//   1. A field is written only when the record carries it — an absent DOI stays absent, never '' and never
//      a guess derived from the title.
//   2. What we cannot read is reported, not silently dropped: a record with no title, or a line that fits
//      no tag, comes back in `skipped` with the reason and the line number, so the caller can show it.
//   3. Parsing is deterministic: the same bytes give the same records in the same order.

import type { CitationItem, CitationItemType } from './types'

/** `TY  - JOUR` — a two-character tag, two spaces, a hyphen, a space, then the value. */
const TAG_LINE = /^([A-Z][A-Z0-9]) {2}- ?(.*)$/u

// RIS type codes, including the ones Chinese databases emit. Anything unmapped keeps its raw code in
// `rawType` and is typed `unknown` rather than being forced into a neighbouring type.
const RIS_TYPE_MAP: Record<string, CitationItemType> = {
  JOUR: 'journal-article',
  JFULL: 'journal-article',
  MGZN: 'journal-article',
  CPAPER: 'conference-paper',
  CONF: 'conference-paper',
  BOOK: 'book',
  EBOOK: 'book',
  CHAP: 'chapter',
  ECHAP: 'chapter',
  RPRT: 'report',
  THES: 'thesis',
  DATA: 'dataset',
  ELEC: 'web',
  WEB: 'web',
  GEN: 'unknown',
  NEWS: 'web'
}

// Tags that carry the same field, in the order of preference: EndNote writes T1/A1, most Chinese
// exporters write TI/AU. Both spellings must land in the same field or the record loses half itself.
const TITLE_TAGS = ['TI', 'T1', 'CT', 'BT'] as const
const AUTHOR_TAGS = ['AU', 'A1'] as const
const CONTAINER_TAGS = ['JO', 'JF', 'T2', 'JA'] as const
const YEAR_TAGS = ['PY', 'Y1', 'DA'] as const
const ABSTRACT_TAGS = ['AB', 'N2'] as const
const KEYWORD_TAGS = ['KW'] as const

// Every tag the importer reads. Anything else is counted in `unmappedTags` so a new exporter's dialect
// shows up as data rather than as a silent loss.
const KNOWN_TAGS: ReadonlySet<string> = new Set([
  'TY',
  'ER',
  ...TITLE_TAGS,
  ...AUTHOR_TAGS,
  ...CONTAINER_TAGS,
  ...YEAR_TAGS,
  ...ABSTRACT_TAGS,
  ...KEYWORD_TAGS,
  'DO',
  'UR',
  'L1',
  'VL',
  'IS',
  'SP',
  'EP',
  'PB',
  'SN',
  'ET',
  'M1',
  'M3',
  'LA',
  'DB',
  'AN',
  'ID',
  'C1',
  'C2',
  'C3',
  'C4',
  'C5',
  'C6',
  'C7',
  'C8',
  'N1',
  'OP',
  'RI',
  'RN',
  'SE',
  'ST',
  'U1',
  'U2',
  'U3',
  'U4',
  'U5',
  'Y2',
  'TA'
])

export type RisSkippedReason = 'no-title' | 'unparsable-line' | 'not-a-record'

export type RisSkippedRecord = {
  /** 1-based line in the input where the record (or the offending line) starts. */
  line: number
  reason: RisSkippedReason
  /** The raw text that could not be used, trimmed — shown to whoever imported the file. */
  detail: string
}

/** A record as the file wrote it: the citation fields, plus the two the library stores but citing does not. */
export type RisImportedRecord = {
  item: CitationItem
  /** Empty when the file carried none. Never synthesised from the title. */
  abstract: string
  keywords: string[]
  /** The raw RIS type code, e.g. `JOUR` or `STANDARD`. Absent when the record had no `TY`. */
  rawType?: string
}

export type RisImportResult = {
  records: RisImportedRecord[]
  skipped: RisSkippedRecord[]
  /** Tags we saw but do not map, with how many records carried them. Nothing is invented for them. */
  unmappedTags: Record<string, number>
  /** RIS type codes we do not map, e.g. `STANDARD`. */
  unmappedTypes: Record<string, number>
}

type MutableRecord = {
  startLine: number
  tags: Map<string, string[]>
}

const clean = (value: string): string => value.replace(/\s+/gu, ' ').trim()

/** A year is the first run of four digits that can be one; `2021/03/14` and `(2021)` both give 2021. */
const yearOf = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const match = /(1[5-9]\d{2}|20\d{2})/u.exec(raw)
  if (match?.[1] === undefined) return undefined
  const year = Number(match[1])
  return Number.isFinite(year) ? year : undefined
}

/** `12-18`, `12–18`, `e12345` — kept as written; only the dash is normalised. */
const pagesOf = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined
  const value = clean(raw)
  return value.length === 0 ? undefined : value.replace(/[–—]/gu, '-')
}

const firstTag = (record: MutableRecord, tags: readonly string[]): string | undefined => {
  for (const tag of tags) {
    const value = record.tags.get(tag)?.find((candidate) => candidate.length > 0)
    if (value !== undefined) return value
  }
  return undefined
}

const allTagValues = (record: MutableRecord, tags: readonly string[]): string[] =>
  tags.flatMap((tag) => record.tags.get(tag) ?? []).filter((value) => value.length > 0)

const optional = <K extends keyof CitationItem>(
  key: K,
  value: CitationItem[K] | undefined
): Partial<Pick<CitationItem, K>> =>
  value === undefined || value === '' ? {} : ({ [key]: value } as Pick<CitationItem, K>)

const trimmed = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const clean_ = clean(value)
  return clean_.length === 0 ? undefined : clean_
}

const toRecord = (
  record: MutableRecord
): { record: RisImportedRecord } | { reason: RisSkippedReason } => {
  const title = trimmed(firstTag(record, TITLE_TAGS))
  if (title === undefined) return { reason: 'no-title' }

  const rawType = trimmed(firstTag(record, ['TY']))?.toUpperCase()
  // A TY we do not know is still a statement about the record's type: it is typed `unknown` and the raw
  // code is kept, so nothing downstream mistakes it for a journal article.
  const itemType: CitationItemType | undefined =
    rawType === undefined ? undefined : (RIS_TYPE_MAP[rawType] ?? 'unknown')

  const authors = allTagValues(record, AUTHOR_TAGS)
    .map((raw) => clean(raw).replace(/^[\s,;]+|[\s,;]+$/gu, ''))
    .filter((name) => name.length > 0)
    .map((name) => ({ name }))

  const doi = trimmed(firstTag(record, ['DO']))?.replace(/^https?:\/\/doi\.org\//iu, '')

  const item: CitationItem = {
    title,
    authors,
    ...optional('containerTitle', trimmed(firstTag(record, CONTAINER_TAGS))),
    ...optional('year', yearOf(firstTag(record, YEAR_TAGS))),
    ...optional('volume', trimmed(firstTag(record, ['VL']))),
    ...optional('issue', trimmed(firstTag(record, ['IS']))),
    ...optional('pages', pagesOf(firstTag(record, ['SP']))),
    ...optional('publisher', trimmed(firstTag(record, ['PB']))),
    ...optional('doi', doi),
    ...optional('url', trimmed(firstTag(record, ['UR', 'L1']))),
    ...optional('itemType', itemType)
  }

  return {
    record: {
      item,
      abstract: clean(firstTag(record, ABSTRACT_TAGS) ?? ''),
      keywords: allTagValues(record, KEYWORD_TAGS)
        .map(clean)
        .filter((value) => value.length > 0),
      ...(rawType === undefined ? {} : { rawType })
    }
  }
}

/**
 * Parses a RIS file into citation records. Accepts CRLF, a UTF-8 BOM, blank lines between tags, and
 * continuation lines (a value wrapped across lines, indented) — all of which appear in real exports.
 */
export const parseRis = (input: string): RisImportResult => {
  const text = input.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
  const lines = text.split('\n')

  const records: RisImportedRecord[] = []
  const skipped: RisSkippedRecord[] = []
  const unmappedTags: Record<string, number> = {}
  const unmappedTypes: Record<string, number> = {}

  let current: MutableRecord | undefined
  let lastTag: string | undefined

  const flush = (): void => {
    if (current === undefined) return
    if (current.tags.size === 0) {
      current = undefined
      lastTag = undefined
      return
    }
    const converted = toRecord(current)
    if ('reason' in converted) {
      skipped.push({
        line: current.startLine,
        reason: converted.reason,
        detail: clean([...current.tags.values()].flat().join(' ')) || '(empty record)'
      })
    } else {
      records.push(converted.record)
      const { rawType } = converted.record
      if (rawType !== undefined && RIS_TYPE_MAP[rawType] === undefined) {
        unmappedTypes[rawType] = (unmappedTypes[rawType] ?? 0) + 1
      }
    }
    current = undefined
    lastTag = undefined
  }

  lines.forEach((line, index) => {
    const lineNumber = index + 1

    // A blank line separates records in most exports and appears mid-record in a few; it never carries a
    // value, so it only ever closes a record that was left open without an ER.
    if (line.trim().length === 0) return

    const match = TAG_LINE.exec(line)
    if (match === null) {
      // Indented text continues the previous tag: some exporters wrap long titles and abstracts.
      if (current !== undefined && lastTag !== undefined && /^\s/u.test(line)) {
        const values = current.tags.get(lastTag)
        if (values !== undefined && values.length > 0) {
          const previous = values.pop() ?? ''
          values.push(clean(`${previous} ${line}`))
          return
        }
      }
      skipped.push({ line: lineNumber, reason: 'unparsable-line', detail: clean(line) })
      return
    }

    const [, tag = '', rawValue = ''] = match

    if (tag === 'TY') {
      flush()
      current = { startLine: lineNumber, tags: new Map([['TY', [clean(rawValue)]]]) }
      lastTag = 'TY'
      return
    }

    if (current === undefined) {
      // `ER` with no open record, or a stray tag: worth reporting, never worth guessing at.
      skipped.push({ line: lineNumber, reason: 'not-a-record', detail: clean(line) })
      return
    }

    if (tag === 'ER') {
      flush()
      return
    }

    const value = clean(rawValue)
    const values = current.tags.get(tag)
    if (values === undefined) current.tags.set(tag, [value])
    else values.push(value)
    lastTag = tag

    if (!KNOWN_TAGS.has(tag)) unmappedTags[tag] = (unmappedTags[tag] ?? 0) + 1
  })

  flush()

  return { records, skipped, unmappedTags, unmappedTypes }
}
