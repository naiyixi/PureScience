import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import {
  createEmptySessionManifest,
  createSessionFile,
  normalizeSessionFile,
  sanitizeSessionUploadedAttachments,
  sanitizeSessionRuntimeContext,
  normalizeSessionManifest,
  type LoadAllSessionsResult,
  type PersistedChatSession,
  type PersistedSessionManifest,
  type PersistedSessionStatus,
  type SaveSessionManifestRequest,
  type SessionLoadFailure,
  type SessionLoadWarning,
  type SessionRuntimeContext,
  type SessionSummaryFile
} from '../../shared/session-persistence'
import {
  MAX_RETAINED_SESSION_MESSAGES,
  trimSessionHistory,
  type SessionRetention
} from '../../shared/session-retention'
import { SESSION_PACKAGE_IMPORT_RECORD_SUFFIX } from '../../shared/session-package-import'
import {
  summarizeSessionCatalogEntry,
  type SessionCatalogResult,
  type SessionCatalogSummary
} from '../../shared/session-catalog-summary'
import { decodeSessionDataPaths, encodeSessionDataPaths } from './session-data-paths'
import { bumpSessionRevision } from './session-revision'
import { beginFsOperation, endFsOperation } from '../diagnostics/fs-queue-probe'

const SESSIONS_DIR = 'sessions'
const DELETED_SESSIONS_DIR = 'deleted-sessions'
const PROJECT_DELETION_COMMIT_MARKER = '.project-deletion-committed'
const MANIFEST_FILE = 'manifest.json'
// The index format this build writes and accepts. An entry written by another version is treated as
// absent rather than migrated: its replacement is one parse of that session's document.
const SUMMARY_FILE_VERSION = 2
const FILE_REPLACEMENT_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const

type SessionLoadDiagnostics = {
  result: LoadAllSessionsResult
  // False means at least one directory or session file could not be read or safely quarantined.
  // Callers may hydrate the returned sessions but must not reconcile absent index rows as deletions.
  isComplete: boolean
  warnings: SessionLoadWarning[]
  failure?: SessionLoadFailure
}

type SessionCatalogDiagnostics = {
  result: SessionCatalogResult
  isComplete: boolean
  warnings: SessionLoadWarning[]
  // How the scan was answered, per entry: `hits` came from the on-disk index without reading the
  // document, `parsedDocuments` had to be read (and rewrote its index entry). Reported so the
  // acceptance can be checked against a real run instead of against the intent.
  index: { hits: number; parsedDocuments: number }
}

type SessionScanOptions = {
  mode?: 'repair' | 'read-only'
}

type SessionLoadDiagnostic =
  | { status: 'found'; session: PersistedChatSession }
  | { status: 'missing' }
  | { status: 'unreadable' }

type ProjectSessionLoadDiagnostics = {
  sessions: PersistedChatSession[]
  isComplete: boolean
}

type ProjectSessionDeletionState = 'live' | 'legacy-committed' | 'prepared' | 'absent'

type SessionDirectoryEntry = {
  name: string
  isDirectory(): boolean
  isFile(): boolean
}

// Where one session write spent its wall time, measured inside the write itself.
//
// Why split it: the real-machine reading put 44.6 s of a 142.7 s slow-save total in `writeMs` across 159 slow
// saves, and the question that decides the next unit is whether those seconds are OUR serialization (a cost
// that writing only what changed would remove) or the filesystem's (a cost no reshaping of the bytes removes on
// a machine under memory pressure). A probe on an idle machine says the bytes are cheap — rewriting a 3.1 MB
// session cost 6 ms of serialization and 4 ms of write — so the field's 98 ms median is not the JSON.
// Naming the parts is what makes that decidable from a field log instead of another design guess.
export type SessionWritePhases = {
  /** Waiting in this repository's own save queue, behind an earlier write. */
  queueMs: number
  /** Trimming, sanitizing and path encoding: CPU over the document before a byte is produced. */
  materializeMs: number
  /** The `JSON.stringify` of the whole document. */
  serializeMs: number
  /** Creating the project directory and writing the temp file. */
  diskWriteMs: number
  /** The rename that makes the write observable. */
  replaceMs: number
}

type SessionRepositoryDependencies = {
  remove(path: string, options: { force: boolean; recursive: boolean }): Promise<void>
  readDirectoryEntries(path: string): Promise<SessionDirectoryEntry[]>
  readManifestFile(path: string): Promise<string>
  readSessionFile(path: string): Promise<string>
  statFile(path: string): Promise<{ size: number; mtimeMs: number }>
  writeSummaryFile(path: string, content: string): Promise<void>
  renameFile(source: string, destination: string): Promise<void>
  wait(delayMs: number): Promise<void>
}

const DEFAULT_DEPENDENCIES: SessionRepositoryDependencies = {
  remove: (path, options) => rm(path, options),
  readDirectoryEntries: (path) => readdir(path, { withFileTypes: true }),
  readManifestFile: (path) => readFile(path, 'utf8'),
  readSessionFile: (path) => readFile(path, 'utf8'),
  statFile: async (path) => {
    const stats = await lstat(path)
    return { size: stats.size, mtimeMs: stats.mtimeMs }
  },
  writeSummaryFile: (path, content) => writeFile(path, content, 'utf8'),
  renameFile: (source, destination) => rename(source, destination),
  wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))
}

// Applies the retention bound to both message collections a session carries — the conversation list and
// the conversation graph — and records the drop on the document. A session under the limit is returned
// untouched (the very same object), so an ordinary write cannot start rewriting documents.
const trimRetainedSessionHistory = (session: PersistedChatSession): PersistedChatSession => {
  const limited = trimSessionHistory(session.messages, MAX_RETAINED_SESSION_MESSAGES)
  const graphMessages = session.conversationGraph?.messages
  const trimmedGraph =
    graphMessages === undefined
      ? undefined
      : trimSessionHistory(graphMessages, MAX_RETAINED_SESSION_MESSAGES)
  const dropped =
    (limited.retention?.droppedMessages ?? 0) + (trimmedGraph?.retention?.droppedMessages ?? 0)
  if (dropped === 0) return session

  // The recorded gap is datable from the oldest message that is no longer there, whichever collection
  // it came from.
  const boundaries = [
    limited.retention?.droppedBefore,
    trimmedGraph?.retention?.droppedBefore
  ].filter((value): value is number => value !== undefined)
  const retention: SessionRetention = {
    droppedMessages: dropped,
    droppedBefore: Math.min(...boundaries)
  }

  return {
    ...session,
    messages: limited.messages,
    ...(trimmedGraph === undefined || session.conversationGraph === undefined
      ? {}
      : { conversationGraph: { ...session.conversationGraph, messages: trimmedGraph.messages } }),
    retention
  }
}

const isRetryableFileReplacementError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  ['EPERM', 'EACCES', 'EBUSY'].includes(String((error as { code?: unknown }).code))

// Production storage lives under ~/.purescience; dev builds use an isolated sibling directory.
export const PROD_SESSION_DIR_NAME = '.purescience'
export const DEV_SESSION_DIR_NAME = '.purescience-project'

// Builds the app-owned session directory in the user's home folder. Kept pure (no electron) so it
// stays unit-testable; the dev/prod choice is applied by the main-only resolveStorageRoot helper.
const getSessionPersistenceDir = (
  homePath: string,
  dirName: string = PROD_SESSION_DIR_NAME
): string => join(homePath, dirName)

// Rebuilds the metadata slice a `useSummary` reader used to receive from the list projection: the
// two list-only fields are dropped and the document's content stays behind, exactly as before.
const sessionSliceFromCatalog = (
  catalog: SessionCatalogSummary,
  projectId: string
): PersistedChatSession => {
  const { messageCount: _messageCount, lastAgentMessage: _lastAgentMessage, ...session } = catalog
  return { ...session, projectId, messages: [] }
}

// Rejects path segments that could escape the sessions tree. Real session/project ids are id-like, so
// this only guards against corrupt or malicious values before they become file paths.
const assertSafeSegment = (segment: string): string => {
  if (
    !segment ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0')
  ) {
    throw new Error(`Unsafe session path segment: ${JSON.stringify(segment)}`)
  }

  return segment
}

// The answer to "does this Session carry a Plan?" from the list-tier projection. `answered` carries the
// runtime context when the index shows one; `unavailable` is not an error and not "no Plan" — it means
// the index cannot prove it describes the current bytes, so the caller must read the document.
export type RuntimeContextIndexLookup =
  { status: 'answered'; runtimeContext?: SessionRuntimeContext } | { status: 'unavailable' }

// What a whole-Session save must take from the durable record instead of the renderer's projection: the
// three main-owned fields, plus the timestamp the merge uses to stay monotonic. Deliberately not a
// `PersistedChatSession`: an object that only looks like a Session is how a caller ends up trusting a
// partial document.
export type SessionSaveAuthority = {
  runtimeContext?: SessionRuntimeContext
  archivedAt?: number
  status?: PersistedSessionStatus
  updatedAt: number
}

// `missing` and `unreadable` keep their document-read meaning; the caller must not merge either into a
// write. Written as a closed union so a new state has to be handled where the save decides to fail.
//
// `source` is not decoration: the slow-save line reports it, so an installed reading can say whether the
// narrow path was taken at all. Without it a smaller `authorityMs` and an index that was never consulted
// look the same from the outside.
export type SaveAuthorityLookup =
  | { status: 'found'; authority: SessionSaveAuthority; source: 'index' | 'document' }
  | { status: 'missing' }
  | { status: 'unreadable' }

const SESSION_STATUSES: readonly PersistedSessionStatus[] = [
  'idle',
  'running',
  'waiting-permission',
  'waiting-plan-approval',
  'error'
]

// Reads the four fields a save may not take from the renderer out of a document that was just parsed and
// normalized, so the document path and the index path agree field for field.
const saveAuthorityFromSession = (session: PersistedChatSession): SessionSaveAuthority => {
  const authority: SessionSaveAuthority = { updatedAt: session.updatedAt }
  if (session.runtimeContext) authority.runtimeContext = session.runtimeContext
  if (session.archivedAt !== undefined) authority.archivedAt = session.archivedAt
  if (session.status !== undefined) authority.status = session.status
  return authority
}

// The same four fields from an index entry, or `undefined` when that entry cannot stand in for the
// document. Every check mirrors one the document read performs: a context must survive the same sanitizer
// (`loadRuntimeContextFromSummary` already refuses otherwise), the archive stamp must be a safe integer
// like `normalizeSessionFile` requires, and the status must be one of the persisted literals. Anything
// else — including a field written by a build that shaped it differently — sends the caller back to the
// document rather than being carried into a write.
const saveAuthorityFromCatalog = (
  catalog: SessionCatalogSummary
): SessionSaveAuthority | undefined => {
  if (!Number.isSafeInteger(catalog.updatedAt) || catalog.updatedAt < 0) return undefined
  const authority: SessionSaveAuthority = { updatedAt: catalog.updatedAt }
  if (catalog.runtimeContext !== undefined) {
    const runtimeContext = sanitizeSessionRuntimeContext(catalog.runtimeContext)
    if (!runtimeContext) return undefined
    authority.runtimeContext = runtimeContext
  }
  if (catalog.archivedAt !== undefined) {
    if (!Number.isSafeInteger(catalog.archivedAt) || catalog.archivedAt <= 0) return undefined
    authority.archivedAt = catalog.archivedAt
  }
  if (catalog.status !== undefined) {
    if (!SESSION_STATUSES.includes(catalog.status)) return undefined
    authority.status = catalog.status
  }
  return authority
}

// Owns per-session durable reads/writes: one file per session under sessions/<projectId>/<id>.json,
// plus a small manifest for the last-open selection. Writes are serialized and atomic (temp + rename),
// while malformed JSON is backed up and I/O failures preserve the existing file for later recovery.
class SessionRepository {
  private saveQueue: Promise<void> = Promise.resolve()
  private writeSequence = 0
  private backupSequence = 0
  private readonly dependencies: SessionRepositoryDependencies

  constructor(
    private readonly storageDir: string,
    dependencies: Partial<SessionRepositoryDependencies> = {}
  ) {
    this.dependencies = {
      remove: dependencies.remove ?? DEFAULT_DEPENDENCIES.remove,
      readDirectoryEntries:
        dependencies.readDirectoryEntries ?? DEFAULT_DEPENDENCIES.readDirectoryEntries,
      readManifestFile: dependencies.readManifestFile ?? DEFAULT_DEPENDENCIES.readManifestFile,
      readSessionFile: dependencies.readSessionFile ?? DEFAULT_DEPENDENCIES.readSessionFile,
      renameFile: dependencies.renameFile ?? DEFAULT_DEPENDENCIES.renameFile,
      statFile: dependencies.statFile ?? DEFAULT_DEPENDENCIES.statFile,
      writeSummaryFile: dependencies.writeSummaryFile ?? DEFAULT_DEPENDENCIES.writeSummaryFile,
      wait: dependencies.wait ?? DEFAULT_DEPENDENCIES.wait
    }
  }

  private get sessionsDir(): string {
    return join(this.storageDir, SESSIONS_DIR)
  }

  private get manifestPath(): string {
    return join(this.sessionsDir, MANIFEST_FILE)
  }

  private get deletedSessionsDir(): string {
    return join(this.storageDir, DELETED_SESSIONS_DIR)
  }

  private projectDir(projectId: string): string {
    return join(this.sessionsDir, assertSafeSegment(projectId))
  }

  private sessionFilePath(projectId: string, sessionId: string): string {
    return join(this.projectDir(projectId), `${assertSafeSegment(sessionId)}.json`)
  }

  private deletedProjectDir(projectId: string): string {
    return join(this.deletedSessionsDir, assertSafeSegment(projectId))
  }

  // Loads every per-session file plus the manifest.
  async loadAll(): Promise<LoadAllSessionsResult> {
    const scan = await this.loadAllWithDiagnostics()
    return scan.result
  }

  // Loads one durable session directly instead of scanning every project/session file. Reviewer fix
  // loops call this after each correction turn so every re-review sees newly persisted messages rather
  // than retaining the snapshot that existed when the initial review started.
  async loadSession(
    projectId: string,
    sessionId: string
  ): Promise<PersistedChatSession | undefined> {
    const safeProjectId = assertSafeSegment(projectId)
    return (
      await this.readSessionFile(
        this.sessionFilePath(safeProjectId, assertSafeSegment(sessionId)),
        safeProjectId
      )
    ).session
  }

  // Terminal mutations must distinguish absence from a transient/non-ENOENT read failure. Treating
  // both as undefined could unlink the JSON before Upload cleanup has observed its final authority.
  async loadSessionWithDiagnostics(
    projectId: string,
    sessionId: string
  ): Promise<SessionLoadDiagnostic> {
    const safeProjectId = assertSafeSegment(projectId)
    const safeSessionId = assertSafeSegment(sessionId)
    const read = await this.readSessionFile(
      this.sessionFilePath(safeProjectId, safeSessionId),
      safeProjectId
    )
    if (!read.isComplete || read.wasQuarantined) return { status: 'unreadable' }

    const quarantine = await this.hasQuarantinedSessionFile(safeProjectId, safeSessionId)
    if (!quarantine.isComplete) return { status: 'unreadable' }
    if (read.session) return { status: 'found', session: read.session }
    return quarantine.exists ? { status: 'unreadable' } : { status: 'missing' }
  }

  // The Plan projection asks one question every time a window opens — "does this Session carry a Plan?"
  // — and the document tier answers it by parsing the whole Session JSON (real corpus: 68.99 MB across
  // 66 Sessions, up to 3.1 MB for a single one). The list tier already keeps a projection beside every
  // document that is 108x smaller (0.64 MB in total) and carries the runtime context, validated against
  // the document's own bytes by the fingerprint check below. So this lookup answers from that index when
  // the index can prove it describes the current file, and otherwise says `unavailable` — which puts the
  // caller back on the document, byte for byte the behaviour it had before.
  //
  // It never guesses in either direction: a summary whose fingerprint does not match answers nothing,
  // and a runtime context that does not survive the same sanitizer the document read runs answers
  // nothing either (an unreadable context in the index must not become "this Session has no Plan").
  async loadRuntimeContextFromSummary(
    projectId: string,
    sessionId: string
  ): Promise<RuntimeContextIndexLookup> {
    const filePath = this.sessionFilePath(
      assertSafeSegment(projectId),
      assertSafeSegment(sessionId)
    )
    const summary = await this.tryReadSessionSummary(filePath)
    if (!summary) return { status: 'unavailable' }
    if (summary.runtimeContext === undefined) return { status: 'answered' }
    const runtimeContext = sanitizeSessionRuntimeContext(summary.runtimeContext)
    if (!runtimeContext) return { status: 'unavailable' }
    return { status: 'answered', runtimeContext }
  }

  // The whole-Session save asks a narrower question than `loadSessionWithDiagnostics` answers: it needs
  // only the fields the renderer is not allowed to own — runtime context, archive state, the
  // awaiting-approval block — plus `updatedAt`, which keeps the merged document monotonic.
  //
  // It used to answer that by parsing the whole document on every save. On the real corpus the documents
  // are 69.0 MB across 67 files (average 1.03 MB, largest 3.11 MB) while their index entries are 0.64 MB
  // across 66 (average 9.7 KB): 106x less to read and parse, for fields the index already carries. The
  // save's own phase log agrees it was paying for it — `authorityMs` was 460.2 s of 1,118.9 s across 789
  // slow saves (41%, p50 91 ms, p90 688 ms, max 22.7 s), second only to the disk write.
  //
  // Same rule as `loadRuntimeContextFromSummary`: the index answers only when its fingerprint still
  // describes the bytes on disk, and every field it carries must survive the validators the document read
  // would have run. Otherwise (absent entry, drift, an older format, a context the sanitizer rejects) the
  // caller gets the document path, byte for byte the behaviour it had before this seam — including
  // `unreadable`, which must keep failing closes rather than overwrite a file it could not read.
  async loadSaveAuthority(projectId: string, sessionId: string): Promise<SaveAuthorityLookup> {
    const safeProjectId = assertSafeSegment(projectId)
    const safeSessionId = assertSafeSegment(sessionId)
    // Both reads report themselves to the shared file-system probe: `authorityMs` is the save's largest
    // segment, and until now the stall verdict could only see the preview acquire path's reads, so for this
    // one it always answered "nothing of ours was queueing" — a blind spot, not a calm pool.
    const summary = await this.reportFsOperation(() =>
      this.tryReadSessionSummary(this.sessionFilePath(safeProjectId, safeSessionId))
    )
    if (summary) {
      const fromIndex = saveAuthorityFromCatalog(summary)
      if (fromIndex) return { status: 'found', authority: fromIndex, source: 'index' }
    }

    const document = await this.reportFsOperation(() =>
      this.loadSessionWithDiagnostics(safeProjectId, safeSessionId)
    )
    if (document.status !== 'found') return document
    return {
      status: 'found',
      authority: saveAuthorityFromSession(document.session),
      source: 'document'
    }
  }

  // Runs one file-system step as a reported operation. The probe is a counter, not a clock: it says an
  // operation of ours was in flight, never how long it took, which is what lets a stall verdict separate a
  // busy thread pool from a loop that was gone.
  //
  // Scope is deliberately the save path (authority read, directory create, document write, index write) —
  // the channel whose slow rows dominate the real logs. Whole-tree scans report the same way by call, not
  // here: they are not part of a save and their fan-out is a different reading.
  private async reportFsOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
    beginFsOperation()
    try {
      return await operation()
    } finally {
      endFsOperation()
    }
  }

  // Reports whether the live sessions tree was fully scanned so DB reconciliation never acts on a
  // partial read. Project recovery owns tombstone cleanup before ordinary hydration is allowed.
  async loadAllWithDiagnostics(options: SessionScanOptions = {}): Promise<SessionLoadDiagnostics> {
    const quarantineInvalidFiles = options.mode !== 'read-only'
    const { sessions, isComplete, warnings } = await this.readAllSessions({
      quarantineInvalidFiles,
      ...(options.mode === 'read-only' ? { useSummary: true } : {})
    })
    const manifestRead = await this.readManifest({ quarantineInvalidFiles })

    return {
      result: { sessions, manifest: manifestRead.manifest },
      // The manifest is only a last-open pointer. It must never make a complete Session authority
      // scan read-only; a later selection write will retry persistence through the normal saver.
      isComplete,
      warnings: manifestRead.warning ? [...warnings, manifestRead.warning] : warnings
    }
  }

  /**
   * The list tier's own scan: identity and metadata for every Session.
   *
   * It walks the same tree the full scan walks — which is what makes an externally created or
   * deleted Session show up immediately, since the file list comes from the directory and never
   * from the index — but it parses a document only when the on-disk index cannot answer for it:
   *
   *   - index entry present and its fingerprint (size + mtime) matches the file  -> serve it, no read
   *   - entry missing, stale, an older format, or unreadable                     -> parse that one file
   *
   * The last case is the fallback the acceptance asks for: with no index at all (first run after an
   * upgrade, or the index removed), every entry takes it, which rebuilds the whole index in one pass
   * and leaves the next scan parsing nothing. Cost is bounded by the entries that actually changed.
   *
   * Deliberately not a repair scan: a corrupt document is reported as a warning and left in place for
   * the reconciliation pass to quarantine, because a list read must not move a user's file.
   */
  async loadCatalogWithDiagnostics(): Promise<SessionCatalogDiagnostics> {
    const projectDirectories = await this.listDirectoryNames(this.sessionsDir)
    const sessions: SessionCatalogSummary[] = []
    const warnings: SessionLoadWarning[] = []
    let isComplete = projectDirectories.isComplete
    let indexHits = 0
    let parsedDocuments = 0

    for (const projectId of projectDirectories.names) {
      const project = await this.readProjectCatalog(projectId, {
        missingDirectoryIsIncomplete: true,
        warnings
      })
      sessions.push(...project.sessions)
      isComplete &&= project.isComplete
      indexHits += project.indexHits
      parsedDocuments += project.parsedDocuments
    }

    const manifestRead = await this.readManifest({ quarantineInvalidFiles: false })

    return {
      result: { sessions, manifest: manifestRead.manifest },
      isComplete,
      warnings: manifestRead.warning ? [...warnings, manifestRead.warning] : warnings,
      index: { hits: indexHits, parsedDocuments }
    }
  }

  // Project deletion needs a complete view of only its target authority. An unrelated unreadable
  // Project must not block deletion, while any target-directory failure remains fail-closed.
  async loadProjectWithDiagnostics(projectId: string): Promise<ProjectSessionLoadDiagnostics> {
    return this.readProjectSessions(assertSafeSegment(projectId), {
      quarantinedIsIncomplete: true
    })
  }

  async loadCommittedProjectWithDiagnostics(
    projectId: string
  ): Promise<ProjectSessionLoadDiagnostics> {
    const safeProjectId = assertSafeSegment(projectId)
    return this.readProjectSessionsAtDirectory(
      safeProjectId,
      this.deletedProjectDir(safeProjectId),
      {
        quarantinedIsIncomplete: true
      }
    )
  }

  // Writes one session file (serialized through the save queue to preserve write order).
  //
  // `onWritePhases` is how the caller learns where the write spent its wall time. It is a callback rather than
  // a return value so that every existing stand-in that implements this surface with one parameter keeps
  // satisfying it, and so that a caller with nothing to report pays no allocation.
  async saveSession(
    session: PersistedChatSession,
    onWritePhases?: (phases: SessionWritePhases) => void
  ): Promise<void> {
    const queuedAt = Date.now()
    return this.enqueue(async () => {
      const phases: SessionWritePhases = {
        queueMs: Date.now() - queuedAt,
        materializeMs: 0,
        serializeMs: 0,
        diskWriteMs: 0,
        replaceMs: 0
      }
      await this.writeSession(session, phases)
      // Readers that keep a view of every session (search) learn about the write here, not by re-reading.
      bumpSessionRevision()
      // Reported only after the bytes are durable: a failed write has no breakdown worth attributing.
      onWritePhases?.(phases)
    })
  }

  async saveCommittedProjectSession(session: PersistedChatSession): Promise<void> {
    return this.enqueue(async () => {
      if ((await this.getProjectSessionDeletionState(session.projectId)) !== 'legacy-committed') {
        throw new Error('Cannot save a Session outside committed Project deletion authority.')
      }
      await this.writeSessionToDirectory(session, this.deletedProjectDir(session.projectId))
      bumpSessionRevision()
    })
  }

  // Removes a single session file.
  async deleteSession(projectId: string, sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      const safeProjectId = assertSafeSegment(projectId)
      const safeSessionId = assertSafeSegment(sessionId)
      const diagnostic = await this.loadSessionWithDiagnostics(safeProjectId, safeSessionId)
      if (diagnostic.status === 'unreadable') {
        throw new Error('Cannot delete a Session whose durable JSON is unreadable.')
      }
      if (diagnostic.status === 'missing') return

      // The valid primary proves matching quarantines are superseded authority covered by this
      // explicit Session deletion. Remove every backup first so any failure leaves that proof in
      // place and the operation safely retryable; only then remove the current primary.
      const quarantines = await this.listQuarantinedSessionFiles(safeProjectId, safeSessionId)
      if (!quarantines.isComplete) {
        throw new Error('Cannot delete a Session whose quarantine directory is unreadable.')
      }
      for (const fileName of quarantines.names) {
        await this.dependencies.remove(join(this.projectDir(safeProjectId), fileName), {
          force: true,
          recursive: false
        })
      }
      await this.dependencies.remove(this.sessionFilePath(safeProjectId, safeSessionId), {
        force: true,
        recursive: false
      })
      bumpSessionRevision()
    })
  }

  // Atomically moves a marked live directory into the durable deletion area. The marker/tombstone is
  // retained until Project deletion finishes so recovery can distinguish a committed Session phase
  // from an attempt that failed before the rename, including for Projects with no Session files.
  async deleteProjectSessions(projectId: string): Promise<void> {
    return this.enqueue(async () => {
      const safeProjectId = assertSafeSegment(projectId)
      const state = await this.getProjectSessionDeletionState(safeProjectId)
      if (state === 'legacy-committed' || state === 'prepared') return

      const liveProjectDir = this.projectDir(safeProjectId)
      const deletedProjectDir = this.deletedProjectDir(safeProjectId)
      await mkdir(this.deletedSessionsDir, { recursive: true })
      await this.dependencies.remove(deletedProjectDir, { recursive: true, force: true })
      await mkdir(liveProjectDir, { recursive: true })
      await writeFile(join(liveProjectDir, PROJECT_DELETION_COMMIT_MARKER), '', 'utf8')
      await rename(liveProjectDir, deletedProjectDir)
    })
  }

  async getProjectSessionDeletionState(projectId: string): Promise<ProjectSessionDeletionState> {
    const safeProjectId = assertSafeSegment(projectId)
    const deletedProjectDir = this.deletedProjectDir(safeProjectId)
    const liveProjectDir = this.projectDir(safeProjectId)
    const markerPath = join(deletedProjectDir, PROJECT_DELETION_COMMIT_MARKER)

    try {
      const tombstone = await lstat(deletedProjectDir)
      if (!tombstone.isDirectory() || tombstone.isSymbolicLink()) {
        throw new Error(`Project Session deletion tombstone is invalid: ${projectId}`)
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        try {
          const live = await lstat(liveProjectDir)
          if (!live.isDirectory() || live.isSymbolicLink()) {
            throw new Error(`Project Session live authority is invalid: ${projectId}`)
          }
          return 'live'
        } catch (liveError) {
          if (isMissingFileError(liveError)) return 'absent'
          throw liveError
        }
      }
      throw error
    }

    let isPrepared = false
    try {
      const marker = await lstat(markerPath)
      if (!marker.isFile() || marker.isSymbolicLink()) {
        throw new Error(`Project Session deletion marker is invalid: ${projectId}`)
      }
      isPrepared = true
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }

    // Releases before the marker protocol atomically renamed the same directory and then removed it
    // best-effort. A surviving unmarked tombstone therefore proves a possible committed old Session
    // phase and must be treated fail-closed while a Project deletion intent is being recovered.
    try {
      await lstat(liveProjectDir)
    } catch (error) {
      if (isMissingFileError(error)) return isPrepared ? 'prepared' : 'legacy-committed'
      throw error
    }
    throw new Error(`Project Session deletion has conflicting live authority: ${projectId}`)
  }

  async markCommittedProjectSessionsPrepared(projectId: string): Promise<void> {
    await this.enqueue(async () => {
      if ((await this.getProjectSessionDeletionState(projectId)) !== 'legacy-committed') return
      await this.atomicWrite(
        join(this.deletedProjectDir(assertSafeSegment(projectId)), PROJECT_DELETION_COMMIT_MARKER),
        ''
      )
    })
  }

  async completeProjectSessionDeletion(projectId: string): Promise<void> {
    await this.enqueue(() =>
      this.dependencies.remove(this.deletedProjectDir(assertSafeSegment(projectId)), {
        recursive: true,
        force: true
      })
    )
  }

  async listLegacyProjectSessionTombstones(): Promise<string[]> {
    let entries
    try {
      entries = await readdir(this.deletedSessionsDir, { withFileTypes: true })
    } catch (error) {
      if (isMissingFileError(error)) return []
      throw error
    }

    const projectIds: string[] = []
    for (const entry of entries) {
      // Every direct child is deletion authority. Ignoring an unexpected file or symlink could hide
      // an old tombstone from adoption and permanently strand the only legacy Upload locator.
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Project Session deletion tombstone is invalid: ${entry.name}`)
      }
      const projectId = assertSafeSegment(entry.name)
      const state = await this.getProjectSessionDeletionState(projectId)
      if (state === 'legacy-committed') projectIds.push(projectId)
      else if (state !== 'prepared') {
        // A tombstone observed by this scan must remain authoritative through classification. Treat
        // concurrent disappearance or conflicting live authority as unknown instead of skipping it.
        throw new Error(`Project Session deletion tombstone state changed: ${projectId}`)
      }
    }
    return projectIds.sort()
  }

  // Persists the last-open project/session pointer.
  async saveManifest(request: SaveSessionManifestRequest): Promise<void> {
    return this.enqueue(() => this.writeManifest(request))
  }

  // Serializes writes so an older save cannot finish after a newer one.
  private enqueue(operation: () => Promise<unknown>): Promise<void> {
    const run = this.saveQueue.then(() => operation()).then(() => undefined)

    this.saveQueue = run.then(
      () => undefined,
      () => undefined
    )

    return run
  }

  // Writes through a unique temp file, then atomically replaces the target session file.
  private async writeSession(
    session: PersistedChatSession,
    phases?: SessionWritePhases
  ): Promise<void> {
    await this.writeSessionToDirectory(session, this.projectDir(session.projectId), phases)
  }

  private async writeSessionToDirectory(
    session: PersistedChatSession,
    projectDirectory: string,
    phases?: SessionWritePhases
  ): Promise<void> {
    const materializeStarted = Date.now()
    const messages = [...session.messages, ...(session.conversationGraph?.messages ?? [])]
    const legacyUpload = messages
      .flatMap((message) => message.uploads ?? [])
      .find((upload) => !upload.versionId)
    if (legacyUpload) {
      throw new Error(
        `Session upload must be upgraded to an immutable Version before persistence: ${legacyUpload.id}`
      )
    }
    const filePath = join(projectDirectory, `${assertSafeSegment(session.id)}.json`)
    // Bound the retained history here, at the one place every session write passes through: a
    // conversation that runs for months must not make its own document unloadable. Oldest first, and
    // the drop is recorded on the document (shared/session-retention) so a reader sees where the
    // record resumes rather than believing the conversation began there.
    const sanitizedSession = sanitizeSessionUploadedAttachments(trimRetainedSessionHistory(session))
    const payload = createSessionFile(encodeSessionDataPaths(sanitizedSession))
    if (phases) phases.materializeMs = Date.now() - materializeStarted

    const mkdirStarted = Date.now()
    await this.reportFsOperation(() => mkdir(projectDirectory, { recursive: true }))
    if (phases) phases.diskWriteMs += Date.now() - mkdirStarted
    await this.reportFsOperation(() => this.atomicWrite(filePath, payload, phases))
    // Warm the summary cache so the next startup skips parsing this file.
    //
    // Awaited, not fire-and-forget: this entry's fingerprint is taken with a `stat` of the file, and an
    // earlier save's entry could otherwise stat a document a later save had already replaced while still
    // carrying the older projection — an entry that claims to describe bytes it did not come from. Two
    // consequences beyond correctness: the next save's authority read always finds a current entry (so
    // the narrow path is hit deterministically rather than depending on write ordering), and a failed
    // summary write still cannot fail the save (the writer swallows its own errors).
    await this.reportFsOperation(() => this.writeSessionSummary(filePath, sanitizedSession))
  }

  private async writeManifest(request: SaveSessionManifestRequest): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true })
    await this.atomicWrite(this.manifestPath, normalizeSessionManifest(request))
  }

  // Shared temp-file + rename write used by session files and the manifest.
  private async atomicWrite(
    filePath: string,
    payload: unknown,
    phases?: SessionWritePhases
  ): Promise<void> {
    this.writeSequence += 1
    const temporaryPath = `${filePath}.${Date.now()}-${this.writeSequence}.tmp`

    const serializeStarted = Date.now()
    const serialized = `${JSON.stringify(payload, null, 2)}\n`
    if (phases) phases.serializeMs = Date.now() - serializeStarted

    const diskStarted = Date.now()
    await writeFile(temporaryPath, serialized, 'utf8')
    if (phases) phases.diskWriteMs += Date.now() - diskStarted
    const replaceStarted = Date.now()
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await this.dependencies.renameFile(temporaryPath, filePath)
          if (phases) phases.replaceMs = Date.now() - replaceStarted
          return
        } catch (error) {
          const delayMs = FILE_REPLACEMENT_RETRY_DELAYS_MS[attempt]
          if (delayMs === undefined || !isRetryableFileReplacementError(error)) throw error
          await this.dependencies.wait(delayMs)
        }
      }
    } catch (error) {
      await this.dependencies
        .remove(temporaryPath, { recursive: false, force: true })
        .catch(() => undefined)
      throw error
    }
  }

  private async readManifest(options: { quarantineInvalidFiles: boolean }): Promise<{
    manifest: PersistedSessionManifest
    warning?: SessionLoadWarning
  }> {
    let raw: string
    try {
      raw = await this.dependencies.readManifestFile(this.manifestPath)
    } catch (error) {
      if (!isMissingFileError(error)) {
        return {
          manifest: createEmptySessionManifest(),
          warning: {
            kind: 'manifest-unreadable',
            fileName: MANIFEST_FILE,
            recovered: false
          }
        }
      }
      return {
        manifest: createEmptySessionManifest()
      }
    }

    try {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Invalid Session manifest')
      }
      return {
        manifest: normalizeSessionManifest(parsed)
      }
    } catch {
      const wasQuarantined =
        options.quarantineInvalidFiles && (await this.tryBackupInvalidFile(this.manifestPath))
      return {
        manifest: createEmptySessionManifest(),
        warning: {
          kind: 'manifest-corrupt',
          fileName: MANIFEST_FILE,
          recovered: wasQuarantined
        }
      }
    }
  }

  // Reads every project directory's session files and propagates completeness across every level.
  // Repair scans quarantine invalid data; read-only scans report it in place. I/O errors keep
  // reconciliation disabled until the next repair.
  private async readAllSessions(options: {
    quarantineInvalidFiles: boolean
    useSummary?: boolean
  }): Promise<{
    sessions: PersistedChatSession[]
    isComplete: boolean
    warnings: SessionLoadWarning[]
  }> {
    const projectDirectories = await this.listDirectoryNames(this.sessionsDir)
    const sessions: PersistedChatSession[] = []
    const warnings: SessionLoadWarning[] = []
    let isComplete = projectDirectories.isComplete

    for (const projectId of projectDirectories.names) {
      const project = await this.readProjectSessions(projectId, {
        missingDirectoryIsIncomplete: true,
        quarantineInvalidFiles: options.quarantineInvalidFiles,
        ...(options.useSummary ? { useSummary: true } : {}),
        warnings
      })
      sessions.push(...project.sessions)
      isComplete &&= project.isComplete
    }

    return { sessions, isComplete, warnings }
  }

  private async readProjectSessions(
    projectIdValue: string,
    options: {
      missingDirectoryIsIncomplete?: boolean
      quarantinedIsIncomplete?: boolean
      quarantineInvalidFiles?: boolean
      useSummary?: boolean
      warnings?: SessionLoadWarning[]
    } = {}
  ): Promise<ProjectSessionLoadDiagnostics> {
    const projectId = assertSafeSegment(projectIdValue)
    return this.readProjectSessionsAtDirectory(
      projectId,
      join(this.sessionsDir, projectId),
      options
    )
  }

  private async readProjectSessionsAtDirectory(
    projectId: string,
    projectDir: string,
    options: {
      missingDirectoryIsIncomplete?: boolean
      quarantinedIsIncomplete?: boolean
      quarantineInvalidFiles?: boolean
      useSummary?: boolean
      warnings?: SessionLoadWarning[]
    } = {}
  ): Promise<ProjectSessionLoadDiagnostics> {
    const sessionFiles = await this.listSessionFileNames(projectDir, {
      missingIsIncomplete: options.missingDirectoryIsIncomplete
    })
    const sessions: PersistedChatSession[] = []
    const activeQuarantines = new Set(sessionFiles.quarantinedPrimaryFileNames)
    const warnedFiles = new Set<string>()
    let isComplete = sessionFiles.isComplete

    for (const fileName of sessionFiles.names) {
      // The directory is the authoritative owning project, regardless of the file's stored projectId.
      const read = await this.readSessionFile(join(projectDir, fileName), projectId, {
        missingIsIncomplete: true,
        quarantineInvalidFiles: options.quarantineInvalidFiles,
        ...(options.useSummary ? { useSummary: true } : {})
      })
      isComplete &&= read.isComplete
      if (options.quarantinedIsIncomplete && read.wasQuarantined) isComplete = false
      if (read.warning) {
        options.warnings?.push(read.warning)
        warnedFiles.add(read.warning.fileName)
      }
      if (read.session) {
        // A current primary that successfully normalizes supersedes retained historical backups for
        // the same file. Keep the backups, but do not let them permanently block terminal mutation.
        activeQuarantines.delete(fileName)
        sessions.push(read.session)
      }
    }
    if (options.quarantinedIsIncomplete && activeQuarantines.size > 0) isComplete = false
    for (const fileName of activeQuarantines) {
      if (!warnedFiles.has(fileName)) {
        options.warnings?.push({
          kind: 'corrupt',
          projectId,
          fileName,
          recovered: true
        })
      }
    }

    return { sessions, isComplete }
  }

  // The catalog tier's per-project walk. Same file list, same completeness rules as the full scan —
  // only the per-file read differs (index first, document only when the index cannot answer).
  private async readProjectCatalog(
    projectIdValue: string,
    options: {
      missingDirectoryIsIncomplete?: boolean
      warnings?: SessionLoadWarning[]
    } = {}
  ): Promise<{
    sessions: SessionCatalogSummary[]
    isComplete: boolean
    indexHits: number
    parsedDocuments: number
  }> {
    const projectId = assertSafeSegment(projectIdValue)
    const projectDir = join(this.sessionsDir, projectId)
    const sessionFiles = await this.listSessionFileNames(projectDir, {
      missingIsIncomplete: options.missingDirectoryIsIncomplete
    })
    const sessions: SessionCatalogSummary[] = []
    let isComplete = sessionFiles.isComplete
    let indexHits = 0
    let parsedDocuments = 0

    for (const fileName of sessionFiles.names) {
      const filePath = join(projectDir, fileName)
      const cached = await this.tryReadSessionSummary(filePath)
      if (cached) {
        // Served from the index: this document is never opened. The directory owns the project id, as
        // it does on the full scan, so the entry travels with the authoritative one.
        indexHits += 1
        sessions.push({ ...cached, projectId })
        continue
      }

      // No usable entry: read this one document and let the read rewrite the index for it. Quarantine
      // is switched OFF explicitly — a list read must not move a user's file, and the default here is
      // the repair path.
      parsedDocuments += 1
      const read = await this.readSessionFile(filePath, projectId, {
        missingIsIncomplete: true,
        quarantineInvalidFiles: false
      })
      isComplete &&= read.isComplete
      if (read.warning) options.warnings?.push(read.warning)
      if (read.session) sessions.push(summarizeSessionCatalogEntry(read.session))
    }

    return { sessions, isComplete, indexHits, parsedDocuments }
  }

  // Summary path for a session file: <session-file>.summary.json in the same directory.
  private summaryPathFor(filePath: string): string {
    return `${filePath}.summary.json`
  }

  // The index entry for one session file, or undefined when the index cannot answer for it: absent,
  // unreadable, written by an older format, or describing a different version of the file than the
  // one on disk now (which is how an external edit invalidates it).
  private async tryReadSessionSummary(
    filePath: string
  ): Promise<SessionCatalogSummary | undefined> {
    try {
      const [fingerprint, rawSummary] = await Promise.all([
        this.dependencies.statFile(filePath),
        this.dependencies.readSessionFile(this.summaryPathFor(filePath)).catch(() => undefined)
      ])
      if (!rawSummary) return undefined
      const summary = JSON.parse(rawSummary) as SessionSummaryFile
      if (
        summary.version !== SUMMARY_FILE_VERSION ||
        summary.fingerprint.size !== fingerprint.size ||
        summary.fingerprint.mtimeMs !== fingerprint.mtimeMs
      ) {
        return undefined
      }
      return summary.catalog
    } catch {
      return undefined
    }
  }

  // Writes the list-tier index entry next to the session file. Best-effort: a failed summary write
  // never fails the session save/load.
  private async writeSessionSummary(
    filePath: string,
    session: PersistedChatSession
  ): Promise<void> {
    try {
      const fingerprint = await this.dependencies.statFile(filePath)
      const summary: SessionSummaryFile = {
        version: SUMMARY_FILE_VERSION,
        sessionId: session.id,
        projectId: session.projectId,
        fingerprint,
        // The projection, not the document: messages/conversationGraph/activities are dropped here, and
        // the count and last agent message are the parts a list cannot recompute without them.
        catalog: summarizeSessionCatalogEntry(session)
      }
      await this.dependencies.writeSummaryFile(
        this.summaryPathFor(filePath),
        JSON.stringify(summary)
      )
    } catch {
      // Cache is advisory only.
    }
  }

  private async readSessionFile(
    filePath: string,
    projectId: string,
    options: {
      missingIsIncomplete?: boolean
      quarantineInvalidFiles?: boolean
      useSummary?: boolean
    } = {}
  ): Promise<{
    session?: PersistedChatSession
    isComplete: boolean
    wasQuarantined?: boolean
    warning?: SessionLoadWarning
  }> {
    // Summary-first: only the startup list path opts in; full-parse callers (recovery, exports)
    // keep seeing the authoritative file.
    if (options.useSummary) {
      const cached = await this.tryReadSessionSummary(filePath)
      if (cached) {
        return { session: sessionSliceFromCatalog(cached, projectId), isComplete: true }
      }
    }

    let raw: string
    try {
      raw = await this.dependencies.readSessionFile(filePath)
    } catch (error) {
      if (isMissingFileError(error) && !options.missingIsIncomplete) return { isComplete: true }
      return {
        isComplete: false,
        warning: {
          kind: 'unreadable',
          projectId,
          fileName: basename(filePath),
          recovered: false
        }
      }
    }

    try {
      const session = normalizeSessionFile(JSON.parse(raw) as unknown, {
        preserveLegacyUploadPaths: true
      })
      if (!session) {
        const wasQuarantined =
          options.quarantineInvalidFiles !== false && (await this.tryBackupInvalidFile(filePath))
        return {
          isComplete: wasQuarantined,
          wasQuarantined,
          warning: {
            kind: 'corrupt',
            projectId,
            fileName: basename(filePath),
            recovered: wasQuarantined
          }
        }
      }

      const restored = decodeSessionDataPaths({ ...session, projectId })
      // Warm the summary cache so the next startup skips the full parse. Deliberately NOT awaited: a scan
      // answers from the documents it parsed rather than from the cache it writes beside them, so a first
      // launch over N documents does not wait on N small writes. The consequence is that "the entry
      // landed" runs on a later clock than "the scan returned" — a caller that needs the next read to be
      // index-only (a test, a restart handler) waits for it explicitly rather than assuming it.
      void this.writeSessionSummary(filePath, restored)
      return { session: restored, isComplete: true }
    } catch {
      const wasQuarantined =
        options.quarantineInvalidFiles !== false && (await this.tryBackupInvalidFile(filePath))
      return {
        isComplete: wasQuarantined,
        wasQuarantined,
        warning: {
          kind: 'corrupt',
          projectId,
          fileName: basename(filePath),
          recovered: wasQuarantined
        }
      }
    }
  }

  // ENOENT is an authoritative empty directory; any other readdir failure is a partial scan.
  private async listDirectoryNames(dir: string): Promise<{ names: string[]; isComplete: boolean }> {
    try {
      const entries = await this.dependencies.readDirectoryEntries(dir)

      return {
        names: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
        isComplete: true
      }
    } catch (error) {
      return { names: [], isComplete: isMissingFileError(error) }
    }
  }

  // Lists only committed session JSON files. Quarantines are associated with their former primary so
  // terminal scans can distinguish orphan authority from a backup superseded by valid current JSON.
  // In-progress temp writes stay excluded and non-ENOENT directory failures disable reconciliation.
  private async listSessionFileNames(
    dir: string,
    options: { missingIsIncomplete?: boolean } = {}
  ): Promise<{
    names: string[]
    isComplete: boolean
    quarantinedPrimaryFileNames: string[]
  }> {
    try {
      const entries = await this.dependencies.readDirectoryEntries(dir)

      return {
        names: entries
          .filter(
            (entry) =>
              entry.isFile() &&
              entry.name.endsWith('.json') &&
              !entry.name.includes('.tmp') &&
              !entry.name.includes('.invalid-') &&
              // Summary caches (<session>.json.summary.json) are metadata, not session files.
              !entry.name.endsWith('.summary.json') &&
              // Import records (<session>.import.json) are the sidecar that keeps an imported session
              // read-only. They are metadata beside a session, not a session: scanned as one they fail
              // to normalize and get quarantined as corrupt, which silently destroys the posture the
              // record exists to carry.
              !entry.name.endsWith(SESSION_PACKAGE_IMPORT_RECORD_SUFFIX)
          )
          .map((entry) => entry.name),
        isComplete: true,
        quarantinedPrimaryFileNames: entries.flatMap((entry) => {
          const match = /^(.*\.json)\.invalid-\d+-\d+$/u.exec(entry.name)
          return match ? [match[1]] : []
        })
      }
    } catch (error) {
      return {
        names: [],
        isComplete: isMissingFileError(error) && !options.missingIsIncomplete,
        quarantinedPrimaryFileNames: []
      }
    }
  }

  private async hasQuarantinedSessionFile(
    projectId: string,
    sessionId: string
  ): Promise<{ exists: boolean; isComplete: boolean }> {
    const quarantines = await this.listQuarantinedSessionFiles(projectId, sessionId)
    return { exists: quarantines.names.length > 0, isComplete: quarantines.isComplete }
  }

  private async listQuarantinedSessionFiles(
    projectId: string,
    sessionId: string
  ): Promise<{ names: string[]; isComplete: boolean }> {
    try {
      const entries = await readdir(this.projectDir(projectId))
      const prefix = `${sessionId}.json.invalid-`
      return {
        names: entries.filter(
          (entry) => entry.startsWith(prefix) && /^\d+-\d+$/u.test(entry.slice(prefix.length))
        ),
        isComplete: true
      }
    } catch (error) {
      return { names: [], isComplete: isMissingFileError(error) }
    }
  }

  // Returning false preserves the partial-scan signal when even quarantine could not complete.
  private async tryBackupInvalidFile(filePath: string): Promise<boolean> {
    try {
      await this.backupInvalidFile(filePath)
      return true
    } catch {
      return false
    }
  }

  private async backupInvalidFile(filePath: string): Promise<void> {
    this.backupSequence += 1
    await rename(filePath, `${filePath}.invalid-${Date.now()}-${this.backupSequence}`)
  }
}

// Distinguishes first-run missing storage from malformed files that deserve a backup.
const isMissingFileError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'ENOENT'

export { SessionRepository, getSessionPersistenceDir }
export type { ProjectSessionDeletionState, ProjectSessionLoadDiagnostics, SessionLoadDiagnostic }
export type { SessionLoadDiagnostics, SessionCatalogDiagnostics }
