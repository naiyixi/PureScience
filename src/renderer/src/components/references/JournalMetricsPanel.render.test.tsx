// @vitest-environment jsdom
// Render tests for the journal-metric screening table. They pin the acceptance the plan states in words:
//
//   * a metric nobody imported reads "Unknown" — and the cell never shows a 0;
//   * every number is on screen with the year and the source it came from;
//   * the counts line reconciles all four buckets against the total, so "the filter matched nothing" can
//     never be read as "there are no journals".

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', () => {
  const labels: Record<string, string> = {
    'references.journalMetrics.unknown': 'Unknown',
    'references.journalMetrics.counts':
      '{matched} of {total} journals match · {missing} have no such metric · {notNumeric} have a value that is not a number · {notMatching} fall outside the bounds',
    'references.journalMetrics.kind.impactFactor': 'Impact factor',
    'references.journalMetrics.kind.casPartition': 'CAS partition'
  }

  return {
    useLanguage: () => ({
      t: (key: string, vars?: Record<string, string | number>): string => {
        const template = labels[key] ?? key
        if (!vars) return template
        return Object.entries(vars).reduce(
          (text, [name, value]) => text.replace(`{${name}}`, String(value)),
          template
        )
      }
    })
  }
})

import { JournalMetricsTable } from './JournalMetricsPanel'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (element: React.ReactElement): void => {
  act(() => root.render(element))
}

describe('journal metrics table', () => {
  it('says Unknown where no metric was imported, and never a zero', () => {
    render(
      <JournalMetricsTable
        counts={{ total: 1, matched: 1, missingMetric: 0, valueNotNumeric: 0, notMatching: 0 }}
        kinds={['impact-factor']}
        rows={[
          {
            journalId: 'j-1',
            name: 'journal with no metrics',
            issn: null,
            cells: { 'impact-factor': { state: 'unknown' } }
          }
        ]}
        unknownLabel="Unknown"
      />
    )

    const cells = [...container.querySelectorAll('td')].map((cell) => cell.textContent ?? '')
    expect(cells).toContain('Unknown')
    // The cell that has no metric says so in words: no zero appears anywhere in that cell.
    expect(cells).not.toContain('0')
  })

  it('prints every number with its year and its source', () => {
    render(
      <JournalMetricsTable
        counts={{ total: 1, matched: 1, missingMetric: 0, valueNotNumeric: 0, notMatching: 0 }}
        kinds={['impact-factor']}
        rows={[
          {
            journalId: 'j-1',
            name: 'nature',
            issn: '0028-0836',
            cells: {
              'impact-factor': {
                state: 'known',
                value: '64.8',
                numericValue: 64.8,
                year: 2023,
                source: 'Journal Citation Reports'
              }
            }
          }
        ]}
        unknownLabel="Unknown"
      />
    )

    const text = container.textContent ?? ''
    expect(text).toContain('64.8')
    expect(text).toContain('2023')
    expect(text).toContain('Journal Citation Reports')
    expect(text).toContain('0028-0836')
    // The column header uses the translated kind, not the store's raw word.
    expect(text).toContain('Impact factor')
  })

  it('reconciles the counts line against the total', () => {
    render(
      <JournalMetricsTable
        counts={{ total: 9, matched: 3, missingMetric: 4, valueNotNumeric: 1, notMatching: 1 }}
        kinds={[]}
        rows={[]}
        unknownLabel="Unknown"
      />
    )

    const text = container.textContent ?? ''
    expect(text).toContain('3 of 9 journals match')
    expect(text).toContain('4 have no such metric')
    expect(text).toContain('1 have a value that is not a number')
    expect(text).toContain('1 fall outside the bounds')
  })
})
