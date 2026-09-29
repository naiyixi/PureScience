import { useLanguage, type TranslationKey } from '@/i18n'
import type {
  ScreeningEvidenceCoverage,
  ScreeningVerdict
} from '../../../../shared/references-screening'
import {
  screeningUnprocessedBreakdown,
  type ScreeningCoverageChecklist,
  type ScreeningSearchedScope
} from '../../../../shared/references-screening-coverage'

// The coverage checklist (S5). Everything it prints comes from `buildScreeningCoverageChecklist`, which
// derives it from the collection's own screening lines — this component decides only how it reads.
//
// Why it exists at all: the plan makes 每篇恰属其一 and 未处理量显式 acceptance criteria, and neither is
// checkable from an aggregate. So the four tiers are laid out as four MEMBERSHIP lists (not four
// numbers), the four counts are printed beside them, the reconciliation line states whether they add up
// to the candidate count, and the unprocessed records are named one by one. A reader — or an acceptance
// run — can then re-count the rows and get the same answer the panel claims, instead of taking a total
// on faith.

const COVERAGE_LABEL: Record<ScreeningEvidenceCoverage, TranslationKey> = {
  'full-text': 'references.screening.coverage.full-text',
  'abstract-only': 'references.screening.coverage.abstract-only',
  'metadata-only': 'references.screening.coverage.metadata-only',
  unavailable: 'references.screening.coverage.unavailable'
}

const VERDICT_LABEL: Record<ScreeningVerdict, TranslationKey> = {
  included: 'references.screening.verdict.included',
  'needs-review': 'references.screening.verdict.needs-review',
  excluded: 'references.screening.verdict.excluded',
  'not-evaluated': 'references.screening.verdict.not-evaluated'
}

// The one scope this build can honestly claim. Mapped rather than inlined so the day a real retrieval
// count exists, the label changes in one place.
const SCOPE_LABEL: Record<ScreeningSearchedScope, TranslationKey> = {
  'collection-members': 'references.screening.coverageList.scope.collectionMembers'
}

export function ReferencesScreeningCoverageList({
  checklist,
  titleOf
}: {
  checklist: ScreeningCoverageChecklist
  titleOf: (referenceId: string) => string
}): React.JSX.Element {
  const { t } = useLanguage()
  const chipClass = 'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium'

  // The unprocessed records, each still carrying the tier it would be decided on — so "what is left"
  // and "on how much evidence" are answered by one list rather than two panels.
  const unprocessed = checklist.groups.flatMap((group) =>
    group.items
      .filter((entry) => entry.unprocessed)
      .map((entry) => ({ referenceId: entry.referenceId, coverage: group.coverage }))
  )

  return (
    <div
      className="mt-2 flex flex-col gap-1 rounded-lg border border-[var(--border)] p-2"
      data-testid="screening-coverage-list"
      data-scope={checklist.searchedScope}
      data-searched={checklist.searchedCount}
      data-candidate={checklist.candidateCount}
      data-classified={checklist.classifiedCount}
      data-unprocessed={checklist.unprocessedCount}
      data-reconciled={checklist.reconciled ? 'true' : 'false'}
      data-within-searched={checklist.withinSearched ? 'true' : 'false'}
    >
      <p
        className="text-[11px] font-medium text-[var(--foreground)]"
        data-testid="screening-coverage-title"
      >
        {t('references.screening.coverageList.title')}
      </p>

      {/* Both totals, always together: a surface showing one of them could not be checked at all. */}
      <p
        className="text-[10px] text-[var(--muted-foreground)]"
        data-testid="screening-coverage-reconcile"
      >
        {t('references.screening.coverageList.reconcile', {
          searched: checklist.searchedCount,
          scope: t(SCOPE_LABEL[checklist.searchedScope]),
          candidate: checklist.candidateCount,
          classified: checklist.classifiedCount
        })}
      </p>
      <p
        className="text-[10px] text-[var(--muted-foreground)]"
        data-testid="screening-coverage-scope-note"
      >
        {t('references.screening.coverageList.scopeNote')}
      </p>
      <p
        className="text-[10px] text-[var(--muted-foreground)]"
        data-testid="screening-coverage-tier-rule"
      >
        {t('references.screening.coverageList.tierRule')}
      </p>
      <p
        className={`text-[10px] ${
          checklist.reconciled ? 'text-[var(--muted-foreground)]' : 'text-amber-400'
        }`}
        data-testid="screening-coverage-reconciliation"
      >
        {checklist.reconciled
          ? t('references.screening.coverageList.reconciled', {
              classified: checklist.classifiedCount
            })
          : t('references.screening.coverageList.notReconciled', {
              classified: checklist.classifiedCount,
              candidate: checklist.candidateCount
            })}
      </p>

      <ul className="flex flex-col gap-1">
        {checklist.groups.map((group) => (
          <li
            key={group.coverage}
            className="rounded border border-[var(--border)] px-2 py-1"
            data-testid="screening-coverage-group"
            data-coverage={group.coverage}
            data-count={group.count}
          >
            <p className="flex flex-wrap items-center gap-1 text-[10px]">
              <span className={`${chipClass} bg-[var(--border)] text-[var(--muted-foreground)]`}>
                {t(COVERAGE_LABEL[group.coverage])}
              </span>
              <span
                className="font-medium text-[var(--foreground)]"
                data-testid="screening-coverage-group-count"
              >
                {t('references.screening.coverageList.counted', {
                  label: t(COVERAGE_LABEL[group.coverage]),
                  count: group.count
                })}
              </span>
            </p>
            {group.items.length === 0 ? (
              <p
                className="mt-0.5 text-[10px] text-[var(--muted-foreground)]"
                data-testid="screening-coverage-group-empty"
              >
                {t('references.screening.coverageList.groupEmpty')}
              </p>
            ) : (
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {group.items.map((entry) => (
                  <li
                    key={entry.referenceId}
                    className="flex flex-wrap items-center gap-1 text-[10px]"
                    data-testid="screening-coverage-item"
                    data-reference-id={entry.referenceId}
                    data-coverage={group.coverage}
                    data-verdict={entry.verdict}
                    data-unprocessed={entry.unprocessed ? 'true' : 'false'}
                  >
                    <span className="text-[var(--foreground)]">{titleOf(entry.referenceId)}</span>
                    <span
                      className={`${chipClass} bg-[var(--border)] text-[var(--muted-foreground)]`}
                    >
                      {t(VERDICT_LABEL[entry.verdict])}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      {/* 未处理量显式: the number AND the names. Zero is printed too, so "nothing is left" is a stated
          fact rather than an empty space a reader has to interpret. */}
      <div
        className="rounded border border-[var(--border)] px-2 py-1"
        data-testid="screening-coverage-unprocessed"
        data-unprocessed-count={checklist.unprocessedCount}
      >
        <p
          className="text-[10px] text-[var(--foreground)]"
          data-testid="screening-coverage-unprocessed-line"
        >
          {t('references.screening.coverageList.unprocessed', {
            unprocessed: checklist.unprocessedCount
          })}
        </p>
        {unprocessed.length === 0 ? null : (
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {unprocessed.map((entry) => (
              <li
                key={entry.referenceId}
                className="flex flex-wrap items-center gap-1 text-[10px]"
                data-testid="screening-coverage-unprocessed-item"
                data-reference-id={entry.referenceId}
                data-coverage={entry.coverage}
              >
                <span className="text-[var(--foreground)]">{titleOf(entry.referenceId)}</span>
                <span className={`${chipClass} bg-[var(--border)] text-[var(--muted-foreground)]`}>
                  {t(COVERAGE_LABEL[entry.coverage])}
                </span>
              </li>
            ))}
          </ul>
        )}
        {unprocessed.length === 0 ? null : (
          <p
            className="mt-0.5 text-[10px] text-[var(--muted-foreground)]"
            data-testid="screening-coverage-unprocessed-tiers"
          >
            {screeningUnprocessedBreakdown(checklist)
              .map((entry) =>
                t('references.screening.coverageList.counted', {
                  label: t(COVERAGE_LABEL[entry.coverage]),
                  count: entry.count
                })
              )
              .join(' · ')}
          </p>
        )}
      </div>

      {/* A corpus that does not add up is shown as failing its own check — never as a total that quietly
          means nothing. */}
      {checklist.violations.length > 0 ? (
        <div
          className="rounded border border-amber-500/40 px-2 py-1"
          data-testid="screening-coverage-violations"
        >
          <p className="text-[10px] text-amber-400">
            {t('references.screening.coverageList.violations', {
              issues: checklist.violations.join(' · ')
            })}
          </p>
        </div>
      ) : null}
    </div>
  )
}
