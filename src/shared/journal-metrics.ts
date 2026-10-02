// Journal metric import (R2, the producer side of `JournalMetric`). One row is one claim about one journal,
// in one year, from one source.
//
// Three rules are structural here, and each exists because the alternative looks like success:
//   * a row without a year or a source never reaches the database — an undated, unsourced number is not a
//     fact, and a surface that later has to print "which year, which source" would have to invent both;
//   * every input row produces exactly ONE outcome, in input order, with a NAMED reason when it is skipped,
//     so "nothing was importable" and "nothing was reported" can never look the same;
//   * an identifier that is not well formed is refused, never repaired (`normalizeIssn` owns that rule).
//
// Blank lines are not rows: they carry no claim, so skipping them drops nothing. Every other line of the
// table — including a line with the wrong number of fields — produces an outcome.

import { normalizeIssn } from './journal-identity'

// The kinds the library knows about, listed so a caller can be told what is expected. The store itself
// keeps accepting any non-empty kind: a new publisher table must not require a code change.
export const KNOWN_JOURNAL_METRIC_KINDS = Object.freeze([
  'impact-factor',
  'jcr-quartile',
  'cas-partition',
  'cas-top',
  'acceptance-rate'
] as const)

export type JournalMetricImportRow = {
  issn?: string | null
  journalName?: string | null
  kind: string
  value: string
  year?: number | string | null
  source?: string | null
  note?: string | null
}

// Request-level shapes: either structured rows from a caller that already parsed them, or the raw text of a
// downloaded table. Exactly one of the two is required — accepting both would make precedence a silent
// decision about which file was imported.
export type JournalMetricImportRequest = {
  rows?: readonly JournalMetricImportRow[]
  text?: string
  format?: 'csv' | 'tsv'
  // Used for tables that have no kind column (most publisher exports): every row of such a table is the same
  // kind of metric, and naming it once is how the caller says so. A kind cell with a value always wins.
  defaultKind?: string
}

// Named reasons a row can be refused. Every one of them is a statement about the row, not a fallback: an
// engine failure is never recorded here (it aborts the import instead), which is what keeps "skipped" from
// meaning "something went wrong somewhere".
export type JournalMetricRowProblem =
  | 'malformed-row'
  | 'no-kind'
  | 'no-value'
  | 'no-year'
  | 'no-source'
  | 'bad-issn'
  | 'name-missing'
  | 'name-ambiguous'
  | 'duplicate'

export type ValidatedJournalMetricRow = {
  issn: string | null
  journalName: string | null
  kind: string
  value: string
  year: number
  source: string
  note: string | null
}

export type JournalMetricRowValidation =
  | { ok: true; row: ValidatedJournalMetricRow }
  | { ok: false; reason: JournalMetricRowProblem; detail: string }

export type JournalMetricImportOutcome =
  | {
      index: number
      line?: number
      status: 'imported'
      kind: string
      value: string
      year: number
      source: string
      journalId: string
      // Which rule identified the journal. `by-alias` (R2-U4) means the row's own name is an alias of a
      // journal the user explicitly merged — the same journal under an older spelling.
      journalMatch: 'by-issn' | 'by-normalized-name' | 'by-alias'
      // True when this row is what brought the journal into the library, so the report can say how many
      // identities the import established rather than only how many numbers it stored.
      journalCreated: boolean
      metricId: string
    }
  | {
      index: number
      line?: number
      status: 'skipped'
      reason: JournalMetricRowProblem
      detail: string
    }

export type JournalMetricImportResult = {
  imported: number
  skipped: number
  journalsCreated: number
  outcomes: readonly JournalMetricImportOutcome[]
}

// A row as it came off the table, before validation. `problem` entries are lines that could not even be
// shaped into a row (a wrong field count), reported rather than dropped.
export type JournalMetricImportCandidate = {
  index: number
  line?: number
  row?: JournalMetricImportRow
  problem?: JournalMetricRowProblem
  detail?: string
}

const text = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value).trim()

// A metric year is a gregorian year: four digits, nothing else. "2024.0", "24" and "n/a" are all refused
// rather than squeezed into a number, because a squeezed year is a fabricated one.
const parseYear = (value: number | string | null | undefined): number | null => {
  if (typeof value === 'number')
    return Number.isInteger(value) && value >= 1000 && value <= 2999 ? value : null
  const raw = text(value)
  if (!/^\d{4}$/.test(raw)) return null
  const year = Number.parseInt(raw, 10)

  return year >= 1000 && year <= 2999 ? year : null
}

export const validateJournalMetricRow = (
  row: JournalMetricImportRow | null | undefined
): JournalMetricRowValidation => {
  if (!row || typeof row !== 'object') {
    return { ok: false, reason: 'malformed-row', detail: 'the row is not an object' }
  }
  const kind = text(row.kind)
  if (!kind) {
    return {
      ok: false,
      reason: 'no-kind',
      detail: 'no metric kind: a number with no kind cannot be filtered, compared or labelled'
    }
  }
  const value = text(row.value)
  if (!value) {
    return {
      ok: false,
      reason: 'no-value',
      detail: 'no value: a blank cell is a missing measurement, not a zero'
    }
  }
  const year = parseYear(row.year)
  if (year === null) {
    return {
      ok: false,
      reason: 'no-year',
      detail: `year ${JSON.stringify(row.year ?? null)} is not a four-digit year`
    }
  }
  const source = text(row.source)
  if (!source) {
    return {
      ok: false,
      reason: 'no-source',
      detail: 'no source: a number whose source is unknown cannot be checked or cited'
    }
  }
  const rawIssn = text(row.issn)
  const issn = rawIssn ? normalizeIssn(rawIssn) : undefined
  if (rawIssn && !issn) {
    return {
      ok: false,
      reason: 'bad-issn',
      detail: `ISSN ${JSON.stringify(rawIssn)} is not a well-formed ISSN, and a repaired identifier is a fabricated one`
    }
  }
  const journalName = text(row.journalName)
  if (!issn && !journalName) {
    return {
      ok: false,
      reason: 'name-missing',
      detail: 'neither an ISSN nor a journal name: a metric belongs to a journal, not to a row'
    }
  }

  return {
    ok: true,
    row: {
      issn: issn ?? null,
      journalName: journalName || null,
      kind,
      value,
      year,
      source,
      note: text(row.note) || null
    }
  }
}

type ColumnKey = 'issn' | 'journalName' | 'kind' | 'value' | 'year' | 'source' | 'note'

// Deliberately narrow: every alias here means "the journal" in a metric table. Ambiguous words a publisher
// table might use for something else (a bare `name`, `title`, `category`) are NOT aliases — mapping an
// article title to a journal name would create a journal nobody asked for, which is the exact failure the
// journal entity exists to prevent.
const COLUMN_ALIASES: Readonly<Record<ColumnKey, readonly string[]>> = Object.freeze({
  issn: ['issn', 'issn l', 'eissn', 'issn no'],
  journalName: [
    'journal',
    'journalname',
    'journal name',
    'publication',
    'venue',
    'periodical',
    '期刊',
    '期刊名称',
    '刊名'
  ],
  kind: ['kind', 'metric', 'metric kind', 'metrickind', 'type', '指标', '指标类型', '类型'],
  value: ['value', 'metric value', 'metricvalue', 'score', 'indicator', '指标值', '值'],
  year: ['year', 'metric year', '年份', '年度'],
  source: ['source', 'data source', 'datasource', 'provider', '来源', '数据来源'],
  note: ['note', 'notes', 'remark', '备注']
})

const normaliseHeaderCell = (cell: string): string =>
  cell
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim()

const splitDelimited = (line: string, format: 'csv' | 'tsv'): string[] => {
  if (format === 'tsv') return line.split('\t').map((cell) => cell.trim())

  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        current += char
      }
      continue
    }
    if (char === '"' && current.trim() === '') {
      quoted = true
      current = ''
    } else if (char === ',') {
      cells.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current.trim())

  return cells
}

const NON_ROW_COLUMNS: readonly ColumnKey[] = ['issn', 'journalName']

const missingColumns = (
  columns: Partial<Record<ColumnKey, number>>,
  options: { defaultKind?: string }
): string[] => {
  const missing: string[] = []
  if (columns.value === undefined) missing.push('value')
  if (columns.year === undefined) missing.push('year')
  if (columns.source === undefined) missing.push('source')
  if (columns.kind === undefined && !text(options.defaultKind))
    missing.push('kind (or defaultKind)')
  if (NON_ROW_COLUMNS.every((key) => columns[key] === undefined))
    missing.push('issn or a journal name column')

  return missing
}

// Parses the text of a downloaded table into one candidate per data line. A missing required column is a
// REQUEST failure (nothing in the table could be imported, and the message names what was looked for); a
// line with the wrong field count is a ROW outcome, because the rest of the table is still importable.
export const prepareJournalMetricCandidates = (
  request: JournalMetricImportRequest
): JournalMetricImportCandidate[] => {
  const hasRows = request.rows !== undefined
  const hasText = request.text !== undefined
  if (hasRows && hasText) {
    throw new Error('Journal metric import takes either rows or text, not both.')
  }
  if (!hasRows && !hasText) {
    throw new Error('Journal metric import needs either rows or the text of a table.')
  }
  if (hasRows) {
    return (request.rows ?? []).map((row, index) => ({ index, row }))
  }

  const format = request.format
  if (format !== 'csv' && format !== 'tsv') {
    throw new Error('Journal metric import from text needs format "csv" or "tsv".')
  }

  const lines = String(request.text ?? '')
    .split(/\r?\n/)
    .map((line, position) => ({ line: position + 1, text: line }))
    .filter((entry) => entry.text.trim() !== '')
  if (lines.length === 0) {
    throw new Error('Journal metric import table is empty: there is no header row to read.')
  }

  const header = splitDelimited(lines[0].text, format)
  const columns: Partial<Record<ColumnKey, number>> = {}
  header.forEach((cell, index) => {
    const key = normaliseHeaderCell(cell)
    for (const [column, aliases] of Object.entries(COLUMN_ALIASES) as Array<
      [ColumnKey, readonly string[]]
    >) {
      if (columns[column] === undefined && aliases.includes(key)) columns[column] = index
    }
  })
  const missing = missingColumns(columns, request)
  if (missing.length > 0) {
    throw new Error(
      `Journal metric import table is missing required column(s): ${missing.join(', ')}. Headers found: ${header.join(' | ')}`
    )
  }

  const defaultKind = text(request.defaultKind)
  return lines.slice(1).map((entry, index) => {
    const cells = splitDelimited(entry.text, format)
    if (cells.length !== header.length) {
      return {
        index,
        line: entry.line,
        problem: 'malformed-row' as const,
        detail: `the table has ${header.length} columns but this line has ${cells.length} fields`
      }
    }
    const pick = (key: ColumnKey): string => {
      const position = columns[key]

      return position === undefined ? '' : (cells[position] ?? '').trim()
    }
    const year = pick('year')

    return {
      index,
      line: entry.line,
      row: {
        issn: pick('issn'),
        journalName: pick('journalName'),
        kind: pick('kind') || defaultKind,
        value: pick('value'),
        year: year === '' ? null : year,
        source: pick('source'),
        note: pick('note')
      }
    }
  })
}
