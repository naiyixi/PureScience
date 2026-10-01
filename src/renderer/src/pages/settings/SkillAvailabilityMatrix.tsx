import { useLanguage, type TranslationKey } from '@/i18n'
import { useCallback, useEffect, useState } from 'react'

import type {
  SkillAvailabilityCommandResult,
  SkillAvailabilityView
} from '../../../../shared/skill-availability'
import { cn } from '@/lib/utils'

// Target ids come from the contract; the labels are the reader's name for them.
const TARGET_NAME_KEYS: Record<string, TranslationKey> = {
  'claude-code': 'settings.skillAvailabilityTargetClaudeCode',
  codex: 'settings.skillAvailabilityTargetCodex',
  opencode: 'settings.skillAvailabilityTargetOpencode'
}

/**
 * Which skills each reader may load.
 *
 * A row per reader, a switch per skill. Two states are shown as locked rather than hidden, because a user who
 * cannot tell "off for this reader" from "off for everyone" will not trust either: a globally disabled skill
 * cannot be handed back here, and an always-on skill cannot be taken away from any reader.
 */
export const SkillAvailabilityMatrix = (): React.JSX.Element => {
  const { t } = useLanguage()
  const [view, setView] = useState<SkillAvailabilityView>()
  const [failed, setFailed] = useState(false)
  const [savingTarget, setSavingTarget] = useState<string>()

  const apply = useCallback((result: SkillAvailabilityCommandResult): void => {
    setView(result.view)
    setFailed(false)
  }, [])

  const load = useCallback(async (): Promise<void> => {
    const client = window.api?.settings?.skillAvailability
    if (!client) throw new Error('unavailable')
    apply(await client({ action: 'get' }))
  }, [apply])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await load()
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [load])

  const toggle = async (targetId: string, skillId: string, withheld: boolean): Promise<void> => {
    const client = window.api?.settings?.skillAvailability
    if (!client || !view) return
    const current = view.targets.find((target) => target.id === targetId)?.skillIds ?? []
    const next = withheld
      ? [...new Set([...current, skillId])]
      : current.filter((id) => id !== skillId)
    setSavingTarget(targetId)
    try {
      apply(await client({ action: 'set', targetId, disabledSkillIds: next }))
    } catch {
      setFailed(true)
    } finally {
      setSavingTarget(undefined)
    }
  }

  if (failed && !view) {
    return (
      <section className="mt-6 border-t border-border pt-4" data-testid="skill-availability">
        <p className="text-xs text-muted-foreground">
          {t('settings.skillAvailabilityUnavailable')}
        </p>
      </section>
    )
  }

  return (
    <section className="mt-6 border-t border-border pt-4" data-testid="skill-availability">
      <h2 className="mb-1 text-sm font-semibold text-foreground">
        {t('settings.skillAvailability')}
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">{t('settings.skillAvailabilityHint')}</p>
      {view
        ? view.targets.map((target) => (
            <div
              key={target.id}
              className="mb-4"
              data-testid={`skill-availability-target-${target.id}`}
            >
              <p className="mb-1 text-xs font-medium text-foreground">
                {TARGET_NAME_KEYS[target.id] ? t(TARGET_NAME_KEYS[target.id]) : target.id}
                <span className="ml-2 font-normal text-muted-foreground">
                  {t('settings.skillAvailabilityWithheld').replace(
                    '{n}',
                    String(target.skillIds.length)
                  )}
                </span>
              </p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                {view.skills.map((skill) => {
                  const globallyOff = view.globallyDisabledSkillIds.includes(skill.id)
                  const locked = skill.alwaysOn || globallyOff
                  const withheld = target.skillIds.includes(skill.id)
                  const note = skill.alwaysOn
                    ? t('settings.skillAvailabilityAlwaysOn')
                    : globallyOff
                      ? t('settings.skillAvailabilityGloballyOff')
                      : undefined
                  return (
                    <label
                      key={skill.id}
                      data-testid={`skill-availability-${target.id}-${skill.id}`}
                      className={cn(
                        'flex items-center gap-2 text-xs',
                        locked ? 'text-muted-foreground' : 'text-foreground'
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={withheld || skill.alwaysOn}
                        disabled={locked || savingTarget === target.id}
                        onChange={(event) => void toggle(target.id, skill.id, event.target.checked)}
                      />
                      <span className="truncate">{skill.name}</span>
                      {note ? (
                        <span className="text-[10px] text-muted-foreground">{note}</span>
                      ) : null}
                    </label>
                  )
                })}
              </div>
            </div>
          ))
        : null}
    </section>
  )
}
