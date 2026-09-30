import { useLanguage, type TranslationKey } from '@/i18n'
import { AlertTriangle, RefreshCw, ShieldAlert, ShieldCheck, ShieldHalf } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import {
  protectionRepairSteps,
  type ExecutionProtectionLayerId,
  type ExecutionProtectionLevel,
  type ExecutionProtectionMatrix,
  type ExecutionProtectionSnapshot,
  type ExecutionProtectionUnmetCode,
  type ExecutionProtectionRepairCode,
  type ExecutionSurface,
  type RemoteUnprotectedExecutionPolicy
} from '../../../../shared/execution-protection'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const SURFACE_KEYS: Record<ExecutionSurface, TranslationKey> = {
  notebook: 'protection.surfaceNotebook',
  shell: 'protection.surfaceShell',
  'background-job': 'protection.surfaceBackgroundJob',
  'remote-host': 'protection.surfaceRemoteHost'
}

const LEVEL_KEYS: Record<ExecutionProtectionLevel, TranslationKey> = {
  'os-sandbox': 'protection.levelOsSandbox',
  'network-allowlist': 'protection.levelNetworkAllowlist',
  unprotected: 'protection.levelUnprotected'
}

const LAYER_KEYS: Record<ExecutionProtectionLayerId, TranslationKey> = {
  'macos-seatbelt-runtime-write': 'protection.layerMacosSeatbeltRuntimeWrite',
  'egress-allowlist': 'protection.layerEgressAllowlist',
  'managed-runtime-mutation-guard': 'protection.layerManagedRuntimeMutationGuard'
}

const UNMET_KEYS: Record<ExecutionProtectionUnmetCode, TranslationKey> = {
  'network-allowlist-disabled': 'protection.unmetNetworkAllowlistDisabled',
  'os-sandbox-unavailable-platform': 'protection.unmetOsSandboxUnavailablePlatform',
  'os-sandbox-component-missing': 'protection.unmetOsSandboxComponentMissing',
  'remote-execution-has-no-local-protection': 'protection.unmetRemoteExecutionHasNoLocalProtection',
  'protection-unresolved': 'protection.unmetProtectionUnresolved'
}

const REPAIR_KEYS: Record<ExecutionProtectionRepairCode, TranslationKey> = {
  'enable-network-allowlist': 'protection.repairEnableNetworkAllowlist',
  'run-locally': 'protection.repairRunLocally',
  'platform-has-no-os-sandbox': 'protection.repairPlatformHasNoOsSandbox'
}

const POLICY_KEYS: Record<
  RemoteUnprotectedExecutionPolicy,
  { label: TranslationKey; hint: TranslationKey }
> = {
  confirm: { label: 'protection.policyConfirm', hint: 'protection.policyConfirmHint' },
  remembered: { label: 'protection.policyRemembered', hint: 'protection.policyRememberedHint' },
  deny: { label: 'protection.policyDeny', hint: 'protection.policyDenyHint' }
}

const POLICY_ORDER: readonly RemoteUnprotectedExecutionPolicy[] = ['confirm', 'remembered', 'deny']

const LEVEL_ICONS: Record<ExecutionProtectionLevel, React.ComponentType<{ className?: string }>> = {
  'os-sandbox': ShieldCheck,
  'network-allowlist': ShieldHalf,
  unprotected: ShieldAlert
}

const LEVEL_TONE: Record<ExecutionProtectionLevel, string> = {
  'os-sandbox': 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  'network-allowlist': 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  unprotected: 'border-destructive/40 bg-destructive/10 text-destructive'
}

// Settings -> Execution protection. The protection matrix answers, before anything runs, what
// isolation each execution surface actually has on this machine — and names what it does NOT have.
// The level is weakest-link (both the filesystem write-guard and network filtering must hold for
// `os-sandbox`), so the two axes are always rendered next to it: a level can never quietly hide a
// protection that is still in force.
const ExecutionProtectionPanel = (): React.JSX.Element => {
  const { t } = useLanguage()
  const [matrix, setMatrix] = useState<ExecutionProtectionMatrix | undefined>(undefined)
  const [loadFailed, setLoadFailed] = useState(false)
  const [isSavingPolicy, setIsSavingPolicy] = useState(false)

  // The bridge read is shared by the mount effect and the Retry button. `undefined` means "no
  // bridge in this window", which is reported as an unavailable matrix rather than an empty one.
  const readMatrix = useCallback(async (): Promise<ExecutionProtectionMatrix | undefined> => {
    const read = window.api?.settings?.executionProtection
    if (!read) return undefined
    return (await read({ action: 'matrix' })).matrix
  }, [])

  const applyResult = useCallback((next: ExecutionProtectionMatrix | undefined): void => {
    if (next) setMatrix(next)
    setLoadFailed(next === undefined)
  }, [])

  useEffect(() => {
    let active = true
    void readMatrix()
      .then((next) => {
        if (active) applyResult(next)
      })
      .catch(() => {
        if (active) setLoadFailed(true)
      })
    return () => {
      active = false
    }
  }, [readMatrix, applyResult])

  const reload = (): void => {
    void readMatrix()
      .then(applyResult)
      .catch(() => setLoadFailed(true))
  }

  const selectPolicy = (policy: RemoteUnprotectedExecutionPolicy): void => {
    const write = window.api?.settings?.executionProtection
    if (!write || policy === matrix?.remoteUnprotectedPolicy) return
    setIsSavingPolicy(true)
    void write({ action: 'set-remote-policy', policy })
      .then((result) => {
        setMatrix(result.matrix)
        setLoadFailed(false)
      })
      .catch(() => setLoadFailed(true))
      .finally(() => setIsSavingPolicy(false))
  }

  const surfaceRow = (snapshot: ExecutionProtectionSnapshot): React.JSX.Element => {
    const Icon = LEVEL_ICONS[snapshot.level]
    const repairs = protectionRepairSteps(snapshot)
    return (
      <div
        key={snapshot.surface}
        data-slot={`protection-row-${snapshot.surface}`}
        className="grid gap-3 rounded-xl border border-border bg-card p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]"
      >
        <div className="space-y-2">
          <div className="text-sm font-medium text-foreground">
            {t(SURFACE_KEYS[snapshot.surface])}
          </div>
          <span
            data-slot={`protection-level-${snapshot.surface}`}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
              LEVEL_TONE[snapshot.level]
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {t(LEVEL_KEYS[snapshot.level])}
          </span>
        </div>
        <div className="space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
            <span data-slot={`protection-scope-filesystem-${snapshot.surface}`}>
              {t('protection.scopeFilesystem')}
              {': '}
              <span className="font-medium text-foreground">
                {t(
                  snapshot.scope.filesystem === 'runtime-write-protected'
                    ? 'protection.scopeFilesystemProtected'
                    : 'protection.scopeFilesystemUnrestricted'
                )}
              </span>
            </span>
            <span data-slot={`protection-scope-network-${snapshot.surface}`}>
              {t('protection.scopeNetwork')}
              {': '}
              <span className="font-medium text-foreground">
                {t(
                  snapshot.scope.network === 'allowlist'
                    ? 'protection.scopeNetworkAllowlist'
                    : 'protection.scopeNetworkUnrestricted'
                )}
              </span>
            </span>
          </div>
          {snapshot.applied.length > 0 ? (
            <ul className="space-y-1 text-muted-foreground">
              {snapshot.applied.map((layer) => (
                <li key={layer} className="flex items-start gap-1.5">
                  <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span>{t(LAYER_KEYS[layer])}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">{t('protection.noAppliedLayers')}</p>
          )}
          {snapshot.unmet.length > 0 ? (
            <ul className="space-y-1">
              {snapshot.unmet.map((reason) => (
                <li
                  key={reason.code}
                  data-slot={`protection-unmet-${reason.code}`}
                  className="flex items-start gap-1.5 text-destructive"
                >
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>{t(UNMET_KEYS[reason.code])}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {repairs.length > 0 ? (
            <ul className="space-y-1 text-muted-foreground">
              {repairs.map((repair) => (
                <li key={repair.code} data-slot={`protection-repair-${repair.code}`}>
                  {t('protection.repairLabel')}
                  {': '}
                  {t(REPAIR_KEYS[repair.code])}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    )
  }

  if (loadFailed) {
    return (
      <section data-slot="protection-unavailable" className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('protection.loadError')}</p>
        <Button variant="outline" size="sm" onClick={reload}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          {t('protection.reload')}
        </Button>
      </section>
    )
  }

  if (!matrix) {
    return (
      <section data-slot="protection-loading" className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('protection.loading')}</p>
      </section>
    )
  }

  return (
    <section className="space-y-5" data-slot="protection-panel">
      <p className="text-sm text-muted-foreground">{t('protection.intro')}</p>
      <p className="text-xs text-muted-foreground" data-slot="protection-weakest-link">
        {t('protection.weakestLinkNote')}
      </p>

      <div
        className="space-y-2 rounded-xl border border-border bg-card p-4"
        data-slot="protection-capability"
      >
        <div className="text-sm font-medium text-foreground">{t('protection.capabilityTitle')}</div>
        <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-3">
          <div>
            {t('protection.capabilityPlatform')}
            {': '}
            <span className="font-medium text-foreground">{matrix.platform}</span>
          </div>
          <div data-slot="protection-capability-os-write-guard">
            {t('protection.capabilityOsWriteGuard')}
            {': '}
            <span className="font-medium text-foreground">
              {matrix.osWriteGuard.available
                ? t('protection.capabilityOsWriteGuardAvailable')
                : matrix.osWriteGuard.componentPresent
                  ? t('protection.capabilityOsWriteGuardUnsupported')
                  : t('protection.capabilityOsWriteGuardComponentMissing', {
                      component: matrix.osWriteGuard.component
                    })}
            </span>
          </div>
          <div data-slot="protection-capability-network-allowlist">
            {t('protection.capabilityNetworkAllowlist')}
            {': '}
            <span className="font-medium text-foreground">
              {matrix.networkAllowlist.enabled ? t('protection.enabled') : t('protection.disabled')}
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="text-sm font-medium text-foreground">{t('protection.matrixTitle')}</div>
        {matrix.surfaces.map(surfaceRow)}
      </div>

      <div
        className="space-y-3 rounded-xl border border-border bg-card p-4"
        data-slot="protection-policy"
      >
        <div className="text-sm font-medium text-foreground">{t('protection.policyTitle')}</div>
        <p className="text-xs text-muted-foreground">{t('protection.policyHint')}</p>
        <div className="space-y-2">
          {POLICY_ORDER.map((policy) => (
            <label
              key={policy}
              data-slot={`protection-policy-${policy}`}
              className={cn(
                'flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-xs transition-colors',
                matrix.remoteUnprotectedPolicy === policy
                  ? 'border-primary/50 bg-primary/5'
                  : 'border-border hover:bg-muted'
              )}
            >
              <input
                type="radio"
                name="protection-remote-policy"
                className="mt-0.5"
                checked={matrix.remoteUnprotectedPolicy === policy}
                disabled={isSavingPolicy}
                onChange={() => selectPolicy(policy)}
              />
              <span className="space-y-1">
                <span className="block text-sm font-medium text-foreground">
                  {t(POLICY_KEYS[policy].label)}
                </span>
                <span className="block text-muted-foreground">{t(POLICY_KEYS[policy].hint)}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
    </section>
  )
}

export { ExecutionProtectionPanel }
