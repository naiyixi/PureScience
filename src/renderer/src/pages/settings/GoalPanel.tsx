/* Hallmark · pre-emit critique: P4 H4 E4 S4 R4 V4 */
import { useCallback, useEffect, useState } from 'react'
import { Flag, RefreshCw, TriangleAlert } from 'lucide-react'

import { useLanguage } from '@/i18n'
import { Button } from '@/components/ui/button'
import type { Goal, GoalOverview } from '../../../../shared/goal'

// The goals a session is pursuing, and — the part that matters — what the app's OWN readings have proved
// about them. Read-only by design: a goal belongs to a session, progress only moves on a reading the app
// re-resolves, and neither is something a settings form can supply, so the agent-facing goal_configure /
// goal_advance tools are the only writers. A criterion with no reading is shown as unmet, never as done:
// "no evidence" must not read as "satisfied" on screen either.
export const GoalPanel = (): React.JSX.Element => {
  const { t } = useLanguage()
  const [overview, setOverview] = useState<GoalOverview>({ goals: [], unreadableSessionIds: [] })
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.goals.listAll()
      setOverview(next)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() awaits before any setState (fetch-on-mount); no cascading renders
    void load()
  }, [load])

  const shortFingerprint = (fingerprint: string): string =>
    fingerprint.length > 12 ? `${fingerprint.slice(0, 12)}…` : fingerprint

  const renderCriterion = (goal: Goal, index: number): React.JSX.Element => {
    const criterion = goal.acceptance[index]
    if (!criterion) return <li key={index} />
    return (
      <li key={criterion.id} className="flex flex-col gap-1">
        <span className="text-sm">{criterion.text}</span>
        {criterion.metBy ? (
          <span className="font-mono text-xs text-muted-foreground">
            {t('settings.goalsMetBy')} {criterion.metBy.kind} {criterion.metBy.id}{' '}
            {shortFingerprint(criterion.metBy.fingerprint)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{t('settings.goalsUnmet')}</span>
        )}
      </li>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Flag className="size-4 text-muted-foreground" aria-hidden />
            <h2 className="text-base font-medium">{t('settings.goalsTitle')}</h2>
          </div>
          <p className="text-sm text-muted-foreground">{t('settings.goalsDesc')}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('settings.goalsRefresh')}
          onClick={() => void load()}
        >
          <RefreshCw className="size-4" aria-hidden />
        </Button>
      </div>

      {error ? (
        <p className="text-sm text-destructive">
          {t('settings.goalsLoadFailed')} {error}
        </p>
      ) : null}

      {overview.unreadableSessionIds.length > 0 ? (
        <p className="flex items-start gap-2 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {t('settings.goalsUnreadable')} {overview.unreadableSessionIds.join(', ')}
          </span>
        </p>
      ) : null}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('settings.goalsLoading')}</p>
      ) : overview.goals.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('settings.goalsEmpty')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {overview.goals.map((goal) => (
            <li key={goal.id} className="flex flex-col gap-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{goal.objective}</span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {goal.state}
                </span>
              </div>
              <span className="font-mono text-xs text-muted-foreground">
                {t('settings.goalsSession')} {goal.sessionId}
              </span>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('settings.goalsAcceptance')}
                </span>
                <ul className="flex flex-col gap-1.5">
                  {goal.acceptance.map((_criterion, index) => renderCriterion(goal, index))}
                </ul>
              </div>
              <span className="text-xs text-muted-foreground">
                {t('settings.goalsMilestones')} {goal.milestones.length}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
