import { useLanguage, type TranslationKey } from '@/i18n'
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  FUNCTION_MODEL_FALLBACKS,
  type FunctionModelDetection,
  type FunctionModelDetectionFailureReason,
  type FunctionModelEvent,
  type FunctionModelId,
  type FunctionModelResolution,
  type FunctionModelUnusableReason,
  type FunctionModels
} from '../../../../shared/function-models'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/stores/settings-store'
import { ProviderKindIcon } from './provider-icons'
import { providerKindKey } from './provider-form-value'

// Same composite-value convention as the other model selects in this page.
const SEP = '␟'
// "Run it the built-in way" is a value of its own, not an empty selection: it is what most users want and
// the row has to be able to say it.
const BUILT_IN = '__built-in__'

const FUNCTION_NAME_KEYS: Record<FunctionModelId, TranslationKey> = {
  'skill-selection': 'settings.functionModelSkillSelection'
}

const FUNCTION_DETAIL_KEYS: Record<FunctionModelId, TranslationKey> = {
  'skill-selection': 'settings.functionModelSkillSelectionDetail'
}

// Every way a detection can fail names itself: "it did not work" sends the user looking in the wrong place.
const DETECT_REASON_KEYS: Record<FunctionModelDetectionFailureReason, TranslationKey> = {
  'not-configured': 'settings.functionModelDetectReasonNotConfigured',
  'provider-missing': 'settings.functionModelDetectReasonProviderMissing',
  'provider-has-no-credentials': 'settings.functionModelDetectReasonNoCredentials',
  'provider-unverified': 'settings.functionModelDetectReasonUnverified',
  'model-missing': 'settings.functionModelDetectReasonModelMissing',
  unreachable: 'settings.functionModelDetectReasonUnreachable',
  timeout: 'settings.functionModelDetectReasonTimeout',
  'http-error': 'settings.functionModelDetectReasonHttpError',
  'invalid-response': 'settings.functionModelDetectReasonInvalidResponse'
}

const UNUSABLE_KEYS: Record<FunctionModelUnusableReason, TranslationKey> = {
  'provider-missing': 'settings.functionModelUnusableProviderMissing',
  'provider-has-no-credentials': 'settings.functionModelUnusableNoCredentials',
  'provider-unverified': 'settings.functionModelUnusableUnverified',
  'model-missing': 'settings.functionModelUnusableModelMissing'
}

/**
 * One function row on Settings > Model.
 *
 * It shows three things the competitor's equivalent does not: the model in force, where that model comes
 * from, and what runs instead when it is not usable. The fallback is stated even when no model is
 * configured, because "runs the built-in way" is a fact about the feature, not an absence of one.
 */
export const FunctionModelRow = ({
  functionId
}: {
  functionId: FunctionModelId
}): React.JSX.Element => {
  const { t } = useLanguage()
  const providers = useSettingsStore((state) => state.providers)
  const [models, setModels] = useState<FunctionModels>({})
  const [resolution, setResolution] = useState<FunctionModelResolution>()
  const [failed, setFailed] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [detection, setDetection] = useState<FunctionModelDetection>()

  // Reading happens in an async effect body on purpose: the answer arrives from the main process, and a
  // synchronous set during render would be a state update the row never asked for.
  const read = useCallback(async (): Promise<void> => {
    const client = window.api?.settings?.functionModels
    if (!client) {
      // A window without this channel cannot read the setting at all. Saying so beats an empty row that
      // reads as "nothing configured"; the update is deferred a tick so it is not a set during the effect.
      await Promise.resolve()
      setFailed(true)

      return
    }
    const result = await client({ action: 'resolve', functionId })
    setModels(result.models)
    setResolution(result.resolved)
    setFailed(false)
  }, [functionId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await read()
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [read])

  const options = useMemo(
    () =>
      providers.flatMap((provider) =>
        (provider.models.length > 0 ? provider.models : provider.model ? [provider.model] : [])
          .filter((model): model is string => typeof model === 'string')
          .map((model) => ({ provider, model }))
      ),
    [providers]
  )

  const override = models[functionId]
  const current = options.find(
    (option) =>
      override && option.provider.id === override.providerId && option.model === override.model
  )

  const write = async (next: FunctionModels): Promise<void> => {
    const client = window.api?.settings?.functionModels
    if (!client) return
    try {
      const result = await client({ action: 'set', models: next })
      setModels(result.models)
      await read()
    } catch {
      setFailed(true)
    }
  }

  const detect = async (): Promise<void> => {
    const client = window.api?.settings?.functionModels
    if (!client) return
    setDetecting(true)
    try {
      const result = await client({ action: 'detect', functionId })
      setModels(result.models)
      setDetection(result.detected)
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      setDetecting(false)
    }
  }

  const change = (value: string): void => {
    if (value === BUILT_IN) {
      const { [functionId]: _cleared, ...rest } = models
      void write(rest)

      return
    }
    const [providerId, model] = value.split(SEP)
    void write({ ...models, [functionId]: { providerId, model } })
  }

  const groups = providers
    .map((provider) => ({
      provider,
      options: options.filter((option) => option.provider.id === provider.id)
    }))
    .filter((group) => group.options.length > 0)

  const reason = resolution?.unusable[0]
  const stateText = resolution
    ? resolution.override
      ? t('settings.functionModelUsing', {
          model: resolution.override.model,
          provider:
            providers.find((provider) => provider.id === resolution.override?.providerId)?.name ??
            ''
        })
      : t('settings.functionModelBuiltInPath')
    : t('settings.functionModelLoading')

  return (
    <div className="flex flex-col gap-1.5" data-testid={`function-model-row-${functionId}`}>
      <span className="text-xs font-medium text-foreground">
        {t(FUNCTION_NAME_KEYS[functionId])}
      </span>
      <Select
        value={current ? `${current.provider.id}${SEP}${current.model}` : BUILT_IN}
        onValueChange={change}
      >
        <SelectTrigger
          aria-label={t(FUNCTION_NAME_KEYS[functionId])}
          className="w-72"
          data-testid={`function-model-select-${functionId}`}
        >
          <span className="flex items-center gap-2 truncate">
            {current ? (
              <>
                <ProviderKindIcon
                  kindKey={providerKindKey(current.provider.type, current.provider.vendorId)}
                />
                <span className="truncate">{current.model}</span>
                <span className="truncate text-muted-foreground">{current.provider.name}</span>
              </>
            ) : (
              <span className="text-muted-foreground">
                {t('settings.functionModelBuiltInPath')}
              </span>
            )}
          </span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={BUILT_IN}>{t('settings.functionModelBuiltInPath')}</SelectItem>
          {groups.map((group) => (
            <SelectGroup key={group.provider.id}>
              <SelectLabel>{group.provider.name}</SelectLabel>
              {group.options.map((option) => (
                <SelectItem
                  key={`${option.provider.id}${SEP}${option.model}`}
                  value={`${option.provider.id}${SEP}${option.model}`}
                >
                  {option.model}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{t(FUNCTION_DETAIL_KEYS[functionId])}</p>
      {/* What is in force, then what runs instead of an unusable override — both named, never implied. */}
      <p
        className="text-xs text-muted-foreground"
        data-testid={`function-model-state-${functionId}`}
      >
        {failed ? t('settings.functionModelUnavailable') : stateText}
      </p>
      {!failed && !resolution?.override ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid={`function-model-fallback-${functionId}`}
        >
          {`${t(FUNCTION_MODEL_FALLBACKS[functionId].detailKey as TranslationKey)}${
            reason ? ` ${t(UNUSABLE_KEYS[reason])}` : ''
          }`}
        </p>
      ) : null}
      {detection ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid={`function-model-detection-${functionId}`}
        >
          {detection.ok
            ? t('settings.functionModelDetected', {
                ms: String(detection.elapsedMs),
                usage: detection.usage
                  ? t('settings.functionModelDetectedUsage', {
                      input: String(detection.usage.inputTokens ?? 0),
                      output: String(detection.usage.outputTokens ?? 0)
                    })
                  : t('settings.functionModelDetectedNoUsage')
              })
            : `${t('settings.functionModelDetectFailed')} ${t(
                DETECT_REASON_KEYS[detection.reason]
              )}${detection.status ? ` (${detection.status})` : ''}`}
        </p>
      ) : null}
      {/* Detection spends real quota, so the control says so and is only offered once there is a model to
          detect: probing the built-in path would produce a measurement of nothing. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          className="h-7 px-2 text-xs"
          data-testid={`function-model-detect-${functionId}`}
          disabled={detecting || !current}
          onClick={() => void detect()}
        >
          {detecting ? t('settings.functionModelDetecting') : t('settings.functionModelDetect')}
        </Button>
        <span className="text-xs text-muted-foreground">
          {current
            ? t('settings.functionModelDetectNote')
            : t('settings.functionModelDetectNeedsModel')}
        </span>
      </div>
    </div>
  )
}

const TRAIL_REASON_KEYS: Record<FunctionModelEvent['reason'] & string, TranslationKey> = {
  ...DETECT_REASON_KEYS,
  'call-failed': 'settings.functionModelTrailCallFailed'
}

/**
 * What the functions actually did, newest first.
 *
 * The settings rows above say what will happen; this says what happened. It is the answer to the question a
 * model picker normally cannot answer — "why did this run not use the model I configured" — and it is why
 * the entries name a reason instead of reporting a failure.
 */
export const FunctionModelTrail = (): React.JSX.Element => {
  const { t } = useLanguage()
  const providers = useSettingsStore((state) => state.providers)
  const [events, setEvents] = useState<readonly FunctionModelEvent[]>([])
  const [failed, setFailed] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const client = window.api?.settings?.functionModels
    if (!client) {
      setFailed(true)

      return
    }
    const result = await client({ action: 'events' })
    setEvents(result.events ?? [])
    setFailed(false)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await load()
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [load])

  const providerName = (providerId: string | undefined): string =>
    providers.find((provider) => provider.id === providerId)?.name ?? providerId ?? ''

  // Newest first, and bounded: a trail is for reading the recent story, not for scrolling history.
  const shown = [...events].slice(-10).reverse()

  return (
    <div className="flex flex-col gap-1.5" data-testid="function-model-trail">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-foreground">
          {t('settings.functionModelTrail')}
        </span>
        <Button
          type="button"
          variant="ghost"
          className="h-7 px-2 text-xs"
          data-testid="function-model-trail-refresh"
          onClick={() => void load().catch(() => setFailed(true))}
        >
          {t('settings.functionModelTrailRefresh')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('settings.functionModelTrailHint')}</p>
      {failed ? (
        <p className="text-xs text-muted-foreground">{t('settings.functionModelUnavailable')}</p>
      ) : null}
      {!failed && shown.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="function-model-trail-empty">
          {t('settings.functionModelTrailEmpty')}
        </p>
      ) : null}
      {!failed
        ? shown.map((event, index) => (
            <p
              key={`${event.at}-${index}`}
              className="text-xs text-muted-foreground"
              data-testid="function-model-trail-entry"
            >
              {`${new Date(event.at).toLocaleString()} · ${t('settings.functionModelSkillSelection')} · ${
                event.outcome === 'used-model'
                  ? t('settings.functionModelTrailUsed', {
                      model: event.model ?? '',
                      provider: providerName(event.providerId)
                    })
                  : `${t('settings.functionModelTrailBuiltIn')} ${t(
                      TRAIL_REASON_KEYS[event.reason ?? 'not-configured']
                    )}`
              }`}
            </p>
          ))
        : null}
    </div>
  )
}
