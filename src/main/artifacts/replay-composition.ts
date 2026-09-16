import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { ArtifactVersionProvenance } from '../../shared/artifact-provenance'
import type { NotebookLanguage, NotebookRunSummary } from '../../shared/notebook'
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
  /** Where re-runs build their throwaway working directory. */
  tempRoot?: string
}

const languageOf = (provenance: ArtifactVersionProvenance): string => {
  const producer = provenance.evidence.producer
  if (producer.state !== 'available') return 'python'
  return producer.kernel_kind === 'r' ? 'r' : 'python'
}

export const createArtifactReplayAdapter = (
  deps: ReplayCompositionDeps
): { replayVersion: (request: ReplayVersionRequest) => Promise<ReplayVersionResult> } => {
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
    createWorkspace: () => mkdtemp(join(deps.tempRoot ?? tmpdir(), 'ps-replay-')),
    removeWorkspace: (workspace) => rm(workspace, { recursive: true, force: true }),
    readFileBase64: (path) =>
      readFile(path)
        .then((bytes) => bytes.toString('base64'))
        .catch(() => undefined),
    digest: (base64) => createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex'),
    // The owner asks for a run; this maps the app's run record onto the named outcomes the verdict is
    // built from, so a timeout, a failure and a completed run stay distinguishable all the way up.
    executeNotebook: async (request) => {
      const summary = await deps.executeNotebook({
        projectName: request.projectName,
        sessionId: request.sessionId,
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
          environmentManifestChecksum: summary.environmentManifestChecksum
        }
      }
      return {
        status: 'failed' as const,
        stdout,
        stderr,
        traceback: summary.text?.traceback ?? ''
      }
    },
    appVersion: deps.appVersion
  })

  return { replayVersion: owner.replayVersion }
}
