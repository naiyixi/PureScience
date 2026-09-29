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
    'references.screening.coverage.metadata-only': 'Metadata only',
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
    'references.screening.batchApplied2': 'applied'
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
    clearScreeningOverride: vi.fn()
  }

  // Exact text, because a row's "Include" button sits under a filter chip reading "Included".
  const findExactButton = (label: string): HTMLButtonElement => {
    const match = Array.from(document.querySelectorAll('button')).find(
      (button) => (button.textContent ?? '').trim() === label
    )
    if (!match) throw new Error(`no button whose text is exactly ${label}`)
    return match
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
    window.api = { references: api } as unknown as typeof window.api
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
})
