import type { ArtifactVersionProvenance } from './artifact-provenance'

// Reproduction verification contract.
//
// The point of this module is the honesty boundary: a Version is only "reproduced" when the
// application itself re-executed the sealed recipe AND every required file compared identical.
// Anything less must say so — a caller-supplied byte match is reported as `bytes-match`, a bound
// (size/count) that stops a comparison is reported as `not-compared`, and an incomplete recipe is
// never partially credited. Deterministic and side-effect free so both the main process and tests
// evaluate the same rules; the surfaces (agent tool, panel) only render what this returns.

export const REPRODUCIBILITY_SCHEMA_VERSION = 1

// A comparison that cannot be performed inside these limits must report `not-compared` — never
// `identical` — so a bound can never silently turn into a pass.
export const REPRODUCIBILITY_MAX_COMPARE_BYTES = 64 * 1024 * 1024
export const REPRODUCIBILITY_MAX_COMPARED_FILES = 200

export type ReproducibilityGapReason =
  | 'artifact-content-unavailable'
  | 'execution-evidence-missing'
  | 'execution-script-truncated'
  | 'environment-evidence-missing'
  | 'environment-evidence-incomplete'
  | 'producer-run-unidentified'
  | 'input-content-unavailable'
  | 'no-re-execution-evidence'
  | 'no-reproduced-files'
  | 'no-counterpart-in-recipe'
  | 'comparison-bound-exceeded'
  | 'comparison-limit-reached'
  | 'reproduction-not-hashed'
  | 'reproduction-file-unreadable'
  | 'reproduction-file-missing'

// Caveats do not block a verdict, but every surface must disclose them. They exist for the parts of a
// recipe that are recorded "best effort" — a cached, partially validated package inventory, for example —
// where refusing to check would make the feature useless while silence would overstate the evidence.
export type ReproducibilityCaveat =
  'environment-inventory-best-effort' | 'environment-inventory-cache-reused'

export type ReproducibilityRecipeFile = {
  filename: string
  sha256: string
  sizeBytes: number
}

export type ReproducibilityRecipeInput = ReproducibilityRecipeFile & {
  association: string
  contentAvailable: boolean
}

export type ReproducibilityRecipeExecution = {
  kernelKind: string
  environmentName?: string
  runs: Array<{
    runId: string
    runIndex: number
    status: string
    scriptBytes: number
  }>
}

export type ReproducibilityRecipeEnvironment = {
  name: string
  kernelKind: string
  runtimeSource: string
  runtimeVersion?: string
  platform?: string
  architecture?: string
  packageCount: number
  packages: Array<{ name: string; version?: string; versionStatus: string }>
  captureStatus: string
  warnings: string[]
}

export type SealedReproducibilityRecipe = {
  schemaVersion: typeof REPRODUCIBILITY_SCHEMA_VERSION
  identity: {
    artifactId: string
    versionId: string
    versionNumber: number
    filename: string
    contentType?: string
  }
  expected: { sha256: string; sizeBytes: number }
  execution: ReproducibilityRecipeExecution | null
  environment: ReproducibilityRecipeEnvironment | null
  inputs: ReproducibilityRecipeInput[]
  sealed: boolean
  unsealedReasons: ReproducibilityGapReason[]
  // Non-blocking disclosures that must travel with every verdict (see ReproducibilityCaveat).
  caveats: ReproducibilityCaveat[]
}

export type ReproducedFileObservation =
  | {
      state: 'observed'
      path: string
      filename: string
      sizeBytes: number
      sha256: string
    }
  | {
      state: 'unreadable'
      path: string
      filename: string
      reason: 'not-found' | 'not-allowed' | 'not-a-file' | 'read-failed'
    }

export type ReproducibilityFileOutcome =
  'identical' | 'content-mismatch' | 'size-mismatch' | 'not-compared'

export type ReproducibilityFileComparison = {
  path: string
  filename: string
  outcome: ReproducibilityFileOutcome
  reason?: ReproducibilityGapReason
  counterpart?: string
  expectedSha256?: string
  reproducedSha256?: string
  expectedSizeBytes?: number
  reproducedSizeBytes?: number
}

export type ReproducibilityVerdict =
  // Only reachable when the application re-executed the sealed recipe itself.
  | 'reproduced'
  // Every compared file matched the sealed Version, but no app-owned re-execution backs it.
  | 'bytes-match'
  | 'not-reproduced'
  | 'inconclusive'
  | 'not-checkable'

export type ReproducibilityEvidenceKind =
  // The app re-ran the recipe (the only path that can yield `reproduced`).
  | 'app-reexecution'
  // Bytes were compared against the sealed Version; nobody re-ran anything.
  | 'external-bytes'
  | 'none'

export type ReproducibilityEvaluation = {
  verdict: ReproducibilityVerdict
  evidenceKind: ReproducibilityEvidenceKind
  counts: {
    compared: number
    identical: number
    mismatched: number
    notCompared: number
  }
  reasons: ReproducibilityGapReason[]
  // Machine labels every surface must render alongside the verdict; they exist so a caller cannot
  // present `bytes-match` as "reproduced" or hide a partial comparison.
  requiredLabels: string[]
}

// One reproduction check, as requested over the artifact RPC and reported back to the agent tool.
export type ArtifactReproducibilityCheckRequest = {
  projectId: string
  appSessionId: string
  artifactId: string
  versionId: string
  // Runtime-owned capability envelope fields. The artifact RPC rejects a request whose envelope does
  // not match the turn's capability, so these are filled from the trusted per-turn handoff — never from
  // the model — exactly like an artifact write.
  artifactStorageSessionId: string
  artifactRunId: string
  // Ask the app to re-run the sealed recipe itself, in an isolated directory, and grade that run's
  // own output. This is a request, not a claim: the verdict only becomes `reproduced` when the app
  // really executed the replay, and a replay that cannot run is reported with its refusal.
  reexecute?: boolean
  // Paths of the files a reproduction produced, compared when the app did not re-run the recipe
  // itself. Ignored for a re-execution: the app grades what it produced, not what it was handed.
  reproducedFiles: string[]
  // Roots the app authorized for this turn (artifact MCP environment). A path outside them becomes a
  // `not-compared` outcome instead of a silent read.
  allowedImportRoots: string[]
  relativeBaseDirs?: string[]
}

export type ArtifactReproducibilityReport = {
  checkedAt: string
  recipe: SealedReproducibilityRecipe
  comparisons: ReproducibilityFileComparison[]
  verdict: ReproducibilityVerdict
  evidenceKind: ReproducibilityEvidenceKind
  counts: ReproducibilityEvaluation['counts']
  reasons: ReproducibilityGapReason[]
  requiredLabels: string[]
  // Whether the app could replay this recipe, and what is missing when it could not. Producing a plan
  // is not executing it: a runnable plan still yields no `reproduced` verdict until the isolated
  // re-execution runner is wired, and the summary says so.
  replay: ReproducibilityReplaySummary | null
}

export type ReproducibilityReplaySummary = {
  runnable: boolean
  refusals: string[]
  notes: string[]
  kernelKind?: string
  stagedInputCount: number
  expectedOutputCount: number
  // Filled in when the app actually ran the replay: what came back, in the same vocabulary the
  // isolated runner uses. Absent means nothing was executed.
  execution?: {
    state: 'completed' | 'failed' | 'timed-out' | 'refused'
    refusal?: string
    detail: string
    producedOutputCount: number
    missingOutputCount: number
  }
}

const uniqueReasons = (reasons: ReproducibilityGapReason[]): ReproducibilityGapReason[] => [
  ...new Set(reasons)
]

// Derives the sealed recipe from the recorded Version provenance. Everything the app captured is
// used as-is; anything missing becomes an explicit `unsealedReasons` entry instead of a guess.
export const buildSealedReproducibilityRecipe = (
  provenance: ArtifactVersionProvenance
): SealedReproducibilityRecipe => {
  const { descriptor, evidence, execution } = provenance
  const unsealedReasons: ReproducibilityGapReason[] = []

  const expectedSha256 = descriptor.checksum?.trim() ?? ''
  if (!expectedSha256) unsealedReasons.push('artifact-content-unavailable')
  if (provenance.contentStatus.state === 'unavailable') {
    unsealedReasons.push('artifact-content-unavailable')
  }

  if (evidence.producer.state === 'unavailable') unsealedReasons.push('producer-run-unidentified')

  let recipeExecution: ReproducibilityRecipeExecution | null = null
  const runs = execution?.runs ?? []
  if (runs.length === 0) {
    unsealedReasons.push('execution-evidence-missing')
  } else {
    if (runs.some((run) => run.scriptTruncated)) unsealedReasons.push('execution-script-truncated')
    if (runs.some((run) => run.script.trim().length === 0)) {
      unsealedReasons.push('execution-evidence-missing')
    }
    recipeExecution = {
      kernelKind: runs[0].kernelKind,
      ...(runs[0].environmentName ? { environmentName: runs[0].environmentName } : {}),
      runs: runs.map((run) => ({
        runId: run.runId,
        runIndex: run.runIndex,
        status: run.status,
        scriptBytes: run.script.length
      }))
    }
  }

  const environmentEvidence = evidence.environment
  const caveats: ReproducibilityCaveat[] = []
  let recipeEnvironment: ReproducibilityRecipeEnvironment | null = null
  if (!environmentEvidence || evidence.environment_status.state === 'unavailable') {
    unsealedReasons.push('environment-evidence-missing')
  } else {
    // A best-effort (cached, partially validated) inventory does NOT unseal the recipe: the replay
    // reuses the same managed environment by name instead of recreating it, so an incomplete inventory
    // cannot make the byte comparison lie — a drifted environment shows up as a mismatch, never as a
    // pass. It is disclosed as a caveat instead. Claims about the environment (which packages, which
    // versions) still require a complete capture, which is why the caveat travels with the verdict.
    if (
      environmentEvidence.installed_inventory.validation !== 'full-scan' ||
      environmentEvidence.capture_status !== 'complete' ||
      !environmentEvidence.complete
    ) {
      caveats.push('environment-inventory-best-effort')
    }
    if (environmentEvidence.installed_inventory.source === 'cache-reused') {
      caveats.push('environment-inventory-cache-reused')
    }
    recipeEnvironment = {
      name: environmentEvidence.environment_name,
      kernelKind: environmentEvidence.kernel_kind,
      runtimeSource: environmentEvidence.runtime_source,
      ...(environmentEvidence.runtime_version
        ? { runtimeVersion: environmentEvidence.runtime_version }
        : {}),
      ...(environmentEvidence.platform ? { platform: environmentEvidence.platform } : {}),
      ...(environmentEvidence.architecture
        ? { architecture: environmentEvidence.architecture }
        : {}),
      packageCount: environmentEvidence.packages.length,
      packages: environmentEvidence.packages.map((entry) => ({
        name: entry.name,
        ...(entry.version ? { version: entry.version } : {}),
        versionStatus: entry.version_status
      })),
      captureStatus: environmentEvidence.capture_status,
      warnings: environmentEvidence.warnings ?? []
    }
  }

  const unavailableInputIds = new Set(
    (execution?.inputFiles ?? [])
      .filter((file) => file.availability.state === 'unavailable')
      .map((file) => file.inputFileVersionId)
  )
  const inputs: ReproducibilityRecipeInput[] = evidence.inputs.map((input) => ({
    filename: input.filename,
    sha256: input.checksum,
    sizeBytes: input.size_bytes,
    association: input.strongest_association,
    contentAvailable: !unavailableInputIds.has(input.input_file_version_id)
  }))
  if (inputs.some((input) => !input.contentAvailable)) {
    unsealedReasons.push('input-content-unavailable')
  }

  const sealedReasons = uniqueReasons(unsealedReasons)

  return {
    schemaVersion: REPRODUCIBILITY_SCHEMA_VERSION,
    identity: {
      artifactId: evidence.artifact_id,
      versionId: evidence.version_id,
      versionNumber: evidence.version_number,
      filename: evidence.filename,
      ...(evidence.content_type ? { contentType: evidence.content_type } : {})
    },
    expected: { sha256: expectedSha256, sizeBytes: descriptor.size },
    execution: recipeExecution,
    environment: recipeEnvironment,
    inputs,
    sealed: sealedReasons.length === 0,
    unsealedReasons: sealedReasons,
    caveats: [...new Set(caveats)]
  }
}

const unreadableReason = (
  reason: Extract<ReproducedFileObservation, { state: 'unreadable' }>['reason']
): ReproducibilityGapReason =>
  reason === 'not-found' ? 'reproduction-file-missing' : 'reproduction-file-unreadable'

// Compares one reproduced file against its counterpart in the sealed recipe. Returned outcomes are
// ordered from "cannot judge" to "judged": any reason to withhold a verdict wins over an equality.
export const compareReproducedFile = ({
  observed,
  counterpart,
  alreadyCompared
}: {
  observed: ReproducedFileObservation
  counterpart?: ReproducibilityRecipeFile
  alreadyCompared: number
}): ReproducibilityFileComparison => {
  const base = { path: observed.path, filename: observed.filename }

  if (observed.state === 'unreadable') {
    return {
      ...base,
      outcome: 'not-compared',
      reason: unreadableReason(observed.reason),
      ...(counterpart
        ? { counterpart: counterpart.filename, expectedSizeBytes: counterpart.sizeBytes }
        : {})
    }
  }

  if (!counterpart) {
    return {
      ...base,
      outcome: 'not-compared',
      reason: 'no-counterpart-in-recipe',
      reproducedSizeBytes: observed.sizeBytes,
      reproducedSha256: observed.sha256
    }
  }

  const withCounterpart = {
    ...base,
    counterpart: counterpart.filename,
    expectedSha256: counterpart.sha256,
    expectedSizeBytes: counterpart.sizeBytes,
    reproducedSha256: observed.sha256,
    reproducedSizeBytes: observed.sizeBytes
  }

  if (alreadyCompared >= REPRODUCIBILITY_MAX_COMPARED_FILES) {
    return { ...withCounterpart, outcome: 'not-compared', reason: 'comparison-limit-reached' }
  }
  if (
    observed.sizeBytes > REPRODUCIBILITY_MAX_COMPARE_BYTES ||
    counterpart.sizeBytes > REPRODUCIBILITY_MAX_COMPARE_BYTES
  ) {
    return { ...withCounterpart, outcome: 'not-compared', reason: 'comparison-bound-exceeded' }
  }
  if (!observed.sha256) {
    return { ...withCounterpart, outcome: 'not-compared', reason: 'reproduction-not-hashed' }
  }
  if (observed.sizeBytes !== counterpart.sizeBytes) {
    return { ...withCounterpart, outcome: 'size-mismatch' }
  }

  return {
    ...withCounterpart,
    outcome: observed.sha256 === counterpart.sha256 ? 'identical' : 'content-mismatch'
  }
}

// Turns per-file outcomes into one verdict. The order below is the whole guarantee: an unsealed
// recipe cannot be checked, missing re-execution cannot be `reproduced`, one mismatch is enough to
// fail, and any file left uncompared can only ever yield `inconclusive`.
export const evaluateArtifactReproduction = ({
  recipe,
  reexecuted,
  comparisons
}: {
  recipe: SealedReproducibilityRecipe
  reexecuted: boolean
  comparisons: ReproducibilityFileComparison[]
}): ReproducibilityEvaluation => {
  const counted = (outcome: ReproducibilityFileOutcome): number =>
    comparisons.filter((comparison) => comparison.outcome === outcome).length
  const counts = {
    compared: comparisons.length - counted('not-compared'),
    identical: counted('identical'),
    mismatched: counted('content-mismatch') + counted('size-mismatch'),
    notCompared: counted('not-compared')
  }
  const requiredLabels: string[] = [
    // Caveats travel with every verdict, including a refusal, so no surface can quote the outcome
    // without the disclosure that came with it.
    ...recipe.caveats
  ]
  const reasons = comparisons
    .map((comparison) => comparison.reason)
    .filter((reason): reason is ReproducibilityGapReason => reason !== undefined)

  if (!recipe.sealed) {
    requiredLabels.push('recipe-not-sealed', 'per-file-outcomes')
    return {
      verdict: 'not-checkable',
      evidenceKind: 'none',
      counts,
      reasons: uniqueReasons([...recipe.unsealedReasons, ...reasons]),
      requiredLabels
    }
  }

  if (comparisons.length === 0) {
    requiredLabels.push('no-reproduced-files', 'per-file-outcomes')
    return {
      verdict: 'not-checkable',
      evidenceKind: reexecuted ? 'app-reexecution' : 'none',
      counts,
      reasons: uniqueReasons(['no-reproduced-files', ...reasons]),
      requiredLabels
    }
  }

  const evidenceKind: ReproducibilityEvidenceKind = reexecuted
    ? 'app-reexecution'
    : 'external-bytes'
  if (!reexecuted) requiredLabels.push('external-bytes-no-reexecution')
  if (counts.notCompared > 0) requiredLabels.push('partial-comparison')
  requiredLabels.push('per-file-outcomes')

  if (counts.mismatched > 0) {
    return {
      verdict: 'not-reproduced',
      evidenceKind,
      counts,
      reasons: uniqueReasons(reasons),
      requiredLabels
    }
  }

  if (counts.notCompared > 0) {
    return {
      verdict: 'inconclusive',
      evidenceKind,
      counts,
      reasons: uniqueReasons(['no-re-execution-evidence', ...reasons]),
      requiredLabels
    }
  }

  if (!reexecuted) {
    return {
      verdict: 'bytes-match',
      evidenceKind,
      counts,
      reasons: uniqueReasons(['no-re-execution-evidence', ...reasons]),
      requiredLabels
    }
  }

  return {
    verdict: 'reproduced',
    evidenceKind,
    counts,
    reasons: uniqueReasons(reasons),
    requiredLabels
  }
}
