import { describe, expect, it } from 'vitest'

import type { SealedReproducibilityRecipe } from './reproducibility'
import {
  planRecipeReexecution,
  REPRODUCIBILITY_MAX_REEXECUTION_RUNS,
  summarizeReexecutionPlan
} from './reproducibility-reexecution'

const recipe = (
  overrides: Partial<SealedReproducibilityRecipe> = {}
): SealedReproducibilityRecipe => ({
  schemaVersion: 1,
  identity: {
    artifactId: 'artifact-1',
    versionId: 'version-1',
    versionNumber: 1,
    filename: 'cos.png'
  },
  expected: { sha256: 'a'.repeat(64), sizeBytes: 8 },
  execution: {
    kernelKind: 'python',
    environmentName: 'python',
    runs: [{ runId: 'run-2', runIndex: 2, status: 'completed', scriptBytes: 40 }]
  },
  environment: {
    name: 'python',
    kernelKind: 'python',
    runtimeSource: 'managed',
    packageCount: 1,
    packages: [{ name: 'matplotlib', version: '3.10.0', versionStatus: 'known' }],
    captureStatus: 'complete',
    warnings: []
  },
  inputs: [
    {
      filename: 'groups.csv',
      sha256: 'c'.repeat(64),
      sizeBytes: 20,
      association: 'resolver-accessed',
      contentAvailable: true
    }
  ],
  sealed: true,
  unsealedReasons: [],
  caveats: [],
  ...overrides
})

const recordedRun = { script: 'import matplotlib.pyplot as plt\nplt.plot([1, 2])' }

describe('planRecipeReexecution', () => {
  it('plans a replay of a sealed recipe, with the captured inputs to stage', () => {
    const plan = planRecipeReexecution({ recipe: recipe(), runs: [recordedRun] })

    expect(plan.runnable).toBe(true)
    if (!plan.runnable) throw new Error('expected a runnable plan')
    expect(plan.kernelKind).toBe('python')
    expect(plan.environmentName).toBe('python')
    expect(plan.scripts).toEqual([recordedRun.script])
    expect(plan.inputs).toEqual([{ filename: 'groups.csv', sha256: 'c'.repeat(64), sizeBytes: 20 }])
    expect(plan.expectedOutputs).toEqual([
      { filename: 'cos.png', sha256: 'a'.repeat(64), sizeBytes: 8 }
    ])
    expect(plan.notes.join(' ')).toContain('isolated working directory')
  })

  it('refuses to replay an unsealed recipe', () => {
    const plan = planRecipeReexecution({
      recipe: recipe({ sealed: false, unsealedReasons: ['environment-evidence-incomplete'] }),
      runs: [recordedRun]
    })

    expect(plan.runnable).toBe(false)
    expect(plan.refusals).toContain('recipe-not-sealed')
  })

  it('refuses to replay when the recorded script list does not match the capture', () => {
    const plan = planRecipeReexecution({ recipe: recipe(), runs: [] })

    expect(plan.runnable).toBe(false)
    expect(plan.refusals).toContain('execution-evidence-mismatch')
  })

  it('refuses to replay a truncated script', () => {
    const plan = planRecipeReexecution({
      recipe: recipe(),
      runs: [{ ...recordedRun, truncated: true }]
    })

    expect(plan.runnable).toBe(false)
    expect(plan.refusals).toContain('execution-script-truncated')
  })

  it('refuses to replay an empty script', () => {
    const plan = planRecipeReexecution({ recipe: recipe(), runs: [{ script: '   ' }] })

    expect(plan.runnable).toBe(false)
    expect(plan.refusals).toContain('no-execution-script')
  })

  it('refuses a kernel kind the app cannot replay', () => {
    const plan = planRecipeReexecution({
      recipe: recipe({
        execution: {
          kernelKind: 'julia',
          runs: [{ runId: 'run-2', runIndex: 2, status: 'completed', scriptBytes: 12 }]
        }
      }),
      runs: [recordedRun]
    })

    expect(plan.runnable).toBe(false)
    expect(plan.refusals).toContain('kernel-kind-unsupported')
  })

  it('refuses a recipe longer than the replay bound', () => {
    const runs = Array.from({ length: REPRODUCIBILITY_MAX_REEXECUTION_RUNS + 1 }, (_, index) => ({
      runId: `run-${index}`,
      runIndex: index,
      status: 'completed',
      scriptBytes: 10
    }))
    const plan = planRecipeReexecution({
      recipe: recipe({ execution: { kernelKind: 'python', runs } }),
      runs: runs.map(() => recordedRun)
    })

    expect(plan.runnable).toBe(false)
    expect(plan.refusals).toContain('run-count-exceeded')
  })

  it('refuses to replay when a declared input has no available content', () => {
    const plan = planRecipeReexecution({
      recipe: recipe({
        inputs: [
          {
            filename: 'groups.csv',
            sha256: 'c'.repeat(64),
            sizeBytes: 20,
            association: 'resolver-accessed',
            contentAvailable: false
          }
        ]
      }),
      runs: [recordedRun]
    })

    expect(plan.runnable).toBe(false)
    expect(plan.refusals).toContain('declared-input-content-unavailable')
  })

  it('refuses a recipe with no recorded execution at all', () => {
    const plan = planRecipeReexecution({ recipe: recipe({ execution: null }), runs: [] })

    expect(plan.runnable).toBe(false)
    expect(plan.refusals).toContain('execution-evidence-missing')
  })

  it('warns that state from outside the recorded cells is not replayed', () => {
    const plans = planRecipeReexecution({
      recipe: recipe({
        execution: {
          kernelKind: 'python',
          runs: [
            { runId: 'run-1', runIndex: 1, status: 'completed', scriptBytes: 10 },
            { runId: 'run-2', runIndex: 2, status: 'completed', scriptBytes: 40 }
          ]
        }
      }),
      runs: [{ script: 'df = pd.read_csv("groups.csv")' }, recordedRun]
    })

    expect(plans.runnable).toBe(true)
    if (!plans.runnable) throw new Error('expected a runnable plan')
    expect(plans.scripts).toHaveLength(2)
    expect(plans.notes.join(' ')).toContain('State produced outside the recorded cells')
  })
})

describe('summarizeReexecutionPlan', () => {
  it('reports the decision and its reasons without leaking the scripts', () => {
    const summary = summarizeReexecutionPlan(
      planRecipeReexecution({ recipe: recipe(), runs: [recordedRun] })
    )

    expect(summary).toMatchObject({
      runnable: true,
      kernelKind: 'python',
      stagedInputCount: 1,
      expectedOutputCount: 1
    })
    expect(JSON.stringify(summary)).not.toContain('matplotlib')
  })

  it('keeps the refusal list for a plan that cannot run', () => {
    const summary = summarizeReexecutionPlan(planRecipeReexecution({ recipe: recipe(), runs: [] }))

    expect(summary).toMatchObject({
      runnable: false,
      refusals: ['execution-evidence-mismatch'],
      stagedInputCount: 0,
      expectedOutputCount: 0
    })
    expect(summary.kernelKind).toBeUndefined()
  })
})
