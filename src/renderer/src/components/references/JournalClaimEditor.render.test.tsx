// @vitest-environment jsdom
// IC29 render tests: the correction form appends a claim and the history shows what came back — including the
// claim that was already there. The store's doctrine is append-only, so the assertion that matters is that
// submitting does NOT replace the list, and that a refusal from main is shown rather than swallowed.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', () => ({
  useLanguage: () => ({
    t: (key: string): string =>
      ({
        'references.journalMetrics.correct.title': 'Correct a metric',
        'references.journalMetrics.correct.hint': 'A correction is added as another claim.',
        'references.journalMetrics.correct.journal': 'Journal',
        'references.journalMetrics.correct.kind': 'Kind',
        'references.journalMetrics.correct.value': 'Value',
        'references.journalMetrics.correct.year': 'Year',
        'references.journalMetrics.correct.source': 'Source',
        'references.journalMetrics.correct.note': 'Note',
        'references.journalMetrics.correct.submit': 'Add claim',
        'references.journalMetrics.correct.history': 'Claims on this journal',
        'references.journalMetrics.correct.historyEmpty': 'No claims yet.'
      })[key] ?? key
  })
}))

const { JournalClaimEditor } = await import('./JournalClaimEditor')

let container: HTMLDivElement
let root: Root
let listJournalClaims: ReturnType<typeof vi.fn>
let appendJournalMetric: ReturnType<typeof vi.fn>

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

const render = async (): Promise<void> => {
  await act(async () => {
    root.render(
      <JournalClaimEditor
        journals={[{ id: 'journal-1', name: 'Journal of Claim Evidence' }]}
        kinds={['impact-factor']}
        onAppended={() => undefined}
      />
    )
  })
  await flush()
  await flush()
}

const byLabel = (label: string): HTMLInputElement | HTMLSelectElement | null =>
  document.body.querySelector(`[aria-label="${label}"]`)

const setValue = (element: HTMLInputElement | HTMLSelectElement | null, value: string): void => {
  if (!element) return
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  setter?.call(element, value)
  act(() => {
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  listJournalClaims = vi
    .fn()
    .mockResolvedValue([
      { kind: 'impact-factor', value: '3.5', year: 2024, source: 'Publisher table', fetchedAt: 1 }
    ])
  appendJournalMetric = vi.fn().mockResolvedValue({ id: 'claim-2' })
  window.api = {
    references: { listJournalClaims, appendJournalMetric }
  } as unknown as typeof window.api
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('JournalClaimEditor (IC29)', () => {
  it('shows the claims the store already holds', async () => {
    await render()

    const history = document.querySelector('[data-testid="journal-claim-history"]')
    expect(history).not.toBeNull()
    const text = history?.textContent ?? ''
    expect(text).toContain('impact-factor')
    expect(text).toContain('3.5')
    expect(text).toContain('2024')
    expect(text).toContain('Publisher table')
    expect(listJournalClaims).toHaveBeenCalledWith('journal-1')
  })

  it('sends a correction as a new claim and keeps the old one on screen', async () => {
    await render()

    setValue(byLabel('Value'), '4.1')
    setValue(byLabel('Year'), '2025')
    setValue(byLabel('Source'), 'Corrected by hand')

    // The old claim is still listed before the submit…
    expect(document.body.textContent).toContain('3.5')

    // …and after it, the store is asked for the claims again (rather than the list being replaced locally),
    // so what is on screen is what the store holds.
    listJournalClaims.mockResolvedValue([
      { kind: 'impact-factor', value: '3.5', year: 2024, source: 'Publisher table', fetchedAt: 1 },
      { kind: 'impact-factor', value: '4.1', year: 2025, source: 'Corrected by hand', fetchedAt: 2 }
    ])
    const submit = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Add claim'
    )
    await act(async () => {
      submit?.click()
    })
    await flush()

    expect(appendJournalMetric).toHaveBeenCalledWith({
      journalId: 'journal-1',
      kind: 'impact-factor',
      value: '4.1',
      year: 2025,
      source: 'Corrected by hand',
      note: ''
    })
    expect(listJournalClaims).toHaveBeenCalledTimes(2)
    const text = document.body.textContent ?? ''
    expect(text).toContain('3.5')
    expect(text).toContain('4.1')
  })

  it('shows a refusal from main instead of swallowing it', async () => {
    // Main refuses an undated or unsourced claim; the form is filled so the submit is genuinely available,
    // and the refusal must be shown rather than swallowed.
    appendJournalMetric.mockRejectedValue(new Error('appendMetric requires a source'))
    await render()

    setValue(byLabel('Value'), '4.1')
    setValue(byLabel('Year'), '2025')
    setValue(byLabel('Source'), 'Corrected by hand')

    const submit = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Add claim'
    )
    await act(async () => {
      submit?.click()
    })
    await flush()

    expect(appendJournalMetric).toHaveBeenCalled()
    expect(document.body.textContent).toContain('appendMetric requires a source')
    // Nothing was re-read as if it had landed.
    expect(listJournalClaims).toHaveBeenCalledTimes(1)
  })
})
