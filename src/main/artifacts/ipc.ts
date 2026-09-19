import { shell } from 'electron'

import { ipcMainHandle } from '../ipc-handler-registry'

import {
  ARTIFACT_OWNERSHIP_PERSISTENCE_RACE,
  MAX_ARTIFACT_AVAILABILITY_PATHS,
  type ArtifactFile,
  type ArtifactPreviewResult,
  type FinalizeRunArtifactsResult,
  type ProbeArtifactAvailabilityRequest,
  type ProbeArtifactAvailabilityResult,
  type ResolveArtifactVersionDescriptorsRequest
} from '../../shared/artifacts'
import { stat } from 'node:fs/promises'
import type {
  ArtifactLineageProvenance,
  ArtifactVersionDescriptor,
  ArtifactVersionExecutionProvenance,
  ArtifactVersionMessagesProvenance,
  ArtifactVersionProvenance,
  ArtifactVersionReviewProvenance,
  GetArtifactLineageRequest,
  GetArtifactVersionProvenanceRequest
} from '../../shared/artifact-provenance'
import type {
  ArtifactCodeReconstructionState,
  GenerateArtifactCodeReconstructionRequest,
  GetArtifactCodeReconstructionRequest
} from '../../shared/artifact-code-reconstruction'
import { parseArtifactVersionLocator } from '../../shared/artifact-provenance'
import type { ReplayVersionRequest, ReplayVersionResult } from '../../shared/artifact-replay'
import type {
  FinalizeRunArtifactsRequest,
  ListProjectArtifactsRequest,
  OpenArtifactFileRequest,
  ReadArtifactPreviewRequest,
  ReconcilePendingArtifactsRequest,
  WriteUserEditedVersionRequest
} from '../../shared/artifacts'
import { resolveDataRoot } from '../storage-root'
import { withDataRootWrite } from '../storage/migration-state'
import { readBoundedManagedFilePreview } from '../managed-file-preview'
import { createLogger, type Logger } from '../logger'
import { ArtifactRepository } from './repository'
import { ArtifactRunRegistry } from './run-registry'
import {
  ArtifactFinalizationProofError,
  ArtifactOwnershipPersistenceRaceError,
  type ArtifactProvenanceRepository
} from './provenance-repository'

const log = createLogger('artifacts:finalization')

type ArtifactHandlers = {
  /** Re-runs a recorded version and compares the result with what it recorded producing. */
  replayVersion: (request: ReplayVersionRequest) => Promise<ReplayVersionResult>
  finalizeRunArtifacts: (request: FinalizeRunArtifactsRequest) => Promise<ArtifactFile[]>
  listProjectFiles: (request: ListProjectArtifactsRequest) => Promise<ArtifactFile[]>
  reconcilePendingArtifacts: (request: ReconcilePendingArtifactsRequest) => Promise<ArtifactFile[]>
  openFile: (request: OpenArtifactFileRequest) => Promise<void>
  readPreview: (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>
  probeAvailability: (
    request: ProbeArtifactAvailabilityRequest
  ) => Promise<ProbeArtifactAvailabilityResult>
  getLineage: (request: GetArtifactLineageRequest) => Promise<ArtifactLineageProvenance | undefined>
  writeUserEditedVersion: (request: WriteUserEditedVersionRequest) => Promise<ArtifactFile>
  getVersionProvenance: (
    request: GetArtifactVersionProvenanceRequest
  ) => Promise<ArtifactVersionProvenance>
  getVersionExecution: (
    request: GetArtifactVersionProvenanceRequest
  ) => Promise<ArtifactVersionExecutionProvenance>
  getVersionMessages: (
    request: GetArtifactVersionProvenanceRequest
  ) => Promise<ArtifactVersionMessagesProvenance>
  getVersionReview: (
    request: GetArtifactVersionProvenanceRequest
  ) => Promise<ArtifactVersionReviewProvenance>
  getCodeReconstruction: (
    request: GetArtifactCodeReconstructionRequest
  ) => Promise<ArtifactCodeReconstructionState>
  generateCodeReconstruction: (
    request: GenerateArtifactCodeReconstructionRequest
  ) => Promise<ArtifactCodeReconstructionState>
  resolveVersionDescriptors: (
    request: ResolveArtifactVersionDescriptorsRequest
  ) => Promise<ArtifactVersionDescriptor[]>
}

type ArtifactHandlerDependencies = {
  openPath?: (path: string) => Promise<string>
  logger?: Pick<Logger, 'error'>
  // Run ids of turns in flight right now (live runtime state). Their pending files are still being
  // written, so the orphan scan excludes them; a crashed run is absent here and correctly surfaces.
  getActiveArtifactRunIds?: () => string[]
  withSessionMutation?: <Result>(
    projectId: string,
    sessionId: string,
    mutation: () => Promise<Result>
  ) => Promise<Result>
  provenance?: Pick<
    ArtifactProvenanceRepository,
    | 'finalizeRun'
    | 'getLineage'
    | 'writeUserEditedVersion'
    | 'getVersionProvenance'
    | 'getVersionCore'
    | 'getVersionExecution'
    | 'getVersionMessages'
    | 'getVersionReview'
    | 'resolveVersionDescriptors'
    | 'resolveVersionContent'
    | 'resolveVersionPaths'
    | 'listUnpublishedProjectVersions'
  >
  codeReconstruction?: {
    get(request: GetArtifactCodeReconstructionRequest): Promise<ArtifactCodeReconstructionState>
    generate(
      request: GenerateArtifactCodeReconstructionRequest
    ): Promise<ArtifactCodeReconstructionState>
  }
  /** Re-running a recorded version and comparing the result with what it recorded producing. */
  replay?: {
    replayVersion: (request: ReplayVersionRequest) => Promise<ReplayVersionResult>
  }
}

// Serializes finalization per claim so duplicate renderer event processing cannot move files twice.
const withClaimLock = async <Result>(
  locks: Map<string, Promise<void>>,
  claimId: string,
  action: () => Promise<Result>
): Promise<Result> => {
  const previous = locks.get(claimId) ?? Promise.resolve()
  let release!: () => void
  const current = previous.then(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )

  locks.set(claimId, current)
  await previous

  try {
    return await action()
  } finally {
    release()

    if (locks.get(claimId) === current) {
      locks.delete(claimId)
    }
  }
}

// Creates artifact handlers with injectable dependencies for tests and Electron shell integration.
const createArtifactHandlers = (
  repository: ArtifactRepository,
  runRegistry: ArtifactRunRegistry,
  dependencies: ArtifactHandlerDependencies = {}
): ArtifactHandlers => {
  const finalizeLocks = new Map<string, Promise<void>>()
  const openPath =
    dependencies.openPath ?? ((filePath: string): Promise<string> => shell.openPath(filePath))
  const getActiveArtifactRunIds = dependencies.getActiveArtifactRunIds ?? ((): string[] => [])

  // A pending run must be treated as in-flight (not orphaned) for its whole lifecycle: while the prompt
  // runs (getActiveArtifactRunIds), AND after stop while its claim awaits the renderer's finalize call
  // (runRegistry unfinalized claims) — the run leaves the runtime's active set at stop, before finalize.
  const inFlightRunIds = (): Set<string> =>
    new Set([...getActiveArtifactRunIds(), ...runRegistry.getUnfinalizedRunIds()])

  return {
    finalizeRunArtifacts: (request) =>
      withDataRootWrite(() =>
        withClaimLock(finalizeLocks, request.claimId, () => {
          const claim = runRegistry.resolve(request.claimId)
          const finalize = (): Promise<ArtifactFile[]> =>
            finalizeRunArtifacts(
              repository,
              runRegistry,
              request,
              dependencies.provenance,
              dependencies.logger ?? log
            )
          return dependencies.withSessionMutation
            ? dependencies.withSessionMutation(claim.projectName, claim.sessionId, finalize)
            : finalize()
        })
      ),
    listProjectFiles: async (request) => {
      const files = await repository.listProjectArtifacts(request.projectName, inFlightRunIds())
      // A produced-but-never-published Version is absent from the compatibility listing. Show it anyway,
      // named for what it is, so "the run produced this file" and "this file became an artifact" cannot
      // be mistaken for each other. Without a Provenance authority there is nothing extra to add.
      if (!dependencies.provenance?.listUnpublishedProjectVersions) return files
      const unpublished = await dependencies.provenance.listUnpublishedProjectVersions(
        request.projectName
      )
      return [
        ...files,
        ...unpublished.map((version) => ({ ...version, publication: 'unpublished' as const }))
      ]
    },
    reconcilePendingArtifacts: (request) =>
      withDataRootWrite(() => repository.reconcilePendingArtifactPaths(request)),
    openFile: async (request) => {
      // Resolve through the repository first so shell.openPath never sees unmanaged locations.
      const versionIdentity = parseArtifactVersionLocator(request.path)
      const filePath = versionIdentity
        ? await dependencies.provenance
            ?.resolveVersionContent(versionIdentity)
            .then((resolved) => resolved.path)
        : await repository.resolveManagedFilePath(request)
      if (!filePath) throw new Error('Artifact Provenance is not configured.')
      const openError = await openPath(filePath)

      if (openError) {
        throw new Error(openError)
      }
    },
    readPreview: async (request) => {
      const versionIdentity = parseArtifactVersionLocator(request.path)
      if (!versionIdentity) return repository.readManagedFilePreview(request)
      if (!dependencies.provenance) throw new Error('Artifact Provenance is not configured.')
      const { path } = await dependencies.provenance.resolveVersionContent(versionIdentity)
      return readBoundedManagedFilePreview(path, request, 'Invalid artifact preview encoding.')
    },
    probeAvailability: async (request) => {
      const items = Array.isArray(request?.items) ? request.items : []
      // Valid entries first, then dedupe by path: a malformed duplicate must not evict a good one.
      const managedSources = new Set(['artifact', 'upload', 'notebook-input'])
      const valid = items.filter(
        (item): item is (typeof items)[number] =>
          typeof item?.path === 'string' &&
          item.path.length > 0 &&
          managedSources.has(item.source)
      )
      const unique = [...new Map(valid.map((item) => [item.path, item])).values()]
      if (unique.length > MAX_ARTIFACT_AVAILABILITY_PATHS) {
        throw new Error(`At most ${MAX_ARTIFACT_AVAILABILITY_PATHS} paths may be probed at once.`)
      }
      if (unique.length === 0) return { unavailable: [] }

      // File-system path per request path. Locators (what a transcript card carries) resolve for the whole
      // batch in one query and read nothing; managed paths are resolved by the existing path check, which
      // touches no database at all.
      const resolved = new Map<string, string>()
      const locatorsByProject = new Map<string, Array<{ path: string; versionId: string }>>()
      for (const item of unique) {
        const identity = parseArtifactVersionLocator(item.path)
        if (!identity) {
          try {
            resolved.set(item.path, await repository.resolveManagedFilePath({ path: item.path }))
          } catch {
            // Unresolvable is an answer, not an error: the caller is asking whether it exists.
          }
          continue
        }
        const bucket = locatorsByProject.get(identity.projectId) ?? []
        bucket.push({ path: item.path, versionId: identity.versionId })
        locatorsByProject.set(identity.projectId, bucket)
      }
      if (locatorsByProject.size > 0) {
        if (!dependencies.provenance?.resolveVersionPaths) {
          throw new Error('Artifact Provenance is not configured.')
        }
        for (const [projectId, entries] of locatorsByProject) {
          const paths = await dependencies.provenance.resolveVersionPaths({
            projectId,
            // Many cards can point at the same version; the id travels once.
            versionIds: [...new Set(entries.map((entry) => entry.versionId))]
          })
          for (const entry of entries) {
            const filePath = paths.get(entry.versionId)
            if (filePath) resolved.set(entry.path, filePath)
          }
        }
      }

      const missing = new Set<string>()
      await Promise.all(
        unique.map(async (item) => {
          const filePath = resolved.get(item.path)
          if (!filePath) {
            missing.add(item.path)
            return
          }
          const present = await stat(filePath)
            .then((stats) => stats.isFile())
            .catch(() => false)
          if (!present) missing.add(item.path)
        })
      )
      // Answered in the order they were asked, so a caller can map the result back position by position.
      return { unavailable: unique.map((item) => item.path).filter((path) => missing.has(path)) }
    },
    getLineage: (request) => {
      if (!dependencies.provenance) throw new Error('Artifact Provenance is not configured.')
      return dependencies.provenance.getLineage(request)
    },
    writeUserEditedVersion: (request) => {
      if (!dependencies.provenance) throw new Error('Artifact Provenance is not configured.')
      const write = (): Promise<ArtifactFile> =>
        dependencies.provenance!.writeUserEditedVersion(request)
      return dependencies.withSessionMutation
        ? dependencies.withSessionMutation(request.projectId, request.appSessionId, write)
        : write()
    },
    getVersionProvenance: (request) => {
      if (!dependencies.provenance) throw new Error('Artifact Provenance is not configured.')
      return dependencies.provenance.getVersionCore(request)
    },
    getVersionExecution: (request) => {
      if (!dependencies.provenance) throw new Error('Artifact Provenance is not configured.')
      return dependencies.provenance.getVersionExecution(request)
    },
    getVersionMessages: (request) => {
      if (!dependencies.provenance) throw new Error('Artifact Provenance is not configured.')
      return dependencies.provenance.getVersionMessages(request)
    },
    getVersionReview: (request) => {
      if (!dependencies.provenance) throw new Error('Artifact Provenance is not configured.')
      return dependencies.provenance.getVersionReview(request)
    },
    getCodeReconstruction: (request) => {
      if (!dependencies.codeReconstruction) {
        throw new Error('Artifact code reconstruction is not configured.')
      }
      return dependencies.codeReconstruction.get(request)
    },
    generateCodeReconstruction: (request) => {
      const codeReconstruction = dependencies.codeReconstruction
      if (!codeReconstruction) {
        throw new Error('Artifact code reconstruction is not configured.')
      }
      // Hold one migration lease across evidence reads, model work, and the cache commit so a data
      // root move cannot switch beneath an in-flight reconstruction.
      return withDataRootWrite(() => codeReconstruction.generate(request))
    },
    resolveVersionDescriptors: (request) => {
      if (!dependencies.provenance) throw new Error('Artifact Provenance is not configured.')
      return dependencies.provenance.resolveVersionDescriptors(request)
    },
    replayVersion: (request) => {
      if (!dependencies.replay) throw new Error('Artifact replay is not configured.')
      return dependencies.replay.replayVersion(request)
    }
  }
}

// Turns a runtime claim into message-owned files and permits idempotent replay for the same message.
const finalizeRunArtifacts = async (
  repository: ArtifactRepository,
  runRegistry: ArtifactRunRegistry,
  request: FinalizeRunArtifactsRequest,
  provenance?: Pick<ArtifactProvenanceRepository, 'finalizeRun'>,
  logger: Pick<Logger, 'error'> = log
): Promise<ArtifactFile[]> => {
  const claim = runRegistry.resolve(request.claimId)

  if (claim.finalizedMessageId) {
    // A retry for the same message should return the final list; a different message is a bug.
    if (claim.finalizedMessageId !== request.messageId) {
      throw new Error(
        `Artifact run claim already finalized for message: ${claim.finalizedMessageId}`
      )
    }

    return repository.listMessageFiles({
      projectName: claim.projectName,
      sessionId: claim.sessionId,
      messageId: request.messageId
    })
  }

  let durableFinalizationCompleted = false
  let compatibilityPublicationCompleted = false
  let stage: 'durable-finalization' | 'compatibility-publication' = 'durable-finalization'

  try {
    let provenanceArtifacts: ArtifactFile[] | undefined
    let provenanceRequest: Parameters<ArtifactProvenanceRepository['finalizeRun']>[0] | undefined
    if (provenance) {
      if (
        !claim.rootFrameId ||
        !claim.agentFrameId ||
        !claim.messageBranchId ||
        !claim.runtimeSegmentId ||
        !claim.promptMessageId
      ) {
        throw new ArtifactFinalizationProofError(
          'Artifact run claim is missing complete provenance context.'
        )
      }
      if (!claim.artifactVersionIds || claim.artifactVersionIds.length === 0) {
        throw new ArtifactFinalizationProofError(
          'Artifact run claim is missing exact Artifact Version ids.'
        )
      }
      provenanceRequest = {
        projectId: claim.projectName,
        appSessionId: claim.sessionId,
        artifactRunId: claim.runId,
        artifactVersionIds: [...claim.artifactVersionIds],
        rootFrameId: claim.rootFrameId,
        agentFrameId: claim.agentFrameId,
        messageBranchId: claim.messageBranchId,
        runtimeSegmentId: claim.runtimeSegmentId,
        promptMessageId: claim.promptMessageId,
        messageId: request.messageId
      }
      // Commit the complete provenance proof and immutable message ownership before compatibility bytes
      // move. A later compatibility failure is retryable because the prepared marker remains durable.
      provenanceArtifacts = await provenance.finalizeRun(provenanceRequest)
      durableFinalizationCompleted = true
    }

    stage = 'compatibility-publication'
    // Publish compatibility bytes only after the complete provenance transaction succeeds. The move is
    // idempotent, so a finalized-but-unlinked run can replay here or during prepared-marker recovery.
    const artifacts = await repository.finalizeRunArtifacts({
      projectName: claim.projectName,
      sourceSessionId: claim.artifactSessionId,
      sessionId: claim.sessionId,
      runId: claim.runId,
      messageId: request.messageId,
      ...(claim.artifactVersionIds ? { artifactVersionIds: claim.artifactVersionIds } : {}),
      ...(claim.rootFrameId &&
      claim.agentFrameId &&
      claim.messageBranchId &&
      claim.runtimeSegmentId &&
      claim.promptMessageId
        ? {
            provenanceContext: {
              rootFrameId: claim.rootFrameId,
              agentFrameId: claim.agentFrameId,
              messageBranchId: claim.messageBranchId,
              runtimeSegmentId: claim.runtimeSegmentId,
              promptMessageId: claim.promptMessageId
            }
          }
        : {})
    })
    compatibilityPublicationCompleted = true

    runRegistry.markFinalized(request.claimId, request.messageId)

    return provenanceArtifacts ?? artifacts
  } catch (error) {
    const failureKind =
      error instanceof ArtifactOwnershipPersistenceRaceError
        ? ARTIFACT_OWNERSHIP_PERSISTENCE_RACE
        : error instanceof ArtifactFinalizationProofError
          ? 'invalid-proof'
          : 'operational-failure'
    logger.error('artifact finalization attempt failed', {
      stage,
      failureKind,
      durableFinalizationCompleted,
      compatibilityPublicationCompleted,
      claimId: request.claimId,
      artifactRunId: claim.runId,
      messageId: request.messageId,
      ...(claim.artifactVersionIds ? { artifactVersionIds: [...claim.artifactVersionIds] } : {}),
      ...(claim.rootFrameId ? { rootFrameId: claim.rootFrameId } : {}),
      ...(claim.agentFrameId ? { agentFrameId: claim.agentFrameId } : {}),
      ...(claim.messageBranchId ? { messageBranchId: claim.messageBranchId } : {}),
      ...(claim.runtimeSegmentId ? { runtimeSegmentId: claim.runtimeSegmentId } : {}),
      ...(claim.promptMessageId ? { promptMessageId: claim.promptMessageId } : {})
    })
    throw error
  }
}

// Artifacts are data-class: they follow the configurable data root (defaults to the config root).
const createDefaultArtifactRepository = (): ArtifactRepository =>
  new ArtifactRepository(resolveDataRoot())

// Registers the renderer-visible artifact commands without exposing internal message-file listing.
const registerArtifactIpcHandlers = (
  repository = createDefaultArtifactRepository(),
  runRegistry = new ArtifactRunRegistry(),
  getActiveArtifactRunIds?: () => string[],
  provenance?: Pick<
    ArtifactProvenanceRepository,
    | 'finalizeRun'
    | 'getLineage'
    | 'writeUserEditedVersion'
    | 'getVersionProvenance'
    | 'getVersionCore'
    | 'getVersionExecution'
    | 'getVersionMessages'
    | 'getVersionReview'
    | 'resolveVersionDescriptors'
    | 'resolveVersionContent'
    | 'resolveVersionPaths'
    | 'listUnpublishedProjectVersions'
  >,
  withSessionMutation?: ArtifactHandlerDependencies['withSessionMutation'],
  handlers: ArtifactHandlers = createArtifactHandlers(repository, runRegistry, {
    getActiveArtifactRunIds,
    provenance,
    withSessionMutation
  })
): void => {
  ipcMainHandle(
    'artifacts:finalize-run',
    async (_event, request: FinalizeRunArtifactsRequest): Promise<FinalizeRunArtifactsResult> => {
      try {
        return { ok: true, artifacts: await handlers.finalizeRunArtifacts(request) }
      } catch (error) {
        if (!(error instanceof ArtifactOwnershipPersistenceRaceError)) throw error
        return {
          ok: false,
          code: ARTIFACT_OWNERSHIP_PERSISTENCE_RACE,
          message: error.message
        }
      }
    }
  )
  ipcMainHandle('artifacts:list-project-files', (_event, request: ListProjectArtifactsRequest) =>
    handlers.listProjectFiles(request)
  )
  ipcMainHandle(
    'artifacts:reconcile-pending',
    (_event, request: ReconcilePendingArtifactsRequest) =>
      handlers.reconcilePendingArtifacts(request)
  )
  ipcMainHandle('artifacts:open-file', (_event, request: OpenArtifactFileRequest) =>
    handlers.openFile(request)
  )
  ipcMainHandle(
    'artifacts:write-user-edited-version',
    (_event, request: WriteUserEditedVersionRequest) => handlers.writeUserEditedVersion(request)
  )
  ipcMainHandle('artifacts:read-preview', (_event, request: ReadArtifactPreviewRequest) =>
    handlers.readPreview(request)
  )
  ipcMainHandle(
    'artifacts:probe-availability',
    (_event, request: ProbeArtifactAvailabilityRequest) => handlers.probeAvailability(request)
  )
  ipcMainHandle('artifacts:get-lineage', (_event, request: GetArtifactLineageRequest) =>
    handlers.getLineage(request)
  )
  ipcMainHandle(
    'artifacts:get-version-provenance',
    (_event, request: GetArtifactVersionProvenanceRequest) => handlers.getVersionProvenance(request)
  )
  ipcMainHandle(
    'artifacts:get-version-execution',
    (_event, request: GetArtifactVersionProvenanceRequest) => handlers.getVersionExecution(request)
  )
  ipcMainHandle(
    'artifacts:get-version-messages',
    (_event, request: GetArtifactVersionProvenanceRequest) => handlers.getVersionMessages(request)
  )
  ipcMainHandle(
    'artifacts:get-version-review',
    (_event, request: GetArtifactVersionProvenanceRequest) => handlers.getVersionReview(request)
  )
  ipcMainHandle(
    'artifacts:get-code-reconstruction',
    (_event, request: GetArtifactCodeReconstructionRequest) =>
      handlers.getCodeReconstruction(request)
  )
  ipcMainHandle(
    'artifacts:generate-code-reconstruction',
    (_event, request: GenerateArtifactCodeReconstructionRequest) =>
      handlers.generateCodeReconstruction(request)
  )
  ipcMainHandle(
    'artifacts:resolve-version-descriptors',
    (_event, request: ResolveArtifactVersionDescriptorsRequest) =>
      handlers.resolveVersionDescriptors(request)
  )
  ipcMainHandle('artifacts:replay-version', (_event, request: ReplayVersionRequest) =>
    handlers.replayVersion(request)
  )
}

export { createArtifactHandlers, createDefaultArtifactRepository, registerArtifactIpcHandlers }
export type { ArtifactHandlers }
