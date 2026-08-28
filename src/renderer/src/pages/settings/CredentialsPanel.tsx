/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertDialog } from 'radix-ui'
import { KeyRound, Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react'

import { useLanguage, type TranslationKey } from '@/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
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

const CredentialRow = ({
  credential,
  onEdit,
  onDelete
}: {
  credential: CredentialView
  onEdit: () => void
  onDelete: () => void
}): React.JSX.Element => {
  const { t } = useLanguage()
  return (
    <div
      data-slot="credential-row"
      className="flex items-center justify-between rounded-lg border border-border bg-bg-00 px-3 py-2.5"
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
      onSaved()
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

// Unified credential store panel: 8 built-in scientific services + custom entries. Each entry holds
// an optional non-secret username and an encrypted secret; the panel never sees plaintext.
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
    const label = serviceLabel(t, serviceId)
    return (
      <div key={serviceId} className="space-y-2" data-slot={`credential-service-${serviceId}`}>
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium text-text-100">{label}</span>
          {entries.length === 0 ? (
            <button
              type="button"
              data-slot="credential-add"
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-text-200 outline-none hover:bg-bg-200 hover:text-text-100 focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={() => setEditing({ kind: 'new', serviceId })}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t('settings.credentialsEdit')}
            </button>
          ) : null}
        </div>
        {entries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-2.5 text-[12px] text-text-300">
            {t('settings.credentialsEmpty')}
          </div>
        ) : (
          entries.map((credential) => (
            <CredentialRow
              key={credential.id}
              credential={credential}
              onEdit={() => setEditing({ kind: 'edit', credential })}
              onDelete={() => setPendingDelete(credential)}
            />
          ))
        )}
      </div>
    )
  }

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

      <div className="mt-4 flex min-h-0 flex-1 gap-4 overflow-hidden">
        <div className="flex w-44 shrink-0 flex-col overflow-y-auto rounded-lg border border-border bg-bg-10 p-2">
          {BUILTIN_SERVICE_IDS.map((serviceId) => (
            <button
              key={serviceId}
              type="button"
              data-slot={`credential-nav-${serviceId}`}
              className={cn(
                'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                editingServiceId === serviceId
                  ? 'bg-bg-200 text-text-100'
                  : 'text-text-200 hover:bg-bg-100'
              )}
              onClick={() =>
                setEditing(
                  (byService.get(serviceId) ?? [])[0]
                    ? { kind: 'edit', credential: (byService.get(serviceId) ?? [])[0] }
                    : { kind: 'new', serviceId }
                )
              }
            >
              <span className="min-w-0 truncate">{serviceLabel(t, serviceId)}</span>
              <span className="ml-1 shrink-0 text-[11px] text-text-300">
                {(byService.get(serviceId) ?? []).length}
              </span>
            </button>
          ))}
        </div>

        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto rounded-lg border border-border bg-bg-10">
          {store.isLoading && store.credentials.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-[12px] text-text-300">
              {t('settings.memoryLoading')}
            </div>
          ) : editing && editingServiceId ? (
            <CredentialEditor
              credential={editingView}
              serviceId={editingServiceId}
              onCancel={() => setEditing(undefined)}
              onSaved={() => setEditing(undefined)}
              store={store}
            />
          ) : (
            <div className="space-y-6 p-4">
              {BUILTIN_SERVICE_IDS.map(renderServiceRow)}
              <div className="border-t border-border pt-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[13px] font-medium text-text-100">
                    {serviceLabel(t, 'custom')}
                  </span>
                  <button
                    type="button"
                    data-slot="credential-add-custom"
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-text-200 outline-none hover:bg-bg-200 hover:text-text-100 focus-visible:ring-2 focus-visible:ring-ring/50"
                    onClick={() => setEditing({ kind: 'new', serviceId: 'custom' })}
                  >
                    <Plus className="size-3.5" aria-hidden="true" />
                    {t('settings.credentialsAddCustom')}
                  </button>
                </div>
                {(byService.get('custom') ?? []).map((credential) => (
                  <div key={credential.id} className="mt-2">
                    <CredentialRow
                      credential={credential}
                      onEdit={() => setEditing({ kind: 'edit', credential })}
                      onDelete={() => setPendingDelete(credential)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
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
