import { useLanguage } from '@/i18n'
import { EthernetPort, RefreshCw, Wifi, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { PackageMirror } from '../../../../shared/mirror'
import type { NetworkConnectionType, NetworkInfo } from '../../../../shared/network'
import type { EgressSettings, EgressDomainGroupId } from '../../../../shared/egress'
import { EGRESS_DOMAIN_GROUPS } from '../../../../shared/egress'
import type { ProxySettings, ProxyType } from '../../../../shared/proxy'
import {
  DEFAULT_PROXY_SETTINGS,
  PROXY_PORT_RANGE,
  PROXY_TYPES,
  proxyUrlFor
} from '../../../../shared/proxy'
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

      <EgressSection />
      <ProxySection />
    </div>
  )
}

// Network egress allowlist: master switch + 6 scientific domain groups + custom domains. When the
// switch is on, notebook/REPL/shell child processes are routed through a local filtering proxy that
// only allows the enabled groups and custom domains. Persisted via settings IPC; applied to the
// child-process runtime immediately on save.
const EgressSection = (): React.JSX.Element => {
  const { t } = useLanguage()
  const [settings, setSettings] = useState<EgressSettings | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const [draftDomain, setDraftDomain] = useState('')

  useEffect(() => {
    let cancelled = false
    void window.api.settings.getEgress().then((value) => {
      if (cancelled) return
      setSettings(value ?? { enabled: false, groups: {}, customDomains: [] })
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const update = (next: EgressSettings): void => {
    setSettings(next)
    void window.api.settings
      .setEgress(next)
      .then(setSettings)
      .catch(() => undefined)
  }

  if (!loaded) {
    return (
      <section className="mt-6 rounded-xl border border-border bg-card p-4">
        <p className="text-xs text-muted-foreground">{t('settings.loading')}</p>
      </section>
    )
  }

  const current = settings ?? { enabled: false, groups: {}, customDomains: [] }
  const groupIds = EGRESS_DOMAIN_GROUPS.map((group) => group.id)
  const groupLabels: Record<EgressDomainGroupId, string> = {
    literature: t('settings.egressGroupLiterature'),
    genomics: t('settings.egressGroupGenomics'),
    structures: t('settings.egressGroupStructures'),
    clinical: t('settings.egressGroupClinical'),
    bioinformatics: t('settings.egressGroupBioinformatics'),
    repositories: t('settings.egressGroupRepositories')
  }

  const addDomain = (): void => {
    const domain = draftDomain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
    if (!domain || current.customDomains.includes(domain)) {
      setDraftDomain('')
      return
    }
    update({ ...current, customDomains: [...current.customDomains, domain] })
    setDraftDomain('')
  }

  return (
    <section
      className="mt-6 rounded-xl border border-border bg-card p-4"
      data-slot="egress-section"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-foreground">{t('settings.egressTitle')}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t('settings.egressDescription')}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={current.enabled}
          aria-label={t('settings.egressEnabled')}
          data-slot="egress-master-switch"
          className={cn(
            'relative h-5 w-9 shrink-0 rounded-full transition-colors',
            current.enabled ? 'bg-primary' : 'bg-muted'
          )}
          onClick={() => update({ ...current, enabled: !current.enabled })}
        >
          <span
            className={cn(
              'absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform',
              current.enabled ? 'translate-x-[18px]' : 'translate-x-0.5'
            )}
          />
        </button>
      </div>

      {current.enabled ? (
        <div className="mt-4 space-y-4">
          {current.customDomains.length > 0 ? (
            <p className="text-xs text-muted-foreground" data-slot="egress-custom-count">
              {t('settings.egressCustomCount').replace('{n}', String(current.customDomains.length))}
            </p>
          ) : null}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {groupIds.map((groupId) => (
              <label
                key={groupId}
                className="flex cursor-pointer items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground"
              >
                <span>{groupLabels[groupId]}</span>
                <input
                  type="checkbox"
                  data-slot={`egress-group-${groupId}`}
                  checked={current.groups[groupId] !== false}
                  onChange={(event) =>
                    update({
                      ...current,
                      groups: { ...current.groups, [groupId]: event.target.checked }
                    })
                  }
                />
              </label>
            ))}
          </div>

          <div data-slot="egress-custom">
            <h4 className="text-xs font-medium text-foreground">
              {t('settings.egressCustomDomains')}
            </h4>
            <div className="mt-2 flex gap-2">
              <Input
                data-slot="egress-domain-input"
                value={draftDomain}
                placeholder={t('settings.egressCustomPlaceholder')}
                onChange={(event) => setDraftDomain(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    addDomain()
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-slot="egress-add-domain"
                onClick={addDomain}
              >
                {t('settings.egressAddDomain')}
              </Button>
            </div>
            {current.customDomains.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">{t('settings.egressNoCustom')}</p>
            ) : (
              <ul className="mt-2 flex flex-wrap gap-2">
                {current.customDomains.map((domain) => (
                  <li
                    key={domain}
                    className="flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-foreground"
                  >
                    <span>{domain}</span>
                    <button
                      type="button"
                      aria-label={t('settings.egressRemoveDomain')}
                      data-slot={`egress-remove-${domain}`}
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() =>
                        update({
                          ...current,
                          customDomains: current.customDomains.filter((d) => d !== domain)
                        })
                      }
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </section>
  )
}

// Child-process proxy: follow the operating system (default) or pin a manual proxy
// (HTTP / HTTPS / SOCKS5) that notebook kernels, the REPL and shells route through.
// Persisted via settings IPC and applied to the child-process runtime immediately on
// save. While the egress allowlist above is enabled it owns the route (the filtering
// proxy must stay the only hop), so the manual proxy applies only when egress is off.
const ProxySection = (): React.JSX.Element => {
  const { t } = useLanguage()
  const [saved, setSaved] = useState<ProxySettings | undefined>(undefined)
  const [draft, setDraft] = useState<ProxySettings>(DEFAULT_PROXY_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void window.api.settings.getProxy().then((value) => {
      if (cancelled) return
      const current = value ?? DEFAULT_PROXY_SETTINGS
      setSaved(current)
      setDraft(cloneProxySettings(current))
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const manual = draft.manual ?? { type: 'http' as ProxyType, host: '', port: 0, noProxy: [] }
  const isDirty = JSON.stringify(draft) !== JSON.stringify(saved)

  const patchManual = (patchValue: Partial<ProxySettings['manual']>): void => {
    setDraft({ ...draft, mode: 'manual', manual: { ...manual, ...patchValue } })
  }

  const selectType = (type: ProxyType): void => patchManual({ type })

  const parsePort = (raw: string): number | undefined => {
    const value = Number(raw)
    return Number.isInteger(value) && value >= PROXY_PORT_RANGE.min && value <= PROXY_PORT_RANGE.max
      ? value
      : undefined
  }

  const splitNoProxy = (raw: string): string[] =>
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)

  const handleSave = async (): Promise<void> => {
    setFormError(undefined)
    if (draft.mode === 'manual') {
      if (!manual.host.trim()) {
        setFormError(t('settings.proxyHostRequired'))
        return
      }
      if (manual.port === undefined || parsePort(String(manual.port)) === undefined) {
        setFormError(t('settings.proxyPortInvalid'))
        return
      }
    }

    setSaving(true)
    try {
      const next: ProxySettings =
        draft.mode === 'system'
          ? { mode: 'system' }
          : {
              mode: 'manual',
              manual: {
                type: manual.type,
                host: manual.host.trim(),
                port: parsePort(String(manual.port)) ?? PROXY_PORT_RANGE.min,
                ...(splitNoProxy(manual.noProxy?.join(', ') ?? '').length > 0
                  ? { noProxy: splitNoProxy(manual.noProxy?.join(', ') ?? '') }
                  : {})
              }
            }
      const persisted = await window.api.settings.setProxy(next)
      setSaved(persisted ?? DEFAULT_PROXY_SETTINGS)
      setDraft(cloneProxySettings(persisted ?? DEFAULT_PROXY_SETTINGS))
    } catch (error) {
      setFormError(error instanceof Error ? error.message : t('settings.proxySaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) {
    return (
      <section className="mt-6 rounded-xl border border-border bg-card p-4">
        <p className="text-xs text-muted-foreground">{t('settings.loading')}</p>
      </section>
    )
  }

  const savedManual =
    saved?.mode === 'manual' && saved.manual && saved.manual.host.trim() !== ''
      ? saved.manual
      : undefined

  return (
    <section className="mt-6 rounded-xl border border-border bg-card p-4" data-slot="proxy-section">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('settings.proxyTitle')}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t('settings.proxyDescription')}
        </p>
      </div>

      <div className="mt-4 space-y-2">
        <button
          type="button"
          role="radio"
          aria-checked={draft.mode === 'system'}
          data-slot="proxy-mode-system"
          className={cn(
            'flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
            draft.mode === 'system'
              ? 'border-primary bg-primary/5'
              : 'border-border bg-card hover:bg-muted/60'
          )}
          onClick={() => setDraft({ ...draft, mode: 'system' })}
        >
          <input
            type="radio"
            name="proxy-mode"
            className="mt-0.5 accent-primary"
            checked={draft.mode === 'system'}
            onChange={() => setDraft({ ...draft, mode: 'system' })}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">
              {t('settings.proxyModeSystem')}
            </span>
            <span className="block text-xs text-muted-foreground">
              {t('settings.proxyModeSystemHint')}
            </span>
          </span>
        </button>

        <button
          type="button"
          role="radio"
          aria-checked={draft.mode === 'manual'}
          data-slot="proxy-mode-manual"
          className={cn(
            'flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
            draft.mode === 'manual'
              ? 'border-primary bg-primary/5'
              : 'border-border bg-card hover:bg-muted/60'
          )}
          onClick={() => setDraft({ ...draft, mode: 'manual' })}
        >
          <input
            type="radio"
            name="proxy-mode"
            className="mt-0.5 accent-primary"
            checked={draft.mode === 'manual'}
            onChange={() => setDraft({ ...draft, mode: 'manual' })}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">
              {t('settings.proxyModeManual')}
            </span>
            <span className="block text-xs text-muted-foreground">
              {t('settings.proxyModeManualHint')}
            </span>
          </span>
        </button>
      </div>

      {draft.mode === 'manual' ? (
        <div className="mt-4 space-y-3" data-slot="proxy-manual-fields">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_2fr_1fr]">
            <div className="space-y-1.5">
              <label className={fieldLabelClassName} htmlFor="proxy-type">
                {t('settings.proxyTypeLabel')}
              </label>
              <select
                id="proxy-type"
                data-slot="proxy-type"
                value={manual.type}
                onChange={(event) => selectType(event.target.value as ProxyType)}
                className="h-9 w-full rounded-lg border border-border bg-card px-2.5 text-sm text-foreground"
              >
                {PROXY_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {proxyTypeOptionLabel(type, t)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className={fieldLabelClassName} htmlFor="proxy-host">
                {t('settings.proxyHostLabel')}
              </label>
              <Input
                id="proxy-host"
                data-slot="proxy-host"
                value={manual.host}
                placeholder={t('settings.proxyHostPlaceholder')}
                onChange={(event) => patchManual({ host: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <label className={fieldLabelClassName} htmlFor="proxy-port">
                {t('settings.proxyPortLabel')}
              </label>
              <Input
                id="proxy-port"
                data-slot="proxy-port"
                value={manual.port === 0 ? '' : String(manual.port)}
                placeholder="7890"
                inputMode="numeric"
                onChange={(event) => patchManual({ port: parsePort(event.target.value) })}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className={fieldLabelClassName} htmlFor="proxy-no-proxy">
              {t('settings.proxyNoProxyLabel')}
            </label>
            <Input
              id="proxy-no-proxy"
              data-slot="proxy-no-proxy"
              value={manual.noProxy?.join(', ') ?? ''}
              placeholder="example.com, 10.0.0.0/8"
              onChange={(event) => patchManual({ noProxy: splitNoProxy(event.target.value) })}
            />
            <p className="text-[11px] text-muted-foreground">{t('settings.proxyNoProxyHint')}</p>
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground" data-slot="proxy-status">
          {savedManual
            ? t('settings.proxyStatusManual').replace('{url}', proxyUrlFor(savedManual))
            : t('settings.proxyStatusSystem')}
        </p>
        <div className="flex items-center gap-2">
          {formError ? (
            <p className="text-xs text-destructive" role="alert">
              {formError}
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-slot="proxy-save"
            onClick={() => void handleSave()}
            disabled={!isDirty || saving}
          >
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </div>
    </section>
  )
}

const cloneProxySettings = (settings: ProxySettings): ProxySettings =>
  JSON.parse(JSON.stringify(settings)) as ProxySettings

// Literal option labels for the proxy scheme select (t() only accepts literal keys).
const proxyTypeOptionLabel = (type: ProxyType, t: ReturnType<typeof useLanguage>['t']): string => {
  switch (type) {
    case 'http':
      return t('settings.proxyTypeHttp')
    case 'https':
      return t('settings.proxyTypeHttps')
    case 'socks5':
      return t('settings.proxyTypeSocks5')
  }
}

export { NetworkPanel }
