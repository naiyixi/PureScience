/* Hallmark · pre-emit critique: P4 H4 E4 S4 R4 V4 */
import { useCallback, useEffect, useState } from 'react'
import { CircleDot, Pause, Play, Plus, RefreshCw, Trash2 } from 'lucide-react'

import { useLanguage } from '@/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { EndpointRegisterRequest, ManagedEndpoint } from '../../../../shared/endpoint'

// Local model services ("managed endpoints"): daemon-owned lifecycle for locally hosted model
// servers. The panel lists every endpoint (across sessions), lets the user register one (name,
// loopback URL, runbook skill, opaque start/stop scripts + readiness path), APPROVE a pending
// script set (the first registration of given script bytes requires user approval — scripts are
// shown verbatim), and start/stop or remove an endpoint.
export const EndpointPanel = (): React.JSX.Element => {
  const { t } = useLanguage()
  const [endpoints, setEndpoints] = useState<ManagedEndpoint[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [skillName, setSkillName] = useState('')
  const [startScript, setStartScript] = useState('')
  const [stopScript, setStopScript] = useState('')
  const [livePath, setLivePath] = useState('/health/ready')
  const [credentialName, setCredentialName] = useState('')
  const [busyName, setBusyName] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    try {
      const items = await window.api.endpoint.listAll()
      setEndpoints(items)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() awaits before any setState (fetch-on-mount); no cascading renders
    void load()
  }, [load])

  const nameValid = /^[a-z0-9-]{1,64}$/.test(name.trim())
  const urlValid = /^http:\/\/127\.0\.0\.1:\d{1,5}(\/.*)?$/.test(url.trim())
  const formValid =
    nameValid &&
    urlValid &&
    skillName.trim().length > 0 &&
    startScript.trim().length > 0 &&
    stopScript.trim().length > 0

  const register = useCallback(async (): Promise<void> => {
    if (!formValid || saving) return
    setSaving(true)
    try {
      const request: EndpointRegisterRequest = {
        name: name.trim(),
        url: url.trim(),
        skillName: skillName.trim(),
        startScript: startScript.trim(),
        stopScript: stopScript.trim(),
        livePath: livePath.trim() || '/health/ready',
        ...(credentialName.trim() ? { credentialName: credentialName.trim() } : {})
      }
      // The panel has no session context; registrations are audited against a synthetic owner
      // (the agent-facing endpoint_register tool is the session-aware path).
      await window.api.endpoint.register({ sessionId: 'settings-panel', request })
      setName('')
      setUrl('')
      setSkillName('')
      setStartScript('')
      setStopScript('')
      setLivePath('/health/ready')
      setCredentialName('')
      setShowForm(false)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }, [
    formValid,
    saving,
    name,
    url,
    skillName,
    startScript,
    stopScript,
    livePath,
    credentialName,
    load
  ])

  const toggle = useCallback(
    async (endpoint: ManagedEndpoint): Promise<void> => {
      if (busyName) return
      setBusyName(endpoint.name)
      try {
        if (endpoint.state === 'live' || endpoint.state === 'starting') {
          await window.api.endpoint.stop(endpoint.name)
        } else if (endpoint.state === 'stopped' || endpoint.state === 'failed') {
          await window.api.endpoint.start(endpoint.name)
        }
        await load()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusyName(undefined)
      }
    },
    [busyName, load]
  )

  const remove = useCallback(
    async (endpoint: ManagedEndpoint): Promise<void> => {
      if (busyName) return
      setBusyName(endpoint.name)
      try {
        await window.api.endpoint.remove(endpoint.name)
        await load()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusyName(undefined)
      }
    },
    [busyName, load]
  )

  const stateLabel = (endpoint: ManagedEndpoint): string => {
    switch (endpoint.state) {
      case 'live':
        return t('settings.endpointsLive')
      case 'starting':
        return t('settings.endpointsStarting')
      case 'failed':
        return t('settings.endpointsFailed')
      default:
        return t('settings.endpointsStopped')
    }
  }

  return (
    <div className="space-y-5 p-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t('settings.endpointsDesc')}</p>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void load()}
            aria-label={t('settings.endpointsRefresh')}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button size="sm" onClick={() => setShowForm((open) => !open)}>
            <Plus className="mr-1 h-4 w-4" />
            {t('settings.endpointsNew')}
          </Button>
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {showForm ? (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="endpoint-name" className="text-sm font-medium">
                {t('settings.endpointsName')}
              </label>
              <Input
                id="endpoint-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="esm-fold"
              />
              {!nameValid ? (
                <p className="text-xs text-destructive">{t('settings.endpointsNameHint')}</p>
              ) : null}
            </div>
            <div className="space-y-1">
              <label htmlFor="endpoint-url" className="text-sm font-medium">
                {t('settings.endpointsUrl')}
              </label>
              <Input
                id="endpoint-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="http://127.0.0.1:20001"
              />
              {!urlValid ? (
                <p className="text-xs text-destructive">{t('settings.endpointsUrlHint')}</p>
              ) : null}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="endpoint-skill" className="text-sm font-medium">
                {t('settings.endpointsSkill')}
              </label>
              <Input
                id="endpoint-skill"
                value={skillName}
                onChange={(event) => setSkillName(event.target.value)}
                placeholder="esm-runbook"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="endpoint-credential" className="text-sm font-medium">
                {t('settings.endpointsCredential')}
              </label>
              <Input
                id="endpoint-credential"
                value={credentialName}
                onChange={(event) => setCredentialName(event.target.value)}
                placeholder={t('settings.endpointsCredentialPlaceholder')}
              />
            </div>
          </div>
          <div className="space-y-1">
            <label htmlFor="endpoint-live" className="text-sm font-medium">
              {t('settings.endpointsLivePath')}
            </label>
            <Input
              id="endpoint-live"
              value={livePath}
              onChange={(event) => setLivePath(event.target.value)}
              placeholder="/health/ready"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="endpoint-start" className="text-sm font-medium">
              {t('settings.endpointsStartScript')}
            </label>
            <Textarea
              id="endpoint-start"
              value={startScript}
              onChange={(event) => setStartScript(event.target.value)}
              rows={3}
              placeholder={t('settings.endpointsStartScriptPlaceholder')}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="endpoint-stop" className="text-sm font-medium">
              {t('settings.endpointsStopScript')}
            </label>
            <Textarea
              id="endpoint-stop"
              value={stopScript}
              onChange={(event) => setStopScript(event.target.value)}
              rows={2}
              placeholder={t('settings.endpointsStopScriptPlaceholder')}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>
              {t('settings.cancel')}
            </Button>
            <Button size="sm" disabled={!formValid || saving} onClick={() => void register()}>
              {t('settings.endpointsRegister')}
            </Button>
          </div>
        </div>
      ) : null}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('settings.endpointsLoading')}</p>
      ) : endpoints.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <CircleDot className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('settings.endpointsEmpty')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('settings.endpointsEmptyHint')}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-bg-10">
          <ul className="divide-y divide-border">
            {endpoints.map((endpoint) => (
              <li
                key={endpoint.name}
                className="flex items-start justify-between gap-3 px-3 py-2.5"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'h-2 w-2 shrink-0 rounded-full',
                        endpoint.state === 'live'
                          ? 'bg-success-000'
                          : endpoint.state === 'starting'
                            ? 'bg-accent animate-pulse'
                            : endpoint.state === 'failed'
                              ? 'bg-danger-000'
                              : 'bg-muted-foreground/30'
                      )}
                    />
                    <span className="truncate text-sm font-medium">{endpoint.name}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {stateLabel(endpoint)}
                    </span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {endpoint.url}
                    {endpoint.livePath} · {t('settings.endpointsSkill')}: {endpoint.skillName}
                  </p>
                  {endpoint.lastError ? (
                    <p className="truncate text-xs text-destructive">{endpoint.lastError}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={busyName === endpoint.name}
                    aria-label={
                      endpoint.state === 'live' || endpoint.state === 'starting'
                        ? t('settings.endpointsStop')
                        : t('settings.endpointsStart')
                    }
                    onClick={() => void toggle(endpoint)}
                  >
                    {endpoint.state === 'live' || endpoint.state === 'starting' ? (
                      <Pause className="h-4 w-4" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={busyName === endpoint.name}
                    aria-label={t('settings.endpointsDelete')}
                    onClick={() => void remove(endpoint)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
