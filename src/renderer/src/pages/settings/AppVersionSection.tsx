import { useEffect, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import { useLanguage } from '@/i18n'

import { AppLogo } from '@/components/AppLogo'
import { Button } from '@/components/ui/button'
import { ThirdPartyLicensesDialog } from '@/components/ThirdPartyLicensesDialog'
import { useUpdateStore } from '@/stores/update-store'
import { APP } from '../../../../shared/app-config'
import { SettingsRow, SettingsSection, SettingsToggle } from './SettingsLayout'

// App identity + update control in Settings→General. Reads the shared update store so it stays in
// sync with the external capsule; the update button opens the shared dialog (version + notes +
// download), so the download/confirm UX lives in one place.
const AppVersionSection = (): React.JSX.Element => {
  const { t } = useLanguage()
  const [licensesOpen, setLicensesOpen] = useState(false)
  const appInfo = useUpdateStore((state) => state.appInfo)
  const status = useUpdateStore((state) => state.status)
  const check = useUpdateStore((state) => state.check)
  const openDialog = useUpdateStore((state) => state.openDialog)
  // Update auto-apply opt-in (Settings → General): persisted in the main settings store, read
  // here so the toggle reflects the real flag. Guarded with optional chaining so render suites
  // that stub window.api without the settings namespace keep working (toggle stays hidden-off).
  const [autoApply, setAutoApply] = useState(false)
  const [autoApplyLoaded, setAutoApplyLoaded] = useState(false)

  useEffect(() => {
    const getAutoApply = (window.api as { settings?: { getAutoApply?: () => Promise<boolean> } })
      ?.settings?.getAutoApply
    if (typeof getAutoApply !== 'function') return
    let cancelled = false
    void getAutoApply().then((enabled) => {
      if (!cancelled) {
        setAutoApply(enabled)
        setAutoApplyLoaded(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const version = appInfo?.version ?? status.current
  const isChecking = status.state === 'checking'
  const isDownloading = status.state === 'downloading'
  const hasUpdate = status.state === 'available' || isDownloading || status.state === 'ready'

  const statusLine = ((): string => {
    switch (status.state) {
      case 'checking':
        return t('settings.checkingForUpdates')
      case 'available':
        return t('common.newVersion').replace('{v}', status.latest ?? '')
      case 'downloading':
        return `${t('common.downloading')} ${status.progress ?? 0}%`
      case 'ready':
        // Kind-aware: in-place (win/linux) updates finish by restarting; the mac flow hands the
        // user the downloaded installer. The generic "downloaded" copy said neither clearly.
        return status.applyKind === 'restart'
          ? t('update.readyRestartHint')
          : t('update.readyInstallerHint')
      case 'up-to-date':
        return t('settings.onLatestVersion')
      case 'error':
        return status.error ?? t('settings.updateCheckFailed')
      default:
        return ''
    }
  })()

  return (
    <SettingsSection title={t('settings.about')} aria-label={t('settings.appVersion')}>
      <SettingsRow
        label={
          <div className="flex min-w-0 items-center gap-3">
            <AppLogo className="size-12 rounded-lg" />
            <div className="min-w-0">
              <p className="flex items-baseline gap-2">
                <span className="text-sm font-semibold text-foreground">{APP.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  v{version} · {APP.releaseCode}
                </span>
              </p>
              <p className="mt-0.5 text-xs font-normal text-muted-foreground">
                {APP.releaseCodeMeaning} · {APP.copyright}
              </p>
            </div>
          </div>
        }
        controlClassName="w-auto justify-self-end"
      >
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void check()}
            disabled={isChecking}
          >
            <RefreshCw
              className={isChecking ? 'size-4 animate-spin' : 'size-4'}
              aria-hidden="true"
            />
            {isChecking ? t('common.checking') : t('settings.checkNow')}
          </Button>

          {hasUpdate ? (
            <Button type="button" onClick={() => openDialog()}>
              <Download className="size-4" aria-hidden="true" />
              {isDownloading
                ? `${t('common.downloading')} ${status.progress ?? 0}%`
                : status.state === 'ready'
                  ? t('settings.updateReady')
                  : t('common.updateTo').replace('{v}', status.latest ?? '')}
            </Button>
          ) : null}
        </div>
      </SettingsRow>

      <SettingsRow
        label={t('settings.autoApplyUpdate')}
        description={t('settings.autoApplyUpdateHint')}
      >
        <div className="flex justify-end">
          <SettingsToggle
            enabled={autoApply}
            onToggle={() => {
              const setAutoApplyApi = (
                window.api as {
                  settings?: { setAutoApply?: (enabled: boolean) => Promise<boolean> }
                }
              )?.settings?.setAutoApply
              if (!setAutoApplyApi) return
              setAutoApplyApi(!autoApply)
                .then(setAutoApply)
                .catch(() => undefined)
            }}
            disabled={!autoApplyLoaded}
            aria-label={t('settings.autoApplyUpdate')}
          />
        </div>
      </SettingsRow>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t pt-3 text-xs">
        <a
          href={APP.links.website}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground underline-offset-4 hover:underline"
        >
          {t('settings.helpCenter')}
        </a>
        <a
          href={APP.links.githubReleases}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground underline-offset-4 hover:underline"
        >
          {t('settings.releaseNotes')}
        </a>
        <a
          href={APP.links.githubIssues}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground underline-offset-4 hover:underline"
        >
          {t('settings.reportIssue')}
        </a>
        <button
          type="button"
          onClick={() => setLicensesOpen(true)}
          className="text-muted-foreground underline-offset-4 hover:underline"
        >
          {t('settings.thirdPartyLicenses')}
        </button>
      </div>

      <ThirdPartyLicensesDialog open={licensesOpen} onOpenChange={setLicensesOpen} />

      {statusLine ? (
        <p
          className={
            status.state === 'error'
              ? 'mt-2 text-xs text-destructive'
              : 'mt-2 text-xs text-muted-foreground'
          }
          role={status.state === 'error' ? 'alert' : undefined}
        >
          {statusLine}
        </p>
      ) : null}
    </SettingsSection>
  )
}

export { AppVersionSection }
