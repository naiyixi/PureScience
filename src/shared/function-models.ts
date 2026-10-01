/**
 * Function-level model slots.
 *
 * A "function" here is a narrow, non-conversational model call the app makes for one purpose — choosing
 * which skills a turn should load, for instance. It is not a scenario: a scenario decides the model that
 * runs the conversation, while a function slot decides the model for one looked-up decision inside a run.
 *
 * Two rules this file exists to enforce:
 *
 * 1. **A slot is only listed when a feature consumes it.** The plan for this version named literature
 *    classification as a second slot, but no such feature exists in this repository — a settings row that
 *    picks a model for a thing nobody implemented is a switch that changes nothing, which is the kind of
 *    UI this file refuses to justify.
 * 2. **The fallback is always stated.** Every function has a built-in path that needs no model at all, and
 *    the resolution says which one is in force and why an override on record is not being used. "No model
 *    configured" and "the configured model is unusable" are different facts and must not read the same.
 */

export const FUNCTION_MODEL_IDS = ['skill-selection'] as const

export type FunctionModelId = (typeof FUNCTION_MODEL_IDS)[number]

export const isFunctionModelId = (value: unknown): value is FunctionModelId =>
  typeof value === 'string' && (FUNCTION_MODEL_IDS as readonly string[]).includes(value)

export type FunctionModelOverride = Readonly<{
  providerId: string
  model: string
}>

export type FunctionModels = Readonly<Partial<Record<FunctionModelId, FunctionModelOverride>>>

/**
 * What a function does when no model of its own is usable. The `detailKey` is the translation key of the
 * sentence a user reads; keeping it here (rather than in the panel) means the settings row, the fallback
 * event and the tests all describe the same path.
 */
export type FunctionModelFallback = Readonly<{
  kind: 'built-in-deterministic'
  detailKey: string
}>

export const FUNCTION_MODEL_FALLBACKS: Readonly<Record<FunctionModelId, FunctionModelFallback>> = {
  // Without a model, the turn loads no pre-selected skills and the whole catalog still reaches the agent:
  // the decision moves from a model call to the agent's own reading of the catalog.
  'skill-selection': {
    kind: 'built-in-deterministic',
    detailKey: 'settings.functionModelsFallbackSkillSelection'
  }
}

export type FunctionModelUnusableReason =
  | 'provider-missing'
  | 'provider-has-no-credentials'
  // The app already excludes a provider whose last validation failed from every model picker. A slot
  // pointing at one must not read as working just because a key is stored.
  | 'provider-unverified'
  | 'model-missing'

/**
 * The facts a resolution needs about a configured provider. Passed in rather than looked up so the
 * resolution stays a pure function: the same stored override and the same facts must always resolve the
 * same way, which is what makes the settings row, the run and the audit event agree.
 */
export type FunctionModelProviderFacts = Readonly<{
  id: string
  /** False when the provider is known but cannot authenticate. */
  hasCredentials: boolean
  /** Model ids the provider offers. Undefined means the list has not been read — not that it is empty. */
  models?: readonly string[]
  /** True when the most recent connectivity check failed and nothing later succeeded. */
  validationFailed?: boolean
}>

export type FunctionModelResolution = Readonly<{
  functionId: FunctionModelId
  /** The override that will be used, or null when this function runs on its built-in path. */
  override: FunctionModelOverride | null
  /** Always present: what happens instead when `override` is null. */
  fallback: FunctionModelFallback
  /**
   * Why an override that is on record will not be used. Empty when nothing is on record — an empty list
   * means "nobody configured this", never "the configured one failed for reasons we did not look up".
   */
  unusable: readonly FunctionModelUnusableReason[]
}>

export const resolveFunctionModel = ({
  functionId,
  stored,
  providers
}: {
  functionId: FunctionModelId
  stored?: FunctionModels
  providers: readonly FunctionModelProviderFacts[]
}): FunctionModelResolution => {
  const fallback = FUNCTION_MODEL_FALLBACKS[functionId]
  const override = stored?.[functionId]
  if (!override) return { functionId, override: null, fallback, unusable: [] }

  const provider = providers.find((entry) => entry.id === override.providerId)
  if (!provider) {
    return { functionId, override: null, fallback, unusable: ['provider-missing'] }
  }
  // Credentials first: a provider that cannot authenticate makes the model question moot, and reporting
  // both would invite the reader to fix the smaller problem.
  if (!provider.hasCredentials) {
    return { functionId, override: null, fallback, unusable: ['provider-has-no-credentials'] }
  }
  if (provider.validationFailed) {
    return { functionId, override: null, fallback, unusable: ['provider-unverified'] }
  }
  // Only judged when the model list is actually known. An unread list is not evidence that the model is
  // absent, and turning it into a failure would block a working configuration for no reason.
  if (provider.models !== undefined && !provider.models.includes(override.model)) {
    return { functionId, override: null, fallback, unusable: ['model-missing'] }
  }

  return { functionId, override, fallback, unusable: [] }
}

/**
 * Reads a stored function-model map. Unknown ids and malformed entries are dropped rather than kept: a
 * slot for a function this build does not have would otherwise survive a downgrade and reappear as a
 * setting that silently does nothing.
 */
/**
 * The settings surface for these slots: one channel, three actions, so the panel reads the stored map, writes
 * it, and asks what a function will actually use without three commands drifting apart.
 */
/** Token counts a provider reported for the detection round trip, when it reported any. */
export type FunctionModelDetectionUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type FunctionModelDetectionFailureReason =
  | 'not-configured'
  | FunctionModelUnusableReason
  | 'unreachable'
  | 'timeout'
  | 'http-error'
  | 'invalid-response'

/**
 * What a detection run found. A detection is a real round trip, so it reports what that round trip cost —
 * elapsed time always, tokens when the provider says so. A green tick with no measurement would be a claim
 * about a call nobody saw.
 */
export type FunctionModelDetection =
  | {
      ok: true
      /** Measured wall time of the round trip. */
      elapsedMs: number
      providerId: string
      model: string
      usage?: FunctionModelDetectionUsage
    }
  | {
      ok: false
      elapsedMs: number
      reason: FunctionModelDetectionFailureReason
      status?: number
      providerId?: string
      model?: string
    }

/**
 * The trail a function leaves behind: what each narrow call did, which model it used, and — when it took its
 * built-in path — whether that was because nobody configured it or because the configuration could not be
 * used. A competitor's equivalent stops at "these features use the first service"; this is what lets the
 * user ask why a particular run did not.
 */
export type FunctionModelEventReason =
  /** Nothing is configured for this function. */
  | 'not-configured'
  /** Configured, but unusable — the same named reasons the settings row shows. */
  | FunctionModelUnusableReason
  /** The call was attempted and did not come back with a selector result. */
  | 'call-failed'
  /**
   * No request was sent at all: the selector had nothing to select for (an empty catalog), or the
   * deterministic connector shortcut answered first. Distinct from 'call-failed' because reporting a model
   * as "used" when nothing left the machine is the exact false claim this vocabulary exists to prevent.
   */
  | 'call-not-attempted'

export type FunctionModelEvent = Readonly<{
  at: number
  functionId: FunctionModelId
  /** `used-model` means the configured model answered; `built-in` means the built-in path ran instead. */
  outcome: 'used-model' | 'built-in'
  providerId?: string
  model?: string
  reason?: FunctionModelEventReason
}>

export type FunctionModelCommandRequest =
  | { action: 'get' }
  | { action: 'set'; models: FunctionModels }
  | { action: 'resolve'; functionId: FunctionModelId }
  | { action: 'detect'; functionId: FunctionModelId }
  | { action: 'probe'; functionId: FunctionModelId }
  | { action: 'events' }

// What one immediate selection did. `used-model` means the configured model answered and its picks are
// listed; `built-in` means the built-in path ran instead, with the reason — and, outside a turn, that path
// has nothing to select with, so an empty list is the honest answer rather than an invented one.
export type FunctionModelProbeResult = Readonly<{
  outcome: 'used-model' | 'built-in'
  reason?: FunctionModelEventReason
  providerId?: string
  model?: string
  elapsedMs: number
  selectedSkillIds: readonly string[]
}>

export type FunctionModelCommandResult = {
  models: FunctionModels
  /** Present for `resolve`: what that function will use, and its built-in path when it will not. */
  resolved?: FunctionModelResolution
  /** Present for `detect`: the outcome of one real round trip. */
  detected?: FunctionModelDetection
  /** Present for `probe`: what one immediate selection did. */
  probe?: FunctionModelProbeResult
  /** Present for `events`: the recorded trail, newest last. */
  events?: readonly FunctionModelEvent[]
}

export const sanitizeFunctionModels = (value: unknown): FunctionModels | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined

  const entries = Object.entries(value as Record<string, unknown>)
  const sanitized: Partial<Record<FunctionModelId, FunctionModelOverride>> = {}
  for (const [id, raw] of entries) {
    if (!isFunctionModelId(id)) continue
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const { providerId, model } = raw as { providerId?: unknown; model?: unknown }
    if (typeof providerId !== 'string' || providerId.trim().length === 0) continue
    if (typeof model !== 'string' || model.trim().length === 0) continue
    sanitized[id] = { providerId: providerId.trim(), model: model.trim() }
  }

  return Object.keys(sanitized).length === 0 ? undefined : sanitized
}
