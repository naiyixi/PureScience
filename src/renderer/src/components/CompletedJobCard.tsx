import { Zap, ChevronRight } from 'lucide-react'

import { useLanguage } from '@/i18n'
import type { ComputeJobStatus, JobSummary } from '../../../shared/compute'
import { jobStatusLabel } from './job-status-label'

// CompletedJobCard appears in the conversation timeline as an independent card.
// Used when a job's job_id was NOT found in any tool-call rawOutput
// (fallback: placed at createdAt position in the timeline).
// Also shown for completed jobs (success/failed/timeout/error).
// Design: design.md §5b — rounded card, green for finished, red for failed/error/timeout.

type CompletedJobCardProps = {
  job: JobSummary
  onOpen: (job: JobSummary) => void
}

// Colour only — the status WORD comes from job-status-label.ts so the card says 已完成 on a Chinese
// interface instead of the English literal it used to hard-code here.
const STATUS_COLOR_CLASS: Record<ComputeJobStatus, string> = {
  queued: 'text-muted-foreground',
  submitted: 'text-muted-foreground',
  running: 'text-amber-600 dark:text-amber-400',
  success: 'text-green-600 dark:text-green-400',
  failed: 'text-red-600 dark:text-red-400',
  timeout: 'text-red-600 dark:text-red-400',
  error: 'text-red-600 dark:text-red-400',
  // Stopped by the reader: neutral, same reasoning as the badge.
  cancelled: 'text-muted-foreground'
}

export function CompletedJobCard({ job, onOpen }: CompletedJobCardProps): React.JSX.Element {
  const { t } = useLanguage()
  const colorClass = STATUS_COLOR_CLASS[job.status] ?? STATUS_COLOR_CLASS.queued
  const statusLabel = jobStatusLabel(job.status, t)

  const intentDisplay = job.intent.length > 70 ? `${job.intent.slice(0, 67)}…` : job.intent

  return (
    <button
      type="button"
      data-testid="completed-job-card"
      className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-muted/30 px-3.5 py-2.5 text-left text-[12px] hover:bg-muted/50 transition-colors"
      onClick={() => onOpen(job)}
      aria-label={t('aria.completedRemoteJob').replace('{name}', job.intent)}
    >
      <Zap size={13} className={colorClass} aria-hidden="true" style={{ flexShrink: 0 }} />
      <span className="text-[11px] text-muted-foreground shrink-0">{job.display_name}</span>
      <span className="flex-1 min-w-0 truncate text-secondary-foreground">{intentDisplay}</span>
      <span className={`text-[11px] shrink-0 ${colorClass}`}>— {statusLabel}</span>
      <ChevronRight size={12} className="text-muted-foreground shrink-0" aria-hidden="true" />
    </button>
  )
}
