import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { customConnectorSlug } from '../shared/custom-connector'
import { isAllowedExternalUrl } from './navigation-policy'

import {
  app,
  BrowserWindow,
  dialog,
  net,
  Notification,
  protocol,
  shell,
  webContents,
  type WebContents
} from 'electron'

import { createIpcHandlerInstallationScope, ipcMainHandle } from './ipc-handler-registry'
import {
  APPLICATION_MODULE_DISPOSAL_BUDGET_MS,
  composeApplicationRuntimeWithAdapters,
  type ApplicationModuleBuilder
} from './application-runtime'
import {
  createApplicationCommandComposition,
  type ApplicationCommandComposition,
  type ApplicationCommandCompositionDependencies
} from './application-command-composition'
import type { ApplicationInvocation } from './application-command-router'
import type { PersistedChatSession } from '../shared/session-persistence'
import { createApplicationEventModule, type ApplicationEventSource } from './application-events'
import { projectTaskRuntimeEvent } from './web-service/application-event-projections'

import { createAcpRuntime } from './acp/runtime-composition'
import { createAcpCreateSessionWorkflow } from './acp/create-session-workflow'
import { createAcpHandlerWorkflows } from './acp/handler-workflows'
import { createAcpTaskAgentPort } from './acp/task-agent-port'
import { ArtifactCodeReconstructionRunner } from './acp/artifact-code-reconstruction-runner'
import { ArchiveCoordinator } from './archive/coordinator'
import { ArtifactCodeReconstructionService } from './artifacts/code-reconstruction'
import { createArtifactReplayAdapter } from './artifacts/replay-composition'
import {
  createArtifactHandlers,
  createDefaultArtifactRepository,
  registerArtifactIpcHandlers
} from './artifacts/ipc'
import { ArtifactProvenanceRepository } from './artifacts/provenance-repository'
import { createArtifactReproducibilityService } from './artifacts/reproducibility-service'
import { createReproductionFileObserver } from './artifacts/reproduction-file-observer'
import { runSealedRecipeReplay } from './artifacts/reproducibility-replay-runner'
import {
  replayEnvironmentName,
  resolveReplayInterpreter,
  resolveStoredInputPath
} from './artifacts/reproduction-runtime-scope'
import { ProvenanceMessageSnapshotRepository } from './artifacts/provenance-message-snapshot'
import { ArtifactRunRegistry } from './artifacts/run-registry'
import { createComputeIpcModule } from './compute/ipc'
import { createReferencesIpcModule, installReferencesIpcHandlers } from './references/ipc'
import { fingerprintPdfFile } from './settings/pdf-fingerprint'
import { attachEnabledComputeHosts } from './compute/enabled-hosts-registry'
import { createComputeJobRuntime } from './compute/job-runtime'
import { BackgroundDeliveryOwner } from './background-delivery/owner'
import { BackgroundDeliveryRepository } from './background-delivery/repository'
import { deliverComputeResult, recoverComputeResults } from './background-delivery/compute-source'
import { backgroundDeliveryLabelsFor } from '../shared/background-delivery-labels'
import type { BackgroundDelivery } from '../shared/background-delivery'
import type { ComputeJob } from '../shared/compute'
import { waitForInitialConnectorRefresh } from './connector-reload'
import { ApprovalBroker } from './connectors/approval-broker'
import { McpClientManager } from './connectors/mcp-client-manager'
import { isCustomMcpServerRouteSafe, toCustomMcpConfig } from './connectors/custom-mcp-bootstrap'
import { createMoleculePreviewHandler } from './connectors/molecule-preview'
import { ALL_CONNECTOR_IDS } from './connectors/registry'
import { ConnectorRuntimeSettingsProjection } from './connectors/runtime-settings-projection'
import { ConnectorService } from './connectors/service'
import { createSubAgentExecutor } from './connectors/sub-agent-executor'
import type { ToolContext } from './connectors/types'
import { registerFileSaveHandlers } from './file-save'
import { createSessionArtifactFileResolver } from './session-artifact-file-resolver'
import { createCliCommandOwner, registerCliInstallIpcHandlers } from './cli-install/ipc'
import { createGithubCommandOwner, registerGithubIpcHandlers } from './github-ipc'
import {
  BackendShutdownOutcomeError,
  BackendShutdownCoordinator,
  QUIT_SHUTDOWN_BUDGET_MS,
  UPDATE_SHUTDOWN_BUDGET_MS,
  type ShutdownStepOutcome
} from './lifecycle-shutdown'
import { registerLifecycleIpcHandlers } from './lifecycle-broadcast'
import { createLogsCommandOwner, registerLogsIpcHandlers } from './logs-ipc'
import { registerNetworkIpcHandlers } from './network-ipc'
import { registerWindowIpcHandlers } from './window-ipc'
import { registerWindowFindIpcHandlers } from './window-find-ipc'
import { TaskNotificationService } from './notifications/task-notifications'
import { createNotificationInboxController } from './notifications/notification-inbox-controller'
import { registerNotificationInboxIpcAdapter } from './notifications/notification-inbox-ipc'
import { NotificationInboxDbRepository } from './notifications/notification-inbox-repository'
import { bindNotificationInboxDeletionRuntime } from './notifications/notification-inbox-runtime'
import {
  buildSkillImportApprovalBroadcast,
  buildConnectorApprovalBroadcast,
  buildTaskNotificationShow
} from './notifications/electron-wiring'
import { createLogger, diagnosticErrorFields, errorLogFields } from './logger'
import { startDiagnosticOperation } from './diagnostics/operation'
import { broadcastNotebookEnvProgress, registerNotebookEnvIpcHandlers } from './notebook/env-ipc'
import {
  createNotebookApplicationModule,
  createNotebookLocalRpcModule,
  installNotebookEnvironmentSurface
} from './notebook/application'
import { serializeProvisioner } from './notebook/environment-operation-foundation'
import { createNotebookEnvironmentLifecycle } from './notebook/environment-lifecycle-workflows'
import {
  createManagedPreviewOwnerRegistry,
  installManagedPreviewElectronAdapter
} from './managed-preview-ipc'
import { ManagedPreviewResources } from './managed-preview-resources'
import type { ManagedPreviewSource } from '../shared/preview-resources'
import {
  createOfficePreviewFrameProcessResolver,
  createOfficePreviewProcessMemoryReader
} from './office-preview/office-preview-electron'
import { registerOfficePreviewIpcHandlers } from './office-preview/office-preview-ipc'
import {
  createOfficePreviewRuntimeUrl,
  registerOfficePreviewRuntimeProtocol
} from './office-preview/office-preview-runtime-protocol'
import { OfficePreviewSupervisor } from './office-preview/office-preview-supervisor'
import { registerNotebookIpcHandlers } from './notebook/ipc'
import { registerRuntimeIpcHandlers } from './notebook/runtime-ipc'
import { NotebookRunRepository, getNotebookDataRoot, getRuntimeRoot } from './notebook/repository'
import { NotebookLocalRpcServer } from './notebook/local-rpc-server'
import { NotebookInputRegistry } from './notebook/input-registry'
import { effectiveMirrorAsync } from './notebook/mirror-probe'
import { createProductionProvisioner, type RuntimeProvisioner } from './notebook/provisioner'
import { createRuntimeSelectionWorkflows } from './notebook/runtime-selection-workflows'
import { runtimeRoot } from './notebook/runtime-paths'
import type { NotebookEnvironmentManager } from './notebook/runtime-service'
import { parseArtifactVersionLocator } from '../shared/artifact-provenance'
import { DEFAULT_ARTIFACT_PROJECT_NAME } from '../shared/artifacts'
import type { NotebookLanguage } from '../shared/notebook'
import { OFFICE_PREVIEW_STATE_CHANNEL } from '../shared/office-preview'
import { prepareExternalPythonRuntime } from './notebook/venv-overlay'
import {
  createDefaultPreviewStateRepository,
  createDefaultProjectRepository,
  createProjectHandlers,
  registerProjectIpcHandlers
} from './projects/ipc'
import { createReviewerCommandOwner, registerReviewerIpcHandlers } from './reviewer/ipc'
import { createRoutineCommandOwner, registerRoutineIpcHandlers } from './settings/routine-ipc'
import { createEndpointCommandOwner, registerEndpointIpcHandlers } from './settings/endpoint-ipc'
import {
  createAnnotationCommandOwner,
  registerAnnotationIpcHandlers
} from './settings/annotation-ipc'
import { AnnotationRepository } from './settings/annotation-repository'
import { BookmarkRepository } from './settings/bookmark-repository'
import { createBookmarkCommandOwner, registerBookmarkIpcHandlers } from './settings/bookmark-ipc'
import { createPdfCommandOwner, registerPdfIpcHandlers } from './settings/pdf-ipc'
import { PdfService } from './settings/pdf-service'
import { createFigureCommandOwner, registerFigureIpcHandlers } from './settings/figure-ipc'
import { reviewFigure } from './settings/figure-review-service'
import {
  createHostQueryCommandOwner,
  registerHostQueryIpcHandlers
} from './settings/host-query-ipc'
import { TaskCheckpointStore } from './settings/task-checkpoint-store'
import { evaluateCheckpointFreshness, type TaskCheckpointPatch } from '../shared/task-checkpoint'
import { HostQueryService } from './settings/host-query-service'
import type { FigureReviewRequest } from '../shared/figure'
import {
  createDefaultReviewRepository,
  createDefaultSessionRepository,
  createSessionPersistenceHandlers,
  loadCatalogAfterProjectRecovery,
  loadSessionMetadataAfterProjectRecovery,
  loadSessionsAfterProjectRecovery,
  registerSessionPersistenceIpcHandlers
} from './session-persistence/ipc'
import {
  createConversationExportService,
  registerConversationExportIpcHandler
} from './session-persistence/conversation-export'
import { createProjectFilesHandlers, registerProjectFilesIpcHandlers } from './project-files/ipc'
import { createSearchIpcHandlers, registerSearchIpcHandlers } from './search/ipc'
import { GLOBAL_SEARCH_FILE_LIST_MAX_PAGES } from './search/handlers'
import { MAX_PAGE_LIMIT as MAX_PROJECT_FILES_PAGE_LIMIT } from './project-files/query-support'
import { createSessionIndex } from './search/session-index'
import { getSessionRevision } from './session-persistence/session-revision'
import { createSearchEvidenceService } from './search/search-evidence'
import { createSearchFileTextReader, type SearchFileTextItem } from './search/file-text-reader'
import type { ReadArtifactPreviewRequest, ArtifactPreviewResult } from '../shared/artifacts'
import { toSearchableMessages } from './search/handlers'
import { createManagedFileIndexRepository } from './project-files/repository'
import { ProjectDeletionCoordinator } from './projects/deletion-coordinator'
import { getProjectDbClient } from './projects/prisma-client'
import { createPermissionGrantRegistry } from './permission-grants/registry'
import { isPermissionGrantScopeLive } from './permission-grants/scope-liveness'
import { registerPermissionGrantIpcAdapter } from './permission-grants/ipc'
import { createPermissionGrantProjectionController } from './permission-grants/projection-controller'
import { reconcilePermissionGrantOwners } from './permission-grants/reconciliation'
import { SessionPersistenceCoordinator } from './session-persistence/coordinator'
import { type SessionPersistenceBackend } from './session-persistence/ipc'
import { tryDecryptKey } from './settings/crypto'
import { SETTINGS_INSTALL_LOG_CHANNEL, registerSettingsIpcHandlers } from './settings/ipc'
import { registerLocalFsIpcHandlers } from './local-fs/ipc'
import { LocalFsService } from './local-fs/service'
import { FolderGrantsService } from './folder-grants'
import { registerFolderGrantsIpcHandlers } from './folder-grants-ipc'
import { getAppClaudeConfigDir } from './settings/provider-env'
import { createDefaultSettingsService } from './settings/service'
import { ContextSummaryRepository } from './settings/context-summary-repository'
import { createContextSummaryCapture } from './settings/context-summary-capture'
import { RoutineRepository } from './settings/routine-repository'
import { EndpointRepository } from './settings/endpoint-repository'
import { EndpointManager } from './settings/endpoint-manager'
import { RoutineScheduler } from './settings/routine-scheduler'
import type { NotebookRuntimeSettings } from './settings/capabilities'
import type { WindowSettingsCapabilities } from './settings/service-capabilities'
import { createSettingsWorkflows } from './settings/workflows'
import { showSettingsSaveDialog } from './settings/save-dialog'
import { ProfileService } from './specialist/service'
import { SpecialistRepository } from './specialist/repository'
import { BuiltinSpecialistRegistry } from './specialist/builtin-registry'
import { composeBuiltinSkillCatalog } from './specialist/package/builtin-skill-catalog'
import { SpecialistPackageService } from './specialist/package/service'
import { MarketplaceService } from './specialist/marketplace/service'
import { MarketplaceRepository } from './specialist/marketplace/repository'
import { OFFICIAL_MARKETPLACE_SOURCE } from './specialist/marketplace/official-source'
import { SPECIALIST_MARKETPLACE_IPC } from '../shared/specialist-marketplace'
import {
  saveSpecialistExport,
  saveSpecialistPackageReport,
  selectSpecialistArchive
} from './specialist/package/electron-adapter'
import { UserSkillSpecialistPackageAdapter } from './skills/specialist-package-adapter'
import { BundledSkillSpecialistPackageAdapter } from './skills/builtin-specialist-package-adapter'
import { saveSkillExport } from './skills/export'
import { AgentsService } from './agents/agents-service'
import {
  CompletionGateCoordinator,
  CompletionGateRuntimeRegistry,
  createCompletionGatedControlToolInterceptor,
  createCompletionGateSwitchNotifier
} from './agents/completion-gate'
import { createProductionAppHandoffRuntime } from './agents/app-handoff-runtime'
import {
  AcpSpecialistApprovalGateway,
  createAcpBackedSpecialistBridge
} from './agents/specialist-approval-gateway'
import {
  CompletionHandoffLifecycle,
  FileCompletionHandoffRepository
} from './agents/completion-handoff-lifecycle'
import { registerCompletionHandoffIpcHandlers } from './agents/completion-handoff-ipc'
import {
  registerClaudeCodeCompletionGateRuntime,
  selectPersistedUserTaskContext
} from './agents/claude-code-handoff'
import { installCompletionGateDiagnostics } from './agents/completion-gate-diagnostics'
import { PendingSessionSpecialistBindings } from './agents/pending-session-specialist-bindings'
import { createCodexCompletionGateRuntime } from './acp/codex-completion-handoff'
import { createOpenCodeImmediateHandoffRuntime } from './acp/opencode-immediate-handoff'
import { registerSpecialistIpcHandlers } from './specialist/ipc'
import {
  createContributionTemplateExporter,
  resolveContributionTemplateReadmePath
} from './specialist/package/contribution-template'
import { SessionBindingService } from './specialist/session-binding'
import { SPECIALIST_IPC } from '../shared/specialist'
import {
  CONNECTOR_TEMPLATE_MAX_BYTES,
  type AppIconPreview,
  type AppIconVariant,
  type RespondApprovalRequest
} from '../shared/settings'
import { registerStorageIpcHandlers } from './storage/ipc'
import {
  registerSessionPackageImportIpcHandlers,
  registerSessionPackageIpcHandlers
} from './session-package/ipc'
import { createSessionPackageImportOwner } from './session-package/import-owner'
import { createSessionPackageFileLister } from './session-package/files'
import { DEFAULT_SESSION_PACKAGE_MAX_FILE_BYTES } from './session-package/export'
import { createStorageCommandOwner } from './storage/command-owner'
import { withDataRootWrite } from './storage/migration-state'
import { normalizeLegacyDataPaths } from './storage/normalize-legacy-paths'
import { detectActiveSessions } from './storage/detect-active'
import {
  computeDefaultDataRoot,
  initDataRoot,
  resolveConfigRoot,
  resolveDataRoot,
  resolveStorageRoot,
  samePath
} from './storage-root'
import { createUpdateCommandOwner, registerUpdateIpcHandlers } from './update/ipc'
import { createUpdateStrategy } from './update/create-strategy'
import { startUpdateScheduler } from './update/scheduler'
import { createDefaultUploadRepository, registerUploadIpcHandlers } from './uploads/ipc'
import { createUploadCommandOwner } from './uploads/command-owner'
import { broadcastToRenderers, installRendererBroadcastEventHub } from './renderer-broadcast'
import {
  installElectronRuntimeAdapters,
  type ElectronRuntimeAdapterInterfaces,
  type NamedElectronSurfaceAdapter
} from './runtime-electron-wiring'
import { ConversationSkillImporter, SkillImportApprovalBroker } from './skills/conversation-import'
import { SkillCreator } from './skills/skill-creator'
import type { ConversationSkillImportApprovalResponse } from '../shared/settings'
import type { TaskAgentPort } from './tasks/task-runner'

const permissionGrantsLog = createLogger('permission-grants')
// How long a delivery turn waits for a session that is already running a turn, and how often it looks.
const BACKGROUND_DELIVERY_TURN_WAIT_MS = 15 * 60 * 1000
const BACKGROUND_DELIVERY_TURN_POLL_MS = 500

type IpcRegistrationOptions = {
  mainEntryPath: string
  // Headless web-serve launches (--serve) have no local desktop user; task notifications are
  // disabled there by contract, not just incidentally via Notification.isSupported().
  headless?: boolean
  // Applies a newly-selected app-icon variant to the window + dock/taskbar and the Windows tray.
  // Supplied by the desktop startup path; absent in web/headless mode (no local window to re-skin).
  onAppIconVariantChanged?: (variant: AppIconVariant) => void
  // Renders the built-in icon variants to preview data URLs for the Appearance picker.
  listAppIconPreviews?: () => AppIconPreview[]
  // Retained as an explicit startup marker while the app owns the only handoff composition.
  handoffRuntime?: 'production'
}

export type ApplicationRuntimeInterfaces = {
  applicationCommands: Pick<ApplicationCommandComposition, 'localWeb' | 'remoteWeb' | 'task'>
  applicationEvents: ApplicationEventSource
  bindRemoteAccess: ApplicationCommandComposition['bindRemoteAccess']
  taskNotifications: Pick<
    TaskNotificationService,
    'setActivationHandler' | 'setAttentionHandlers' | 'setPendingOpenSession' | 'setUnreadHandler'
  >
  notificationInbox: Pick<
    import('./notifications/notification-inbox-controller').NotificationInboxController,
    'configureDesktop' | 'syncViewState' | 'handleAppFocus' | 'handleWindowCreated' | 'refreshBadge'
  >
  settingsService: WindowSettingsCapabilities
  taskAgent: TaskAgentPort
  sessionDeletionCapability: Pick<SessionPersistenceCoordinator, 'setSessionDeletionHandlers'>
  archiveCapability: Pick<ArchiveCoordinator, 'isSessionAvailableById' | 'setMarkReadSessions'>
  detectActiveSessions: () => ReturnType<typeof detectActiveSessions>
  prepareForQuit: () => Promise<Extract<ShutdownStepOutcome, 'completed' | 'timeout' | 'failed'>>
}

type ApplicationModuleInterfaces = ApplicationRuntimeInterfaces & {
  readonly electronAdapters: ElectronRuntimeAdapterInterfaces
}

type IpcRegistration = ApplicationRuntimeInterfaces & {
  dispose: () => Promise<void>
}

// Builds a short, human-readable preview of a connector call's arguments for the approval card.
const previewArgs = (args: Record<string, unknown>): string => {
  let json: string
  try {
    json = JSON.stringify(args)
  } catch {
    json = '{…}'
  }
  return json.length > 300 ? `${json.slice(0, 300)}…` : json
}

// Constructs application-owned modules and their narrow Electron adapter interfaces. The factory does
// not register a channel or protocol; transport installation happens only after construction succeeds.
const createApplicationModules = async (
  {
    mainEntryPath,
    headless = false,
    onAppIconVariantChanged,
    listAppIconPreviews
  }: IpcRegistrationOptions,
  modules: ApplicationModuleBuilder
): Promise<ApplicationModuleInterfaces> => {
  const beforeComputeAdapters: NamedElectronSurfaceAdapter[] = []
  const beforeAcpAdapters: NamedElectronSurfaceAdapter[] = []
  const afterAcpAdapters: NamedElectronSurfaceAdapter[] = []
  let surfaceAdapters = beforeComputeAdapters
  const declareElectronAdapter = (name: string, install: () => void | (() => void)): void => {
    surfaceAdapters.push({
      name,
      install: () => {
        const scope = createIpcHandlerInstallationScope()
        try {
          const cleanup = install()
          return scope.complete(typeof cleanup === 'function' ? cleanup : undefined)
        } catch (error) {
          scope.rollback()
          throw error
        }
      }
    })
  }
  const applicationEvents = await modules.add(
    installRendererBroadcastEventHub,
    createApplicationEventModule
  )
  // One settings service backs both the settings IPC and the ACP spawn config (single source of truth).
  const settingsService = await modules.add(undefined, () => ({
    capability: createDefaultSettingsService()
  }))
  const storedSettings = await settingsService.getStoredSettings()
  const storageLog = createLogger('storage')
  // Prime the data-root cache from settings before any data repository is constructed below. A change
  // to this value only takes effect after a restart, so reading it once here is sufficient.
  initDataRoot(storedSettings.dataRoot)
  // Re-apply persisted child-process network controls (egress allowlist + manual proxy) so a
  // restart keeps the previous session's restrictions/route without requiring a settings edit.
  await settingsService.hydrateChildProxyRuntime(storedSettings)
  const notificationInbox = createNotificationInboxController({
    headless,
    repository: new NotificationInboxDbRepository(() => getProjectDbClient(resolveStorageRoot())),
    onChanged: (event) => applicationEvents.publish('notifications:changed', event),
    onError: (error) =>
      createLogger('notifications').warn('message center operation failed', errorLogFields(error))
  })
  await notificationInbox.restore()
  // Record only the location class. Absolute paths (including reversible code-point renderings) can
  // expose usernames and folder names in a support bundle.
  storageLog.info('data root resolved', {
    location: samePath(resolveDataRoot(), computeDefaultDataRoot()) ? 'default' : 'custom'
  })

  // Constructed once here (rather than left to each register*IpcHandlers' own default) so the
  // one-time legacy-path normalization pass below can share the exact instances the IPC surface uses.
  const uploadRepository = createDefaultUploadRepository()
  try {
    await uploadRepository.recoverStagingUploads()
  } catch (error) {
    // Ready bytes remain fail-closed; keep startup available so Files can surface unaffected rows and
    // the next launch can retry any recoverable staging Version.
    storageLog.error(
      'staging upload recovery incomplete; will retry next launch',
      diagnosticErrorFields(error)
    )
  }
  const sessionRepository = createDefaultSessionRepository()
  const projectRepository = createDefaultProjectRepository()
  const previewStateRepository = createDefaultPreviewStateRepository()

  // One-time conversion of any legacy absolute data-root paths on disk (pre-$DATA-sentinel installs)
  // into the portable "$DATA/..." form, guarded so it only ever runs once. Never allowed to block
  // startup on failure: an error is logged and the marker stays unset, so the pass simply retries on
  // the next launch.
  if (!storedSettings.pathsNormalizedAt) {
    const normalizationOperation = startDiagnosticOperation(storageLog, {
      operation: 'legacy-data-root-normalization',
      fields: { mode: 'legacy-normalize' }
    })
    normalizationOperation.phase('rewrite-paths')
    try {
      await normalizeLegacyDataPaths({
        sessionRepository,
        sessionUploads: uploadRepository,
        previewStateRepository,
        projectRepository,
        dataRoot: resolveDataRoot()
      })
      normalizationOperation.phase('persist-marker')
      await settingsService.markPathsNormalized()
      normalizationOperation.complete()
    } catch (error) {
      normalizationOperation.fail(error)
    }
  }

  // Share one repository and registry so runtime artifact claims and renderer finalization meet.
  const artifactRepository = createDefaultArtifactRepository()
  const artifactProvenanceRepository = new ArtifactProvenanceRepository({
    storageRoot: resolveDataRoot(),
    getClient: () => getProjectDbClient(resolveStorageRoot()),
    compatibilityRepository: artifactRepository,
    loadSession: (projectId, appSessionId) => sessionRepository.loadSession(projectId, appSessionId)
  })
  const provenanceMessageSnapshots = new ProvenanceMessageSnapshotRepository({
    storageRoot: resolveDataRoot(),
    getClient: () => getProjectDbClient(resolveStorageRoot())
  })
  const artifactRunRegistry = new ArtifactRunRegistry()
  // The upload repository above is shared so staging recovery, Session upgrade, prompt finalization,
  // and previews all observe one durable Version authority.
  const notebookInputRegistry = new NotebookInputRegistry({
    storageRoot: resolveDataRoot(),
    getClient: () => getProjectDbClient(resolveStorageRoot())
  })
  // Shared local-fs service backs both the "This computer" browser IPC and the managed-preview
  // resolver below, so path validation stays identical across both entry points.
  const localFsService = new LocalFsService()
  // User-linked folder grants (`@path/to/folder`): owned here, injected into the ACP file
  // reference resolver, and exposed to the renderer for grant management.
  const folderGrantsService = new FolderGrantsService({ dataRoot: resolveDataRoot() })
  registerFolderGrantsIpcHandlers(folderGrantsService)
  // One source-neutral resolver keeps previews and user-requested exports on identical trust checks.
  const resolveManagedFilePath = (
    source: ManagedPreviewSource,
    request: { path: string; projectId?: string; sessionId?: string }
  ): Promise<string> => {
    if (source === 'artifact') {
      const versionIdentity = parseArtifactVersionLocator(request.path)
      return versionIdentity
        ? artifactProvenanceRepository
            .resolveVersionContent(versionIdentity)
            .then((resolved) => resolved.path)
        : artifactRepository.resolveManagedFilePath(request)
    }
    if (source === 'upload') {
      return uploadRepository.resolveManagedUploadPath(request, {
        projectId: request.projectId,
        sessionId: request.sessionId
      })
    }
    if (source === 'notebook-input') {
      return notebookInputRegistry
        .resolvePreviewKey(request.path)
        .then((target) => target.absolutePath)
    }
    // 'local' is the only remaining source, and it is the one that resolves an arbitrary host path.
    // Falling through to it by default would silently widen any future source added to the union, so
    // name it and reject anything unknown.
    if (source === 'local') return localFsService.resolveFilePath(request)
    const unhandled: never = source
    return Promise.reject(new Error(`Unsupported managed preview source: ${String(unhandled)}`))
  }
  const resolveSessionArtifactFilePath = createSessionArtifactFileResolver({
    compatibilityProjectName: DEFAULT_ARTIFACT_PROJECT_NAME,
    resolveVersionContent: (identity) =>
      artifactProvenanceRepository.resolveVersionContent(identity),
    resolveLegacyArtifactPath: (projectName, sessionId, path) =>
      artifactRepository.resolveSessionArtifactFilePath(projectName, sessionId, path)
  })
  // One registry owns short-lived capability URLs for both managed artifact repositories.
  const previewResources = new ManagedPreviewResources({
    resolvePath: resolveManagedFilePath
  })
  const managedPreviewOwners = createManagedPreviewOwnerRegistry(previewResources)

  // Permission scope validation starts before the ACP coordinator is constructed. Keep the late-bound
  // reference here so a first-turn Session grant can recognize its live owner before the renderer's
  // asynchronous session persistence finishes.
  const runtimeRef: { current: ReturnType<typeof createAcpRuntime> | undefined } = {
    current: undefined
  }
  const notebookActivityRef: {
    current:
      { getActiveNotebookSessions(): { projectName: string; sessionId: string }[] } | undefined
  } = { current: undefined }

  // Construct one storage/index/deletion graph for every related IPC surface. Sharing these instances
  // is essential: separate coordinators would have independent queues and recovery gates.
  const configRoot = resolveStorageRoot()
  const permissionGrantRegistry = await createPermissionGrantRegistry({
    getClient: () => getProjectDbClient(configRoot),
    isScopeLive: (scope) =>
      isPermissionGrantScopeLive(scope, {
        projectExists: async (projectId) => (await projectRepository.get(projectId)) !== undefined,
        persistedSessionExists: async (projectId, sessionId) =>
          (await sessionRepository.loadSession(projectId, sessionId)) !== undefined,
        liveSessionExists: (projectId, sessionId) =>
          runtimeRef.current?.hasLiveSession(projectId, sessionId) ?? false
      })
  })
  const projectFilesRepository = createManagedFileIndexRepository(
    getProjectDbClient,
    configRoot,
    resolveDataRoot()
  )
  const sessionPersistenceCoordinator = new SessionPersistenceCoordinator(
    sessionRepository,
    projectFilesRepository,
    (event) => broadcastToRenderers('project-files:changed', event),
    provenanceMessageSnapshots,
    uploadRepository,
    artifactProvenanceRepository,
    {
      reconcileSessions: (sessions) =>
        reconcilePermissionGrantOwners(permissionGrantRegistry, { sessions })
    }
  )
  const uploadCommandOwner = createUploadCommandOwner(uploadRepository, {
    withSessionMutation: (projectId, sessionId, mutation) =>
      sessionPersistenceCoordinator.runSessionMutation(projectId, sessionId, mutation)
  })
  const reviewRepository = createDefaultReviewRepository()
  const projectDeletionCoordinator = new ProjectDeletionCoordinator(
    projectRepository,
    sessionPersistenceCoordinator,
    previewStateRepository,
    reviewRepository,
    artifactProvenanceRepository,
    permissionGrantRegistry
  )
  const detectArchiveBlockingSessions = (): ReturnType<typeof detectActiveSessions> =>
    detectActiveSessions({
      runtime: {
        getActivePromptSessions: () => runtimeRef.current?.getActivePromptSessions() ?? []
      },
      notebook: {
        getActiveNotebookSessions: () =>
          notebookActivityRef.current?.getActiveNotebookSessions() ?? []
      }
    })
  const archiveCoordinator = new ArchiveCoordinator(
    projectRepository,
    sessionPersistenceCoordinator,
    {
      isSessionBusy: (projectId, sessionId) =>
        detectArchiveBlockingSessions().some(
          (session) => session.projectId === projectId && session.sessionId === sessionId
        ),
      isProjectBusy: (projectId) =>
        detectArchiveBlockingSessions().some((session) => session.projectId === projectId),
      liveSessionProjectId: (sessionId) => runtimeRef.current?.liveSessionProjectId(sessionId)
    }
  )
  notificationInbox.setSessionAvailability((sessionId) =>
    archiveCoordinator.isSessionAvailableById(sessionId)
  )
  archiveCoordinator.setMarkReadSessions((sessionIds) =>
    notificationInbox.markSessionsRead(sessionIds)
  )
  bindNotificationInboxDeletionRuntime({
    inbox: notificationInbox,
    sessionPersistenceCoordinator
  })
  const projectHandlers = createProjectHandlers(projectRepository, projectDeletionCoordinator, {
    updateArchive: (request) => archiveCoordinator.updateProjectArchive(request)
  })
  const projectFilesHandlers = createProjectFilesHandlers(
    projectFilesRepository,
    sessionPersistenceCoordinator,
    projectDeletionCoordinator
  )
  // Stashed host.agents.switch bindings for sessions that are not yet durable (fresh unsent drafts),
  // flushed to disk on the session's first save so an approved switch survives an app restart before
  // the next message. Shared by persistSessionSpecialist (stash) and saveSession (flush).
  const pendingSpecialistBindings = new PendingSessionSpecialistBindings()
  const sessionPersistenceBackend: SessionPersistenceBackend = {
    // Options are forwarded here too: this wrapper and the handler above are the two places the caller's
    // opt-in to a cached catalog was being dropped on the way to the coordinator.
    loadAll: (options) =>
      loadSessionsAfterProjectRecovery(
        projectDeletionCoordinator,
        sessionPersistenceCoordinator,
        options
      ),
    // The list tier: metadata for every session, from the on-disk index. Same Project-deletion
    // prerequisite as loadAll, none of its derived-state work (see the startup pass below).
    loadCatalog: () =>
      loadCatalogAfterProjectRecovery(projectDeletionCoordinator, sessionPersistenceCoordinator),
    saveSession: async (session, options) => {
      await projectDeletionCoordinator.recoverPendingDeletions()
      const created =
        (await sessionRepository.loadSession(session.projectId, session.id)) === undefined
      const durableSession = await sessionPersistenceCoordinator.saveSession(session, options)
      // Flush any approved host.agents.switch binding stashed while this session was not yet durable,
      // so the approved target survives a restart before the next message (the in-memory binding
      // alone does not persist across restart).
      if (pendingSpecialistBindings.has(durableSession.id)) {
        const specialistId = pendingSpecialistBindings.take(durableSession.id)
        await sessionPersistenceCoordinator.saveSessionSpecialistBinding(
          durableSession,
          specialistId
        )
      }
      return { created, session: durableSession }
    },
    updateArchive: async (request) => {
      await projectDeletionCoordinator.recoverPendingDeletions()
      return archiveCoordinator.updateSessionArchive(request)
    },
    deleteSession: async (projectId, sessionId) => {
      await projectDeletionCoordinator.recoverPendingDeletions()
      const result = await sessionPersistenceCoordinator.deleteSession(projectId, sessionId)
      await permissionGrantRegistry.prune({ kind: 'session', projectId, sessionId })
      return result
    },
    saveManifest: async (request) => {
      await projectDeletionCoordinator.recoverPendingDeletions()
      return sessionPersistenceCoordinator.saveManifest(request)
    }
  }
  let backendTeardownOwnedByCoordinator = false
  const notebookRuntimeSettings: Pick<NotebookRuntimeSettings, 'getSnapshot'> = {
    getSnapshot: async (language) => {
      const [runtimeSelection, runtimeEnablement, manualInterpreters, packageMirror] =
        await Promise.all([
          settingsService.getRuntimeSelection(language),
          settingsService.getRuntimeEnablement(language),
          settingsService.getManualInterpreters(language),
          settingsService.getPackageMirror()
        ])
      return {
        language,
        runtimeSelection,
        runtimeEnablement,
        manualInterpreters,
        packageMirror
      }
    }
  }
  const notebookApplication = await modules.add(
    {
      configRoot: resolveConfigRoot(),
      dataRoot: resolveDataRoot(),
      projectName: DEFAULT_ARTIFACT_PROJECT_NAME,
      repository: new NotebookRunRepository(resolveDataRoot()),
      getPackageMirror: () => settingsService.getPackageMirror(),
      notebookRuntimeSettings,
      locale: app.getLocale(),
      appVersion: app.getVersion(),
      resolveArtifactPath: (request: { projectName: string; sessionId: string; path: string }) =>
        artifactRepository.resolveSessionArtifactFilePath(
          request.projectName,
          request.sessionId,
          request.path
        ),
      events: applicationEvents,
      disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS,
      isBackendTeardownOwned: () => backendTeardownOwnedByCoordinator
    },
    createNotebookApplicationModule
  )
  const {
    runtime: notebookService,
    commands: notebookCommands,
    localRpc: notebookLocalRpc
  } = notebookApplication
  notebookActivityRef.current = notebookService

  // Builtins are validated once at startup from read-only repository resources. Package imports use
  // the same repository while keeping their dynamic Connector/custom-Skill catalog separate.
  const specialistRepository = new SpecialistRepository(resolveStorageRoot())
  const appVersion = app.getVersion()
  const specialistSkills = await settingsService.listSpecialistSkillCatalog()
  const specialistPackageSkillAdapter = new UserSkillSpecialistPackageAdapter(resolveStorageRoot())
  const builtinSpecialistPackageSkillAdapter = new BundledSkillSpecialistPackageAdapter()
  const packageSkills = await specialistPackageSkillAdapter.snapshot()
  const builtinRegistry = new BuiltinSpecialistRegistry({
    appVersion,
    builtinSkills: composeBuiltinSkillCatalog(appVersion, specialistSkills),
    skills: specialistSkills.map((skill) => {
      const packageSkill = packageSkills.find((candidate) => candidate.id === skill.id)
      return {
        id: skill.id,
        builtin: skill.source === 'featured',
        displayName: skill.displayName,
        source: skill.source,
        ...(packageSkill ?? {})
      }
    }),
    connectorIds: ALL_CONNECTOR_IDS,
    protectedSpecialistIds: ['reviewer'],
    protectedSpecialistNames: ['Reviewer']
  })
  const profileService = new ProfileService(specialistRepository, builtinRegistry)
  await profileService.ensureBuiltinCatalogReady()
  const specialistPackageService = new SpecialistPackageService({
    storageDir: resolveStorageRoot(),
    repository: specialistRepository,
    catalog: async () => {
      const appVersion = app.getVersion()
      const [skills, packageSkills, connectorSettings] = await Promise.all([
        settingsService.listSpecialistSkillCatalog(),
        specialistPackageSkillAdapter.snapshot(),
        settingsService.getConnectors()
      ])
      const customMcpServers = connectorSettings?.customMcpServers ?? []
      const baseCatalog = {
        appVersion,
        builtinSkills: composeBuiltinSkillCatalog(appVersion, skills),
        skills: skills.map((skill) => {
          const packageSkill = packageSkills.find((candidate) => candidate.id === skill.id)
          return {
            id: skill.id,
            builtin: skill.source === 'featured',
            displayName: skill.displayName,
            source: skill.source,
            ...(packageSkill ?? {})
          }
        }),
        connectorIds: Array.from(
          new Set([
            ...ALL_CONNECTOR_IDS,
            ...customMcpServers
              .filter((server) => isCustomMcpServerRouteSafe(server, customMcpServers))
              .map(customConnectorSlug)
          ])
        ),
        connectorAliases: Object.fromEntries(
          customMcpServers
            .filter((server) => isCustomMcpServerRouteSafe(server, customMcpServers))
            .flatMap((server) => {
              const slug = customConnectorSlug(server)
              return [
                [server.name, slug],
                [server.id, slug]
              ]
            })
        ),
        protectedSpecialistIds: ['reviewer'],
        protectedSpecialistNames: ['Reviewer']
      }
      const builtinSpecialists = await new BuiltinSpecialistRegistry(baseCatalog).load()
      return {
        ...baseCatalog,
        protectedSpecialistIds: [
          ...baseCatalog.protectedSpecialistIds,
          ...builtinSpecialists.entries.map((entry) => entry.id)
        ],
        protectedSpecialistNames: [
          ...(baseCatalog.protectedSpecialistNames ?? []),
          ...builtinSpecialists.entries.flatMap((entry) => [
            entry.name,
            entry.displayName ?? entry.name
          ])
        ]
      }
    },
    skillPort: specialistPackageSkillAdapter,
    builtinSkillPort: builtinSpecialistPackageSkillAdapter,
    onCommitted: () => {
      broadcastToRenderers(SPECIALIST_IPC.CATALOG_CHANGED, undefined)
      void runtime.requestSkillsReload()
    }
  })
  settingsService.setSkillDeletionGuard((skillId) =>
    specialistPackageService.assertSkillDeletionAllowed(skillId)
  )
  // Specialist Marketplace : verified discovery + install provenance. The
  // official source carries no trusted keys yet (fails closed); users add verified GitHub sources.
  const marketplaceRepository = new MarketplaceRepository(resolveStorageRoot())
  const marketplaceService = new MarketplaceService({
    repository: marketplaceRepository,
    packages: specialistPackageService,
    fetch: globalThis.fetch.bind(globalThis),
    officialSource: OFFICIAL_MARKETPLACE_SOURCE,
    getDisabledSkillIds: async () => {
      const stored = await settingsService.getStoredSettings()
      return stored.disabledSkillIds ?? []
    },
    getInstalledSpecialists: async () => {
      const stored = await specialistRepository.getAll()
      return stored.specialists.map((entry) => ({
        id: entry.id,
        ...(entry.origin ? { origin: entry.origin } : {}),
        ...(entry.importBaseline?.archiveDigest
          ? { archiveDigest: entry.importBaseline.archiveDigest }
          : {})
      }))
    },
    setSkillsMainEnabled: async (ids, enabled) => {
      for (const id of ids) {
        await settingsService.setSkillEnabled({ id, enabled })
      }
    },
    // Governed packages: tag the installed specialist with the marketplace origin so the UI can
    // group it and protect publisher content from casual overwrite.
    onSpecialistInstalled: async (specialistId, revision) => {
      await specialistRepository
        .update(specialistId, { origin: 'marketplace' }, revision)
        .catch((error) => {
          createLogger('marketplace').warn(
            'install origin tagging failed',
            diagnosticErrorFields(error)
          )
        })
    }
  })
  // Per-session specialist binding store. Shared between the SET_SESSION_SPECIALIST barrier
  // (validate + record) and the runtime switch so a hot-switch lands on the same source of truth.
  const sessionBindingService = new SessionBindingService(profileService)
  // Compose the interceptor before ACP because Notebook construction precedes runtime construction.
  // Startup registers the complete production adapter below before any IPC surface becomes callable.
  const completionGateRuntimeRegistry = new CompletionGateRuntimeRegistry()
  const completionHandoffLifecycle = new CompletionHandoffLifecycle(
    new FileCompletionHandoffRepository(join(resolveStorageRoot(), 'specialist-handoffs')),
    completionGateRuntimeRegistry,
    Date.now,
    (event) => broadcastToRenderers(SPECIALIST_IPC.HANDOFF_LIFECYCLE_CHANGED, event),
    async ({ targetName }) => {
      if (targetName === null) return undefined
      const profile = await profileService.resolveRunnableByName(targetName)
      return { specialistId: profile.id, revision: profile.revision }
    }
  )
  registerCompletionHandoffIpcHandlers(completionHandoffLifecycle)
  const completionGateCoordinator = new CompletionGateCoordinator(
    completionGateRuntimeRegistry,
    completionHandoffLifecycle
  )
  await modules.add({ completionGateCoordinator }, ({ completionGateCoordinator: coordinator }) => {
    let disposeDiagnostics: (() => void) | undefined
    return {
      name: 'completion-handoff-diagnostics',
      capability: undefined,
      start: () => {
        disposeDiagnostics = installCompletionGateDiagnostics(coordinator, {
          log: createLogger('completion-handoff'),
          broadcast: (event) => broadcastToRenderers(SPECIALIST_IPC.HANDOFF_LIFECYCLE, event)
        })
      },
      dispose: () => disposeDiagnostics?.()
    }
  })
  // The delivery callback is intentionally a no-op: the Notebook runtime itself returns a normal
  // disposition to the existing repl_execute caller. Captured dispositions never return that value.
  notebookService.setControlCompletionInterceptor(
    createCompletionGatedControlToolInterceptor(completionGateCoordinator, async () => undefined)
  )
  // Desktop notifications for finished/failed agent tasks and approval waits. Delivery is
  // Electron's Notification (Notification Center on macOS, toasts on Windows, libnotify on Linux);
  // the service itself stays Electron-free so its filtering rules are unit-testable. The click
  // handler is bound later, in index.ts, where showMainWindow exists. Constructed before the
  // connector approval broker, which nudges through it.
  //
  // The wiring is extracted into electron-wiring helpers so the headless gate and the broker→service
  // sessionId pass-through have a unit-level home — inline closures were untestable, and a
  // regression on either of those contracts would not be caught by TaskNotificationService tests.
  const notificationsLog = createLogger('notifications')
  const liveNotifications = new Set<Notification>()
  const taskNotifications = new TaskNotificationService({
    isEnabled: () => settingsService.getNotificationsEnabled(),
    isAppFocused: () => BrowserWindow.getAllWindows().some((window) => window.isFocused()),
    show: buildTaskNotificationShow({
      notificationCtor: Notification,
      liveNotifications,
      log: notificationsLog,
      headless
    }),
    onDeliveryError: (error) =>
      notificationsLog.warn('task notification delivery failed', errorLogFields(error)),
    onAttentionError: (error) =>
      notificationsLog.warn('desktop attention handler failed', errorLogFields(error)),
    onUnreadError: (error) =>
      notificationsLog.warn('unread task handler failed', errorLogFields(error))
  })
  // The renderer peeks once sessions are hydrated, then conditionally consumes the same target.
  // This lets partial recovery open an already-loaded conversation while retaining an omitted one
  // for retry, without an older IPC round trip clearing a newer click target.
  declareElectronAdapter('task-notifications', () => {
    registerNotificationInboxIpcAdapter(notificationInbox)
    ipcMainHandle('notifications:peek-pending-open-session', () =>
      taskNotifications.peekPendingOpenSession()
    )
    ipcMainHandle('notifications:take-pending-open-session', (_event, expectedToken: unknown) =>
      typeof expectedToken === 'number' && Number.isSafeInteger(expectedToken) && expectedToken > 0
        ? taskNotifications.takePendingOpenSession(expectedToken)
        : null
    )
  })
  // One MCP client manager backs both dispatch (ConnectorService.call → custom server) and skill-doc
  // generation (listTools) for user-added custom MCP servers (stdio + remote). It lazily connects per
  // server, so constructing it here does not spawn anything until a custom server is actually used.
  const mcpClientManager = await modules.add(undefined, () => {
    const manager = new McpClientManager({
      // Classified external navigation: only the shared protocol allowlist (http/https/mailto) may
      // reach the OS browser; anything else is refused.
      openExternal: (url) => {
        if (isAllowedExternalUrl(url)) return shell.openExternal(url)
        return Promise.reject(new Error(`Blocked external navigation to disallowed URL: ${url}`))
      },
      saveOAuthState: (serverId, state) =>
        settingsService.saveCustomServerOAuthState(serverId, state)
    })
    return {
      name: 'mcp-client-manager',
      capability: manager,
      dispose: () => manager.closeAll()
    }
  })
  const connectorRuntimeSettings = new ConnectorRuntimeSettingsProjection({
    readConnectors: () => settingsService.getConnectors(),
    skillsDir: join(getAppClaudeConfigDir(resolveStorageRoot()), 'skills'),
    mcpClientManager
  })
  settingsService.setMaterializedCustomSkillNamesProvider(() =>
    connectorRuntimeSettings.materializedCustomSkillNames()
  )
  settingsService.setCustomServerAuthenticator(
    async (serverId) => {
      const server = (await settingsService.getConnectors())?.customMcpServers?.find(
        (candidate) => candidate.id === serverId
      )
      if (!server) throw new Error(`Unknown custom connector: ${serverId}`)
      await mcpClientManager.authenticate(toCustomMcpConfig(server))
    },
    (serverId) => mcpClientManager.cancelAuthentication(serverId)
  )
  // Bridges un-trusted connector calls to the renderer approval card. A tool call that isn't
  // pre-allowed or skip-approved is held here until the user decides (or it auto-denies on timeout).
  const approvalBroker = new ApprovalBroker({
    generateId: () => randomUUID(),
    broadcast: buildConnectorApprovalBroadcast({
      broadcastToRenderers,
      taskNotifications,
      onNotificationError: (error) =>
        notificationsLog.warn('connector approval notification failed', errorLogFields(error))
    })
  })
  // The late-bound app runtime also serves connector tools that attach a generated file to the current
  // turn. It is created below because it depends on the connector service.
  const skillImportApprovalBroker = new SkillImportApprovalBroker({
    generateId: () => randomUUID(),
    broadcast: buildSkillImportApprovalBroadcast({
      broadcastToRenderers,
      taskNotifications,
      onNotificationError: (error) =>
        notificationsLog.warn('skill import approval notification failed', errorLogFields(error))
    }),
    onSettled: (id) => broadcastToRenderers('skills:conversation-import-settled', id)
  })
  const conversationSkillImporter = new ConversationSkillImporter({
    uploads: uploadRepository,
    createCancellationGuard: (sessionId, turnToken, attachmentUri) =>
      skillImportApprovalBroker.createCancellationGuard(sessionId, turnToken, attachmentUri),
    createSessionCancellationGuard: (sessionId) =>
      skillImportApprovalBroker.createSessionCancellationGuard(sessionId),
    previewBundle: (bundle) => settingsService.previewSkillArchive(bundle),
    importBundle: (bundle, items) => settingsService.importSkillArchiveBatch(bundle, items),
    scanGitHub: async (url) => (await settingsService.scanRepoSkills({ repo: url })).skills,
    importGitHub: (url) => settingsService.importSkill({ url }),
    requestApproval: (request, cancellation) =>
      skillImportApprovalBroker.request(request, cancellation),
    // If a prompt is active the coordinator defers the reconnect until its terminal event, making the
    // new Skill available on the next user turn without interrupting the importing tool call.
    onSkillsChanged: () => void runtimeRef.current?.requestSkillsReload()
  })
  const moleculePreviewHandler = createMoleculePreviewHandler({
    writeArtifactForCurrentRun: (sessionId, input) => {
      if (!runtimeRef.current) throw new Error('Artifact runtime is not initialized.')
      return runtimeRef.current.writeArtifactForCurrentRun(sessionId, input)
    }
  })
  // Multi-agent orchestration (delegate_tasks): the sub-agent executor is assembled AFTER the ACP
  // task-agent port and the application-command composition exist (both are constructed later in
  // this function). A mutable ref bridges the ordering — delegate_tasks tool calls happen long
  // after startup, so the call-time read is always populated.
  const subAgentRef: { current?: ToolContext['runSubAgent'] } = {}
  const connectorService = new ConnectorService({
    getConnectors: () => connectorRuntimeSettings.current(),
    getConnectorsFresh: () => settingsService.getConnectors(),
    getUseIntent: async () => (await settingsService.getStoredSettings()).useIntent,
    resolveApiKey: (ref) => tryDecryptKey(ref),
    mcpClientManager,
    permissionGrantRegistry,
    requestApproval: ({ connector, method, args, sessionId, availableScopes }) =>
      approvalBroker.request({
        connector,
        method,
        argsPreview: previewArgs(args),
        ...(sessionId ? { sessionId } : {}),
        availableScopes
      }),
    resolveSpecialistProfile: async (specialistId) => {
      try {
        return await profileService.resolveRunnableById(specialistId)
      } catch {
        return undefined
      }
    },
    localToolHandlers: { 'molecule/preview_molecule': moleculePreviewHandler },
    subAgent: (request) =>
      subAgentRef.current
        ? subAgentRef.current(request)
        : Promise.reject(
            new Error('Sub-agent executor is not ready (agent runtime still initializing).')
          )
  })
  // Register compute IPC handlers early so computeService can be wired into the notebook RPC server.
  // The approval broker in compute/ipc.ts broadcasts via BrowserWindow.getAllWindows(), which requires
  // Electron to be ready — this is always the case here since we're inside registerIpcHandlers.
  // Adapt the artifact repository to the ArtifactResolver shape so job input staging can upload
  // absolute artifact-store paths (validated to stay inside the store by resolveManagedFilePath).
  const computeArtifactResolver = {
    resolveArtifactPath: (path: string) => artifactRepository.resolveManagedFilePath({ path })
  }
  // The delivery ledger needs the project database and is created further down; the compute module only
  // reads it (the job-detail panel's provenance), so it gets a late-bound reader instead of forcing the
  // creation order. Before it is bound, the reader honestly reports an empty ledger.
  const deliveryLedgerReader: { list?: (sessionId: string) => Promise<BackgroundDelivery[]> } = {}
  const computeIpcModule = createComputeIpcModule(
    undefined,
    undefined,
    computeArtifactResolver,
    undefined,
    taskNotifications,
    permissionGrantRegistry,
    async (sessionId) => (await deliveryLedgerReader.list?.(sessionId)) ?? []
  )
  // Project reference library (v1.51): register its renderer surface alongside compute.
  // Fingerprint an attached PDF's content (head hash + exact size) so a swapped file is
  // detectable behind a reference. Fail-soft: provenance sugar never blocks the attach itself.
  const fingerprintManagedPdf = async (
    projectId: string,
    managedFileId: string
  ): Promise<string | null> => {
    try {
      const client = await getProjectDbClient(configRoot)
      const separator = managedFileId.indexOf(':')
      const row =
        separator > 0
          ? await client.managedFile.findFirst({
              where: {
                projectId,
                source: managedFileId.slice(0, separator),
                sourceFileId: managedFileId.slice(separator + 1)
              },
              orderBy: { seq: 'desc' }
            })
          : await client.managedFile.findFirst({
              where: { projectId, sourceFileId: managedFileId },
              orderBy: { seq: 'desc' }
            })
      if (!row?.storageKey) return null
      const path = join(resolveDataRoot(), ...row.storageKey.split('/'))
      return await fingerprintPdfFile(path)
    } catch {
      return null
    }
  }
  const referencesIpcModule = createReferencesIpcModule(undefined, {
    resolvePdfFingerprint: fingerprintManagedPdf
  })
  installReferencesIpcHandlers(referencesIpcModule)

  // Global search reads the stores the app already keeps: sessions from the persistence backend, files
  // from the project-files index, literature from the references module. A project-less query cannot
  // reach files or literature, and the response says so instead of reporting an empty search.
  // The page the files port just read, so a content read can find the file it is about. Filled on each
  // query and read back by `readFileText` — a project file is only addressable through that page.
  const searchableFileItems = new Map<string, SearchFileTextItem>()
  const searchFileText = createSearchFileTextReader({
    findItem: (fileId) => searchableFileItems.get(fileId),
    readArtifactPreview: (request) => artifactPreviewForSearch(request),
    readUploadPreview: (request) => uploadRepository.readManagedUploadPreview(request)
  })

  // Assigned once the artifact handlers exist (they are constructed later in this scope); the search
  // only asks for a preview while serving a query, long after startup.
  let artifactPreviewForSearch: (
    request: ReadArtifactPreviewRequest
  ) => Promise<ArtifactPreviewResult> = async () => {
    throw new Error('Artifact preview reader is not wired yet.')
  }

  // Search reads every session; without this it did so per query, which cost over a second on a real
  // corpus. The durable repository bumps the revision on every write, so the view is only re-read when
  // something actually changed.
  const searchSessionIndex = createSessionIndex({
    // The staleness budget lives with the index, which asks for a possibly-cached catalog; this seam only
    // forwards the request.
    loadAll: async (options) => (await sessionPersistenceBackend.loadAll(options)).sessions,
    revision: getSessionRevision
  })

  const searchHandlers = createSearchIpcHandlers({
    loadSessions: () => searchSessionIndex.getSessions(),
    readFileText: searchFileText,
    listFiles: async ({ projectId }) => {
      // The flat `all` collection is the cross-session read model. It is paged at the size the project
      // files contract allows — asking for more than that is rejected outright, which is exactly how this
      // seam broke once — up to a bounded number of pages.
      searchableFileItems.clear()
      const files: Array<{ id: string; title: string; relativePath: string; timestamp?: string }> =
        []
      let cursor: string | undefined
      let listBounded = false

      for (let page = 0; page < GLOBAL_SEARCH_FILE_LIST_MAX_PAGES; page += 1) {
        const result = await projectFilesHandlers.listFiles({
          projectId,
          collection: { kind: 'all' },
          limit: MAX_PROJECT_FILES_PAGE_LIMIT,
          ...(cursor ? { cursor } : {})
        })
        for (const item of result.items) {
          searchableFileItems.set(item.id, {
            projectId: item.projectId,
            sessionId: item.sessionId,
            name: item.name,
            path: item.path,
            source: item.source
          })
          files.push({
            id: item.id,
            title: item.name,
            relativePath: item.path,
            ...(item.mtimeMs ? { timestamp: new Date(item.mtimeMs).toISOString() } : {})
          })
        }
        if (!result.nextCursor) return { files, listBounded }
        cursor = result.nextCursor
        // The last allowed page still had a cursor: more files exist than we listed, and the response
        // says so rather than reading as the whole project.
        listBounded = true
      }
      return { files, listBounded }
    },
    listReferences: async (projectId) => {
      const references = await referencesIpcModule.handlers.list(projectId)

      return references.map((reference) => ({
        id: reference.id,
        title: reference.title,
        ...(reference.abstractSnippet ? { abstract: reference.abstractSnippet } : {}),
        ...(reference.authors && reference.authors.length > 0
          ? {
              authors: reference.authors
                .map((author) => (typeof author === 'string' ? author : author.name))
                .filter((name): name is string => typeof name === 'string' && name.length > 0)
            }
          : {}),
        ...(reference.venue ? { venue: reference.venue } : {}),
        ...(reference.doi ? { doi: reference.doi } : {}),
        ...(reference.year !== undefined ? { year: reference.year } : {}),
        ...(reference.arxivId ? { arxivId: reference.arxivId } : {}),
        ...(reference.pmid ? { pmid: reference.pmid } : {}),
        ...(reference.pmcid ? { pmcid: reference.pmcid } : {})
      }))
    }
  })
  surfaceAdapters = beforeAcpAdapters
  const {
    computeService,
    jobRepository,
    hostRepository,
    enabledComputeHostsRegistry: hostsRegistry
  } = computeIpcModule
  const dataRoot = resolveDataRoot()
  // Start the JobPoller wired to the shared broadcaster so every state/tail change is pushed to all
  // renderer windows via 'compute:job-updated' (Phase 3d, design.md §9 + §15.3). The dispatcher
  // (inside ComputeService) uses the same hook, so submitted→running/error transitions broadcast too.
  // Phase 3b: harvestFn drives automatic harvest on terminal transitions; broadcast + storageRoot
  // wire the compute_done notification emitter for all three terminal outcomes (issue 06).
  // Background result delivery: a finished job's result is written into its session by the MAIN process,
  // so closing the window — or a job that finishes while the app is closed and is restarted later — no
  // longer strands the result in an inbox nobody reads.
  const backgroundDeliveries = new BackgroundDeliveryRepository(() =>
    getProjectDbClient(resolveStorageRoot())
  )
  deliveryLedgerReader.list = (sessionId) => backgroundDeliveries.listForSession(sessionId)
  const backgroundDeliveryOwner = new BackgroundDeliveryOwner({
    deliveries: backgroundDeliveries,
    // Read per delivery: the continuation turn must speak the language the window was last showing,
    // which can differ from the language in force when this owner was constructed.
    labels: async () => backgroundDeliveryLabelsFor(await settingsService.getUiLanguage()),
    sessions: {
      loadSession: (projectId, sessionId) => sessionRepository.loadSession(projectId, sessionId),
      saveSession: async (session) => {
        await sessionPersistenceBackend.saveSession(session)
      }
    },
    // A delivery turn has no window behind it, so it must attach the session itself: resume when the
    // runtime does not hold it, then send the continuation the ledger already wrote into the session.
    // That text is app-owned and already persisted, so it must not be stored as a user message twice.
    startTurn: async ({ sessionId, projectId, prompt }) => {
      const runtime = runtimeRef.current
      if (!runtime) throw new Error('Agent runtime is unavailable.')
      const session = await sessionRepository.loadSession(projectId, sessionId)
      if (!session) throw new Error(`Unknown session: ${sessionId}`)
      // One session runs one turn at a time. If the person is mid-turn there, wait for it to finish
      // rather than racing it; a runtime that never frees up gives up loudly after the bound (the message
      // is already in the session, so the result itself is not lost).
      const deadline = Date.now() + BACKGROUND_DELIVERY_TURN_WAIT_MS
      while (runtime.getActivePromptSessions().some((entry) => entry.sessionId === sessionId)) {
        if (Date.now() > deadline) throw new Error(`Session is still busy: ${sessionId}`)
        await new Promise((resolve) => setTimeout(resolve, BACKGROUND_DELIVERY_TURN_POLL_MS))
      }
      if (!runtime.getSnapshot().sessionIds.includes(sessionId)) {
        await runtime.resumeSession({
          sessionId,
          cwd: session.cwd,
          ...(session.permissionProfile ? { permissionProfile: session.permissionProfile } : {}),
          // The framework/backend the session was last run against, so a restored session is never
          // resumed onto an incompatible store (same fields the renderer passes on restore).
          ...(session.agentFrameworkId ? { previousFrameworkId: session.agentFrameworkId } : {}),
          ...(session.agentBackendId ? { previousBackendId: session.agentBackendId } : {}),
          ...(session.specialistId ? { specialistId: session.specialistId } : {})
        })
      }
      await runtime.sendPrompt({ sessionId, text: prompt, suppressUserMessage: true })
    }
  })
  const deliveryLog = createLogger('background-delivery')
  // Sessions this process delivered into, so a clean stop can hand its leases back immediately instead of
  // making the next run wait the lease out.
  const deliveredSessions = new Set<string>()
  const reportDeliveryFailure = (
    error: unknown,
    ids: { jobId?: string; sessionId?: string }
  ): void =>
    deliveryLog.warn('background result delivery failed', {
      ...(ids.jobId ? { jobId: ids.jobId } : {}),
      ...(ids.sessionId ? { sessionId: ids.sessionId } : {}),
      ...errorLogFields(error)
    })

  await modules.add(
    {
      computeService,
      hostRepository,
      jobRepository,
      storageRoot: dataRoot,
      onJobResult: async (job: ComputeJob): Promise<void> => {
        await deliverComputeResult(
          { job_id: job.job_id, project_id: job.project_id, session_id: job.session_id },
          { owner: backgroundDeliveryOwner, onError: reportDeliveryFailure }
        )
        deliveredSessions.add(job.session_id)
        // The result is in the session now, so the inbox entry is handled: leaving it unconsumed would
        // keep announcing something the reader has already been given.
        await jobRepository
          .markNotificationsConsumed([job.job_id])
          .catch((error) => reportDeliveryFailure(error, { jobId: job.job_id }))
      }
    },
    (dependencies) => {
      const jobPoller = createComputeJobRuntime(dependencies)
      return {
        name: 'compute-job-runtime',
        capability: undefined,
        start: async () => {
          jobPoller.start()
          // Recovery pass: every job already in the inbox is registered again (idempotent by job id) and
          // its session drained, so a result that finished while this ledger was unavailable — or before
          // it existed — still reaches its session instead of sitting unread.
          try {
            const jobs = await jobRepository.findNotifiedJobs()
            const outcome = await recoverComputeResults(
              jobs.map((job) => ({
                job_id: job.job_id,
                project_id: job.project_id,
                session_id: job.session_id
              })),
              { owner: backgroundDeliveryOwner, onError: reportDeliveryFailure }
            )
            if (outcome.failed > 0 || outcome.sessions > 0) {
              deliveryLog.info('background delivery recovery pass', outcome)
            }
          } catch (error) {
            reportDeliveryFailure(error, {})
          }
        },
        dispose: async () => {
          jobPoller.stop()
          for (const sessionId of deliveredSessions) {
            await backgroundDeliveryOwner.releaseSession(sessionId)
          }
          deliveredSessions.clear()
        }
      }
    }
  )
  // Augment computeService with getEnabledComputeHosts so the RPC server can serve list_compute.
  // Must preserve ComputeService's prototype methods (list/getDetails/submitJob/...) — see the helper.
  const computeServiceWithRegistry = attachEnabledComputeHosts(computeService, hostsRegistry)
  // host.agents control-plane SDK (issue 02/05): read Specialist/catalog surface plus the durable
  // immediate-handoff lifecycle. The catalog adapter delegates to the authoritative
  // SettingsService + ProfileService; switch() reuses the SAME SessionBindingService and durable
  // session-file persistence seam the SET_SESSION_SPECIALIST IPC handler uses (no parallel switch
  // service). The runtime reconfigure callback is intentionally NOT wired here — it runs at the safe
  // next-message boundary, not inside the SDK call. Privileged operations use the existing ACP
  // permission broker/card; its response is the only approve/decline authority.
  const specialistApprovalGateway = new AcpSpecialistApprovalGateway({
    bridge: createAcpBackedSpecialistBridge({
      request: async (payload, session) => {
        const sessionId = session.sessionId
        const runtime = runtimeRef.current
        if (!sessionId || !runtime) {
          return { outcome: 'declined', reason: 'The approval surface is unavailable.' }
        }
        const target = payload.kind === 'switch' ? payload.targetName : undefined
        const approved = await runtime.requestAppApproval({
          sessionId,
          title:
            payload.kind === 'switch'
              ? target === null
                ? 'Switch to Main Agent?'
                : `Switch to ${target}?`
              : payload.kind === 'delete'
                ? `Delete ${payload.name}?`
                : `Rename ${payload.name} to ${payload.newName}?`,
          rawInput: { specialistApproval: payload }
        })
        return approved ? { outcome: 'approved' } : { outcome: 'declined' }
      }
    })
  })
  const agentsService = new AgentsService({
    profileService,
    catalog: {
      listSkillCatalog: () => settingsService.listSpecialistSkillCatalog(),
      getConnectors: () => settingsService.getConnectors()
    },
    sessionBinding: sessionBindingService,
    approvalGateway: specialistApprovalGateway,
    approvalLifecycle: completionHandoffLifecycle,
    // The completion gate is the sole execution authority. The legacy pending-switch renderer
    // broadcast is intentionally not emitted: lifecycle events are a read-only projection and can
    // neither delay nor re-run the approved continuation.
    switchNotifier: createCompletionGateSwitchNotifier(completionGateCoordinator),
    deleteSpecialist: (request) => specialistPackageService.deleteSpecialist(request),
    // Catalog invalidation after a successful privileged mutation: reconnect live sessions so the
    // agent respawns (re-provisioning skills) and re-applies the updated Specialist whitelist. The
    // ProfileService already broadcasts specialist:catalog-changed on update/delete; this refreshes the
    // RUNTIME capability resolution (mirrors the Settings IPC path's onProfilesChanged callback).
    invalidateCatalog: () => void runtime.requestSkillsReload(),
    persistSessionSpecialist: async (sessionId, specialistId) => {
      const allSessions = await sessionRepository.loadAll()
      const session = allSessions.sessions.find((s) => s.id === sessionId)
      if (!session) {
        // The calling session is a fresh unsent draft that is not yet on disk. Stash the approved
        // binding so the save path flushes it on first persist — otherwise an app restart before the
        // first save would silently lose the approved switch (only the in-memory binding survives).
        pendingSpecialistBindings.stash(sessionId, specialistId)
        specialistPersistLog.debug(
          'session not yet durable; stashed specialist binding for first save',
          {
            sessionId,
            specialistId
          }
        )
        return
      }
      // The session is already durable: this write is authoritative, so drop any stale stash.
      pendingSpecialistBindings.take(sessionId)
      await sessionPersistenceCoordinator.saveSessionSpecialistBinding(session, specialistId)
    }
  })
  const contextSummaryRepository = new ContextSummaryRepository({
    storageRoot: resolveDataRoot()
  })
  const routineRepository = new RoutineRepository({
    storageRoot: resolveDataRoot()
  })
  const endpointRepository = new EndpointRepository({
    storageRoot: resolveDataRoot()
  })
  const endpointManager = new EndpointManager({
    repository: endpointRepository,
    resolveCredential: async (name) => {
      const settings = await settingsService.getStoredSettings()
      const entry = (settings.credentials ?? []).find((candidate) => candidate.id === name)
      return entry ? tryDecryptKey(entry.secretRef) : undefined
    }
  })
  const annotationRepository = new AnnotationRepository({
    storageRoot: resolveDataRoot()
  })
  // Session bookmarks (v1.65): private to the reader, so this store is wired for the renderer only —
  // there is no agent-facing owner beside it.
  const bookmarkRepository = new BookmarkRepository({
    storageRoot: resolveDataRoot()
  })
  const pdfService = new PdfService({
    storageRoot: resolveDataRoot(),
    resolvePath: async (path) => (path.startsWith('/') ? path : join(resolveDataRoot(), path))
  })
  // One reader for both surfaces: the PDF preview/annotation commands and the references module's
  // PDF → DOI import (3.4) use the same PdfService, so a document is registered once and read the same
  // way. Bound unconditionally (not inside an Electron-only adapter) so the web/CLI command surface
  // can import references too.
  referencesIpcModule.bindPdfPorts({
    open: async (path, projectId) => {
      const opened = await pdfService.open(path, projectId)
      return { docId: opened.doc.docId, pageCount: opened.doc.pageCount }
    },
    // Pages arrive as objects with their number; the import only needs the text, in page order.
    pages: async (docId, start, end) => {
      const read = await pdfService.pages(docId, start, end)
      return read.pages
        .slice()
        .sort((left, right) => left.page - right.page)
        .map((page) => page.text)
        .join('\n')
    }
  })
  const hostQueryService = new HostQueryService({
    getClient: () => getProjectDbClient(resolveStorageRoot())
  })
  const taskCheckpointStore = new TaskCheckpointStore((projectId) =>
    join(resolveStorageRoot(), 'checkpoints', projectId)
  )
  const notebookRpcServer = await modules.add(
    new NotebookLocalRpcServer(notebookLocalRpc, {
      onSessionReleased: (sessionId) => completionGateCoordinator.releaseSession(sessionId),
      connectorService,
      computeService: computeServiceWithRegistry,
      skillImporter: conversationSkillImporter,
      skillCreator: new SkillCreator({ configDir: resolveConfigRoot() }),
      memoryWriter: {
        saveNote: (categoryName, text, evidence) =>
          settingsService.saveMemoryNote(categoryName, text, evidence)
      },
      taskCheckpoint: {
        save: (projectId, patch) =>
          taskCheckpointStore.apply(projectId, patch as TaskCheckpointPatch),
        load: async (projectId, currentFingerprint) => {
          const checkpoint = await taskCheckpointStore.read(projectId)
          if (!checkpoint) return { checkpoint: null, freshness: { status: 'missing' } }
          return {
            checkpoint,
            freshness: evaluateCheckpointFreshness(checkpoint, currentFingerprint)
          }
        }
      },
      contextSummary: {
        queryChunk: (sessionId, summaryId, question) =>
          contextSummaryRepository.queryChunk(sessionId, summaryId, question),
        recordBoundary: (sessionId, label) =>
          contextSummaryRepository.recordBoundary(sessionId, label)
      },
      routine: {
        configure: (sessionId, request) => routineRepository.upsert(sessionId, request),
        status: (sessionId) => routineRepository.list(sessionId),
        cancel: (sessionId, routineId) => routineRepository.remove(sessionId, routineId)
      },
      endpoints: {
        register: (sessionId, request) => endpointRepository.upsert(request, sessionId),
        unregister: (_sessionId, name) => endpointManager.unregister(name),
        start: (_sessionId, name) => endpointManager.start(name),
        stop: (_sessionId, name) => endpointManager.stop(name),
        status: (_sessionId, name) => endpointRepository.get(name),
        list: () => endpointRepository.list(),
        freePort: () => endpointManager.freePort()
      },
      annotations: {
        set: (_sessionId, projectId, request) =>
          annotationRepository.set(projectId, request, 'agent'),
        list: (_sessionId, projectId, target) =>
          annotationRepository.list(projectId, target ?? undefined),
        remove: (_sessionId, projectId, annotationId) =>
          annotationRepository.remove(projectId, annotationId)
      },
      pdf: {
        open: (_sessionId, projectId, path) => pdfService.open(path, projectId),
        pages: (_sessionId, _projectId, docId, start, end) => pdfService.pages(docId, start, end),
        outline: (_sessionId, _projectId, docId) => pdfService.outline(docId),
        scan: (_sessionId, _projectId, docId, query) => pdfService.scan(docId, query),
        tables: (_sessionId, _projectId, docId, page) => pdfService.tables(docId, page),
        figures: (_sessionId, _projectId, docId, page) => pdfService.figures(docId, page)
      },
      figure: {
        review: (_sessionId, _projectId, request) => {
          const figureRequest = request as FigureReviewRequest
          return Promise.resolve(reviewFigure(figureRequest.panels, figureRequest.figureNote))
        }
      },
      hostQuery: {
        query: (_sessionId, projectId, sql) => hostQueryService.query(sql, projectId)
      },
      planService: {
        call: (input) => {
          const runtime = runtimeRef.current
          if (!runtime) return Promise.reject(new Error('ACP runtime is not available.'))
          return runtime.callSessionPlan(input)
        }
      },
      artifactProvenance: {
        createVersion: (request) =>
          sessionPersistenceCoordinator.runSessionMutation(
            request.projectId,
            request.appSessionId,
            () => artifactProvenanceRepository.createVersion(request)
          ),
        replayVersion: (request) =>
          sessionPersistenceCoordinator.runSessionMutation(
            request.projectId,
            request.appSessionId,
            () => artifactProvenanceRepository.replayVersion(request)
          ),
        checkReproduction: (request) => {
          const dataRoot = resolveDataRoot()

          return createArtifactReproducibilityService({
            getVersionProvenance: (query) =>
              artifactProvenanceRepository.getVersionProvenance(query),
            observeFile: createReproductionFileObserver({
              allowedImportRoots: request.allowedImportRoots,
              relativeBaseDirs: request.relativeBaseDirs ?? []
            }),
            runReplay: async ({ plan, inputs }) => {
              const envName = replayEnvironmentName({
                kernelKind: plan.kernelKind,
                environmentName: plan.environmentName
              })
              const interpreter = resolveReplayInterpreter({
                dataRoot,
                kernelKind: plan.kernelKind,
                environmentName: plan.environmentName
              })
              try {
                if (!(await stat(interpreter)).isFile()) throw new Error('not a file')
              } catch {
                return {
                  state: 'refused' as const,
                  refusal: 'interpreter-missing' as const,
                  detail:
                    `The recorded environment "${envName}" is not installed in this app, so the ` +
                    'recipe was not re-executed. Install or enable that runtime, then check again.',
                  outputs: [],
                  missingOutputs: [],
                  stdoutTail: '',
                  stderrTail: ''
                }
              }

              return runSealedRecipeReplay({
                kernelKind: plan.kernelKind,
                scripts: plan.scripts,
                interpreterPath: interpreter,
                expectedOutputFilenames: plan.expectedOutputs.map((output) => output.filename),
                inputs: inputs.map((input) => ({
                  ...input,
                  path: resolveStoredInputPath({ dataRoot, storageKey: input.path })
                }))
              })
            }
          }).check(request)
        }
      },
      inputRegistry: notebookInputRegistry,
      agentsService
    }),
    createNotebookLocalRpcModule
  )
  // Register ownership before ACP construction. Reverse disposal therefore drains ACP + Notebook
  // through the coordinator first, then releases the local bridge without creating a second runtime
  // shutdown owner; rollback also closes a server started during partial composition.
  // The RPC server needs the runtime service to dispatch to, and the runtime service needs the RPC
  // server's (lazily-started) connection for host.mcp() env injection — wire the second half here to
  // avoid a construction cycle.
  notebookService.setMcpRpcConnectionResolver(({ sessionId, projectId }) =>
    notebookRpcServer.issueControlConnection(sessionId, projectId)
  )
  // The renderer's approval card responds here; the broker resolves the held connector call.
  declareElectronAdapter('connector-approvals', () => {
    ipcMainHandle('connectors:approval-respond', (_event, request: RespondApprovalRequest) => {
      approvalBroker.respond(request.id, request.decision)
    })
    ipcMainHandle(
      'skills:conversation-import-respond',
      (_event, response: ConversationSkillImportApprovalResponse) => {
        skillImportApprovalBroker.respond(response)
      }
    )
    ipcMainHandle('skills:conversation-import-replay-pending', () => {
      skillImportApprovalBroker.replayPending()
    })
  })

  const initialConnectorSkillsReady = waitForInitialConnectorRefresh(
    connectorRuntimeSettings.refresh(),
    {
      // If custom MCP discovery outlives the startup barrier, the first agent may already have
      // materialized the old connector docs. Rotate it once the late refresh settles so the next
      // session/prompt uses the refreshed skills instead of waiting for another settings change.
      onLateSettled: () => runtimeRef.current?.requestSkillsReload()
    }
  )

  // Repair soft-owner grants left behind if the app stopped between deleting a Connector/ComputeHost
  // and pruning its authority. A failed/timeout Connector refresh leaves that owner class untouched;
  // app-owned MCP catalog ids are non-UUID and are never guessed to be stale.
  void initialConnectorSkillsReady
    .then(async () => {
      const hosts = await hostRepository.list()
      await reconcilePermissionGrantOwners(permissionGrantRegistry, {
        ...(connectorRuntimeSettings.current()
          ? {
              customServerIds:
                connectorRuntimeSettings.current()?.customMcpServers?.map((server) => server.id) ??
                []
            }
          : {}),
        computeProviderIds: hosts.map((host) => host.providerId)
      })
    })
    .catch((error) =>
      permissionGrantsLog.error(
        'permission grant owner reconciliation failed',
        errorLogFields(error)
      )
    )

  const cliCommandOwner = createCliCommandOwner()
  const githubCommandOwner = createGithubCommandOwner()
  const logsCommandOwner = createLogsCommandOwner()
  declareElectronAdapter('desktop-utilities', () => {
    registerFileSaveHandlers({ resolveManagedFilePath, resolveSessionArtifactFilePath })
    registerLogsIpcHandlers(logsCommandOwner)
    registerGithubIpcHandlers({}, githubCommandOwner)
    registerNetworkIpcHandlers()
    registerCliInstallIpcHandlers(cliCommandOwner)
    registerWindowIpcHandlers()
    registerWindowFindIpcHandlers()
  })
  // ACP identity resolution and the Specialist settings IPC must use the same service instance.
  // Creating it only for settings leaves create-session unable to resolve a selected UUID.
  const contextSummaryCapture = createContextSummaryCapture({
    repository: contextSummaryRepository,
    loadSession: (projectId, sessionId) => sessionRepository.loadSession(projectId, sessionId),
    projectIdForSession: async (sessionId) => {
      // Session ids are not globally unique across projects; resolve by scanning the loaded set.
      // Compaction is rare, so a full scan is acceptable.
      try {
        const { sessions } = await sessionRepository.loadAll()
        return sessions.find((session) => session.id === sessionId)?.projectId
      } catch {
        return undefined
      }
    }
  })
  const runtime = await modules.add(
    {
      mcpEntryPath: mainEntryPath,
      repository: artifactRepository,
      runRegistry: artifactRunRegistry,
      provenanceRepository: artifactProvenanceRepository,
      uploadRepository,
      notebookRpcServer,
      peekNotebookHandoffContext: (sessionId) => notebookService.peekHandoffContext(sessionId),
      authorizeSkillImportReferencedUploads: (projectId, sessionId, paths) =>
        conversationSkillImporter.authorizeReferencedUploads(projectId, sessionId, paths),
      settingsService,
      permissionGrantRegistry,
      taskNotifications,
      notificationInbox,
      folderGrants: folderGrantsService,
      onSessionTurnStarted: (sessionId, turnToken) =>
        skillImportApprovalBroker.beginSessionTurn(sessionId, turnToken),
      onSessionTurnEnded: (sessionId, turnToken) =>
        skillImportApprovalBroker.endSessionTurn(sessionId, turnToken),
      onSkillImportAttachmentEligible: (sessionId, turnToken, attachmentUri) =>
        skillImportApprovalBroker.allowSessionTurnAttachment(sessionId, turnToken, attachmentUri),
      onSessionCancellationRequested: (sessionId) =>
        skillImportApprovalBroker.cancelSession(sessionId),
      onSessionUnavailable: (sessionId) => skillImportApprovalBroker.cancelSession(sessionId),
      onAllSessionsCancellationRequested: () => skillImportApprovalBroker.cancelAll(),
      beforeSessionDelete: (sessionId) =>
        notebookService.shutdownSession(sessionId).then(() => undefined),
      initializationBarrier: initialConnectorSkillsReady,
      profileService,
      sessionPersistenceCoordinator,
      contextSummaryCapture
    },
    (options) => {
      const runtime = createAcpRuntime(options)
      return {
        name: 'acp-runtime',
        capability: runtime,
        disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS,
        rollback: () =>
          backendTeardownOwnedByCoordinator
            ? undefined
            : runtime.shutdownForQuit().then(() => undefined)
      }
    }
  )
  surfaceAdapters = afterAcpAdapters
  runtimeRef.current = runtime
  // Archive availability is checked at the final admission point, rather than trusting renderer
  // visibility, so an archived Project/Session cannot restart work through another surface.
  runtime.setPromptAdmissionGuard((sessionId) =>
    archiveCoordinator.assertSessionAvailableById(sessionId)
  )
  const codeReconstructionLog = createLogger('artifacts:code-reconstruction')
  const codeReconstructionRunner = await modules.add(
    {
      appVersion: app.getVersion(),
      configRoot,
      captureTarget: () => settingsService.captureActiveExplicitAgentBackendTarget(),
      resolveTarget: (target, context) =>
        settingsService.resolveExplicitAgentBackend(target, context)
    },
    (options) => {
      const runner = new ArtifactCodeReconstructionRunner(options)
      return {
        name: 'artifact-code-reconstruction-runner',
        capability: runner,
        dispose: () => runner.shutdown()
      }
    }
  )
  void codeReconstructionRunner
    .sweepStaleProfiles()
    .catch((error) =>
      codeReconstructionLog.error(
        'stale reconstruction profile cleanup failed',
        diagnosticErrorFields(error)
      )
    )
  const codeReconstruction = new ArtifactCodeReconstructionService({
    provenance: artifactProvenanceRepository,
    runner: codeReconstructionRunner
  })
  const createSessionWorkflow = createAcpCreateSessionWorkflow(runtime, {
    assertProjectAvailable: (projectId) => archiveCoordinator.assertProjectAvailable(projectId)
  })
  const acpHandlerWorkflows = createAcpHandlerWorkflows(
    runtime,
    createSessionWorkflow,
    taskNotifications,
    archiveCoordinator,
    sessionRepository
  )
  const taskAgent = createAcpTaskAgentPort(
    runtime,
    createSessionWorkflow,
    taskNotifications,
    archiveCoordinator
  )
  await modules.add(undefined, () => {
    const scheduler = new RoutineScheduler({
      repository: {
        listAllSchedules: () => routineRepository.listAllSchedules(),
        recordTick: (sessionId, routineId, result) =>
          routineRepository.recordTick(sessionId, routineId, result),
        setEnabled: (sessionId, routineId, enabled) =>
          routineRepository.setEnabled(sessionId, routineId, enabled)
      },
      dispatchTick: async (schedule) => {
        try {
          // A scheduled tick runs as a fresh task session in the owning session's project. The
          // instruction is a self-contained prompt, so the fresh session needs no memory of the
          // scheduling conversation.
          const owner = (await sessionRepository.loadAll()).sessions.find(
            (session) => session.id === schedule.sessionId
          )
          if (!owner) {
            return { kind: 'error', message: 'Owning session no longer exists.' }
          }
          const created = await taskAgent.createSession({
            projectId: owner.projectId,
            permissionProfile: 'ask'
          })
          await taskAgent.prompt({
            sessionId: created.sessionId,
            promptMessageId: randomUUID(),
            text: schedule.instruction
          })
          return { kind: 'ok', runId: created.sessionId }
        } catch (error) {
          return {
            kind: 'error',
            message: error instanceof Error ? error.message : String(error)
          }
        }
      }
    })
    return {
      name: 'routine-scheduler',
      capability: scheduler,
      start: () => scheduler.start(),
      rollback: () => scheduler.stop(),
      dispose: () => scheduler.stop()
    }
  })
  {
    // Framework-specific adapters declare their own session selector. The registry resolves those
    // selectors before its generic fallback, so registration order cannot route a Codex/OpenCode
    // completion through the wrong continuation path.
    completionGateRuntimeRegistry.register(
      createCodexCompletionGateRuntime({
        runtime,
        resolveApprovedSpecialistId: (sessionId) => sessionBindingService.getBinding(sessionId)
      })
    )
    completionGateRuntimeRegistry.register(
      createOpenCodeImmediateHandoffRuntime({
        runtime,
        resolveSpecialistId: (sessionId) => sessionBindingService.getBinding(sessionId),
        reportHandoffFailure: async (failure) =>
          runtime.reportApprovedHandoffFailure(failure.sessionId)
      })
    )
    completionGateRuntimeRegistry.register(
      createProductionAppHandoffRuntime({
        runtime,
        sessionBinding: sessionBindingService
      })
    )
  }
  // Claude's Specialist identity is baked into agent session creation. Its selector joins the Codex
  // and OpenCode selectors above; the generic runtime remains fallback-only.
  registerClaudeCodeCompletionGateRuntime(completionGateRuntimeRegistry, {
    sessionFramework: (sessionId) => runtime.getSessionFramework(sessionId),
    cancelPrompt: (request) => runtime.cancelPrompt(request),
    waitForPromptOwnershipRelease: (sessionId) => runtime.waitForPromptOwnershipRelease(sessionId),
    resolveSpecialistId: (sessionId) => sessionBindingService.getBinding(sessionId),
    resolveSwitchReadBack: async (sessionId, targetName) => {
      const specialistId = sessionBindingService.getBinding(sessionId)
      const revision = specialistId
        ? (await profileService.resolveRunnableById(specialistId)).revision
        : undefined
      return {
        status: 'approved',
        operation: 'switch',
        binding: {
          sessionId,
          specialistId,
          targetName,
          ...(revision === undefined ? {} : { revision })
        }
      }
    },
    prepareReplayContext: async (input) => {
      const persisted = (await sessionRepository.loadAll()).sessions.find(
        (session) => session.id === input.sessionId
      )
      runtime.prepareClaudeCodeHandoffReplay({
        ...input,
        supportedTaskContext: selectPersistedUserTaskContext(persisted?.messages ?? [])
      })
    },
    discardReplayContext: async (sessionId) => runtime.discardClaudeCodeHandoffReplay(sessionId),
    switchSpecialist: (sessionId, specialistId) =>
      runtime.switchSpecialist(sessionId, specialistId),
    createContinuationRequest: (input) => runtime.createClaudeCodeContinuationRequest(input),
    sendAppContinuation: (request) => runtime.sendAppContinuation(request),
    reportHandoffFailure: async (_error, _handoff, context) => {
      runtime.reportApprovedHandoffFailure(context.sessionId)
    }
  })
  void completionHandoffLifecycle.recover().catch((error: unknown) => {
    createLogger('completion-handoff').error(
      'failed to recover approved handoffs',
      errorLogFields(error)
    )
  })
  permissionGrantRegistry.subscribe(() => runtime.notifyPermissionGrantsChanged())
  // Single shared teardown owner for both the before-quit handler (index.ts) and the pre-update-install
  // gate. Update handling is deliberately constructed below, after this dependency is complete.
  const shutdownCoordinator = new BackendShutdownCoordinator({
    runtime,
    notebook: notebookService,
    log: createLogger('shutdown')
  })
  // Construct update handling only after its backend-shutdown gate exists. The in-place strategy owns
  // this immutable dependency from construction; the manifest fallback ignores it because it does not
  // quit the running app to install.
  const updateStrategy = createUpdateStrategy(process.platform, {
    installGate: () => shutdownCoordinator.runForUpdateGate(UPDATE_SHUTDOWN_BUDGET_MS)
  })
  const updateCommandOwner = createUpdateCommandOwner(updateStrategy, {
    // Settings → General auto-apply opt-in: when on, a finished in-place download restarts the
    // app to install instead of waiting for the user's click.
    isAutoApplyEnabled: () => settingsService.getAutoApply()
  })
  let stopUpdateScheduler: (() => void) | undefined
  await modules.add(undefined, () => ({
    name: 'update-scheduler',
    capability: undefined,
    dispose: () => stopUpdateScheduler?.()
  }))
  declareElectronAdapter('update', () => {
    registerUpdateIpcHandlers(updateStrategy, updateCommandOwner)
    stopUpdateScheduler = startUpdateScheduler(updateStrategy)
  })
  const permissionGrantProjection = await modules.add(
    {
      registry: permissionGrantRegistry,
      projects: {
        list: async () => {
          await projectDeletionCoordinator.recoverPendingDeletions()
          return projectRepository.list()
        }
      },
      sessions: {
        metadataSnapshot: () =>
          loadSessionMetadataAfterProjectRecovery(
            projectDeletionCoordinator,
            sessionPersistenceCoordinator
          )
      },
      connectors: {
        get: async () => ({
          ...(await settingsService.getConnectors()),
          bundledConnectorIds: ALL_CONNECTOR_IDS
        })
      }
    },
    (dependencies) => {
      const owner = createPermissionGrantProjectionController({
        ...dependencies,
        publishChanged: (payload) => broadcastToRenderers('permissions:changed', payload)
      })
      return {
        name: 'permission-grant-projection',
        capability: owner,
        dispose: () => owner.dispose()
      }
    }
  )
  // Spawn-config changes rotate the coordinator's runtime for future sessions. Existing sessions retain
  // their owning runtime, so a framework/provider switch cannot interrupt an in-flight turn.
  const settingsWorkflows = createSettingsWorkflows(settingsService, {
    runtime: {
      requestProviderReconnect: () => void runtime.requestProviderReconnect(),
      requestAgentFrameworkSwitch: () => void runtime.requestAgentFrameworkSwitch(),
      applyReasoningEffort: (effort) => runtime.applyReasoningEffortChange(effort),
      applyModelChange: (target) => runtime.applyModelChange(target)
    },
    skills: { requestSkillsReload: () => void runtime.requestSkillsReload() },
    connectors: {
      invalidatePermissionProjection: () => permissionGrantProjection.invalidateProjection(),
      refreshConnectorSkillDocs: () => connectorRuntimeSettings.refresh(),
      requestSkillsReload: () => void runtime.requestSkillsReload(),
      pruneCustomServerPermissions: (serverId) =>
        permissionGrantRegistry.prune({ kind: 'mcp_server', serverId }).then(() => undefined),
      beginCustomServerSecurityChange: (serverId) =>
        connectorService.beginCustomServerSecurityChange(serverId),
      clearCustomServerFailure: (serverId) => connectorService.clearCustomServerFailure(serverId)
    },
    appearance: { applyAppIconVariant: onAppIconVariantChanged ?? (() => undefined) }
  })
  declareElectronAdapter('settings', () =>
    registerSettingsIpcHandlers({
      service: settingsService,
      workflows: settingsWorkflows,
      listAppIconPreviews,
      connectorTemplateFiles: {
        select: async () => {
          const selected = await dialog.showOpenDialog({
            title: 'Import Connector configuration',
            properties: ['openFile'],
            filters: [{ name: 'Connector configuration', extensions: ['json'] }]
          })
          const filePath = selected.filePaths[0]
          if (selected.canceled || !filePath) return { cancelled: true as const }
          if ((await stat(filePath)).size > CONNECTOR_TEMPLATE_MAX_BYTES) {
            throw new Error('Connector configuration files must be 256 KiB or smaller')
          }
          return {
            cancelled: false as const,
            fileName: basename(filePath),
            contents: await readFile(filePath, 'utf8')
          }
        },
        save: async (suggestedFileName, contents, sender) => {
          const selected = await showSettingsSaveDialog(sender, {
            title: 'Export Connector configuration',
            defaultPath: suggestedFileName,
            filters: [{ name: 'Connector configuration', extensions: ['json'] }]
          })
          if (selected.canceled || !selected.filePath) return false
          await writeFile(selected.filePath, contents, 'utf8')
          return true
        }
      },
      skillExportFiles: {
        save: (archive, sender) =>
          saveSkillExport(
            {
              showSaveDialog: (options) => showSettingsSaveDialog(sender, options),
              writeFile: (filePath, bytes) => writeFile(filePath, bytes)
            },
            archive
          )
      }
    })
  )
  declareElectronAdapter('notebook', () => registerNotebookIpcHandlers(notebookCommands))
  // Wire session deletion to the binding store so stale in-memory bindings do not accumulate.
  // The renderer calls sessions:delete-session (via sessionPersistenceBackend) and acp:delete-session
  // separately; both paths should clear the binding. Override the backend deleteSession callback here
  // so all durable-path deletions — regardless of whether the ACP session was attached — clear the
  // binding in one place.
  const originalDeleteSession =
    sessionPersistenceBackend.deleteSession.bind(sessionPersistenceBackend)
  sessionPersistenceBackend.deleteSession = async (projectId, sessionId) => {
    await originalDeleteSession(projectId, sessionId)
    sessionBindingService.clearSession(sessionId)
  }
  const sessionDocumentLoader = {
    loadSession: (projectId: string, sessionId: string) =>
      sessionRepository.loadSession(projectId, sessionId)
  }
  const sessionPersistenceHandlers = createSessionPersistenceHandlers(
    sessionPersistenceBackend,
    reviewRepository,
    sessionDocumentLoader
  )
  const specialistPersistLog = createLogger('specialist:persist')
  declareElectronAdapter('specialist', () =>
    registerSpecialistIpcHandlers(
      profileService,
      sessionBindingService,
      // Persist only the specialist UUID to the durable session file — never a profile snapshot.
      // Read the current session file, patch specialistId, and save so the binding survives restarts.
      // Reading all sessions to locate the target is intentional: sessionId alone is not sufficient to
      // open the file (it lives under sessions/<projectId>/<sessionId>.json), and this operation is
      // infrequent enough that the scan cost is acceptable.
      async (sessionId, specialistId) => {
        const allSessions = await sessionRepository.loadAll()
        const session = allSessions.sessions.find((s) => s.id === sessionId)
        if (!session) {
          // The session has not yet been persisted (created but not saved). The specialistId will be
          // written when the renderer calls sessions:save-session for the first time.
          specialistPersistLog.debug(
            'session not yet durable; specialistId will be written on first save',
            {
              sessionId,
              specialistId
            }
          )
          return
        }
        await sessionPersistenceCoordinator.saveSessionSpecialistBinding(session, specialistId)
      },
      // Apply the switch to the live agent runtime. The closure is invoked per-request, so a
      // late-bound reference is unnecessary.
      (sessionId, specialistId) => runtime.switchSpecialist(sessionId, specialistId),
      // A specialist capability edit (skills/connectors/enabled) must reach live sessions on the next
      // turn: reconnect so the agent respawns (re-provisioning skills) and resumes with the updated
      // specialist whitelist in the session _meta.
      () => void runtime.requestSkillsReload(),
      createContributionTemplateExporter({
        appVersion: app.getVersion(),
        showSaveDialog: (options) => dialog.showSaveDialog(options),
        readReadme: () => readFile(resolveContributionTemplateReadmePath(app.getAppPath()), 'utf8'),
        writeFile: (filePath, bytes) => writeFile(filePath, bytes)
      }),
      {
        service: specialistPackageService,
        selectArchive: () =>
          selectSpecialistArchive({
            showOpenDialog: (options) => dialog.showOpenDialog(options),
            readFile,
            getFileSize: async (filePath) => (await stat(filePath)).size
          }),
        saveReport: (report) =>
          saveSpecialistPackageReport(
            {
              showSaveDialog: (options) => dialog.showSaveDialog(options),
              writeFile: (filePath, contents) => writeFile(filePath, contents, 'utf8')
            },
            report
          ),
        saveExport: (archive) =>
          saveSpecialistExport(
            {
              showSaveDialog: (options) => dialog.showSaveDialog(options),
              writeFile: (filePath, bytes) => writeFile(filePath, bytes)
            },
            archive
          )
      },
      {
        service: marketplaceService,
        broadcastDownloadProgress: (progress) =>
          broadcastToRenderers(SPECIALIST_MARKETPLACE_IPC.DOWNLOAD_PROGRESS, progress)
      }
    )
  )
  // Runtime selection UI (Settings/Onboarding): survey managed+external per language, persist the
  // choice, and pick an interpreter file. The runtime root MUST match the executor/service's
  // (getRuntimeRoot(<dataRoot>)); read lazily so a data-root switch is reflected without re-register.
  const runtimeSelectionWorkflows = createRuntimeSelectionWorkflows({
    settingsService,
    runtimeRoot: () => getRuntimeRoot(resolveDataRoot()),
    // WS10: revoke a disabled runtime from any live session bound to it (mark binding unavailable).
    onRuntimeDisabled: (language, envId, force) =>
      notebookService.revokeRuntime(language, envId, { force }),
    // WS11: live-session usage of a runtime, for the disable-impact warning.
    describeRuntimeUsage: (language, envId) =>
      notebookService.describeRuntimeUsage(language, envId),
    prepareExternalPython: async (selection, root) => {
      const configuredMirror = await settingsService.getPackageMirror()
      const mirror = await effectiveMirrorAsync(configuredMirror, app.getLocale())
      await prepareExternalPythonRuntime(selection, root, {
        pypiIndex: mirror.pypiIndex,
        caBundle: mirror.caBundle
      })
    }
  })
  declareElectronAdapter('notebook-runtime', () =>
    registerRuntimeIpcHandlers(runtimeSelectionWorkflows)
  )
  declareElectronAdapter('managed-preview', () =>
    installManagedPreviewElectronAdapter(previewResources, undefined, managedPreviewOwners)
  )
  declareElectronAdapter('office-preview-runtime', () =>
    registerOfficePreviewRuntimeProtocol(
      {
        runtimeHtmlPath: join(__dirname, '../renderer/office-preview.html'),
        devServerUrl: process.env['ELECTRON_RENDERER_URL'],
        fetchRuntime: (targetUrl, request) =>
          net.fetch(targetUrl, {
            // Runtime assets are public application files. Forwarding custom-protocol headers or its
            // abort signal makes Chromium treat the local fetch as a cross-site renderer request.
            method: request.method
          })
      },
      protocol
    )
  )
  const officePreviewSupervisor = new OfficePreviewSupervisor({
    inspectResource: ({ source, path }) => previewResources.inspect({ source, path }),
    acquireResource: (ownerId, request, snapshot, maxBytes) =>
      previewResources.acquire(
        ownerId,
        { source: request.source, path: request.path },
        { snapshot, maxBytes }
      ),
    releaseResource: (ownerId, resourceId) => previewResources.release(ownerId, { resourceId }),
    createSessionId: randomUUID,
    createRuntimeUrl: createOfficePreviewRuntimeUrl,
    resolveFrameProcess: createOfficePreviewFrameProcessResolver(webContents),
    getProcessMemoryUsageBytes: createOfficePreviewProcessMemoryReader(app),
    publishState: (ownerId, state) =>
      webContents.fromId(ownerId)?.send(OFFICE_PREVIEW_STATE_CHANNEL, state)
  })
  declareElectronAdapter('office-preview', () =>
    registerOfficePreviewIpcHandlers(officePreviewSupervisor)
  )

  // Resolve the shared conda base under the app data root (relocatable, where the runtime install
  // lives) and start the env readiness gate. The conda channel comes from the effective package mirror
  // (configured override, else the region default from locale). Runtime packs use the official CDN base
  // with PURESCIENCE_ENV_CDN_BASE available for private/self-hosted deployments.
  const provisioningRoot = runtimeRoot(resolveDataRoot())
  // Build the provisioner separately from registering the IPC surface: if construction fails (e.g.
  // micromamba missing in dev), `provisioner` stays undefined but the notebook-env handlers are STILL
  // registered below (as unavailable stubs), so the renderer gets an actionable "runtime unavailable"
  // status/error instead of a hard "No handler registered for notebook-env:provision" crash.
  let provisioner: ReturnType<typeof createProductionProvisioner> | undefined
  let serialized: RuntimeProvisioner | undefined
  try {
    const configuredMirror = await settingsService.getPackageMirror()
    const mirror = await effectiveMirrorAsync(configuredMirror, app.getLocale())
    provisioner = createProductionProvisioner({
      root: provisioningRoot,
      channel: mirror.condaChannel ?? process.env.PURESCIENCE_CONDA_CHANNEL ?? 'conda-forge',
      caBundle: mirror.caBundle,
      micromamba: { resourcesPath: process.resourcesPath },
      // Self-guard the provisioner's prefix writes (startup restore/upgrade/repair, named create, lazy
      // materialize) against a prefix crash-recovery could not confirm free of a live orphan — closes
      // the startup-gate path the UI-only assertProvisionAllowed guard did not cover. Reads the live
      // blocked set at call time (recovery is awaited before the gate touches any prefix).
      isPrefixBlocked: (prefix) => notebookService.isPrefixRecoveryBlocked(prefix),
      // An explicit user Reset (repair with force) clears the in-memory block; the provisioner also
      // clears the retained journal record + sidecar so the quarantine doesn't re-arm next startup.
      clearPrefixBlock: (prefix) => notebookService.clearRecoveryBlock(prefix),
      // Reset also clears an interrupted install's runtime-ID block, or bound sessions would still be
      // rejected after the env rebuilds until the next restart.
      clearRuntimeBlock: (runtimeId) => notebookService.clearRuntimeRecoveryBlock(runtimeId),
      // A force Reset that finds the journal itself corrupt moves it aside and releases just THAT prefix
      // from the global corrupt-journal barrier — other envs stay blocked until their own Reset/restart.
      clearCorruptBlock: (prefix) => notebookService.clearCorruptRecoveryBlock(prefix),
      // On an unconfirmed-child prefix-write failure, block the prefix in-process immediately so an
      // in-session retry can't begin() a second op that races the first's possibly-live orphan.
      blockPrefix: (prefix) => notebookService.blockPrefixRecovery(prefix),
      // Lets a force Reset refuse a prefix an interrupted install (or prefix write) this session left with
      // a possibly-live orphan — the provisioner can't see install failures in its own set.
      isPrefixLiveUnconfirmed: (prefix) => notebookService.isPrefixLiveUnconfirmed(prefix),
      // Share the service's per-env install lock so a default-env create/repair/upgrade serializes with
      // a package install into the same env prefix instead of racing it on a separate lock.
      withPrefixLock: (envName, fn) => notebookService.withEnvLock(envName, fn)
    })
    // One serialized wrapper shared by the startup gate and the notebook service's on-demand default
    // provisioning, so a concurrent build of the same default env (UI R-tab + an agent R run) can't
    // race the provisioner's shared in-flight flag; materialize is also idempotent as a backstop.
    serialized = serializeProvisioner(provisioner)
  } catch (error) {
    // micromamba missing (e.g. dev without a staged binary): the notebook env stays unprovisioned and
    // the UI surfaces "runtime unavailable" rather than crashing startup or dropping the IPC handlers.
    console.error('Notebook environment provisioning unavailable:', error)
  }
  // Crash recovery (WS13): reconcile any runtime operation the previous process left in flight (orphan
  // download staging, a half-built prefix, an interrupted install). Kicked off HERE — before the env
  // IPC gate below — so recoverInterruptedOperations() publishes its barrier synchronously and every
  // prefix-touching path (the startup gate's restore/upgrade/repair, UI provision/repair, named-env
  // create, on-demand materialize, install) can await it and never race recovery's cleanup/delete.
  // Fire-and-forget so a slow/failed recovery never blocks IPC registration; the barrier itself is what
  // actually orders the prefix work.
  void notebookService
    .recoverInterruptedOperations()
    .catch((error) => console.error('Notebook operation recovery failed:', error))
  const waitForRecovery = (): Promise<void> => notebookService.ensureRecovered()
  // Lets UI provision/repair refuse when recovery left the default env's prefix blocked (an
  // unknown-liveness orphan may still be writing it) — throws with an actionable message.
  const assertProvisionAllowed = (language: NotebookLanguage): void => {
    if (notebookService.isDefaultEnvRecoveryBlocked(language)) {
      throw new Error(
        `The ${language} runtime is recovering from an interrupted operation whose process could not be ` +
          'confirmed stopped. Restart the app to re-check and recover it before setting it up again.'
      )
    }
  }

  const notebookEnvironmentLifecycle = createNotebookEnvironmentLifecycle({
    provisioner: serialized,
    root: provisioningRoot,
    projectProgress: broadcastNotebookEnvProgress,
    waitForRecovery,
    assertProvisionAllowed,
    onRepairCompleted: (language) => notebookService.completeRuntimeRepair(language)
  })
  // Always register the handlers (serialized is undefined when the provisioner could not be built).
  // Start maintenance only after all four Electron channels exist, preserving the previous startup
  // ordering while construction remains application-owned and single-instance.
  declareElectronAdapter('notebook-environment', () => {
    installNotebookEnvironmentSurface(notebookEnvironmentLifecycle, registerNotebookEnvIpcHandlers)
  })
  if (provisioner && serialized) {
    // Back the notebook service's manage_environments tool with the same provisioner that owns the env
    // gate (it is a DefaultRuntimeProvisioner, which implements createNamedEnvironment/listEnvironments/
    // removeEnvironment). Wired after construction like the mcp/mirror resolvers above.
    notebookService.setEnvironmentManager(provisioner as unknown as NotebookEnvironmentManager)
    // On first agent use of a not-yet-built default env, build it from the offline bundle (via the
    // shared serialized provisioner) instead of erroring — keeps R lazy but avoids the agent creating
    // a redundant named env.
    notebookService.setDefaultEnvProvisioner(serialized, broadcastNotebookEnvProgress)
  }

  // Registered after the acp/notebook handlers exist: migration needs to interrupt both runtimes.
  const storageCommandOwner = createStorageCommandOwner({
    runtime,
    notebook: notebookService,
    getActivePromptSessions: () => runtime.getActivePromptSessions(),
    settingsService
  })
  declareElectronAdapter('storage', () =>
    registerStorageIpcHandlers(
      {
        runtime,
        notebook: notebookService,
        getActivePromptSessions: () => runtime.getActivePromptSessions(),
        settingsService
      },
      storageCommandOwner
    )
  )
  const artifactHandlers = createArtifactHandlers(artifactRepository, artifactRunRegistry, {
    getActiveArtifactRunIds: () =>
      runtimeRef.current ? runtimeRef.current.getActiveArtifactRunIds() : [],
    provenance: artifactProvenanceRepository,
    codeReconstruction,
    // Re-runs go through the same notebook execution the original run used, in a throwaway directory.
    replay: createArtifactReplayAdapter({
      provenance: artifactProvenanceRepository,
      executeNotebook: (request) => notebookCommands.execute(request),
      appVersion: () => app.getVersion(),
      // A re-run executes through this app's own notebook, so the directory it can actually run in is a
      // notebook session directory. Claiming one and grading it is what makes the verdict comparable.
      notebookDataRoot: (projectName, sessionId) =>
        getNotebookDataRoot(resolveDataRoot(), projectName, sessionId),
      // A re-run starts in the environment the recorded run used, read from that session's own record; if
      // the record is gone it runs under the default and the verdict keeps saying the lock was not applied.
      readNotebookBindings: async ({ projectName, sessionId }) => {
        // Straight from the session's own record: no live session has to exist for a re-run to know which
        // interpreter the recorded run used.
        const document = await new NotebookRunRepository(resolveDataRoot()).findExisting(
          projectName,
          sessionId
        )
        return document?.runtimeBindings
      },
      bindNotebookRuntime: (request) => notebookService.bindRuntime(request),
      shutdownNotebookSession: (request) => notebookCommands.shutdown(request)
    }),
    withSessionMutation: (projectId, sessionId, mutation) =>
      sessionPersistenceCoordinator.runSessionMutation(projectId, sessionId, mutation)
  })
  // Now that the artifact surface exists, the search can read artifact file text through it.
  artifactPreviewForSearch = (request) => artifactHandlers.readPreview(request)
  declareElectronAdapter('artifacts', () =>
    registerArtifactIpcHandlers(
      artifactRepository,
      artifactRunRegistry,
      () => (runtimeRef.current ? runtimeRef.current.getActiveArtifactRunIds() : []),
      artifactProvenanceRepository,
      (projectId, sessionId, mutation) =>
        sessionPersistenceCoordinator.runSessionMutation(projectId, sessionId, mutation),
      artifactHandlers
    )
  )
  declareElectronAdapter('uploads', () =>
    registerUploadIpcHandlers(uploadCommandOwner, {
      // Standalone "Save as artifact" uploads have no session mutation to piggyback on, so the
      // Files panel only learns about them through this broadcast.
      onStandaloneUploadSaved: (projectId, sessionId) =>
        broadcastToRenderers('project-files:changed', {
          projectId,
          sessionId,
          sources: ['upload'],
          kind: 'upsert'
        })
    })
  )
  declareElectronAdapter('notebook-input-preview', () => {
    ipcMainHandle('notebook:read-input-preview', (_event, request) =>
      notebookInputRegistry.readPreview(request)
    )
  })
  declareElectronAdapter('session-persistence', () => {
    registerSessionPersistenceIpcHandlers(
      sessionPersistenceBackend,
      reviewRepository,
      sessionDocumentLoader,
      sessionPersistenceHandlers
    )
    // The reconciliation pass is no longer a side effect of reading the session list: the list tier
    // answers from the on-disk index and parses nothing, so it cannot be what upgrades legacy Uploads,
    // recovers artifacts, backfills the file projection or reaps stale permission grants. Kick the
    // full pass once per process here instead — the same work the first catalog read used to run,
    // still on the startup boundary (this is the first loadAll of the process), just not on the user's
    // critical path. Fire-and-forget: a failure is reported and retried on the next startup, and it
    // must not hold up adapter installation.
    void loadSessionsAfterProjectRecovery(
      projectDeletionCoordinator,
      sessionPersistenceCoordinator
    ).catch((error: unknown) => {
      createLogger('session-persistence').error(
        'startup session reconciliation failed',
        errorLogFields(error)
      )
    })
  })
  const conversationExportService = createConversationExportService({
    loadSession: (projectId, sessionId) => sessionRepository.loadSession(projectId, sessionId),
    isSessionActive: (projectId, sessionId) =>
      runtime
        .getActivePromptSessions()
        .some(
          (activeSession) =>
            activeSession.projectName === projectId && activeSession.sessionId === sessionId
        )
  })
  declareElectronAdapter('conversation-export', () =>
    registerConversationExportIpcHandler(conversationExportService)
  )
  declareElectronAdapter('permission-grants', () =>
    registerPermissionGrantIpcAdapter(permissionGrantProjection)
  )
  declareElectronAdapter('search', () => registerSearchIpcHandlers(searchHandlers))
  declareElectronAdapter('project-files', () =>
    registerProjectFilesIpcHandlers(
      projectFilesRepository,
      sessionPersistenceCoordinator,
      projectDeletionCoordinator,
      projectFilesHandlers
    )
  )
  // Backs the "This computer" browser; shares localFsService with the managed-preview resolver.
  declareElectronAdapter('local-fs', () => registerLocalFsIpcHandlers(localFsService))
  declareElectronAdapter('projects', () =>
    registerProjectIpcHandlers(
      projectRepository,
      previewStateRepository,
      projectDeletionCoordinator,
      projectHandlers
    )
  )
  declareElectronAdapter('lifecycle', () => registerLifecycleIpcHandlers())
  // Compute IPC handlers are registered earlier (before the notebook RPC server) so computeService
  // can be injected into the RPC server for the computeCall route. See above.
  // Wire the reviewer backend into the app lifecycle: installs ipcMainHandle('reviewer:run', ...)
  // and 'reviewer:get-for-session' so the renderer's fire-and-forget reviewer calls resolve to
  // real handlers instead of no-ops. Passing the already-constructed AcpRuntime so the reviewer
  // can spawn sessions under the same agent connection.
  const reviewerOptions = {
    acpRuntime: runtime,
    mcpEntryPath: mainEntryPath,
    // Pins are verified against the same loaded sessions the search reads, so a pin and a palette
    // hit can never disagree about what the transcript says.
    searchEvidence: {
      verify: (line) =>
        createSearchEvidenceService({
          readSessionMessages: async (sessionId) => {
            const { sessions } = await sessionPersistenceBackend.loadAll()
            const session = sessions.find((candidate) => candidate.id === sessionId)
            return session ? toSearchableMessages(session) : []
          }
        }).verify(line)
    },
    artifactProvenanceRepository,
    withSessionMutation: <Result>(
      projectId: string,
      sessionId: string,
      mutation: () => Promise<Result>
    ) => sessionPersistenceCoordinator.runSessionMutation(projectId, sessionId, mutation),
    // Fold timeline: map persisted chunks to the UI view model.
    contextSummaryChunks: async (sessionId) => {
      const chunks = await contextSummaryRepository.listChunks(sessionId)
      return chunks.map((chunk) => ({
        id: chunk.id,
        level: chunk.level,
        foldedAt: chunk.foldedAt,
        reason: chunk.reason,
        boundaryLabel: chunk.boundaryLabel,
        foldedTokens: chunk.foldedTokens,
        summaryText: chunk.summaryText,
        transcriptPreview: chunk.transcript.slice(0, 500)
      }))
    }
  }
  const reviewerCommandOwner = createReviewerCommandOwner(reviewerOptions)
  declareElectronAdapter('reviewer', () => {
    registerReviewerIpcHandlers(reviewerOptions, reviewerCommandOwner)
  })
  declareElectronAdapter('session-package', () =>
    registerSessionPackageIpcHandlers({
      loadSession: (projectId, sessionId) =>
        sessionRepository.loadSessionWithDiagnostics(projectId, sessionId),
      listReviews: (sessionId) => reviewRepository.getReviewsForSession(sessionId),
      // The evidence store answers by request; an attach-only answer is not evidence, so it is dropped
      // rather than passed off as a list.
      listEvidence: async (reviewIds) => {
        const result = await reviewerCommandOwner.evidence({ action: 'list', reviewIds })
        return 'attachments' in result ? result.attachments : []
      },
      listReferences: (projectId) => referencesIpcModule.handlers.list(projectId),
      files: (() => {
        // A session's files live in the project's file catalog, tagged with the session they belong to —
        // NOT in the session document, which carries none.
        const lister = createSessionPackageFileLister({
          listProjectFiles: (request) => artifactHandlers.listProjectFiles(request),
          readPreview: (request) => artifactHandlers.readPreview(request),
          maxFileBytes: DEFAULT_SESSION_PACKAGE_MAX_FILE_BYTES
        })
        return { countFiles: lister.countFiles, listFiles: lister.listFiles }
      })(),
      appVersion: app.getVersion()
    })
  )
  declareElectronAdapter('session-package-import', () =>
    registerSessionPackageImportIpcHandlers({
      owner: createSessionPackageImportOwner({
        configRoot: resolveConfigRoot(),
        saveSession: (session: PersistedChatSession) => sessionRepository.saveSession(session),
        workspaceFor: (sessionId: string) => join(resolveDataRoot(), 'workspaces', sessionId)
      }),
      // The picker lives at the edge, like the export's save dialog: only the adapter knows the window.
      showOpenDialog: async (window?: BrowserWindow) => {
        const options = {
          title: 'Import session package',
          filters: [{ name: 'PureScience session package', extensions: ['science'] }],
          properties: ['openFile' as const]
        }
        const result = window
          ? await dialog.showOpenDialog(window, options)
          : await dialog.showOpenDialog(options)
        return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
      }
    })
  )
  declareElectronAdapter('routine', () => {
    registerRoutineIpcHandlers(createRoutineCommandOwner(routineRepository))
  })
  declareElectronAdapter('endpoint', () => {
    registerEndpointIpcHandlers(createEndpointCommandOwner(endpointRepository, endpointManager))
  })
  declareElectronAdapter('annotation', () => {
    registerAnnotationIpcHandlers(createAnnotationCommandOwner(annotationRepository))
  })
  declareElectronAdapter('bookmark', () => {
    registerBookmarkIpcHandlers(createBookmarkCommandOwner(bookmarkRepository))
  })
  declareElectronAdapter('pdf', () => {
    registerPdfIpcHandlers(createPdfCommandOwner(pdfService))
  })
  declareElectronAdapter('figure', () => {
    registerFigureIpcHandlers(
      createFigureCommandOwner((request) => reviewFigure(request.panels, request.figureNote))
    )
  })
  declareElectronAdapter('query', () => {
    registerHostQueryIpcHandlers(createHostQueryCommandOwner(hostQueryService))
  })

  const electronSenderFor = (
    invocation: ApplicationInvocation<readonly unknown[]>
  ): WebContents => {
    const senderId = Number(invocation.callerContext.clientId)
    const sender =
      Number.isSafeInteger(senderId) && senderId > 0 ? webContents.fromId(senderId) : null
    if (!sender || sender.isDestroyed()) {
      throw new Error('Electron command caller is no longer available.')
    }
    return sender
  }
  const applicationCommandDependencies: ApplicationCommandCompositionDependencies = {
    acp: { runtime, workflows: acpHandlerWorkflows, archiveAvailability: archiveCoordinator },
    notebook: {
      workflows: notebookCommands,
      readInputPreview: (request) => notebookInputRegistry.readPreview(request)
    },
    notebookEnvironment: notebookEnvironmentLifecycle,
    notebookRuntime: {
      workflows: runtimeSelectionWorkflows,
      pickInterpreter: async () => {
        const result = await dialog.showOpenDialog({ properties: ['openFile'] })
        return result.filePaths[0] ?? null
      }
    },
    settingsCore: {
      service: settingsService,
      appearance: settingsWorkflows.appearance,
      emitInstallEvent: (event) => broadcastToRenderers(SETTINGS_INSTALL_LOG_CHANNEL, event),
      listAppIconPreviews
    },
    settingsIntegration: {
      skills: settingsWorkflows.skills,
      connectors: settingsWorkflows.connectors,
      connectorApprovals: approvalBroker,
      skillImportApprovals: skillImportApprovalBroker
    },
    settingsRuntime: { workflows: settingsWorkflows.runtime },
    compute: {
      compute: computeIpcModule.handlers,
      bookmarks: {
        get: (providerId) => settingsService.getComputeBookmarks(providerId),
        set: (providerId, folders) => settingsService.setComputeBookmarks(providerId, folders)
      },
      enabledHosts: hostsRegistry
    },
    permissionGrants: permissionGrantProjection,
    references: { references: referencesIpcModule.handlers },
    dataContent: {
      artifacts: artifactHandlers,
      electron: {
        exportConversationFromInvokingWindow: (invocation) => {
          const sender = electronSenderFor(invocation)
          return conversationExportService.exportConversation(
            invocation.args[0],
            BrowserWindow.fromWebContents(sender) ?? undefined
          )
        },
        stageLocalFileWithProgress: (invocation) => {
          const sender = electronSenderFor(invocation)
          return uploadCommandOwner.stageLocalFile(invocation, {
            report: (progress) => sender.send('uploads:transfer-progress', progress)
          })
        }
      },
      events: applicationEvents,
      managedPreview: managedPreviewOwners,
      preview: {
        load: (request) => previewStateRepository.get(request.projectId),
        save: (request) => previewStateRepository.save(request.projectId, request.state),
        delete: (request) => previewStateRepository.delete(request.projectId)
      },
      projectFiles: projectFilesHandlers,
      projects: projectHandlers,
      search: searchHandlers,
      sessions: sessionPersistenceHandlers,
      uploads: uploadCommandOwner,
      withDataRootWrite
    },
    host: {
      cli: cliCommandOwner,
      folderGrants: folderGrantsService,
      github: githubCommandOwner,
      localFs: localFsService,
      logs: logsCommandOwner,
      notifications: {
        peekPendingOpenSession: () => taskNotifications.peekPendingOpenSession(),
        takePendingOpenSession: (expectedToken) =>
          taskNotifications.takePendingOpenSession(expectedToken)
      },
      reviewer: reviewerCommandOwner,
      routine: createRoutineCommandOwner(routineRepository),
      endpoint: createEndpointCommandOwner(endpointRepository, endpointManager),
      annotation: createAnnotationCommandOwner(annotationRepository),
      bookmark: createBookmarkCommandOwner(bookmarkRepository),
      pdf: createPdfCommandOwner(pdfService),
      figure: createFigureCommandOwner((request) =>
        reviewFigure(request.panels, request.figureNote)
      ),
      query: createHostQueryCommandOwner(hostQueryService),
      storage: storageCommandOwner,
      update: updateCommandOwner
    }
  }

  // The shared coordinator remains the sole ACP + Notebook teardown owner. Register command routing
  // after it so reverse disposal removes adapters, then the router, before any underlying owner stops.
  await modules.add({ shutdownCoordinator }, ({ shutdownCoordinator: coordinator }) => ({
    name: 'backend-shutdown-coordinator',
    capability: undefined,
    disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS + APPLICATION_MODULE_DISPOSAL_BUDGET_MS,
    dispose: async () => BackendShutdownOutcomeError.assertClean(await coordinator.runForQuit())
  }))
  backendTeardownOwnedByCoordinator = true
  const applicationCommandComposition = await modules.add(
    applicationCommandDependencies,
    (dependencies) => {
      // Router diagnostics had no sink in production, so a slow handler was invisible: this is where the
      // first-open hitches had to be answerable from. Slow handlers are logged with their duration; the
      // rejection codes stay at debug (they already surface to the caller as errors).
      const applicationCommandLog = createLogger('application-commands')
      const composition = createApplicationCommandComposition(dependencies, (diagnostic) => {
        const fields = {
          commandName: diagnostic.commandName,
          ...(diagnostic.durationMs === undefined ? {} : { durationMs: diagnostic.durationMs })
        }
        if (diagnostic.code === 'slow-handler') {
          applicationCommandLog.warn('application command handler was slow', {
            ...fields,
            operation: 'application-command'
          })
          return
        }
        applicationCommandLog.debug('application command diagnostic', { ...fields, code: diagnostic.code })
      })
      return {
        name: 'application-command-composition',
        capability: composition,
        dispose: () => composition.dispose()
      }
    }
  )

  // Assemble the delegate sub-agent executor now that the task command surface exists. Delegate
  // runs auto-create the 'delegate-tasks' project on first use and accumulate task sessions under
  // it (same known behavior as web-service task runs). Registered as the LAST module so reverse
  // disposal tears it down before the command composition and runtime it depends on.
  const subAgentExecutor = createSubAgentExecutor({
    commands: applicationCommandComposition.task,
    agent: taskAgent,
    subscribeEvents: (listener) =>
      applicationEvents.subscribe((event) => {
        const runtimeEvent = projectTaskRuntimeEvent(event)
        if (runtimeEvent) listener(runtimeEvent)
      })
  })
  subAgentRef.current = subAgentExecutor.runSubAgent
  await modules.add({ subAgentExecutor }, ({ subAgentExecutor }) => ({
    name: 'delegate-sub-agent-executor',
    capability: undefined,
    dispose: () => subAgentExecutor.dispose()
  }))

  return {
    applicationCommands: {
      localWeb: applicationCommandComposition.localWeb,
      remoteWeb: applicationCommandComposition.remoteWeb,
      task: applicationCommandComposition.task
    },
    applicationEvents,
    bindRemoteAccess: applicationCommandComposition.bindRemoteAccess,
    taskNotifications,
    notificationInbox,
    settingsService,
    taskAgent,
    sessionDeletionCapability: sessionPersistenceCoordinator,
    archiveCapability: archiveCoordinator,
    detectActiveSessions: () => detectActiveSessions({ runtime, notebook: notebookService }),
    prepareForQuit: () => runtime.prepareForQuit(),
    electronAdapters: {
      beforeCompute: beforeComputeAdapters,
      compute: computeIpcModule,
      beforeAcp: beforeAcpAdapters,
      acp: { runtime, workflows: acpHandlerWorkflows },
      afterAcp: afterAcpAdapters
    }
  }
}

const registerIpcHandlers = async (options: IpcRegistrationOptions): Promise<IpcRegistration> => {
  const applicationRuntime = await composeApplicationRuntimeWithAdapters(
    (modules) => createApplicationModules(options, modules),
    installElectronRuntimeAdapters
  )
  return {
    ...applicationRuntime.interfaces,
    dispose: applicationRuntime.dispose
  }
}

export { registerIpcHandlers }
