import { useState } from 'react'
import { AlertTriangle, Brain, Check, ChevronDown, ChevronRight, Cpu, Search } from 'lucide-react'
import { useLanguage } from '@/i18n'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { ProviderKindIcon } from '../settings/provider-icons'
import { providerKindKey } from '../settings/provider-form-value'
import {
  selectFrameworkApiEndpoints,
  selectProviderModelOptions,
  useSettingsStore,
  type ProviderModelOption
} from '@/stores/settings-store'
import { isProviderUsableByFramework } from '../../../../shared/settings'
import { isModelBridgeSupported } from '../../../../shared/provider-registry'
import {
  resolveProviderEffectiveModel,
  resolveProviderReasoningEffortProfile
} from '../../../../shared/provider-reasoning-effort'
import { resolveReasoningEffortControl } from '../../../../shared/reasoning-effort'
import { incompatibilityReason } from './composer-model-picker-utils'
import { fuzzyScore, type FuzzyMatch } from './composer/fuzzy-match'
import { HighlightedText } from './composer/HighlightedText'

const triggerClassName =
  'flex h-8 max-w-[220px] items-center gap-1 rounded-md px-2.5 text-sm text-text-300 hover:bg-bg-200 hover:text-text-100 disabled:cursor-not-allowed disabled:opacity-50 transition-colors'

// Label for an option: the model name, or the provider name when the option carries no concrete model.
const optionLabel = (option: ProviderModelOption): string => option.model || option.providerName

// Option label rendered with its fuzzy-match runs underlined when the query hit this exact option.
const matchLabel = (label: string, match: FuzzyMatch | null): React.ReactNode =>
  match ? <HighlightedText text={label} positions={match.positions} /> : label

// One radio row shape shared by both submenus: menuitemradio semantics, bold + trailing Check when
// picked, optional leading icon and trailing hint. The three call sites (default effort, effort
// rung, model) stay behavior-identical by construction.
const MenuRadioItem = ({
  checked,
  onSelect,
  leading,
  hint,
  children
}: {
  checked: boolean
  onSelect: () => void
  leading?: React.ReactNode
  hint?: string
  children: React.ReactNode
}): React.JSX.Element => (
  <DropdownMenuItem
    role="menuitemradio"
    aria-checked={checked}
    onSelect={onSelect}
    className={cn('gap-2', checked && 'font-medium')}
  >
    {leading}
    <span className="min-w-0 flex-1 truncate">{children}</span>
    {hint ? <span className="text-[11px] text-text-300">{hint}</span> : null}
    {checked ? (
      <Check className="size-4 shrink-0 text-primary" strokeWidth={2} aria-hidden="true" />
    ) : null}
  </DropdownMenuItem>
)

// Model/provider switcher shown in the composer toolbar. Reads the settings store directly (the store
// is global) so the presentational ConversationPanel needn't thread provider state through. With no
// selectable model it shows a warning that opens Settings; with a single option it renders nothing
// (there's nothing to switch between); otherwise it renders the switcher.
const ComposerModelPicker = (): React.JSX.Element | null => {
  const { t } = useLanguage()
  // The model submenu's fuzzy-search box. `modelSubOpen` exists only to reset the query when the
  // submenu reopens, so the catalog never appears pre-filtered from an earlier search.
  const [modelSubOpen, setModelSubOpen] = useState(false)
  const [modelQuery, setModelQuery] = useState('')
  const query = modelQuery.trim()
  const providers = useSettingsStore((state) => state.providers)
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const claudeSubscriptionProviderId = useSettingsStore(
    (state) => state.claudeSubscriptionProviderId
  )
  const activeModel = useSettingsStore((state) => state.activeModel)
  const setActiveProvider = useSettingsStore((state) => state.setActiveProvider)
  const openSettings = useSettingsStore((state) => state.openSettings)
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)
  const frameworkEndpoints = useSettingsStore(selectFrameworkApiEndpoints)
  const reasoningEffort = useSettingsStore((state) => state.reasoningEffort)
  const setReasoningEffort = useSettingsStore((state) => state.setReasoningEffort)

  const frameworkName =
    agentFrameworks.find((framework) => framework.id === agentFrameworkId)?.displayName ??
    'this framework'

  // Reasoning-effort state resolves through the same chain as the Settings page control: the
  // effective model for the active provider, that model's static effort profile, then the control
  // options the stored intent maps onto.
  const activeProvider = providers.find((candidate) => candidate.id === activeProviderId)
  const effectiveModel = resolveProviderEffectiveModel(activeProvider, activeModel)
  const effortProfile = resolveProviderReasoningEffortProfile(activeProvider, effectiveModel)
  const effortControl = resolveReasoningEffortControl(reasoningEffort, effortProfile)
  const selectedEffortLabel = effortControl.options.find(
    (option) => option.value === effortControl.selectedValue
  )?.label

  // The effort row only makes sense when the active provider's model can take an effort at all;
  // without an active provider there is nothing the selection would apply to, so the row hides.
  const showEffortRow =
    activeProvider !== undefined && effortProfile.supported && effortControl.options.length > 0

  // The trigger advertises a non-default effort as a suffix, derived from showEffortRow so the two
  // visibility rules can never drift apart. 'default' means "whatever the provider does" — the
  // common case — and stays quiet.
  const effortSuffixLabel =
    showEffortRow && reasoningEffort !== 'default' ? selectedEffortLabel : undefined
  const defaultEffortChecked = reasoningEffort === 'default'

  // A provider is selectable only when it can actually drive the current framework (endpoint + type).
  const isCompatible = (provider: (typeof providers)[number], model: string): boolean =>
    isProviderUsableByFramework(
      { apiEndpoints: provider.apiEndpoints, type: provider.type },
      { id: agentFrameworkId, supportedApiTypes: frameworkEndpoints }
    ) &&
    (agentFrameworkId !== 'codex' || isModelBridgeSupported(provider, model))

  const options = selectProviderModelOptions(
    providers,
    activeProviderId,
    claudeSubscriptionProviderId
  )
  const usableOptions = options.filter((option) => {
    const provider = providers.find((candidate) => candidate.id === option.providerId)
    return provider ? isCompatible(provider, option.model) : false
  })
  const hasUsable = usableOptions.length > 0

  // No provider configured at all: nothing to pick or explain, so warn with a button that opens
  // Settings rather than leaving the toolbar a silent dead end.
  if (options.length === 0) {
    return (
      <button
        type="button"
        onClick={() => openSettings()}
        className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-amber-700 hover:bg-amber-50 transition-colors dark:text-amber-400 dark:hover:bg-amber-950/30"
        aria-label={t('modelPicker.noModelAria')}
      >
        <AlertTriangle className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
        <span className="truncate">{t('modelPicker.noModel')}</span>
      </button>
    )
  }

  // A single usable option leaves nothing to switch between, so the picker stays hidden. When the
  // sole provider is incompatible we instead fall through to the dropdown (hasUsable is false) so its
  // incompatibility reason stays reachable — an all-incompatible framework must never silently vanish.
  if (options.length === 1 && hasUsable) return null

  // The active option matches by provider and model; an undefined activeModel maps to the empty-model
  // "default" entry.
  const activeKeyModel = activeModel ?? ''
  const current = options.find(
    (option) => option.providerId === activeProviderId && option.model === activeKeyModel
  )

  // Group options by provider so official vendors show their catalog under one heading.
  const groups = providers
    .map((provider) => ({
      provider,
      options: options.filter((option) => option.providerId === provider.id)
    }))
    .filter((group) => group.options.length > 0)

  // Fuzzy-search view of the catalog (same ordered-subsequence matcher as the composer / and @
  // popups). A provider stays visible when its name or any of its models matches; a name-only hit
  // keeps the whole catalog of that provider, an option-level hit narrows it to the matches sorted
  // by relevance (closest first). With no query every entry is shown in the stable provider order.
  type OptionMatch = { option: ProviderModelOption; match: FuzzyMatch | null }
  const isOptionMatch = (entry: OptionMatch): entry is OptionMatch & { match: FuzzyMatch } =>
    entry.match !== null
  const modelSearchGroups = groups.map((group) => {
    const nameMatch = query ? fuzzyScore(query, group.provider.name) : null
    const optionMatches: OptionMatch[] = group.options.map((option) => ({
      option,
      match: query ? fuzzyScore(query, optionLabel(option)) : null
    }))
    if (query !== '' && nameMatch === null && !optionMatches.some(isOptionMatch)) {
      return { group, entries: [] as OptionMatch[] }
    }
    const entries =
      query === '' || nameMatch !== null
        ? optionMatches
        : [...optionMatches].filter(isOptionMatch).sort((a, b) => b.match.score - a.match.score)
    return { group, entries }
  })
  const hasSearchResults =
    query === '' || modelSearchGroups.some((entry) => entry.entries.length > 0)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            triggerClassName,
            !hasUsable &&
              'text-amber-700 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-400'
          )}
          aria-label={hasUsable ? t('modelPicker.selectModel') : t('modelPicker.noCompatible')}
        >
          {hasUsable ? (
            <>
              {current ? (
                <ProviderKindIcon
                  kindKey={providerKindKey(current.providerType, current.vendorId)}
                  className="size-4"
                />
              ) : null}
              <span className="flex min-w-0 items-center">
                {current ? (
                  <>
                    {/* The model name alone ellipsizes under the trigger's max width; the effort
                        suffix is the newer signal and stays fully visible. */}
                    <span className="truncate font-medium text-text-100">
                      {optionLabel(current)}
                    </span>
                    {effortSuffixLabel ? (
                      <span className="ml-1.5 shrink-0 whitespace-nowrap text-text-300">
                        · {effortSuffixLabel}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="truncate">{t('modelPicker.selectModel')}</span>
                )}
              </span>
            </>
          ) : (
            <>
              <AlertTriangle className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
              <span className="truncate">{t('modelPicker.noCompatible')}</span>
            </>
          )}
          <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      {/* Two-level menu: the first level is two summary rows (effort, model) whose actual choices
          live in their submenus. This keeps the long provider catalog out of the top level, which
          now reads as a compact overview instead of a scrolling list. */}
      <DropdownMenuContent side="top" align="end" sideOffset={8} className="w-84 p-1">
        {showEffortRow ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="items-center gap-2 px-2 py-1.5">
              <Brain className="size-4 shrink-0 text-text-200" strokeWidth={2} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium leading-5">
                  {t('modelPicker.reasoningEffort')}
                </span>
                <span className="block text-[11px] leading-4 text-text-300">
                  {t('settings.howLongModelThinks')}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-bg-200 px-2 py-0.5 text-[11px] font-medium leading-4 text-text-100">
                {defaultEffortChecked ? t('modelPicker.defaultEffort') : selectedEffortLabel}
                <ChevronRight
                  className="size-3 shrink-0 opacity-60"
                  strokeWidth={2}
                  aria-hidden="true"
                />
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56 p-1">
              <MenuRadioItem
                checked={defaultEffortChecked}
                onSelect={() => void setReasoningEffort('default')}
                hint={t('modelPicker.providerDefaultHint')}
              >
                {t('modelPicker.defaultEffort')}
              </MenuRadioItem>
              {effortControl.options.map((option) => (
                // Checked by concrete value, not intent: several intents can project onto one
                // value, and the profile owns which one is selected.
                <MenuRadioItem
                  key={option.value}
                  checked={
                    reasoningEffort !== 'default' && option.value === effortControl.selectedValue
                  }
                  onSelect={() => void setReasoningEffort(option.intent)}
                >
                  {option.label}
                </MenuRadioItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <DropdownMenuSub
          open={modelSubOpen}
          onOpenChange={(open) => {
            setModelSubOpen(open)
            // Fresh catalog on every open: a stale query must never hide the list behind a
            // re-triggered submenu.
            if (open) setModelQuery('')
          }}
        >
          <DropdownMenuSubTrigger
            data-testid="model-row"
            className="items-center gap-2 px-2 py-1.5"
          >
            {/* The leading icon stays a generic model glyph; the provider identity lives in the
                right-hand two-line summary instead. */}
            <Cpu className="size-4 shrink-0 text-text-200" strokeWidth={2} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium leading-5">Model</span>
              <span className="block text-[11px] leading-4 text-text-300">
                {t('settings.providerAndModelForChat')}
              </span>
            </span>
            {/* The current pick echoes on the right inside a capsule: small bold provider line
                with its own icon over the model name. The capsule is two lines tall, so it uses
                a soft rounded-lg corner rather than the single-line pill's rounded-full; long
                names ellipsize against the max width. */}
            {current ? (
              <span className="flex shrink-0 items-center gap-1.5 rounded-lg bg-bg-200 px-2 py-1">
                <span className="flex max-w-[12rem] flex-col items-end text-right">
                  <span className="flex max-w-full items-center gap-1 text-[11px] font-semibold leading-4 text-text-300">
                    <ProviderKindIcon
                      kindKey={providerKindKey(current.providerType, current.vendorId)}
                      className="size-3 shrink-0"
                    />
                    <span className="min-w-0 truncate">{current.providerName}</span>
                  </span>
                  <span className="block max-w-full truncate text-[13px] font-medium leading-5">
                    {optionLabel(current)}
                  </span>
                </span>
                <ChevronRight
                  className="size-3.5 shrink-0 opacity-60"
                  strokeWidth={2}
                  aria-hidden="true"
                />
              </span>
            ) : (
              <>
                <span className="shrink-0 text-[11px] text-text-300">
                  {t('modelPicker.select')}
                </span>
                <ChevronRight
                  className="size-3.5 shrink-0 opacity-60"
                  strokeWidth={2}
                  aria-hidden="true"
                />
              </>
            )}
          </DropdownMenuSubTrigger>
          {/* The full grouped catalog (compatibility rows included) lives one level down so the
              first level stays a summary; behavior per item is unchanged from the flat menu. A
              fuzzy search box narrows the catalog: query text matches model and provider names,
              matched runs are underlined, and a provider whose name alone hit keeps its whole
              catalog. */}
          <DropdownMenuSubContent className="max-h-[320px] min-w-[15rem] overflow-y-auto p-1">
            <div className="relative mb-1">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={modelQuery}
                onChange={(event) => setModelQuery(event.target.value)}
                placeholder={t('modelPicker.searchModels')}
                aria-label={t('modelPicker.searchModels')}
                data-testid="model-search-input"
                className="h-8 pl-8 text-[13px]"
                // Keep typing local: without this, the menu's built-in typeahead would swallow
                // the letters before the input ever sees them.
                onKeyDown={(event) => event.stopPropagation()}
              />
            </div>
            {query !== '' && !hasSearchResults ? (
              <p
                className="px-2 py-2 text-center text-xs text-muted-foreground"
                data-testid="model-search-empty"
              >
                {t('modelPicker.noResults')}
              </p>
            ) : (
              modelSearchGroups.map(({ group, entries }) => {
                const compatible = group.options.some((option) =>
                  isCompatible(group.provider, option.model)
                )
                const endpointCompatible = isProviderUsableByFramework(
                  {
                    apiEndpoints: group.provider.apiEndpoints,
                    type: group.provider.type
                  },
                  { id: agentFrameworkId, supportedApiTypes: frameworkEndpoints }
                )
                const reason = compatible
                  ? undefined
                  : endpointCompatible && agentFrameworkId === 'codex'
                    ? t('modelPicker.codexBridgeReason', { name: group.provider.name })
                    : incompatibilityReason(
                        {
                          apiEndpoints: group.provider.apiEndpoints,
                          type: group.provider.type,
                          name: group.provider.name
                        },
                        frameworkName,
                        frameworkEndpoints
                      )
                if (entries.length === 0) return null

                return (
                  <DropdownMenuGroup key={group.provider.id}>
                    <DropdownMenuLabel>{group.provider.name}</DropdownMenuLabel>
                    {compatible ? (
                      entries.map(({ option, match }) => {
                        const isActive =
                          option.providerId === activeProviderId && option.model === activeKeyModel
                        const optionCompatible = isCompatible(group.provider, option.model)

                        if (!optionCompatible) {
                          // Endpoint is fine but this model is statically marked unsupported over the
                          // Codex bridge. Grey it with a warning icon; the full reason is on hover
                          // (title) and read by assistive tech (aria-label), so it isn't a long inline
                          // string.
                          const optionReason = t('modelPicker.bridgeUnsupportedReason', {
                            model: optionLabel(option)
                          })
                          return (
                            <DropdownMenuItem
                              key={`${option.providerId}:${option.model}`}
                              aria-disabled
                              aria-label={optionReason}
                              title={optionReason}
                              onSelect={(event) => event.preventDefault()}
                              className="gap-2 text-text-300"
                            >
                              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                              <span className="min-w-0 flex-1 truncate">
                                {matchLabel(optionLabel(option), match)}
                              </span>
                              <span className="text-xs">{t('modelPicker.unsupported')}</span>
                            </DropdownMenuItem>
                          )
                        }

                        return (
                          <MenuRadioItem
                            key={`${option.providerId}:${option.model}`}
                            checked={isActive}
                            onSelect={() =>
                              void setActiveProvider(option.providerId, option.model).catch(
                                () => undefined
                              )
                            }
                            leading={
                              <ProviderKindIcon
                                kindKey={providerKindKey(option.providerType, option.vendorId)}
                                className="size-4 shrink-0"
                              />
                            }
                          >
                            {matchLabel(optionLabel(option), match)}
                          </MenuRadioItem>
                        )
                      })
                    ) : (
                      // An incompatible provider gets one greyed, non-actionable row: a short
                      // "Unavailable" label + warning icon, with the full reason on hover (title) and
                      // exposed to assistive tech (aria-label) — so the dropdown stays compact instead
                      // of wrapping a long sentence. It stays keyboard-reachable via roving focus (a
                      // `disabled` item is skipped, and a label is not focusable), aria-disabled marks
                      // it unselectable, and onSelect is prevented so it never switches the model.
                      <DropdownMenuItem
                        aria-disabled
                        aria-label={reason}
                        title={reason}
                        onSelect={(event) => event.preventDefault()}
                        className="gap-2 text-text-300"
                      >
                        <AlertTriangle
                          className="size-4 shrink-0"
                          strokeWidth={2}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          Unavailable for {frameworkName}
                        </span>
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuGroup>
                )
              })
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {hasUsable ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openSettings()}>
              {t('modelPicker.openSettings')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export { ComposerModelPicker }
