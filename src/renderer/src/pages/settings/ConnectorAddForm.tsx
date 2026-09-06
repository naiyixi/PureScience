import { useMemo, useState } from 'react'
import { useLanguage, type TranslationKey } from '@/i18n'

import type {
  AddCustomServerRequest,
  ConnectorTemplateDefinition,
  CustomServerTransport,
  CustomServerView,
  UpdateCustomServerRequest
} from '../../../../shared/settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useSettingsStore } from '@/stores/settings-store'
import {
  customConnectorAliasKey,
  customConnectorAliases,
  isCustomConnectorSlug,
  toCustomConnectorSlug
} from '../../../../shared/custom-connector'
import { SettingsRow } from './SettingsLayout'

// Which kind of custom connector is being added: a local stdio command or a remote HTTP/SSE server.
type ConnectorMode = 'local' | 'remote'

// The two remote transports, kept out of the local (stdio) mode.
type RemoteTransport = Extract<CustomServerTransport, 'streamable_http' | 'sse'>
type RemoteAuth = 'none' | 'oauth' | 'headers'

const fieldLabelClassName = 'text-xs font-medium text-muted-foreground'

// Splits an arguments textarea on any whitespace/newlines into a positional arg list, dropping empties.
const parseArgs = (raw: string, onePerLine = false): string[] =>
  raw
    .split(onePerLine ? /\n/ : /\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)

// Parses one KEY=VALUE per line into a record; blank lines and lines without '=' are ignored.
const parseEnv = (raw: string): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return env
}

// Parses one "Name: Value" per line into a headers record; blank/invalid lines are ignored.
const parseHeaders = (raw: string): Record<string, string> => {
  const headers: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(':')
    if (colon <= 0) continue
    headers[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim()
  }
  return headers
}

// A required-field marker next to a label. Purely visual; the real guard is the disabled Add button.
const RequiredMark = (): React.JSX.Element => (
  <span aria-hidden="true" className="ml-0.5 text-destructive">
    *
  </span>
)

const REMOTE_TRANSPORTS: { id: RemoteTransport; label: TranslationKey }[] = [
  { id: 'streamable_http', label: 'settings.streamableHttp' },
  { id: 'sse', label: 'settings.sse' }
]

// Common runtimes used to launch a local stdio MCP server, plus an "other" escape hatch for an
// absolute path or an uncommon binary.
const COMMAND_OPTIONS: { value: string; label: TranslationKey }[] = [
  { value: 'npx', label: 'settings.commandNpx' },
  { value: 'uvx', label: 'settings.commandUvx' },
  { value: 'node', label: 'settings.commandNode' },
  { value: 'python3', label: 'settings.commandPython3' },
  { value: 'docker', label: 'settings.commandDocker' },
  { value: 'other', label: 'settings.commandOther' }
]

type ConnectorAddFormProps = {
  initialTransport?: ConnectorMode
  initialTemplate?: ConnectorTemplateDefinition
  // When set, the form edits this custom server instead of adding a new one. The name is immutable.
  editServer?: CustomServerView
  // Called after the custom server has been added/updated successfully.
  onDone: () => void
  onCancel: () => void
}

// Maps a stored transport to the form's local/remote mode.
const modeForTransport = (transport: CustomServerTransport): ConnectorMode =>
  transport === 'stdio' ? 'local' : 'remote'

// Add or edit a custom MCP server ("custom connector"): a local stdio command or a remote HTTP/SSE
// server, gated behind an explicit trust confirmation the way the reference "Add connector" flow is.
export function ConnectorAddForm({
  initialTransport,
  initialTemplate,
  editServer,
  onDone,
  onCancel
}: ConnectorAddFormProps): React.JSX.Element {
  const { t } = useLanguage()
  const addCustomServer = useSettingsStore((s) => s.addCustomServer)
  const updateCustomServer = useSettingsStore((s) => s.updateCustomServer)
  const connectors = useSettingsStore((s) => s.connectors)
  const customServers = useSettingsStore((s) => s.customServers)
  const isEdit = editServer !== undefined

  const [mode, setMode] = useState<ConnectorMode>(
    editServer
      ? modeForTransport(editServer.transport)
      : initialTemplate
        ? modeForTransport(initialTemplate.transport)
        : (initialTransport ?? 'local')
  )
  const [name, setName] = useState(editServer?.name ?? initialTemplate?.name ?? '')
  const [slug, setSlug] = useState(editServer?.slug ?? initialTemplate?.slug ?? '')
  const [slugTouched, setSlugTouched] = useState(initialTemplate !== undefined)
  const currentSlug = isEdit
    ? (editServer?.slug ?? '')
    : slugTouched
      ? slug
      : toCustomConnectorSlug(name)
  const slugError = useMemo((): string | null => {
    if (!currentSlug || !isCustomConnectorSlug(currentSlug)) {
      return t('settings.slugInvalidHint')
    }
    if (connectors.some((connector) => connector.id === currentSlug)) {
      return t('settings.idReservedByBuiltin')
    }
    if (
      customServers.some(
        (server) =>
          server.id !== editServer?.id &&
          customConnectorAliases(server)
            .map(customConnectorAliasKey)
            .includes(customConnectorAliasKey(currentSlug))
      )
    ) {
      return t('settings.idAlreadyExists')
    }
    return null
  }, [connectors, currentSlug, customServers, editServer?.id, t])
  const [description, setDescription] = useState(
    editServer?.description ?? initialTemplate?.description ?? ''
  )
  // Local (stdio) fields. The command is chosen from common runtimes, with an "other" escape hatch
  // for an absolute path or an uncommon binary.
  const initialCommand = editServer?.command ?? initialTemplate?.command
  const initialCommandIsPreset = initialCommand
    ? COMMAND_OPTIONS.some((o) => o.value === initialCommand)
    : true
  const [commandChoice, setCommandChoice] = useState<string>(
    initialCommand ? (initialCommandIsPreset ? initialCommand : 'other') : 'npx'
  )
  const [customCommand, setCustomCommand] = useState(
    initialCommand && !initialCommandIsPreset ? initialCommand : ''
  )
  const command = commandChoice === 'other' ? customCommand : commandChoice
  const [argsText, setArgsText] = useState(
    (editServer?.args ?? initialTemplate?.args ?? []).join(initialTemplate ? '\n' : ' ')
  )
  const [envText, setEnvText] = useState(
    (initialTemplate?.requiredSecrets?.environment ?? []).map((key) => `${key}=`).join('\n')
  )
  // Remote fields.
  const [url, setUrl] = useState(editServer?.url ?? initialTemplate?.url ?? '')
  const [remoteTransport, setRemoteTransport] = useState<RemoteTransport>(
    editServer && editServer.transport !== 'stdio'
      ? editServer.transport
      : initialTemplate && initialTemplate.transport !== 'stdio'
        ? initialTemplate.transport
        : 'streamable_http'
  )
  const [remoteAuth, setRemoteAuth] = useState<RemoteAuth>(
    editServer?.oauth || initialTemplate?.oauth
      ? 'oauth'
      : editServer?.hasHeaders || initialTemplate?.requiredSecrets?.headers?.length
        ? 'headers'
        : 'none'
  )
  const [oauthScopesText, setOauthScopesText] = useState(
    (editServer?.oauth?.scopes ?? initialTemplate?.oauth?.scopes ?? []).join(' ')
  )
  const [authorizationServerUrl, setAuthorizationServerUrl] = useState(
    editServer?.oauth?.authorizationServerUrl ??
      initialTemplate?.oauth?.authorizationServerUrl ??
      ''
  )
  const [clientMetadataUrl, setClientMetadataUrl] = useState(
    editServer?.oauth?.clientMetadataUrl ?? initialTemplate?.oauth?.clientMetadataUrl ?? ''
  )
  const [headersText, setHeadersText] = useState(
    (initialTemplate?.requiredSecrets?.headers ?? []).map((header) => `${header}: `).join('\n')
  )
  // Add-time trust confirmation and submission state. An existing (already-trusted) server starts trusted.
  const [trusted, setTrusted] = useState(isEdit)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsedArgs = parseArgs(argsText, initialTemplate !== undefined)
  const parsedEnv = parseEnv(envText)
  const parsedHeaders = parseHeaders(headersText)
  const commandPreview = [command.trim(), ...parsedArgs].filter((part) => part.length > 0).join(' ')
  const requiredEnvironment = initialTemplate?.requiredSecrets?.environment ?? []
  const requiredHeaders = initialTemplate?.requiredSecrets?.headers ?? []
  const requiredSecretValuesFilled =
    (requiredEnvironment.length === 0 ||
      (mode === 'local' &&
        requiredEnvironment.every((key) => (parsedEnv[key] ?? '').trim().length > 0))) &&
    (requiredHeaders.length === 0 ||
      (mode === 'remote' &&
        remoteAuth === 'headers' &&
        requiredHeaders.every((header) => (parsedHeaders[header] ?? '').trim().length > 0)))

  const requiredFilled =
    name.trim().length > 0 &&
    !slugError &&
    (mode === 'local' ? command.trim().length > 0 : url.trim().length > 0) &&
    requiredSecretValuesFilled
  const canSubmit = requiredFilled && trusted && !submitting

  const switchMode = (next: ConnectorMode): void => {
    setMode(next)
    setError(null)
  }

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const env = parsedEnv
      const headers = parsedHeaders
      const oauthScopes = oauthScopesText
        .split(/[\s,]+/)
        .map((scope) => scope.trim())
        .filter(Boolean)
      // Omitted env/headers keep the stored (secret) values on edit; on add they are simply unset.
      const hasEnv = envText.trim().length > 0
      const hasHeaders = headersText.trim().length > 0
      const transport: CustomServerTransport = mode === 'local' ? 'stdio' : remoteTransport
      const shared = {
        description: description.trim() || undefined,
        transport,
        ...(mode === 'local'
          ? {
              command: command.trim(),
              ...(parsedArgs.length > 0 ? { args: parsedArgs } : {})
            }
          : {
              url: url.trim(),
              oauth:
                remoteAuth === 'oauth'
                  ? {
                      ...(authorizationServerUrl.trim()
                        ? { authorizationServerUrl: authorizationServerUrl.trim() }
                        : {}),
                      ...(clientMetadataUrl.trim()
                        ? { clientMetadataUrl: clientMetadataUrl.trim() }
                        : {}),
                      ...(oauthScopes.length ? { scopes: oauthScopes } : {})
                    }
                  : null
            })
      }

      if (isEdit && editServer) {
        const request: UpdateCustomServerRequest = {
          id: editServer.id,
          ...shared,
          ...(mode === 'local' && hasEnv ? { env } : {}),
          ...(mode === 'remote' && remoteAuth !== 'headers'
            ? { headers: {} }
            : hasHeaders
              ? { headers }
              : {}),
          ...(mode === 'remote' && remoteAuth !== 'oauth' ? { oauth: null } : {})
        }
        await updateCustomServer(request)
      } else {
        const request: AddCustomServerRequest = {
          name: name.trim(),
          slug: currentSlug,
          ...shared,
          ...(mode === 'local' && Object.keys(env).length > 0 ? { env } : {}),
          ...(mode === 'remote' && remoteAuth === 'headers' && Object.keys(headers).length > 0
            ? { headers }
            : {})
        }
        await addCustomServer(request)
      }
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.failedToSaveConnector'))
    } finally {
      setSubmitting(false)
    }
  }

  const segmentButtonClassName = (active: boolean): string =>
    `inline-flex h-7 items-center rounded-md px-3 text-sm transition-colors motion-reduce:transition-none ${
      active
        ? 'bg-card font-medium text-foreground shadow-sm'
        : 'text-muted-foreground hover:text-foreground'
    }`

  return (
    <div className="p-5">
      <div className="flex w-full flex-col gap-4">
        {initialTemplate ? (
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
            {t('settings.importedConfigPrefilled')}
          </div>
        ) : null}
        <div
          role="radiogroup"
          aria-label={t('settings.connectorType')}
          className="inline-flex w-fit items-center rounded-lg bg-muted p-0.5"
        >
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'local'}
            onClick={() => switchMode('local')}
            className={segmentButtonClassName(mode === 'local')}
          >
            {t('settings.localCommand')}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'remote'}
            onClick={() => switchMode('remote')}
            className={segmentButtonClassName(mode === 'remote')}
          >
            {t('settings.remoteServer')}
          </button>
        </div>

        <div className="space-y-1.5">
          <label className={fieldLabelClassName} htmlFor="connector-name">
            {t('settings.displayName')}
            {isEdit ? null : <RequiredMark />}
          </label>
          <Input
            id="connector-name"
            aria-label={t('settings.displayName')}
            value={name}
            disabled={isEdit}
            placeholder={t('settings.displayNameExample')}
            onChange={(event) => setName(event.target.value)}
          />
          {isEdit ? (
            <p className="text-xs text-muted-foreground">{t('settings.displayNameFixed')}</p>
          ) : null}
        </div>

        <SettingsRow
          label={
            <>
              {t('settings.connectorId')}
              {isEdit ? null : <RequiredMark />}
            </>
          }
          description={
            <span className={slugError ? 'text-destructive' : undefined}>
              {slugError ?? t('settings.connectorIdHint').replace('{slug}', currentSlug)}
            </span>
          }
        >
          <Input
            id="connector-slug"
            aria-label={t('settings.connectorId')}
            value={currentSlug}
            readOnly={isEdit}
            aria-invalid={slugError ? true : undefined}
            className="font-mono"
            onChange={
              isEdit
                ? undefined
                : (event) => {
                    setSlugTouched(true)
                    setSlug(event.target.value.toLowerCase())
                  }
            }
          />
        </SettingsRow>

        <div className="space-y-1.5">
          <label className={fieldLabelClassName} htmlFor="connector-description">
            {t('settings.description')}{' '}
            <span className="text-muted-foreground">{t('common.optional')}</span>
          </label>
          <Input
            id="connector-description"
            aria-label={t('settings.description')}
            value={description}
            placeholder={t('settings.whatConnectorProvides')}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        {mode === 'local' ? (
          <>
            <div className="space-y-1.5">
              <label className={fieldLabelClassName} htmlFor="connector-command">
                {t('settings.command')}
                <RequiredMark />
              </label>
              <Select value={commandChoice} onValueChange={setCommandChoice}>
                <SelectTrigger aria-label={t('settings.command')}>
                  <span>
                    {COMMAND_OPTIONS.find((o) => o.value === commandChoice)?.label
                      ? t(COMMAND_OPTIONS.find((o) => o.value === commandChoice)!.label)
                      : commandChoice}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {COMMAND_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {commandChoice === 'other' ? (
                <Input
                  aria-label={t('settings.customCommand')}
                  value={customCommand}
                  placeholder="/absolute/path/to/executable"
                  className="font-mono"
                  onChange={(event) => setCustomCommand(event.target.value)}
                />
              ) : null}
            </div>

            <div className="space-y-1.5">
              <label className={fieldLabelClassName} htmlFor="connector-args">
                {t('settings.arguments')}{' '}
                <span className="text-muted-foreground">{t('common.optional')}</span>
              </label>
              <Textarea
                id="connector-args"
                aria-label={t('settings.arguments')}
                value={argsText}
                rows={2}
                placeholder="-y @modelcontextprotocol/server-memory"
                className="resize-none font-mono text-[13px]"
                onChange={(event) => setArgsText(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {initialTemplate ? t('settings.oneArgPerLine') : t('settings.argsSeparated')}
              </p>
            </div>

            <div className="space-y-1.5">
              <label className={fieldLabelClassName} htmlFor="connector-env">
                {t('settings.environmentVariables')}{' '}
                <span className="text-muted-foreground">{t('common.optional')}</span>
              </label>
              <Textarea
                id="connector-env"
                aria-label={t('settings.environmentVariables')}
                value={envText}
                rows={3}
                placeholder={'KEY=value\nANOTHER_KEY=value'}
                className="resize-none font-mono text-[13px]"
                onChange={(event) => setEnvText(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t('settings.oneKeyValuePerLine')}
                {initialTemplate?.requiredSecrets?.environment?.length
                  ? t('settings.requiredField').replace(
                      '{names}',
                      initialTemplate.requiredSecrets.environment.join(', ')
                    )
                  : ''}
                {isEdit ? t('settings.leaveBlankKeepCurrent') : ''}
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1.5">
              <label className={fieldLabelClassName} htmlFor="connector-url">
                {t('settings.serverUrl')}
                <RequiredMark />
              </label>
              <Input
                id="connector-url"
                aria-label={t('settings.serverUrl')}
                value={url}
                placeholder="https://example.com/mcp"
                className="font-mono"
                onChange={(event) => setUrl(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <span className={fieldLabelClassName}>{t('settings.transport')}</span>
              <Select
                value={remoteTransport}
                onValueChange={(value) => setRemoteTransport(value as RemoteTransport)}
              >
                <SelectTrigger aria-label={t('settings.transport')}>
                  <span>
                    {REMOTE_TRANSPORTS.find((entry) => entry.id === remoteTransport)?.label
                      ? t(REMOTE_TRANSPORTS.find((entry) => entry.id === remoteTransport)!.label)
                      : remoteTransport}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {REMOTE_TRANSPORTS.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {t(entry.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <SettingsRow label={t('settings.authentication')}>
              <Select
                value={remoteAuth}
                onValueChange={(value) => setRemoteAuth(value as RemoteAuth)}
              >
                <SelectTrigger aria-label={t('settings.authentication')}>
                  <span>
                    {remoteAuth === 'oauth'
                      ? t('settings.oauthBrowserSignIn')
                      : remoteAuth === 'headers'
                        ? t('settings.staticHeaders')
                        : t('settings.none')}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('settings.none')}</SelectItem>
                  <SelectItem value="oauth">{t('settings.oauthBrowserSignIn')}</SelectItem>
                  <SelectItem value="headers">{t('settings.staticHeaders')}</SelectItem>
                </SelectContent>
              </Select>
            </SettingsRow>

            {remoteAuth === 'oauth' ? (
              <>
                <SettingsRow
                  label={
                    <>
                      {t('settings.oauthScopes')}{' '}
                      <span className="text-muted-foreground">{t('common.optional')}</span>
                    </>
                  }
                >
                  <Input
                    id="connector-oauth-scopes"
                    aria-label={t('settings.oauthScopes')}
                    value={oauthScopesText}
                    placeholder="openid profile"
                    onChange={(event) => setOauthScopesText(event.target.value)}
                  />
                </SettingsRow>
                <SettingsRow
                  label={
                    <>
                      {t('settings.authorizationServerUrl')}{' '}
                      <span className="text-muted-foreground">{t('common.optional')}</span>
                    </>
                  }
                >
                  <Input
                    id="connector-oauth-server"
                    aria-label={t('settings.authorizationServerUrl')}
                    value={authorizationServerUrl}
                    placeholder={t('settings.autoDiscoverFromMcp')}
                    className="font-mono"
                    onChange={(event) => setAuthorizationServerUrl(event.target.value)}
                  />
                </SettingsRow>
                <SettingsRow
                  label={
                    <>
                      {t('settings.clientMetadataUrl')}{' '}
                      <span className="text-muted-foreground">{t('common.optional')}</span>
                    </>
                  }
                >
                  <Input
                    id="connector-oauth-client-metadata"
                    aria-label={t('settings.clientMetadataUrl')}
                    value={clientMetadataUrl}
                    placeholder={t('settings.useDynamicClientRegistration')}
                    className="font-mono"
                    onChange={(event) => setClientMetadataUrl(event.target.value)}
                  />
                </SettingsRow>
              </>
            ) : null}

            {remoteAuth === 'headers' ? (
              <div className="space-y-1.5">
                <label className={fieldLabelClassName} htmlFor="connector-headers">
                  {t('settings.headers')}{' '}
                  <span className="text-muted-foreground">{t('common.optional')}</span>
                </label>
                <Textarea
                  id="connector-headers"
                  aria-label={t('settings.headers')}
                  value={headersText}
                  rows={3}
                  placeholder={'Authorization: Bearer <token>\nX-Api-Key: <key>'}
                  className="resize-none font-mono text-[13px]"
                  onChange={(event) => setHeadersText(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.nameValuePerLine')}
                  {initialTemplate?.requiredSecrets?.headers?.length
                    ? t('settings.requiredField').replace(
                        '{names}',
                        initialTemplate.requiredSecrets.headers.join(', ')
                      )
                    : ''}
                  {isEdit ? t('settings.leaveBlankKeepCurrent') : ''}
                </p>
              </div>
            ) : null}
          </>
        )}

        <div className="rounded-lg border border-border bg-muted/30 p-3">
          {mode === 'local' && commandPreview ? (
            <p className="mb-2 break-all font-mono text-xs text-muted-foreground">
              {commandPreview}
            </p>
          ) : null}
          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              aria-label={t('settings.trustConnectorLabel')}
              checked={trusted}
              className="mt-0.5 size-4 shrink-0"
              onChange={(event) => setTrusted(event.target.checked)}
            />
            <span className="text-sm text-foreground">{t('settings.trustConnector')}</span>
          </label>
        </div>

        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {submitting
              ? isEdit
                ? t('settings.saving')
                : t('settings.adding')
              : isEdit
                ? t('settings.saveChanges')
                : t('settings.addConnector')}
          </Button>
        </div>
      </div>
    </div>
  )
}
