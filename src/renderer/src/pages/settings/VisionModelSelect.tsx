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
import { selectableVisionOptions } from './vision-model-options'
import {
  getOfficialVendorModelIds,
  isOfficialVendorId,
  isVendorModelMultimodal
} from '../../../../shared/provider-registry'
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

  // A provider is a vision candidate at the *model* level, not the provider level: a DeepSeek
  // account whose active (main) model is text-only still serves deepseek-v4-flash-vision-exp, so the
  // picker must consult the vendor catalog rule per model. Providers without a known vendor keep the
  // stored supportsImageInput flag (all their models were declared vision-capable when configured).
  const isVisionCandidate = (provider: (typeof providers)[number], model: string): boolean =>
    provider.vendorId !== undefined && isOfficialVendorId(provider.vendorId)
      ? isVendorModelMultimodal(provider.vendorId, model)
      : provider.supportsImageInput === true

  // Candidate models for one provider. For an official vendor, derive from the bundled vendor
  // catalog (which always carries the multimodal ids) rather than the persisted provider.models —
  // that list is often pruned to the active model, so a text main model would hide the vision
  // variant. Stored models still merge in, in case a refreshed vendor catalog surfaced a new id.
  const modelsFor = (provider: (typeof providers)[number]): string[] => {
    const listed =
      provider.models.length > 0 ? provider.models : provider.model ? [provider.model] : []
    if (provider.vendorId !== undefined && isOfficialVendorId(provider.vendorId)) {
      return [...new Set([...getOfficialVendorModelIds(provider.vendorId), ...listed])]
    }
    return listed
  }

  const options = providers.flatMap((provider) => {
    return modelsFor(provider)
      .filter((model) => isVisionCandidate(provider, model))
      .map((model) => ({ provider, model }))
  })

  if (options.length === 0 && !visionModel) {
    // No vision-capable provider is configured: the section keeps its heading/description (owned by
    // the parent) and explains why the picker is absent instead of silently rendering nothing.
    return <p className="text-xs text-muted-foreground">{t('settings.visionModelUnavailable')}</p>
  }

  const candidate = visionModel
    ? options.find(
        (option) =>
          option.provider.id === visionModel.providerId && option.model === visionModel.model
      )
    : undefined

  // The saved pair wins over the candidate rule. Its owner validates on write and on admission, so a
  // persisted configuration is the truth about what the relay will use; showing "disabled" here because
  // this render's candidate list came back empty (a provider whose metadata this window has not
  // refreshed yet, for instance) would tell the user the opposite of what the settings file says.
  const savedProvider = visionModel
    ? providers.find((provider) => provider.id === visionModel.providerId)
    : undefined
  const current =
    candidate ??
    (visionModel && savedProvider
      ? { provider: savedProvider, model: visionModel.model }
      : undefined)

  // A saved configuration with nothing to pick means this window's candidate list is thinner than the
  // settings file: keep the saved pair on screen and say so, rather than reporting it as disabled.
  const savedWithoutCandidate = Boolean(visionModel && savedProvider && !candidate)

  // A saved pair that the candidate rule does not produce still has to be *selectable*: keeping it on
  // screen while leaving it out of the list is what makes the control look stuck — the value is shown, but
  // the list has no row to pick, so choosing anything is impossible and nothing can be re-confirmed.
  const selectable = selectableVisionOptions(current, options)

  const groups = providers
    .map((provider) => ({
      provider,
      options: selectable.filter((option) => option.provider.id === provider.id)
    }))
    // A provider that only appears through the saved pair still needs its group rendered.
    .filter((group) => group.options.length > 0 || group.provider.id === current?.provider.id)

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
      {savedWithoutCandidate ? (
        <p className="text-xs text-muted-foreground">{t('settings.visionModelSavedNotOffered')}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">{t('settings.visionModelHint')}</p>
    </div>
  )
}

export { VisionModelSelect }
