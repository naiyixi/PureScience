import { homedir } from 'node:os'

import { app } from 'electron'

import type { AcpPermissionRequest, AcpRuntimeEvent, AcpStateSnapshot } from '../../shared/acp'
import { DEFAULT_ARTIFACT_PROJECT_NAME } from '../../shared/artifacts'
import { ELICITATION_CHANNEL_REQUEST } from '../../shared/elicitation'
import {
  filterSpecialistConnectorSkills,
  resolveEffectiveSpecialistSkills
} from '../../shared/specialist'
import type { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ArtifactRepository } from '../artifacts/repository'
import type { ArtifactRunRegistry } from '../artifacts/run-registry'
import { createLogger, errorLogFields } from '../logger'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import type { NotebookHandoffContext } from '../notebook/runtime-service'
import {
  runTaskNotificationInBackground,
  type TaskNotificationService
} from '../notifications/task-notifications'
import type { NotificationInboxController } from '../notifications/notification-inbox-controller'
import type { FolderGrantsService } from '../folder-grants'
import type { PermissionGrantRegistry } from '../permission-grants/registry'
import { broadcastToRenderers } from '../renderer-broadcast'
import type { AcpSettingsCapabilities } from '../settings/service-capabilities'
import {
  buildSpecialistIdentityAppend,
  buildSpecialistIdentityPrefix
} from '../specialist/identity'
import type { ProfileService } from '../specialist/service'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import type { UploadRepository } from '../uploads/repository'
import type { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import { ElicitationBroker } from '../elicitation-broker'
import { createBoundedEventAdmission } from '../event-admission'
import { AgentMcpHttpHost } from './mcp-http-host'
import { projectRegistrySessionGrants } from './permission-broker'
import { AcpRuntime, type AcpRuntimeCallbacks, type AcpRuntimeOptions } from './runtime'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import { AcpRuntimeCoordinator } from './runtime-coordinator'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'
import { RestrictedInferenceRunner } from './restricted-inference-runner'
import { ImageInputCompatibilityOwner } from './image-input-compatibility-owner'
import { VisionEvidenceRepository } from '../vision/vision-evidence-repository'
import { getProjectDbClient } from '../projects/prisma-client'

const log = createLogger('acp')

type AcpRuntimeArtifacts = {
  repository: ArtifactRepository
  runRegistry: ArtifactRunRegistry
  provenanceRepository?: Pick<
    ArtifactProvenanceRepository,
    'listRunVersions' | 'writeAppGeneratedVersion'
  > &
    Partial<Pick<ArtifactProvenanceRepository, 'resolveVersionContent'>>
}

type AcpRuntimeCompositionOptions = AcpRuntimeArtifacts & {
  mcpEntryPath: string
  uploadRepository: UploadRepository
  notebookRpcServer: NotebookLocalRpcServer
  peekNotebookHandoffContext?: (sessionId: string) => NotebookHandoffContext | undefined
  authorizeSkillImportReferencedUploads: (
    projectId: string,
    sessionId: string,
    paths: string[]
  ) => Promise<() => void>
  settingsService: AcpSettingsCapabilities
  permissionGrantRegistry?: PermissionGrantRegistry
  initializationBarrier?: Promise<unknown>
  taskNotifications?: TaskNotificationService
  // Backend-owned message center: terminal task outcomes and blocking permission requests are
  // recorded here so desktop and Web clients share one notification inbox.
  notificationInbox?: Pick<NotificationInboxController, 'record'>
  // User-linked folder grants (`@path/to/folder`) injected into the file-reference resolver.
  folderGrants?: Pick<FolderGrantsService, 'resolveRoot'>
  onSessionTurnStarted?: (sessionId: string, turnToken: string) => void
  onSessionTurnEnded?: (sessionId: string, turnToken: string) => void
  onSkillImportAttachmentEligible?: (
    sessionId: string,
    turnToken: string,
    attachmentUri: string
  ) => void
  onSessionCancellationRequested?: (sessionId: string) => void
  onSessionUnavailable?: (sessionId: string) => void
  onAllSessionsCancellationRequested?: () => void
  onDisconnected?: () => void
  beforeSessionDelete?: (sessionId: string) => Promise<void>
  profileService?: ProfileService
  sessionPersistenceCoordinator?: Pick<
    SessionPersistenceCoordinator,
    | 'readSessionRuntimeContext'
    | 'patchSessionRuntimeContext'
    | 'appendUserMessageToInteraction'
    | 'containsMessageOnActiveBranch'
  >
}

// Composes the compatibility façade while the coordinator remains the cross-generation Session owner.
const createAcpRuntime = ({
  mcpEntryPath,
  repository,
  runRegistry,
  provenanceRepository,
  uploadRepository,
  notebookRpcServer,
  peekNotebookHandoffContext,
  authorizeSkillImportReferencedUploads,
  settingsService,
  permissionGrantRegistry,
  initializationBarrier,
  taskNotifications,
  notificationInbox,
  folderGrants,
  onSessionTurnStarted,
  onSessionTurnEnded,
  onSkillImportAttachmentEligible,
  onSessionCancellationRequested,
  onSessionUnavailable,
  onAllSessionsCancellationRequested,
  onDisconnected,
  beforeSessionDelete,
  profileService,
  sessionPersistenceCoordinator
}: AcpRuntimeCompositionOptions): AcpRuntimeCoordinator => {
  const configRoot = resolveConfigRoot()
  const dataRoot = resolveDataRoot()
  const defaultCwd = homedir()
  // App-owned structured clarification: agent elicitation/create requests are projected to the
  // renderer and block until the user answers, declines, or cancels. The broker is also handed to
  // the coordinator so the renderer's acp:respond-elicitation IPC can settle pending cards.
  const elicitationBroker = new ElicitationBroker({
    emitRequest: (request) => broadcastToRenderers(ELICITATION_CHANNEL_REQUEST, request)
  })
  // Bounded admission for the high-volume agent event stream: transient events are rate-limited
  // per window (excess dropped; the snapshot reconciles), critical events always pass — so a
  // tens-of-thousands-of-events turn never freezes the renderer.
  const admitEvent = createBoundedEventAdmission((event) => broadcastToRenderers('acp:event', event))
  const callbacks: AcpRuntimeCallbacks = {
    onStateChanged: (state: AcpStateSnapshot) => broadcastToRenderers('acp:state', state),
    onEvent: (event: AcpRuntimeEvent) => {
      admitEvent(event)
      // Fire-and-forget: a notification hiccup must never stall the renderer event stream.
      if (taskNotifications) {
        runTaskNotificationInBackground(
          () => taskNotifications.handleRuntimeEvent(event),
          (error) => log.warn('task notification event failed', errorLogFields(error))
        )
      }
      recordInboxOutcome(event)
    },
    onPermissionRequest: (request: AcpPermissionRequest) => {
      broadcastToRenderers('acp:permission-request', request)
      // A pending approval parks the turn; an unfocused user gets a desktop nudge.
      if (taskNotifications) {
        runTaskNotificationInBackground(
          () => taskNotifications.handlePermissionRequest(request),
          (error) => log.warn('permission notification failed', errorLogFields(error))
        )
      }
      recordInboxAuthorization(request)
    }
  }

  // Message-center wiring: terminal task outcomes and parked authorization requests are recorded
  // into the shared inbox (desktop + Web). Deduping on (kind, session, origin) keeps a turn from
  // creating duplicate cards across retries.
  const recordInboxOutcome = (event: AcpRuntimeEvent): void => {
    if (!notificationInbox) return
    const sessionId = event.sessionId
    if (!sessionId) return
    if (event.kind === 'stop') {
      notificationInbox
        .record({
          dedupeKey: `task.completed:${sessionId}:${event.messageId ?? 'turn'}`,
          kind: 'task.completed',
          source: 'agent-tool',
          sessionId,
          originId: event.id,
          // Stable identifiers; the renderer maps them to the interface language.
          title: 'Task completed',
          summary: event.text ?? 'Agent turn completed',
          actionState: 'resolved'
        })
        .catch((error) => log.warn('inbox record failed', errorLogFields(error)))
    } else if (event.kind === 'error') {
      notificationInbox
        .record({
          dedupeKey: `task.failed:${sessionId}:${event.messageId ?? 'turn'}`,
          kind: 'task.failed',
          source: 'agent-tool',
          sessionId,
          originId: event.id,
          title: 'Task failed',
          summary: event.text ?? 'Agent turn failed — inspect the conversation',
          actionState: 'resolved'
        })
        .catch((error) => log.warn('inbox record failed', errorLogFields(error)))
    }
  }

  const recordInboxAuthorization = (request: AcpPermissionRequest): void => {
    notificationInbox
      ?.record({
        dedupeKey: `authorization.required:${request.sessionId}:${request.requestId}`,
        kind: 'authorization.required',
        source: 'agent-tool',
        sessionId: request.sessionId,
        originId: request.requestId,
        title: 'Authorization required',
        summary: request.title ?? 'The agent requests a sensitive operation',
        actionState: 'pending'
      })
      .catch((error) => log.warn('inbox record failed', errorLogFields(error)))
  }

  return new AcpRuntimeCoordinator(
    (runtimeCallbacks, permissionGrantStore) => {
      const selection = settingsService.captureActiveAgentBackendSelection()
      // Vision image relay : a text-only active backend translates attached
      // images into evidence text through the configured Vision model. The runner enforces a
      // tool-less, isolated session per analysis; evidence is cached in the Project DB.
      const visionRunner = new RestrictedInferenceRunner({
        appVersion: app.getVersion(),
        configRoot,
        profileNamespace: 'vision-evidence',
        resolveTarget: (target, context) =>
          settingsService.resolveExplicitAgentBackend(target, context)
      })
      const visionOwner = new ImageInputCompatibilityOwner({
        captureTarget: () => settingsService.getVisionModelTarget(),
        runner: visionRunner,
        evidenceRepository: new VisionEvidenceRepository(() => getProjectDbClient(configRoot))
      })
      const runtimeOptions: AcpRuntimeOptions = {
        appVersion: app.getVersion(),
        // Packaged macOS apps often start with cwd at "/" or the app bundle; use home instead.
        defaultCwd,
        resolveBackend: async (context) =>
          settingsService.resolveAgentBackend(await selection, context),
        imageInputCompatibility: visionOwner,
        mcpHttpHost: new AgentMcpHttpHost(),
        skills: {
          needForceLoad: (ids) => settingsService.skillsNeedingForceLoad(ids),
          namesForIds: (ids) => settingsService.skillNudgeNamesForIds(ids),
          descriptorsForIds: (ids, codexHome) =>
            settingsService.codexSkillDescriptorsForIds(ids, codexHome),
          catalogForCodexHome: (codexHome) => settingsService.codexSkillCatalog(codexHome)
        },
        artifacts: {
          configRoot,
          dataRoot,
          projectName: DEFAULT_ARTIFACT_PROJECT_NAME,
          mcpEntryPath,
          repository,
          runRegistry,
          provenance: provenanceRepository,
          getRpcConnection: () => notebookRpcServer.ensureStarted(),
          issueRpcCapability: (binding) => notebookRpcServer.issueArtifactRunCapability(binding),
          revokeRpcCapability: (token) => notebookRpcServer.revokeArtifactRunCapability(token)
        },
        uploads: { repository: uploadRepository },
        notebook: {
          projectName: DEFAULT_ARTIFACT_PROJECT_NAME,
          mcpEntryPath,
          getRpcConnection: ({ sessionId, projectId }) =>
            notebookRpcServer.issueSessionConnection(sessionId, projectId),
          registerSessionAlias: (aliasSessionId, sessionId) =>
            notebookRpcServer.registerSessionAlias(aliasSessionId, sessionId),
          releaseSessionCapabilities: (sessionId) =>
            notebookRpcServer.releaseSessionCapabilities(sessionId),
          registerSessionSpecialist: (sessionId, specialistId) =>
            notebookRpcServer.registerSessionSpecialist(sessionId, specialistId),
          setArtifactProvenanceContext: (sessionId, context) =>
            notebookRpcServer.setArtifactProvenanceContext(sessionId, context),
          registerTurnInputs: (request) => notebookRpcServer.registerNotebookTurnInputs(request),
          peekHandoffContext: peekNotebookHandoffContext
        },
        skillImport: {
          mcpEntryPath,
          configDir: configRoot,
          isEnabled: () => settingsService.getConversationSkillImportEnabled(),
          getRpcConnection: ({ sessionId }) =>
            notebookRpcServer.issueSkillImportConnection(sessionId),
          registerSessionAlias: (aliasSessionId, sessionId) =>
            notebookRpcServer.registerSessionAlias(aliasSessionId, sessionId),
          releaseSessionCapabilities: (sessionId) =>
            notebookRpcServer.releaseSessionCapabilities(sessionId),
          authorizeReferencedUploads: authorizeSkillImportReferencedUploads
        },
        memory: {
          mcpEntryPath,
          getRpcConnection: ({ sessionId }) => notebookRpcServer.issueMemoryConnection(sessionId),
          registerSessionAlias: (aliasSessionId, sessionId) =>
            notebookRpcServer.registerSessionAlias(aliasSessionId, sessionId)
        },
        contextSummary: {
          mcpEntryPath,
          getRpcConnection: ({ sessionId }) =>
            notebookRpcServer.issueContextSummaryConnection(sessionId),
          registerSessionAlias: (aliasSessionId, sessionId) =>
            notebookRpcServer.registerSessionAlias(aliasSessionId, sessionId)
        },
        elicitation: {
          requestElicitation: (request, sessionId) =>
            elicitationBroker.requestElicitation(request, sessionId),
          observeElicitationComplete: (notification) =>
            elicitationBroker.observeElicitationComplete(notification)
        },
        folderGrants,
        ...(sessionPersistenceCoordinator
          ? {
              plan: {
                mcpEntryPath,
                getRpcConnection: ({ sessionId, projectId }) =>
                  notebookRpcServer.issuePlanConnection(sessionId, projectId),
                registerSessionAlias: (aliasSessionId, sessionId) =>
                  notebookRpcServer.registerSessionAlias(aliasSessionId, sessionId),
                sessions: sessionPersistenceCoordinator
              }
            }
          : {}),
        callbacks: runtimeCallbacks,
        permissionGrantStore,
        permissionGrantRegistry,
        resolveSpecialistIdentity: profileService
          ? async (specialistId: string, frameworkId: string) => {
              let profile
              try {
                profile = await profileService.resolveRunnableById(specialistId)
              } catch {
                // Profile not found or corrupt
                return undefined
              }
              if (!profile.enabled) return undefined
              const append = buildSpecialistIdentityAppend(profile)
              const prefix = buildSpecialistIdentityPrefix(profile)
              if (frameworkId === 'claude-code') return { append, prefix: '' }
              return { append: '', prefix }
            }
          : undefined,
        resolveSpecialistSkills: profileService
          ? async (specialistId) => {
              try {
                const profile = await profileService.resolveRunnableById(specialistId)
                if (!profile.enabled) {
                  return { kind: 'unavailable', reason: 'The bound specialist is disabled.' }
                }
                const effective = resolveEffectiveSpecialistSkills(
                  profile,
                  await settingsService.listSpecialistSkillCatalog()
                )
                if (effective.kind === 'specialist') {
                  const provisioned = await settingsService.provisionedConnectorSkillNames()
                  const connectorSkills = filterSpecialistConnectorSkills(provisioned, profile)
                  if (connectorSkills.length > 0) {
                    return {
                      ...effective,
                      frameworkNames: [...effective.frameworkNames, ...connectorSkills]
                    }
                  }
                }
                return effective
              } catch {
                return { kind: 'unavailable', reason: 'The bound specialist is unavailable.' }
              }
            }
          : undefined
      }
      const baseOwners = composeAcpRuntimeBaseOwners(runtimeOptions)
      return new AcpRuntime(
        runtimeOptions,
        baseOwners,
        composeAcpRuntimeSessionOwners(runtimeOptions, baseOwners)
      )
    },
    callbacks,
    defaultCwd,
    initializationBarrier,
    onDisconnected,
    onSessionUnavailable,
    {
      onSessionTurnStarted,
      onSessionTurnEnded,
      onSkillImportAttachmentEligible,
      onSessionCancellationRequested,
      onAllSessionsCancellationRequested,
      beforeSessionDelete
    },
    permissionGrantRegistry
      ? () => projectRegistrySessionGrants(permissionGrantRegistry.listCached())
      : undefined,
    elicitationBroker
  )
}

export { createAcpRuntime }
export type { AcpRuntimeCompositionOptions }
