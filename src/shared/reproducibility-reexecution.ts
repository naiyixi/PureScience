import type { ReproducibilityReplaySummary, SealedReproducibilityRecipe } from './reproducibility'

// Re-execution planning for a sealed recipe.
//
// This decides — deterministically and before anything is spawned — whether the app may re-run a
// recipe at all, and what exactly would be run. It deliberately refuses more often than it accepts:
// a recipe whose script list does not match what was captured, whose declared inputs have no
// available content, or whose kernel kind has no managed runtime cannot be re-executed faithfully,
// and pretending otherwise would turn a partial run into a "reproduced" verdict.

export const REPRODUCIBILITY_MAX_REEXECUTION_RUNS = 20

export type ReproducibilityReexecutionRefusal =
  | 'recipe-not-sealed'
  | 'execution-evidence-missing'
  | 'execution-evidence-mismatch'
  | 'execution-script-truncated'
  | 'no-execution-script'
  | 'kernel-kind-unsupported'
  | 'run-count-exceeded'
  | 'declared-input-content-unavailable'

export type ReproducibilityReexecutionPlan =
  | {
      runnable: false
      refusals: ReproducibilityReexecutionRefusal[]
      notes: string[]
    }
  | {
      runnable: true
      refusals: []
      kernelKind: 'python' | 'r'
      environmentName?: string
      // The recorded runs, in order. They are replayed inside ONE interpreter session, which is the
      // closest faithful replay of a cell sequence outside the kernel that originally ran it.
      scripts: string[]
      // Declared inputs to stage into the isolated working directory, checksum-verified before use.
      inputs: Array<{ filename: string; sha256: string; sizeBytes: number }>
      // Files graded after the run. Only the sealed Version file is graded: anything else a replay
      // produces has no counterpart in the recipe and is reported as such.
      expectedOutputs: Array<{ filename: string; sha256: string; sizeBytes: number }>
      notes: string[]
    }

const SUPPORTED_KERNEL_KINDS = ['python', 'r'] as const

const supportedKernelKind = (value: string): value is (typeof SUPPORTED_KERNEL_KINDS)[number] =>
  (SUPPORTED_KERNEL_KINDS as readonly string[]).includes(value)

export const planRecipeReexecution = ({
  recipe,
  runs,
  maxRuns = REPRODUCIBILITY_MAX_REEXECUTION_RUNS
}: {
  recipe: SealedReproducibilityRecipe
  // The recorded scripts, read from the persisted execution snapshot (never from the model).
  runs: Array<{ script: string; truncated?: true }>
  maxRuns?: number
}): ReproducibilityReexecutionPlan => {
  const refusals: ReproducibilityReexecutionRefusal[] = []
  const recordedRuns = recipe.execution?.runs ?? []
  const kernelKind = recipe.execution?.kernelKind ?? ''

  if (!recipe.sealed) refusals.push('recipe-not-sealed')
  if (recordedRuns.length === 0) refusals.push('execution-evidence-missing')
  if (recordedRuns.length > 0 && runs.length !== recordedRuns.length) {
    refusals.push('execution-evidence-mismatch')
  }
  if (runs.some((run) => run.truncated)) refusals.push('execution-script-truncated')
  if (runs.length > 0 && runs.every((run) => run.script.trim().length === 0)) {
    refusals.push('no-execution-script')
  }
  if (recordedRuns.length > 0 && !supportedKernelKind(kernelKind)) {
    refusals.push('kernel-kind-unsupported')
  }
  if (runs.length > maxRuns) refusals.push('run-count-exceeded')
  if (recipe.inputs.some((input) => !input.contentAvailable)) {
    refusals.push('declared-input-content-unavailable')
  }

  if (refusals.length > 0 || recordedRuns.length === 0) {
    return {
      runnable: false,
      refusals: refusals.length > 0 ? refusals : ['execution-evidence-missing'],
      notes: [
        'Nothing was re-executed. Fix the missing evidence before treating this Version as replayable.'
      ]
    }
  }

  const notes = [
    'Replay runs the recorded cells in order inside one fresh interpreter session in an isolated working directory.',
    'Only the sealed Version file is graded; other outputs of the replay have no recorded counterpart and are reported as not-compared.'
  ]
  if (runs.length > 1) {
    notes.push(
      'State produced outside the recorded cells (earlier turns, kernels, or manual steps) is not part of the replay.'
    )
  }

  return {
    runnable: true,
    refusals: [],
    kernelKind: kernelKind as 'python' | 'r',
    ...(recipe.execution?.environmentName
      ? { environmentName: recipe.execution.environmentName }
      : {}),
    scripts: runs.map((run) => run.script),
    inputs: recipe.inputs.map((input) => ({
      filename: input.filename,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes
    })),
    expectedOutputs: [
      {
        filename: recipe.identity.filename,
        sha256: recipe.expected.sha256,
        sizeBytes: recipe.expected.sizeBytes
      }
    ],
    notes
  }
}

// Projects a plan into what a report (and therefore the agent) may see: the decision and its reasons,
// never the scripts themselves.
export const summarizeReexecutionPlan = (
  plan: ReproducibilityReexecutionPlan
): ReproducibilityReplaySummary => ({
  runnable: plan.runnable,
  refusals: plan.refusals,
  notes: plan.notes,
  ...(plan.runnable ? { kernelKind: plan.kernelKind } : {}),
  stagedInputCount: plan.runnable ? plan.inputs.length : 0,
  expectedOutputCount: plan.runnable ? plan.expectedOutputs.length : 0
})
