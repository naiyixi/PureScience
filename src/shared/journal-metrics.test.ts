import { describe, expect, it } from 'vitest'

import {
  prepareJournalMetricCandidates,
  validateJournalMetricRow,
  type JournalMetricImportRequest
} from './journal-metrics'

const reason = (request: JournalMetricImportRequest): string =>
  prepareJournalMetricCandidates(request)
    .map((candidate) => {
      if (candidate.problem) return candidate.problem
      const validation = validateJournalMetricRow(candidate.row)

      return validation.ok ? 'ok' : validation.reason
    })
    .join(',')

describe('validateJournalMetricRow', () => {
  it('refuses a number that cannot be labelled: no year, no source, no value, no kind', () => {
    const base = { kind: 'impact-factor', value: '48.5', year: 2024, source: 'JCR 2024' }

    expect(reason({ rows: [{ ...base, kind: '  ' }] })).toBe('no-kind')
    expect(reason({ rows: [{ ...base, value: '' }] })).toBe('no-value')
    expect(reason({ rows: [{ ...base, source: ' ' }] })).toBe('no-source')
    expect(reason({ rows: [{ ...base, year: null }] })).toBe('no-year')
    // A year is a gregorian year, not a number that contains one: these are refused, never rounded or read
    // as 24 (a "repaired" year is a fabricated one, and the whole point of the column is to be exact).
    expect(reason({ rows: [{ ...base, year: '2024.0' }] })).toBe('no-year')
    expect(reason({ rows: [{ ...base, year: '24' }] })).toBe('no-year')
    expect(reason({ rows: [{ ...base, year: Number.NaN }] })).toBe('no-year')
    expect(reason({ rows: [null as never] })).toBe('malformed-row')
  })

  it('refuses a malformed ISSN instead of repairing it, and accepts the printed forms', () => {
    const base = { kind: 'impact-factor', value: '48.5', year: 2024, source: 'JCR 2024' }

    expect(reason({ rows: [{ ...base, issn: '0028-083' }] })).toBe('bad-issn')
    expect(reason({ rows: [{ ...base, issn: 'n/a' }] })).toBe('bad-issn')

    const padded = validateJournalMetricRow({ ...base, issn: '00280836' })
    expect(padded.ok && padded.row.issn).toBe('0028-0836')
    const prefixed = validateJournalMetricRow({ ...base, issn: 'ISSN: 0028-0836' })
    expect(prefixed.ok && prefixed.row.issn).toBe('0028-0836')
  })

  it('needs an ISSN or a journal name — a metric belongs to a journal, not to a row', () => {
    expect(
      reason({ rows: [{ kind: 'impact-factor', value: '48.5', year: 2024, source: 'JCR 2024' }] })
    ).toBe('name-missing')
    const named = validateJournalMetricRow({
      journalName: '  Nature  ',
      kind: 'impact-factor',
      value: '48.5',
      year: '2024',
      source: ' JCR 2024 '
    })
    expect(named.ok && named.row).toEqual({
      issn: null,
      journalName: 'Nature',
      kind: 'impact-factor',
      value: '48.5',
      year: 2024,
      source: 'JCR 2024',
      note: null
    })
  })
})

describe('prepareJournalMetricCandidates', () => {
  it('takes rows or text, never both and never neither', () => {
    expect(() => prepareJournalMetricCandidates({})).toThrow(/either rows or the text/)
    expect(() => prepareJournalMetricCandidates({ rows: [], text: 'x', format: 'csv' })).toThrow(
      /not both/
    )
    expect(() => prepareJournalMetricCandidates({ text: 'x' })).toThrow(/format/)
  })

  it('reads a header by name, tolerating a BOM, quoting and a different column order', () => {
    const csv = [
      '\uFEFFSource,期刊名称,Year,Value,ISSN,Kind',
      'JCR 2024,Nature,2024,48.5,0028-0836,impact-factor',
      '"JCR 2024","Cell, and its relatives",2024,64.5,0092-8674,impact-factor'
    ].join('\n')

    const candidates = prepareJournalMetricCandidates({ text: csv, format: 'csv' })

    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toMatchObject({ index: 0, line: 2 })
    // The quoted cell keeps its comma instead of splitting the row: a journal name is not two columns.
    expect(candidates[1].row?.journalName).toBe('Cell, and its relatives')
    expect(candidates.map((candidate) => validateJournalMetricRow(candidate.row).ok)).toEqual([
      true,
      true
    ])
  })

  it('reports a line whose field count does not match the header instead of dropping it', () => {
    const tsv = [
      'Journal\tValue\tYear\tSource\tKind',
      'Nature\t48.5\t2024',
      'Cell\t64.5\t2024\tJCR\timpact-factor'
    ].join('\n')

    const candidates = prepareJournalMetricCandidates({ text: tsv, format: 'tsv' })

    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toMatchObject({ index: 0, line: 2, problem: 'malformed-row' })
    expect(candidates[0].detail).toMatch(/5 columns but this line has 3 fields/)
    expect(validateJournalMetricRow(candidates[1].row).ok).toBe(true)
  })

  it('names the columns it looked for when the table cannot be read at all', () => {
    expect(() =>
      prepareJournalMetricCandidates({ text: 'Journal,Year\nNature,2024', format: 'csv' })
    ).toThrow(/missing required column\(s\): value, source, kind \(or defaultKind\)/)
  })

  it('lets a table without a kind column say its kind once, and a cell override it', () => {
    const csv = [
      'Journal,Value,Year,Source',
      'Nature,48.5,2024,JCR 2024',
      'Cell,64.5,2024,JCR 2024'
    ].join('\n')
    expect(() => prepareJournalMetricCandidates({ text: csv, format: 'csv' })).toThrow(/kind/)

    const candidates = prepareJournalMetricCandidates({
      text: `${csv}\n`,
      format: 'csv',
      defaultKind: 'impact-factor'
    })
    expect(candidates.map((candidate) => candidate.row?.kind)).toEqual([
      'impact-factor',
      'impact-factor'
    ])
  })

  it('does not treat a blank line as a row, and keeps line numbers for the rows it does read', () => {
    const csv = [
      'Journal,Value,Year,Source,Kind',
      'Nature,48.5,2024,JCR,impact-factor',
      '',
      'Cell,64.5,2024,JCR,impact-factor'
    ].join('\n')

    const candidates = prepareJournalMetricCandidates({ text: csv, format: 'csv' })

    expect(candidates).toHaveLength(2)
    expect(candidates.map((candidate) => candidate.line)).toEqual([2, 4])
  })
})
