import { AsyncLocalStorage } from 'node:async_hooks'
import type { Dirent } from 'node:fs'
import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { AcpPermissionRequest, AcpPermissionResponse, AcpRuntimeEvent } from '../../shared/acp'
import type {
  FinalizeRunArtifactsRequest,
  FinalizeRunArtifactsResult
} from '../../shared/artifacts'
import type { ReplayVersionRequest } from '../../shared/artifact-replay'
import { benchEvidenceFromSession, type SessionEvidence } from '../../shared/bench-evidence'
import type { Project } from '../../shared/projects'
import type {
  ExportSessionPackageRequest,
  ExportSessionPackageResult
} from '../../shared/session-package'
import type { SessionPackageImportResult } from '../../shared/session-package-import'
import type { PersistedArtifact, PersistedChatSession } from '../../shared/session-persistence'
import {
  readCapabilityNoticeTally,
  type CapabilityNoticeTally
} from '../capabilities/notice-journal'
import type {
  AcquiredTaskArtifact,
  StartTaskRunRequest,
  TaskRun,
  TaskSessionSummary
} from '../../shared/task-api'
import { createApplicationCommandClient } from '../application-command-client'
import type { ApplicationCommandByNameDispatcher } from '../application-command-composition'
import { createTaskCallerContext, type CallerContext } from '../caller-context'
import {
  TaskRunner,
  TaskRunnerError,
  summarizeSession,
  type CreateTaskProjectRequest,
  type TaskAgentPort,
  type TaskRunnerDependencies
} from '../tasks/task-runner'

const TASK_CALLER_CONTEXT = createTaskCallerContext()
// The approval route's context: same headless caller, but carrying the explicit `satisfy-approval`
// authority the permission command requires. Nothing else in the task surface uses it.
const TASK_APPROVAL_CALLER_CONTEXT = createTaskCallerContext({ satisfyApproval: true })

type TaskApiPorts = {
  commands: ApplicationCommandByNameDispatcher
  agent: TaskAgentPort
}

type TaskApiDependencies = {
  createId: () => string
  now: () => number
  subscribeEvents: (listener: (event: AcpRuntimeEvent) => void) => () => void
}

class HeadlessTaskApi {
  private readonly callerContexts = new AsyncLocalStorage<CallerContext>()
  private readonly commandClient = createApplicationCommandClient()
  private readonly runner: TaskRunner

  constructor(
    private readonly ports: TaskApiPorts,
    dependencies: Partial<TaskApiDependencies> = {}
  ) {
    const subscribeEvents = dependencies.subscribeEvents ?? (() => () => undefined)
    // Non-Agent compatibility channels remain temporary façade adapters. Agent execution crosses a
    // direct, narrow port so Task never impersonates an Electron caller for runtime operations.
    this.runner = new TaskRunner({
      projects: {
        list: () => this.invoke('projects:list') as Promise<Project[]>,
        create: (request) => this.invoke('projects:create', request) as Promise<Project>
      },
      sessions: {
        list: async () => {
          // This caller lists sessions for a task and does not decide what the user sees, so it may take a
          // catalog served from memory (the full read is ~55 MB and ~1.4 s on a real data root).
          const result = (await this.invoke('sessions:load-all', {
            allowCachedCatalog: true
          })) as {
            sessions: PersistedChatSession[]
          }
          return result.sessions
        },
        save: async (session) => {
          await this.invoke('sessions:save-session', session)
        }
      },
      agent: {
        withSessionAvailable: (projectId, sessionId, operation) =>
          this.withCurrentCaller(() =>
            this.ports.agent.withSessionAvailable(projectId, sessionId, operation)
          ),
        listAttachedSessionIds: () =>
          this.withCurrentCaller(() => this.ports.agent.listAttachedSessionIds()),
        createSession: (request) =>
          this.withCurrentCaller(() => this.ports.agent.createSession(request)),
        resumeSession: (request) =>
          this.withCurrentCaller(() => this.ports.agent.resumeSession(request)),
        setPermissionProfile: (sessionId, profile) =>
          this.withCurrentCaller(() => this.ports.agent.setPermissionProfile(sessionId, profile)),
        prompt: (request) => this.withCurrentCaller(() => this.ports.agent.prompt(request))
      },
      artifacts: {
        finalizeRun: (request: FinalizeRunArtifactsRequest) =>
          this.invoke('artifacts:finalize-run', request) as Promise<FinalizeRunArtifactsResult>
      },
      previewResources: {
        acquire: (request) =>
          this.invoke('preview-resources:acquire', request) as Promise<{
            id: string
            url: string
            size: number
            mimeType?: string
          }>,
        // Capability cleanup must remain available if request authorization is revoked while a
        // response stream drains. The fixed local automation context grants no new access.
        release: async (resourceId) => {
          await this.commandClient.invoke(
            this.ports.commands,
            'preview-resources:release',
            TASK_CALLER_CONTEXT,
            [{ resourceId }]
          )
        }
      },
      runtimeEvents: { subscribe: subscribeEvents },
      createId: dependencies.createId ?? randomUUID,
      now: dependencies.now ?? Date.now
    } satisfies TaskRunnerDependencies)
  }

  dispose(): void {
    try {
      this.runner.dispose()
    } finally {
      this.commandClient.dispose()
    }
  }

  runWithCallerContext<Result>(context: CallerContext, operation: () => Result): Result {
    return this.callerContexts.run(context, operation)
  }

  listProjects(): Promise<Project[]> {
    return this.runner.listProjects()
  }

  createProject(request: CreateTaskProjectRequest): Promise<Project> {
    return this.runner.createProject(request)
  }

  listSessions(project?: string): Promise<TaskSessionSummary[]> {
    return this.runner.listSessions(project)
  }

  getSession(sessionId: string): Promise<TaskSessionSummary> {
    return this.runner.getSession(sessionId)
  }

  startRun(request: StartTaskRunRequest): Promise<TaskRun> {
    return this.runner.startRun(request)
  }

  getRun(runId: string): TaskRun {
    return this.runner.getRun(runId)
  }

  waitForRun(runId: string): Promise<TaskRun> {
    return this.runner.waitForRun(runId)
  }

  listArtifacts(sessionId: string): Promise<PersistedArtifact[]> {
    return this.runner.listArtifacts(sessionId)
  }

  acquireArtifact(artifactId: string): Promise<AcquiredTaskArtifact> {
    return this.runner.acquireArtifact(artifactId)
  }

  releaseArtifact(resourceId: string): Promise<void> {
    return this.runner.releaseArtifact(resourceId)
  }

  // Read-only projections of judgements that already exist, for the command line (P3-8). Each one calls
  // the same application command the window calls, so the CLI cannot drift from what the UI shows —
  // a second implementation of "is this machine ready" is exactly what this must not become.
  readiness(): Promise<unknown> {
    return this.invoke('settings:check-environment')
  }

  runtimes(): Promise<unknown> {
    return this.invoke('runtime:list-environments')
  }

  connectors(): Promise<unknown> {
    return this.invoke('settings:list-connectors')
  }

  /**
   * The portable-session package, exported to a path the caller names.
   *
   * `purescience package export` and the Web download route both land here, and both call the same
   * application command the window's own export dialog calls — so the three surfaces cannot disagree
   * about what a package contains. A missing destination is the exporter's named refusal
   * (`no-destination`), not a dialog this caller cannot show.
   */
  async sessionPackageExport(request: {
    sessionId: string
    /** Omitted by a caller that only knows the session id; resolved from the catalog it already lists. */
    projectId?: string
    mode: ExportSessionPackageRequest['mode']
    destinationPath: string
  }): Promise<ExportSessionPackageResult> {
    const projectId = request.projectId ?? (await this.projectIdForSession(request.sessionId))
    if (!projectId) {
      throw new TaskRunnerError('session_not_found', `Session not found: ${request.sessionId}`)
    }
    return this.invoke('sessions:export-package', {
      projectId,
      sessionId: request.sessionId,
      mode: request.mode,
      destinationPath: request.destinationPath
    }) as Promise<ExportSessionPackageResult>
  }

  /**
   * Lands a package as a new, read-only session. The caller hands over a PATH (the transport writes the
   * bytes to one first), so this stays a thin pass-through to the importer the window also uses.
   */
  async sessionPackageImport(request: {
    packagePath: string
    /**
     * Where the new session lands. Omitted only when this machine has exactly one project — the importer
     * never guesses between several, because importing into the wrong library is silent and permanent.
     */
    targetProjectId?: string
  }): Promise<SessionPackageImportResult> {
    const targetProjectId = request.targetProjectId ?? (await this.soleProjectId())
    return this.invoke('sessions:import-package', {
      packagePath: request.packagePath,
      confirm: { ...(targetProjectId ? { targetProjectId } : {}) }
    }) as Promise<SessionPackageImportResult>
  }

  private async soleProjectId(): Promise<string | undefined> {
    const projects = (await this.invoke('projects:list')) as Project[]
    return projects.length === 1 ? projects[0]!.id : undefined
  }

  /**
   * Re-runs a recorded artifact version and reports whether the result came back the same, for
   * `purescience replay`. It calls the same command the window calls: a second replay implementation is
   * exactly what would let the command line and the app disagree about what "reproduced" means.
   */
  replayArtifactVersion(request: ReplayVersionRequest): Promise<unknown> {
    return this.invoke('artifacts:replay-version', request)
  }

  /**
   * The permission requests currently waiting for an answer, read from the same runtime snapshot the
   * window renders. A headless service has no window to click, so without this a run that asks for
   * approval waits forever with no way to see why (observed: a plain run stalled after its first
   * notebook tool call, with the reviewer never starting).
   */
  async pendingPermissions(): Promise<AcpPermissionRequest[]> {
    const snapshot = (await this.invoke('acp:get-state')) as {
      pendingPermissions?: AcpPermissionRequest[]
    }
    return snapshot.pendingPermissions ?? []
  }

  /**
   * Answers one of those requests. The id is passed through to the runtime, which rejects an unknown or
   * already-settled request — the command line cannot manufacture an approval that no request backs.
   *
   * This single command runs under the approval caller context (an explicit `satisfy-approval`
   * authority) instead of the generic automation one: approving is what a human at a terminal does,
   * and the capability is named rather than inferred from a relabelled principal.
   */
  respondPermission(response: AcpPermissionResponse): Promise<unknown> {
    return this.commandClient.invoke(
      this.ports.commands,
      'acp:respond-permission',
      TASK_APPROVAL_CALLER_CONTEXT,
      [response]
    )
  }

  /**
   * What a session contributes to a capability preflight beyond its artifacts: the files the user
   * attached and the skills its messages reference. Session records are the only place those live,
   * and `sessions:load-all` is the narrow read that already serves session listing.
   *
   * `usedCapabilities` is a MENTION list, not an execution log — the caller words it that way.
   */
  /**
   * The project a session belongs to, from the same catalog the rest of this surface lists. A package
   * request names a session; the exporter needs the project it lives in, and asking the caller to repeat
   * something the app already knows is how the two get out of step.
   */
  private async projectIdForSession(sessionId: string): Promise<string | null> {
    const result = (await this.invoke('sessions:load-all', { allowCachedCatalog: true })) as {
      sessions: PersistedChatSession[]
    }
    return result.sessions.find((session) => session.id === sessionId)?.projectId ?? null
  }

  async capabilitySessionInputs(sessionId: string): Promise<{
    found: boolean
    attachments: { name: string }[]
    usedCapabilities: string[]
  }> {
    const result = (await this.invoke('sessions:load-all', { allowCachedCatalog: true })) as {
      sessions: PersistedChatSession[]
    }
    const session = result.sessions.find((entry) => entry.id === sessionId)
    if (!session) return { found: false, attachments: [], usedCapabilities: [] }

    const attachments: { name: string }[] = []
    const used = new Set<string>()
    for (const message of session.messages ?? []) {
      for (const upload of message.uploads ?? []) {
        const name = upload.name || upload.originalName
        if (name) attachments.push({ name })
      }
      for (const part of message.parts ?? []) {
        if (part.type === 'skill' && part.id) used.add(part.id)
      }
    }
    return { found: true, attachments, usedCapabilities: [...used] }
  }

  /**
   * The evidence a benchmark case is graded against: the session's transcript, its tool calls and
   * the artifacts it produced. Quantities and citations are deliberately not extracted here — a
   * regex cannot tell whether a number carried provenance, and inventing that would defeat the
   * grader. See shared/bench-evidence.
   */
  async sessionEvidence(sessionId: string): Promise<{
    found: boolean
    evidence: SessionEvidence | null
    /** Present when this session was asked whether it had capability gaps; null when it never was. */
    capabilityNotice: CapabilityNoticeTally | null
  }> {
    const result = (await this.invoke('sessions:load-all', { allowCachedCatalog: true })) as {
      sessions: PersistedChatSession[]
    }
    const session = result.sessions.find((entry) => entry.id === sessionId)
    if (!session) return { found: false, evidence: null, capabilityNotice: null }
    // Session JSON records the artifact's content path, not the name the run used. The file library
    // does carry names, so ask it first and fall back to the session record only when it cannot
    // answer — a grader keyed on filenames is useless without them.
    const artifacts = await this.namedArtifacts(sessionId, session.projectId).catch(() =>
      this.listArtifacts(sessionId)
    )
    // A run that wrote the figure into the notebook directory produced it just the same; include
    // those files so the grader scores the work rather than the publish step.
    const notebookFiles = await this.notebookOutputs(session.cwd)
    const seen = new Set(artifacts.map((artifact) => artifact.path))
    const merged: PersistedArtifact[] = [
      ...artifacts,
      ...notebookFiles
        .filter((file) => !seen.has(file.path))
        .map((file) => ({
          id: file.path,
          kind: 'workspace-file' as const,
          path: file.path,
          name: file.name
        }))
    ]
    return {
      found: true,
      evidence: benchEvidenceFromSession(session, merged),
      // Did this session ever get told about its capability gaps? A benchmark that cannot check its
      // own manipulation reads flat scores as "no effect" when the truth is "nothing happened".
      capabilityNotice: readCapabilityNoticeTally(sessionId)
    }
  }

  /**
   * Files the run left in its notebook data directory. A run may produce a figure by writing a file
   * in the notebook cwd without ever publishing an artifact — the difference is publishing, not
   * producing — so grading on artifacts alone would score the publish step, not the work.
   *
   * Bounded on purpose: two levels deep, hidden directories skipped, capped, and never fatal.
   */
  private async notebookOutputs(
    cwd: string | undefined
  ): Promise<{ path: string; name: string }[]> {
    if (!cwd) return []
    // Only a notebook data directory qualifies, and `run.json` is what marks one. Without this a
    // session whose cwd happens to be `/tmp` (or a home directory) would have unrelated files
    // graded as its outputs.
    try {
      await access(join(cwd, 'run.json'))
    } catch {
      return []
    }
    const found: { path: string; name: string }[] = []
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 2 || found.length >= 200) return
      let entries: Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (found.length >= 200) return
        if (entry.name.startsWith('.')) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full, depth + 1)
          continue
        }
        found.push({ path: full, name: entry.name })
      }
    }
    await walk(cwd, 0)
    return found
  }

  /**
   * Artifacts for one session as the file library sees them: `name` plus the stored path. Throws when
   * the library or the project name is unavailable, so the caller can fall back rather than silently
   * grading against unnamed blobs.
   */
  private async namedArtifacts(sessionId: string, projectId: string): Promise<PersistedArtifact[]> {
    const projects = (await this.invoke('projects:list')) as Project[]
    const projectName = projects.find((project) => project.id === projectId)?.name
    if (!projectName) throw new Error(`No project name for ${projectId}`)
    const files = (await this.invoke('artifacts:list-project-files', {
      projectName
    })) as (PersistedArtifact & { sessionId?: string })[]
    const forSession = files.filter(
      (file) => file.sessionId === undefined || file.sessionId === sessionId
    )
    if (!forSession.length) throw new Error('file library returned nothing for this session')
    return forSession.map((file) => ({
      id: file.id,
      kind: file.kind,
      path: file.path,
      ...(file.name ? { name: file.name } : {})
    }))
  }

  private invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return this.commandClient.invoke(
      this.ports.commands,
      channel,
      this.currentCallerContext(),
      args
    )
  }

  private currentCallerContext(): CallerContext {
    return this.callerContexts.getStore() ?? TASK_CALLER_CONTEXT
  }

  private withCurrentCaller<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (!this.currentCallerContext().isAuthorizationCurrent()) {
      return Promise.reject(new Error('Caller authorization is no longer current.'))
    }
    return operation()
  }
}

export { HeadlessTaskApi, TaskRunnerError as TaskApiError, summarizeSession }
export type { TaskApiDependencies, TaskApiPorts }
