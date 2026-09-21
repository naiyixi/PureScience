import { ipcMainHandle } from '../ipc-handler-registry'

import type { SessionCatalogResult } from '../../shared/session-catalog-summary'
import type {
  DeleteSessionRequest,
  LoadAllSessionsOptions,
  LoadAllSessionsResult,
  PersistedChatSession,
  SaveSessionOptions,
  ReadSessionDocumentRequest,
  SaveSessionManifestRequest,
  UpdateSessionArchiveRequest,
  SessionLoadDiagnostics
} from '../../shared/session-persistence'
import { LIFECYCLE_CHANNELS } from '../../shared/lifecycle-events'
import { broadcastLifecycleEvent, getLifecycleClientId } from '../lifecycle-broadcast'
import { createLogger, diagnosticErrorFields, type Logger } from '../logger'
import { resolveStorageRoot } from '../storage-root'
import { SessionRepository } from './repository'
import { ReviewRepository } from '../reviewer/repository'
import { getProjectDbClient } from '../projects/prisma-client'
import { withDataRootWrite } from '../storage/migration-state'
import type { SessionMetadataSnapshot } from './coordinator'

type SessionPersistenceBackend = {
  loadAll: (options?: LoadAllSessionsOptions) => Promise<LoadAllSessionsResult>
  // The list tier: identity and metadata for every session, answered from the on-disk index.
  loadCatalog: () => Promise<SessionCatalogResult>
  saveSession: (
    session: PersistedChatSession,
    options?: SaveSessionOptions
  ) => Promise<{ created: boolean; session: PersistedChatSession }>
  updateArchive?: (request: UpdateSessionArchiveRequest) => Promise<PersistedChatSession>
  deleteSession: (projectId: string, sessionId: string) => Promise<void>
  saveManifest: (request: SaveSessionManifestRequest) => Promise<void>
}

type SessionPersistenceHandlers = {
  loadAll: (options?: LoadAllSessionsOptions) => Promise<LoadAllSessionsResult>
  // The list tier: identity and metadata only, no active-Branch content, plus the last-open pointer.
  listCatalog: () => Promise<SessionCatalogResult>
  // The document tier: one session, straight from its own file, for a reader that needs its content.
  readDocument: (projectId: string, sessionId: string) => Promise<PersistedChatSession | undefined>
  saveSession: (
    session: PersistedChatSession,
    options?: SaveSessionOptions
  ) => Promise<{ created: boolean; session: PersistedChatSession }>
  updateArchive: (request: UpdateSessionArchiveRequest) => Promise<PersistedChatSession>
  deleteSession: (request: DeleteSessionRequest) => Promise<void>
  saveManifest: (request: SaveSessionManifestRequest) => Promise<void>
}

type ProjectDeletionRecoveryBackend = {
  recoverPendingDeletions: () => Promise<void>
}

type SessionStartupLoader = {
  loadAll: (options?: LoadAllSessionsOptions) => Promise<LoadAllSessionsResult>
  loadAllReadOnly: () => Promise<LoadAllSessionsResult>
}

type SessionMetadataLoader = {
  sessionMetadataSnapshot: () => Promise<SessionMetadataSnapshot>
}

type SessionCatalogLoader = {
  loadCatalog: () => Promise<SessionCatalogResult>
}

// One session, read straight from its own file. The list tier deliberately does not carry the active
// Branch's content, so a reader that needs it asks for exactly the session it is looking at instead of
// every session in the corpus.
type SessionDocumentLoader = {
  loadSession: (projectId: string, sessionId: string) => Promise<PersistedChatSession | undefined>
}

const withProjectDeletionRecoveryStatus = <Result extends { diagnostics?: SessionLoadDiagnostics }>(
  result: Result,
  isProjectDeletionRecoveryComplete: boolean
): Result => ({
  ...result,
  diagnostics: {
    isComplete: result.diagnostics?.isComplete ?? true,
    warnings: result.diagnostics?.warnings ?? [],
    ...result.diagnostics,
    isProjectDeletionRecoveryComplete
  }
})

// Cached metadata must not overtake queued Project deletion work. Let recovery failures reject so
// Permissions reports the Session store as incomplete instead of publishing stale navigation labels.
const loadSessionMetadataAfterProjectRecovery = async (
  projectRecovery: ProjectDeletionRecoveryBackend,
  sessionLoader: SessionMetadataLoader
): Promise<SessionMetadataSnapshot> => {
  await projectRecovery.recoverPendingDeletions()
  return sessionLoader.sessionMetadataSnapshot()
}

// Project deletion recovery is a prerequisite for mutating startup reconciliation. If it fails,
// expose only the coordinator's explicit read-only snapshot so healthy transcripts remain navigable
// without allowing partially recovered Project authority to drive cleanup or derived-state writes.
const loadSessionsAfterProjectRecovery = async (
  projectRecovery: ProjectDeletionRecoveryBackend,
  sessionLoader: SessionStartupLoader,
  options: LoadAllSessionsOptions = {},
  log: Pick<Logger, 'warn'> = createLogger('session-persistence')
): Promise<LoadAllSessionsResult> => {
  try {
    await projectRecovery.recoverPendingDeletions()
  } catch (error) {
    try {
      log.warn('project deletion recovery failed', {
        operation: 'session-hydration',
        phase: 'recover-project-deletions',
        outcome: 'degraded',
        ...diagnosticErrorFields(error)
      })
    } catch {
      // Diagnostics must never prevent the explicit read-only recovery path.
    }
    return withProjectDeletionRecoveryStatus(await sessionLoader.loadAllReadOnly(), false)
  }

  return withProjectDeletionRecoveryStatus(await sessionLoader.loadAll(options), true)
}

// The list tier's counterpart. Project deletion recovery is the same prerequisite (a Session list must
// not present rows whose owning Project is mid-deletion), but the read itself is the catalog scan, so
// the fallback when recovery fails is that same scan rather than a parse-everything load: it still
// reports the Sessions it can see, and it never mutates authority.
const loadCatalogAfterProjectRecovery = async (
  projectRecovery: ProjectDeletionRecoveryBackend,
  sessionLoader: SessionCatalogLoader,
  log: Pick<Logger, 'warn'> = createLogger('session-persistence')
): Promise<SessionCatalogResult> => {
  // The list tier reports the same prerequisite the full load reports: the renderer gates deleting a
  // project or a session on it, so a recovery it cannot see is a capability the user loses silently.
  let recoveryComplete = true
  try {
    await projectRecovery.recoverPendingDeletions()
  } catch (error) {
    recoveryComplete = false
    try {
      log.warn('project deletion recovery failed', {
        operation: 'session-catalog',
        phase: 'recover-project-deletions',
        outcome: 'degraded',
        ...diagnosticErrorFields(error)
      })
    } catch {
      // Diagnostics must never prevent the catalog read.
    }
  }

  return withProjectDeletionRecoveryStatus(await sessionLoader.loadCatalog(), recoveryComplete)
}

// Adapts the coordinator into small handlers that are easy to unit test.
const createSessionPersistenceHandlers = (
  repository: SessionPersistenceBackend,
  reviewRepository: ReviewRepository,
  documents: SessionDocumentLoader
): SessionPersistenceHandlers => {
  // Kept as an injected boundary for project-level cleanup compatibility; session deletion must not
  // call it because Reviews belong to retained provenance.
  void reviewRepository
  return {
    // The options are forwarded, not dropped: this wrapper is where the caller's explicit opt-in to a
    // cached catalog used to disappear (measured on the live instance — the coordinator saw `flag=undefined`
    // while the cache was warm, so every request still paid the full load).
    loadAll: (options) => repository.loadAll(options),
    saveSession: (session, options) =>
      options ? repository.saveSession(session, options) : repository.saveSession(session),
    updateArchive: (request) => {
      if (!repository.updateArchive) throw new Error('Session archive is unavailable.')
      return repository.updateArchive(request)
    },
    // A session delete tombstones its origin graph but deliberately retains Review rows, findings and
    // scope snapshots. Provenance remains readable from Files; project deletion owns final cleanup.
    deleteSession: (request) => repository.deleteSession(request.projectId, request.sessionId),
    saveManifest: (request) => repository.saveManifest(request),
    // No cache opt-in here: this is the path that decides what the user sees, and it must not serve a
    // catalog that is even a second old. It is cheap without a cache because the scan is answered from
    // the on-disk index: it walks the tree and parses only the sessions that actually changed.
    // The projection is the repository's, so nothing here has to rebuild it from messages the list
    // deliberately does not carry.
    listCatalog: () => repository.loadCatalog(),
    readDocument: (projectId, sessionId) => documents.loadSession(projectId, sessionId)
  }
}

// Creates the production repository rooted at the (dev-aware) storage root.
const createDefaultSessionRepository = (): SessionRepository =>
  new SessionRepository(resolveStorageRoot())

// The document tier's default source: the same repository, read one session at a time.
const createDefaultSessionDocumentLoader = (): SessionDocumentLoader => {
  const repository = createDefaultSessionRepository()
  return {
    loadSession: (projectId, sessionId) => repository.loadSession(projectId, sessionId)
  }
}

const createDefaultReviewRepository = (): ReviewRepository =>
  new ReviewRepository(() => getProjectDbClient(resolveStorageRoot()))

// Registers renderer-callable persistence commands without coupling them to ACP runtime IPC.
const registerSessionPersistenceIpcHandlers = (
  repository: SessionPersistenceBackend,
  reviewRepository = createDefaultReviewRepository(),
  documents: SessionDocumentLoader = createDefaultSessionDocumentLoader(),
  handlers: SessionPersistenceHandlers = createSessionPersistenceHandlers(
    repository,
    reviewRepository,
    documents
  ),
  // The list tier has to report the same project-deletion prerequisite the full load reports: the renderer
  // gates deleting a project or a session on it, and the catalog path is the one it actually reads.
  projectRecovery?: ProjectDeletionRecoveryBackend
): void => {
  // Keep persistence IPC separate from ACP runtime commands; it owns durable UI state only.
  // loadAll can replay pending deletions and every mutation can materialize provenance/upload bytes.
  // Hold the shared data-root lease at the IPC boundary so migration drains the complete operation.
  ipcMainHandle('sessions:load-all', (_event, options?: LoadAllSessionsOptions) =>
    withDataRootWrite(() => handlers.loadAll(options))
  )
  ipcMainHandle(
    'sessions:save-session',
    async (event, session: PersistedChatSession, options?: SaveSessionOptions) => {
      const originClientId = getLifecycleClientId(event)
      return withDataRootWrite(async () => {
        const result = await handlers.saveSession(session, options)
        broadcastLifecycleEvent(
          result.created ? LIFECYCLE_CHANNELS.sessionCreated : LIFECYCLE_CHANNELS.sessionUpdated,
          {
            session: result.session,
            originClientId
          }
        )
        return result.session
      })
    }
  )
  ipcMainHandle('sessions:update-archive', async (event, request: UpdateSessionArchiveRequest) => {
    const originClientId = getLifecycleClientId(event)
    return withDataRootWrite(async () => {
      const session = await handlers.updateArchive(request)
      broadcastLifecycleEvent(LIFECYCLE_CHANNELS.sessionUpdated, { session, originClientId })
      return session
    })
  })
  ipcMainHandle('sessions:delete-session', async (_event, request: DeleteSessionRequest) => {
    await withDataRootWrite(async () => {
      await handlers.deleteSession(request)
      broadcastLifecycleEvent(LIFECYCLE_CHANNELS.sessionDeleted, request)
    })
  })
  ipcMainHandle('sessions:save-manifest', (_event, request: SaveSessionManifestRequest) =>
    withDataRootWrite(() => handlers.saveManifest(request))
  )
  // Read-only additions for the list/document split. Both hold the shared data-root lease for the same
  // reason the other reads do: a read must not race a migration moving the root underneath it.
  ipcMainHandle('sessions:list-catalog', () =>
    withDataRootWrite(() =>
      projectRecovery
        ? loadCatalogAfterProjectRecovery(projectRecovery, {
            loadCatalog: () => handlers.listCatalog()
          })
        : handlers.listCatalog()
    )
  )
  ipcMainHandle('sessions:read-document', (_event, request: ReadSessionDocumentRequest) =>
    withDataRootWrite(() => handlers.readDocument(request.projectId, request.sessionId))
  )
}

export {
  createDefaultReviewRepository,
  createDefaultSessionRepository,
  createSessionPersistenceHandlers,
  loadCatalogAfterProjectRecovery,
  loadSessionMetadataAfterProjectRecovery,
  loadSessionsAfterProjectRecovery,
  registerSessionPersistenceIpcHandlers
}
export type { SessionDocumentLoader, SessionPersistenceBackend, SessionPersistenceHandlers }
