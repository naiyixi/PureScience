/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */

import { AlertTriangle, FileJson, Upload } from 'lucide-react'
import { useState } from 'react'

import {
  CONNECTOR_TEMPLATE_MAX_BYTES,
  type ConnectorTemplateDefinition,
  type ConnectorTemplateDiagnostic,
  type ConnectorTemplateSelectionResult,
  type SelectCustomServerTemplateRequest
} from '../../../../shared/settings'
import { useLanguage, type TranslationKey } from '@/i18n'
import { FileDropOverlay } from '@/components/FileDropOverlay'
import { Button } from '@/components/ui/button'
import { useFileDropZone } from '@/hooks/useFileDropZone'

type ConnectorImportViewProps = {
  onUse: (definition: ConnectorTemplateDefinition) => void
  onCancel: () => void
}

const kb = (bytes: number): string => `${Math.round(bytes / 1024)} KB`

const diagnosticClassName = (diagnostic: ConnectorTemplateDiagnostic): string =>
  diagnostic.severity === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-destructive'

const transportLabel = (definition: ConnectorTemplateDefinition): TranslationKey =>
  definition.transport === 'stdio'
    ? 'settings.localCommand'
    : definition.transport === 'streamable_http'
      ? 'settings.streamableHttp'
      : 'settings.sse'

export function ConnectorImportView({
  onUse,
  onCancel
}: ConnectorImportViewProps): React.JSX.Element {
  const { t } = useLanguage()
  const [selection, setSelection] = useState<ConnectorTemplateSelectionResult>()
  const [selecting, setSelecting] = useState(false)
  const [error, setError] = useState<string>()

  const applySelection = async (request?: SelectCustomServerTemplateRequest): Promise<void> => {
    setSelecting(true)
    setError(undefined)
    try {
      const result = await window.api.settings.selectCustomServerTemplate(request)
      if (!result.cancelled) setSelection(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('settings.couldNotValidateConfig'))
    } finally {
      setSelecting(false)
    }
  }

  const handleFiles = async (files: File[]): Promise<void> => {
    if (selecting || files.length === 0) return
    setSelection(undefined)
    if (files.length !== 1) {
      setError(t('settings.chooseOneConnectorConfig'))
      return
    }
    const file = files[0]
    if (!file.name.toLowerCase().endsWith('.json')) {
      setError(t('settings.connectorConfigMustBeJson'))
      return
    }
    if (file.size > CONNECTOR_TEMPLATE_MAX_BYTES) {
      setError(t('settings.connectorTooLarge').replace('{limit}', kb(CONNECTOR_TEMPLATE_MAX_BYTES)))
      return
    }
    await applySelection({ fileName: file.name, contents: await file.text() })
  }

  const { isDragging, dropZoneProps } = useFileDropZone({
    enabled: !selecting,
    onFiles: (files) => void handleFiles(files)
  })

  const preview = selection && !selection.cancelled ? selection.preview : undefined
  const definition = preview?.definition
  const secretNames = [
    ...(definition?.requiredSecrets?.environment ?? []),
    ...(definition?.requiredSecrets?.headers ?? [])
  ]

  return (
    <div className="p-5">
      <div className="flex w-full flex-col gap-5">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            {t('settings.importConnectorConfig')}
          </h2>
          <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
            {t('settings.connectorBlurb')}
          </p>
        </div>

        <button
          type="button"
          {...dropZoneProps}
          disabled={selecting}
          onClick={() => void applySelection()}
          className="relative flex w-full cursor-pointer flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-muted/20 px-6 py-10 text-center transition-colors motion-reduce:transition-none hover:bg-muted/40 disabled:cursor-default disabled:opacity-60"
        >
          {isDragging ? (
            <FileDropOverlay label={t('connectorImport.dropToValidate')} className="rounded-lg" />
          ) : null}
          <span className="inline-flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Upload className="size-5" aria-hidden="true" />
          </span>
          <span className="text-sm font-medium text-foreground">
            {selecting ? t('settings.validating') : t('settings.dragDropOrClick')}
          </span>
          <span className="max-w-sm text-xs text-muted-foreground">
            {t('settings.connectorChooseJson').replace('{limit}', kb(CONNECTOR_TEMPLATE_MAX_BYTES))}
          </span>
        </button>

        {selection && !selection.cancelled ? (
          <p className="-mt-3 truncate text-center text-xs text-muted-foreground">
            {selection.fileName}
          </p>
        ) : null}

        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}

        {definition ? (
          <div>
            <div className="mb-2 flex items-center gap-2">
              <FileJson className="size-4 text-muted-foreground" aria-hidden="true" />
              <h3 className="text-sm font-medium text-foreground">
                {t('connectorImport.configPreview')}
              </h3>
            </div>
            <dl className="divide-y divide-border border-y border-border text-sm">
              <div className="grid grid-cols-[8rem_1fr] gap-3 py-2.5">
                <dt className="text-muted-foreground">{t('common.name')}</dt>
                <dd className="min-w-0 break-words text-foreground">{definition.name}</dd>
              </div>
              <div className="grid grid-cols-[8rem_1fr] gap-3 py-2.5">
                <dt className="text-muted-foreground">{t('connectorShare.transport')}</dt>
                <dd className="text-foreground">{t(transportLabel(definition))}</dd>
              </div>
              <div className="grid grid-cols-[8rem_1fr] gap-3 py-2.5">
                <dt className="text-muted-foreground">
                  {definition.transport === 'stdio' ? t('common.command') : t('common.serverUrl')}
                </dt>
                <dd className="min-w-0 break-all font-mono text-xs text-foreground">
                  {definition.transport === 'stdio'
                    ? [definition.command, ...(definition.args ?? [])].filter(Boolean).join(' ')
                    : definition.url}
                </dd>
              </div>
              <div className="grid grid-cols-[8rem_1fr] gap-3 py-2.5">
                <dt className="text-muted-foreground">{t('connectorShare.credentials')}</dt>
                <dd className="text-foreground">
                  {definition.oauth
                    ? t('settings.oauthAfterAdding')
                    : secretNames.length
                      ? t('settings.connectorEnterLocally').replace(
                          '{names}',
                          secretNames.join(', ')
                        )
                      : t('settings.noneDeclared')}
                </dd>
              </div>
            </dl>
          </div>
        ) : null}

        {preview?.diagnostics.length ? (
          <div className="space-y-2" aria-label={t('connectorImport.configDiagnostics')}>
            {preview.diagnostics.map((item) => (
              <div
                key={`${item.code}:${item.path ?? ''}`}
                className={`flex items-start gap-2 text-xs ${diagnosticClassName(item)}`}
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{item.message}</span>
              </div>
            ))}
          </div>
        ) : null}

        <div className={selection ? 'flex items-center justify-end gap-2' : 'text-center'}>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          {selection ? (
            <Button
              type="button"
              disabled={!preview?.ready || !definition}
              onClick={() => definition && onUse(definition)}
            >
              {t('connectorImport.useConfig')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
