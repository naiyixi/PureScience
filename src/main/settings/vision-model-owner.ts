import {
  isClaudeSubscriptionProvider,
  isCodexSubscriptionProvider,
  providerValidationFailed,
  type VisionModelConfiguration
} from '../../shared/settings'
import type { StoredProvider } from './types'
import { isVendorModelMultimodal } from '../../shared/provider-registry'
import { DEFAULT_AGENT_FRAMEWORK_ID, getAgentFramework } from '../agent-framework'
import type { AgentBackendResolver, ExplicitAgentBackendTarget } from './backend-resolver'
import type { ProviderAccountsModule } from './provider-accounts'
import type { SettingsRepository } from './repository'

type VisionModelOwnerOptions = Readonly<{
  repository: SettingsRepository
  providers: ProviderAccountsModule
  backendResolver: Pick<AgentBackendResolver, 'captureConfiguredSelection'>
}>


// Whether THIS model takes image input — decided by the model, not by whichever model the provider is
// currently set to. The Vision relay exists precisely for the case where the main model is text-only and
// a separate model does the seeing; asking the provider (which reports the *active* model's capability)
// made that configuration impossible to save: the picker offered deepseek-v4-flash-vision-exp and the
// write was refused with "does not support image input". The user saw a click that did nothing.
const acceptsImageInput = (provider: StoredProvider, model: string): boolean => {
  if (isCodexSubscriptionProvider(provider.type)) return true
  if (isClaudeSubscriptionProvider(provider.type)) return true
  if (provider.type === 'custom') return provider.supportsImageInput === true
  if (provider.type === 'official' && provider.vendorId) {
    return isVendorModelMultimodal(provider.vendorId, model)
  }

  return provider.supportsImageInput === true
}

// Owns the optional Vision model relay target . The Vision model is a fixed
// provider+model pair used ONLY to translate image input when the active backend is text-only.
// Validation happens here before any write: the provider must exist, validate, not be a Codex
// subscription, be usable by the active framework, and support image input.
class VisionModelOwner {
  constructor(private readonly options: VisionModelOwnerOptions) {}

  // Validates and persists the Vision model configuration; undefined disables the relay.
  async set(configuration: VisionModelConfiguration | undefined): Promise<void> {
    if (configuration) {
      const settings = await this.options.repository.getSettings()
      const provider = settings.providers.find((entry) => entry.id === configuration.providerId)
      if (!provider || providerValidationFailed(provider)) {
        throw new Error(
          'The selected Vision model is no longer available. Refresh the model catalog.'
        )
      }
      if (isCodexSubscriptionProvider(provider.type)) {
        throw new Error('Codex subscription models cannot run as the Vision model.')
      }
      const { frameworkId } = await this.options.backendResolver.captureConfiguredSelection()
      const framework = getAgentFramework(
        frameworkId ?? settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID
      )
      const target = this.options.providers.resolveRuntimeTarget(
        provider,
        { kind: 'required', model: configuration.model },
        framework
      )
      if (
        !target.frameworkCompatible ||
        (framework.id === 'codex' && !target.modelBridgeSupported)
      ) {
        throw new Error(
          'The selected Vision model is not available for the active Agent Framework. Refresh the model catalog.'
        )
      }
      if (!acceptsImageInput(provider, configuration.model)) {
        throw new Error('The selected Vision model does not support image input.')
      }
    }
    await this.options.repository.setVisionModel(configuration)
  }

  // Resolves the persisted Vision configuration into an explicit backend target, or undefined when
  // the relay is disabled. Throws when the persisted target is no longer usable so callers surface
  // the misconfiguration instead of silently dropping image input.
  async admit(): Promise<ExplicitAgentBackendTarget | undefined> {
    const settings = await this.options.repository.getSettings()
    const configuration = settings.visionModel
    if (!configuration) return undefined
    const provider = settings.providers.find((entry) => entry.id === configuration.providerId)
    if (!provider || providerValidationFailed(provider)) {
      throw new Error('The configured Vision model provider is unavailable.')
    }
    if (isCodexSubscriptionProvider(provider.type)) {
      throw new Error('The configured Vision model transport is unavailable.')
    }
    const { frameworkId } = await this.options.backendResolver.captureConfiguredSelection()
    const framework = getAgentFramework(frameworkId)
    const target = this.options.providers.resolveRuntimeTarget(
      provider,
      { kind: 'required', model: configuration.model },
      framework
    )
    if (
      !target.frameworkCompatible ||
      (framework.id === 'codex' && !target.modelBridgeSupported) ||
      !acceptsImageInput(provider, configuration.model)
    ) {
      throw new Error('The configured Vision model is unavailable for image input.')
    }
    return Object.freeze({
      frameworkId,
      providerId: configuration.providerId,
      model: Object.freeze({ kind: 'required' as const, id: configuration.model }),
      reasoningEffort: configuration.reasoningEffort
    })
  }
}

const createVisionModels = (
  repository: SettingsRepository,
  providers: ProviderAccountsModule,
  backendResolver: AgentBackendResolver
): VisionModelOwner => new VisionModelOwner({ repository, providers, backendResolver })

export { createVisionModels, VisionModelOwner }
export type { VisionModelOwnerOptions }
