export type PermissionProfile = 'ask' | 'auto' | 'full'
export type RunStatus = 'running' | 'completed' | 'failed'

export type Project = {
  id: string
  name: string
  description: string
  isExample: boolean
  createdAt: number
  updatedAt: number
}

export type Run = {
  id: string
  sessionId: string
  projectId: string
  status: RunStatus
  startedAt: number
  completedAt?: number
  output?: string
  error?: string
  artifacts: Artifact[]
}

export type SessionStatus =
  'idle' | 'running' | 'waiting-permission' | 'waiting-plan-approval' | 'error'

export type Session = {
  id: string
  projectId: string
  title: string
  status: SessionStatus
  permissionProfile?: PermissionProfile
  createdAt: number
  updatedAt: number
  output?: string
  error?: string
  artifactCount: number
}

export type Artifact = {
  id: string
  kind: 'workspace-file' | 'external-file' | 'managed-file'
  path: string
  name?: string
  mimeType?: string
  size?: number
  mtimeMs?: number
  sha256?: string
}

// The payloads below are the app's own projections, read from the HTTP routes the command line also uses.
// Two rules keep these honest:
//   1. Each named member is one a caller actually reads — the fields are the contract, not a copy of the
//      app's internal types (a copy drifts silently the moment the app adds a field).
//   2. Everything else passes through unchanged, which is why every one of them carries an index
//      signature. A projection that grows a member does not break a compiled caller.
export type ReadinessReport = {
  checkedAt: number
  platform: string
  architecture: string
  checks: readonly unknown[]
  ready: boolean
  canAutoInstall: boolean
  agentFrameworkId: string
  runtime: unknown
  [member: string]: unknown
}

export type RuntimeSurvey = {
  python: readonly unknown[]
  r: readonly unknown[]
  [member: string]: unknown
}

export type ConnectorSurvey = {
  connectors: readonly unknown[]
  customServers: readonly unknown[]
  ncbi: unknown
  [member: string]: unknown
}

export type CapabilityReport = {
  /** Named failure families the capability contract speaks in — never free-form text. */
  failureFamilies: Readonly<Record<string, string>>
  declared: readonly unknown[]
  /** Capability ids the app has no contract for. A non-empty list is a question, not an error. */
  undeclared: readonly string[]
  problems: readonly unknown[]
  /** `null` when no session was named: without one the payload reports no per-session facts at all. */
  session: unknown
  [member: string]: unknown
}

/** One request a run is waiting on. A headless service has no card to click, so this is the only view. */
export type PermissionRequest = {
  requestId: string
  sessionId: string
  toolCallId: string
  title: string
  status?: string
  isMcp?: boolean
  mcpIdentity?: string
  options: readonly { optionId: string; name: string; kind: string }[]
  [member: string]: unknown
}

export type ReplayVersionRequest = {
  projectId: string
  appSessionId: string
  artifactId: string
  versionId: string
  /** Bounds the re-run; a recording that takes longer is reported as timed out. */
  timeoutMs?: number
}

export type ReplayVersionReport = {
  /**
   * Which of five named things is true about the environment — never a boolean. `not-recorded` and
   * `not-reported` mean the comparison could not be made, a different sentence from `drifted`.
   */
  environment: unknown
  /** Named so a caller never has to guess why nothing was compared. */
  stopped?: 'no-recorded-code' | 'version-unreadable' | 'not-configured'
  [member: string]: unknown
}

export type SessionPackageImport = {
  ok: true
  sessionId: string
  [member: string]: unknown
}

export class PureScienceApiError extends Error {
  code: string
  status?: number
}

export class PureScienceClient {
  constructor(options: {
    baseUrl: string
    token: string
    fetch?: typeof globalThis.fetch
    sleep?: (milliseconds: number) => Promise<void>
  })
  health(): Promise<unknown>
  listProjects(): Promise<Project[]>
  /** Readiness, runtime survey and connectors: the same judgements the settings window shows. */
  getReadiness(): Promise<ReadinessReport>
  listRuntimes(): Promise<RuntimeSurvey>
  listConnectors(): Promise<ConnectorSurvey>
  /**
   * Capability contracts, and — when a session id is given — whether that session satisfies each one.
   * Without a session the payload reports no facts at all, so the argument is what turns the catalog
   * into a readiness reading.
   */
  getCapabilities(sessionId?: string): Promise<CapabilityReport>
  /** The permission requests a run is waiting on. The only way to see why an unattended run stopped. */
  pendingPermissions(): Promise<PermissionRequest[]>
  /** Answers one of those requests. An unknown or already-settled id is rejected by the app. */
  respondPermission(
    requestId: string,
    options?: { optionId?: string; cancelled?: boolean }
  ): Promise<{ requestId: string }>
  /** Re-run a recorded artifact version and compare the result with what it recorded producing. */
  replayVersion(request: ReplayVersionRequest): Promise<ReplayVersionReport>
  createProject(request: { name: string; description?: string }): Promise<Project>
  listSessions(project?: string): Promise<Session[]>
  getSession(sessionId: string): Promise<Session>
  startRun(request: {
    project: string
    prompt: string
    sessionId?: string
    permissionProfile?: PermissionProfile
    skillIds?: string[]
  }): Promise<Run>
  getRun(runId: string): Promise<Run>
  waitForRun(
    runId: string,
    options?: { pollIntervalMs?: number; signal?: AbortSignal; timeoutMs?: number }
  ): Promise<Run>
  listArtifacts(sessionId: string): Promise<Artifact[]>
  downloadArtifact(artifactId: string, options?: { signal?: AbortSignal }): Promise<Response>
  /**
   * The portable-session package for one session, as the HTTP response that carries the bytes. Same
   * shape as `downloadArtifact` on purpose: both stream a file to a path the caller named.
   */
  downloadSessionPackage(
    sessionId: string,
    options?: { mode?: string; projectId?: string; signal?: AbortSignal }
  ): Promise<Response>
  /**
   * Hands a package's bytes to the app, which lands it as a new read-only session. The bytes travel as
   * the request body rather than base64 in JSON. Local-only authority: a request that arrived through
   * remote access is refused.
   */
  importSessionPackage(
    bytes: BodyInit,
    options?: { projectId?: string; signal?: AbortSignal }
  ): Promise<SessionPackageImport>
  events(options?: {
    signal?: AbortSignal
    WebSocket?: typeof globalThis.WebSocket
  }): AsyncIterable<{
    type: 'run.event' | 'permission.requested'
    data: unknown
  }> & { ready: Promise<void> }
}

export function connectToPureScience(options?: {
  configRoot?: string
  env?: Record<string, string | undefined>
  fetch?: typeof globalThis.fetch
}): Promise<PureScienceClient>
