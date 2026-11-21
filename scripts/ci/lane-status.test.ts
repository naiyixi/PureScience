import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { laneStatus, moduleUrlFor } from './lane-status.mjs'
import { visualRegressionStatus } from './visual-regression-status.mjs'

const writeCode = async (contents: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'lane-status-'))
  const path = join(directory, 'exit-code')
  await writeFile(path, contents)

  return path
}

describe('soft lane certification status', () => {
  it('reads a zero exit code as passed and anything else as failed', async () => {
    expect(laneStatus(await writeCode('0\n'))).toBe('passed')
    // A real disagreement: the lane ran and the product/assertion differed.
    expect(laneStatus(await writeCode('1\n'))).toBe('failed')
    // Playwright exits 130 on SIGINT; any non-zero is still "ran and did not agree".
    expect(laneStatus(await writeCode('130'))).toBe('failed')
    // A signal death (SIGSEGV on a Windows runner) is not a pass either.
    expect(laneStatus(await writeCode('-11\n'))).toBe('failed')
  })

  it('says "did not run" only when there is nothing to read', async () => {
    expect(laneStatus(join(tmpdir(), 'no-such-lane-exit-code'))).toBe('not-applicable')
    expect(laneStatus(undefined)).toBe('not-applicable')
    expect(laneStatus(await writeCode(''))).toBe('not-applicable')
  })

  it('fails closed on a file that says something that is not an exit code', async () => {
    // Silently calling this "not-applicable" would erase the evidence that the lane was attempted.
    await expect(async () => laneStatus(await writeCode('boom'))).rejects.toThrow(/not a number/)
  })

  it('keeps the visual lane entry point reading the same file the same way', async () => {
    // Two entry points, one judge: if the wrapper ever drifted, the record could say `failed` for the
    // visual lane and `passed` for the P0 lane on identical input.
    expect(visualRegressionStatus(await writeCode('0\n'))).toBe('passed')
    expect(visualRegressionStatus(await writeCode('1\n'))).toBe(laneStatus(await writeCode('1\n')))
  })

  it('normalises a Windows argv path so the CLI entry still fires there', () => {
    // The bug this pins: on the Windows runner `process.argv[1]` comes back as `D:\\a\\...\\lane-status.mjs`,
    // so the naive `file://${argv[1]}` comparison was false, the script printed nothing, and the record
    // writer rejected an empty `--electron-p0` (run 44879328011, windows-x64).
    expect(moduleUrlFor('D:\\a\\PureScience\\scripts\\ci\\lane-status.mjs')).toBe(
      'file:///D:/a/PureScience/scripts/ci/lane-status.mjs'
    )
    // The POSIX form must keep working, since the visual lane reads it on macOS.
    expect(moduleUrlFor('/Users/x/lane-status.mjs')).toBe('file:///Users/x/lane-status.mjs')
    expect(moduleUrlFor(undefined)).toBe('')
  })

  it('prints a reading when invoked as a program, and prints nothing when imported', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { fileURLToPath } = await import('node:url')
    const run = promisify(execFile)
    const { stdout } = await run(process.execPath, [
      fileURLToPath(new URL('./lane-status.mjs', import.meta.url)),
      await writeCode('1\n')
    ])
    // "printed nothing" is exactly how the Windows job failed: silence must not be mistakable for a pass.
    expect(stdout.trim()).toBe('failed')
  })
})
