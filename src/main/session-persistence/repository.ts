import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import {
  createEmptySessionManifest,
  createSessionFile,
  normalizeSessionFile,
  sanitizeSessionUploadedAttachments,
  normalizeSessionManifest,
  type LoadAllSessionsResult,
  type PersistedChatSession,
  type PersistedSessionManifest,
  type SaveSessionManifestRequest,
  type SessionLoadFailure,
  type SessionLoadWarning,
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
  async saveSession(session: PersistedChatSession): Promise<void> {
    return this.enqueue(async () => {
      await this.writeSession(session)
      // Readers that keep a view of every session (search) learn about the write here, not by re-reading.
      bumpSessionRevision()
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
  private async writeSession(session: PersistedChatSession): Promise<void> {
    await this.writeSessionToDirectory(session, this.projectDir(session.projectId))
  }

  private async writeSessionToDirectory(
    session: PersistedChatSession,
    projectDirectory: string
  ): Promise<void> {
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

    await mkdir(projectDirectory, { recursive: true })
    await this.atomicWrite(filePath, createSessionFile(encodeSessionDataPaths(sanitizedSession)))
    // Warm the summary cache so the next startup skips parsing this file.
    void this.writeSessionSummary(filePath, sanitizedSession)
  }

  private async writeManifest(request: SaveSessionManifestRequest): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true })
    await this.atomicWrite(this.manifestPath, normalizeSessionManifest(request))
  }

  // Shared temp-file + rename write used by session files and the manifest.
  private async atomicWrite(filePath: string, payload: unknown): Promise<void> {
    this.writeSequence += 1
    const temporaryPath = `${filePath}.${Date.now()}-${this.writeSequence}.tmp`

    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await this.dependencies.renameFile(temporaryPath, filePath)
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
      // Warm the summary cache so the next startup skips the full parse.
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
