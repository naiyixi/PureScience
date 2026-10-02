import type { AcpPromptRequest } from '../../shared/acp'
import type { ArtifactTurnHandle } from './artifact-turn-owner'
import { AcpContextCompactionWorkflow } from './context-compaction-workflow'
import { createInputNoticeResolver } from './input-notice'
import { createLogger, errorLogFields } from '../logger'
import { AcpPromptPreparationOwner, type SelectBridgeSkills } from './prompt-preparation-owner'
import {
  AcpPromptTurnWorkflow,
  type AcpPromptTurnPlanWorkflow,
  type AcpPromptTurnWorkflowOptions
} from './prompt-turn-workflow'
import type { AcpRuntimeOptions } from './runtime'
import type { AcpRuntimeBaseOwners } from './runtime-base-composition'
import type { AcpRuntimeSessionOwners } from './runtime-session-composition'
import type { AcpSettingsCapabilities } from '../settings/service-capabilities'
import { runFunctionModelSkillSelection } from '../settings/function-model-skill-selection'

type AcpRuntimePromptReloadHost = Readonly<{
  disconnect: AcpPromptTurnWorkflowOptions['disconnectForReload']
  resume: AcpPromptTurnWorkflowOptions['resumeAfterReload']
}>

type AcpRuntimePromptHost = Readonly<{
  plan: AcpPromptTurnPlanWorkflow
  reload: AcpRuntimePromptReloadHost
}>

const log = createLogger('acp')

const errorMessage = (error: unknown): string => {
  try {
    const raw = error instanceof Error ? (error as { message?: unknown }).message : error
    return typeof raw === 'string' ? raw : String(raw)
  } catch {
    return 'unknown error'
  }
}

const acpErrorKind = (error: unknown): string | undefined => {
  try {
    const data = (error as { data?: unknown } | null)?.data
    const kind = (data as { errorKind?: unknown } | null | undefined)?.errorKind
    return typeof kind === 'string' ? kind : undefined
  } catch {
    return undefined
  }
}

const safeLogError = (message: string, error: unknown): void => {
  try {
    log.error(message, errorLogFields(error))
  } catch {
    // Prompt projection and the original provider outcome take precedence over diagnostics.
  }
}

// Composes the complete Prompt workflow around authoritative Base and Session owners. The host is
// limited to Plan application policy and public reload re-entry; constructors never invoke it.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
type SkillSelectionFunctionModels = Pick<
  AcpSettingsCapabilities,
  'recordFunctionModelEvent' | 'resolveFunctionModelTarget'
>

/**
 * Skill selection is one of the app's narrow model calls, so it honours the function-level slot: the
 * configured model answers, or the built-in path runs — and either way the trail records which happened,
 * because "the model I configured was not used" has to be answerable rather than merely invisible.
 *
 * Exported and dependency-injected so the wiring itself is testable: the branch that decides between the
 * configured model and the built-in path is exactly where a silent fallback would hide.
 */
// Named so the failure the bridge swallowed reaches the recorder with its cause intact.
const BRIDGE_SELECTION_FAILED = 'bridge-skill-selection-failed'
const BRIDGE_SELECTION_NOT_ATTEMPTED = 'bridge-skill-selection-not-attempted'

export const createSkillSelectionBridge = ({
  functionModels,
  select,
  skillSelectionOutcome
}: {
  functionModels?: SkillSelectionFunctionModels
  select: (
    text: string,
    catalog: Parameters<SelectBridgeSkills>[1],
    signal?: AbortSignal,
    targetOverride?: Parameters<SelectBridgeSkills>[3]
    // Undefined is an honest answer here: the connection owner has no lane to a bridge at all when the
    // session is not connected, and that is the built-in path, not an error.
  ) => Promise<Awaited<ReturnType<SelectBridgeSkills>> | undefined>
  /**
   * What the last call actually did. Without it a failed call and an answered-but-empty one are the same
   * empty list, and the trail would record the first as "the configured model answered" — a claim about a
   * call that never succeeded. Absent ⇒ nothing extra is claimed (the value is still returned).
   */
  skillSelectionOutcome?: () => 'answered' | 'failed' | 'skipped' | undefined
}): SelectBridgeSkills => {
  const builtIn = async (
    text: string,
    catalog: Parameters<SelectBridgeSkills>[1],
    signal?: AbortSignal
  ): Promise<Awaited<ReturnType<SelectBridgeSkills>>> => (await select(text, catalog, signal)) ?? []

  return async (text, catalog, signal) => {
    // The branch itself lives in runFunctionModelSkillSelection so the settings surface's on-demand probe
    // executes the SAME decision instead of a near-copy of it: the probe's whole purpose is to say what a
    // turn would do.
    const { value } = await runFunctionModelSkillSelection({
      functionId: 'skill-selection',
      host: functionModels,
      builtIn: () => builtIn(text, catalog, signal),
      // The call is made, and then what it did is read back: throwing here is how a failure reaches the
      // recorder. The bridge still swallows its own error (a turn must never break on a selector) — this only
      // stops that swallow from being reported as an answer.
      runWithModel: async (target) => {
        const selected = await select(text, catalog, signal, target)
        const outcome = skillSelectionOutcome?.()
        if (outcome === 'failed') throw new Error(BRIDGE_SELECTION_FAILED)
        if (outcome === 'skipped') throw new Error(BRIDGE_SELECTION_NOT_ATTEMPTED)

        return selected ?? []
      },
      classifyRunFailure: (error) =>
        error instanceof Error && error.message === BRIDGE_SELECTION_NOT_ATTEMPTED
          ? 'call-not-attempted'
          : 'call-failed'
    })

    return value
  }
}

const composeAcpRuntimePromptOwners = (
  options: AcpRuntimeOptions,
  base: AcpRuntimeBaseOwners,
  session: AcpRuntimeSessionOwners,
  host: AcpRuntimePromptHost
) => {
  const callbacks = options.callbacks ?? {}
  const activeSession = (sessionId: string) =>
    session.sessionRegistry.lookup(sessionId)?.attachment?.session
  const currentFramework = () => base.backendGeneration.current.framework
  const projectName = (sessionId: string): string =>
    session.sessionEnvironment.projectName(sessionId)
  // The session's working directory, which is what a relative input path in the task is resolved against.
  const sessionCwd = (sessionId: string): string | undefined =>
    session.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().cwd
  const inputNoticeResolver = createInputNoticeResolver()
  const emitState = (): void => session.publication.emitState()
  const diagnosticContext = () => ({
    framework: currentFramework().id,
    generation: base.connectionResources.epoch,
    status: base.snapshotOwner.status
  })
  const emitSkillActivities = (
    sessionId: string,
    promptTurn: number,
    inputs: ReadonlyArray<{ name: string }>,
    status: 'in_progress' | 'completed' | 'failed'
  ): void => {
    for (const [index, { name }] of inputs.entries()) {
      session.publication.pushEvent({
        kind: 'tool',
        level: status === 'failed' ? 'error' : 'info',
        sessionId,
        toolCallId: `purescience-skill-${promptTurn}-${index}`,
        providerToolName: 'skill',
        title: `Loaded skill: ${name}`,
        status
      })
    }
  }
  const openArtifact = async (
    sessionId: string,
    provenanceContext: AcpPromptRequest['provenanceContext']
  ): Promise<ArtifactTurnHandle | undefined> => {
    if (!base.artifactTurns) return undefined
    return base.artifactTurns.open({
      appSessionId: sessionId,
      artifactStorageSessionId:
        base.sessionCapabilities.artifactRoutingIdFor(sessionId) ?? sessionId,
      projectId: projectName(sessionId),
      agentName: currentFramework().displayName,
      provenanceContext
    })
  }
  const publishArtifact = async (
    sessionId: string,
    artifact: ArtifactTurnHandle | undefined,
    onPublished?: () => void
  ): Promise<void> => {
    if (!artifact || !base.artifactTurns) return
    const publication = await base.artifactTurns.finalize(artifact)
    if (!publication) return
    session.publication.pushEvent(
      {
        kind: 'artifact',
        level: 'info',
        sessionId,
        title: 'Generated files',
        runId: publication.runId,
        promptMessageId: publication.promptMessageId,
        artifactSessionId: publication.artifactStorageSessionId,
        artifactClaimId: publication.artifactClaimId,
        artifacts: publication.artifacts
      },
      onPublished
    )
  }
  const disposeArtifact = async (artifact: ArtifactTurnHandle | undefined): Promise<void> => {
    if (artifact) await base.artifactTurns?.dispose(artifact)
  }

  const promptPreparation = new AcpPromptPreparationOwner({
    promptContent: base.promptContentOwner,
    presentation: base.sessionPresentationPolicy,
    contextUsage: base.contextUsageTracker,
    selectBridgeSkills: createSkillSelectionBridge({
      ...(options.functionModels ? { functionModels: options.functionModels } : {}),
      select: (text, catalog, signal, targetOverride) =>
        base.connectionResources.selectBridgeSkills(text, catalog, signal, targetOverride),
      // Read back after the call so a failure is not recorded as an answer.
      skillSelectionOutcome: () => base.connectionResources.bridgeSkillSelectionOutcome()
    }),
    authorizeReferencedUploads: options.skillImport?.authorizeReferencedUploads,
    imageInputCompatibility: options.imageInputCompatibility,
    inputNotice: (request) =>
      inputNoticeResolver.forTurn(request.text ?? '', sessionCwd(request.sessionId)),
    ...(options.notebook
      ? {
          notebook: {
            peekHandoffContext: options.notebook.peekHandoffContext,
            registerTurnInputs: options.notebook.registerTurnInputs
          }
        }
      : {}),
    emitState
  })
  const contextCompactionWorkflow = new AcpContextCompactionWorkflow({
    sessions: { activeSession, currentFramework },
    interactions: base.sessionInteractions,
    context: base.contextUsageTracker,
    promptContent: base.promptContentOwner,
    contextEstimateInput: (sessionId) =>
      session.contextUsagePolicy.resolve(sessionId).estimateInput,
    selectedContextWindow: (sessionId) =>
      session.contextUsagePolicy.resolve(sessionId).selectedWindow,
    routeHiddenNotification: (notification, sessionId) =>
      session.sessionUpdateProjector.route(notification, {
        appSessionId: sessionId,
        visible: false,
        emitState: () => {
          try {
            emitState()
          } catch (error) {
            safeLogError('compaction state callback failed', error)
          }
        }
      }),
    pushEvent: (event) => session.publication.pushEvent(event),
    emitState,
    errorMessage,
    onCompacted: options.contextSummaryCapture
      ? (input) => options.contextSummaryCapture?.(input)
      : undefined
  })
  const promptTurnWorkflow = new AcpPromptTurnWorkflow({
    registry: session.sessionRegistry,
    interactions: base.sessionInteractions,
    skills: base.turnSkills,
    preparation: promptPreparation,
    executor: base.providerPromptExecutor,
    contextUsage: base.contextUsageTracker,
    providerReconnectPending: () => base.connectionTransitions.providerReconnectPending,
    finalizer: base.promptOutcomeFinalizer,
    permission: session.permissionContext,
    environment: {
      backend: () => base.backendGeneration.current,
      tooling: () => session.sessionEnvironment.toolingAvailability(),
      bridgeSkillsAvailable: () => base.connectionResources.bridgeSkillsAvailable,
      skillImportEnabled: () => base.sessionCapabilities.isSkillImportEnabled(),
      contextEstimateInput: (sessionId) =>
        session.contextUsagePolicy.resolve(sessionId).estimateInput,
      selectedContextWindow: (sessionId) =>
        session.contextUsagePolicy.resolve(sessionId).selectedWindow,
      emitSkillActivities,
      onSkillImportAttachmentEligible: callbacks.onSkillImportAttachmentEligible,
      onProviderPromptAccepted: callbacks.onProviderPromptAccepted,
      routeNotification: (notification, sessionId) =>
        session.sessionUpdateProjector.route(notification, { appSessionId: sessionId }),
      diagnosticContext,
      pushUserMessage: ({ sessionId, promptMessageId, text }) =>
        session.publication.pushEvent({
          kind: 'message',
          level: 'info',
          sessionId,
          // App-routed prompts (for example an Auditor correction) do not already exist in the
          // renderer store. Reuse the provenance id so the durable graph and Artifact claim share
          // one Prompt owner instead of inventing two identities for the same turn.
          ...(promptMessageId ? { promptMessageId, messageId: promptMessageId } : {}),
          role: 'user',
          text
        })
    },
    artifacts: {
      open: openArtifact,
      promptMessageIdFor: (sessionId) => base.artifactTurns?.promptMessageIdFor(sessionId),
      publish: publishArtifact,
      dispose: disposeArtifact
    },
    plan: host.plan,
    finalization: {
      errorMessage,
      errorKind: acpErrorKind,
      pushEvent: (event) => session.publication.pushEvent(event),
      onPromptEnded: (sessionId, turnToken) => callbacks.onPromptEnded?.(sessionId, turnToken),
      generationActivityChanged: base.notifyGenerationActivityChanged,
      autoCompact: (sessionId, active, interaction) =>
        contextCompactionWorkflow.compactAutomatic({
          sessionId,
          session: active,
          interaction
        })
    },
    currentCwd: () => base.snapshotOwner.cwd,
    resolveProjectName: projectName,
    disconnectForReload: host.reload.disconnect,
    resumeAfterReload: host.reload.resume,
    recordAdmittedPrompt: (request) => base.handoffContinuity.recordAdmittedPrompt(request),
    onPromptStarted: (sessionId, turnToken, promptAttemptId) =>
      callbacks.onPromptStarted?.(sessionId, turnToken, promptAttemptId),
    emitState
  })

  return Object.freeze({ contextCompactionWorkflow, promptTurnWorkflow })
}
/* eslint-enable @typescript-eslint/explicit-function-return-type */

type AcpRuntimePromptOwners = ReturnType<typeof composeAcpRuntimePromptOwners>

export { composeAcpRuntimePromptOwners }
export type { AcpRuntimePromptHost, AcpRuntimePromptOwners }
