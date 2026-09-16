import { describe, expect, it, vi } from 'vitest'

import { REPLAY_RECIPE_FORMAT_VERSION, type SealedRecipe } from '../../shared/replay-verification'
import {
  createArtifactReplayRunner,
  type ReplayExecuteOutcome,
  type ReplayRunOutcome,
  type ReplayRunnerPorts
} from './replay-runner'

const digest = (value: string): string => `sha256:${Buffer.from(value, 'base64').toString('utf8')}`

const OUTPUT = 'a\tb\n1\t2\n'
const outputDigest = digest(Buffer.from(OUTPUT).toString('base64'))

const recipe = (overrides: Partial<SealedRecipe> = {}): SealedRecipe => ({
  formatVersion: REPLAY_RECIPE_FORMAT_VERSION,
  appVersion: '1.61.0',
  origin: 'executed',
  inputs: [{ path: 'data/in.csv', sha256: digest('a'), sizeBytes: 1 }],
  outputs: [{ path: 'results/out.tsv', sha256: outputDigest, sizeBytes: 8 }],
  ...overrides
})

const harness = (
  overrides: Partial<ReplayRunnerPorts> = {}
): {
  owner: ReturnType<typeof createArtifactReplayRunner>
  ports: ReplayRunnerPorts
  execute: ReturnType<typeof vi.fn>
  removeWorkspace: ReturnType<typeof vi.fn>
} => {
  const execute = vi.fn(async (): Promise<ReplayExecuteOutcome> => ({
    status: 'ran',
    stdout: '',
    stderr: '',
    exitCode: 0,
    durationMs: 42
  }))
  const removeWorkspace = vi.fn().mockResolvedValue(undefined)
  const ports: ReplayRunnerPorts = {
    createWorkspace: vi.fn().mockResolvedValue('/tmp/replay-scratch'),
    materializeInputs: vi.fn().mockResolvedValue(undefined),
    execute,
    readProduced: vi.fn().mockResolvedValue(Buffer.from(OUTPUT).toString('base64')),
    digest,
    removeWorkspace,
    appVersion: () => '1.61.0',
    ...overrides
  }
  // The ports on the object, not the locals: an override replaces one, and the assertions must look at
  // what the runner actually called.
  return {
    owner: createArtifactReplayRunner(ports),
    ports,
    execute: ports.execute as ReturnType<typeof vi.fn>,
    removeWorkspace: ports.removeWorkspace as ReturnType<typeof vi.fn>
  }
}

const run = (
  owner: ReturnType<typeof createArtifactReplayRunner>,
  overrides: Partial<Parameters<typeof owner.replay>[0]> = {}
): Promise<ReplayRunOutcome> =>
  owner.replay({
    recipe: recipe(),
    code: 'print(1)',
    language: 'python',
    outputPath: 'results/out.tsv',
    environmentLockApplied: false,
    ...overrides
  })

describe('artifact replay runner', () => {
  it('reproduces a byte-identical output and does not claim the environment was rebuilt', async () => {
    const { owner } = harness()
    const outcome = await run(owner)

    expect(outcome.report.verdict).toBe('reproduced')
    expect(outcome.report.mode).toBe('re-run')
    // The package set was not reproduced; saying otherwise is the lie this field exists to prevent.
    expect(outcome.environmentLock).toBe('not-applied')
    expect(outcome.execution).toMatchObject({ exitCode: 0, durationMs: 42, via: 'notebook:python' })
  })

  it('reports a re-run that produced different bytes as differing', async () => {
    const { owner } = harness({
      readProduced: vi.fn().mockResolvedValue(Buffer.from('a\tb\n1\t9\n').toString('base64'))
    })
    const outcome = await run(owner)

    expect(outcome.report.verdict).toBe('differs')
    expect(outcome.report.files[0]).toMatchObject({ status: 'differs' })
  })

  it('treats a failing run as unverifiable, naming the exit code and the last line of stderr', async () => {
    const { owner } = harness({
      execute: vi.fn(async (): Promise<ReplayExecuteOutcome> => ({
        status: 'ran',
        stdout: '',
        stderr: 'Traceback\nModuleNotFoundError: No module named pandas\n',
        exitCode: 1,
        durationMs: 30
      }))
    })
    const outcome = await run(owner)

    expect(outcome.report.verdict).toBe('unverifiable')
    // Learning nothing about reproduction is not the same as learning it does not reproduce.
    expect(outcome.report.reasons[0]).toContain('exited with code 1')
    expect(outcome.report.reasons[0]).toContain('No module named pandas')
  })

  it('treats a timeout as unverifiable rather than as a difference', async () => {
    const { owner } = harness({
      execute: vi.fn(async (): Promise<ReplayExecuteOutcome> => ({
        status: 'timeout',
        durationMs: 120000,
        stderr: ''
      }))
    })
    const outcome = await run(owner)

    expect(outcome.report.verdict).toBe('unverifiable')
    expect(outcome.report.reasons[0]).toContain('timed out')
  })

  it('reports a run that finished but produced nothing', async () => {
    // Passing `undefined` for the produced value would fall back to the default parameter, so the
    // absence is stated as an override here.
    const { owner } = harness({ readProduced: vi.fn().mockResolvedValue(undefined) })
    const outcome = await run(owner)

    expect(outcome.report.verdict).toBe('unverifiable')
    expect(outcome.report.reasons[0]).toContain('nothing to compare')
  })

  // The structural rule: inferred code is never executed to certify anything.
  it('refuses to run a reconstructed recipe, and says so instead of guessing', async () => {
    const { owner, execute } = harness()
    const outcome = await run(owner, { recipe: recipe({ origin: 'reconstructed' }) })

    expect(execute).not.toHaveBeenCalled()
    expect(outcome.report.verdict).toBe('unverifiable')
    expect(outcome.report.files).toEqual([])
    expect(outcome.execution).toEqual({ skipped: 'reconstructed-recipe' })
    expect(outcome.report.reasons.join(' ')).toContain('model reconstruction')
  })

  it('says which runtime is missing rather than reporting a difference', async () => {
    const { owner, execute } = harness({
      execute: vi.fn(async (): Promise<ReplayExecuteOutcome> => ({
        status: 'no-runtime',
        language: 'R'
      }))
    })
    const outcome = await run(owner, { language: 'R' })

    expect(execute).toHaveBeenCalledTimes(1)
    expect(outcome.report.verdict).toBe('unverifiable')
    expect(outcome.report.reasons[0]).toContain('no R runtime is available')
  })

  it('cleans up its workspace even when the run fails', async () => {
    const { owner, removeWorkspace } = harness({
      execute: vi.fn(async (): Promise<ReplayExecuteOutcome> => ({
        status: 'ran',
        stdout: '',
        stderr: 'boom',
        exitCode: 2,
        durationMs: 5
      }))
    })
    await run(owner)

    expect(removeWorkspace).toHaveBeenCalledWith('/tmp/replay-scratch')
  })

  it('hands the recorded code to the runtime verbatim, from the workspace', async () => {
    const { owner, execute } = harness()
    const code = 'print("a \'b\' \\n c")'
    await run(owner, { code })

    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][0]).toMatchObject({
      code,
      language: 'python',
      cwd: '/tmp/replay-scratch'
    })
  })
})
