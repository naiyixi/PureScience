import type { ProviderView } from './settings'
import type { ReasoningEffort } from './settings'
import type { ScenarioModelId, ScenarioModels } from './settings'

// v1.46: single source of truth for "which backend does this scenario run?".
//
// Runtime reality: conversation-detail / sub-agent / review turns are executed by the agent
// framework's own tools (Claude Code multi-agent, the reviewer tool, …), so the app cannot inject a
// model into those internal requests. The app CAN guarantee one thing: any request the app itself
// originates for a scenario — today the Reviewer-driven conversations, tomorrow app-created
// sub-agents — resolves to the same rule every time. Agents that read the settings snapshot (the
// app MCP settings surface) can apply the same resolution for their own internal calls.
//
// Resolution rule (mirrors the UI semantics):
//   1. A pinned scenario override wins: its provider/model, with its own reasoningEffort when
//      pinned ('default' means "follow the global level", not "no effort").
//   2. No override → the scenario inherits the active provider/model and the global effort.
export type ResolvedScenarioBackend = {
  providerId: string
  model: string
  reasoningEffort: ReasoningEffort
}

export type ScenarioBackendInput = {
  scenario: ScenarioModelId
  scenarioModels?: ScenarioModels
  providers: readonly ProviderView[]
  activeProviderId?: string
  activeModel?: string
  globalReasoningEffort: ReasoningEffort
}

export const resolveScenarioBackend = (
  input: ScenarioBackendInput
): ResolvedScenarioBackend | null => {
  const override = input.scenarioModels?.[input.scenario]

  const providerId = override?.providerId ?? input.activeProviderId
  const model = override?.model ?? input.activeModel
  if (!providerId || !model) return null
  // A stored override may reference a provider that was later removed; only resolve against live
  // providers so callers never send a request to a phantom backend.
  if (!input.providers.some((provider) => provider.id === providerId)) return null

  const reasoningEffort: ReasoningEffort =
    override && override.reasoningEffort !== undefined && override.reasoningEffort !== 'default'
      ? override.reasoningEffort
      : input.globalReasoningEffort

  return { providerId, model, reasoningEffort }
}
