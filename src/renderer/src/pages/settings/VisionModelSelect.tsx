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
import type { VisionModelConfiguration } from '../../../../shared/settings'
import { ProviderKindIcon } from './provider-icons'
import { providerKindKey } from './provider-form-value'

// Separator for the composite (providerId, model) select value (same convention as ActiveModelSelect).
const SEP = '␟'

// The optional "Vision model" selector for Settings > Model . Unlike the active
// model, this is a fixed provider+model pair used ONLY to translate image input when the active
// backend is text-only. It filters to providers that advertise image input, and supports clearing
// the selection to disable the relay.
const VisionModelSelect = (): React.JSX.Element | null => {
  const { t } = useLanguage()
  const providers = useSettingsStore((state) => state.providers)
  const visionModel = useSettingsStore((state) => state.visionModel)
  const setVisionModel = useSettingsStore((state) => state.setVisionModel)

  // Only providers whose current model supports image input can act as the Vision model.
  const options = providers.flatMap((provider) => {
    if (provider.supportsImageInput !== true) return []
    return (
      provider.models.length > 0 ? provider.models : provider.model ? [provider.model] : []
    ).map((model) => ({ provider, model }))
  })

  if (options.length === 0) return null

  const current = visionModel
    ? options.find(
        (option) =>
          option.provider.id === visionModel.providerId && option.model === visionModel.model
      )
    : undefined

  const groups = providers
    .map((provider) => ({
      provider,
      options: options.filter((option) => option.provider.id === provider.id)
    }))
    .filter((group) => group.options.length > 0)

  const change = (value: string): void => {
    if (value === '__clear__') {
      void setVisionModel(undefined).catch(() => undefined)
      return
    }
    const [providerId, model] = value.split(SEP)
    const configuration: VisionModelConfiguration = {
      providerId,
      model,
      reasoningEffort: 'default'
    }
    void setVisionModel(configuration).catch(() => undefined)
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-foreground">{t('settings.visionModel')}</span>
      <div className="flex items-center gap-2">
        <Select
          value={current ? `${current.provider.id}${SEP}${current.model}` : '__clear__'}
          onValueChange={change}
        >
          <SelectTrigger aria-label={t('settings.visionModel')} className="w-72">
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
                <span className="text-muted-foreground">{t('settings.visionModelDisabled')}</span>
              )}
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__clear__">{t('settings.visionModelDisabled')}</SelectItem>
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
        {current ? (
          <button
            type="button"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => void setVisionModel(undefined).catch(() => undefined)}
          >
            {t('settings.visionModelClear')}
          </button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{t('settings.visionModelHint')}</p>
    </div>
  )
}

export { VisionModelSelect }
