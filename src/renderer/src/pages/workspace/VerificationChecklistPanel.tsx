// VerificationChecklistPanel: the session-level verification checklist — every warn/fail claim
// raised by ANY review of the session, aggregated into one stable list. Each claim shows its
// latest verdict + evidence, how many times the fix loop re-assessed it (reflag), and a
// "Mark addressed" / "Reopen" action the user can take without leaving the panel.
//
// This is the PureScience equivalent of the reference product's session_claims +
// verification_checks loop projected onto the existing Finding rows: one warn/fail Finding is the
// stable identity of one claim (the reviewer model mutates it in place across fix-loop rounds), so
// no duplicated store is needed — the checklist is a read-side aggregation over Review + Finding +
// disposition rows.

import { useEffect } from 'react'
import { AlertTriangle, CheckCircle2, RotateCcw, ShieldCheck, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLanguage } from '@/i18n'

import type {
  VerificationChecklist,
  VerificationChecklistItem,
  FindingResolution
} from '../../../../shared/reviewer'
import { useReviewStore } from '@/stores/review-store'

type VerificationChecklistPanelProps = {
  projectId: string
  sessionId: string
  // Called when the user clicks "Go to transcript" on a claim (same intent shape as the reviewer card).
  onGoToTranscript?: (checkId: string) => void
}

// Icon for a claim's latest verdict.
const VerdictIcon = ({
  status
}: {
  status: VerificationChecklistItem['latestStatus']
}): React.JSX.Element => {
  if (status === 'fail')
    return (
      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
    )
  if (status === 'warn')
    return <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-yellow-500" aria-hidden />
  return (
    <CheckCircle2
      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400"
      aria-hidden
    />
  )
}

const RESOLUTION_LABELS: Record<FindingResolution, string> = {
  open: 'open',
  resolved: 'resolved',
  unaddressed: 'unaddressed'
}

// One claim row in the checklist.
const ClaimRow = ({
  item,
  onMarkAddressed,
  onReopen,
  onGoToTranscript
}: {
  item: VerificationChecklistItem
  onMarkAddressed: (item: VerificationChecklistItem) => void
  onReopen: (item: VerificationChecklistItem) => void
  onGoToTranscript?: (checkId: string) => void
}): React.JSX.Element => {
  const isResolved = item.resolution === 'resolved'
  const badgeStyles: Record<string, string> = {
    fail: 'bg-red-50 border-red-200 text-red-700 dark:bg-red-950/20 dark:border-red-800/50 dark:text-red-300',
    warn: 'bg-yellow-50 border-yellow-200 text-yellow-700 dark:bg-yellow-950/20 dark:border-yellow-800/50 dark:text-yellow-300',
    pass: 'bg-green-50 border-green-200 text-green-700 dark:bg-green-950/20 dark:border-green-800/50 dark:text-green-300'
  }

  return (
    <div
      className={cn(
        'rounded-lg border p-3 transition-colors',
        isResolved ? 'border-border-200 bg-bg-000 opacity-70' : 'border-border-200 bg-bg-000'
      )}
      data-testid="checklist-claim"
      data-finding-id={item.rootFindingId}
      data-resolution={item.resolution}
    >
      {/* Verdict badge + claim text */}
      <div className="flex items-start gap-2">
        <VerdictIcon status={item.latestStatus} />
        <span
          className={cn(
            'mt-0.5 shrink-0 rounded border px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
            badgeStyles[item.latestStatus] ?? ''
          )}
        >
          {item.latestStatus}
        </span>
        <p className="flex-1 text-xs font-medium leading-snug text-text-000">{item.claim}</p>
      </div>

      {/* Evidence */}
      <p className="mt-2 text-xs leading-relaxed text-text-300">{item.latestEvidence}</p>

      {/* Meta row: resolution pill, reflag count, assessment count, transcript link */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-text-400">
        <span
          className={cn(
            'rounded px-1 py-0.5 font-medium',
            isResolved
              ? 'bg-green-50 text-green-700 dark:bg-green-950/20 dark:text-green-300'
              : 'bg-bg-200 text-text-300'
          )}
          data-testid="checklist-resolution"
        >
          {RESOLUTION_LABELS[item.resolution]}
        </span>
        {item.reflagCount > 0 && (
          <span data-testid="checklist-reflag" className="text-text-400">
            re-flagged ×{item.reflagCount}
          </span>
        )}
        <span>assessed ×{item.assessmentCount}</span>
        {onGoToTranscript && (
          <button
            type="button"
            className="ml-auto font-medium text-text-400 transition-colors hover:text-text-300"
            onClick={() => onGoToTranscript(item.rootFindingId)}
            data-testid="checklist-go-transcript"
          >
            Go to transcript
          </button>
        )}
      </div>

      {/* Resolution actions */}
      <div className="mt-2 flex items-center gap-2 border-t border-border-200 pt-2">
        {isResolved ? (
          <button
            type="button"
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-text-400 transition-colors hover:bg-bg-200 hover:text-text-300"
            onClick={() => onReopen(item)}
            data-testid="checklist-reopen"
          >
            <RotateCcw className="h-3 w-3" aria-hidden />
            Reopen
          </button>
        ) : (
          <button
            type="button"
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-green-700 transition-colors hover:bg-green-50 dark:text-green-300 dark:hover:bg-green-950/20"
            onClick={() => onMarkAddressed(item)}
            data-testid="checklist-mark-addressed"
          >
            <ShieldCheck className="h-3 w-3" aria-hidden />
            Mark addressed
          </button>
        )}
      </div>
    </div>
  )
}

// The checklist panel: loads once per project+session and renders every aggregated claim.
const VerificationChecklistPanel = ({
  projectId,
  sessionId,
  onGoToTranscript
}: VerificationChecklistPanelProps): React.JSX.Element => {
  const { t } = useLanguage()
  const checklist: VerificationChecklist = useReviewStore((state) =>
    state.getChecklist(sessionId, projectId)
  )
  const loadChecklist = useReviewStore((state) => state.loadChecklist)
  const mutateChecklist = useReviewStore((state) => state.mutateChecklist)

  useEffect(() => {
    void loadChecklist(sessionId, projectId)
  }, [sessionId, projectId, loadChecklist])

  const items = checklist.items ?? []

  const handleMarkAddressed = (item: VerificationChecklistItem): void => {
    void mutateChecklist({
      projectId,
      appSessionId: sessionId,
      rootFindingId: item.rootFindingId,
      resolution: 'resolved'
    })
  }

  const handleReopen = (item: VerificationChecklistItem): void => {
    void mutateChecklist({
      projectId,
      appSessionId: sessionId,
      rootFindingId: item.rootFindingId,
      resolution: 'open'
    })
  }

  const openCount = items.filter((item) => item.resolution !== 'resolved').length

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-border-200 px-4 py-3">
        <h2 className="text-[13px] font-semibold text-text-000">Verification checklist</h2>
        <p className="mt-0.5 text-[11px] text-text-300">
          {openCount} open of {items.length} claims
        </p>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {items.length === 0 ? (
          <p className="text-xs text-text-400" data-testid="checklist-empty">
            {t('ui.nochecksrecorded')}
          </p>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <ClaimRow
                key={item.rootFindingId}
                item={item}
                onMarkAddressed={handleMarkAddressed}
                onReopen={handleReopen}
                onGoToTranscript={onGoToTranscript}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export { VerificationChecklistPanel }
