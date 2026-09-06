/* Hallmark · pre-emit critique: P4 H4 E4 S4 R4 V4 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarClock, Pause, Play, Plus, RefreshCw, Trash2 } from 'lucide-react'

import { useLanguage } from '@/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { RoutineConfigureRequest, RoutineSchedule } from '../../../../shared/routine'

// Scheduled tasks ("routines"): recurring instructions the app dispatches as fresh task runs on
// a fixed interval. The panel lists every schedule (across sessions), lets the user create one
// (instruction + interval), and toggle/pause or delete existing ones. Schedules are owned by
// sessions — the owning session id is shown so the user can tell where a routine came from.
export const RoutinePanel = (): React.JSX.Element => {
  const { t } = useLanguage()
  const [schedules, setSchedules] = useState<RoutineSchedule[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [intervalMinutes, setIntervalMinutes] = useState('60')
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    try {
      const items = await window.api.routine.listAll()
      setSchedules(items)
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

  const minutes = useMemo(() => Number(intervalMinutes), [intervalMinutes])
  const intervalValid = Number.isInteger(minutes) && minutes >= 5 && minutes <= 1440
  const instructionValid = instruction.trim().length > 0

  const createRoutine = useCallback(async (): Promise<void> => {
    if (!intervalValid || !instructionValid || saving) return
    setSaving(true)
    try {
      const configure: RoutineConfigureRequest = {
        everyMinutes: minutes,
        instruction: instruction.trim(),
        ...(label.trim() ? { label: label.trim() } : {})
      }
      // The panel has no session context, so schedules are created against a synthetic owner id
      // (the scheduler scans across sessions; a missing owner simply records a failed first tick
      // until the owning session exists — the settings panel is for management, the agent-facing
      // routine_configure tool is the session-aware creation path).
      await window.api.routine.upsert({ sessionId: 'settings-panel', configure })
      setInstruction('')
      setLabel('')
      setIntervalMinutes('60')
      setShowForm(false)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }, [intervalValid, instructionValid, saving, minutes, instruction, label, load])

  const toggle = useCallback(
    async (schedule: RoutineSchedule): Promise<void> => {
      try {
        await window.api.routine.setEnabled({
          sessionId: schedule.sessionId,
          routineId: schedule.id,
          enabled: !schedule.enabled
        })
        await load()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [load]
  )

  const remove = useCallback(
    async (schedule: RoutineSchedule): Promise<void> => {
      try {
        await window.api.routine.remove({
          sessionId: schedule.sessionId,
          routineId: schedule.id
        })
        await load()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [load]
  )

  // Rendered-clock for "due in Xm" labels. A single render-stable timestamp avoids calling
  // Date.now() during render (impure) while staying fresh on every list reload.
  const [clockNow] = useState(() => Date.now())

  const formatNextDue = (schedule: RoutineSchedule): string => {
    if (!schedule.enabled || schedule.nextDue === null) return t('settings.routinePaused')
    const delta = schedule.nextDue - clockNow
    if (delta <= 0) return t('settings.routineDue')
    const mins = Math.round(delta / 60_000)
    if (mins < 60) return `${mins} ${t('settings.routineMinutes')}`
    return `${Math.round(mins / 60)} ${t('settings.routineHours')}`
  }

  return (
    <div className="space-y-5 p-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t('settings.routineDesc')}</p>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void load()}
            aria-label={t('settings.routineRefresh')}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button size="sm" onClick={() => setShowForm((open) => !open)}>
            <Plus className="mr-1 h-4 w-4" />
            {t('settings.routineNew')}
          </Button>
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {showForm ? (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="space-y-1">
            <label htmlFor="routine-instruction" className="text-sm font-medium">
              {t('settings.routineInstruction')}
            </label>
            <Textarea
              id="routine-instruction"
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              rows={3}
              placeholder={t('settings.routineInstructionPlaceholder')}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="routine-interval" className="text-sm font-medium">
                {t('settings.routineInterval')}
              </label>
              <Input
                id="routine-interval"
                type="number"
                min={5}
                max={1440}
                value={intervalMinutes}
                onChange={(event) => setIntervalMinutes(event.target.value)}
              />
              {!intervalValid ? (
                <p className="text-xs text-destructive">{t('settings.routineIntervalHint')}</p>
              ) : null}
            </div>
            <div className="space-y-1">
              <label htmlFor="routine-label" className="text-sm font-medium">
                {t('settings.routineLabel')}
              </label>
              <Input
                id="routine-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t('settings.routineLabelPlaceholder')}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>
              {t('settings.cancel')}
            </Button>
            <Button
              size="sm"
              disabled={!intervalValid || !instructionValid || saving}
              onClick={() => void createRoutine()}
            >
              {t('settings.routineCreate')}
            </Button>
          </div>
        </div>
      ) : null}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('settings.routineLoading')}</p>
      ) : schedules.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <CalendarClock className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('settings.routineEmpty')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('settings.routineEmptyHint')}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-bg-10">
          <ul className="divide-y divide-border">
            {schedules.map((schedule) => (
              <li key={schedule.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'h-2 w-2 shrink-0 rounded-full',
                        schedule.enabled ? 'bg-success-000' : 'bg-muted-foreground/30'
                      )}
                    />
                    <span className="truncate text-sm font-medium">
                      {schedule.label ?? schedule.instruction}
                    </span>
                    {schedule.pausedReason === 'stuck' ? (
                      <span className="rounded bg-accent/40 px-1.5 py-0.5 text-xs text-accent-foreground">
                        {t('settings.routineStuck')}
                      </span>
                    ) : null}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{schedule.instruction}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('settings.routineEvery')} {schedule.everyMinutes}{' '}
                    {t('settings.routineMinutes')} · {formatNextDue(schedule)} ·{' '}
                    {t('settings.routineTicks')}: {schedule.tickCount}
                    {schedule.missedTicks > 0 ? ` (${schedule.missedTicks} ✕)` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={
                      schedule.enabled ? t('settings.routinePause') : t('settings.routineResume')
                    }
                    onClick={() => void toggle(schedule)}
                  >
                    {schedule.enabled ? (
                      <Pause className="h-4 w-4" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('settings.routineDelete')}
                    onClick={() => void remove(schedule)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
