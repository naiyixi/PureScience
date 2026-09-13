import type {
  ArtifactVersionProvenance,
  GetArtifactVersionProvenanceRequest
} from '../../shared/artifact-provenance'
import {
  buildSealedReproducibilityRecipe,
  compareReproducedFile,
  evaluateArtifactReproduction,
  REPRODUCIBILITY_MAX_COMPARED_FILES,
  type ArtifactReproducibilityCheckRequest,
  type ArtifactReproducibilityReport,
  type ReproducedFileObservation,
  type ReproducibilityFileComparison,
  type ReproducibilityRecipeFile,
  type SealedReproducibilityRecipe
} from '../../shared/reproducibility'
import {
  planRecipeReexecution,
  summarizeReexecutionPlan,
  type ReproducibilityReexecutionPlan
} from '../../shared/reproducibility-reexecution'
import type { ReplayInputSource, ReplayRunResult } from './reproducibility-replay-runner'

// Reproduction verification service (main process).
//
// It owns exactly two things the shared engine cannot do on its own: reading the recorded Version
// provenance out of SQLite, and turning caller-supplied reproduction paths into observed bytes. Every
// judgement (sealing, per-file outcome, verdict) belongs to `src/shared/reproducibility.ts`, so the
// agent surface, the panel and tests all grade by the same rules.
//
// The app does not re-execute the recipe yet, so `reexecuted` is carried through from the caller and
// an all-identical run without it is reported as `bytes-match`, never `reproduced`.

export type ArtifactReproducibilityServiceOptions = {
  getVersionProvenance: (
    request: GetArtifactVersionProvenanceRequest
  ) => Promise<ArtifactVersionProvenance | undefined>
  // Resolves the path (allow-root checked) and returns its size + SHA-256. Never throws for a
  // rejected path: an unreadable file must become a `not-compared` outcome, not a failed check.
  observeFile: (path: string) => Promise<ReproducedFileObservation>
  // Runs a sealed recipe in isolation. Absent in contexts that may not spawn processes (the check
  // then reports that re-execution is unavailable instead of pretending it happened).
  runReplay?: RecipeReplayPort
  now?: () => Date
}

export type RunnableRecipeReexecutionPlan = Extract<
  ReproducibilityReexecutionPlan,
  { runnable: true }
>

export type RecipeReplayRequest = {
  plan: RunnableRecipeReexecutionPlan
  inputs: ReplayInputSource[]
}

export type RecipeReplayPort = (request: RecipeReplayRequest) => Promise<ReplayRunResult>

export type ArtifactReproducibilityService = {
  check(request: ArtifactReproducibilityCheckRequest): Promise<ArtifactReproducibilityReport>
}

const baseName = (value: string): string => value.split(/[\\/]/u).filter(Boolean).at(-1) ?? value

export const createArtifactReproducibilityService = (
  options: ArtifactReproducibilityServiceOptions
): ArtifactReproducibilityService => {
  const now = options.now ?? ((): Date => new Date())

  // The Version's own file is the primary counterpart; a declared recipe input is the fallback.
  const findCounterpart = (
    recipe: SealedReproducibilityRecipe,
    filename: string
  ): ReproducibilityRecipeFile | undefined => {
    if (filename === recipe.identity.filename) {
      return {
        filename: recipe.identity.filename,
        sha256: recipe.expected.sha256,
        sizeBytes: recipe.expected.sizeBytes
      }
    }

    const input = recipe.inputs.find((entry) => entry.filename === filename)

    return input
      ? { filename: input.filename, sha256: input.sha256, sizeBytes: input.sizeBytes }
      : undefined
  }

  return {
    async check(request) {
      if (request.reproducedFiles.length > REPRODUCIBILITY_MAX_COMPARED_FILES) {
        throw new Error(
          `At most ${REPRODUCIBILITY_MAX_COMPARED_FILES} reproduced files may be compared in one check.`
        )
      }

      const provenance = await options.getVersionProvenance({
        projectId: request.projectId,
        appSessionId: request.appSessionId,
        artifactId: request.artifactId,
        versionId: request.versionId
      })
      if (!provenance) {
        throw new Error('Artifact Version not found in this Project and Session.')
      }

      const recipe = buildSealedReproducibilityRecipe(provenance)
      // The recorded scripts come from the persisted execution snapshot (main process only); the plan
      // decides whether the app could replay them, and says what is missing when it could not.
      const replayPlan = planRecipeReexecution({
        recipe,
        runs: (provenance.execution?.runs ?? []).map((run) => ({
          script: run.script,
          ...(run.scriptTruncated ? { truncated: true as const } : {})
        }))
      })
      let replay = summarizeReexecutionPlan(replayPlan)
      const comparisons: ReproducibilityFileComparison[] = []
      let reexecuted = false

      if (request.reexecute === true && replayPlan.runnable) {
        // The app re-runs the recipe and grades its OWN output: caller-supplied paths are ignored here
        // on purpose, otherwise a caller could hand back the sealed file and claim a reproduction.
        const run: ReplayRunResult = options.runReplay
          ? await options.runReplay({
              plan: replayPlan,
              inputs: provenance.evidence.inputs.map((input) => ({
                filename: input.filename,
                sha256: input.checksum,
                sizeBytes: input.size_bytes,
                path: input.storage_key
              }))
            })
          : {
              state: 'refused',
              refusal: 'replay-not-configured',
              detail: 'Re-execution is not available in this context.',
              outputs: [],
              missingOutputs: [],
              stdoutTail: '',
              stderrTail: ''
            }
        replay = {
          ...replay,
          execution: {
            state: run.state,
            ...(run.refusal ? { refusal: run.refusal } : {}),
            detail: run.detail,
            producedOutputCount: run.outputs.length,
            missingOutputCount: run.missingOutputs.length
          }
        }

        if (run.state !== 'refused') {
          reexecuted = true
          for (const expected of replayPlan.expectedOutputs) {
            const produced = run.outputs.find((output) => output.filename === expected.filename)
            comparisons.push(
              compareReproducedFile({
                observed: produced
                  ? {
                      state: 'observed',
                      path: produced.filename,
                      filename: produced.filename,
                      sizeBytes: produced.sizeBytes,
                      sha256: produced.sha256
                    }
                  : {
                      state: 'unreadable',
                      path: expected.filename,
                      filename: expected.filename,
                      reason: 'not-found'
                    },
                counterpart: expected,
                alreadyCompared: comparisons.length
              })
            )
          }
        }
      } else if (request.reexecute !== true) {
        for (const path of request.reproducedFiles) {
          const observed = await options.observeFile(path)
          const filename = observed.filename || baseName(path)
          comparisons.push(
            compareReproducedFile({
              observed: { ...observed, filename },
              counterpart: findCounterpart(recipe, filename),
              alreadyCompared: comparisons.length
            })
          )
        }
      }

      const evaluation = evaluateArtifactReproduction({
        recipe,
        reexecuted,
        comparisons
      })

      return {
        checkedAt: now().toISOString(),
        recipe,
        comparisons,
        verdict: evaluation.verdict,
        evidenceKind: evaluation.evidenceKind,
        counts: evaluation.counts,
        reasons: evaluation.reasons,
        requiredLabels: evaluation.requiredLabels,
        replay
      }
    }
  }
}
