// @vitest-environment jsdom
// Render tests for the journal-metric import form. They pin the part of the form that the store could already
// do and the window could not ask for:
//
//   * a table with no kind column can name its metric once (the request-level `defaultKind`), instead of the
//     reader having to edit the file and add a column;
//   * the box the reader types into is the value that travels — not a second vocabulary invented here;
//   * an empty box sends NO kind, so a request that means "no kind anywhere" cannot look like one that tried
//     and sent nothing.
//
// Driving the real component matters here: a shared-parser test can only show that `defaultKind` works when a
// caller passes it, and would stay green on a form that never passes it.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import type {
  JournalMetricImportRequest,
  JournalMetricImportResult
} from '../../../../shared/journal-metrics'

vi.mock('@/i18n', () => {
  const labels: Record<string, string> = {
    'references.journalMetrics.import.title': 'Import metrics',
    'references.journalMetrics.import.hint':
      'Paste a publisher table (CSV/TSV). Every row needs a value, a year and a source; nothing is guessed.',
    'references.journalMetrics.import.placeholder': 'journal,issn,kind,value,year,source',
    'references.journalMetrics.import.submit': 'Import',
    'references.journalMetrics.import.busy': 'Importing…',
    'references.journalMetrics.import.summary':
      '{imported} imported · {skipped} skipped · {journals} journals created',
    'references.journalMetrics.import.importedLine': 'line {line}: {kind} {value} ({year})',
    'references.journalMetrics.import.skippedLine': 'line {line}: {reason}',
    'references.journalMetrics.import.defaultKind': 'Metric kind for tables without one',
    'references.journalMetrics.import.defaultKindHint':
      'Used when the table has no kind column; a kind in the table still wins.',
    'references.journalMetrics.kind.impactFactor': 'Impact factor',
    'references.journalMetrics.kind.jcrQuartile': 'JCR quartile',
    'references.journalMetrics.kind.casPartition': 'CAS partition',
    'references.journalMetrics.kind.casTop': 'CAS top',
    'references.journalMetrics.kind.acceptanceRate': 'Acceptance rate'
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

import { JournalMetricsImport } from './JournalMetricsImport'
import { JOURNAL_METRIC_KINDS } from './journal-metric-kind-labels'

// A publisher table of exactly the shape that motivated this field: same metric on every row, no kind column.
const TABLE_WITHOUT_KIND = ['Journal,Value,Year,Source', 'Nature,48.5,2024,JCR 2024'].join('\n')

let container: HTMLDivElement
let root: Root
let importJournalMetrics: Mock<
  (input: JournalMetricImportRequest) => Promise<JournalMetricImportResult>
>
let onImported: Mock<() => void>

const IMPORT_RESULT: JournalMetricImportResult = {
  imported: 1,
  skipped: 0,
  journalsCreated: 1,
  outcomes: []
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

const renderForm = async (): Promise<void> => {
  await act(async () => {
    root.render(<JournalMetricsImport onImported={onImported} />)
  })
  await flush()
}

const field = (slot: string): HTMLInputElement | HTMLTextAreaElement => {
  const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[data-slot="${slot}"]`
  )
  if (!element) throw new Error(`no field with data-slot ${slot}`)
  return element
}

// React tracks the last value it wrote, so a dispatched event alone is ignored; set through the prototype
// setter first (same technique as the screening-table render test).
const type = async (slot: string, value: string): Promise<void> => {
  await act(async () => {
    const element = field(slot)
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const submit = async (): Promise<void> => {
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[data-slot="journal-metrics-import-submit"]')
      ?.click()
  })
  await flush()
}

beforeEach(() => {
  importJournalMetrics =
    vi.fn<(input: JournalMetricImportRequest) => Promise<JournalMetricImportResult>>()
  importJournalMetrics.mockResolvedValue(IMPORT_RESULT)
  onImported = vi.fn<() => void>()
  window.api = {
    references: { importJournalMetrics }
  } as unknown as typeof window.api
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { api?: unknown }).api
})

describe('journal metric import form', () => {
  it('offers the five kinds the library knows by name, as the tokens the store keeps', async () => {
    await renderForm()

    const input = field('journal-metrics-import-default-kind')
    expect(input.getAttribute('aria-label')).toBe('Metric kind for tables without one')

    // The suggestions must be reachable from the field itself, and they must be the store's tokens — a
    // suggestion of the translated label would store a kind no column is keyed by.
    const listId = input.getAttribute('list')
    expect(listId).toBeTruthy()
    const options = [...container.querySelectorAll<HTMLOptionElement>(`#${listId} option`)]
    expect(options.map((option) => option.value)).toEqual([...JOURNAL_METRIC_KINDS])
    expect(options.map((option) => option.textContent)).toEqual([
      'Impact factor',
      'JCR quartile',
      'CAS partition',
      'CAS top',
      'Acceptance rate'
    ])
  })

  it('sends the kind named once for a table that has no kind column', async () => {
    await renderForm()

    await type('journal-metrics-import-text', TABLE_WITHOUT_KIND)
    await type('journal-metrics-import-default-kind', 'cas-partition')
    await submit()

    expect(importJournalMetrics).toHaveBeenCalledTimes(1)
    expect(importJournalMetrics.mock.calls[0][0]).toEqual({
      format: 'csv',
      text: TABLE_WITHOUT_KIND,
      defaultKind: 'cas-partition'
    })
    // The library is re-read so the table above shows what was stored, not a local guess.
    expect(onImported).toHaveBeenCalledTimes(1)
  })

  it('sends no kind at all when the box was left empty, and none for whitespace either', async () => {
    await renderForm()

    await type('journal-metrics-import-text', TABLE_WITHOUT_KIND)
    await submit()

    // toStrictEqual, not toEqual: the absent key is the assertion — an explicit `defaultKind: undefined`
    // would pass a loose comparison while still telling the store the caller had a kind in mind.
    expect(importJournalMetrics.mock.calls[0][0]).toStrictEqual({
      format: 'csv',
      text: TABLE_WITHOUT_KIND
    })

    await type('journal-metrics-import-default-kind', '   ')
    await submit()

    expect(importJournalMetrics).toHaveBeenCalledTimes(2)
    expect(importJournalMetrics.mock.calls[1][0]).toStrictEqual({
      format: 'csv',
      text: TABLE_WITHOUT_KIND
    })
  })
})
