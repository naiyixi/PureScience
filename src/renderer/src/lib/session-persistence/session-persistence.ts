import { useCallback, useEffect, useRef, useState } from 'react'

import type { ArtifactFile, ReconcilePendingArtifactsRequest } from '../../../../shared/artifacts'
import type {
  DeleteSessionRequest,
  LoadAllSessionsResult,
  PersistedChatSession,
  ReadSessionDocumentRequest,
  SaveSessionOptions,
  SessionConflictRebaseField,
  SaveSessionManifestRequest
} from '../../../../shared/session-persistence'
import { SESSION_MANIFEST_VERSION } from '../../../../shared/session-persistence'
import { PENDING_UPLOAD_SESSION_ID } from '../../../../shared/uploads'
import type { SessionCatalogResult } from '../../../../shared/session-catalog-summary'
import {
  isExternallyHydratedSession,
  isSummaryOnlySession,
  markSummaryOnlySession,
  toPersistedSession,
  useSessionStore
} from '../../stores/session-store'
import type { ChatSession, SessionHydrationSelection } from '../../stores/session-store'

type SessionPersistenceApi = {
  loadAll: () => Promise<LoadAllSessionsResult>
  // The list tier. Optional so a bridge without it keeps the old behaviour instead of failing outright; the
  // app's own bridge provides it.
  listCatalog?: () => Promise<SessionCatalogResult>
  // The document tier. Present on the real bridge; a caller that needs one session's content asks for it by
  // name instead of holding every session's content in memory.
  readDocument: (request: ReadSessionDocumentRequest) => Promise<PersistedChatSession | undefined>
  saveSession: (
    session: PersistedChatSession,
    options?: SaveSessionOptions
  ) => Promise<PersistedChatSession>
  deleteSession: (request: DeleteSessionRequest) => Promise<void>
  saveManifest: (request: SaveSessionManifestRequest) => Promise<void>
}

type LatestSessionSaveTask = (options?: SaveSessionOptions) => Promise<PersistedChatSession>

// A streamed reply reaches the store as dozens of snapshots per turn, and each snapshot became one durable
// write plus a whole-session echo back to this window: measured at 19–29 writes and 178–374KB of session
// payload per 40-chunk turn. The queue below only collapsed a snapshot that arrived while the previous
// write was still in flight, and a local write finishes far faster than the chunk cadence, so nearly every
// snapshot got its own write. Holding a superseded snapshot for this long keeps the newest state without
// paying a write (and its echo) per chunk; the delay is a fraction of what a user could notice as lost
// work if the app died, and recorded turns are flushed by the forced path, which never goes through here.
const LATEST_SAVE_COALESCE_MS = 350

type HeldLatestSave = {
  target: string
  task: LatestSessionSaveTask
  options: SaveSessionOptions | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  resolve: (session: PersistedChatSession) => void
  reject: (error: unknown) => void
}

type OrderedSessionPersistence = Pick<SessionPersistenceApi, 'saveSession' | 'saveManifest'> & {
  saveLatestSession: (
    target: string,
    task: LatestSessionSaveTask,
    options?: SaveSessionOptions
  ) => Promise<PersistedChatSession>
  flush: () => Promise<void>
}

const SESSION_CONFLICT_REBASE_FIELDS = [
  'title',
  'permissionProfile',
  'autoReviewEnabled',
  'delegationEnabled',
  'enabledComputeHosts',
  'pinned',
  'specialistId'
] as const satisfies readonly SessionConflictRebaseField[]

const conflictRebaseFieldChanged = (
  previous: ChatSession,
  next: ChatSession,
  field: SessionConflictRebaseField
): boolean => {
  if (field !== 'enabledComputeHosts') return previous[field] !== next[field]
  const previousHosts = previous.enabledComputeHosts ?? []
  const nextHosts = next.enabledComputeHosts ?? []
  return (
    previousHosts.length !== nextHosts.length ||
    previousHosts.some((host, index) => host !== nextHosts[index])
  )
}

const mergeSaveSessionOptions = (
  previous: SaveSessionOptions | undefined,
  next: SaveSessionOptions | undefined
): SaveSessionOptions | undefined => {
  const conflictRebaseFields = [
    ...new Set([...(previous?.conflictRebaseFields ?? []), ...(next?.conflictRebaseFields ?? [])])
  ]
  return conflictRebaseFields.length > 0 ? { conflictRebaseFields } : undefined
}

// Serializes every renderer-originated Session write through one ordering seam. Store snapshots at
// the queue tail use latest-wins coalescing; explicit Session and Manifest writes remain barriers, so
// Artifact finalization cannot be overtaken by an older store snapshot.
const createOrderedSessionPersistence = (
  api: Pick<SessionPersistenceApi, 'saveSession' | 'saveManifest'>
): OrderedSessionPersistence => {
  let queue: Promise<unknown> = Promise.resolve()
  let held: HeldLatestSave | undefined
  let heldPromise: Promise<PersistedChatSession> | undefined
  const lastWriteAt = new Map<string, number>()

  // Runs one held snapshot in queue order. The promise handed to the caller resolves here (or here with the
  // error), so holding a snapshot delays its durability report but never strands an awaiter.
  const startWrite = (entry: HeldLatestSave): void => {
    const run = queue.then(
      () => entry.task(entry.options),
      () => entry.task(entry.options)
    )
    queue = run.then(
      () => undefined,
      () => undefined
    )
    run.then(
      (result) => {
        lastWriteAt.set(entry.target, Date.now())
        entry.resolve(result)
      },
      (error: unknown) => entry.reject(error)
    )
  }

  // A held snapshot is already the newest state for its target, so anything that must not be overtaken (an
  // explicit write, a manifest barrier, a flush) releases it first instead of dropping it: dropping would
  // both strand the caller's promise and lose the newest snapshot.
  const releaseHeld = (): void => {
    const entry = held
    if (!entry) return
    held = undefined
    heldPromise = undefined
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    startWrite(entry)
  }

  const enqueue = <Result>(task: () => Promise<Result>): Promise<Result> => {
    releaseHeld()
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  const saveLatestSession = (
    target: string,
    task: LatestSessionSaveTask,
    options?: SaveSessionOptions
  ): Promise<PersistedChatSession> => {
    // A snapshot arriving while one for the same target waits replaces it — the newest state wins, and the
    // callers of both snapshots share the one write.
    if (held?.target === target && heldPromise) {
      held.task = task
      held.options = mergeSaveSessionOptions(held.options, options)
      return heldPromise
    }

    let resolveEntry: (session: PersistedChatSession) => void = () => undefined
    let rejectEntry: (error: unknown) => void = () => undefined
    const promise = new Promise<PersistedChatSession>((resolve, reject) => {
      resolveEntry = resolve
      rejectEntry = reject
    })
    // The hold only applies to a snapshot that follows another write for the same target: an isolated save
    // (a rename, the first chunk of a turn, a resumed session) keeps its prompt write and its prompt
    // resolution, and the coalescing window is measured from when the previous write started, so a snapshot
    // arriving while that write is still in flight is held too.
    const previousWriteAt = lastWriteAt.get(target)
    const delay =
      previousWriteAt === undefined
        ? 0
        : Math.max(0, previousWriteAt + LATEST_SAVE_COALESCE_MS - Date.now())
    const entry: HeldLatestSave = {
      target,
      task,
      options,
      timer: undefined,
      resolve: resolveEntry,
      reject: rejectEntry
    }
    lastWriteAt.set(target, Date.now())
    if (delay === 0) {
      startWrite(entry)
      return promise
    }

    entry.timer = setTimeout(() => {
      if (held === entry) releaseHeld()
    }, delay)
    held = entry
    heldPromise = promise
    return promise
  }

  return {
    saveLatestSession,
    saveSession: (session, options) =>
      enqueue(() => (options ? api.saveSession(session, options) : api.saveSession(session))),
    saveManifest: (request) => enqueue(() => api.saveManifest(request)),
    // A flush is the barrier callers use before quitting or reloading, so it writes the held snapshot rather
    // than waiting out the coalescing window.
    flush: () => {
      releaseHeld()
      return queue.then(() => undefined)
    }
  }
}

// The Store saver and Artifact finalization share this instance in production. Its adapters resolve
// window.api lazily, keeping module import safe in tests before the preload bridge is installed.
const liveSessionPersistence = createOrderedSessionPersistence({
  saveSession: (session, options) =>
    options
      ? window.api.sessions.saveSession(session, options)
      : window.api.sessions.saveSession(session),
  saveManifest: (request) => window.api.sessions.saveManifest(request)
})

const saveSessionInOrder = (session: PersistedChatSession): Promise<PersistedChatSession> =>
  liveSessionPersistence.saveSession(session)

const flushSessionPersistence = (): Promise<void> => liveSessionPersistence.flush()

// The one artifact command startup reconciliation needs; kept narrow so it is trivial to fake in tests.
type ArtifactReconcileApi = {
  reconcilePendingArtifacts: (request: ReconcilePendingArtifactsRequest) => Promise<ArtifactFile[]>
}

// A crash between persisting a pending artifact reference and finalizing it strands the file in
// `.pending/<run>/`. The path segment is stable across OSes, so detect it structurally.
const isPendingArtifactPath = (path: string | undefined): path is string =>
  typeof path === 'string' && path.split(/[\\/]/).includes('.pending')

// Re-finalizes artifacts a prior crash left in `.pending` after the in-memory finalize claim was lost.
// For each hydrated message still referencing a pending path, ask the main process to complete the
// move (idempotent) and replace the message's stale references with the finalized files. Runs once at
// startup after the store saver is subscribed, so each replacement is persisted. Per-message failures
// are isolated and never block the rest; an empty result leaves references untouched so a file still
// readable at its pending path is never dropped.
const reconcilePendingArtifacts = async (api: ArtifactReconcileApi): Promise<void> => {
  for (const session of useSessionStore.getState().sessions) {
    if (session.isPending || !session.projectId) continue

    const artifactsById = new Map(
      (session.artifacts ?? []).map((artifact) => [artifact.id, artifact])
    )

    for (const message of session.messages) {
      const pendingPaths = (message.artifactIds ?? [])
        .map((id) => artifactsById.get(id)?.path)
        .filter(isPendingArtifactPath)

      if (pendingPaths.length === 0) continue

      try {
        const finalized = await api.reconcilePendingArtifacts({
          projectName: session.projectId,
          sessionId: session.id,
          messageId: message.id,
          pendingPaths
        })

        if (finalized.length > 0) {
          useSessionStore.getState().replaceMessageArtifacts({
            sessionId: session.id,
            messageId: message.id,
            artifacts: finalized
          })
        }
      } catch (error) {
        reportPersistenceError(error)
      }
    }
  }
}

type SessionStoreSnapshot = {
  sessions: ChatSession[]
  selectedSessionId: string | undefined
}

type SessionPersistenceState = {
  isHydrated: boolean
  isLoading: boolean
  isReady: boolean
  hasCompleteSessionCatalog: boolean
  canDeleteSessionsAndProjects: boolean
  loadError: string | undefined
  loadWarning: string | undefined
  writeError: string | undefined
  dismissLoadWarning: () => void
  retryLoad: () => void
  retryWrites: () => void
}

type StoreSaverOptions = {
  forceTargets?: ReadonlySet<string>
  conflictRebaseFieldsByTarget?: ReadonlyMap<string, readonly SessionConflictRebaseField[]>
}

type StoreSaverFailureContext = {
  conflictRebaseFields?: readonly SessionConflictRebaseField[]
}

type StoreSaverObserver = {
  onFailure?: (target: string, error: unknown, context: StoreSaverFailureContext) => void
  onSuccess?: (target: string) => void
}

type StoreSaver = (state: SessionStoreSnapshot, options?: StoreSaverOptions) => Promise<unknown>

const pruneRemovedSessionWriteTargets = (
  targets: Set<string>,
  sessions: readonly Pick<ChatSession, 'id'>[],
  conflictRebaseFields?: Map<string, SessionConflictRebaseField[]>
): void => {
  const activeSessionTargets = new Set(sessions.map((session) => `session:${session.id}`))
  for (const target of targets) {
    if (target.startsWith('session:') && !activeSessionTargets.has(target)) {
      targets.delete(target)
      conflictRebaseFields?.delete(target)
    }
  }
}

// Retains full diagnostics in the console while the hook exposes renderer-safe recovery state.
const reportPersistenceError = (error: unknown): void => {
  console.warn('Session persistence failed', error)
}

const SAFE_SESSION_LOAD_ERROR =
  'PureScience could not read saved conversation data. Retry to continue.'
const SAFE_SESSION_WRITE_ERROR =
  'PureScience could not save the latest conversation changes. Retry before closing the app.'

// Hydrates the in-memory session store from the per-session files loaded by the main process.
const loadPersistedSessions = async (
  api: SessionPersistenceApi,
  shouldHydrate: () => boolean = () => true,
  preferredSelection?: SessionHydrationSelection
): Promise<LoadAllSessionsResult | undefined> => {
  // The list tier: every session's identity and metadata, none of the active Branch's content. The document
  // for the session the user is actually looking at is read straight after, so nothing but that one session's
  // content is ever in the store — this is what takes the hydration payload from 55 MB to its metadata.
  const catalog = api.listCatalog ? await api.listCatalog() : undefined
  const loaded = catalog
    ? {
        sessions: catalog.sessions.map(
          (summary) => ({ ...summary, messages: [] }) as PersistedChatSession
        ),
        manifest: catalog.manifest
      }
    : await api.loadAll()
  if (!shouldHydrate()) return undefined

  // Retry captures live navigation as an explicit tri-state. If the user had no selection, or the
  // selected Session disappeared before recovery completed, do not replay a stale disk manifest or
  // fall through to the globally newest Session from another Project. Passing the selection into
  // hydration applies the sessions and selection atomically for all Zustand subscribers.
  useSessionStore.getState().hydrateSessions(loaded.sessions, loaded.manifest, preferredSelection)

  if (!catalog) return loaded as LoadAllSessionsResult

  // Mark what the store is holding as summaries, then fetch the one session whose content the reader needs.
  // Marking is what makes the guard apply: without it a later save would write a summary over its document.
  for (const session of useSessionStore.getState().sessions) {
    markSummaryOnlySession(session)
  }
  const selection = preferredSelection?.sessionId ?? useSessionStore.getState().selectedSessionId
  const toLoad = useSessionStore.getState().sessions.find((session) => session.id === selection)
  if (toLoad) await sessionDocumentLoaderFor(api).load(toLoad.id)

  return {
    sessions: loaded.sessions,
    manifest: loaded.manifest ?? { version: SESSION_MANIFEST_VERSION },
    // The list tier reports the load diagnostics too, and the deletion gate reads exactly this field:
    // rebuilding the result without them is what kept Delete disabled however healthy the store was.
    ...(catalog.diagnostics ? { diagnostics: catalog.diagnostics } : {})
  } as LoadAllSessionsResult
}

// Reads one session's document on demand and puts it into the store, replacing the summary it was holding.
//
// This is the other half of the list/document split: the list arrives as summaries for every session, and a
// reader that needs the content asks for the one session it is looking at. Two things make it safe rather than
// merely convenient — a read that returns nothing is treated as a failure, never as an empty conversation, and
// a failed read leaves the session marked as a summary so the guard keeps refusing to write it.
export type SessionDocumentLoadOutcome = 'loaded' | 'not-a-summary' | 'unknown-session' | 'failed'

export type SessionDocumentLoader = {
  load: (sessionId: string) => Promise<SessionDocumentLoadOutcome>
}

// One loader per bridge. Hydration and the selection effect both ask; if each built its own loader, their
// in-flight de-duplication would not see each other and the same document would be read twice at startup —
// which is exactly what the render-level case caught.
const loaders = new WeakMap<object, SessionDocumentLoader>()

const sessionDocumentLoaderFor = (api: SessionPersistenceApi): SessionDocumentLoader => {
  const existing = loaders.get(api)
  if (existing) return existing
  const created = createSessionDocumentLoader(api)
  loaders.set(api, created)
  return created
}

const createSessionDocumentLoader = (api: SessionPersistenceApi): SessionDocumentLoader => {
  // A session can be asked for twice before the first read lands (selection plus an explicit request). One
  // read serves both instead of two racing each other into the store.
  const inFlight = new Map<string, Promise<SessionDocumentLoadOutcome>>()

  const load = (sessionId: string): Promise<SessionDocumentLoadOutcome> => {
    const existing = inFlight.get(sessionId)
    if (existing) return existing

    const task = (async (): Promise<SessionDocumentLoadOutcome> => {
      const summary = useSessionStore
        .getState()
        .sessions.find((session) => session.id === sessionId)
      if (!summary) return 'unknown-session'
      if (!isSummaryOnlySession(summary)) return 'not-a-summary'
      if (!summary.projectId) return 'unknown-session'

      try {
        const document = await api.readDocument({
          projectId: summary.projectId,
          sessionId
        })
        if (!document) return 'failed'
        useSessionStore.getState().applySessionDocument(document)
        return 'loaded'
      } catch {
        return 'failed'
      }
    })()

    inFlight.set(sessionId, task)
    void task.finally(() => inFlight.delete(sessionId))
    return task
  }

  return { load }
}

// Indexes sessions by id for reference-equality diffing between store snapshots.
const indexById = (sessions: ChatSession[]): Map<string, ChatSession> =>
  new Map(sessions.map((session) => [session.id, session]))

// Upload publication owns the staged path -> immutable Version transition. Saving between append and
// finalize would race the main-process legacy upgrader and could publish the same bytes twice, so the
// bridge waits for every pending attachment to acquire its Version identity.
const hasStagedUploads = (session: ChatSession): boolean =>
  session.messages.some((message) =>
    message.uploads?.some(
      (upload) => upload.sessionId === PENDING_UPLOAD_SESSION_ID && !upload.versionId
    )
  )

// Builds an incremental saver: on each store change it persists only sessions whose reference changed
// and updates the manifest when selection moves. Explicit deletion owns its durable coordinator call.
const createStoreSaver = (
  api: SessionPersistenceApi,
  initial: SessionStoreSnapshot = useSessionStore.getState(),
  observer: StoreSaverObserver = {},
  persistence: OrderedSessionPersistence = createOrderedSessionPersistence(api)
): StoreSaver => {
  let previousSessions = initial.sessions
  let previousSelection = initial.selectedSessionId

  return (state, options) => {
    const nextSessions = state.sessions
    const previousById = indexById(previousSessions)
    const nextById = indexById(nextSessions)
    const tasks: Array<{
      target: string
      run: () => Promise<unknown>
      failureContext: StoreSaverFailureContext
    }> = []

    // Persist new or mutated sessions; pending sessions never touch disk until they bind a real id. A
    // session without a projectId cannot map to a sessions/<projectId>/ path (the main repository rejects
    // an empty segment), so skip it rather than enqueue a write that would throw and be swallowed.
    for (const session of nextSessions) {
      if (session.isPending || !session.projectId) continue

      const target = `session:${session.id}`
      const isForced = options?.forceTargets?.has(target) === true

      if (
        (previousById.get(session.id) !== session || isForced) &&
        (isForced || !isExternallyHydratedSession(session)) &&
        // Never write a session the store holds only as a summary: a summary carries no messages, graph or
        // activities, so persisting it would truncate the durable conversation down to its metadata. Unlike
        // the externally-hydrated case this is deliberately not bypassable by a forced flush — a forced
        // flush is exactly the path by which a summary would reach the disk.
        !isSummaryOnlySession(session) &&
        !hasStagedUploads(session) &&
        // A terminal graph-integrity failure keeps the renderer responsive, but the flat projection
        // is no longer proven to match the immutable Branch graph. Preserve the last durable copy.
        !session.conversationGraphSyncBlocked
      ) {
        const previousSession = previousById.get(session.id)
        const changedConflictRebaseFields = previousSession
          ? SESSION_CONFLICT_REBASE_FIELDS.filter((field) =>
              conflictRebaseFieldChanged(previousSession, session, field)
            )
          : []
        const conflictRebaseFields = [
          ...new Set([
            ...changedConflictRebaseFields,
            ...(options?.conflictRebaseFieldsByTarget?.get(target) ?? [])
          ])
        ]

        const saveOptions = conflictRebaseFields.length > 0 ? { conflictRebaseFields } : undefined
        const applyDurableSession = (
          durableSession: PersistedChatSession,
          options: SaveSessionOptions | undefined
        ): void => {
          useSessionStore.getState().applyDurableSessionProjection({
            source: session,
            session: durableSession,
            mode:
              (options?.conflictRebaseFields?.length ?? 0) > 0
                ? 'replace-persisted-if-current'
                : 'merge-upload-identities'
          })
        }

        tasks.push({
          target,
          failureContext: { conflictRebaseFields },
          run: isForced
            ? async () => {
                const durableSession = await persistence.saveSession(
                  toPersistedSession(session),
                  saveOptions
                )
                applyDurableSession(durableSession, saveOptions)
              }
            : () =>
                persistence.saveLatestSession(
                  target,
                  async (coalescedOptions) => {
                    const persisted = toPersistedSession(session)
                    const durableSession = await (coalescedOptions
                      ? api.saveSession(persisted, coalescedOptions)
                      : api.saveSession(persisted))
                    applyDurableSession(durableSession, coalescedOptions)
                    return durableSession
                  },
                  saveOptions
                )
        })
      }
    }

    // Track the last-open selection, ignoring transient pending selections.
    if (
      state.selectedSessionId !== previousSelection ||
      options?.forceTargets?.has('manifest') === true
    ) {
      const selectedSession = state.selectedSessionId
        ? nextById.get(state.selectedSessionId)
        : undefined

      if (!selectedSession?.isPending) {
        tasks.push({
          target: 'manifest',
          failureContext: {},
          run: () =>
            persistence.saveManifest({
              lastSessionId: state.selectedSessionId,
              lastProjectId: selectedSession?.projectId
            })
        })
      }
    }

    previousSessions = nextSessions
    previousSelection = state.selectedSessionId

    const scheduledTasks = tasks.map(({ target, run, failureContext }) => {
      // Invoke every task now so it takes its place in the shared persistence queue at snapshot time.
      return run().then(
        (result) => {
          observer.onSuccess?.(target)
          return result
        },
        (error: unknown) => {
          observer.onFailure?.(target, error, failureContext)
          throw error
        }
      )
    })

    return Promise.all(scheduledTasks).then(() => undefined)
  }
}

// Starts session persistence and returns health/recovery state so App can gate input and surface failures.
const useSessionPersistence = (): SessionPersistenceState => {
  const [isHydrated, setIsHydrated] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isReady, setIsReady] = useState(false)
  const [hasCompleteSessionCatalog, setHasCompleteSessionCatalog] = useState(false)
  const [canDeleteSessionsAndProjects, setCanDeleteSessionsAndProjects] = useState(false)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [loadWarning, setLoadWarning] = useState<string | undefined>(undefined)
  const [writeError, setWriteError] = useState<string | undefined>(undefined)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const retrySelection = useRef<SessionHydrationSelection | undefined>(undefined)
  const failedWriteTargets = useRef(new Set<string>())
  const failedConflictRebaseFields = useRef(new Map<string, SessionConflictRebaseField[]>())
  const retryManifestWritePending = useRef(false)
  const saverRef = useRef<StoreSaver | undefined>(undefined)
  const dismissLoadWarning = useCallback(() => setLoadWarning(undefined), [])
  const retryLoad = useCallback(() => {
    // A partial snapshot remains interactive. Keep the session the user chose from that snapshot so
    // a successful retry cannot replay the older on-disk manifest over their live navigation.
    if (isHydrated) {
      retrySelection.current = { sessionId: useSessionStore.getState().selectedSessionId }
    }
    setIsHydrated(false)
    setIsLoading(true)
    setIsReady(false)
    setHasCompleteSessionCatalog(false)
    setCanDeleteSessionsAndProjects(false)
    setLoadError(undefined)
    setLoadWarning(undefined)
    setWriteError(undefined)
    retryManifestWritePending.current = false
    setLoadAttempt((attempt) => attempt + 1)
  }, [isHydrated])
  const retryWrites = useCallback(() => {
    const saver = saverRef.current
    if (!saver || failedWriteTargets.current.size === 0) return

    const state = useSessionStore.getState()
    pruneRemovedSessionWriteTargets(
      failedWriteTargets.current,
      state.sessions,
      failedConflictRebaseFields.current
    )
    if (failedWriteTargets.current.size === 0) {
      setWriteError(undefined)
      return
    }

    void saver(state, {
      forceTargets: new Set(failedWriteTargets.current),
      conflictRebaseFieldsByTarget: new Map(failedConflictRebaseFields.current)
    }).catch(reportPersistenceError)
  }, [])

  // Switching to another session reads its document. Sessions arrive from the list tier without their content,
  // so without this the conversation just selected would look empty — and the guard, correctly, would refuse to
  // write it. One effect covers every way a selection can change (sidebar, deep link, restore) rather than one
  // call site at a time.
  const selectedSessionId = useSessionStore((state) => state.selectedSessionId)
  useEffect(() => {
    if (!selectedSessionId) return
    void sessionDocumentLoaderFor(window.api.sessions).load(selectedSessionId)
  }, [selectedSessionId])

  useEffect(() => {
    let isMounted = true
    let unsubscribe: (() => void) | undefined
    let activeSaver: StoreSaver | undefined
    saverRef.current = undefined
    failedWriteTargets.current.clear()
    failedConflictRebaseFields.current.clear()

    // Loads before subscribing so the initial empty store cannot overwrite disk state.
    const startPersistence = async (): Promise<void> => {
      const preferredSelection = retrySelection.current
      try {
        const result = await loadPersistedSessions(
          window.api.sessions,
          () => isMounted,
          preferredSelection
        )
        if (!result || !isMounted) return
        setIsHydrated(true)
        const loadWarnings = result.diagnostics?.warnings ?? []
        const sessionWarningCount = loadWarnings.filter(
          (warning) => warning.kind !== 'manifest-corrupt' && warning.kind !== 'manifest-unreadable'
        ).length
        setHasCompleteSessionCatalog(
          result.diagnostics?.isComplete !== false && sessionWarningCount === 0
        )
        setCanDeleteSessionsAndProjects(
          result.diagnostics?.isProjectDeletionRecoveryComplete === true
        )

        if (result.diagnostics?.isComplete === false) {
          setLoadError(
            result.diagnostics.failure === 'startup-reconciliation-failed'
              ? 'Saved conversations loaded, but storage recovery could not finish. Retry before creating or saving conversations.'
              : 'Some saved conversations could not be read. Retry before creating or saving conversations.'
          )
          setIsLoading(false)
          return
        }

        if (loadWarnings.length > 0) {
          const manifestWasRecovered = loadWarnings.some(
            (warning) => warning.kind === 'manifest-corrupt' && warning.recovered
          )
          const manifestRecoveryFailed = loadWarnings.some(
            (warning) => warning.kind === 'manifest-corrupt' && !warning.recovered
          )
          const manifestWasUnreadable = loadWarnings.some(
            (warning) => warning.kind === 'manifest-unreadable'
          )
          const warningMessages = [
            manifestWasRecovered
              ? 'Conversation selection data was damaged and moved aside.'
              : undefined,
            manifestRecoveryFailed
              ? 'Conversation selection data was damaged and could not be moved aside, so no conversation was selected.'
              : undefined,
            manifestWasUnreadable
              ? 'Conversation selection data could not be read, so no conversation was selected.'
              : undefined,
            sessionWarningCount > 0
              ? `${sessionWarningCount} saved conversation file${sessionWarningCount === 1 ? ' was' : 's were'} damaged and moved aside.`
              : undefined,
            'The remaining conversations were loaded.'
          ]
          setLoadWarning(warningMessages.filter(Boolean).join(' '))
        }
      } catch (error) {
        reportPersistenceError(error)
        if (isMounted) {
          setHasCompleteSessionCatalog(false)
          setCanDeleteSessionsAndProjects(false)
          setLoadError(SAFE_SESSION_LOAD_ERROR)
          setIsLoading(false)
        }
        return
      }

      let hasStartedPendingArtifactReconciliation = false
      const startPendingArtifactReconciliation = (): void => {
        if (hasStartedPendingArtifactReconciliation) return
        hasStartedPendingArtifactReconciliation = true
        // Runs after the saver subscribes so finalized references are persisted. A failed startup
        // manifest write defers this until that retry succeeds and persistence becomes ready.
        void reconcilePendingArtifacts(window.api.artifacts)
      }

      // Snapshot the hydrated state as the diff baseline so hydration itself is not re-saved.
      const save = createStoreSaver(
        window.api.sessions,
        useSessionStore.getState(),
        {
          onFailure: (target, _error, context) => {
            if (!isMounted) return
            failedWriteTargets.current.add(target)
            const conflictRebaseFields = context.conflictRebaseFields
            if (conflictRebaseFields && conflictRebaseFields.length > 0) {
              failedConflictRebaseFields.current.set(target, [
                ...new Set([
                  ...(failedConflictRebaseFields.current.get(target) ?? []),
                  ...conflictRebaseFields
                ])
              ])
            }
            pruneRemovedSessionWriteTargets(
              failedWriteTargets.current,
              useSessionStore.getState().sessions,
              failedConflictRebaseFields.current
            )
            // A queued save can lose a race with an authoritative deletion. Its tombstone rejection
            // must not resurrect a retry target for a Session that no longer exists in the store.
            if (!failedWriteTargets.current.has(target)) {
              if (failedWriteTargets.current.size === 0) setWriteError(undefined)
              return
            }
            setWriteError(SAFE_SESSION_WRITE_ERROR)
          },
          onSuccess: (target) => {
            if (!isMounted) return
            failedWriteTargets.current.delete(target)
            failedConflictRebaseFields.current.delete(target)
            if (target === 'manifest' && retryManifestWritePending.current) {
              retryManifestWritePending.current = false
              setIsReady(true)
              startPendingArtifactReconciliation()
            }
            if (failedWriteTargets.current.size === 0) setWriteError(undefined)
          }
        },
        liveSessionPersistence
      )
      activeSaver = save
      saverRef.current = save

      unsubscribe = useSessionStore.subscribe((state) => {
        pruneRemovedSessionWriteTargets(
          failedWriteTargets.current,
          state.sessions,
          failedConflictRebaseFields.current
        )
        if (failedWriteTargets.current.size === 0) setWriteError(undefined)
        void save(state).catch(reportPersistenceError)
      })

      // Hydration intentionally uses the user's live selection instead of the older disk manifest
      // on retry. Force that tri-state selection (including an explicit empty selection) back to
      // disk before declaring persistence ready, because the saver baseline already contains it.
      if (preferredSelection !== undefined) {
        try {
          await save(useSessionStore.getState(), {
            forceTargets: new Set(['manifest'])
          })
        } catch (error) {
          retryManifestWritePending.current = true
          reportPersistenceError(error)
        }
        if (!isMounted) return
      }

      retrySelection.current = undefined
      setIsLoading(false)
      if (retryManifestWritePending.current) return
      setIsReady(true)
      startPendingArtifactReconciliation()
    }

    void startPersistence()

    return () => {
      isMounted = false
      if (saverRef.current === activeSaver) saverRef.current = undefined
      unsubscribe?.()
    }
  }, [loadAttempt])

  return {
    isHydrated,
    isLoading,
    isReady,
    hasCompleteSessionCatalog,
    canDeleteSessionsAndProjects,
    loadError,
    loadWarning,
    writeError,
    dismissLoadWarning,
    retryLoad,
    retryWrites
  }
}

export {
  createOrderedSessionPersistence,
  createSessionDocumentLoader,
  createStoreSaver,
  flushSessionPersistence,
  loadPersistedSessions,
  reconcilePendingArtifacts,
  saveSessionInOrder,
  useSessionPersistence
}
export type {
  ArtifactReconcileApi,
  OrderedSessionPersistence,
  SessionPersistenceApi,
  SessionPersistenceState
}
