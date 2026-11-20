import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { visualRegressionStatus } from './visual-regression-status.mjs'

const writeCode = async (contents: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'visual-status-'))
  const path = join(directory, 'visual-regression-exit-code')
  await writeFile(path, contents)

  return path
}

describe('visual regression certification status', () => {
  it('reads a zero exit code as passed and anything else as failed', async () => {
    expect(visualRegressionStatus(await writeCode('0\n'))).toBe('passed')
    // A real disagreement: the comparison ran and the pixels differed.
    expect(visualRegressionStatus(await writeCode('1\n'))).toBe('failed')
    // Playwright exits 130 on SIGINT; any non-zero is still "ran and did not agree".
    expect(visualRegressionStatus(await writeCode('130'))).toBe('failed')
  })

  it('says "did not run" only when there is nothing to read', async () => {
    // The lane was skipped (no packaged app): the file was never written.
    expect(visualRegressionStatus(join(tmpdir(), 'no-such-visual-exit-code'))).toBe(
      'not-applicable'
    )
    expect(visualRegressionStatus(undefined)).toBe('not-applicable')
    // An empty file is a writer that got as far as creating the file but wrote nothing usable.
    expect(visualRegressionStatus(await writeCode(''))).toBe('not-applicable')
  })

  it('fails closed on a file that says something that is not an exit code', async () => {
    // Silently calling this "not-applicable" would erase the evidence that the comparison was attempted.
    await expect(async () => visualRegressionStatus(await writeCode('boom'))).rejects.toThrow(
      /not a number/
    )
  })
})
