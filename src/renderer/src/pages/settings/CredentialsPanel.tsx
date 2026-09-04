/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertDialog } from 'radix-ui'
import {
  BookOpen,
  Cloud,
  Cpu,
  KeyRound,
  Loader2,
  Plus,
  Server,
  ShieldCheck,
  Trash2
} from 'lucide-react'

import { useLanguage, type TranslationKey } from '@/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { GitHubMark } from '@/components/GitHubStarBadge'
import {
  dialogDescriptionClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import type {
  CredentialServiceId,
  CredentialTestResult,
  CredentialView,
  SetCredentialRequest
} from '../../../../shared/settings'

// The 8 built-in service kinds (the reference catalog) + custom. Display labels come from i18n by
// key so the panel stays translatable; these are the stable service ids.
const BUILTIN_SERVICE_IDS: readonly CredentialServiceId[] = [
  'aws',
  'github',
  'gcp',
  'azure',
  'modal',
  'nvidia',
  'openalex',
  'literature'
]

const SERVICE_LABEL_KEYS: Record<CredentialServiceId, TranslationKey> = {
  aws: 'settings.credentialsServiceAws',
  github: 'settings.credentialsServiceGithub',
  gcp: 'settings.credentialsServiceGcp',
  azure: 'settings.credentialsServiceAzure',
  modal: 'settings.credentialsServiceModal',
  nvidia: 'settings.credentialsServiceNvidia',
  openalex: 'settings.credentialsServiceOpenalex',
  literature: 'settings.credentialsServiceLiterature',
  custom: 'settings.credentialsServiceCustom'
}

const serviceLabel = (t: (key: TranslationKey) => string, serviceId: CredentialServiceId): string =>
  t(SERVICE_LABEL_KEYS[serviceId])

// Service identity chips. Built-in scientific services have no bundled brand assets (the app never
// ships third-party marks it does not own), so each row gets a neutral glyph that reads as the
// service's kind; GitHub is the one official mark we carry (inline octocat, see GitHubStarBadge).
const SERVICE_ICONS: Record<CredentialServiceId, React.ComponentType<{ className?: string }>> = {
  aws: Cloud,
  github: GitHubMark,
  gcp: Cloud,
  azure: Cloud,
  modal: Server,
  nvidia: Cpu,
  openalex: BookOpen,
  literature: BookOpen,
  custom: KeyRound
}

type CredentialsStore = {
  credentials: CredentialView[]
  isLoading: boolean
  load: () => Promise<void>
  set: (request: SetCredentialRequest) => Promise<void>
  remove: (id: string) => Promise<void>
  test: (id: string, secret?: string) => Promise<CredentialTestResult>
}

const useCredentialsStore = (): CredentialsStore => {
  const [credentials, setCredentials] = useState<CredentialView[]>([])
  // Start loading: the first render happens before the async read resolves, and the initial
  // state is the loading state (no synchronous setState inside the effect).
  const [isLoading, setIsLoading] = useState(true)

  const load = useCallback(async (): Promise<void> => {
    try {
      setCredentials(await window.api.settings.getCredentials())
    } finally {
      setIsLoading(false)
    }
  }, [])

  const set = useCallback(async (request: SetCredentialRequest): Promise<void> => {
    const view = await window.api.settings.setCredential(request)
    setCredentials((current) => {
      const exists = current.some((credential) => credential.id === view.id)
      return exists
        ? current.map((credential) => (credential.id === view.id ? view : credential))
        : [...current, view]
    })
  }, [])

  const remove = useCallback(async (id: string): Promise<void> => {
    setCredentials(await window.api.settings.deleteCredential(id))
  }, [])

  const test = useCallback(
    (id: string, secret?: string): Promise<CredentialTestResult> =>
      window.api.settings.testCredential({ id, secret }),
    []
  )

  useEffect(() => {
    void load()
  }, [load])

  return { credentials, isLoading, load, set, remove, test }
}

// One saved credential. `variant="plain"` drops the card chrome so rows can sit flush inside a
// divided section list (the three-section layout); the default keeps the standalone card used by
// the custom section when it lists many entries.
const CredentialRow = ({
  credential,
  variant = 'card',
  onEdit,
  onDelete
}: {
  credential: CredentialView
  variant?: 'card' | 'plain'
  onEdit: () => void
  onDelete: () => void
}): React.JSX.Element => {
  const { t } = useLanguage()
  return (
    <div
      data-slot="credential-row"
      className={cn(
        'flex items-center justify-between',
        variant === 'card' && 'rounded-lg border border-border bg-bg-00 px-3 py-2.5'
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[13px] text-text-100">
          <span className="truncate">{credential.name}</span>
          {credential.hasSecret ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-bg-200 px-2 py-0.5 text-[11px] text-text-200">
              <ShieldCheck className="size-3" aria-hidden="true" />
              {t('settings.credentialsSaved')}
            </span>
          ) : (
            <span className="rounded-full bg-bg-200 px-2 py-0.5 text-[11px] text-text-300">
              {t('settings.credentialsNotConfigured')}
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[12px] text-text-300">
          {credential.username ? `${credential.username} · ` : ''}
          {credential.hint ?? '—'}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          data-slot="credential-edit"
          className="rounded-md px-2 py-1 text-[12px] text-text-200 outline-none hover:bg-bg-200 hover:text-text-100 focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={onEdit}
        >
          {t('settings.credentialsEdit')}
        </button>
        <button
          type="button"
          data-slot="credential-delete"
          aria-label={t('settings.credentialsDelete')}
          className="rounded-md p-1.5 text-text-300 outline-none hover:bg-danger-000/10 hover:text-danger-000 focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

const CredentialEditor = ({
  credential,
  serviceId,
  onCancel,
  onSaved,
  store
}: {
  credential?: CredentialView
  serviceId: CredentialServiceId
  onCancel: () => void
  onSaved: () => void
  store: CredentialsStore
}): React.JSX.Element => {
  const { t } = useLanguage()
  const [username, setUsername] = useState(credential?.username ?? '')
  const [name, setName] = useState(credential?.name ?? '')
  const [secret, setSecret] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [testResult, setTestResult] = useState<CredentialTestResult | undefined>(undefined)
  const isCustom = serviceId === 'custom'

  const save = async (): Promise<void> => {
    setIsSaving(true)
    try {
      await store.set({
        ...(credential ? { id: credential.id } : {}),
        serviceId,
        ...(isCustom && name.trim() ? { name: name.trim() } : {}),
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(secret.trim() ? { secret: secret.trim() } : {})
      })
      // Guided-recovery loop: when a secret was (re)entered, re-probe it right away. Pass = close,
      // fail = stay open with targeted recovery guidance so the user can fix and retry in place.
      if (secret.trim()) {
        const result = await store.test(credential?.id ?? '', secret.trim() || undefined)
        setTestResult(result)
        if (result.ok) onSaved()
      } else {
        onSaved()
      }
    } finally {
      setIsSaving(false)
    }
  }

  const test = async (): Promise<void> => {
    if (!credential && !secret.trim()) return
    setIsTesting(true)
    try {
      setTestResult(await store.test(credential?.id ?? '', secret.trim() || undefined))
    } finally {
      setIsTesting(false)
    }
  }

  return (
    <div data-slot="credential-editor" className="flex min-w-0 flex-1 flex-col">
      <div className="border-b border-border px-4 py-2.5">
        <span className="text-[13px] font-medium text-text-100">
          {isCustom && name.trim() ? name.trim() : serviceLabel(t, serviceId)}
        </span>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {isCustom ? (
          <div>
            <label
              htmlFor="credential-name"
              className="mb-1 block text-[12px] font-medium text-text-100"
            >
              {t('settings.credentialsCustomNameLabel')}
            </label>
            <input
              id="credential-name"
              data-slot="credential-name-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('settings.credentialsCustomNamePlaceholder')}
              className="w-full rounded-md border border-border bg-bg-00 px-3 py-2 text-[12px] text-text-100 outline-none placeholder:text-text-300 focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </div>
        ) : null}
        <div>
          <label
            htmlFor="credential-username"
            className="mb-1 block text-[12px] font-medium text-text-100"
          >
            {t('settings.credentialsUsernameLabel')}
          </label>
          <input
            id="credential-username"
            data-slot="credential-username-input"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder={t('settings.credentialsUsernamePlaceholder')}
            className="w-full rounded-md border border-border bg-bg-00 px-3 py-2 text-[12px] text-text-100 outline-none placeholder:text-text-300 focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </div>
        <div>
          <label
            htmlFor="credential-secret"
            className="mb-1 block text-[12px] font-medium text-text-100"
          >
            {t('settings.credentialsSecretLabel')}
          </label>
          <input
            id="credential-secret"
            data-slot="credential-secret-input"
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder={
              credential?.hasSecret
                ? (credential.hint ?? t('settings.credentialsSecretPlaceholder'))
                : t('settings.credentialsSecretPlaceholder')
            }
            className="w-full rounded-md border border-border bg-bg-00 px-3 py-2 text-[12px] text-text-100 outline-none placeholder:text-text-300 focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </div>
        {testResult ? (
          <div
            role="status"
            data-slot="credential-test-result"
            className={cn(
              'rounded-lg border px-3 py-2 text-[12px] leading-5',
              testResult.ok
                ? 'border-bg-200 bg-bg-00 text-text-200'
                : 'border-danger-000/40 bg-danger-000/10 text-danger-000'
            )}
          >
            {testResult.ok
              ? t('settings.credentialsTestOk')
              : t('settings.credentialsTestFail').replace(
                  '{message}',
                  testResult.message ?? testResult.detail ?? ''
                )}
            {!testResult.ok && testResult.kind ? (
              <p className="mt-1 text-[11px] leading-4 opacity-80">
                {t(
                  testResult.kind === 'auth'
                    ? 'settings.credentialsRecoveryAuth'
                    : testResult.kind === 'network'
                      ? 'settings.credentialsRecoveryNetwork'
                      : testResult.kind === 'format'
                        ? 'settings.credentialsRecoveryFormat'
                        : 'settings.credentialsRecoveryUnknown'
                )}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-between border-t border-border px-4 py-3">
        <Button
          type="button"
          variant="outline"
          data-slot="credential-test-button"
          disabled={isTesting || (!credential && !secret.trim())}
          onClick={() => void test()}
        >
          {isTesting ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            t('settings.credentialsTest')
          )}
        </Button>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            data-slot="credential-save-button"
            disabled={isSaving || (isCustom && !name.trim())}
            onClick={() => void save()}
          >
            {isSaving ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              t('settings.credentialsSave')
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

// Unified credential store panel, aligned to the three-section credentials layout (reference
// 20.05.22): ① 服务 — one row per built-in scientific service with an identity chip and a
// saved/not-configured state plus a manage/add action; ② 连接器凭据 — the device-global named
// credentials that custom connectors and endpoints can reference (empty state + new action);
// ③ 自定义 — the note that Custom MCP Connectors and model providers keep their credentials in
// their own configuration. All three share the same encrypted store and CRUD flow; no new
// backends.
export const CredentialsPanel = (): React.JSX.Element => {
  const { t } = useLanguage()
  const store = useCredentialsStore()
  const [editing, setEditing] = useState<
    { kind: 'edit'; credential: CredentialView } | { kind: 'new'; serviceId: CredentialServiceId }
  >()
  const [pendingDelete, setPendingDelete] = useState<CredentialView | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const byService = useMemo(() => {
    const result = new Map<CredentialServiceId, CredentialView[]>()
    for (const credential of store.credentials) {
      const list = result.get(credential.serviceId) ?? []
      list.push(credential)
      result.set(credential.serviceId, list)
    }
    return result
  }, [store.credentials])

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    setIsDeleting(true)
    try {
      await store.remove(pendingDelete.id)
      setPendingDelete(null)
    } finally {
      setIsDeleting(false)
    }
  }

  const renderServiceRow = (serviceId: CredentialServiceId): React.JSX.Element => {
    const entries = byService.get(serviceId) ?? []
    const Icon = SERVICE_ICONS[serviceId]
    return (
      <div
        key={serviceId}
        data-slot={`credential-service-${serviceId}`}
        className="flex items-center gap-3 px-3 py-2.5"
      >
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-bg-00 text-text-200"
        >
          <Icon className="size-4" />
        </span>
        {entries.length === 0 ? (
          <>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13px] text-text-100">
                <span className="truncate font-medium">{serviceLabel(t, serviceId)}</span>
                <span className="rounded-full bg-bg-200 px-2 py-0.5 text-[11px] text-text-300">
                  {t('settings.credentialsNotConfigured')}
                </span>
              </div>
              <div className="mt-0.5 text-[12px] text-text-300">
                {t('settings.credentialsEmpty')}
              </div>
            </div>
            <button
              type="button"
              data-slot="credential-add"
              className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-text-200 outline-none hover:bg-bg-200 hover:text-text-100 focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={() => setEditing({ kind: 'new', serviceId })}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t('settings.credentialsEdit')}
            </button>
          </>
        ) : (
          <div className="min-w-0 flex-1 space-y-1">
            {entries.map((credential) => (
              <CredentialRow
                key={credential.id}
                credential={credential}
                variant="plain"
                onEdit={() => setEditing({ kind: 'edit', credential })}
                onDelete={() => setPendingDelete(credential)}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  const customEntries = byService.get('custom') ?? []
  const editingView = editing?.kind === 'edit' ? editing.credential : undefined
  const editingServiceId = editing
    ? editing.kind === 'edit'
      ? editing.credential.serviceId
      : editing.serviceId
    : undefined

  return (
    <div data-slot="credentials-panel" className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex items-start gap-2 px-4 pt-4">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-text-300" aria-hidden="true" />
        <div>
          <h2 className="text-[13px] font-medium text-text-100">{t('settings.credentials')}</h2>
          <p className="mt-0.5 max-w-xl text-[12px] leading-5 text-text-300">
            {t('settings.credentialsDescription')}
          </p>
        </div>
      </div>

      <div className="mt-4 min-h-0 flex-1 px-4 pb-4">
        {store.isLoading && store.credentials.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12px] text-text-300">
            {t('settings.memoryLoading')}
          </div>
        ) : editing && editingServiceId ? (
          <div className="mx-auto h-full w-full max-w-3xl overflow-hidden rounded-lg border border-border bg-bg-10">
            <CredentialEditor
              credential={editingView}
              serviceId={editingServiceId}
              onCancel={() => setEditing(undefined)}
              onSaved={() => setEditing(undefined)}
              store={store}
            />
          </div>
        ) : (
          <div className="mx-auto h-full w-full max-w-3xl space-y-7 overflow-y-auto pr-0.5">
            {/* Section ① 服务 — one manage row per built-in scientific service. */}
            {/* i18n note: heading copy ('Services') to be keyed by the parent — i18n files are frozen for this task. */}
            <section aria-label={t('settings.credentialsServicesHeading')}>
              <h3 className="text-[13px] font-medium text-text-100">
                {t('settings.credentialsServicesHeading')}
              </h3>
              <div className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border bg-bg-10">
                {BUILTIN_SERVICE_IDS.map(renderServiceRow)}
              </div>
            </section>

            {/* Section ② 连接器凭据 — device-global named credentials custom connectors and
                endpoints can reference; empty state + new-credential action. */}
            <section aria-label={t('settings.credentialsConnectorHeading')}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[13px] font-medium text-text-100">
                  {t('settings.credentialsConnectorHeading')}
                </h3>
                <button
                  type="button"
                  data-slot="credential-add-custom"
                  className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-text-200 outline-none hover:bg-bg-200 hover:text-text-100 focus-visible:ring-2 focus-visible:ring-ring/50"
                  onClick={() => setEditing({ kind: 'new', serviceId: 'custom' })}
                >
                  <Plus className="size-3.5" aria-hidden="true" />
                  {t('settings.credentialsAddCustom')}
                </button>
              </div>
              <p className="mt-0.5 text-[12px] leading-5 text-text-300">
                {t('settings.credentialsConnectorDescription')}
              </p>
              <div className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border bg-bg-10">
                {customEntries.length === 0 ? (
                  <div className="px-3 py-3 text-[12px] text-text-300">
                    {t('settings.credentialsConnectorEmpty')}
                  </div>
                ) : (
                  customEntries.map((credential) => (
                    <div key={credential.id} className="flex items-center gap-3 px-3 py-2.5">
                      <span
                        aria-hidden="true"
                        className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-bg-00 text-text-200"
                      >
                        <KeyRound className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <CredentialRow
                          credential={credential}
                          variant="plain"
                          onEdit={() => setEditing({ kind: 'edit', credential })}
                          onDelete={() => setPendingDelete(credential)}
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* Section ③ 自定义 — the note that Custom MCP Connectors and model providers keep
                their credentials in their own configuration (managed on their own settings
                panels), so nothing is duplicated here. */}
            <section aria-label={t('settings.credentialsServiceCustom')}>
              <h3 className="text-[13px] font-medium text-text-100">
                {t('settings.credentialsServiceCustom')}
              </h3>
              <p className="mt-1 text-[12px] leading-5 text-text-300">
                {t('settings.credentialsCustomDescription')}
              </p>
            </section>
          </div>
        )}
      </div>

      <AlertDialog.Root
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))]')}>
            <AlertDialog.Title className={dialogTitleClassName}>
              {t('settings.credentialsDeleteTitle')}
            </AlertDialog.Title>
            <AlertDialog.Description className={dialogDescriptionClassName}>
              {t('settings.credentialsDeleteDescription').replace(
                '{name}',
                pendingDelete?.name ?? ''
              )}
            </AlertDialog.Description>
            <div className="mt-6 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="outline" disabled={isDeleting}>
                  {t('common.cancel')}
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button
                  type="button"
                  variant="destructive"
                  data-slot="credential-delete-confirm"
                  disabled={isDeleting}
                  onClick={() => void confirmDelete()}
                >
                  {t('common.delete')}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  )
}
