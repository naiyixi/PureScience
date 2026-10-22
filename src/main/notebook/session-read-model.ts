import type {
  NotebookCell,
  NotebookEnvironmentStatus,
  NotebookKernelMetadata,
  NotebookLanguage,
  NotebookRunRecord,
  NotebookRunSourceHash,
  NotebookRunSummary,
  NotebookSessionReference,
  NotebookSessionRequest,
  NotebookSessionState
} from '../../shared/notebook'
import { isSha256Hex } from '../../shared/notebook'
import type { NotebookRuntimeBinding, NotebookRuntimeBindings } from '../../shared/notebook-runtime'
import { getNotebookRunJsonPath, getRuntimeRoot, NotebookRunRepository } from './repository'
import { notebookRunSourceHash } from './run-risk-receipt'
import type { NotebookSessionSnapshot } from './session-aggregate'

type NotebookHandoffContext = {
  activeRunId?: string
  activeWriteCellId?: string
  executionCount: number
  cells: Array<{
    id: string
    language: NotebookLanguage
    status: NotebookCell['status']
    executionCount?: number
    latestRunId?: string
  }>
  kernels: Array<{
    kind: NotebookLanguage | 'repl'
    status: NotebookKernelMetadata['lastKnownStatus']
  }>
  runtimes: Array<{
    language: NotebookLanguage
    label: string
    version?: string
    status?: NotebookRuntimeBinding['status']
    reason?: NotebookRuntimeBinding['reason']
  }>
}

type NotebookSessionReadSource = {
  readonly id: string
  readonly sessionId: string
  readonly projectName: string
  readonly cwd: string
  readonly notebookSessionRoot: string
  readonly dataRoot: string
  readonly runtimeRoot: string
  readonly runJsonPath: string
  snapshot: () => NotebookSessionSnapshot
  kernelStatusEntries: () => Array<[string, NotebookKernelMetadata['lastKnownStatus']]>
  runtimeBindingEntries: () => Array<[NotebookLanguage, NotebookRuntimeBinding]>
}

type NotebookSessionReadModelOptions<Session extends NotebookSessionReadSource> = {
  storageRoot: string
  defaultProjectName: string
  repository: NotebookRunRepository
  findSession: (sessionId: string) => Session | undefined
  runtimeBindings: (session: Session) => NotebookRuntimeBindings
  isRestartRecommended: (processKey: string) => boolean
}

/**
 * Caller-owned timing slot for `NotebookSessionReadModel.state()`.
 *
 * The point of the split is the next reading, not this one: a slow `notebook:state` is either our own
 * parse of a multi-megabyte document or a main thread that was not running this code at all, and only
 * the per-call numbers can tell those apart.
 */
export type NotebookStateReadPhases = { loadMs?: number }

// Projects live Session Aggregate state and durable run history without owning either source.
class NotebookSessionReadModel<Session extends NotebookSessionReadSource> {
  constructor(private readonly options: NotebookSessionReadModelOptions<Session>) {}

  /**
   * The run this session is executing right now, or undefined when it is idle.
   *
   * Read from the live aggregate this model projects — never from disk, never creating a session, and
   * never from a caller-supplied parameter: a run id that arrived as an RPC argument is not authority
   * for run identity (see ConnectorCallContext). Callers that need one ask here.
   */
  activeRunIdFor(sessionId: string): string | undefined {
    return this.options.findSession(sessionId)?.snapshot().activeRunId
  }

  // A handoff peek must never create a Session or read disk: absent/non-actionable live state is absent.
  peekHandoffContext(sessionId: string): NotebookHandoffContext | undefined {
    const session = this.options.findSession(sessionId)
    if (!session) return undefined

    const snapshot = session.snapshot()
    const kernels: NotebookHandoffContext['kernels'] = snapshot.kernelStatuses
      .filter(([, status]) => status !== 'terminated')
      .slice(-6)
      .map(([processKey, status]) => ({
        kind: processKey === 'repl' ? 'repl' : processKey.startsWith('r:') ? 'r' : 'python',
        status
      }))
    const runtimes = session
      .runtimeBindingEntries()
      .slice(-4)
      .map(([language, binding]) => ({
        language,
        label: binding.label,
        ...(binding.version ? { version: binding.version } : {}),
        ...(binding.status ? { status: binding.status } : {}),
        ...(binding.reason ? { reason: binding.reason } : {})
      }))
    const cells = snapshot.cells.slice(-6).map((cell) => ({
      id: cell.id,
      language: cell.language,
      status: cell.status,
      ...(cell.executionCount === undefined ? {} : { executionCount: cell.executionCount }),
      ...(cell.latestRunId ? { latestRunId: cell.latestRunId } : {})
    }))

    if (
      snapshot.executionCount === 0 &&
      !snapshot.activeRunId &&
      !snapshot.activeWrite &&
      cells.length === 0 &&
      kernels.length === 0 &&
      runtimes.length === 0
    ) {
      return undefined
    }

    return {
      executionCount: snapshot.executionCount,
      ...(snapshot.activeRunId ? { activeRunId: snapshot.activeRunId } : {}),
      ...(snapshot.activeWrite ? { activeWriteCellId: snapshot.activeWrite.cellId } : {}),
      cells,
      kernels,
      runtimes
    }
  }

  /**
   * Where one `notebook:state` read spent its time, filled by the read that knows.
   *
   * `loadMs` is the durable half — reading, parsing and normalizing run.json, which on this machine is
   * 391 MB across 125 documents (median 2.1 MB, max 15.9 MB). It is taken here because this is the only
   * place the document is parsed, and it is written into an object the CALLER owns so two concurrent
   * reads of different sessions cannot overwrite each other's numbers. Nothing else is recorded: a
   * timing slot must never be able to change the answer it describes.
   */
  async state(
    session: Session,
    phases?: NotebookStateReadPhases
  ): Promise<NotebookSessionState & { runtimeBindings: NotebookRuntimeBindings }> {
    const loadStartedAt = performance.now()
    const document = await this.options.repository.loadOrCreate({
      projectName: session.projectName,
      sessionId: session.sessionId,
      workspaceCwd: session.cwd
    })
    if (phases) phases.loadMs = performance.now() - loadStartedAt
    const snapshot = session.snapshot()

    return {
      id: session.id,
      sessionId: session.sessionId,
      cwd: session.cwd,
      notebookSessionRoot: session.notebookSessionRoot,
      dataRoot: session.dataRoot,
      runtimeRoot: session.runtimeRoot,
      pythonPath: document.kernel.pythonPath,
      kernelStatus: document.kernel.lastKnownStatus,
      runJsonPath: session.runJsonPath,
      cells: snapshot.cells.map((cell) => ({ ...cell })),
      activeWrite: snapshot.activeWrite ? { ...snapshot.activeWrite } : undefined,
      activeRunId: snapshot.activeRunId,
      runs: document.runs.map((run) => this.toPublicRunRecord(run)),
      recentRuns: document.runs.slice(-20).map((run) => this.toPublicRunRecord(run)),
      environments: this.environmentStatuses(session),
      runtimeBindings: this.options.runtimeBindings(session)
    }
  }

  async getSessionReference(
    request: NotebookSessionRequest
  ): Promise<NotebookSessionReference | null> {
    const live = this.options.findSession(request.sessionId)
    if (live) return this.toSessionReference(live)

    const projectName = request.projectName ?? this.options.defaultProjectName
    const document = await this.options.repository.findExisting(projectName, request.sessionId)
    if (!document) return null

    return {
      sessionId: request.sessionId,
      projectName,
      workspaceCwd: document.workspaceCwd,
      notebookSessionRoot: document.notebookSessionRoot,
      dataRoot: document.dataRoot,
      runtimeRoot: document.kernel.runtimeRoot,
      runJsonPath: getNotebookRunJsonPath(this.options.storageRoot, projectName, request.sessionId)
    }
  }

  toSessionReference(session: Session): NotebookSessionReference {
    return {
      sessionId: session.sessionId,
      projectName: session.projectName,
      workspaceCwd: session.cwd,
      notebookSessionRoot: session.notebookSessionRoot,
      dataRoot: session.dataRoot,
      runtimeRoot: session.runtimeRoot,
      runJsonPath: session.runJsonPath
    }
  }

  toRunSummary(session: Session, run: NotebookRunRecord): NotebookRunSummary {
    const inputFiles = (run.inputFiles ?? []).map((input) => {
      const publicInput = { ...input } as Partial<typeof input>
      delete publicInput.storageKey
      return publicInput as NotebookRunSummary['inputFiles'][number]
    })
    return {
      ...this.toPublicRunRecord(run),
      inputFiles,
      notebookSessionRoot: session.notebookSessionRoot,
      dataRoot: session.dataRoot,
      runtimeRoot: getRuntimeRoot(this.options.storageRoot),
      kernelName: 'python3'
    }
  }

  private environmentStatuses(session: Session): NotebookEnvironmentStatus[] {
    return session.kernelStatusEntries().map(([processKey, status]) => {
      if (processKey === 'repl') return { processKey, kind: 'repl', status }
      const separator = processKey.indexOf(':')
      return {
        processKey,
        kind: processKey.slice(0, separator) === 'r' ? 'r' : 'python',
        environment: processKey.slice(separator + 1),
        status,
        restartRecommended: this.options.isRestartRecommended(processKey)
      }
    })
  }

  private toPublicRunRecord(run: NotebookRunRecord): NotebookRunRecord {
    const inputFiles = (run.inputFiles ?? []).map((input) => {
      const publicInput = { ...input } as Partial<typeof input>
      delete publicInput.storageKey
      return publicInput
    })
    const sourceContentHash = this.readDerivedSourceHash(run)
    return {
      ...run,
      inputFiles,
      ...(sourceContentHash === undefined ? {} : { sourceContentHash })
    } as NotebookRunRecord
  }

  // Read-side completion of a run's content hash, for records written before the risk receipt existed
  // (v2.1.0, batch B): the run's source is on the record, so the hash the lineage recipe asks for is
  // recomputable here — through the receipt's own hash path, never a second implementation. Skipped
  // when a receipt already carries a hash, so no run carries two hashes claiming the same thing, and
  // `riskReview` is never synthesized: a reader's hash must not read as "this run was assessed".
  private readDerivedSourceHash(run: NotebookRunRecord): NotebookRunSourceHash | undefined {
    if (isSha256Hex(run.riskReview?.codeHash)) return undefined
    if (typeof run.script !== 'string' || run.script === '') return undefined
    return { value: notebookRunSourceHash(run.script), provenance: 'computed-on-read' }
  }
}

export { NotebookSessionReadModel }
export type { NotebookHandoffContext, NotebookSessionReadModelOptions, NotebookSessionReadSource }
