import { ScrollText } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLanguage, type TranslationKey } from '@/i18n'

import type { SkillDetailView as SkillDetail } from '../../../../shared/settings'
import { isSkillAlwaysOn } from '../../../../shared/skill-activation'
import { AgentMarkdown } from '@/components/streamdown/AgentMarkdown'
import { useSettingsStore } from '@/stores/settings-store'
import { SettingsToggle } from './SettingsLayout'

type SkillDetailViewProps = {
  skillId: string
}

// Formats an ISO date as a coarse "Updated N days ago" string for the detail header.
const formatUpdated = (iso: string, t: (key: TranslationKey) => string): string => {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const days = Math.max(0, Math.round((Date.now() - then) / 86_400_000))
  if (days === 0) return t('settings.updatedToday')
  if (days === 1) return t('ws.updatedDayAgo')
  return t('ws.updatedDaysAgo').replace('{n}', String(days))
}

// One label/value row in the Details section.
const DetailRow = ({ label, value }: { label: string; value: string }): React.JSX.Element => (
  <div className="flex flex-col gap-0.5 py-1.5">
    <span className="text-xs font-medium text-muted-foreground">{label}</span>
    <span className="text-sm text-foreground">{value}</span>
  </div>
)

const metadataLabel = (key: string): string =>
  key.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())

const DEDICATED_METADATA_KEYS = new Set([
  'author',
  'license',
  'third-party',
  'third_party',
  'thirdparty'
])

// Read-only detail view for one bundled skill: header (name + badge + updated + description), the
// rendered SKILL.md under "Files", and frontmatter metadata under "Details". The breadcrumb and back
// control live in the settings header, not here.
const SkillDetailView = ({ skillId }: SkillDetailViewProps): React.JSX.Element => {
  const { t } = useLanguage()
  const skill = useSettingsStore((state) => state.skills.find((item) => item.id === skillId))
  const setSkillEnabled = useSettingsStore((state) => state.setSkillEnabled)
  const [detail, setDetail] = useState<SkillDetail | null>(null)

  useEffect(() => {
    let active = true
    void window.api.settings.getSkillDetail(skillId).then((result) => {
      if (active) setDetail(result)
    })
    return () => {
      active = false
    }
  }, [skillId])

  const enabled = skill?.enabled ?? detail?.enabled ?? false
  const name = skill?.name ?? detail?.name ?? ''
  const description = detail?.description ?? skill?.description ?? ''
  const updated = detail ? formatUpdated(detail.updatedAt, t) : ''
  // Badge reflects the skill's actual source; imported and personal skills are not "Featured".
  const source = skill?.source ?? detail?.source
  const sourceLabel =
    source === 'imported' ? 'Imported' : source === 'personal' ? 'Personal' : 'Featured'
  // The skills that ship with the app are its gatekeepers: they cannot be switched off, so the header
  // offers no working switch for them and says why instead of failing silently.
  const alwaysOn = source !== undefined && isSkillAlwaysOn(source)
  const genericMetadata = Object.entries(detail?.metadata ?? {}).filter(
    ([key]) => !DEDICATED_METADATA_KEYS.has(key.toLowerCase())
  )

  return (
    <div className="p-5">
      {/* Header: icon + name + Featured badge + toggle, then updated + description below. */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ScrollText className="size-6 shrink-0 text-primary" aria-hidden="true" />
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-base font-semibold text-foreground">{name}</h1>
            <span className="inline-flex shrink-0 items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {sourceLabel}
            </span>
          </div>
        </div>
        <SettingsToggle
          enabled={enabled}
          aria-label={`Toggle ${name}`}
          disabled={alwaysOn}
          title={alwaysOn ? t('settings.skillAlwaysOn') : undefined}
          onToggle={() => void setSkillEnabled(skillId, !enabled)}
        />
      </div>

      {updated ? <p className="mt-1 text-xs text-muted-foreground">{updated}</p> : null}
      {description ? (
        <p className="mt-2 text-sm text-muted-foreground [text-wrap:pretty]">{description}</p>
      ) : null}
      {alwaysOn ? (
        <p className="mt-2 text-xs text-muted-foreground">{t('settings.skillAlwaysOn')}</p>
      ) : null}

      {/* Trigger quality: pure local rules, scored at read time, so the number is one the user can
          reproduce offline instead of a publisher's self-assessment. Every failing check says what is
          missing — a bare score would say "worse" without saying "worse how". */}
      {detail?.triggerQuality ? (
        <section className="mt-6 border-t border-border pt-4" data-testid="skill-trigger-quality">
          <h2 className="mb-1 text-sm font-semibold text-foreground">
            {t('settings.skillTriggerQuality')}
          </h2>
          <p className="text-xs text-muted-foreground" data-testid="skill-trigger-quality-score">
            {t('settings.skillTriggerQualityScore', {
              score: String(detail.triggerQuality.score),
              passed: String(detail.triggerQuality.checks.filter((check) => check.passed).length),
              total: String(detail.triggerQuality.checks.length)
            })}
          </p>
          <p className="mb-2 mt-1 text-xs text-muted-foreground">
            {t('settings.skillTriggerQualityHint')}
          </p>
          {detail.triggerQuality.checks.map((check) => (
            <div
              key={check.id}
              className="flex flex-wrap items-baseline gap-x-2 py-0.5"
              data-testid={`skill-trigger-check-${check.id}`}
            >
              <span className="text-xs text-foreground">
                {TRIGGER_CHECK_NAME_KEYS[check.id]
                  ? t(TRIGGER_CHECK_NAME_KEYS[check.id])
                  : check.id}
              </span>
              <span className="text-xs text-muted-foreground">
                {check.passed
                  ? t('settings.skillTriggerCheckPassed')
                  : TRIGGER_CHECK_MISSING_KEYS[check.id]
                    ? t(TRIGGER_CHECK_MISSING_KEYS[check.id])
                    : // A check this build has no wording for keeps the evaluator's own sentence rather
                      // than being mistranslated into a rule it does not describe.
                      check.message}
              </span>
            </div>
          ))}
        </section>
      ) : null}

      {/* Files: the rendered SKILL.md body. */}
      <section className="mt-6 border-t border-border pt-4">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Files</h2>
        {detail ? <AgentMarkdown content={detail.body} /> : null}
      </section>

      {/* Details: frontmatter metadata (author, license, third-party notices, ...). */}
      {detail &&
      (detail.author || detail.license || detail.thirdParty || genericMetadata.length > 0) ? (
        <section className="mt-6 border-t border-border pt-4">
          <h2 className="mb-1 text-sm font-semibold text-foreground">
            {t('skillDetail.detailsTitle')}
          </h2>
          {detail.author ? (
            <DetailRow label={t('skillDetail.author')} value={detail.author} />
          ) : null}
          {/* The row is always rendered: a missing license is a fact the reader needs (“unknown”), and a
              blank where a license should be reads as “no problem here”, which is the opposite. */}
          <DetailRow
            label={t('skillDetail.license')}
            value={detail.license ?? t('settings.skillLicenseUnknown')}
          />
          {detail.licenseStatus && detail.licenseStatus !== 'allowed' ? (
            <p className="mb-2 text-xs text-muted-foreground" data-testid="skill-license-status">
              {t(
                detail.licenseStatus === 'restricted'
                  ? 'settings.skillLicenseRestricted'
                  : 'settings.skillLicenseNeedsReview'
              )}
            </p>
          ) : null}
          {detail.thirdParty ? (
            <DetailRow label={t('settings.thirdPartySoftware')} value={detail.thirdParty} />
          ) : null}
          {genericMetadata.map(([key, value]) => (
            <DetailRow key={key} label={metadataLabel(key)} value={value} />
          ))}
        </section>
      ) : null}
    </div>
  )
}

export { SkillDetailView }

// The evaluator's five checks, named and explained in the user's language. A check this build does not have
// wording for is shown by its id and the evaluator's own sentence — an unknown rule must never be described
// by a translation of a different one.
const TRIGGER_CHECK_NAME_KEYS: Record<string, TranslationKey> = {
  length: 'settings.skillTriggerCheckNameLength',
  self_contained: 'settings.skillTriggerCheckNameSelfContained',
  action_vocabulary: 'settings.skillTriggerCheckNameActionVocabulary',
  concrete_subject: 'settings.skillTriggerCheckNameConcreteSubject',
  keyword_density: 'settings.skillTriggerCheckNameKeywordDensity'
}

const TRIGGER_CHECK_MISSING_KEYS: Record<string, TranslationKey> = {
  length: 'settings.skillTriggerCheckMissingLength',
  self_contained: 'settings.skillTriggerCheckMissingSelfContained',
  action_vocabulary: 'settings.skillTriggerCheckMissingActionVocabulary',
  concrete_subject: 'settings.skillTriggerCheckMissingConcreteSubject',
  keyword_density: 'settings.skillTriggerCheckMissingKeywordDensity'
}
