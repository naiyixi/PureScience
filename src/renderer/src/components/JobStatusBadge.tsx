import type { ComputeJobStatus } from '../../../shared/compute'
import { useLanguage } from '@/i18n'
import { jobStatusLabel } from './job-status-label'

// Maps job status to badge styling. Follows design.md §6 badge pattern (same conventions as ReviewCard).
// Terminal statuses consolidate under semantic groups: success=Done, error/failed/timeout=Failed, and
// cancelled stays its own neutral group (the user stopped it; calling that a failure would be wrong).
//
// Only colours live here. The word itself comes from `job-status-label.ts`, because a badge that spelled
// its own English label meant the detail header read "DONE" on a Chinese interface.
const STATUS_CLASS_NAME: Record<ComputeJobStatus, string> = {
  queued:
    'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-950/40 dark:text-slate-400 dark:border-slate-800/50',
  submitted:
    'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-950/40 dark:text-slate-400 dark:border-slate-800/50',
  running:
    'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/20 dark:text-amber-300 dark:border-amber-800/50',
  success:
    'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/20 dark:text-green-300 dark:border-green-800/50',
  failed:
    'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/20 dark:text-red-300 dark:border-red-800/50',
  timeout:
    'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/20 dark:text-red-300 dark:border-red-800/50',
  error:
    'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/20 dark:text-red-300 dark:border-red-800/50',
  // A user-initiated stop is neither a success nor a failure: neutral, like the queued states.
  cancelled:
    'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-950/40 dark:text-slate-400 dark:border-slate-800/50'
}

type JobStatusBadgeProps = {
  status: ComputeJobStatus
}

// Status badge for job detail modal header (top-right). Follows design.md §6 color table.
export function JobStatusBadge({ status }: JobStatusBadgeProps): React.JSX.Element {
  const { t } = useLanguage()
  const className = STATUS_CLASS_NAME[status] ?? STATUS_CLASS_NAME.queued
  return (
    <span
      data-testid="job-status-badge"
      className={`inline-flex items-center rounded border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ${className}`}
    >
      {jobStatusLabel(status, t)}
    </span>
  )
}
