// External compute endpoints section (ComputePanel): configure Modal serverless GPU endpoints
// and NVIDIA NIM inference endpoints. Secrets are referenced by Credentials-panel credential id
// and never stored here.

import { useCallback, useEffect, useState } from 'react'
import { Cpu, Plus, Trash2 } from 'lucide-react'

import { useLanguage, type TranslationKey } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type {
  CreateExternalComputeEndpointRequest,
  ExternalComputeEndpoint,
  ExternalComputeKind
} from '../../../../shared/compute'
import type { CredentialView } from '../../../../shared/settings'

const KIND_LABEL_KEYS: Record<ExternalComputeKind, TranslationKey> = {
  modal: 'settings.externalComputeAddModal',
  nvidia_nim: 'settings.externalComputeAddNim'
}

const KIND_HINT_KEYS: Record<ExternalComputeKind, TranslationKey> = {
  modal: 'settings.externalComputeModalHint',
  nvidia_nim: 'settings.externalComputeNimHint'
}

const EndpointEditor = ({
  kind,
  credentials,
  onCancel,
  onSaved
}: {
  kind: ExternalComputeKind
  credentials: CredentialView[]
  onCancel: () => void
  onSaved: (request: CreateExternalComputeEndpointRequest) => Promise<void>
}): React.JSX.Element => {
  const { t } = useLanguage()
  const [alias, setAlias] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [credentialId, setCredentialId] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [modelName, setModelName] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  const matchingCredentials =
    kind === 'modal'
      ? credentials.filter((credential) => credential.serviceId === 'modal')
      : credentials.filter((credential) => credential.serviceId === 'nvidia')

  const save = async (): Promise<void> => {
    if (!alias.trim() || !credentialId) return
    setIsSaving(true)
    try {
      await onSaved({
        kind,
        alias: alias.trim(),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        credentialId,
        ...(kind === 'nvidia_nim' && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(kind === 'nvidia_nim' && modelName.trim() ? { modelName: modelName.trim() } : {})
      })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div
      data-slot={`external-endpoint-form-${kind}`}
      className="mt-3 rounded-lg border border-border bg-card p-3"
    >
      <p className="text-xs leading-5 text-muted-foreground">{t(KIND_HINT_KEYS[kind])}</p>
      <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <div>
          <label
            htmlFor={`ext-alias-${kind}`}
            className="mb-1 block text-xs font-medium text-foreground"
          >
            {t('settings.externalComputeAlias')}
          </label>
          <Input
            id={`ext-alias-${kind}`}
            data-slot="external-endpoint-alias"
            value={alias}
            placeholder={t('settings.externalComputeAliasPlaceholder')}
            onChange={(event) => setAlias(event.target.value)}
          />
        </div>
        <div>
          <label
            htmlFor={`ext-name-${kind}`}
            className="mb-1 block text-xs font-medium text-foreground"
          >
            {t('settings.externalComputeDisplayName')}
          </label>
          <Input
            id={`ext-name-${kind}`}
            value={displayName}
            placeholder={alias}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <label
            htmlFor={`ext-cred-${kind}`}
            className="mb-1 block text-xs font-medium text-foreground"
          >
            {t('settings.externalComputeCredential')}
          </label>
          {matchingCredentials.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('settings.externalComputeNoCredentials')}
            </p>
          ) : (
            <select
              id={`ext-cred-${kind}`}
              data-slot="external-endpoint-credential"
              value={credentialId}
              onChange={(event) => setCredentialId(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <option value="" disabled>
                {t('settings.externalComputeCredential')}
              </option>
              {matchingCredentials.map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {credential.name} {credential.hint ? `(${credential.hint})` : ''}
                </option>
              ))}
            </select>
          )}
        </div>
        {kind === 'nvidia_nim' ? (
          <>
            <div className="sm:col-span-2">
              <label htmlFor="ext-url" className="mb-1 block text-xs font-medium text-foreground">
                {t('settings.externalComputeBaseUrl')}
              </label>
              <Input
                id="ext-url"
                data-slot="external-endpoint-base-url"
                value={baseUrl}
                placeholder={t('settings.externalComputeBaseUrlPlaceholder')}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="ext-model" className="mb-1 block text-xs font-medium text-foreground">
                {t('settings.externalComputeModel')}
              </label>
              <Input
                id="ext-model"
                data-slot="external-endpoint-model"
                value={modelName}
                placeholder={t('settings.externalComputeModelPlaceholder')}
                onChange={(event) => setModelName(event.target.value)}
              />
            </div>
          </>
        ) : null}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          data-slot="external-endpoint-save"
          disabled={isSaving || !alias.trim() || !credentialId}
          onClick={() => void save()}
        >
          {t('settings.externalComputeSave')}
        </Button>
      </div>
    </div>
  )
}

export const ExternalComputeSection = (): React.JSX.Element => {
  const { t } = useLanguage()
  const [endpoints, setEndpoints] = useState<ExternalComputeEndpoint[]>([])
  const [credentials, setCredentials] = useState<CredentialView[]>([])
  const [loaded, setLoaded] = useState(false)
  const [draftKind, setDraftKind] = useState<ExternalComputeKind | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.api.settings.getExternalComputeEndpoints(),
      window.api.settings.getCredentials()
    ]).then(([endpointList, credentialList]) => {
      if (cancelled) return
      setEndpoints(endpointList)
      setCredentials(credentialList)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback(async (request: CreateExternalComputeEndpointRequest): Promise<void> => {
    setEndpoints(await window.api.settings.setExternalComputeEndpoint(request))
    setDraftKind(undefined)
  }, [])

  const remove = useCallback(async (providerId: string): Promise<void> => {
    setEndpoints(await window.api.settings.deleteExternalComputeEndpoint(providerId))
  }, [])

  if (!loaded) {
    return (
      <div className="mt-6 rounded-xl border border-border bg-card p-4">
        <p className="text-xs text-muted-foreground">{t('settings.loading')}</p>
      </div>
    )
  }

  return (
    <section
      className="mt-6 rounded-xl border border-border bg-card p-4"
      data-slot="external-compute-section"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Cpu className="size-4 text-muted-foreground" aria-hidden="true" />
            {t('settings.externalCompute')}
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t('settings.externalComputeDesc')}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-slot="external-endpoint-add-modal"
            onClick={() => setDraftKind(draftKind === 'modal' ? undefined : 'modal')}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {t('settings.externalComputeAddModal')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-slot="external-endpoint-add-nim"
            onClick={() => setDraftKind(draftKind === 'nvidia_nim' ? undefined : 'nvidia_nim')}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {t('settings.externalComputeAddNim')}
          </Button>
        </div>
      </div>

      {draftKind ? (
        <EndpointEditor
          key={draftKind}
          kind={draftKind}
          credentials={credentials}
          onCancel={() => setDraftKind(undefined)}
          onSaved={save}
        />
      ) : null}

      <div className="mt-4 flex flex-col gap-2.5">
        {endpoints.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {t('settings.externalComputeNone')}
          </p>
        ) : (
          endpoints.map((endpoint) => (
            <div
              key={endpoint.providerId}
              data-slot="external-endpoint-row"
              className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm text-foreground">
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[11px] font-medium',
                      endpoint.kind === 'modal'
                        ? 'bg-muted text-foreground'
                        : 'bg-primary/10 text-primary'
                    )}
                  >
                    {t(KIND_LABEL_KEYS[endpoint.kind]).replace('Add ', '')}
                  </span>
                  <span className="truncate">{endpoint.displayName}</span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {endpoint.providerId}
                  {endpoint.baseUrl ? ` · ${endpoint.baseUrl}` : ''}
                  {endpoint.modelName ? ` · ${endpoint.modelName}` : ''}
                </p>
              </div>
              <button
                type="button"
                aria-label={t('settings.externalComputeDelete')}
                data-slot={`external-endpoint-delete-${endpoint.providerId}`}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                onClick={() => void remove(endpoint.providerId)}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
