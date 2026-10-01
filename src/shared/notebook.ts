import type { ArtifactFile } from './artifacts'
import type { ExecutionProtectionSnapshot } from './execution-protection'
import type { NotebookRuntimeBindings } from './notebook-runtime'

export const NOTEBOOKS_DIR = 'notebooks'
export const NOTEBOOK_RUN_FILE = 'run.json'
// 持久化运行历史窗口: 超过该数量的旧 run 记录被截断, 防止长会话/大输出会话的内存与 IPC 尖峰。
// 渲染端另行展示"仅最近 N 次"提示 (见 NotebookPreview)。
export const NOTEBOOK_PERSISTED_RUN_LIMIT = 100

// Identifies whether a run was initiated by the agent or by the user terminal.
export type NotebookRunSource = 'agent' | 'user'

// Distinguishes regular notebook cells from terminal submissions in the same history.
export type NotebookRunInputKind = 'cell' | 'terminal'

// Mirrors the lifecycle of one persisted execution record in run.json. 'interrupted' = the process
// died (crash / force-quit) while the run was in flight — reconciled from a stale 'running' on the
// next startup. 'cancelled' = the run was deliberately aborted (e.g. a force-stop disable).
export type NotebookRunStatus =
  'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'interrupted' | 'cancelled'

export type NotebookRunProvenanceContext = {
  rootFrameId: string
  agentFrameId: string
  messageBranchId: string
  runtimeSegmentId: string
  promptMessageId: string
}

// Languages a notebook kernel can run in this phase; each runs as a persistent exec-loop process
// (no ipykernel/IRkernel involved).
export type NotebookLanguage = 'python' | 'r'

// Identifies which kernel produced a run: python/r are analysis cells, repl/bash are
// control-plane/shell.
export type NotebookKernelKind = 'python' | 'r' | 'repl' | 'bash'

export type NotebookEnvironmentPackage = {
  name: string
  version?: string
  versionStatus: 'known' | 'unavailable'
  ecosystem: 'python' | 'r' | 'native' | 'unknown'
  evidenceSources: Array<
    | 'python-importlib-metadata'
    | 'python-kernel-modules'
    | 'r-installed-packages'
    | 'r-session-info'
  >
  loadedState?: 'attached' | 'loaded' | 'installed-only' | 'unknown'
  libraryRank?: number
  libraryScope?: 'environment' | 'user' | 'system' | 'unknown'
  builtForRuntime?: string
  priority?: 'base' | 'recommended' | 'other'
}

export type NotebookPackageInstaller =
  | 'conda'
  | 'pip'
  | 'uv'
  | 'poetry'
  | 'r-install-packages'
  | 'renv'
  | 'pak'
  | 'biocmanager'
  | 'unknown'

export type NotebookPackageInstallerAttempt = {
  groupOrdinal: number
  installer: NotebookPackageInstaller
  packages: string[]
  status: 'succeeded' | 'failed' | 'skipped'
  mutationRisk: 'none' | 'possible' | 'confirmed' | 'unknown'
  reason?:
    | 'package-not-found'
    | 'solver-failed'
    | 'installer-unavailable'
    | 'permission'
    | 'network'
    | 'authentication'
    | 'tls-policy'
    | 'validation'
    | 'cancelled'
    | 'process-unconfirmed'
    | 'recovery-blocked'
    | 'unknown'
}

export type NotebookInventoryRefreshAttempt = {
  attempt: number
  trigger: 'terminal' | 'recovery'
  timestamp: string
  result: 'published' | 'unchanged' | 'failed'
  error?: string
}

export type NotebookEnvironmentPackageChange = {
  name: string
  ecosystem: NotebookEnvironmentPackage['ecosystem']
  relationship: 'requested' | 'dependency' | 'unattributed'
  change: 'installed' | 'updated' | 'removed' | 'unchanged' | 'observed'
  beforeVersion?: string
  afterVersion?: string
  libraryRank?: number
  libraryScope?: NotebookEnvironmentPackage['libraryScope']
}

export type NotebookEnvironmentOperation = {
  operationId: string
  timestamp: string
  operation: 'create' | 'install' | 'uninstall' | 'update'
  packages: string[]
  result: 'success' | 'failure'
  attempts: NotebookPackageInstallerAttempt[]
  fallbackUsed: boolean
  inventoryRefresh: 'published' | 'unchanged' | 'failed'
  inventoryRefreshAttempts: NotebookInventoryRefreshAttempt[]
  packageChanges?: NotebookEnvironmentPackageChange[]
}

export type NotebookEnvironmentOperationLogTruncation = {
  omittedCount: number
  earliestRetainedAt?: string
}

export const isNotebookEnvironmentOperationLogTruncation = (
  value: unknown
): value is NotebookEnvironmentOperationLogTruncation => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    Number.isInteger(candidate.omittedCount) &&
    Number(candidate.omittedCount) > 0 &&
    (candidate.earliestRetainedAt === undefined || typeof candidate.earliestRetainedAt === 'string')
  )
}

export type NotebookEnvironmentManifest = {
  schemaVersion: 1
  captureKind: 'completed-run'
  capturedAt: string
  installedInventory: {
    capturedAt: string
    source: 'full-scan' | 'cache-reused'
    validation: 'full-scan' | 'best-effort'
  }
  kernelKind: NotebookLanguage
  environmentName: string
  runtimeSource: 'managed' | 'external'
  runtimeVersion?: string
  platform?: string
  architecture?: string
  inventorySources: Array<'kernel-native' | 'interpreter-native' | 'operation-log'>
  packages: NotebookEnvironmentPackage[]
  operationLog?: NotebookEnvironmentOperation[]
  operationLogTruncation?: NotebookEnvironmentOperationLogTruncation
  complete: boolean
  captureStatus: 'complete' | 'partial'
  warnings?: string[]
}

export type NotebookRunEnvironmentCapture =
  | {
      state: 'available' | 'partial'
      manifestChecksum: string
      /** The environment-defining digest; equal across runs of one environment. */
      manifestFingerprint?: string
      warnings?: string[]
    }
  | {
      state: 'unavailable'
      reason:
        | 'environment-not-supported'
        | 'environment-capture-failed'
        | 'environment-manifest-publication-failed'
        | 'legacy-environment-reference-unavailable'
    }

export type NotebookLiveEnvironmentOverlay = {
  runtimeVersion?: string
  packages: NotebookEnvironmentPackage[]
  warnings?: string[]
}

export type NotebookInputAssociation = 'turn-attached' | 'resolver-accessed'

// Path-independent immutable input identity captured from the trusted main-process registry. The
// storage key is persisted only in run.json/evidence; summaries returned to agents and renderers omit
// it and resolve previews through main-process IPC.
export type NotebookRunInputFile = {
  inputFileVersionId: string
  sourceKind: 'upload-version' | 'artifact-version'
  sourceFileId: string
  sourceVersionNumber?: number
  sourceCreatedAt?: string
  sourceProjectId: string
  sourceSessionId: string
  filename: string
  contentType?: string
  sizeBytes: number
  checksum: string
  storageKey: string
  association: NotebookInputAssociation
}

export type NotebookInputFileSummary = Omit<NotebookRunInputFile, 'storageKey'>

export type NotebookInputPreviewIdentity = {
  projectId: string
  sourceKind: NotebookRunInputFile['sourceKind']
  inputFileVersionId: string
}

const NOTEBOOK_INPUT_PREVIEW_PREFIX = 'notebook-input:'

export const createNotebookInputPreviewKey = (identity: NotebookInputPreviewIdentity): string =>
  `${NOTEBOOK_INPUT_PREVIEW_PREFIX}${encodeURIComponent(
    JSON.stringify([identity.projectId, identity.sourceKind, identity.inputFileVersionId])
  )}`

export const parseNotebookInputPreviewKey = (key: string): NotebookInputPreviewIdentity => {
  if (!key.startsWith(NOTEBOOK_INPUT_PREVIEW_PREFIX)) {
    throw new Error('Invalid Notebook input preview key.')
  }
  const parsed = JSON.parse(
    decodeURIComponent(key.slice(NOTEBOOK_INPUT_PREVIEW_PREFIX.length))
  ) as unknown
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    parsed.some((value) => typeof value !== 'string') ||
    (parsed[1] !== 'upload-version' && parsed[1] !== 'artifact-version')
  ) {
    throw new Error('Invalid Notebook input preview key.')
  }
  return {
    projectId: parsed[0] as string,
    sourceKind: parsed[1],
    inputFileVersionId: parsed[2] as string
  }
}

// Classifies files that are created inside the notebook session workspace.
export type NotebookWorkingFileKind =
  'raw-data' | 'processed-data' | 'cache' | 'script' | 'intermediate' | 'other'

// Keeps raw streams separate while also preserving a display-ready plain text projection.
export type NotebookTextOutput = {
  stdout: string
  stderr: string
  traceback: string
  plain: string[]
}

// Represents structured execution output returned by the interpreter bridge.
export type NotebookOutput =
  | {
      type: 'stream'
      name: 'stdout' | 'stderr'
      text: string
    }
  | {
      type: 'error'
      name?: string
      message?: string
      traceback: string
      // 1-based source line of the failing statement, when the kernel can attribute one (R).
      line?: number
    }
  | {
      type: 'text'
      text: string
    }
  | {
      type: 'json'
      data: unknown
    }
  | {
      // A mime→payload bundle for rich results (e.g. plots, scalar values). Text mimes are verbatim;
      // image/png is base64.
      type: 'display'
      data: Record<string, string>
    }

export type NotebookWorkingFile = {
  path: string
  relativePath: string
  kind: NotebookWorkingFileKind
  // How the file changed during the run: created (new), modified (content/mtime changed), or
  // removed (deleted by the run). Absent on legacy rows written before this field existed.
  changeKind?: 'created' | 'modified' | 'removed'
  size?: number
  mtimeMs?: number
  createdByRunId?: string
}

// ------------------------------------------------------------------------------------------------
// Per-run file evidence (R3). The write side already existed as NotebookWorkingFile; this adds the
// read side and, more importantly, makes "we could not look" a first-class state. An empty read list
// is otherwise indistinguishable from a capture that never ran, and a silent empty list reads as a
// verified fact ("this run opened no existing files") when it may be a failure.
// ------------------------------------------------------------------------------------------------

// A file the run OPENED FOR READING. 'input' = it already existed when the run started (the answer to
// "which existing files did this result use"); 'intermediate' = this same run wrote it first, so it is
// a step inside the run rather than an input to it.
export type NotebookReadFileKind = 'input' | 'intermediate'

export type NotebookReadFile = {
  // Host path, for opening the file.
  path: string
  // Portable session-relative path — the same form NotebookWorkingFile.relativePath uses.
  relativePath: string
  kind: NotebookReadFileKind
  // How many times the path was opened for reading during the run (deduplicated to one entry).
  reads?: number
}

// 'captured' = the capture ran and the list is complete. 'truncated' = the capture ran and stopped at
// its limit (readTruncatedCount says how many were dropped). 'unsupported' = this kernel/driver cannot
// report reads at all. 'unavailable' = capture was expected but failed.
export type NotebookFileEvidenceStatus = 'captured' | 'truncated' | 'unsupported' | 'unavailable'

export type NotebookFileEvidenceReason =
  | 'driver-without-read-capture'
  | 'kernel-language-unsupported'
  | 'capture-failed'
  | 'limit-exceeded'
  | 'observation-unavailable'
  // Two sessions wrote into one working directory: the changes were observed, but they cannot be
  // attributed to one run — so the list is kept and labelled instead of discarded.
  | 'attribution-conflict'

type NotebookFileEvidenceBase = {
  read: NotebookReadFile[]
  // The write observer stops at MAX_CHANGED_PATHS. It used to stop silently; this is how many paths
  // were dropped, so "the run changed nothing else" is never claimed on the observer's behalf.
  writeTruncatedCount?: number
  // Two sessions shared one working directory during this run: each session's evidence stays its own,
  // and the overlap is stated rather than resolved by guessing which writer owns a path.
  directoryConflict?: 'shared-directory'
}

// How complete ONE axis of the evidence is. The write axis's file list already lives on the run
// record (workingFiles), so this carries only the capture status for it; the read axis keeps its list
// beside its status. Same rule as below: a status that implies missing data must carry that data.
export type NotebookFileCapture =
  | { status: 'captured' }
  | { status: 'truncated'; droppedCount: number }
  | { status: 'unsupported'; reason: NotebookFileEvidenceReason }
  | { status: 'unavailable'; reason: NotebookFileEvidenceReason }
  | {
      status: 'unattributed'
      reason: NotebookFileEvidenceReason
      directoryConflict: 'shared-directory'
      // Orthogonal to attribution: an over-limit run can also be an unattributable one.
      droppedCount?: number
      // What was seen changing in the shared directory, kept for the user to inspect but explicitly
      // NOT this run's file list: the same paths belong to the other session too, and workingFiles
      // feeds artifact provenance, where a file attributed to the wrong run is a false claim rather
      // than a gap. So the observation is preserved under a label instead of being reported as ours.
      observedPaths?: string[]
    }

// The read axis, as a discriminated union on purpose: 'truncated' without a count, or 'unsupported'
// without a reason, are unrepresentable — so a list that is short or missing can never be read as a
// complete one.
export type NotebookRunReadEvidence =
  | (NotebookFileEvidenceBase & { readStatus: 'captured' })
  | (NotebookFileEvidenceBase & { readStatus: 'truncated'; readTruncatedCount: number })
  | (NotebookFileEvidenceBase & {
      readStatus: 'unsupported' | 'unavailable'
      readReason: NotebookFileEvidenceReason
    })

// The statuses that mean "the capture did not complete", kept named so call sites and tests agree on
// the vocabulary instead of comparing string literals.
export type NotebookFileEvidenceUncapturedStatus = Exclude<
  NotebookFileEvidenceStatus,
  'captured' | 'truncated'
>

// Classifies collected read paths against what the same run wrote. Kept pure so the rule is testable
// without a kernel: a path in the written set is an intermediate step, everything else is an input.
export const classifyReadFiles = (
  readPaths: ReadonlyArray<{ path: string; relativePath: string; reads?: number }>,
  writtenFiles: ReadonlyArray<{ path: string; relativePath: string }>
): NotebookReadFile[] => {
  const written = new Set(writtenFiles.map((file) => file.relativePath))
  return readPaths.map((read) => ({
    path: read.path,
    relativePath: read.relativePath,
    kind: written.has(read.relativePath) ? 'intermediate' : 'input',
    ...(read.reads === undefined ? {} : { reads: read.reads })
  }))
}

// The "capture did not happen" arm, named so a caller that only ever produces this shape gets the
// reason in its type instead of having to narrow the union back down.
export type NotebookFileEvidenceUncaptured = Extract<
  NotebookRunReadEvidence,
  { readStatus: NotebookFileEvidenceUncapturedStatus }
>

// The honest shape for "the capture did not happen": an empty list that CANNOT be mistaken for a
// verified "no reads" because the status and the reason travel with it.
export const uncapturedReadEvidence = (
  reason: NotebookFileEvidenceReason,
  status: NotebookFileEvidenceUncapturedStatus = 'unsupported'
): NotebookFileEvidenceUncaptured => ({ read: [], readStatus: status, readReason: reason })

// The positive shape for the read axis.
export const capturedReadEvidence = (read: NotebookReadFile[]): NotebookRunReadEvidence => ({
  read,
  readStatus: 'captured'
})

// The read axis stopped at its limit: the collected list is real, and the dropped count says it is
// short — which is why 'truncated' cannot be built without it.
export const truncatedReadEvidence = (
  read: NotebookReadFile[],
  droppedCount: number
): NotebookRunReadEvidence => ({ read, readStatus: 'truncated', readTruncatedCount: droppedCount })

// Write-axis captures. The file list is NotebookRunRecord.workingFiles; these say how complete it is.
export const capturedWriteEvidence = (): NotebookFileCapture => ({ status: 'captured' })
export const truncatedWriteEvidence = (droppedCount: number): NotebookFileCapture => ({
  status: 'truncated',
  droppedCount
})
export const unavailableWriteEvidence = (
  reason: NotebookFileEvidenceReason
): NotebookFileCapture => ({
  status: 'unavailable',
  reason
})
export const unsupportedWriteEvidence = (
  reason: NotebookFileEvidenceReason
): NotebookFileCapture => ({
  status: 'unsupported',
  reason
})
export const unattributedWriteEvidence = (
  reason: NotebookFileEvidenceReason,
  options: { droppedCount?: number; observedPaths?: string[] } = {}
): NotebookFileCapture => ({
  status: 'unattributed',
  reason,
  directoryConflict: 'shared-directory',
  ...(options.droppedCount === undefined ? {} : { droppedCount: options.droppedCount }),
  ...(options.observedPaths === undefined ? {} : { observedPaths: options.observedPaths })
})

// Both axes travel together so a reader never sees a read status without a write status (or a write
// list whose completeness is left to guesswork).
export type NotebookRunFileEvidence = {
  read: NotebookRunReadEvidence
  write: NotebookFileCapture
}
export const buildFileEvidence = (
  read: NotebookRunReadEvidence,
  write: NotebookFileCapture
): NotebookRunFileEvidence => ({ read, write })

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

const EVIDENCE_REASONS: readonly NotebookFileEvidenceReason[] = [
  'driver-without-read-capture',
  'kernel-language-unsupported',
  'capture-failed',
  'limit-exceeded',
  'observation-unavailable'
]

const READ_FILE_KINDS: readonly NotebookReadFileKind[] = ['input', 'intermediate']

// Reads back a persisted evidence record. Anything malformed is dropped WHOLE rather than partially
// trusted: a half-read list that still claims 'captured' is worse than no evidence at all, because the
// reader would take it as a complete account of what the run touched. Dropping yields "absent", which
// callers already treat as "this run predates the evidence" — an honest state, not a false one.
export const sanitizeFileEvidence = (value: unknown): NotebookRunFileEvidence | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  const readAxis = sanitizeReadAxis(candidate.read)
  const writeAxis = sanitizeWriteAxis(candidate.write)
  if (!readAxis || !writeAxis) return undefined
  return buildFileEvidence(readAxis, writeAxis)
}

const sanitizeReadAxis = (value: unknown): NotebookRunReadEvidence | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  const read = candidate.read
  if (!Array.isArray(read)) return undefined

  const files: NotebookReadFile[] = []
  for (const entry of read) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const file = entry as Record<string, unknown>
    if (typeof file.path !== 'string' || file.path.length === 0) return undefined
    if (typeof file.relativePath !== 'string' || file.relativePath.length === 0) return undefined
    if (!READ_FILE_KINDS.includes(file.kind as NotebookReadFileKind)) return undefined
    if (file.reads !== undefined && !isNonNegativeInteger(file.reads)) return undefined
    files.push({
      path: file.path,
      relativePath: file.relativePath,
      kind: file.kind as NotebookReadFileKind,
      ...(file.reads === undefined ? {} : { reads: file.reads as number })
    })
  }

  switch (candidate.readStatus) {
    case 'captured':
      return capturedReadEvidence(files)
    case 'truncated':
      if (!isNonNegativeInteger(candidate.readTruncatedCount)) return undefined
      return truncatedReadEvidence(files, candidate.readTruncatedCount)
    case 'unsupported':
    case 'unavailable':
      if (!EVIDENCE_REASONS.includes(candidate.readReason as NotebookFileEvidenceReason))
        return undefined
      return {
        read: files,
        readStatus: candidate.readStatus,
        readReason: candidate.readReason as NotebookFileEvidenceReason
      }
    default:
      return undefined
  }
}

// The write axis carries no list of its own (workingFiles already holds it), so only the status has to
// survive a read-back — with the same rule: a status that hides missing data must bring that data.
const sanitizeWriteAxis = (value: unknown): NotebookFileCapture | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  switch (candidate.status) {
    case 'captured':
      return capturedWriteEvidence()
    case 'truncated':
      if (!isNonNegativeInteger(candidate.droppedCount)) return undefined
      return truncatedWriteEvidence(candidate.droppedCount)
    case 'unsupported':
    case 'unavailable':
      if (!EVIDENCE_REASONS.includes(candidate.reason as NotebookFileEvidenceReason))
        return undefined
      return candidate.status === 'unsupported'
        ? unsupportedWriteEvidence(candidate.reason as NotebookFileEvidenceReason)
        : unavailableWriteEvidence(candidate.reason as NotebookFileEvidenceReason)
    case 'unattributed':
      if (!EVIDENCE_REASONS.includes(candidate.reason as NotebookFileEvidenceReason))
        return undefined
      if (candidate.directoryConflict !== 'shared-directory') return undefined
      if (candidate.droppedCount !== undefined && !isNonNegativeInteger(candidate.droppedCount)) {
        return undefined
      }
      if (candidate.observedPaths !== undefined) {
        if (!Array.isArray(candidate.observedPaths)) return undefined
        if (candidate.observedPaths.some((path) => typeof path !== 'string' || path.length === 0)) {
          return undefined
        }
      }
      return unattributedWriteEvidence(candidate.reason as NotebookFileEvidenceReason, {
        droppedCount: candidate.droppedCount as number | undefined,
        observedPaths: candidate.observedPaths as string[] | undefined
      })
    default:
      return undefined
  }
}

// Captures the interpreter metadata persisted alongside run history.
// 'idle' is the resting state between runs; 'running' is written around a live cell/control run;
// 'restarting' covers the window of a restart() in progress; 'terminated' marks a proc dropped for
// being idle or lost to a crash/hard-timeout (see NotebookKernelExecutor). 'shutdown' remains the
// explicit user/app-initiated teardown. 'starting' and 'error' are reserved: proc spawn is transient
// and internal to the executor, and a kernel-level failure currently surfaces as a run-level 'failed'
// status rather than a distinct kernel state.
export type NotebookKernelMetadata = {
  language: 'python'
  pythonPath?: string
  kernelName: string
  runtimeRoot: string
  lastKnownStatus:
    'idle' | 'starting' | 'running' | 'error' | 'shutdown' | 'restarting' | 'terminated'
}

// Stores one durable notebook execution, including code, output, and generated-file references.
export type NotebookRunRecord = {
  runId: string
  cellId: string
  source: NotebookRunSource
  inputKind?: NotebookRunInputKind
  // The kernel that produced this run; python/r are analysis cells, repl/bash are
  // control-plane/shell.
  kernelKind: NotebookKernelKind
  script: string
  status: NotebookRunStatus
  // Base variable names this run's script wrote (assignments/deletions), captured at run time for
  // cross-run staleness detection: a later completed run writing the same name makes this stale.
  variablesWritten?: string[]
  startedAt: number
  endedAt?: number
  cwdBefore?: string
  cwdAfter?: string
  executionCount?: number
  text: NotebookTextOutput
  outputs: NotebookOutput[]
  artifacts: ArtifactFile[]
  workingFiles: NotebookWorkingFile[]
  // New native runs persist the exact registered input Versions. Optional keeps legacy run.json
  // documents readable; repository normalization supplies an empty array for old records.
  inputFiles?: NotebookRunInputFile[]
  // Per-run read/write/capture evidence. Absent on records written before it existed.
  fileEvidence?: NotebookRunFileEvidence
  truncated?: boolean
  // Named env that produced this run (python/r only; omitted for repl/bash).
  environment?: string
  // Immutable completed-run environment evidence. The cache that helped build it is never referenced.
  environmentCapture?: NotebookRunEnvironmentCapture
  environmentManifest?: NotebookEnvironmentManifest
  environmentManifestChecksum?: string
  // The digest of the environment itself, so two runs in one environment can be compared at all: the
  // checksum above hashes the stored document, which carries capture timestamps and therefore never matches.
  environmentManifestFingerprint?: string
  // The protection level this run executed at, captured when the run started — not reconstructed
  // later from whatever the settings happen to say now. A run that produced a questionable result
  // must be answerable with "what was it running under", and the answer has to be the one in force
  // at the time. Absent on records written before protection levels existed (and on embedded
  // constructions that were not given the live protection service).
  executionProtection?: ExecutionProtectionSnapshot
  // Trusted turn/Branch attribution injected by the main-process RPC bridge. Legacy and user-run
  // records may omit it; a supplied Artifact producer must match all five fields.
  rootFrameId?: string
  agentFrameId?: string
  messageBranchId?: string
  runtimeSegmentId?: string
  promptMessageId?: string
  // Why a run ended non-normally. Set to 'app-terminated' when a stale 'running' run is reconciled to
  // 'interrupted' on the next startup (the process died mid-run). Absent for normal completions.
  interruptionReason?: 'app-terminated'
}

// The complete JSON document persisted at each notebook session's run.json path.
export type NotebookRunDocument = {
  version: 1
  projectName: string
  sessionId: string
  artifactSessionId?: string
  workspaceCwd: string
  notebookSessionRoot: string
  dataRoot: string
  kernel: NotebookKernelMetadata
  runs: NotebookRunRecord[]
  updatedAt: number
  // v4 persisted per-language session runtime bindings (wire shape), so a session's bound runtime — and
  // why it may be unavailable — survives an app restart. Reloaded + revalidated on the next session
  // load (a bound runtime that is no longer enabled/detected becomes unavailable, never a silent
  // fallback). Absent for sessions that never bound a runtime.
  runtimeBindings?: NotebookRuntimeBindings
}

// Represents the editable in-memory cell state shown by the notebook preview.
export type NotebookCell = {
  id: string
  language: NotebookLanguage
  code: string
  status: 'idle' | 'receiving-code' | 'running' | 'completed' | 'failed'
  writeId?: string
  executionCount?: number
  latestRunId?: string
}

// Prevents the user terminal and the agent stream from editing the same cell concurrently.
export type NotebookWriteLock = {
  writeId: string
  cellId: string
  source: NotebookRunSource
  startedAt: number
}

// Live per-environment kernel status surfaced in state() for the multi-env preview (design D6). One
// entry per (kind, env) process the session has spawned, keyed by the executor's ProcessKey
// (`${kind}:${env}` for python/r, `repl` for the control kernel). The coarse `kernelStatus` on the
// session state stays the DEFAULT env's status for backward compat; this array is the per-env view.
// In-memory only for now — persisting it into run.json is a separate later task (T8).
export type NotebookEnvironmentStatus = {
  processKey: string
  kind: 'python' | 'r' | 'repl'
  // Resolved env name for python/r; omitted for the env-agnostic repl kernel.
  environment?: string
  status: NotebookKernelMetadata['lastKnownStatus']
  // Set after an R install/uninstall: the live R session won't see the change until it restarts, so
  // the preview surfaces a restart prompt. Only R sets this (Python picks up new packages on import).
  restartRecommended?: boolean
}

// Renderer-facing snapshot of one shared notebook interpreter session.
export type NotebookSessionState = {
  id: string
  sessionId: string
  artifactSessionId?: string
  cwd: string
  notebookSessionRoot: string
  dataRoot: string
  runtimeRoot: string
  pythonPath?: string
  kernelStatus: NotebookKernelMetadata['lastKnownStatus']
  runJsonPath: string
  cells: NotebookCell[]
  activeWrite?: NotebookWriteLock
  activeRunId?: string
  runs: NotebookRunRecord[]
  recentRuns: NotebookRunRecord[]
  // Live per-(kind, env) kernel status view (design D6); empty until the session spawns a kernel.
  environments: NotebookEnvironmentStatus[]
}

// Lightweight session handle used by events and preview tabs to reopen the notebook.
export type NotebookSessionReference = {
  sessionId: string
  projectName: string
  workspaceCwd: string
  notebookSessionRoot: string
  dataRoot: string
  runtimeRoot: string
  runJsonPath: string
}

export type NotebookAvailableEvent = NotebookSessionReference
export type NotebookChangedEvent = NotebookSessionReference

// Extends a run record with workspace roots so the agent can decide what to do next.
export type NotebookRunSummary = Omit<NotebookRunRecord, 'inputFiles'> & {
  inputFiles: NotebookInputFileSummary[]
  notebookSessionRoot: string
  dataRoot: string
  runtimeRoot: string
  pythonPath?: string
  kernelName: string
}

// Common routing fields required by every notebook command.
export type NotebookSessionRequest = {
  projectName?: string
  sessionId: string
  workspaceCwd: string
  provenanceContext?: NotebookRunProvenanceContext
  // Injected only by the authenticated local RPC bridge after resolving the active turn registry.
  // Renderer IPC strips this field before calling the runtime service.
  registeredInputFiles?: NotebookRunInputFile[]
  // Identifies the exact active input lease for this execution. The bridge generates it and the
  // kernel returns it when resolving an immutable input so overlapping runs cannot claim access.
  inputRunLeaseId?: string
}

// Resolves the data kernel ('python' or 'r') that owns a given tab. For python/r tabs the
// answer is the tab itself; for repl/bash tabs it is the most recent data kernel that was
// active when the control run executed. Returns undefined when no data run has ever occurred.
export const resolveDataKernelForTab = (
  runs: NotebookRunRecord[],
  tab: NotebookKernelKind
): 'python' | 'r' | undefined => {
  if (tab === 'python' || tab === 'r') return tab
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]
    if (run && (run.kernelKind === 'python' || run.kernelKind === 'r')) return run.kernelKind
  }
  return undefined
}

export type ExportNotebookResult =
  | { saved: false }
  | {
      saved: true
      filePath: string
    }

// Targets the data kernel for an export. The renderer passes the active tab's kernel so the
// resulting .ipynb uses the matching kernelspec and never falls back to "dominant" — that earlier
// silent rule made mixed sessions misleadingly export the wrong notebook. `repl` and `bash` are
// control-plane runs with no standalone kernelspec; the service translates them to the kernel of the
// most recent data run, or rejects the call when no data run has ever occurred.
export type ExportNotebookKernelRequest = NotebookSessionRequest & {
  kernel: NotebookKernelKind
}

// "Download all" path: every data kernel that actually has runs gets its own .ipynb in a directory
// the user picks, with control-plane runs grouped under the data kernel that was active at the time.
export type ExportNotebookAllRequest = NotebookSessionRequest

export type ExportNotebookAllResult =
  | { saved: false }
  | {
      saved: true
      // The directory the user picked plus the kernel → file basename map. The renderer uses this to
      // confirm "saved <count> notebooks to <dir>" in the footer banner.
      directory: string
      files: Array<{ kernel: 'python' | 'r'; filePath: string }>
    }

// Starts a streamed code write into a notebook cell.
export type BeginNotebookCodeCellRequest = NotebookSessionRequest & {
  cellId?: string
  source?: NotebookRunSource
  language?: NotebookLanguage
  // Named env to bind this cell to; omitted -> the default env for language.
  environment?: string
}

// Appends raw code text to an active write lock.
export type AppendNotebookCodeCellRequest = NotebookSessionRequest & {
  writeId: string
  cellId: string
  delta: string
}

// Releases the write lock after the agent has finished streaming code.
export type FinishNotebookCodeCellRequest = NotebookSessionRequest & {
  writeId: string
  cellId: string
}

// Runs an existing cell in the shared interpreter.
export type RunNotebookCellRequest = NotebookSessionRequest & {
  cellId: string
  timeoutMs?: number
  source?: NotebookRunSource
  inputKind?: NotebookRunInputKind
  // Named env to run this cell in; omitted -> the default env for the cell's language.
  environment?: string
}

// Convenience request that writes a cell and runs it in one command.
export type InspectNotebookVariablesRequest = NotebookSessionRequest

// Live namespace snapshot of a data kernel. The kernel answers only when it
// is alive; the Variables view treats an undefined response as 'unavailable'.
export type NotebookVariable = {
  name: string
  type: string
  shape?: string
  preview?: string
}

export type InspectNotebookVariablesResult = {
  variables: NotebookVariable[]
}

export type ExecuteNotebookCodeRequest = NotebookSessionRequest & {
  code: string
  timeoutMs?: number
  cellId?: string
  source?: NotebookRunSource
  inputKind?: NotebookRunInputKind
  language?: NotebookLanguage
  // Named env to execute in; omitted -> the default env for language.
  environment?: string
}

// Runs code on the control-plane REPL kernel (JS; the only kernel with host.mcp connector access).
// Distinct from data cells: no run history, no NotebookLanguage — just code and an optional timeout.
export type ExecuteNotebookControlRequest = NotebookSessionRequest & {
  code: string
  timeoutMs?: number
}

// Runs one shell command in a fresh, stateless process in the session workspace. Distinct from every
// other kernel: no persistent process, no run history, no NotebookLanguage — just a command and an
// optional timeout.
export type ExecuteShellRequest = NotebookSessionRequest & {
  command: string
  timeoutMs?: number
}
