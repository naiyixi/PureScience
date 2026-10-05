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
    'references.journalMetrics.title': 'Journal metrics',
    'references.journalMetrics.hint':
      'Every number is shown with its year and the source it came from.',
    'references.journalMetrics.filter.partition': 'Partition',
    'references.journalMetrics.filter.partitionAny': 'Any partition',
    'references.journalMetrics.filter.minImpactFactor': 'Impact factor ≥',
    'references.journalMetrics.filter.maxImpactFactor': 'Impact factor ≤',
    'references.journalMetrics.filter.year': 'Year',
    'references.journalMetrics.filter.yearAny': 'Latest year',
    'references.journalMetrics.loading': 'Loading journal metrics…',
    'references.journalMetrics.empty': 'No journal matches this filter.',
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
      'That name already belongs to another journal',
    'references.journalMetrics.conflictBadge': 'also {count}',
    'references.journalMetrics.conflictBadgeTitle':
      'The same year holds more than one value from different sources; all are listed below.',
    'references.journalMetrics.conflictLine': 'also {value} ({year} · {source})'
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

import { JournalMergeControls, JournalMetricsPanel, JournalMetricsTable } from './JournalMetricsPanel'

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
                source: 'Journal Citation Reports',
                alternatives: []
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

  it('prints BOTH values when one year holds two claims from two sources', () => {
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
                source: 'Journal Citation Reports',
                alternatives: [{ value: '16.6', numericValue: 16.6, source: '期刊指标库' }]
              }
            }
          }
        ]}
        unknownLabel="Unknown"
      />
    )

    const text = container.textContent ?? ''
    // The hidden-until-now claim and its own source are on screen, not just the winner of the tie-break.
    expect(text).toContain('16.6')
    expect(text).toContain('期刊指标库')
    expect(text).toContain('64.8')
    expect(container.querySelector('[data-testid="journal-metric-conflict"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-testid="journal-metric-alternative"]')).toHaveLength(1)
  })

  it('shows no conflict marker when the year holds a single claim', () => {
    render(
      <JournalMetricsTable
        counts={{ total: 1, matched: 1, missingMetric: 0, valueNotNumeric: 0, notMatching: 0 }}
        kinds={['impact-factor']}
        rows={[
          {
            journalId: 'j-1',
            name: 'nature',
            issn: null,
            aliases: [],
            cells: {
              'impact-factor': {
                state: 'known',
                value: '64.8',
                numericValue: 64.8,
                year: 2023,
                source: 'Journal Citation Reports',
                alternatives: []
              }
            }
          }
        ]}
        unknownLabel="Unknown"
      />
    )

    expect(container.querySelector('[data-testid="journal-metric-conflict"]')).toBeNull()
    expect(container.querySelectorAll('[data-testid="journal-metric-alternative"]')).toHaveLength(0)
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

// The screening controls live in the panel, not in the presentational table, so the bounds are pinned here by
// driving the real container: state -> the filter the pure function is called with -> the rows on screen. A
// unit test of the pure function alone would pass even if the panel never wired the new bound to it.
describe('journal metrics panel range filters', () => {
  const library = {
    journals: [
      { id: 'j-nature', normalizedName: 'nature', displayName: 'Nature', issn: '0028-0836' },
      {
        id: 'j-comms',
        normalizedName: 'nature communications',
        displayName: 'Nature Communications',
        issn: '2041-1723'
      }
    ],
    claims: [
      {
        journalId: 'j-nature',
        kind: 'impact-factor',
        value: '64.8',
        numericValue: 64.8,
        year: 2023,
        source: 'Journal Citation Reports',
        fetchedAt: 1
      },
      {
        journalId: 'j-comms',
        kind: 'impact-factor',
        value: '16.6',
        numericValue: 16.6,
        year: 2023,
        source: 'Journal Citation Reports',
        fetchedAt: 1
      }
    ],
    aliases: []
  }

  const flush = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve()
    })
  }

  const renderPanel = async (): Promise<void> => {
    await act(async () => {
      root.render(<JournalMetricsPanel />)
    })
    await flush()
  }

  const setValue = (label: string, value: string): void => {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
    if (!input) throw new Error(`no input labelled ${label}`)
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  const rowTexts = (): string[] =>
    [...container.querySelectorAll('tbody tr')].map((row) => (row.textContent ?? '').trim())

  beforeEach(() => {
    window.api = {
      references: {
        listJournalMetrics: vi.fn().mockResolvedValue(library),
        // IC29 put the claim editor on this panel, and its effect reads the journal's claims on mount. A stub
        // that lacks the call does not fail loudly — it throws inside a passive effect — so it is stubbed here
        // rather than guarded away in the component.
        listJournalClaims: vi.fn().mockResolvedValue([]),
        appendJournalMetric: vi.fn().mockResolvedValue({ id: 'claim-1' })
      }
    } as unknown as typeof window.api
  })

  it('narrows the table by a ceiling, not only a floor', async () => {
    await renderPanel()

    // Both bounds are reachable, and the unfiltered library really holds two journals — without this the
    // assertion below could pass on a panel that simply never showed the second row.
    expect(container.querySelector('input[aria-label="Impact factor ≥"]')).not.toBeNull()
    expect(container.querySelector('input[aria-label="Impact factor ≤"]')).not.toBeNull()
    expect(rowTexts()).toHaveLength(2)

    await act(async () => {
      setValue('Impact factor ≤', '30')
    })

    const filtered = rowTexts()
    expect(filtered).toHaveLength(1)
    expect(filtered[0]).toContain('Nature Communications')
    expect(filtered.join(' ')).not.toContain('64.8')
    // The excluded journal is counted as outside the bounds rather than as absent, so "one row" cannot be
    // misread as "the library only ever held one journal".
    expect(container.textContent).toContain('1 of 2 journals match')
    expect(container.textContent).toContain('1 fall outside the bounds')
  })

  it('applies the floor and the ceiling together as one range', async () => {
    await renderPanel()

    await act(async () => {
      setValue('Impact factor ≥', '5')
    })
    await act(async () => {
      setValue('Impact factor ≤', '20')
    })

    const filtered = rowTexts()
    expect(filtered).toHaveLength(1)
    expect(filtered[0]).toContain('16.6')
    expect(filtered.join(' ')).not.toContain('64.8')
  })
})
