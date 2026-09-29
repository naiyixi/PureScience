// @vitest-environment jsdom
// Render + interaction tests for the literature-screening surface. They pin what the S3 acceptance
// actually asks a person to be able to see and do:
//
//   * all four states and their NAMED reasons are on screen (never a bare "undecided");
//   * an override never hides the AI verdict — the original stays visible beside it, and clearing the
//     override puts the reviewer back on the model's decision;
//   * an override cannot be applied without a reason (refused before it reaches the backend);
//   * batch and single overrides go through the real channels, with the arguments the backend expects.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', () => {
  const labels: Record<string, string> = {
    'references.screening.title': 'Screening',
    'references.screening.scopeHint': 'Screening runs against one collection.',
    'references.screening.inclusion': 'Inclusion criteria',
    'references.screening.exclusion': 'Exclusion criteria',
    'references.screening.criterionId': 'Criterion ID',
    'references.screening.criterionText': 'Criterion',
    'references.screening.addCriterion': 'Add criterion',
    'references.screening.removeCriterion': 'Remove criterion {id}',
    'references.screening.saveCriteria': 'Save as new revision',
    'references.screening.showHistory': 'Revision history',
    'references.screening.hideHistory': 'Hide revision history',
    'references.screening.start': 'Screen collection',
    'references.screening.resume': 'Resume unfinished items',
    'references.screening.cancel': 'Stop',
    'references.screening.cancelIdle': 'Nothing is running.',
    'references.screening.selectAll': 'Select all',
    'references.screening.overrideReason': 'Reason',
    'references.screening.overrideReasonPlaceholder': 'Why the AI verdict is wrong',
    'references.screening.overrideReasonRequired': 'An override needs a reason.',
    'references.screening.overrideInclude': 'Include',
    'references.screening.overrideExclude': 'Exclude',
    'references.screening.clearOverride': 'Back to the AI verdict',
    'references.screening.overrideCleared': 'Override cleared — the AI verdict stands again.',
    'references.screening.humanOverride': 'Human override',
    'references.screening.aiVerdict': 'AI verdict',
    'references.screening.batchInclude': 'Include selected ({n})',
    'references.screening.batchExclude': 'Exclude selected ({n})',
    'references.screening.batchApplied': 'Overrode {n} references.',
    'references.screening.selectRow': 'Select {title}',
    'references.screening.noSelection': 'No reference selected.',
    'references.screening.cancelled': 'Stopped: {processed} processed, {remaining} left pending.',
    'references.screening.verdict.included': 'Included',
    'references.screening.verdict.needs-review': 'Needs review',
    'references.screening.verdict.excluded': 'Excluded',
    'references.screening.verdict.not-evaluated': 'Not evaluated',
    'references.screening.reason.rule-changed': 'The rule set changed',
    'references.screening.reason.input-changed': 'The evidence changed',
    'references.screening.reason.model-changed': 'The model or policy changed',
    'references.screening.reason.missing-evidence': 'No full text on hand',
    'references.screening.reason.input-too-long': 'Evidence beyond the model input budget',
    'references.screening.reason.uncertain': 'The decision itself is uncertain',
    'references.screening.coverage.full-text': 'Full text',
    'references.screening.coverage.abstract-only': 'Abstract only',
    'references.screening.coverage.metadata-only': 'Metadata only',
    'references.screening.coverage.unavailable': 'No evidence',
    'references.screening.filter.all': 'All',
    'references.screening.freshnessStale': 'Not current',
    'references.screening.freshnessCurrent': 'Current',
    'references.screening.noEvidence': 'No passage was recorded for this decision.',
    'references.screening.progress': '{done} / {total} processed',
    'references.screening.runStatus.running': 'Running',
    'references.screening.ruleRevision': 'Revision {revision}',
    'references.screening.ruleHash': 'content {hash}',
    'references.screening.evidenceQuoted': '{criterion}: “{quote}”',
    'references.screening.decidedWith': 'Decided by {model} · {date}',
    'references.screening.summary':
      'Candidates {candidate} of {searched} searched · assessed {assessed} · unprocessed {unprocessed} · needs review {review}',
    'references.screening.aiVsHuman': 'AI decisions {ai} · human overrides {overrides}',
    'references.screening.coverageCounts':
      'Full text {fullText} · abstract {abstractOnly} · metadata {metadataOnly} · none {unavailable}',
    'references.screening.runCounts':
      '{assessed} assessed · {deferred} deferred · {failed} failed · {pending} unprocessed',
    'references.screening.runStatus.completed': 'Completed',
    'references.screening.revisionCurrent': 'current',
    'references.screening.revisionSuperseded': 'superseded',
    'references.screening.ruleChanged': 'rule changed',
    'references.screening.batchApplied2': 'applied',
    // The S4 statistics + export surface.
    'references.screening.stats.ai': 'AI decisions',
    'references.screening.stats.overrides': 'Human overrides',
    'references.screening.stats.unprocessed': 'Unprocessed',
    'references.screening.stats.unprocessedNote':
      'Unprocessed records are counted separately and never enter an export.',
    'references.screening.stats.verdicts': 'Verdicts',
    'references.screening.stats.coverage': 'Evidence coverage',
    'references.screening.export.title': 'Export',
    'references.screening.export.scope':
      'Export scope: included only — by the effective verdict, where a human override outranks the AI verdict.',
    'references.screening.export.scopeIncludedOnly': 'included only',
    'references.screening.export.preview':
      'Will export {included} · not exported {notExported} (needs review {review} · excluded {excluded} · not evaluated {notEvaluated})',
    'references.screening.export.action': 'Export included',
    'references.screening.export.nothingIncluded':
      'Nothing is included yet, so there is nothing to export.',
    'references.screening.export.receiptExported':
      'Exported {exported} included citations in {style} · scope {scope}.',
    'references.screening.export.receiptNotExported':
      'Not exported {notExported}: needs review {review} · excluded {excluded} · not evaluated {notEvaluated} · by a human override {byOverride}',
    'references.screening.export.receiptReasons': 'Named reasons: {reasons}',
    'references.screening.export.receiptNoReasons': 'No named reasons.',
    'references.screening.export.receiptProvenance':
      'collection {collection} · rule revision {revision} ({hash}) · {time}',
    'references.screening.export.receiptSavedTo': 'Saved to {path}.',
    'references.screening.export.listChanged':
      '{n} included records are not in this list any more; reopen the collection and export again.',
    'references.screening.export.failed': 'The export was not saved: {message}',
    'references.screening.export.cancelled': 'The save was cancelled, so nothing was written.',
    'references.citationStyle': 'Citation style',
    'references.builtinStyles': 'Built-in styles',
    'references.importedStyles': 'Imported styles'
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

const { ReferencesScreeningPanel } = await import('./ReferencesScreeningPanel')
import type { Reference } from '../../../../shared/references'
import type {
  ScreeningCollectionSnapshot,
  ScreeningItemView,
  ScreeningNamedReason,
  ScreeningOverride,
  ScreeningVerdict
} from '../../../../shared/references-screening'

const reference = (id: string, title: string): Reference => ({
  id,
  projectId: 'project-1',
  title,
  authors: [{ name: 'A. Author' }],
  venue: 'Journal',
  year: 2026,
  doi: undefined,
  pmid: undefined,
  pmcid: undefined,
  arxivId: undefined,
  url: undefined,
  abstractSnippet: undefined,
  sourceConnector: 'manual',
  sourceRecordId: undefined,
  citationKey: `key-${id}`,
  provenance: undefined,
  pdfManagedFileId: undefined,
  notes: undefined,
  createdAt: 1,
  updatedAt: 1
})

const item = (
  referenceId: string,
  verdict: ScreeningVerdict,
  reasons: ScreeningNamedReason[] = [],
  override: ScreeningOverride | null = null
): ScreeningItemView => ({
  referenceId,
  decision: {
    referenceId,
    verdict,
    override,
    effective: override ? (override.decision === 'include' ? 'included' : 'excluded') : verdict,
    effectiveSource: override ? 'override' : 'ai'
  },
  freshness: {
    current: reasons.length === 0 && verdict !== 'needs-review',
    stale: reasons.some((reason) => reason !== 'uncertain'),
    review: verdict === 'needs-review',
    reasons
  },
  coverage: 'full-text',
  inputChars: 120,
  inputCharBudget: 60_000,
  ruleRevision: 1,
  policyKey: 'screening:guardrails-v1',
  model: 'stub-model-v1',
  decidedAt: 1_700_000_000_000,
  probabilities: { include: 0.9 },
  evidence:
    verdict === 'included'
      ? [{ criterionId: 'i-1', coverage: 'full-text', quote: 'We enrolled 120 adults.' }]
      : []
})

const snapshot = (items: ScreeningItemView[], running = false): ScreeningCollectionSnapshot => ({
  collectionId: 'collection-1',
  rule: {
    collectionId: 'collection-1',
    revision: 1,
    inclusion: [{ id: 'i-1', text: 'adults' }],
    exclusion: [{ id: 'e-1', text: 'reviews' }],
    contentHash: 'a'.repeat(64),
    createdAt: 1
  },
  items,
  summary: {
    searchedCount: items.length,
    candidateCount: items.length,
    assessedCount: items.filter((entry) => entry.decision.verdict !== 'not-evaluated').length,
    unprocessedCount: items.filter((entry) => entry.decision.verdict === 'not-evaluated').length,
    reviewCount: items.filter((entry) => entry.freshness.review).length,
    verdictCounts: { included: 1, 'needs-review': 1, excluded: 1, 'not-evaluated': 1 },
    coverageCounts: {
      'full-text': items.length,
      'abstract-only': 0,
      'metadata-only': 0,
      unavailable: 0
    }
  },
  reasonCounts: {
    'rule-changed': 0,
    'input-changed': 0,
    'model-changed': 0,
    'missing-evidence': 0,
    'input-too-long': 0,
    uncertain: 1
  },
  aiDecidedCount: 3,
  overrideCount: items.filter((entry) => entry.decision.override).length,
  lastRun: {
    run: {
      id: 'run-1',
      collectionId: 'collection-1',
      ruleRevision: 1,
      startedAt: 1,
      ...(running ? {} : { finishedAt: 2 }),
      status: running ? 'running' : 'completed'
    },
    ruleRevision: 1,
    referenceCount: items.length,
    assessed: items.filter((entry) => entry.decision.verdict !== 'not-evaluated').length,
    deferred: 0,
    failed: 0,
    pending: items.filter((entry) => entry.decision.verdict === 'not-evaluated').length,
    running
  },
  runnerAvailable: true,
  lastError: null
})

describe('ReferencesScreeningPanel', () => {
  let container: HTMLDivElement
  let root: Root
  const api = {
    getScreening: vi.fn(),
    listScreeningRuleRevisions: vi.fn(),
    appendScreeningRuleRevision: vi.fn(),
    startScreeningRun: vi.fn(),
    cancelScreeningRun: vi.fn(),
    setScreeningOverride: vi.fn(),
    setScreeningOverrides: vi.fn(),
    clearScreeningOverride: vi.fn(),
    listCitationStyles: vi.fn()
  }
  // The app's file-save channel, which is how a real export reaches disk (and how the acceptance spec
  // reads a real file back).
  const saveBlobFile = vi.fn()

  // Exact text, because a row's "Include" button sits under a filter chip reading "Included".
  const findExactButton = (label: string): HTMLButtonElement => {
    const match = Array.from(document.querySelectorAll('button')).find(
      (button) => (button.textContent ?? '').trim() === label
    )
    if (!match) throw new Error(`no button whose text is exactly ${label}`)
    return match
  }

  const byTestId = (id: string): HTMLElement => {
    const found = container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
    if (!found) throw new Error(`no element for ${id}`)
    return found
  }

  // React tracks an input's value, so assigning `.value` directly leaves its tracker unchanged and the
  // change handler never fires. Going through the prototype setter is what a real keystroke does.
  const typeInto = async (input: HTMLInputElement, value: string): Promise<void> => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  const flush = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve()
    })
  }

  /**
   * Renders the panel against `state`. `following` is what every LATER read answers with — the panel
   * re-reads after every write, so a test that models a write must also model the read that follows it
   * (in production the write is committed before that read, so the read can never be staler).
   */
  const render = async (
    state: ScreeningCollectionSnapshot,
    references: readonly Reference[],
    following: ScreeningCollectionSnapshot = state
  ): Promise<void> => {
    api.getScreening.mockResolvedValueOnce(state).mockResolvedValue(following)
    await act(async () => {
      root.render(
        <ReferencesScreeningPanel
          collectionId="collection-1"
          collectionName="Screen hits"
          references={references}
          onNotice={() => {}}
          onError={() => {}}
        />
      )
    })
    await flush()
    await flush()
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    api.getScreening.mockReset()
    api.listScreeningRuleRevisions.mockReset()
    api.appendScreeningRuleRevision.mockReset()
    api.startScreeningRun.mockReset()
    api.cancelScreeningRun.mockReset()
    api.setScreeningOverride.mockReset()
    api.setScreeningOverrides.mockReset()
    api.clearScreeningOverride.mockReset()
    api.listScreeningRuleRevisions.mockResolvedValue([])
    api.listCitationStyles.mockReset()
    api.listCitationStyles.mockResolvedValue([])
    saveBlobFile.mockReset()
    saveBlobFile.mockResolvedValue({ saved: true, filePath: '/tmp/references-screen-hits.txt' })
    window.api = { references: api, saveBlobFile } as unknown as typeof window.api
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.removeAttribute('style')
  })

  it('shows all four states with their named reasons', async () => {
    const references = [
      reference('ref-included', 'Included record'),
      reference('ref-review', 'Uncertain record'),
      reference('ref-excluded', 'Excluded record'),
      reference('ref-pending', 'Untouched record')
    ]
    await render(
      snapshot([
        item('ref-included', 'included'),
        item('ref-review', 'needs-review', ['uncertain']),
        item('ref-excluded', 'excluded'),
        item('ref-pending', 'not-evaluated', ['input-too-long'])
      ]),
      references
    )

    const text = document.body.textContent ?? ''
    for (const verdict of ['Included', 'Needs review', 'Excluded', 'Not evaluated']) {
      expect(text).toContain(verdict)
    }
    // The named reasons are on screen as sentences, not as machine tokens.
    expect(text).toContain('The decision itself is uncertain')
    expect(text).toContain('Evidence beyond the model input budget')
    expect(text).not.toContain('input-too-long')
    expect(text).not.toContain('needs-review')
    // 每条决策带溯源: the passage the included verdict rests on is visible.
    expect(text).toContain('We enrolled 120 adults.')
    expect(document.querySelectorAll('[data-testid="screening-row"]')).toHaveLength(4)
  })

  it('keeps the AI verdict visible beside a human override and goes back to it on request', async () => {
    const override: ScreeningOverride = {
      collectionId: 'collection-1',
      referenceId: 'ref-included',
      decision: 'exclude',
      reason: 'the cohort is paediatric',
      actor: 'user',
      createdAt: 1_700_000_100_000
    }
    api.clearScreeningOverride.mockResolvedValue({
      referenceId: 'ref-included',
      item: item('ref-included', 'included', [], null)
    })
    await render(
      snapshot([item('ref-included', 'included', [], override)]),
      [reference('ref-included', 'Included record')],
      snapshot([item('ref-included', 'included', [], null)])
    )

    const text = document.body.textContent ?? ''
    // Both layers: the model's own verdict AND the person's decision, with the reason they gave.
    expect(text).toContain('AI verdict')
    expect(text).toContain('Included')
    expect(text).toContain('Human override')
    expect(text).toContain('the cohort is paediatric')
    expect(document.querySelectorAll('[data-testid="screening-override"]')).toHaveLength(1)

    await act(async () => {
      findExactButton('Back to the AI verdict').click()
      await Promise.resolve()
    })
    await flush()

    expect(api.clearScreeningOverride).toHaveBeenCalledWith('collection-1', 'ref-included')
    // The AI verdict is still there after the override is gone; nothing about the model's decision moved.
    expect(document.body.textContent).toContain('Included')
    expect(document.querySelectorAll('[data-testid="screening-override"]')).toHaveLength(0)
  })

  it('refuses an override with no reason instead of sending it', async () => {
    const onError = vi.fn()
    api.getScreening.mockResolvedValue(snapshot([item('ref-included', 'included')]))
    await act(async () => {
      root.render(
        <ReferencesScreeningPanel
          collectionId="collection-1"
          collectionName="Screen hits"
          references={[reference('ref-included', 'Included record')]}
          onNotice={() => {}}
          onError={onError}
        />
      )
    })
    await flush()

    await act(async () => {
      findExactButton('Exclude').click()
      await Promise.resolve()
    })
    await flush()

    expect(api.setScreeningOverride).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('An override needs a reason.')
  })

  it('sends a single override with the reason the reviewer typed, and reads the line back', async () => {
    const references = [reference('ref-included', 'Included record')]
    api.setScreeningOverride.mockResolvedValue(
      item('ref-included', 'included', [], {
        collectionId: 'collection-1',
        referenceId: 'ref-included',
        decision: 'exclude',
        reason: 'wrong population',
        actor: 'user',
        createdAt: 1
      })
    )
    await render(
      snapshot([item('ref-included', 'included')]),
      references,
      snapshot([
        item('ref-included', 'included', [], {
          collectionId: 'collection-1',
          referenceId: 'ref-included',
          decision: 'exclude',
          reason: 'wrong population',
          actor: 'user',
          createdAt: 1
        })
      ])
    )

    const reason = Array.from(document.querySelectorAll('input')).find(
      (input) => input.getAttribute('aria-label') === 'Why the AI verdict is wrong'
    )
    if (!reason) throw new Error('the per-row reason input is missing')
    await typeInto(reason, 'wrong population')
    await act(async () => {
      findExactButton('Exclude').click()
      await Promise.resolve()
    })
    await flush()

    expect(api.setScreeningOverride).toHaveBeenCalledWith({
      collectionId: 'collection-1',
      referenceId: 'ref-included',
      decision: 'exclude',
      reason: 'wrong population',
      actor: 'user'
    })
    expect(document.querySelectorAll('[data-testid="screening-override"]')).toHaveLength(1)
  })

  it('applies a batch override to every selected record with one reason', async () => {
    const references = [
      reference('ref-included', 'Included record'),
      reference('ref-review', 'Uncertain record')
    ]
    api.setScreeningOverrides.mockResolvedValue({
      applied: 2,
      items: [item('ref-included', 'included'), item('ref-review', 'needs-review', ['uncertain'])]
    })
    await render(
      snapshot([
        item('ref-included', 'included'),
        item('ref-review', 'needs-review', ['uncertain'])
      ]),
      references
    )

    const batchReason = Array.from(document.querySelectorAll('input')).find(
      (input) =>
        input.getAttribute('aria-label') === 'Reason' &&
        input.getAttribute('placeholder') === 'Why the AI verdict is wrong'
    )
    if (!batchReason) throw new Error('the batch reason input is missing')
    await typeInto(batchReason, 'both match the protocol')
    for (const box of Array.from(document.querySelectorAll('input[type="checkbox"]'))) {
      await act(async () => {
        ;(box as HTMLInputElement).click()
      })
    }
    await flush()

    await act(async () => {
      findExactButton('Include selected (2)').click()
      await Promise.resolve()
    })
    await flush()

    expect(api.setScreeningOverrides).toHaveBeenCalledWith({
      collectionId: 'collection-1',
      referenceIds: ['ref-included', 'ref-review'],
      decision: 'include',
      reason: 'both match the protocol',
      actor: 'user'
    })
  })

  it('starts a pass, shows its progress, and offers the stop that is really wired', async () => {
    const references = [
      reference('ref-included', 'Included record'),
      reference('ref-review', 'Uncertain record')
    ]
    api.startScreeningRun.mockResolvedValue({
      runId: 'run-2',
      ruleRevision: 1,
      referenceCount: 2,
      started: true
    })
    api.cancelScreeningRun.mockResolvedValue({
      runId: 'run-2',
      cancelled: true,
      processed: 1,
      remaining: 1
    })
    const onNotice = vi.fn()
    api.getScreening.mockResolvedValue(
      snapshot([
        item('ref-included', 'included'),
        item('ref-review', 'not-evaluated', ['missing-evidence'])
      ])
    )
    await act(async () => {
      root.render(
        <ReferencesScreeningPanel
          collectionId="collection-1"
          collectionName="Screen hits"
          references={references}
          onNotice={onNotice}
          onError={() => {}}
        />
      )
    })
    await flush()

    await act(async () => {
      findExactButton('Screen collection').click()
      await Promise.resolve()
    })
    await flush()
    expect(api.startScreeningRun).toHaveBeenCalledWith({ collectionId: 'collection-1' })

    // A running snapshot offers the stop, and pressing it reaches the backend.
    await render(snapshot([item('ref-included', 'included')], true), references)
    await act(async () => {
      findExactButton('Stop').click()
      await Promise.resolve()
    })
    await flush()
    expect(api.cancelScreeningRun).toHaveBeenCalledWith('collection-1')
  })

  // --- S4: the statistics panel and the screening-range export ------------------------------------

  it('states AI decisions, human overrides and unprocessed as three separate numbers, beside both distributions', async () => {
    const references = [
      reference('ref-included', 'Included record'),
      reference('ref-review', 'Uncertain record'),
      reference('ref-excluded', 'Excluded record'),
      reference('ref-pending', 'Untouched record')
    ]
    const items = [
      item('ref-included', 'included'),
      item('ref-review', 'needs-review', ['uncertain']),
      item('ref-excluded', 'excluded'),
      item('ref-pending', 'not-evaluated', ['input-too-long'])
    ]
    await render(snapshot(items), references)

    // The three numbers are each their own element: AI decisions / human overrides / unprocessed.
    expect(byTestId('screening-stat-ai').textContent?.trim()).toBe('AI decisions 3')
    expect(byTestId('screening-stat-overrides').textContent?.trim()).toBe('Human overrides 0')
    expect(byTestId('screening-stat-unprocessed').textContent?.trim()).toBe('Unprocessed 1')
    // 未处理量 is labelled as such, and the surface says it never reaches an export.
    expect(byTestId('screening-stats').textContent).toContain(
      'Unprocessed records are counted separately and never enter an export.'
    )
    // The four-state distribution and the evidence-coverage distribution, each per state.
    for (const [verdict, label] of [
      ['included', 'Included'],
      ['needs-review', 'Needs review'],
      ['excluded', 'Excluded'],
      ['not-evaluated', 'Not evaluated']
    ] as const) {
      expect(byTestId(`screening-stat-verdict-${verdict}`).textContent?.trim()).toBe(`${label} 1`)
    }
    expect(byTestId('screening-stat-coverage-full-text').textContent?.trim()).toBe('Full text 4')
    expect(byTestId('screening-stat-coverage-abstract-only').textContent?.trim()).toBe(
      'Abstract only 0'
    )
    expect(byTestId('screening-stat-coverage-metadata-only').textContent?.trim()).toBe(
      'Metadata only 0'
    )
    expect(byTestId('screening-stat-coverage-unavailable').textContent?.trim()).toBe(
      'No evidence 0'
    )

    // 与库内逐项一致: recomputed from the rows themselves, the same numbers come out — the aggregate
    // the panel prints is what the lines say, not a second opinion.
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="screening-row"]')
    )
    const verdicts = rows.map((row) => row.dataset.verdict)
    const aiDecided = verdicts.filter((verdict) => verdict !== 'not-evaluated').length
    const unprocessed = verdicts.filter((verdict) => verdict === 'not-evaluated').length
    const overrides = rows.filter((row) => (row.dataset.override ?? '') !== '').length
    expect(aiDecided).toBe(3)
    expect(unprocessed).toBe(1)
    expect(overrides).toBe(0)
    expect(rows.filter((row) => row.dataset.coverage === 'full-text')).toHaveLength(4)
  })

  it('exports only the effective "included" records, states the range, and says what stayed out', async () => {
    const references = [
      reference('ref-included-by-human', 'Later cohort'),
      reference('ref-excluded-by-human', 'Withdrawn record'),
      reference('ref-untouched', 'Unturned stone')
    ]
    const items = [
      // The model was unsure; a person included it. It IS exported (人工覆盖优先于 AI 原判).
      item('ref-included-by-human', 'needs-review', ['uncertain'], {
        collectionId: 'collection-1',
        referenceId: 'ref-included-by-human',
        decision: 'include',
        reason: 'the protocol admits this cohort',
        actor: 'user',
        createdAt: 1
      }),
      // The model included it; a person excluded it. It is NOT exported, whatever the model said.
      item('ref-excluded-by-human', 'included', ['rule-changed'], {
        collectionId: 'collection-1',
        referenceId: 'ref-excluded-by-human',
        decision: 'exclude',
        reason: 'retracted after screening',
        actor: 'user',
        createdAt: 1
      }),
      item('ref-untouched', 'needs-review', ['uncertain'])
    ]
    const onNotice = vi.fn()
    api.getScreening.mockResolvedValue(snapshot(items))
    await act(async () => {
      root.render(
        <ReferencesScreeningPanel
          collectionId="collection-1"
          collectionName="Screen hits"
          references={references}
          onNotice={onNotice}
          onError={() => {}}
        />
      )
    })
    await flush()

    // The range is stated before the button, not after it.
    expect(byTestId('screening-export').dataset.scope).toBe('included-only')
    expect(byTestId('screening-export-scope').textContent).toContain('included only')
    expect(byTestId('screening-export-preview').textContent?.trim()).toBe(
      'Will export 1 · not exported 2 (needs review 1 · excluded 1 · not evaluated 0)'
    )

    await act(async () => {
      findExactButton('Export included').click()
      await Promise.resolve()
    })
    await flush()

    expect(saveBlobFile).toHaveBeenCalledTimes(1)
    const request = saveBlobFile.mock.calls[0]?.[0] as {
      suggestedName: string
      mimeType: string
      data: ArrayBuffer
    }
    // The file names the scope, the collection, the rule revision and the style it was built from.
    expect(request.suggestedName).toMatch(
      /^references-screen-hits-included-only-r1-gbt7714-2015-\d{4}-\d{2}-\d{2}\.txt$/
    )
    expect(request.mimeType).toBe('text/plain')
    const exported = new TextDecoder().decode(request.data)
    expect(exported).toContain('Later cohort')
    expect(exported).not.toContain('Withdrawn record')
    expect(exported).not.toContain('Unturned stone')
    // One citation per exported record, and nothing else.
    expect(exported.trim().split('\n')).toHaveLength(1)

    // The receipt: the range, what stayed out per state, the NAMED reasons, and the provenance.
    expect(byTestId('screening-export-receipt-summary').textContent?.trim()).toBe(
      'Exported 1 included citations in GB/T 7714-2015 (numeric) · scope included only.'
    )
    expect(byTestId('screening-export-receipt-not-exported').textContent?.trim()).toBe(
      'Not exported 2: needs review 1 · excluded 1 · not evaluated 0 · by a human override 1'
    )
    expect(byTestId('screening-export-receipt-reasons').textContent?.trim()).toBe(
      'Named reasons: The rule set changed: 1 · The decision itself is uncertain: 1'
    )
    expect(byTestId('screening-export-receipt-provenance').textContent).toContain(
      'collection Screen hits · rule revision 1'
    )
    expect(byTestId('screening-export-receipt-path').textContent?.trim()).toBe(
      'Saved to /tmp/references-screen-hits.txt.'
    )
    // The toast carries the same receipt, so a reviewer who only watched the notice still saw it.
    expect(onNotice).toHaveBeenCalledWith(
      expect.stringContaining('Not exported 2: needs review 1 · excluded 1 · not evaluated 0')
    )
  })

  it('says there are no named reasons rather than leaving the receipt line blank', async () => {
    const references = [
      reference('ref-included', 'Included record'),
      reference('ref-untouched', 'Unturned stone')
    ]
    // Nothing decided and no reason recorded: the excluded line still states the unprocessed record, and
    // the reasons line says outright that there is nothing to explain.
    const items = [item('ref-included', 'included'), item('ref-untouched', 'not-evaluated')]
    api.getScreening.mockResolvedValue(snapshot(items))
    await act(async () => {
      root.render(
        <ReferencesScreeningPanel
          collectionId="collection-1"
          collectionName="Screen hits"
          references={references}
          onNotice={() => {}}
          onError={() => {}}
        />
      )
    })
    await flush()
    await act(async () => {
      findExactButton('Export included').click()
      await Promise.resolve()
    })
    await flush()

    expect(byTestId('screening-export-receipt-not-exported').textContent?.trim()).toBe(
      'Not exported 1: needs review 0 · excluded 0 · not evaluated 1 · by a human override 0'
    )
    expect(byTestId('screening-export-receipt-reasons').textContent?.trim()).toBe(
      'No named reasons.'
    )
  })

  it('writes nothing when the save is cancelled, and reports a failed write instead of a receipt', async () => {
    const references = [reference('ref-included', 'Included record')]
    const onNotice = vi.fn()
    const onError = vi.fn()
    api.getScreening.mockResolvedValue(snapshot([item('ref-included', 'included')]))
    await act(async () => {
      root.render(
        <ReferencesScreeningPanel
          collectionId="collection-1"
          collectionName="Screen hits"
          references={references}
          onNotice={onNotice}
          onError={onError}
        />
      )
    })
    await flush()

    saveBlobFile.mockResolvedValueOnce({ saved: false })
    await act(async () => {
      findExactButton('Export included').click()
      await Promise.resolve()
    })
    await flush()
    expect(saveBlobFile).toHaveBeenCalledTimes(1)
    expect(onNotice).toHaveBeenCalledWith('The save was cancelled, so nothing was written.')
    // A cancelled save is not an export: no receipt may claim a file nobody wrote.
    expect(container.querySelector('[data-testid="screening-export-receipt"]')).toBeNull()

    // A write that throws is named, and still leaves no receipt behind.
    saveBlobFile.mockRejectedValueOnce(new Error('the disk is full'))
    await act(async () => {
      findExactButton('Export included').click()
      await Promise.resolve()
    })
    await flush()
    expect(onError).toHaveBeenCalledWith('The export was not saved: the disk is full')
    expect(container.querySelector('[data-testid="screening-export-receipt"]')).toBeNull()
  })

  it('refuses to write when the ledger names an included record this list no longer has', async () => {
    const onError = vi.fn()
    // The scope says one record is included, and the window's list has none of them: a file written from
    // it would silently be smaller than the range it is named after.
    api.getScreening.mockResolvedValue(snapshot([item('ref-gone', 'included')]))
    await act(async () => {
      root.render(
        <ReferencesScreeningPanel
          collectionId="collection-1"
          collectionName="Screen hits"
          references={[]}
          onNotice={() => {}}
          onError={onError}
        />
      )
    })
    await flush()

    await act(async () => {
      findExactButton('Export included').click()
      await Promise.resolve()
    })
    await flush()

    expect(saveBlobFile).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(
      '1 included records are not in this list any more; reopen the collection and export again.'
    )
  })

  it('re-reads the ledger when the collection’s membership changes behind the panel', async () => {
    const state = snapshot([item('ref-included', 'included')])
    api.getScreening.mockResolvedValue(state)
    await render(state, [
      reference('ref-included', 'Included record'),
      reference('ref-late', 'Added later')
    ])
    const readsAfterMount = api.getScreening.mock.calls.length

    // The library adds or removes a record while this panel is open: the statistics are counts over the
    // members, so the panel re-reads instead of showing a number the ledger already disagrees with.
    await act(async () => {
      root.render(
        <ReferencesScreeningPanel
          collectionId="collection-1"
          collectionName="Screen hits"
          references={[reference('ref-included', 'Included record')]}
          onNotice={() => {}}
          onError={() => {}}
        />
      )
    })
    await flush()
    expect(api.getScreening.mock.calls.length).toBeGreaterThan(readsAfterMount)
  })

  it('re-reads the ledger when export is pressed, so a range that moved cannot be written', async () => {
    const references = [reference('ref-included-by-human', 'Later cohort')]
    const before = snapshot([
      item('ref-included-by-human', 'needs-review', ['uncertain'], {
        collectionId: 'collection-1',
        referenceId: 'ref-included-by-human',
        decision: 'include',
        reason: 'the protocol admits this cohort',
        actor: 'user',
        createdAt: 1
      })
    ])
    // The preview is drawn from this read; the export re-reads and finds the override cleared.
    const after = snapshot([item('ref-included-by-human', 'needs-review', ['uncertain'])])
    const onError = vi.fn()
    api.getScreening.mockResolvedValueOnce(before).mockResolvedValue(after)
    await act(async () => {
      root.render(
        <ReferencesScreeningPanel
          collectionId="collection-1"
          collectionName="Screen hits"
          references={references}
          onNotice={() => {}}
          onError={onError}
        />
      )
    })
    await flush()
    expect(byTestId('screening-export-preview').textContent).toContain('Will export 1')

    await act(async () => {
      findExactButton('Export included').click()
      await Promise.resolve()
    })
    await flush()

    // The range came from the fresh read, not the preview: nothing is included any more, so no file is
    // written and the reviewer is told why instead of receiving an empty bibliography.
    expect(api.getScreening.mock.calls.length).toBeGreaterThan(1)
    expect(saveBlobFile).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('Nothing is included yet, so there is nothing to export.')
  })
})

describe('the screening surface speaks all nine languages', () => {
  // 中文场景优先: the states, the named reasons, the coverage tiers and the counting lines are Chinese
  // first — and because the vocabulary is closed, every one of those strings exists in the other eight
  // dictionaries too (the repository's translation gate enforces the parity; this pins the point on the
  // screening keys specifically, so a new reason or coverage tier cannot ship half-translated).
  it('has copy for every state, reason and coverage tier in every language', async () => {
    const { dictionaries } = await import('@/i18n/languages')
    const { en } = await import('@/i18n/en')
    const screeningKeys = Object.keys(en).filter((key) => key.startsWith('references.screening.'))
    expect(screeningKeys.length).toBeGreaterThan(70)

    for (const [language, dictionary] of Object.entries(dictionaries)) {
      const missing = screeningKeys.filter((key) => !dictionary[key as keyof typeof en]?.trim())
      expect({ language, missing }).toEqual({ language, missing: [] })
    }

    const zh = dictionaries.zh
    const zhText = (key: keyof typeof en): string => zh[key] ?? ''
    // The four states.
    expect(zhText('references.screening.verdict.included')).toBe('纳入')
    expect(zhText('references.screening.verdict.needs-review')).toBe('待复核')
    expect(zhText('references.screening.verdict.not-evaluated')).toBe('未判定')
    // The six named reasons, spelled out rather than left as machine tokens.
    expect(zhText('references.screening.reason.rule-changed')).toBe('规则已变')
    expect(zhText('references.screening.reason.input-changed')).toBe('依据已变')
    expect(zhText('references.screening.reason.model-changed')).toBe('模型或策略已变')
    expect(zhText('references.screening.reason.missing-evidence')).toBe('没有全文可读')
    expect(zhText('references.screening.reason.input-too-long')).toBe('依据超出模型输入上限')
    expect(zhText('references.screening.reason.uncertain')).toBe('判定本身不确定')
    // The four coverage tiers and the counting line that separates AI decisions from human overrides.
    expect(zhText('references.screening.coverage.full-text')).toBe('全文')
    expect(zhText('references.screening.coverage.unavailable')).toBe('无依据')
    expect(zhText('references.screening.aiVsHuman')).toContain('人工覆盖')
    expect(zhText('references.screening.summary')).toContain('未处理')
  })

  // S4's own copy, in all nine — the statistics labels, the range statement, the export action and the
  // receipt. 中文 states the range as 仅纳入, and the receipt's "what stayed out" line names the three
  // buckets plus the human override, because a receipt that only says "done" is not a receipt.
  it('has copy for the statistics panel and the screening export in every language', async () => {
    const { dictionaries } = await import('@/i18n/languages')
    const { en } = await import('@/i18n/en')
    const s4Keys = [
      'references.screening.stats.title',
      'references.screening.stats.ai',
      'references.screening.stats.overrides',
      'references.screening.stats.unprocessed',
      'references.screening.stats.unprocessedNote',
      'references.screening.stats.verdicts',
      'references.screening.stats.coverage',
      'references.screening.export.title',
      'references.screening.export.scope',
      'references.screening.export.scopeIncludedOnly',
      'references.screening.export.preview',
      'references.screening.export.action',
      'references.screening.export.nothingIncluded',
      'references.screening.export.receiptExported',
      'references.screening.export.receiptNotExported',
      'references.screening.export.receiptReasons',
      'references.screening.export.receiptNoReasons',
      'references.screening.export.receiptProvenance',
      'references.screening.export.receiptSavedTo',
      'references.screening.export.listChanged',
      'references.screening.export.failed',
      'references.screening.export.cancelled'
    ] as const
    // Every key the panel uses exists — a missing one would render the raw key in the window.
    expect(s4Keys.every((key) => key in en)).toBe(true)

    for (const [language, dictionary] of Object.entries(dictionaries)) {
      const missing = s4Keys.filter((key) => !dictionary[key]?.trim())
      expect({ language, missing }).toEqual({ language, missing: [] })
    }

    const zh = dictionaries.zh
    const zhText = (key: keyof typeof en): string => zh[key] ?? ''
    expect(zhText('references.screening.export.scopeIncludedOnly')).toBe('仅纳入')
    expect(zhText('references.screening.export.scope')).toContain('仅纳入')
    expect(zhText('references.screening.export.preview')).toContain('未导出')
    expect(zhText('references.screening.export.receiptNotExported')).toContain('人工覆盖')
    expect(zhText('references.screening.export.receiptReasons')).toContain('具名原因')
    expect(zhText('references.screening.stats.unprocessedNote')).toContain('未处理')
    expect(zhText('references.screening.stats.unprocessed')).toBe('未处理数')
    // Placeholder parity: the receipt templates are filled by name, so every language must carry them.
    for (const [key, placeholders] of [
      [
        'references.screening.export.preview',
        ['included', 'notExported', 'review', 'excluded', 'notEvaluated']
      ],
      [
        'references.screening.export.receiptNotExported',
        ['notExported', 'review', 'excluded', 'notEvaluated', 'byOverride']
      ],
      ['references.screening.export.receiptProvenance', ['collection', 'revision', 'hash', 'time']]
    ] as const) {
      for (const [language, dictionary] of Object.entries(dictionaries)) {
        const value = dictionary[key as keyof typeof en] ?? ''
        const absent = placeholders.filter((name) => !value.includes(`{${name}}`))
        expect({ language, key, absent }).toEqual({ language, key, absent: [] })
      }
    }
  })
})
