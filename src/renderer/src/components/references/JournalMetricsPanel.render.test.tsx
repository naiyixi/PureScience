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
    'references.journalMetrics.kind.casPartition': 'CAS partition',
    'references.journalMetrics.merge.title': 'Merge two journals',
    'references.journalMetrics.merge.hint':
      'Merging moves every metric and every linked reference into the journal you keep. It cannot be undone.',
    'references.journalMetrics.merge.source': 'Merge this journal',
    'references.journalMetrics.merge.target': 'Into this journal',
    'references.journalMetrics.merge.choose': 'Choose a journal…',
    'references.journalMetrics.merge.confirm': 'Merge',
    'references.journalMetrics.merge.merging': 'Merging…',
    'references.journalMetrics.merge.aliases': 'also known as {names}',
    'references.journalMetrics.merge.done':
      'Moved {metrics} metrics and {references} references; “{alias}” now resolves here.',
    'references.journalMetrics.merge.refusal.selfMerge': 'A journal cannot be merged into itself',
    'references.journalMetrics.merge.refusal.aliasConflict':
      'That name already belongs to another journal'
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

import { JournalMergeControls, JournalMetricsTable } from './JournalMetricsPanel'

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
            aliases: [],
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
            aliases: [],
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

  it('shows the spellings a merge left behind, so an old name on screen is explained', () => {
    render(
      <JournalMetricsTable
        counts={{ total: 1, matched: 1, missingMetric: 0, valueNotNumeric: 0, notMatching: 0 }}
        kinds={[]}
        rows={[
          {
            journalId: 'j-1',
            name: 'Nature',
            issn: '0028-0836',
            aliases: ['nature london'],
            cells: {}
          }
        ]}
        unknownLabel="Unknown"
      />
    )

    expect(container.textContent ?? '').toContain('also known as nature london')
  })
})

describe('journal merge controls', () => {
  const journals = [
    { id: 'j-nature', name: 'Nature' },
    { id: 'j-london', name: 'Nature (London)' }
  ]

  it('keeps the button inert until two different journals are chosen, then reports the merge', () => {
    const onMerge = vi.fn()
    render(
      <JournalMergeControls busy={false} journals={journals} onMerge={onMerge} result={null} />
    )

    const confirm = container.querySelector<HTMLButtonElement>(
      '[data-slot="journal-merge-confirm"]'
    )
    expect(confirm?.disabled).toBe(true)

    const selects = container.querySelectorAll<HTMLSelectElement>('select')
    const [source, target] = selects
    act(() => {
      source.value = 'j-london'
      source.dispatchEvent(new Event('change', { bubbles: true }))
      target.value = 'j-nature'
      target.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const enabled = container.querySelector<HTMLButtonElement>(
      '[data-slot="journal-merge-confirm"]'
    )
    expect(enabled?.disabled).toBe(false)
    act(() => enabled?.click())
    expect(onMerge).toHaveBeenCalledWith('j-london', 'j-nature')
  })

  it('refuses to merge a journal into itself, and never calls the store that way', () => {
    const onMerge = vi.fn()
    render(
      <JournalMergeControls busy={false} journals={journals} onMerge={onMerge} result={null} />
    )

    const selects = container.querySelectorAll<HTMLSelectElement>('select')
    const [source, target] = selects
    act(() => {
      source.value = 'j-nature'
      source.dispatchEvent(new Event('change', { bubbles: true }))
      target.value = 'j-nature'
      target.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(
      container.querySelector<HTMLButtonElement>('[data-slot="journal-merge-confirm"]')?.disabled
    ).toBe(true)
    expect(onMerge).not.toHaveBeenCalled()
  })

  it('prints what the merge moved, so the window reports the effect instead of claiming success', () => {
    render(
      <JournalMergeControls
        busy={false}
        journals={journals}
        onMerge={vi.fn()}
        result={{
          ok: true,
          sourceJournalId: 'j-london',
          targetJournalId: 'j-nature',
          alias: 'nature london',
          movedMetrics: 3,
          movedReferences: 2,
          movedAliases: 0
        }}
      />
    )

    const done = container.querySelector('[data-slot="journal-merge-result"]')?.textContent ?? ''
    expect(done).toContain('3')
    expect(done).toContain('2')
    expect(done).toContain('nature london')
  })

  it('stays inert once the journal it merged away is gone, and still prints the report', () => {
    render(
      <JournalMergeControls
        busy={false}
        journals={[{ id: 'j-nature', name: 'Nature' }]}
        onMerge={vi.fn()}
        result={{
          ok: true,
          sourceJournalId: 'j-london',
          targetJournalId: 'j-nature',
          alias: 'nature london',
          movedMetrics: 3,
          movedReferences: 2,
          movedAliases: 0
        }}
      />
    )

    // One journal left: the chosen source no longer exists, so the control cannot fire — and the report of
    // the merge is still on screen, which is the whole reason it stays mounted.
    expect(
      container.querySelector<HTMLButtonElement>('[data-slot="journal-merge-confirm"]')?.disabled
    ).toBe(true)
    const done = container.querySelector('[data-slot="journal-merge-result"]')?.textContent ?? ''
    expect(done).toContain('nature london')
  })

  it('prints a named refusal together with the store own sentence', () => {
    render(
      <JournalMergeControls
        busy={false}
        journals={journals}
        onMerge={vi.fn()}
        result={{
          ok: false,
          reason: 'alias-conflict',
          detail: 'the name "nature london" is already an alias of journal j-third'
        }}
      />
    )

    const refusal = container.querySelector('[data-slot="journal-merge-result"]')?.textContent ?? ''
    expect(refusal).toContain('That name already belongs to another journal')
    expect(refusal).toContain('already an alias of journal j-third')
  })
})
