import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useLanguage, type TranslationKey } from '@/i18n'
import { getUiLocale } from '@/lib/ui-locale'
import type { Reference } from '../../../../shared/references'
import {
  DEFAULT_CITATION_STYLE_ID,
  citationItemFromReference,
  formatCitationList,
  resolveCitationStyles
} from '../../../../shared/citation/format'
import { citationStyleFromImport } from '../../../../shared/citation/csl'
import type { CitationStyleDefinition } from '../../../../shared/citation/types'
import {
  SCREENING_EVIDENCE_COVERAGES,
  SCREENING_NAMED_REASONS,
  SCREENING_VERDICTS,
  type ScreeningCollectionSnapshot,
  type ScreeningCriterion,
  type ScreeningEvidenceCoverage,
  type ScreeningItemView,
  type ScreeningNamedReason,
  type ScreeningOverrideDecision,
  type ScreeningRuleRevision,
  type ScreeningVerdict
} from '../../../../shared/references-screening'
import {
  SCREENING_EXPORT_SCOPE,
  buildScreeningExportScope,
  screeningExportFileName,
  screeningExportReasonBreakdown,
  type ScreeningExportScope
} from '../../../../shared/references-screening-export'
import { buildScreeningCoverageChecklist } from '../../../../shared/references-screening-coverage'
import { ReferencesScreeningCoverageList } from './ReferencesScreeningCoverageList'

// The screening surface of one collection (S3). It reads the collection's triage state, drives a pass,
// edits the versioned rule set, and records human overrides — and it is built so that the two layers a
// decision has are always BOTH visible: the AI verdict with the passage it rests on sits beside the
// human override, and "back to the AI verdict" is a first-class control rather than a destructive one.
//
// Everything a button does is a real round trip: each action awaits the main process and re-renders
// from what the backend returns (the write itself answers with the updated line), never from a local
// guess. While a pass runs the snapshot is polled, so progress and named failures are read from the
// ledger rather than from the renderer's memory of what it asked for.

const VERDICT_LABEL: Record<ScreeningVerdict, TranslationKey> = {
  included: 'references.screening.verdict.included',
  'needs-review': 'references.screening.verdict.needs-review',
  excluded: 'references.screening.verdict.excluded',
  'not-evaluated': 'references.screening.verdict.not-evaluated'
}

const ADD_CRITERION_LABEL: Record<'inclusion' | 'exclusion', TranslationKey> = {
  inclusion: 'references.screening.addInclusionCriterion',
  exclusion: 'references.screening.addExclusionCriterion'
}

const REASON_LABEL: Record<ScreeningNamedReason, TranslationKey> = {
  'rule-changed': 'references.screening.reason.rule-changed',
  'input-changed': 'references.screening.reason.input-changed',
  'model-changed': 'references.screening.reason.model-changed',
  'missing-evidence': 'references.screening.reason.missing-evidence',
  'input-too-long': 'references.screening.reason.input-too-long',
  uncertain: 'references.screening.reason.uncertain'
}

const COVERAGE_LABEL: Record<ScreeningEvidenceCoverage, TranslationKey> = {
  'full-text': 'references.screening.coverage.full-text',
  'abstract-only': 'references.screening.coverage.abstract-only',
  'metadata-only': 'references.screening.coverage.metadata-only',
  unavailable: 'references.screening.coverage.unavailable'
}

type TranslateFn = (key: TranslationKey, vars?: Record<string, string | number>) => string

// One export action's receipt (S4). It carries the range that was used, how much of it reached a file,
// and what stayed out — so the sentence a reviewer reads afterwards is built from the same object the
// file was built from, instead of from a hopeful re-derivation.
type ScreeningExportReceipt = {
  scope: ScreeningExportScope
  exportedCount: number
  styleLabel: string
  fileName: string
  savedPath: string | null
  exportedAt: number
}

type ScreeningExportReceiptText = {
  exported: string
  notExported: string
  reasons: string
  provenance: string
  savedTo: string | null
}

// The receipt, in words. Both the persistent block and the toast are this one function's output, so a
// reviewer reading either sees the same numbers — and the named reasons behind the exclusions are
// spelled out rather than counted into the total.
const describeScreeningExportReceipt = (
  receipt: ScreeningExportReceipt,
  input: { collectionName: string; time: string; t: TranslateFn }
): ScreeningExportReceiptText => {
  const { scope } = receipt
  const { t } = input
  const reasons = screeningExportReasonBreakdown(scope).map(
    (entry) => `${t(REASON_LABEL[entry.reason])}: ${entry.count}`
  )
  return {
    exported: t('references.screening.export.receiptExported', {
      exported: receipt.exportedCount,
      style: receipt.styleLabel,
      scope: t('references.screening.export.scopeIncludedOnly')
    }),
    notExported: t('references.screening.export.receiptNotExported', {
      notExported: scope.notExportedCount,
      review: scope.notExportedCounts['needs-review'],
      excluded: scope.notExportedCounts.excluded,
      notEvaluated: scope.notExportedCounts['not-evaluated'],
      byOverride: scope.notExportedByOverrideCount
    }),
    reasons:
      reasons.length > 0
        ? t('references.screening.export.receiptReasons', { reasons: reasons.join(' · ') })
        : t('references.screening.export.receiptNoReasons'),
    provenance: t('references.screening.export.receiptProvenance', {
      collection: input.collectionName,
      revision: scope.ruleRevision ?? 0,
      hash: (scope.ruleContentHash ?? '').slice(0, 12),
      time: input.time
    }),
    savedTo: receipt.savedPath
      ? t('references.screening.export.receiptSavedTo', { path: receipt.savedPath })
      : null
  }
}

// Colour by state, and a human override always carries its own badge: a decision a person made must be
// distinguishable at a glance from one the model made.
const VERDICT_CLASS: Record<ScreeningVerdict, string> = {
  included: 'bg-emerald-500/15 text-emerald-400',
  'needs-review': 'bg-amber-500/15 text-amber-400',
  excluded: 'bg-red-500/15 text-red-400',
  'not-evaluated': 'bg-[var(--border)] text-[var(--muted-foreground)]'
}

type FilterValue = ScreeningVerdict | 'all'

const FILTERS: readonly FilterValue[] = ['all', ...SCREENING_VERDICTS]

const FILTER_LABEL: Record<FilterValue, TranslationKey> = {
  all: 'references.screening.filter.all',
  included: 'references.screening.verdict.included',
  'needs-review': 'references.screening.verdict.needs-review',
  excluded: 'references.screening.verdict.excluded',
  'not-evaluated': 'references.screening.verdict.not-evaluated'
}

const POLL_INTERVAL_MS = 900

type CriterionDraft = { key: string; id: string; text: string }

const toDraft = (criteria: readonly ScreeningCriterion[], prefix: string): CriterionDraft[] =>
  criteria.map((criterion, index) => ({
    key: `${prefix}-${index}`,
    id: criterion.id,
    text: criterion.text
  }))

export function ReferencesScreeningPanel({
  collectionId,
  collectionName,
  references,
  onNotice,
  onError
}: {
  collectionId: string
  collectionName: string
  references: readonly Reference[]
  onNotice: (message: string) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const { t } = useLanguage()
  const [snapshot, setSnapshot] = useState<ScreeningItemView[] | null>(null)
  const [rule, setRule] = useState<ScreeningRuleRevision | null>(null)
  const [summaryText, setSummaryText] = useState<{
    candidate: number
    searched: number
    assessed: number
    unprocessed: number
    review: number
    ai: number
    overrides: number
    verdicts: Record<ScreeningVerdict, number>
    coverage: Record<ScreeningEvidenceCoverage, number>
    reasons: Record<ScreeningNamedReason, number>
  } | null>(null)
  const [run, setRun] = useState<{
    status: string
    running: boolean
    referenceCount: number
    assessed: number
    deferred: number
    failed: number
    pending: number
    runId: string
  } | null>(null)
  const [runnerAvailable, setRunnerAvailable] = useState(true)
  const [lastError, setLastError] = useState<string | null>(null)

  const [inclusion, setInclusion] = useState<CriterionDraft[]>([])
  const [exclusion, setExclusion] = useState<CriterionDraft[]>([])
  // A ref rather than state: it decides whether an arriving snapshot may overwrite the editor, which is a
  // question asked inside an async read, not something that should re-render.
  const criteriaDirtyRef = useRef(false)
  const [revisions, setRevisions] = useState<ScreeningRuleRevision[] | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  const [filter, setFilter] = useState<FilterValue>('all')
  const [selected, setSelected] = useState<string[]>([])
  const [overrideReasons, setOverrideReasons] = useState<Record<string, string>>({})
  const [batchReason, setBatchReason] = useState('')
  const [busy, setBusy] = useState(false)

  // The export side (S4). The citation-style catalogue is the library's OWN (built-ins from the shared
  // catalogue, imported styles from the existing store), so the screening export formats through the
  // same path as every other export in the app instead of growing a second one.
  const [styles, setStyles] = useState<readonly CitationStyleDefinition[]>(() =>
    resolveCitationStyles()
  )
  const [styleId, setStyleId] = useState<string>(DEFAULT_CITATION_STYLE_ID)
  const [exporting, setExporting] = useState(false)
  const [receipt, setReceipt] = useState<ScreeningExportReceipt | null>(null)

  const applySnapshot = useCallback((next: ScreeningCollectionSnapshot): void => {
    setSnapshot(next.items)
    setRule(next.rule)
    // The criteria editor follows the newest revision until the reviewer starts typing: a poll that
    // rewrote a half-typed criterion would be worse than showing a stale draft.
    if (next.rule && !criteriaDirtyRef.current) {
      setInclusion(toDraft(next.rule.inclusion, 'in'))
      setExclusion(toDraft(next.rule.exclusion, 'ex'))
    }
    setSummaryText({
      candidate: next.summary.candidateCount,
      searched: next.summary.searchedCount,
      assessed: next.summary.assessedCount,
      unprocessed: next.summary.unprocessedCount,
      review: next.summary.reviewCount,
      ai: next.aiDecidedCount,
      overrides: next.overrideCount,
      verdicts: next.summary.verdictCounts,
      coverage: next.summary.coverageCounts,
      reasons: next.reasonCounts
    })
    setRunnerAvailable(next.runnerAvailable)
    setLastError(next.lastError)
    setRun(
      next.lastRun
        ? {
            status: next.lastRun.run.status,
            running: next.lastRun.running,
            referenceCount: next.lastRun.referenceCount,
            assessed: next.lastRun.assessed,
            deferred: next.lastRun.deferred,
            failed: next.lastRun.failed,
            pending: next.lastRun.pending,
            runId: next.lastRun.run.id
          }
        : null
    )
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    try {
      applySnapshot(await window.api.references.getScreening(collectionId))
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [applySnapshot, collectionId, onError])

  // Mount reads this collection's state. Stated as a promise chain rather than an awaited helper call so
  // the effect body itself never sets state — the same shape the library dialog uses for its own reads.
  useEffect(() => {
    let alive = true
    window.api.references
      .getScreening(collectionId)
      .then((next) => {
        if (alive) applySnapshot(next)
      })
      .catch((cause: unknown) => {
        if (alive) onError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      alive = false
    }
  }, [applySnapshot, collectionId, onError])

  // The imported citation styles come from the library's own store: the export offers exactly the
  // styles the rest of the app offers, and a style store that cannot be read is reported rather than
  // quietly narrowed to the built-ins.
  useEffect(() => {
    let alive = true
    window.api.references
      .listCitationStyles()
      .then((imported) => {
        if (alive)
          setStyles(resolveCitationStyles(imported.map((style) => citationStyleFromImport(style))))
      })
      .catch((cause: unknown) => {
        if (alive) onError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      alive = false
    }
  }, [onError])

  const running = run?.running ?? false
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      void reload()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [running, reload])

  // The collection's MEMBERSHIP can change while this panel is open (a record added, removed, or
  // re-assigned from the library toolbar behind it). The statistics are counts over those members, so a
  // change re-reads the ledger rather than leaving a number on screen that the database already
  // disagrees with. Keyed on the id set, and skipped on mount: the mount read above is that one.
  const memberKey = useMemo(
    () =>
      references
        .map((entry) => entry.id)
        .sort()
        .join(','),
    [references]
  )
  const memberKeyRef = useRef(memberKey)
  useEffect(() => {
    if (memberKeyRef.current === memberKey) return
    memberKeyRef.current = memberKey
    void reload()
  }, [memberKey, reload])

  const byId = useMemo(() => new Map(references.map((item) => [item.id, item])), [references])

  const shown = useMemo(
    () => (snapshot ?? []).filter((item) => filter === 'all' || item.decision.effective === filter),
    [snapshot, filter]
  )

  // The range this export WOULD use, previewed from the same lines the rows are drawn from — so the
  // reviewer decides with the scope in front of them ("仅纳入") instead of discovering it in the file.
  // Pressing export re-reads the ledger first (see handleExportIncluded): the preview informs, the read
  // decides.
  const exportScope = useMemo<ScreeningExportScope | null>(
    () =>
      snapshot === null ? null : buildScreeningExportScope({ collectionId, rule, items: snapshot }),
    [collectionId, rule, snapshot]
  )

  // The coverage checklist (S5), derived from the SAME lines the rows are drawn from and from the two
  // totals the ledger returned with them. Nothing here re-counts anything by hand: the membership
  // lists, the four tier counts and the reconciliation verdict all come from one pure function, so the
  // checklist a reader audits and the rows they scroll are two readings of one object.
  const coverageChecklist = useMemo(
    () =>
      snapshot === null || summaryText === null
        ? null
        : buildScreeningCoverageChecklist({
            collectionId,
            searchedCount: summaryText.searched,
            candidateCount: summaryText.candidate,
            items: snapshot
          }),
    [collectionId, snapshot, summaryText]
  )

  const titleOf = useCallback(
    (referenceId: string): string => byId.get(referenceId)?.title ?? referenceId,
    [byId]
  )

  const when = (value: number): string => new Date(value).toLocaleString(getUiLocale())

  // The receipt in words, computed once: the same strings are shown in the panel and sent as the toast.
  const receiptText = receipt
    ? describeScreeningExportReceipt(receipt, {
        collectionName,
        time: when(receipt.exportedAt),
        t
      })
    : null

  const draftFrom = (rows: readonly CriterionDraft[]): ScreeningCriterion[] =>
    rows
      .map((row) => ({ id: row.id.trim(), text: row.text }))
      .filter((row) => row.id.length > 0 || row.text.trim().length > 0)

  const markDirty = (mutate: () => void): void => {
    mutate()
    criteriaDirtyRef.current = true
  }

  const handleSaveCriteria = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.references.appendScreeningRuleRevision({
        collectionId,
        inclusion: draftFrom(inclusion),
        exclusion: draftFrom(exclusion)
      })
      criteriaDirtyRef.current = false
      setRule(result.revision)
      // An open history follows the append: a new revision is a new row, so a stale list would show a
      // history that disagrees with the revision it is describing.
      if (showHistory) {
        setRevisions(await window.api.references.listScreeningRuleRevisions(collectionId))
      }
      onNotice(
        (result.appended
          ? t('references.screening.savedCriteria', { revision: result.revision.revision })
          : t('references.screening.unchangedCriteria', { revision: result.revision.revision })) +
          (result.affectedDecisions > 0
            ? ` ${t('references.screening.criteriaStale', { n: result.affectedDecisions })}`
            : '')
      )
      await reload()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const handleToggleHistory = async (): Promise<void> => {
    if (showHistory) {
      setShowHistory(false)
      return
    }
    try {
      setRevisions(await window.api.references.listScreeningRuleRevisions(collectionId))
      setShowHistory(true)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const handleStart = async (resumeRunId?: string): Promise<void> => {
    setBusy(true)
    try {
      const started = await window.api.references.startScreeningRun({
        collectionId,
        ...(resumeRunId ? { resumeRunId } : {})
      })
      onNotice(
        `${t('references.screening.progress', { done: 0, total: started.referenceCount })} · ${
          started.started ? started.runId : t('references.screening.runStatus.running')
        }`
      )
      await reload()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const handleCancel = async (): Promise<void> => {
    setBusy(true)
    try {
      const cancelled = await window.api.references.cancelScreeningRun(collectionId)
      onNotice(
        cancelled.cancelled
          ? t('references.screening.cancelled', {
              processed: cancelled.processed,
              remaining: cancelled.remaining
            })
          : t('references.screening.cancelIdle')
      )
      await reload()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  // An override without a reason is refused on BOTH sides: here so the reviewer is told, and in the
  // repository so no other caller can write one.
  const handleOverride = async (
    referenceId: string,
    decision: ScreeningOverrideDecision
  ): Promise<void> => {
    const reason = (overrideReasons[referenceId] ?? '').trim()
    if (reason.length === 0) {
      onError(t('references.screening.overrideReasonRequired'))
      return
    }
    setBusy(true)
    try {
      const item = await window.api.references.setScreeningOverride({
        collectionId,
        referenceId,
        decision,
        reason,
        actor: 'user'
      })
      setSnapshot((current) =>
        (current ?? []).map((entry) => (entry.referenceId === item.referenceId ? item : entry))
      )
      setOverrideReasons((current) => {
        const next = { ...current }
        delete next[referenceId]
        return next
      })
      await reload()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const handleClearOverride = async (referenceId: string): Promise<void> => {
    setBusy(true)
    try {
      const cleared = await window.api.references.clearScreeningOverride(collectionId, referenceId)
      setSnapshot((current) =>
        (current ?? []).map((entry) =>
          entry.referenceId === cleared.referenceId ? cleared.item : entry
        )
      )
      onNotice(t('references.screening.overrideCleared'))
      await reload()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const handleBatch = async (decision: ScreeningOverrideDecision): Promise<void> => {
    if (selected.length === 0) {
      onError(t('references.screening.noSelection'))
      return
    }
    const reason = batchReason.trim()
    if (reason.length === 0) {
      onError(t('references.screening.overrideReasonRequired'))
      return
    }
    setBusy(true)
    try {
      const result = await window.api.references.setScreeningOverrides({
        collectionId,
        referenceIds: selected,
        decision,
        reason,
        actor: 'user'
      })
      onNotice(t('references.screening.batchApplied', { n: result.applied }))
      setBatchReason('')
      setSelected([])
      await reload()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  // The export (S4): the triage result goes straight into the library's existing GB/T 7714 export, over
  // the EFFECTIVE verdicts only. Three properties are deliberate:
  //
  //   1. the range is re-read from the ledger at the moment of the export, so a file cannot be built
  //      from a list that has since moved (a revision appended, an override applied a second ago);
  //   2. the text is formatted by the same shared citation layer every other export uses, in the
  //      library's own style catalogue — this is not a second export path;
  //   3. nothing is silent: what stayed out is counted per state and per named reason in the receipt,
  //      and the rule revision + hash + moment travel with it, so the file is attributable.
  const handleExportIncluded = async (): Promise<void> => {
    setExporting(true)
    try {
      const fresh = await window.api.references.getScreening(collectionId)
      const scope = buildScreeningExportScope({
        collectionId,
        rule: fresh.rule,
        items: fresh.items
      })
      if (scope.includedCount === 0) {
        onError(t('references.screening.export.nothingIncluded'))
        return
      }
      const byId = new Map(references.map((entry) => [entry.id, entry]))
      const exported = scope.includedReferenceIds
        .map((referenceId) => byId.get(referenceId))
        .filter((entry): entry is Reference => entry !== undefined)
      // The scope is read from the ledger and the records come from this window's list. If the ledger
      // names an included record the list no longer has (deleted or re-assigned elsewhere), the file
      // would silently contain fewer citations than the range it is named after — so nothing is
      // written and the reviewer is told, instead of receiving a bibliography with a hole in it.
      const missing = scope.includedCount - exported.length
      if (missing > 0) {
        onError(t('references.screening.export.listChanged', { n: missing }))
        return
      }
      const exportedAt = Date.now()
      const style = styles.find((entry) => entry.id === styleId) ?? styles[0]
      const text = formatCitationList(
        exported.map((entry) => citationItemFromReference(entry)),
        styleId,
        { retrievedAt: new Date(exportedAt).toISOString().slice(0, 10) },
        styles
      )
      const fileName = screeningExportFileName({
        collectionName,
        styleId,
        revision: scope.ruleRevision,
        generatedAt: exportedAt
      })
      const saved = await window.api.saveBlobFile({
        suggestedName: fileName,
        mimeType: 'text/plain',
        data: new TextEncoder().encode(text).buffer
      })
      if (!saved.saved) {
        // A cancelled save is not an export: no receipt may claim a file nobody wrote.
        onNotice(t('references.screening.export.cancelled'))
        return
      }
      const next: ScreeningExportReceipt = {
        scope,
        exportedCount: exported.length,
        styleLabel: style?.label ?? styleId,
        fileName,
        savedPath: saved.filePath ?? null,
        exportedAt
      }
      setReceipt(next)
      const described = describeScreeningExportReceipt(next, {
        collectionName,
        time: when(exportedAt),
        t
      })
      onNotice(
        [described.exported, described.notExported, described.reasons, described.provenance].join(
          ' · '
        )
      )
      // Read the state back after the write so the panel shows the ledger, not the export's hopes.
      await reload()
    } catch (cause) {
      onError(
        t('references.screening.export.failed', {
          message: cause instanceof Error ? cause.message : String(cause)
        })
      )
    } finally {
      setExporting(false)
    }
  }

  const buttonClass =
    'inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-[var(--accent-foreground)] hover:opacity-90 disabled:opacity-50'
  const ghostClass =
    'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--muted-foreground)] hover:bg-[var(--border)] disabled:opacity-50'
  const chipClass = 'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium'
  const inputClass =
    'rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-xs outline-none focus:border-[var(--accent)]'

  // Each column labels its own fields ("Inclusion criteria · Criterion ID"), so two columns with the
  // same field names stay distinguishable to a screen reader, a test and a person.
  const renderCriterionRows = (
    rows: readonly CriterionDraft[],
    column: 'inclusion' | 'exclusion',
    setRows: (next: CriterionDraft[]) => void,
    prefix: string
  ): React.JSX.Element => {
    const columnLabel = t(
      column === 'inclusion' ? 'references.screening.inclusion' : 'references.screening.exclusion'
    )
    return (
      <div className="min-w-0 flex-1" role="group" aria-label={columnLabel}>
        <p className="text-[11px] font-medium text-[var(--foreground)]">{columnLabel}</p>
        <ul className="mt-1 flex flex-col gap-1">
          {rows.map((row, index) => (
            <li key={row.key} className="flex items-center gap-1">
              <input
                value={row.id}
                aria-label={`${columnLabel} · ${t('references.screening.criterionId')}`}
                placeholder={t('references.screening.criterionId')}
                className={`${inputClass} w-20`}
                onChange={(event) =>
                  markDirty(() =>
                    setRows(
                      rows.map((entry, position) =>
                        position === index ? { ...entry, id: event.target.value } : entry
                      )
                    )
                  )
                }
              />
              <input
                value={row.text}
                aria-label={`${columnLabel} · ${t('references.screening.criterionText')}`}
                placeholder={t('references.screening.criterionText')}
                className={`${inputClass} min-w-0 flex-1`}
                onChange={(event) =>
                  markDirty(() =>
                    setRows(
                      rows.map((entry, position) =>
                        position === index ? { ...entry, text: event.target.value } : entry
                      )
                    )
                  )
                }
              />
              <button
                type="button"
                className={ghostClass}
                aria-label={t('references.screening.removeCriterion', { id: row.id || index + 1 })}
                title={t('references.screening.removeCriterion', { id: row.id || index + 1 })}
                onClick={() =>
                  markDirty(() => setRows(rows.filter((_entry, position) => position !== index)))
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className={`${ghostClass} mt-1`}
          aria-label={t(ADD_CRITERION_LABEL[column])}
          onClick={() =>
            markDirty(() =>
              setRows([...rows, { key: `${prefix}-new-${rows.length}`, id: '', text: '' }])
            )
          }
        >
          + {t('references.screening.addCriterion')}
        </button>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="screening-panel">
      <div className="border-b border-[var(--border)] px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-[var(--foreground)]">
            {t('references.screening.title')} · {collectionName}
          </span>
          {rule ? (
            <span className="text-[10px] text-[var(--muted-foreground)]">
              {t('references.screening.ruleRevision', { revision: rule.revision })} ·{' '}
              {t('references.screening.ruleHash', { hash: rule.contentHash.slice(0, 12) })}
            </span>
          ) : null}
          <button type="button" className={ghostClass} onClick={() => void handleToggleHistory()}>
            {showHistory
              ? t('references.screening.hideHistory')
              : t('references.screening.showHistory')}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={busy || !runnerAvailable || running}
            title={runnerAvailable ? undefined : t('references.screening.runnerUnavailable')}
            onClick={() => void handleStart()}
          >
            {t('references.screening.start')}
          </button>
          {run && !running && run.pending > 0 && run.status === 'running' ? (
            <button
              type="button"
              className={ghostClass}
              disabled={busy}
              onClick={() => void handleStart(run.runId)}
            >
              {t('references.screening.resume')}
            </button>
          ) : null}
          {running ? (
            <button
              type="button"
              className={ghostClass}
              disabled={busy}
              onClick={() => void handleCancel()}
            >
              {t('references.screening.cancel')}
            </button>
          ) : null}
        </div>

        {/* Criteria: a save appends an immutable revision; the notice says which and how many stored
            decisions that just staled. */}
        <div className="mt-2 flex flex-wrap gap-3 rounded-lg border border-[var(--border)] p-2">
          {renderCriterionRows(inclusion, 'inclusion', setInclusion, 'in')}
          {renderCriterionRows(exclusion, 'exclusion', setExclusion, 'ex')}
          <div className="flex items-end">
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => void handleSaveCriteria()}
            >
              {t('references.screening.saveCriteria')}
            </button>
          </div>
        </div>
        {rule === null ? (
          <p className="mt-1 text-[11px] text-amber-400">{t('references.screening.noCriteria')}</p>
        ) : null}

        {showHistory ? (
          <div className="mt-2 rounded-lg border border-[var(--border)] p-2">
            <p className="text-[11px] font-medium text-[var(--foreground)]">
              {t('references.screening.showHistory')}
            </p>
            <p className="text-[10px] text-[var(--muted-foreground)]">
              {t('references.screening.historyHint')}
            </p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {(revisions ?? []).map((revision) => (
                <li
                  key={revision.revision}
                  className="flex flex-wrap items-center gap-2 text-[10px]"
                >
                  <span className="font-medium text-[var(--foreground)]">
                    {t('references.screening.ruleRevision', { revision: revision.revision })}
                  </span>
                  <span className="text-[var(--muted-foreground)]">{when(revision.createdAt)}</span>
                  <span className="text-[var(--muted-foreground)]">
                    {t('references.screening.ruleHash', {
                      hash: revision.contentHash.slice(0, 12)
                    })}
                  </span>
                  <span className="text-[var(--muted-foreground)]">
                    {revision.inclusion.length + revision.exclusion.length}
                  </span>
                  <span
                    className={`${chipClass} ${
                      revision.revision === rule?.revision
                        ? 'bg-emerald-500/15 text-emerald-400'
                        : 'bg-[var(--border)] text-[var(--muted-foreground)]'
                    }`}
                  >
                    {revision.revision === rule?.revision
                      ? t('references.screening.revisionCurrent')
                      : t('references.screening.revisionSuperseded')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Statistics: AI decisions and human overrides are counted apart, and the unprocessed count is
            printed — never inferred from a missing row. */}
        {summaryText ? (
          <div className="mt-2 flex flex-col gap-0.5">
            <p className="text-[11px] text-[var(--foreground)]">
              {t('references.screening.summary', {
                candidate: summaryText.candidate,
                searched: summaryText.searched,
                assessed: summaryText.assessed,
                unprocessed: summaryText.unprocessed,
                review: summaryText.review
              })}
            </p>
            <p className="text-[10px] text-[var(--muted-foreground)]">
              {t('references.screening.aiVsHuman', {
                ai: summaryText.ai,
                overrides: summaryText.overrides
              })}
            </p>
            <p className="text-[10px] text-[var(--muted-foreground)]">
              {t('references.screening.coverageCounts', {
                fullText: summaryText.coverage['full-text'],
                abstractOnly: summaryText.coverage['abstract-only'],
                metadataOnly: summaryText.coverage['metadata-only'],
                unavailable: summaryText.coverage.unavailable
              })}
            </p>
            <p className="text-[10px] text-[var(--muted-foreground)]">
              {SCREENING_NAMED_REASONS.filter((reason) => summaryText.reasons[reason] > 0)
                .map((reason) => `${t(REASON_LABEL[reason])}: ${summaryText.reasons[reason]}`)
                .join(' · ')}
            </p>
          </div>
        ) : null}

        {/* 统计面板 (S4): AI decisions / human overrides / unprocessed are THREE separate numbers, each
            its own element, because a surface that adds them together cannot answer either question —
            and the unprocessed line says outright that it never reaches an export. Alongside them, the
            four-state distribution and the evidence-coverage distribution, which is what makes "how much
            is left and on what basis" checkable per item rather than in aggregate. */}
        {summaryText ? (
          <div
            className="mt-2 flex flex-col gap-1 rounded-lg border border-[var(--border)] p-2"
            data-testid="screening-stats"
          >
            <div className="flex flex-wrap items-baseline gap-3">
              <span
                className="text-[11px] text-[var(--muted-foreground)]"
                data-testid="screening-stat-ai"
              >
                {t('references.screening.stats.ai')}{' '}
                <span className="font-semibold text-[var(--foreground)]">{summaryText.ai}</span>
              </span>
              <span
                className="text-[11px] text-[var(--muted-foreground)]"
                data-testid="screening-stat-overrides"
              >
                {t('references.screening.stats.overrides')}{' '}
                <span className="font-semibold text-[var(--foreground)]">
                  {summaryText.overrides}
                </span>
              </span>
              <span
                className="text-[11px] text-[var(--muted-foreground)]"
                data-testid="screening-stat-unprocessed"
              >
                {t('references.screening.stats.unprocessed')}{' '}
                <span className="font-semibold text-amber-400">{summaryText.unprocessed}</span>
              </span>
            </div>
            <p className="text-[10px] text-[var(--muted-foreground)]">
              {t('references.screening.stats.unprocessedNote')}
            </p>
            <p
              className="text-[10px] text-[var(--muted-foreground)]"
              data-testid="screening-stat-verdicts"
            >
              {t('references.screening.stats.verdicts')}:{' '}
              {SCREENING_VERDICTS.map((verdict) => (
                <span
                  key={verdict}
                  className="mr-2 inline-block"
                  data-testid={`screening-stat-verdict-${verdict}`}
                >
                  {t(VERDICT_LABEL[verdict])}{' '}
                  <span className="font-medium text-[var(--foreground)]">
                    {summaryText.verdicts[verdict]}
                  </span>
                </span>
              ))}
            </p>
            <p
              className="text-[10px] text-[var(--muted-foreground)]"
              data-testid="screening-stat-coverage"
            >
              {t('references.screening.stats.coverage')}:{' '}
              {SCREENING_EVIDENCE_COVERAGES.map((coverage) => (
                <span
                  key={coverage}
                  className="mr-2 inline-block"
                  data-testid={`screening-stat-coverage-${coverage}`}
                >
                  {t(COVERAGE_LABEL[coverage])}{' '}
                  <span className="font-medium text-[var(--foreground)]">
                    {summaryText.coverage[coverage]}
                  </span>
                </span>
              ))}
            </p>
          </div>
        ) : null}

        {/* 覆盖率清单 (S5): the four evidence tiers as four MEMBERSHIP lists plus their counts, the
            reconciliation line that says whether they add up to the candidate count, and the
            unprocessed records named one by one — so "we covered everything" can be checked by
            re-counting the list rather than by trusting a total. */}
        {coverageChecklist ? (
          <ReferencesScreeningCoverageList checklist={coverageChecklist} titleOf={titleOf} />
        ) : null}

        {/* The export (S4): 仅纳入 — the effective verdicts only — into the library's own GB/T 7714
            export. The scope is stated BEFORE the button, the range is re-read when it is pressed, and
            the receipt afterwards names what stayed out and why, with the revision and the moment. */}
        <div
          className="mt-2 flex flex-col gap-1 rounded-lg border border-[var(--border)] p-2"
          data-testid="screening-export"
          data-scope={SCREENING_EXPORT_SCOPE}
        >
          <p className="text-[11px] text-[var(--foreground)]" data-testid="screening-export-scope">
            {t('references.screening.export.title')} · {t('references.screening.export.scope')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="max-w-56 rounded border border-[var(--border)] bg-transparent px-1 py-0.5 text-[10px]"
              aria-label={t('references.citationStyle')}
              value={styleId}
              onChange={(event) => setStyleId(event.target.value)}
            >
              <optgroup label={t('references.builtinStyles')}>
                {styles
                  .filter((style) => style.source === 'builtin')
                  .map((style) => (
                    <option key={style.id} value={style.id}>
                      {style.labelZh}
                    </option>
                  ))}
              </optgroup>
              {styles.some((style) => style.source === 'imported') ? (
                <optgroup label={t('references.importedStyles')}>
                  {styles
                    .filter((style) => style.source === 'imported')
                    .map((style) => (
                      <option key={style.id} value={style.id}>
                        {style.label}
                      </option>
                    ))}
                </optgroup>
              ) : null}
            </select>
            <button
              type="button"
              className={buttonClass}
              disabled={exporting || (exportScope?.includedCount ?? 0) === 0}
              onClick={() => void handleExportIncluded()}
            >
              {t('references.screening.export.action')}
            </button>
            {exportScope ? (
              <span
                className="text-[10px] text-[var(--muted-foreground)]"
                data-testid="screening-export-preview"
              >
                {t('references.screening.export.preview', {
                  included: exportScope.includedCount,
                  notExported: exportScope.notExportedCount,
                  review: exportScope.notExportedCounts['needs-review'],
                  excluded: exportScope.notExportedCounts.excluded,
                  notEvaluated: exportScope.notExportedCounts['not-evaluated']
                })}
              </span>
            ) : null}
          </div>
          {receipt && receiptText ? (
            <div className="flex flex-col gap-0.5" data-testid="screening-export-receipt">
              <p
                className="text-[10px] text-[var(--foreground)]"
                data-testid="screening-export-receipt-summary"
              >
                {receiptText.exported}
              </p>
              <p
                className="text-[10px] text-[var(--muted-foreground)]"
                data-testid="screening-export-receipt-not-exported"
              >
                {receiptText.notExported}
              </p>
              <p
                className="text-[10px] text-[var(--muted-foreground)]"
                data-testid="screening-export-receipt-reasons"
              >
                {receiptText.reasons}
              </p>
              <p
                className="text-[10px] text-[var(--muted-foreground)]"
                data-testid="screening-export-receipt-provenance"
              >
                {receiptText.provenance}
              </p>
              {receiptText.savedTo ? (
                <p
                  className="text-[10px] text-[var(--muted-foreground)]"
                  data-testid="screening-export-receipt-path"
                >
                  {receiptText.savedTo}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {run ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-[var(--foreground)]">
              {t(`references.screening.runStatus.${run.status}` as TranslationKey)}
            </span>
            <span className="text-[10px] text-[var(--muted-foreground)]">
              {t('references.screening.progress', {
                done: run.assessed + run.deferred + run.failed,
                total: run.referenceCount
              })}
            </span>
            <span className="text-[10px] text-[var(--muted-foreground)]">
              {t('references.screening.runCounts', {
                assessed: run.assessed,
                deferred: run.deferred,
                failed: run.failed,
                pending: run.pending
              })}
            </span>
          </div>
        ) : null}
        {lastError ? (
          <p className="mt-1 text-[11px] text-amber-400" role="status">
            {t('references.screening.runFailed', { message: lastError })}
          </p>
        ) : null}
        {!runnerAvailable ? (
          <p className="mt-1 text-[11px] text-amber-400" role="status">
            {t('references.screening.runnerUnavailable')}
          </p>
        ) : null}
      </div>

      {/* Filters + batch override. */}
      <div className="flex flex-wrap items-center gap-1 border-b border-[var(--border)] px-3 py-1.5">
        {FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            className={`${chipClass} ${
              filter === value
                ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
                : 'bg-[var(--border)] text-[var(--muted-foreground)]'
            }`}
            onClick={() => setFilter(value)}
          >
            {t(FILTER_LABEL[value])}
            {value === 'all'
              ? ` (${snapshot?.length ?? 0})`
              : ` (${(snapshot ?? []).filter((item) => item.decision.effective === value).length})`}
          </button>
        ))}
        <button
          type="button"
          className={ghostClass}
          disabled={(snapshot?.length ?? 0) === 0}
          onClick={() =>
            setSelected(
              selected.length === (snapshot?.length ?? 0)
                ? []
                : (snapshot ?? []).map((item) => item.referenceId)
            )
          }
        >
          {t('references.screening.selectAll')}
        </button>
        <input
          value={batchReason}
          onChange={(event) => setBatchReason(event.target.value)}
          aria-label={t('references.screening.overrideReason')}
          placeholder={t('references.screening.overrideReasonPlaceholder')}
          className={`${inputClass} w-56`}
        />
        <button
          type="button"
          className={buttonClass}
          disabled={busy || selected.length === 0}
          onClick={() => void handleBatch('include')}
        >
          {t('references.screening.batchInclude', { n: selected.length })}
        </button>
        <button
          type="button"
          className={ghostClass}
          disabled={busy || selected.length === 0}
          onClick={() => void handleBatch('exclude')}
        >
          {t('references.screening.batchExclude', { n: selected.length })}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <ul className="flex flex-col gap-1.5">
          {shown.map((item) => {
            const record = byId.get(item.referenceId)
            const verdict = item.decision.verdict
            const override = item.decision.override
            // The row's state is also written as data attributes (see the <li> below): a reviewer's tool
            // — or an acceptance spec — can recompute the statistics from the rows themselves instead of
            // trusting a total printed once at the top.
            return (
              <li
                key={item.referenceId}
                data-testid="screening-row"
                data-reference-id={item.referenceId}
                data-verdict={verdict}
                data-effective={item.decision.effective}
                data-effective-source={item.decision.effectiveSource}
                data-coverage={item.coverage}
                data-override={override?.decision ?? ''}
                data-stale={item.freshness.stale ? 'true' : 'false'}
                data-reasons={item.freshness.reasons.join(',')}
                className="rounded-lg border border-[var(--border)] px-3 py-2"
              >
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    aria-label={t('references.screening.selectRow', {
                      title: record?.title ?? item.referenceId
                    })}
                    checked={selected.includes(item.referenceId)}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, item.referenceId]
                          : current.filter((id) => id !== item.referenceId)
                      )
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-[var(--foreground)]">
                      {record?.title ?? item.referenceId}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {/* The AI layer, always shown — an override never replaces it. */}
                      <span className="text-[10px] text-[var(--muted-foreground)]">
                        {t('references.screening.aiVerdict')}
                      </span>
                      <span className={`${chipClass} ${VERDICT_CLASS[verdict]}`}>
                        {t(VERDICT_LABEL[verdict])}
                      </span>
                      <span
                        className={`${chipClass} bg-[var(--border)] text-[var(--muted-foreground)]`}
                      >
                        {t(COVERAGE_LABEL[item.coverage])}
                      </span>
                      <span
                        className={`${chipClass} ${
                          item.freshness.stale
                            ? 'bg-amber-500/15 text-amber-400'
                            : 'bg-[var(--border)] text-[var(--muted-foreground)]'
                        }`}
                      >
                        {item.freshness.stale
                          ? t('references.screening.freshnessStale')
                          : t('references.screening.freshnessCurrent')}
                      </span>
                      {item.freshness.reasons.map((reason) => (
                        <span
                          key={reason}
                          className={`${chipClass} bg-amber-500/10 text-amber-400`}
                          data-testid="screening-reason"
                        >
                          {t(REASON_LABEL[reason])}
                        </span>
                      ))}
                      {item.decidedAt !== null && item.model ? (
                        <span className="text-[10px] text-[var(--muted-foreground)]">
                          {t('references.screening.decidedWith', {
                            model: item.model,
                            date: when(item.decidedAt)
                          })}
                        </span>
                      ) : null}
                    </div>

                    {/* The human layer, beside it. Clearing it restores the AI verdict exactly. */}
                    {override ? (
                      <div
                        className="mt-1 flex flex-wrap items-center gap-2 rounded border border-[var(--border)] bg-[var(--accent)]/5 px-2 py-1"
                        data-testid="screening-override"
                      >
                        <span className="text-[10px] text-[var(--muted-foreground)]">
                          {t('references.screening.humanOverride')}
                        </span>
                        <span
                          className={`${chipClass} ${
                            override.decision === 'include'
                              ? 'bg-emerald-500/15 text-emerald-400'
                              : 'bg-red-500/15 text-red-400'
                          }`}
                        >
                          {t(
                            override.decision === 'include'
                              ? 'references.screening.overrideInclude'
                              : 'references.screening.overrideExclude'
                          )}
                        </span>
                        <span className="text-[10px] text-[var(--foreground)]">
                          {t('references.screening.overrideReason')}: {override.reason}
                        </span>
                        <span className="text-[10px] text-[var(--muted-foreground)]">
                          {t('references.screening.overrideBy', {
                            actor: override.actor,
                            date: when(override.createdAt)
                          })}
                        </span>
                        <button
                          type="button"
                          className={ghostClass}
                          disabled={busy}
                          onClick={() => void handleClearOverride(item.referenceId)}
                        >
                          {t('references.screening.clearOverride')}
                        </button>
                      </div>
                    ) : null}

                    {item.evidence.length > 0 ? (
                      <ul className="mt-1 flex flex-col gap-0.5">
                        {item.evidence.map((citation, index) => (
                          <li
                            key={`${citation.criterionId}-${index}`}
                            className="text-[10px] text-[var(--muted-foreground)]"
                          >
                            {t('references.screening.evidenceQuoted', {
                              criterion: citation.criterionId,
                              quote: citation.quote
                            })}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">
                        {t('references.screening.noEvidence')}
                      </p>
                    )}

                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <input
                        value={overrideReasons[item.referenceId] ?? ''}
                        onChange={(event) =>
                          setOverrideReasons((current) => ({
                            ...current,
                            [item.referenceId]: event.target.value
                          }))
                        }
                        aria-label={t('references.screening.overrideReasonPlaceholder')}
                        placeholder={t('references.screening.overrideReasonPlaceholder')}
                        className={`${inputClass} w-56`}
                      />
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={busy}
                        onClick={() => void handleOverride(item.referenceId, 'include')}
                      >
                        {t('references.screening.overrideInclude')}
                      </button>
                      <button
                        type="button"
                        className={ghostClass}
                        disabled={busy}
                        onClick={() => void handleOverride(item.referenceId, 'exclude')}
                      >
                        {t('references.screening.overrideExclude')}
                      </button>
                      <span className="text-[10px] text-[var(--muted-foreground)]">
                        {t('references.screening.evidence')} ·{' '}
                        {t('references.screening.ruleRevision', {
                          revision: rule?.revision ?? 0
                        })}
                      </span>
                    </div>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
        {shown.length === 0 ? (
          <p className="py-6 text-center text-xs text-[var(--muted-foreground)]">
            {t('references.screening.noSelection')}
          </p>
        ) : null}
      </div>
    </div>
  )
}
