import { useLanguage } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger
} from '@/components/ui/select'
import { useSettingsStore } from '@/stores/settings-store'
import type { ScenarioModelId, ScenarioModelOverride } from '../../../../shared/settings'
import { SCENARIO_MODEL_IDS } from '../../../../shared/settings'
import type { ReasoningEffort } from '../../../../shared/settings'
import type { ReasoningEffortProfile } from '../../../../shared/reasoning-effort'
import { resolveReasoningEffortControl } from '../../../../shared/reasoning-effort'
import { resolveProviderReasoningEffortProfile } from '../../../../shared/provider-reasoning-effort'
import { ProviderKindIcon } from './provider-icons'
import { providerKindKey } from './provider-form-value'

// Separator for the composite (providerId, model) select value (same convention as the other
// model selects). '__inherit__' means "same as the active model" (the default).
const SEP = '␟'
const INHERIT = '__inherit__'

type ScenarioModelRowProps = {
  scenario: ScenarioModelId
  label: string
}

// Compact segmented reasoning-strength picker for one scenario row (v1.46: independent per-scenario
// effort). 'default' = follow the main model's strength; the remaining segments mirror the global
// control's levels once a model is pinned to this scenario. Reuses the shared profile projection so
// levels always match what the pinned model can actually deliver.
const EffortSegments = ({
  value,
  profile,
  followLabel,
  onChange
}: {
  value: ReasoningEffort
  profile: ReasoningEffortProfile
  followLabel: string
  onChange: (effort: ReasoningEffort) => void
}): React.JSX.Element => {
  const control = resolveReasoningEffortControl(value, profile)
  const options = [
    { value: 'default' as const, label: followLabel },
    ...control.options.map((option) => ({ value: option.intent as ReasoningEffort, label: option.label }))
  ]

  return (
    <div
      role="radiogroup"
      aria-label="reasoning effort"
      className="flex w-fit flex-wrap items-center gap-0.5 rounded-lg bg-muted p-0.5"
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'h-6 rounded-md px-2 text-xs font-medium transition-colors motion-reduce:transition-none',
              selected
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

// One row of Settings > Model > Scenario models: a scenario (conversation details / sub-agents /
// review) with its own default-model selector. Each scenario inherits the active model unless the
// user pins an override; clearing the override returns to inheritance.
const ScenarioModelRow = ({ scenario, label }: ScenarioModelRowProps): React.JSX.Element => {
  const { t } = useLanguage()
  const providers = useSettingsStore((state) => state.providers)
  const scenarioModels = useSettingsStore((state) => state.scenarioModels)
  const setScenarioModel = useSettingsStore((state) => state.setScenarioModel)

  const override = scenarioModels?.[scenario]
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const activeModel = useSettingsStore((state) => state.activeModel)

  // The provider/model this scenario effectively runs (its pinned override, or the active model).
  const effectiveProvider = override
    ? providers.find((provider) => provider.id === override.providerId)
    : providers.find((provider) => provider.id === activeProviderId)
  const effectiveModel = override?.model ?? activeModel
  const effortProfile = resolveProviderReasoningEffortProfile(effectiveProvider, effectiveModel)
  const scenarioEffort: ReasoningEffort = override?.reasoningEffort ?? 'default'

  // Persists a strength level for this scenario: 'default' keeps following the main model's level
  // (the pinned model above may still differ from the main one); any other level pins this scenario
  // independently. Requires a concrete model — when the row inherits the active model and none
  // exists yet there is nothing to pin, so only the follow-default segment stays enabled.
  const changeEffort = (effort: ReasoningEffort): void => {
    if (effort === scenarioEffort) return
    if (!effectiveProvider || !effectiveModel) {
      if (effort === 'default') void setScenarioModel(scenario, undefined).catch(() => undefined)
      return
    }
    const configuration: ScenarioModelOverride = override
      ? { ...override, reasoningEffort: effort }
      : { providerId: effectiveProvider.id, model: effectiveModel, reasoningEffort: effort }
    void setScenarioModel(scenario, configuration).catch(() => undefined)
  }

  // All providers with an explicit model list can back a scenario (subscription pseudo-providers
  // carry no models and drop out naturally).
  const options = providers.flatMap((provider) => {
    return (provider.models.length > 0 ? provider.models : provider.model ? [provider.model] : [])
      .filter((model) => model !== undefined)
      .map((model) => ({ provider, model }))
  })

  const current =
    override &&
    options.find(
      (option) => option.provider.id === override.providerId && option.model === override.model
    )

  const groups = providers
    .map((provider) => ({
      provider,
      options: options.filter((option) => option.provider.id === provider.id)
    }))
    .filter((group) => group.options.length > 0)

  const change = (value: string): void => {
    if (value === INHERIT) {
      void setScenarioModel(scenario, undefined).catch(() => undefined)
      return
    }
    const [providerId, model] = value.split(SEP)
    const configuration: ScenarioModelOverride = {
      providerId,
      model,
      reasoningEffort: 'default'
    }
    void setScenarioModel(scenario, configuration).catch(() => undefined)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <Select
        value={current ? `${current.provider.id}${SEP}${current.model}` : INHERIT}
        onValueChange={change}
      >
        <SelectTrigger aria-label={label} className="w-72">
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
              <span className="text-muted-foreground">{t('settings.scenarioModelInherit')}</span>
            )}
          </span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT}>{t('settings.scenarioModelInherit')}</SelectItem>
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
      <EffortSegments
        value={scenarioEffort}
        profile={effortProfile}
        followLabel={t('settings.scenarioModelInherit')}
        onChange={changeEffort}
      />
    </div>
  )
}

export { SCENARIO_MODEL_IDS, ScenarioModelRow }
