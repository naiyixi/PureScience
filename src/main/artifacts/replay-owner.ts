import {
  REPLAY_RECIPE_FORMAT_VERSION,
  compareReplayEnvironment,
  type ReplayEnvironmentComparison,
  type ReplayReport,
  type SealedFileDigest,
  type SealedRecipe
} from '../../shared/replay-verification'
import {
  createArtifactReplayRunner,
  type ReplayRunOutcome,
  type ReplayRunnerPorts
} from './replay-runner'

// Putting a recorded version back on the bench: read what it says about itself, rebuild its inputs in a
// fresh directory, run the code it recorded, and compare the result with what it recorded producing.
//
// Everything this needs already exists in the app — the recorder wrote the code (`reproduction_code`), the
// inputs (with their digests and storage keys) and the environment manifest checksum. What was missing
// was the bench. Two bounds are stated rather than implied:
//
//   * the environment claim is a digest comparison and nothing else: `matched` needs a digest on BOTH sides
//     and needs them to be equal. A missing digest on either side is its own named outcome
//     (`not-recorded` / `not-reported`) — "we could not compare" is never dressed up as "they differed" —
//     and a replay that never executed (`not-run`) makes no environment claim at all;
//   * a version that carries no recorded code cannot be re-run at all, and says so instead of running
//     something else and calling it reproduction.
/** One recorded input, addressed the way the app already addresses stored content. */
export type ReplayableInput = {
  /** Where the input sat when the recording was made; the re-run reproduces that relative layout. */
  path: string
  sha256: string
  sizeBytes: number
  fileId: string
  versionId: string
  /** Where the input's bytes live, so the adapter resolves it the way the recorder saw it. */
  sourceProjectId?: string
  sourceSessionId?: string
}

export type ReplayableVersion = {
  projectId: string
  appSessionId: string
  projectName?: string
  filename: string
  checksum: string
  sizeBytes: number
  /** The code the recorder captured from the run that produced this version. */
  reproductionCode?: string
  /** `executed` only when the version carries a producer record; otherwise its steps are inferred. */
  origin: 'executed' | 'reconstructed'
  inputs: readonly ReplayableInput[]
  environmentManifestChecksum?: string
  /**
   * The environment-defining digest recorded for this run. Compared instead of the checksum above, which
   * hashes a stored document and therefore differs between two runs of one environment.
   */
  environmentFingerprint?: string
  language: string
}

export type ReplayVersionOutcome = ReplayRunOutcome & {
  /** Five named environment outcomes (see compareReplayEnvironment); never a boolean. */
  environment: ReplayEnvironmentComparison
  /** Named so the caller never has to guess why nothing was compared. */
  stopped?: 'no-recorded-code' | 'version-unreadable'
  environmentManifestChecksum?: string
}

export type ArtifactReplayOwnerPorts = {
  readVersion: (request: {
    projectId: string
    appSessionId: string
    artifactId: string
    versionId: string
  }) => Promise<ReplayableVersion | undefined>
  /** Writes the recorded inputs into the workspace at their recorded relative paths. */
  materializeInputs: (workspace: string, inputs: readonly ReplayableInput[]) => Promise<void>
  createWorkspace: (projectName: string) => Promise<string>
  removeWorkspace: (workspace: string) => Promise<void>
  readFileBase64: (path: string) => Promise<string | undefined>
  digest: (base64: string) => string
  /** Runs the code through the app's own notebook execution, in the given working directory. */
  executeNotebook: (request: {
    projectName?: string
    sessionId: string
    workspaceCwd: string
    code: string
    language: string
    timeoutMs?: number
  }) => Promise<
    | {
        status: 'completed'
        stdout: string
        stderr: string
        environmentManifestChecksum?: string
        environmentFingerprint?: string
        cwdBefore?: string
        cwdAfter?: string
      }
    | {
        status: 'failed'
        stdout: string
        stderr: string
        traceback: string
        cwdBefore?: string
        cwdAfter?: string
      }
    | { status: 'timeout'; stdout: string; stderr: string }
    | { status: 'unavailable'; reason: string }
  >
  appVersion: () => string
}

export type ArtifactReplayOwner = {
  replayVersion: (request: {
    projectId: string
    appSessionId: string
    artifactId: string
    versionId: string
    timeoutMs?: number
  }) => Promise<ReplayVersionOutcome>
}

const joinPath = (workspace: string, relative: string): string =>
  `${workspace.replace(/\/+$/, '')}/${relative.replace(/^\/+/, '')}`

export const createArtifactReplayOwner = (
  ports: ArtifactReplayOwnerPorts
): ArtifactReplayOwner => ({
  replayVersion: async (request) => {
    const version = await ports.readVersion(request)
    if (!version) {
      return {
        report: {
          mode: 're-run',
          verdict: 'unverifiable',
          origin: 'executed',
          files: [],
          reasons: ['Not verifiable: this version could not be read']
        },
        environment: 'not-run',
        execution: { skipped: 'reconstructed-recipe' },
        stopped: 'version-unreadable'
      }
    }

    // No recorded code means no re-run. Running the model's guess instead is the one thing this must not
    // do, so the answer is "cannot", stated plainly.
    if (!version.reproductionCode) {
      return {
        report: {
          mode: 're-run',
          verdict: 'unverifiable',
          origin: version.origin,
          files: [],
          reasons: [
            'Not verifiable: this version recorded no code, so there is nothing to run again'
          ]
        },
        environment: 'not-run',
        execution: { skipped: 'reconstructed-recipe' },
        stopped: 'no-recorded-code'
      }
    }

    const outputs: SealedFileDigest[] = [
      {
        path: version.filename,
        sha256: version.checksum,
        sizeBytes: version.sizeBytes
      }
    ]
    const recipe: SealedRecipe = {
      formatVersion: REPLAY_RECIPE_FORMAT_VERSION,
      appVersion: ports.appVersion(),
      origin: version.origin,
      inputs: version.inputs.map((input) => ({
        path: input.path,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes
      })),
      outputs
    }

    let environmentManifestChecksum: string | undefined
    let environmentFingerprint: string | undefined
    const runnerPorts: ReplayRunnerPorts = {
      createWorkspace: () => ports.createWorkspace(version.projectId),
      // The recorded inputs, not a guess: the adapter resolves each one through the app's own content
      // resolution and writes it where the recording says it was. The runner speaks in digests, so the
      // recorded entries are matched back by path before handing them over.
      materializeInputs: (workspace, sealed) => {
        const recorded = version.inputs.filter((input) =>
          sealed.some((candidate) => candidate.path === input.path)
        )
        return ports.materializeInputs(workspace, recorded)
      },
      execute: async ({ code, language, cwd, timeoutMs }) => {
        const startedAt = Date.now()
        const result = await ports.executeNotebook({
          projectName: version.projectId,
          sessionId: version.appSessionId,
          workspaceCwd: cwd,
          code,
          language,
          timeoutMs
        })
        const durationMs = Date.now() - startedAt
        if (result.status === 'unavailable') return { status: 'no-runtime', language }
        if (result.status === 'timeout') {
          return { status: 'timeout', durationMs, stderr: result.stderr }
        }
        if (result.status === 'failed') {
          return {
            status: 'ran',
            stdout: result.stdout,
            stderr: `${result.stderr}\n${result.traceback}`.trim(),
            ranIn: result.cwdAfter ?? result.cwdBefore,
            exitCode: 1,
            durationMs
          }
        }
        environmentManifestChecksum = result.environmentManifestChecksum
        environmentFingerprint = result.environmentFingerprint
        return {
          status: 'ran',
          stdout: result.stdout,
          stderr: result.stderr,
          ranIn: result.cwdAfter ?? result.cwdBefore,
          exitCode: 0,
          durationMs
        }
      },
      readProduced: (workspace, path) => ports.readFileBase64(joinPath(workspace, path)),
      producedOutsideWorkspace: async (dir, path) =>
        (await ports.readFileBase64(joinPath(dir, path))) !== undefined,
      digest: ports.digest,
      removeWorkspace: ports.removeWorkspace,
      appVersion: ports.appVersion
    }

    const runner = createArtifactReplayRunner(runnerPorts)
    const outcome = await runner.replay({
      recipe,
      code: version.reproductionCode,
      language: version.language,
      outputPath: version.filename,
      // The environment claim is decided after the run, not before: the kernel reports which environment it
      // actually used, and only then can it be compared with the one the Version recorded.
      timeoutMs: request.timeoutMs
    })

    // The comparison itself lives in shared/replay-verification so the window, the CLI and this caller all
    // read the same five named outcomes. "Could not compare" and "the environments differ" are different
    // facts to a reader, and a replay that never ran claims nothing about the environment.
    const environment = compareReplayEnvironment({
      executed: !('skipped' in outcome.execution),
      ...(version.environmentFingerprint !== undefined
        ? { recordedFingerprint: version.environmentFingerprint }
        : {}),
      ...(environmentFingerprint !== undefined ? { replayFingerprint: environmentFingerprint } : {})
    })

    return {
      ...outcome,
      environment,
      environmentManifestChecksum
    }
  }
})

export type { ReplayReport }
