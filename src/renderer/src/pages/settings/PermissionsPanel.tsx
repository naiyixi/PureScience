import { useLanguage, type TranslationKey } from '@/i18n'
import { AlertTriangle, Shield, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { AlertDialog } from 'radix-ui'

import type { PermissionProfileId } from '../../../../shared/permission-profiles'
import type {
  PermissionGrantFamily,
  PermissionGrantSnapshot,
  PermissionGrantScope,
  PermissionGrantView
} from '../../../../shared/permission-grants'
import { Button } from '@/components/ui/button'
import {
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { usePermissionGrantsStore } from '@/stores/permission-grants-store'
import { useSettingsStore } from '@/stores/settings-store'
import { cn } from '@/lib/utils'
import { SettingsIconAction, SettingsRow, SettingsSection } from './SettingsLayout'

type ScopeFilter = 'all' | PermissionGrantScope['kind']

const FAMILY_DETAILS: ReadonlyArray<{
  id: PermissionGrantFamily
  title: TranslationKey
  description: TranslationKey
}> = [
  {
    id: 'registry_writes',
    title: 'settings.registryWrites',
    description: 'settings.registryWritesHint'
  },
  {
    id: 'local_compute',
    title: 'settings.localCompute',
    description: 'settings.localComputeHint'
  },
  {
    id: 'connectors',
    title: 'settings.connectors',
    description: 'settings.approvedMcpTools'
  },
  {
    id: 'file_operations',
    title: 'settings.fileOperations',
    description: 'settings.fileOperationsHint'
  },
  {
    id: 'skills',
    title: 'settings.skills',
    description: 'settings.skillInvocation'
  },
  {
    id: 'built_in_tools',
    title: 'settings.builtInTools',
    description: 'settings.builtInToolsHint'
  }
]

const FILTER_LABELS: Record<ScopeFilter, string> = {
  all: 'All',
  global: 'Global',
  project: 'Project',
  session: 'Session'
}

const INCOMPLETE_STORE_LABELS: Record<
  PermissionGrantSnapshot['incompleteStores'][number],
  TranslationKey
> = {
  projects: 'settings.projectNames',
  sessions: 'settings.sessionNames',
  connector_policy: 'settings.connectorPolicy'
}

const PERMISSION_PROFILES: ReadonlyArray<{
  id: PermissionProfileId
  label: TranslationKey
  description: TranslationKey
  icon: typeof ShieldAlert
}> = [
  {
    id: 'ask',
    label: 'settings.askForApproval',
    description: 'settings.askForApprovalHint',
    icon: Shield
  },
  {
    id: 'auto',
    label: 'settings.autoApproveEdits',
    description: 'settings.autoApproveEditsHint',
    icon: ShieldCheck
  },
  {
    id: 'full',
    label: 'settings.fullAccess',
    description: 'settings.fullAccessHint',
    icon: ShieldAlert
  }
]

const permissionProfileLabel = (
  profile: PermissionProfileId,
  t: (key: TranslationKey) => string
): string =>
  PERMISSION_PROFILES.find((candidate) => candidate.id === profile)?.label
    ? t(PERMISSION_PROFILES.find((candidate) => candidate.id === profile)!.label)
    : t('settings.askForApproval')

const PermissionRow = ({
  grant,
  onRevoke,
  onOpenConnector,
  onOpenSession
}: {
  grant: PermissionGrantView
  onRevoke: (grant: PermissionGrantView) => void
  onOpenConnector?: (serverId: string) => void
  onOpenSession?: (sessionId: string) => void
}): React.JSX.Element => {
  const sessionId = grant.scopeKind === 'session' ? grant.sessionId : undefined
  const scopeClassName =
    'col-start-1 row-start-2 max-w-full justify-self-start truncate rounded-md bg-muted px-2 py-1 text-sm text-muted-foreground sm:col-start-2 sm:row-start-1 sm:max-w-80'

  return (
    <div
      data-slot="permission-row"
      className="group grid min-h-11 min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 transition-colors duration-150 motion-reduce:transition-none hover:bg-muted/45 focus-within:bg-muted/45 sm:grid-cols-[minmax(0,1fr)_auto_2rem]"
    >
      <div className="min-w-0">
        <div>
          <span className="text-sm text-foreground">{grant.capabilityLabel}</span>
          {grant.qualifierLabel ? (
            <span className="ml-2 text-sm text-muted-foreground">{grant.qualifierLabel}</span>
          ) : null}
        </div>
        {grant.coveredBy ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            Also allowed {grant.coveredBy === 'global' ? 'globally' : 'for this project'}
          </p>
        ) : null}
        {grant.policyHint ? (
          <button
            type="button"
            className="mt-0.5 block rounded-sm text-left text-xs text-muted-foreground underline-offset-2 outline-none transition-colors duration-150 motion-reduce:transition-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={() =>
              grant.connectorServerId ? onOpenConnector?.(grant.connectorServerId) : undefined
            }
          >
            {grant.policyHint}
          </button>
        ) : null}
      </div>
      {sessionId && onOpenSession ? (
        <button
          type="button"
          title={grant.scopeLabel}
          aria-label={`Open ${grant.scopeLabel}`}
          className={`${scopeClassName} cursor-pointer transition-colors duration-150 motion-reduce:transition-none outline-none hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50`}
          onClick={() => onOpenSession(sessionId)}
        >
          {grant.scopeLabel}
        </button>
      ) : (
        <span title={grant.scopeLabel} className={scopeClassName}>
          {grant.scopeLabel}
        </span>
      )}
      <SettingsIconAction
        label={`Revoke ${grant.capabilityLabel}`}
        icon={X}
        danger
        className="relative col-start-2 row-span-2 row-start-1 size-8 shrink-0 opacity-100 transition-opacity duration-150 motion-reduce:transition-none before:absolute before:-inset-1.5 before:content-[''] sm:col-start-3 sm:row-span-1 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100"
        onClick={() => onRevoke(grant)}
      />
    </div>
  )
}

const PermissionsPanel = ({
  onOpenConnector,
  onOpenSession
}: {
  onOpenConnector?: (serverId: string) => void
  onOpenSession?: (sessionId: string) => void
}): React.JSX.Element => {
  const { t } = useLanguage()
  const grants = usePermissionGrantsStore((state) => state.grants)
  const counts = usePermissionGrantsStore((state) => state.counts)
  const incompleteStores = usePermissionGrantsStore((state) => state.incompleteStores)
  const status = usePermissionGrantsStore((state) => state.status)
  const error = usePermissionGrantsStore((state) => state.error)
  const load = usePermissionGrantsStore((state) => state.load)
  const revoke = usePermissionGrantsStore((state) => state.revoke)
  const defaultPermissionProfile = useSettingsStore((state) => state.defaultPermissionProfile)
  const setDefaultPermissionProfile = useSettingsStore((state) => state.setDefaultPermissionProfile)
  const [filter, setFilter] = useState<ScopeFilter>('all')
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  const visible = useMemo(
    () => grants.filter((grant) => filter === 'all' || grant.scopeKind === filter),
    [filter, grants]
  )

  const selectDefaultProfile = (profile: PermissionProfileId): void => {
    if (profile === defaultPermissionProfile) return
    if (profile === 'full') {
      setConfirmFullAccess(true)
      return
    }
    void setDefaultPermissionProfile(profile)
  }

  return (
    <div className="px-5 pb-5">
      <SettingsSection
        title={t('settings.newConversations')}
        description={t('settings.permissionsModeDesc2')}
        aria-label={t('settings.newConversationPermissions')}
        className="pt-5"
      >
        <SettingsRow
          label={t('settings.defaultPermissionMode')}
          description={t('settings.defaultPermissionModeHint2')}
          className="pt-0"
        >
          <Select
            value={defaultPermissionProfile}
            onValueChange={(value) => selectDefaultProfile(value as PermissionProfileId)}
          >
            <SelectTrigger aria-label={t('settings.defaultPermissionMode')}>
              <span>{permissionProfileLabel(defaultPermissionProfile, t)}</span>
            </SelectTrigger>
            <SelectContent className="w-[min(24rem,calc(100vw-2rem))]">
              {PERMISSION_PROFILES.map((profile) => {
                const Icon = profile.icon
                const isFull = profile.id === 'full'

                return (
                  <SelectItem
                    key={profile.id}
                    value={profile.id}
                    icon={
                      <Icon
                        className={cn('size-4', isFull && 'text-amber-600 dark:text-amber-400')}
                        aria-hidden="true"
                      />
                    }
                    className="items-start py-2"
                  >
                    <span className="block min-w-0 pr-1">
                      <span
                        className={cn(
                          'block font-medium leading-5',
                          isFull && 'text-amber-600 dark:text-amber-400'
                        )}
                      >
                        {t(profile.label)}
                      </span>
                      <span
                        className={cn(
                          'block text-xs leading-4 text-muted-foreground whitespace-normal',
                          isFull && 'text-amber-600/75 dark:text-amber-400/75'
                        )}
                      >
                        {t(profile.description)}
                      </span>
                    </span>
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
        </SettingsRow>

        {defaultPermissionProfile === 'full' ? (
          <div
            role="status"
            className="mt-1 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-300"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {t('settings.newConvosKeepMode')}
          </div>
        ) : null}
      </SettingsSection>

      <div className="sticky top-0 z-10 -mx-5 mt-5 mb-2 border-t border-border bg-card px-5 py-5">
        <div className="mb-3">
          <h3 className="text-base font-semibold text-foreground">
            {t('settings.rememberedPermissions')}
          </h3>
          <p className="mt-0.5 max-w-2xl text-[13px] leading-5 text-muted-foreground">
            {t('settings.rememberedPermissionsDesc')}
          </p>
        </div>
        <Select value={filter} onValueChange={(value) => setFilter(value as ScopeFilter)}>
          <SelectTrigger
            aria-label={t('settings.filterPermissionsByScope')}
            className="w-full max-w-72 whitespace-nowrap [font-variant-numeric:tabular-nums]"
          >
            {FILTER_LABELS[filter]} ({counts[filter]})
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(FILTER_LABELS) as ScopeFilter[]).map((scope) => (
              <SelectItem key={scope} value={scope}>
                {FILTER_LABELS[scope]} ({counts[scope]})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {incompleteStores.length > 0 ? (
        <div role="status" className="mb-4 rounded-lg border border-border bg-muted/35 px-3 py-2">
          <p className="text-sm text-foreground">{t('settings.permissionDetailsUnavailable')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {incompleteStores.map((store) => t(INCOMPLETE_STORE_LABELS[store])).join(', ')}{' '}
            {t('settings.rememberedGrantsIncomplete')}
          </p>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <p>{error}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void load()}
          >
            Try again
          </Button>
        </div>
      ) : null}

      <div className="scroll-pb-24">
        {status === 'loading' && grants.length === 0 ? (
          <div className="space-y-3" aria-label="Loading permissions">
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                className="h-11 animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
              />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <p className="sr-only" role="status">
            {t('settings.rememberedPermissionsNone')}
          </p>
        ) : (
          <div className="space-y-5">
            {FAMILY_DETAILS.map(({ id, title, description }) => {
              const familyGrants = visible.filter((grant) => grant.family === id)
              if (familyGrants.length === 0) return null

              return (
                <SettingsSection
                  key={id}
                  title={t(title)}
                  titleId={`permission-family-${id}`}
                  description={t(description)}
                  action={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Revoke all ${filter === 'all' ? '' : `${FILTER_LABELS[filter]} `}${title} permissions`}
                      disabled={incompleteStores.length > 0}
                      className="whitespace-nowrap"
                      onClick={() => void revoke(familyGrants)}
                    >
                      Revoke all
                    </Button>
                  }
                  aria-labelledby={`permission-family-${id}`}
                  className="border-b border-border pb-4 last:border-b-0 last:pb-0"
                  headerClassName="flex-col gap-3 sm:flex-row sm:items-start"
                  actionClassName="self-start"
                  contentClassName="mt-1"
                >
                  <div>
                    {familyGrants.map((grant) => (
                      <PermissionRow
                        key={grant.id}
                        grant={grant}
                        onRevoke={(item) => void revoke([item])}
                        onOpenConnector={onOpenConnector}
                        onOpenSession={onOpenSession}
                      />
                    ))}
                  </div>
                </SettingsSection>
              )
            })}
          </div>
        )}
      </div>

      <AlertDialog.Root open={confirmFullAccess} onOpenChange={setConfirmFullAccess}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={cn(dialogOverlayClassName, 'z-[60]')} />
          <AlertDialog.Content
            className={dialogPanelClassName(
              'z-[60] w-[min(440px,calc(100vw-2rem))] overscroll-contain'
            )}
          >
            <div className={dialogHeaderClassName}>
              <div className="flex min-w-0 items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                  <AlertTriangle className="size-5" strokeWidth={2} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <AlertDialog.Title className={dialogTitleClassName}>
                    Use Full access by default?
                  </AlertDialog.Title>
                  <AlertDialog.Description className={dialogDescriptionClassName}>
                    {t('settings.newConvosNotebook')}
                    {t('settings.newConvosRunWithoutAsking')}
                  </AlertDialog.Description>
                </div>
              </div>
              <AlertDialog.Cancel asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close"
                  className={dialogCloseButtonClassName}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </AlertDialog.Cancel>
            </div>
            <div className={dialogFooterClassName}>
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button
                  type="button"
                  className="bg-amber-600 text-white hover:bg-amber-700"
                  onClick={() => void setDefaultPermissionProfile('full')}
                >
                  Use Full access
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  )
}

export { PermissionsPanel }
