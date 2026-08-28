import { useLanguage } from '@/i18n'
import { EthernetPort, RefreshCw, Wifi, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { PackageMirror } from '../../../../shared/mirror'
import type { NetworkConnectionType, NetworkInfo } from '../../../../shared/network'
import type { EnvironmentCheckItem } from '../../../../shared/settings'
import { EnvironmentCheckRow, PendingCheckRow } from '@/components/environment-check-row'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useNetworkStore } from '@/stores/network-store'
import { useSettingsStore } from '@/stores/settings-store'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { isMirrorConfigured, mirrorStatusText, MIRROR_HELP_URL } from './mirror-view'

const fieldLabelClassName = 'text-xs font-medium text-muted-foreground'
const actionButtonClassName =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50'

// Package-mirror list vs. configure form. The configure form is a settings-nav sub-view (not local
// state) so the shared header shows a "Network / Package mirror" breadcrumb with back/forward.
type NetworkView = { kind: 'list' | 'configure' }
type NetworkPanelProps = { view: NetworkView; onNavigate: (view: NetworkView) => void }

// Settings -> Network. The Network status section presents the network store's connectivity
// (navigator.onLine link signal plus the store's shared end-to-end reachability probe) and the
// local interface details reported by the main process; the Package mirror section lets a user
// behind a firewall or on a slow route to the public conda-forge / pip hosts point package
// fetches at a mirror instead. The scientific-domains egress allowlist from the design is
// phase-3 (spec §14, §9) and is intentionally not built here.
const NetworkPanel = ({ view, onNavigate }: NetworkPanelProps): React.JSX.Element => {
  const { t } = useLanguage()
  const packageMirror = useSettingsStore((state) => state.packageMirror)
  const setPackageMirror = useSettingsStore((state) => state.setPackageMirror)
  const isOnline = useNetworkStore((state) => state.isOnline)
  // End-to-end reachability is owned by the network store (probed on startup, recovery, a
  // background cadence, and Retry), so this panel and the header/sidebar indicators never
  // disagree. 'unknown' renders as Checking….
  const connectivity = useNetworkStore((state) => state.connectivity)
  const probeConnectivity = useNetworkStore((state) => state.probeConnectivity)

  // In-component: labels need t(); 'unknown' has no label and drops out.
  const networkCheckBase = {
    id: 'install-network',
    label: t('settings.internetConnection')
  } as const satisfies Pick<EnvironmentCheckItem, 'id' | 'label'>
  const connectionTypeLabels: Partial<Record<NetworkConnectionType, string>> = {
    wifi: t('settings.wifi'),
    ethernet: t('settings.ethernet')
  }

  const isConfiguring = view.kind === 'configure'
  const [draft, setDraft] = useState<PackageMirror>({})
  const [isSaving, setIsSaving] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null)

  // Local interface details come from the main process; window.api.network is Electron-only,
  // so stay with placeholders when the preload bridge is unavailable.
  const refreshNetworkInfo = useCallback((): void => {
    const getInfo = window.api?.network?.getInfo
    if (!getInfo) return

    void getInfo().then((info) => setNetworkInfo(info))
  }, [])

  // Pull local interface details when the list view mounts while online, and re-pull whenever
  // connectivity comes back; offline rows show placeholders, so a drop has nothing to refresh.
  useEffect(() => {
    if (view.kind === 'list' && isOnline) refreshNetworkInfo()
  }, [view.kind, isOnline, refreshNetworkInfo])

  const recheckOnline = useNetworkStore((state) => state.recheckOnline)

  const handleRetry = (): void => {
    recheckOnline()
    refreshNetworkInfo()
    // Announced even while offline: the store short-circuits a link-down probe to
    // 'unreachable', but still holds the Checking… state for its minimum delay first.
    void probeConnectivity({ announce: true })
  }

  // Seed the draft from the saved mirror once each time the configure view is entered (including via
  // history / a remount), without clobbering in-progress edits on a background store refresh.
  const seededRef = useRef(false)
  useEffect(() => {
    if (view.kind === 'configure') {
      if (!seededRef.current) {
        setDraft(packageMirror ?? {})
        setMessage(undefined)
        seededRef.current = true
      }
    } else {
      seededRef.current = false
    }
  }, [view.kind, packageMirror])

  const handleConfigure = (): void => onNavigate({ kind: 'configure' })

  const handleCancel = (): void => {
    setMessage(undefined)
    onNavigate({ kind: 'list' })
  }

  const handleSave = async (): Promise<void> => {
    setIsSaving(true)
    setMessage(undefined)

    try {
      await setPackageMirror(draft)
      onNavigate({ kind: 'list' })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('settings.couldNotSavePackageMirror'))
    } finally {
      setIsSaving(false)
    }
  }

  // Connection type + IP fold into the check row's detail line, e.g. "Wi-Fi · 192.168.1.42".
  const typeLabel = networkInfo ? connectionTypeLabels[networkInfo.connectionType] : undefined
  const interfaceDetail =
    [typeLabel ?? null, networkInfo?.ipAddress ?? null]
      .filter((part) => part !== null)
      .join(' · ') || undefined

  // The Network status row is an EnvironmentCheckItem so it renders with the exact same row
  // component as the onboarding environment step's network check. A live link with unreachable
  // internet is amber (warning) rather than red — the machine is connected, the path out is not.
  const networkCheck: EnvironmentCheckItem = !isOnline
    ? {
        ...networkCheckBase,
        status: 'failed',
        summary: t('settings.machineOffline')
      }
    : connectivity === 'unreachable'
      ? {
          ...networkCheckBase,
          status: 'warning',
          summary: t('settings.linkUpButInternetUnreachable'),
          detail: interfaceDetail
        }
      : {
          ...networkCheckBase,
          status: 'passed',
          summary: t('settings.internetReachable'),
          detail: interfaceDetail
        }

  // 'unknown' only ever means a probe is in flight (offline settles on 'unreachable'), so it
  // always renders as Checking… — including an offline Retry.
  const isChecking = connectivity === 'unknown'

  // Tile icon follows the actual link: WifiOff while offline, then by connection type.
  const networkIcon = !isOnline
    ? WifiOff
    : networkInfo?.connectionType === 'ethernet'
      ? EthernetPort
      : Wifi

  return (
    <div className="space-y-6 p-5">
      {!isConfiguring ? (
        <section aria-label={t('settings.networkStatus')}>
          <h3 className="mb-1 text-sm font-semibold text-foreground">
            {t('settings.networkStatus')}
          </h3>
          <p className="mb-3 text-xs text-muted-foreground">
            {t('settings.networkReachabilityHint')}
          </p>

          <div className="rounded-xl border border-border px-4">
            <ul aria-live="polite">
              {isChecking ? (
                <PendingCheckRow {...networkCheckBase} pendingText={t('settings.checking')} />
              ) : (
                <EnvironmentCheckRow check={networkCheck} icon={networkIcon} />
              )}
            </ul>

            {!isOnline || connectivity === 'unreachable' ? (
              <div className="mb-4 rounded-lg bg-bg-10 px-4 py-4 ring-1 ring-border-200">
                <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
                  {!isOnline ? <li>{t('settings.networkCableHint')}</li> : null}
                  <li>{t('settings.networkProxyHint')}</li>
                  <li>{t('settings.checkPackageMirrorBelow')}</li>
                </ol>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={handleRetry}
                  disabled={isChecking}
                >
                  <RefreshCw className={cn(isChecking && 'animate-spin')} aria-hidden="true" />
                  {isChecking ? t('settings.checking') : t('onboarding.checkAgain')}
                </Button>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <section aria-label={t('settings.packageMirror')}>
        <h3 className="mb-1 text-sm font-semibold text-foreground">
          {t('settings.packageMirror')}
        </h3>
        <p className="mb-3 text-xs text-muted-foreground">{t('settings.whereNotebookFetches')}</p>

        <div className="rounded-xl border border-border p-4">
          {!isConfiguring ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-foreground">{mirrorStatusText(packageMirror, t)}</span>
              <button type="button" onClick={handleConfigure} className={actionButtonClassName}>
                {isMirrorConfigured(packageMirror) ? t('common.edit') : t('settings.configure')}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="space-y-1.5">
                <label className={fieldLabelClassName} htmlFor="mirror-conda-channel">
                  {t('settings.condaChannelMirror')}
                </label>
                <Input
                  id="mirror-conda-channel"
                  aria-label={t('settings.condaChannelMirror')}
                  value={draft.condaChannel ?? ''}
                  placeholder="https://mirrors.example.com/conda-forge/"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, condaChannel: event.target.value }))
                  }
                />
              </div>

              <div className="space-y-1.5">
                <label className={fieldLabelClassName} htmlFor="mirror-pypi-index">
                  {t('settings.pythonPackageIndex')}
                </label>
                <Input
                  id="mirror-pypi-index"
                  aria-label={t('settings.pythonPackageIndex')}
                  value={draft.pypiIndex ?? ''}
                  placeholder="https://mirrors.example.com/pypi/simple"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, pypiIndex: event.target.value }))
                  }
                />
              </div>

              <div className="space-y-1.5">
                <label className={fieldLabelClassName} htmlFor="mirror-ca-bundle">
                  {t('settings.caBundlePath')}{' '}
                  <span className="text-muted-foreground">{t('common.optional')}</span>
                </label>
                <Input
                  id="mirror-ca-bundle"
                  aria-label={t('settings.caBundlePath')}
                  value={draft.caBundle ?? ''}
                  placeholder="/path/to/corp-ca-bundle.pem"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, caBundle: event.target.value }))
                  }
                />
                <p className="text-[11px] text-muted-foreground">{t('settings.pemBundleHint')}</p>
              </div>

              {message ? (
                <p className="text-xs text-destructive" role="alert">
                  {message}
                </p>
              ) : null}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={isSaving}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted disabled:opacity-50"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={isSaving}
                  className="rounded-lg border border-primary bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {isSaving ? t('settings.saving') : t('common.save')}
                </button>
              </div>
            </div>
          )}
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          <ExternalTextLink href={MIRROR_HELP_URL}>{t('settings.viewMirrors')}</ExternalTextLink>
        </p>
      </section>
    </div>
  )
}

export { NetworkPanel }
