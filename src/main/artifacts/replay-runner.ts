import {
  compareReplayOutputs,
  type ReplayExecution,
  type ReplayExecutionEnvironment,
  type ReplayRunOutcome,
  type SealedFileDigest,
  type SealedRecipe
} from '../../shared/replay-verification'
import { resolve } from 'node:path'

// Re-running a recorded artifact in a fresh directory and comparing what comes out with what was
// recorded. This is the half of reproducibility that a digest comparison cannot reach: it executes the
// code again rather than re-reading what it produced.
//
// The claim is deliberately bounded, and the bounds are in the report rather than in a footnote:
//
//   * the working directory is fresh and the recorded inputs are materialised into it, but the package
//     set is NOT reproduced. `environmentLock` says which of the two happened, and `reproduced` is only
//     ever reported alongside that fact — byte-identical output under an environment we did not rebuild
//     is strong evidence, and calling it "the environment was identical" would be a lie;
//   * a run that fails, times out or produces nothing is `unverifiable`, not `differs`: learning nothing
//     about reproduction is not the same as learning that the result does not reproduce;
//   * a recipe whose steps a model reconstructed is never executed to certify anything. Running inferred
//     code produces a plausible file, which is exactly the failure mode this must not have.
// The outcome vocabulary lives in shared/replay-verification: the report crosses the IPC boundary, so
// its shape cannot belong to one side of it.
export type {
  ReplayExecution,
  ReplayExecutionEnvironment,
  ReplayRunOutcome
} from '../../shared/replay-verification'

/** What the execution port can report. Named outcomes, not a sentinel exit code. */
export type ReplayExecuteOutcome =
  | {
      status: 'ran'
      stdout: string
      stderr: string
      exitCode: number
      durationMs: number
      /** The directory the code actually ran in, when the adapter can report it. */
      ranIn?: string
    }
  | { status: 'timeout'; durationMs: number; stderr: string }
  | { status: 'no-runtime'; language: string }
  | { status: 'spawn-failed'; message: string }

export type ReplayRunnerPorts = {
  /** A fresh, empty directory outside the project; the caller owns its removal. */
  createWorkspace: () => Promise<string>
  /** Copies the recipe's recorded inputs into the workspace at their recorded relative paths. */
  materializeInputs: (workspace: string, inputs: readonly SealedFileDigest[]) => Promise<void>
  /**
   * Runs the recorded code in the workspace. The adapter decides how (the app's own kernel path), and
   * reports a named outcome — the runner must never have to read a sentinel to learn what happened.
   */
  execute: (request: {
    code: string
    language: string
    cwd: string
    timeoutMs?: number
  }) => Promise<ReplayExecuteOutcome>
  /** The produced file as base64, or undefined when the run did not produce it. */
  readProduced: (workspace: string, path: string) => Promise<string | undefined>
  /**
   * True when the recorded output exists in the directory the code actually ran in. The adapter owns the
   * filesystem read; the runner only needs to know whether the file was produced somewhere else.
   */
  producedOutsideWorkspace?: (dir: string, path: string) => Promise<boolean>
  digest: (base64: string) => string
  removeWorkspace: (workspace: string) => Promise<void>
  appVersion: () => string
}

export type ReplayRunner = {
  replay: (input: {
    recipe: SealedRecipe
    code: string
    language: string
    /** Workspace-relative path of the output the recipe records. */
    outputPath: string
    environmentLockApplied: boolean
    timeoutMs?: number
  }) => Promise<ReplayRunOutcome>
}

const STDERR_TAIL_LENGTH = 800

/** Why a run did not produce something comparable — the answer has to name the cause, not the symptom. */
export const describeStoppedExecution = (execution: ReplayExecution): string => {
  if (execution.timedOut) return `the re-run timed out after ${execution.durationMs}ms`
  if (execution.exitCode !== 0) {
    const tail = execution.stderrTail.trim()
    return `the re-run exited with code ${String(execution.exitCode)}${
      tail ? `: ${tail.split('\n').slice(-1)[0]}` : ''
    }`
  }
  return 'the re-run finished without producing the recorded output'
}

export const describeReplayExecution = (outcome: ReplayRunOutcome): string => {
  if ('skipped' in outcome.execution) {
    return 'Not run: the recorded steps came from a model reconstruction'
  }
  const { exitCode, timedOut, durationMs } = outcome.execution
  if (timedOut) return `Not verifiable: the re-run timed out after ${durationMs}ms`
  if (exitCode !== 0) return `Not verifiable: the re-run exited with code ${String(exitCode)}`
  return `Ran in ${durationMs}ms`
}

export const createArtifactReplayRunner = (ports: ReplayRunnerPorts): ReplayRunner => ({
  replay: async (input) => {
    const { recipe } = input
    const environmentLock: ReplayExecutionEnvironment = input.environmentLockApplied
      ? 'applied'
      : 'not-applied'

    // Inferred steps are not a recipe: executing them would produce a file that looks like evidence and
    // is not, so the run does not happen and the report says why.
    if (recipe.origin === 'reconstructed') {
      return {
        report: {
          mode: 're-run',
          verdict: 'unverifiable',
          origin: recipe.origin,
          files: [],
          reasons: [
            'Not verifiable: the recorded steps came from a model reconstruction, not from an execution record'
          ]
        },
        environmentLock,
        execution: { skipped: 'reconstructed-recipe' }
      }
    }

    const workspace = await ports.createWorkspace()
    try {
      await ports.materializeInputs(workspace, recipe.inputs)
      const outcome = await ports.execute({
        code: input.code,
        language: input.language,
        cwd: workspace,
        timeoutMs: input.timeoutMs
      })

      // Every way a run can fail to produce something comparable is named here, and none of them is
      // allowed to masquerade as a verdict about reproduction.
      if (outcome.status !== 'ran') {
        const reason =
          outcome.status === 'no-runtime'
            ? `no ${outcome.language} runtime is available to re-run this recording`
            : outcome.status === 'timeout'
              ? `the re-run timed out after ${outcome.durationMs}ms`
              : `the re-run could not be started: ${outcome.message}`
        return {
          report: {
            mode: 're-run',
            verdict: 'unverifiable',
            origin: recipe.origin,
            files: [],
            reasons: [`Not verifiable: ${reason}`]
          },
          environmentLock,
          execution: {
            via: `notebook:${input.language}`,
            exitCode: null,
            timedOut: outcome.status === 'timeout',
            durationMs: outcome.status === 'timeout' ? outcome.durationMs : 0,
            stderrTail:
              outcome.status === 'timeout' ? outcome.stderr.slice(-STDERR_TAIL_LENGTH) : ''
          }
        }
      }

      const execution: ReplayExecution = {
        via: `notebook:${input.language}`,
        exitCode: outcome.exitCode,
        timedOut: false,
        durationMs: outcome.durationMs,
        stderrTail: outcome.stderr.slice(-STDERR_TAIL_LENGTH)
      }

      // A run that did not finish tells us nothing about reproduction — which is not the same as telling
      // us the result does not reproduce.
      if (outcome.exitCode !== 0) {
        return {
          report: {
            mode: 're-run',
            verdict: 'unverifiable',
            origin: recipe.origin,
            files: [],
            reasons: [`Not verifiable: ${describeStoppedExecution(execution)}`]
          },
          environmentLock,
          execution
        }
      }

      const produced = await ports.readProduced(workspace, input.outputPath)
      if (produced === undefined) {
        // The code ran and the recorded file is not where the recipe says it should be. When the adapter can
        // say which directory the code actually ran in, that directory is the difference between "the
        // reproduction failed" and "the run wrote outside the directory being graded" — so say which.
        const ranIn = 'ranIn' in outcome ? outcome.ranIn : undefined
        const outsideWorkspace = ranIn !== undefined && resolve(ranIn) !== resolve(workspace)
        const producedOverThere =
          outsideWorkspace && ranIn !== undefined && ports.producedOutsideWorkspace
            ? await ports.producedOutsideWorkspace(ranIn, input.outputPath)
            : false
        const reason = outsideWorkspace
          ? producedOverThere
            ? `Not verifiable: the re-run executed in ${String(ranIn)} instead of the isolated workspace ${workspace}, and wrote ${input.outputPath} there — the directory being graded never received it`
            : `Not verifiable: the re-run executed in ${String(ranIn)} instead of the isolated workspace ${workspace}, so ${input.outputPath} was written outside the directory being graded`
          : `Not verifiable: the re-run finished without producing ${input.outputPath}, so there is nothing to compare`
        return {
          report: {
            mode: 're-run',
            verdict: 'unverifiable',
            origin: recipe.origin,
            files: [],
            reasons: [reason]
          },
          environmentLock,
          execution
        }
      }

      const outputs: SealedFileDigest[] = [
        {
          path: input.outputPath,
          sha256: ports.digest(produced),
          sizeBytes: Buffer.from(produced, 'base64').length,
          bytes: produced
        }
      ]

      return {
        report: compareReplayOutputs(recipe, { appVersion: ports.appVersion(), outputs }, 're-run'),
        environmentLock,
        execution
      }
    } finally {
      await ports.removeWorkspace(workspace)
    }
  }
})
