import { useEffect, useState } from 'react'
import { Zap } from 'lucide-react'

import type { JobSummary } from '../../../shared/compute'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useLanguage } from '@/i18n'
import { useSessionJobStore } from '@/stores/session-job-store'
import { formatDuration, jobElapsedMs } from './remote-job-badge-utils'

// Badge props — sessionId is used to scope the running job list to the active session.
type RemoteJobBadgeProps = {
  sessionId: string
  onOpenJobList?: () => void
}

// Amber capsule badge placed on the notebook bar right side (design.md §4).
// Shows running count + elapsed time when jobs are running; shows gray "N jobs" when all finished.
// Hidden only when session has no jobs at all.
// Hover reveals a tooltip listing each running job's host + intent + duration.
export const RemoteJobBadge = ({
  sessionId,
  onOpenJobList
}: RemoteJobBadgeProps): React.JSX.Element | null => {
  const { t } = useLanguage()
  const allJobsForSession = useSessionJobStore((state) => state.allJobsForSession)
  const hydratedSessionId = useSessionJobStore((state) => state.hydratedSessionId)
  const hydrate = useSessionJobStore((state) => state.hydrate)
  const [now, setNow] = useState(() => Date.now())

  // The store is fed by broadcasts and one initial fetch per session. Hydrating here too means the
  // badge can never render "no badge" for a session whose jobs were never fetched: without it, the
  // unknown state and the empty state were the same absence, so a session with running jobs looked
  // exactly like a session with none.
  useEffect(() => {
    if (hydratedSessionId === sessionId) return
    if (typeof window.api?.compute?.jobsList !== 'function') return
    void hydrate(sessionId)
  }, [hydrate, hydratedSessionId, sessionId])

  // Tick every second to keep elapsed times fresh.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const allJobs = allJobsForSession(sessionId)

  // Count active jobs (running + submitted) for display
  const activeJobs = allJobs.filter((j) => j.status === 'running' || j.status === 'submitted')

  // Absence means "this session has no jobs": the effect above reads the feed as soon as the
  // badge mounts, so the store can no longer stay un-hydrated while jobs exist elsewhere.
  if (allJobs.length === 0) return null

  const isActive = activeJobs.length > 0

  if (isActive) {
    // Active state: amber badge with "N running · elapsed"
    const oldest = activeJobs.reduce<JobSummary>((a, b) => {
      const aStart = a.started_at ?? a.created_at
      const bStart = b.started_at ?? b.created_at
      return aStart <= bStart ? a : b
    }, activeJobs[0]!)

    const elapsedMs = jobElapsedMs(oldest, now)
    const elapsedStr = formatDuration(elapsedMs)

    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onOpenJobList}
              style={{
                background: 'color-mix(in srgb, var(--session-waiting) 10%, transparent)',
                border: '1px solid color-mix(in srgb, var(--session-waiting) 25%, transparent)',
                color: 'var(--session-waiting)',
                borderRadius: '12px',
                padding: '3px 10px',
                fontSize: '11.5px',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                cursor: onOpenJobList ? 'pointer' : 'default'
              }}
              aria-label={t('jobs.runningAria').replace('{count}', String(activeJobs.length))}
            >
              <Zap size={11} />
              <span>
                {t('jobs.running')
                  .replace('{count}', String(activeJobs.length))
                  .replace('{elapsed}', elapsedStr)}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" align="end" className="p-0 overflow-hidden max-w-sm">
            <div className="px-2 py-1.5">
              <p className="text-[10px] font-medium uppercase tracking-wider opacity-60 mb-1.5">
                {t('jobs.tooltipHeader').replace('{count}', String(activeJobs.length))}
              </p>
              {activeJobs.map((job) => (
                <div key={job.job_id} className="flex items-center gap-2 py-0.5">
                  <Zap size={10} style={{ color: 'var(--session-waiting)', flexShrink: 0 }} />
                  <span className="text-[11px] opacity-70 shrink-0">{job.display_name}</span>
                  <span className="text-[11px] flex-1 truncate">{job.intent}</span>
                  <span className="text-[11px] opacity-60 shrink-0 ml-1">
                    {formatDuration(jobElapsedMs(job, now))}
                  </span>
                </div>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  // Idle state: gray badge with "N jobs"
  return (
    <button
      type="button"
      onClick={onOpenJobList}
      style={{
        background: 'var(--bg-200)',
        border: '1px solid var(--border-200)',
        color: 'var(--text-100)',
        borderRadius: '12px',
        padding: '3px 10px',
        fontSize: '11.5px',
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        cursor: onOpenJobList ? 'pointer' : 'default'
      }}
      aria-label={t('jobs.allAria').replace('{count}', String(allJobs.length))}
    >
      <Zap size={11} />
      <span>{t('jobs.all').replace('{count}', String(allJobs.length))}</span>
    </button>
  )
}
