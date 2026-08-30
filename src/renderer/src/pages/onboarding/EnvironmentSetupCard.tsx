import type { EnvironmentCheckId, EnvironmentCheckResult } from '../../../../shared/settings'
import { EnvironmentCheckRow, PendingCheckRow } from '@/components/environment-check-row'
import { useLanguage } from '@/i18n'

type EnvironmentSetupCardProps = {
  environment: EnvironmentCheckResult | undefined
  error?: string
}

// Host-only requirement list for the first onboarding step. Agent installation and notebook runtime
// management live in their dedicated steps and must not leak back into this surface.
const EnvironmentSetupCard = ({
  environment,
  error
}: EnvironmentSetupCardProps): React.JSX.Element => {
  const { t } = useLanguage()
  const CHECK_LABELS: Array<{ id: EnvironmentCheckId; label: string }> = [
    { id: 'system', label: t('onboarding.systemCompatibility') },
    { id: 'storage', label: t('onboarding.appStoragePermission') },
    { id: 'secure-storage', label: t('onboarding.secureCredentialStorage') },
    { id: 'install-network', label: t('onboarding.installationNetwork') }
  ]
  const HOST_CHECK_IDS: readonly EnvironmentCheckId[] = CHECK_LABELS.map((check) => check.id)
  const visibleChecks = environment?.checks.filter((check) => HOST_CHECK_IDS.includes(check.id))
  const hostNeedsAction = visibleChecks?.some((check) => check.status === 'failed') ?? false

  return (
    <div className="space-y-4">
      <ul
        className="divide-y divide-border-200"
        aria-label={t('ui.environmentrequirements')}
        aria-live="polite"
      >
        {environment
          ? visibleChecks?.map((check) => <EnvironmentCheckRow key={check.id} check={check} />)
          : CHECK_LABELS.map((check) => <PendingCheckRow key={check.id} {...check} />)}
      </ul>

      {hostNeedsAction ? (
        <div className="rounded-lg bg-bg-10 px-4 py-4 ring-1 ring-border-200">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('onboarding.resolveActionNeeded')}
          </p>
        </div>
      ) : null}

      {error ? (
        <div
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3"
          role="alert"
        >
          <p className="text-xs font-semibold text-destructive">{t('onboarding.setupCouldNotComplete')}</p>
          <p className="mt-1 break-words text-xs text-destructive/90">{error}</p>
        </div>
      ) : null}
    </div>
  )
}

export { EnvironmentSetupCard }
