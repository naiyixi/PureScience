import { useLanguage } from '@/i18n'
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

// One row of Settings > Model > Scenario models: a scenario (conversation details / sub-agents /
// review) with its own default-model selector. Each scenario inherits the active model unless the
// user pins an override; clearing the override returns to inheritance.
const ScenarioModelRow = ({ scenario, label }: ScenarioModelRowProps): React.JSX.Element => {
  const { t } = useLanguage()
  const providers = useSettingsStore((state) => state.providers)
  const scenarioModels = useSettingsStore((state) => state.scenarioModels)
  const setScenarioModel = useSettingsStore((state) => state.setScenarioModel)

  const override = scenarioModels?.[scenario]

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
    </div>
  )
}

export { SCENARIO_MODEL_IDS, ScenarioModelRow }
