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
    /**
     * Fallback type words that are not a whole word but a family prefix: CNKI's `SrcDatabase` writes the
     * database code (`CJFD2022`, `CMFD2014`, `CPFD2021`) rather than a type, and the first two letters are
     * what names the kind. Ordered — the first match wins.
     */
    typePrefixes?: ReadonlyArray<readonly [RegExp, CitationItemType]>
    /** Tags that are known and deliberately carry nothing a citation can use (`DataType: 1`). */
    ignoredTags?: readonly string[]
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
      options.pmidTags.includes(tag) ||
      (options.ignoredTags?.includes(tag) ?? false)
    if (!known) options.unmappedTags[tag] = (options.unmappedTags[tag] ?? 0) + 1
  }

  const rawType = firstOf(record, options.typeTags)
  const mapped =
    rawType === undefined
      ? undefined
      : (options.typeMap[rawType.toLowerCase()] ??
        options.typePrefixes?.find(([pattern]) => pattern.test(rawType))?.[1])
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

// ---------------------------------------------------------------------------------------------------------
// CNKI's own text export ("导出/参考文献 → CNKI 格式", copied or saved as .txt)
//
// The tags are `EnglishName-ChineseLabel:` — a shape none of the dialects above has, which is what detection
// keys on. Two label generations are in real exports and they are not synonyms:
//
//   2022 export: Source-文献来源 · PubTime-发表时间 · Volume-卷    · PageCount-页码 (the pages)
//   2021 export: Source-刊名     · PubTime-出版时间 · Roll-卷      · Page-页码 (the pages)
//                                                                · PageCount-页数 (a COUNT: "3")
//
// So the record is keyed by the composite label, not by the English name: a bare `PageCount` would turn
// "this article is 3 pages long" into pages `3`, which is a citation that points at nothing. Same reason the
// list of tags is written out per generation below instead of matched loosely.
//
// What it must not do (each one is a way to invent a fact):
//   - `Organ-单位` is the authors' affiliation, never the publisher.
//   - `URL-网址: [Link]` / `DOI-DOI: 10.…/[Link].…` appear in copies whose links were elided. A value that is
//     not an http(s) URL, or a DOI with a bracketed placeholder in it, is left absent rather than stored as an
//     identifier that would 404 on the resolver.
//   - Authors and keywords are `;`-separated (often with a trailing `;`, keywords often with `;;`); they are
//     split into separate values so one author is never one giant string.
// ---------------------------------------------------------------------------------------------------------

const CNKI_PROFILE = {
  typeTags: ['SrcDatabase-来源库'] as const,
  titleTags: ['Title-题名'] as const,
  authorTags: ['Author-作者'] as const,
  containerTags: ['Source-文献来源', 'Source-刊名'] as const,
  yearTags: ['Year-年', 'PubTime-发表时间', 'PubTime-出版时间'] as const,
  abstractTags: ['Summary-摘要'] as const,
  keywordTags: ['Keyword-关键词'] as const,
  doiTags: ['DOI-DOI'] as const,
  urlTags: ['URL-网址', 'Link-链接'] as const,
  volumeTags: ['Volume-卷', 'Roll-卷'] as const,
  issueTags: ['Period-期'] as const,
  pageTags: ['Page-页码', 'PageCount-页码'] as const,
  ignoredTags: ['DataType'] as const
}

/** Whole-word `SrcDatabase` values, then the database codes the same field writes in older exports. */
const CNKI_TYPE_MAP: Record<string, CitationItemType> = {
  期刊: 'journal-article',
  博士: 'thesis',
  硕士: 'thesis',
  学位论文: 'thesis',
  会议: 'conference-paper',
  图书: 'book'
}

const CNKI_TYPE_PREFIXES: ReadonlyArray<readonly [RegExp, CitationItemType]> = [
  [/^CJFD|^CJFQ|^CJFZ|^CJFN/u, 'journal-article'],
  [/^CMFD|^CDFD/u, 'thesis'],
  [/^CPFD|^IPFD/u, 'conference-paper']
]

/** `English-Chinese:` or a bare `English:` (`DataType: 1`), value after the colon. */
const CNKI_LINE = /^([A-Za-z][A-Za-z0-9]*)\s*(?:-([^:：]{1,24}))?[:：]\s?(.*)$/u

/** Split `a;b;;c;` into `['a','b','c']` on either semicolon, dropping the empty slots. */
const splitCnkiList = (value: string): string[] =>
  value
    .split(/[;；]/u)
    .map((part) => part.trim())
    .filter((part) => part !== '')

const isWebUrl = (value: string): boolean => /^https?:\/\//iu.test(value.trim())

/**
 * CNKI 格式 export. Records are separated by a blank line in the 2022 generation and by nothing at all in the
 * 2021 one, where each record restarts at `DataType:` / a second `Title-`. Both are handled: a repeated title
 * or database field closes the record under construction.
 */
export const parseCnkiTagged = (text: string): RisImportResult => {
  const records: TaggedRecord[] = []
  const skipped: RisSkippedRecord[] = []
  let current: TaggedRecord | undefined
  let lastTag: string | undefined

  const push = (record: TaggedRecord, key: string, value: string): void => {
    if (key === 'Author-作者' || key === 'Keyword-关键词') {
      for (const part of splitCnkiList(value)) pushTag(record, key, part)
      return
    }
    // A placeholder is not an identifier: `[Link]` in the URL field of an elided copy, and a DOI with a
    // bracketed placeholder inside it, are both refused here rather than stored as facts.
    if ((CNKI_PROFILE.urlTags as readonly string[]).includes(key) && !isWebUrl(value)) return
    if ((CNKI_PROFILE.doiTags as readonly string[]).includes(key) && /[[\]]/u.test(value)) return
    if ((CNKI_PROFILE.doiTags as readonly string[]).includes(key) && !/^10\./u.test(value.trim()))
      return
    pushTag(record, key, value)
  }

  const lines = text.split(/\r?\n/u)
  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1
    const line = rawLine.replace(/\uFEFF/gu, '')
    if (line.trim() === '') {
      current = undefined
      lastTag = undefined
      return
    }
    const match = CNKI_LINE.exec(line)
    if (match === null) {
      // A wrapped value belongs to the tag above it, never to a new field.
      if (current !== undefined && lastTag !== undefined) {
        const values = current.tags.get(lastTag)
        const last = values?.[values.length - 1]
        if (values !== undefined && last !== undefined) {
          values[values.length - 1] = `${last} ${line.trim()}`
          return
        }
      }
      skipped.push({
        line: lineNumber,
        reason: 'unparsable-line',
        detail: line.trim().slice(0, 160)
      })
      return
    }
    const english = match[1] as string
    const label = match[2]
    const key = label === undefined ? english : `${english}-${label.trim()}`
    const opensRecord =
      key === 'DataType' ||
      (key === 'Title-题名' && (current?.tags.has('Title-题名') ?? false)) ||
      (key === 'SrcDatabase-来源库' && (current?.tags.has('SrcDatabase-来源库') ?? false))
    if (current === undefined || opensRecord) {
      current = { startLine: lineNumber, tags: new Map() }
      records.push(current)
    }
    push(current, key, match[3] ?? '')
    lastTag = key
  })

  const unmappedTags: Record<string, number> = {}
  const unmappedTypes: Record<string, number> = {}
  const imported: RisImportedRecord[] = []
  for (const record of records) {
    const rows = toRecord(record, {
      typeMap: CNKI_TYPE_MAP,
      typePrefixes: CNKI_TYPE_PREFIXES,
      ignoredTags: CNKI_PROFILE.ignoredTags,
      typeTags: CNKI_PROFILE.typeTags,
      titleTags: CNKI_PROFILE.titleTags,
      authorTags: CNKI_PROFILE.authorTags,
      containerTags: CNKI_PROFILE.containerTags,
      yearTags: CNKI_PROFILE.yearTags,
      abstractTags: CNKI_PROFILE.abstractTags,
      keywordTags: CNKI_PROFILE.keywordTags,
      doiTags: CNKI_PROFILE.doiTags,
      urlTags: CNKI_PROFILE.urlTags,
      publisherTags: [],
      volumeTags: CNKI_PROFILE.volumeTags,
      issueTags: CNKI_PROFILE.issueTags,
      pageTags: CNKI_PROFILE.pageTags,
      pmidTags: [],
      unmappedTags,
      unmappedTypes
    })
    if (rows.length === 0) {
      skipped.push({
        line: record.startLine,
        reason: 'no-title',
        detail: `CNKI record at line ${record.startLine}`
      })
      continue
    }
    imported.push(...rows)
  }

  return { records: imported, skipped, unmappedTags, unmappedTypes }
}

/**
 * True when the text looks like a CNKI export. The 2021 generation opens with `DataType: 1`, so the first few
 * non-empty lines are scanned rather than just the first; the `English-Chinese:` shape is what is looked for,
 * and none of the other dialects can produce it.
 */
export const looksLikeCnki = (text: string): boolean => {
  const lines = text
    .replace(/^\uFEFF/u, '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, 5)
  return lines.some((line) => /^[A-Za-z][A-Za-z0-9]*-[\u3400-\u9fff][^:：]{0,20}[:：]/u.test(line))
}
