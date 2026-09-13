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
  now?: () => Date
}

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
      const comparisons: ReproducibilityFileComparison[] = []
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

      const evaluation = evaluateArtifactReproduction({
        recipe,
        reexecuted: request.reexecuted,
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
        requiredLabels: evaluation.requiredLabels
      }
    }
  }
}
