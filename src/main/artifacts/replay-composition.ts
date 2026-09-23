import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ArtifactVersionProvenance } from '../../shared/artifact-provenance'
import type { NotebookLanguage, NotebookRunSummary } from '../../shared/notebook'
import type { NotebookRuntimeBindings } from '../../shared/notebook-runtime'
import type { ReplayVersionRequest, ReplayVersionResult } from '../../shared/artifact-replay'
import {
  createArtifactReplayOwner,
  type ReplayableInput,
  type ReplayableVersion
} from './replay-owner'

// Binding the replay owner to the app: the recorder's own evidence supplies the recipe, the app's own
// content resolution supplies the inputs, and the app's own notebook execution runs the code. Nothing
// here re-implements a path that already exists — that is the difference between a re-run and a replica.
export type ReplayCompositionDeps = {
  provenance: {
    getVersionCore: (request: {
      projectId: string
      appSessionId: string
      artifactId: string
      versionId: string
    }) => Promise<ArtifactVersionProvenance>
    resolveVersionContent: (request: {
      projectId: string
      versionId: string
      appSessionId?: string
    }) => Promise<{ path: string; filename: string }>
  }
  /**
   * The app's own notebook execution: the same path that ran the code the first time. It reports a run
   * record, whose status is what the replay verdict is built from — never a guess made from silence.
   */
  executeNotebook: (request: {
    projectName?: string
    sessionId: string
    workspaceCwd: string
    code: string
    language: NotebookLanguage
    timeoutMs?: number
  }) => Promise<NotebookRunSummary>
  appVersion: () => string
  /**
   * The directory a notebook session runs its code in. A re-run executes the code through the app's own
   * kernel, and that kernel is spawned with the session's own directory as its working directory — so the
   * directory being graded has to BE a session directory, not a temp folder the kernel never enters.
   */
  notebookDataRoot: (projectName: string, sessionId: string) => string
  /**
   * The runtime bindings the recorded session was using, so a re-run can start in the same environment
   * rather than whatever the default happens to be. Absent when that session's record is gone.
   */
  readNotebookBindings?: (request: {
    projectName: string
    sessionId: string
  }) => Promise<NotebookRuntimeBindings | undefined>
  /** Binds a runtime to the re-run's own session, before its first cell runs. */
  bindNotebookRuntime?: (request: {
    projectName: string
    sessionId: string
    workspaceCwd: string
    language: NotebookLanguage
    runtimeId: string
  }) => Promise<unknown>
  /** Best-effort teardown of a re-run's own session once its verdict is built. */
  shutdownNotebookSession?: (request: {
    projectName: string
    sessionId: string
    workspaceCwd: string
  }) => Promise<unknown>
}

const languageOf = (provenance: ArtifactVersionProvenance): string => {
  const producer = provenance.evidence.producer
  if (producer.state !== 'available') return 'python'
  return producer.kernel_kind === 'r' ? 'r' : 'python'
}

export const createArtifactReplayAdapter = (
  deps: ReplayCompositionDeps
): { replayVersion: (request: ReplayVersionRequest) => Promise<ReplayVersionResult> } => {
  // Keyed by the working directory: one entry per re-run in flight, so concurrent re-runs cannot borrow
  // each other's session. Absent for a workspace this adapter did not create (tests, and callers that
  // supply their own directory) — those keep the request's own session, as before.
  const replaySessions = new Map<
    string,
    { projectName: string; sessionId: string; bound: boolean }
  >()
  const owner = createArtifactReplayOwner({
    readVersion: async (request): Promise<ReplayableVersion | undefined> => {
      const provenance = await deps.provenance.getVersionCore(request).catch(() => undefined)
      if (!provenance) return undefined
      const evidence = provenance.evidence
      // Only a producer record makes the steps `executed`; without one they are inferred, and the owner
      // refuses to run inferred steps as if they were a recording.
      const executed = evidence.producer.state === 'available'
      const inputs: ReplayableInput[] = evidence.inputs.map((input) => ({
        path: input.filename,
        sha256: input.checksum,
        sizeBytes: input.size_bytes,
        fileId: input.source_file_id,
        // Where this input came from, so the adapter can resolve it exactly as the recorder saw it.
        versionId: input.input_file_version_id,
        sourceProjectId: input.source_project_id,
        sourceSessionId: input.source_session_id
      }))
      return {
        projectId: request.projectId,
        appSessionId: request.appSessionId,
        filename: evidence.filename,
        checksum: evidence.checksum,
        sizeBytes: evidence.size_bytes,
        reproductionCode: evidence.reproduction_code,
        origin: executed ? 'executed' : 'reconstructed',
        inputs,
        environmentManifestChecksum:
          evidence.producer.state === 'available'
            ? evidence.producer.environment_manifest_checksum
            : undefined,
        environmentFingerprint:
          evidence.producer.state === 'available'
            ? evidence.producer.environment_fingerprint
            : undefined,
        language: languageOf(provenance)
      }
    },
    materializeInputs: async (workspace, inputs) => {
      for (const input of inputs) {
        const source = await deps.provenance
          .resolveVersionContent({
            projectId: input.sourceProjectId ?? '',
            versionId: input.versionId,
            appSessionId: input.sourceSessionId
          })
          .catch(() => undefined)
        if (!source) continue
        const destination = join(workspace, input.path)
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, await readFile(source.path))
      }
    },
    // A re-run claims its own notebook session, and grades the directory that session runs in: the kernel
    // cannot be told to run elsewhere (its working directory is fixed when it is spawned), so the only way
    // to grade what actually ran is to run it where it is graded. The recorded session is left untouched.
    createWorkspace: async (projectName) => {
      const sessionId = `replay-${randomBytes(8).toString('hex')}`
      const dataRoot = deps.notebookDataRoot(projectName, sessionId)
      await mkdir(dataRoot, { recursive: true })
      replaySessions.set(dataRoot, { projectName, sessionId, bound: false })
      return dataRoot
    },
    removeWorkspace: async (workspace) => {
      const session = replaySessions.get(workspace)
      replaySessions.delete(workspace)
      if (session) {
        // Shut the kernel down before its directory disappears, so nothing keeps running against a path
        // that is about to stop existing.
        await deps
          .shutdownNotebookSession?.({
            projectName: session.projectName,
            sessionId: session.sessionId,
            workspaceCwd: workspace
          })
          .catch(() => undefined)
      }
      // A kernel that has just been told to stop can still be writing inside its directory: a recursive
      // removal empties what it saw and then fails the final rmdir with ENOTEMPTY, which would make the
      // replay fail for a reason that has nothing to do with the recording. Retry that window instead.
      await rm(session ? dirname(workspace) : workspace, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100
      })
    },
    readFileBase64: (path) =>
      readFile(path)
        .then((bytes) => bytes.toString('base64'))
        .catch(() => undefined),
    digest: (base64) => createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex'),
    // The owner asks for a run; this maps the app's run record onto the named outcomes the verdict is
    // built from, so a timeout, a failure and a completed run stay distinguishable all the way up.
    executeNotebook: async (request) => {
      const session = replaySessions.get(request.workspaceCwd)
      if (session && !session.bound) {
        session.bound = true
        const recorded = await deps
          .readNotebookBindings?.({
            projectName: session.projectName,
            sessionId: request.sessionId
          })
          .catch(() => undefined)
        const language = request.language === 'r' ? 'r' : 'python'
        const binding = recorded?.[language]
        if (binding?.runtimeId) {
          // Same runtime as the run being checked, when its record is still readable; a re-run under a
          // different interpreter would be evidence about a different environment.
          await deps
            .bindNotebookRuntime?.({
              projectName: session.projectName,
              sessionId: session.sessionId,
              workspaceCwd: request.workspaceCwd,
              language,
              runtimeId: binding.runtimeId
            })
            .catch(() => undefined)
        }
      }
      const summary = await deps.executeNotebook({
        projectName: request.projectName,
        sessionId: session?.sessionId ?? request.sessionId,
        workspaceCwd: request.workspaceCwd,
        code: request.code,
        language: request.language === 'r' ? 'r' : 'python',
        timeoutMs: request.timeoutMs
      })
      const stdout = summary.text?.stdout ?? ''
      const stderr = summary.text?.stderr ?? ''
      if (summary.status === 'timeout' || summary.status === 'cancelled') {
        return { status: 'timeout' as const, stdout, stderr }
      }
      if (summary.status === 'completed') {
        return {
          status: 'completed' as const,
          stdout,
          stderr,
          environmentManifestChecksum: summary.environmentManifestChecksum,
          environmentFingerprint: summary.environmentManifestFingerprint,
          // Where the run started and ended: the runner needs it to say whether the code executed in the
          // workspace it is grading, and dropping it here is what made that impossible to tell.
          cwdBefore: summary.cwdBefore,
          cwdAfter: summary.cwdAfter
        }
      }
      return {
        status: 'failed' as const,
        stdout,
        stderr,
        traceback: summary.text?.traceback ?? '',
        cwdBefore: summary.cwdBefore,
        cwdAfter: summary.cwdAfter
      }
    },
    appVersion: deps.appVersion
  })

  return { replayVersion: owner.replayVersion }
}
