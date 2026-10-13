import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { NotebookWorkingFile } from '../../shared/notebook'

import { startWorkingFileObservation } from './working-file-observer'

// v2.1.0 (B3): the content identity is the part a third party recomputes, so it is asserted against a
// hash THIS FILE computes — never against a helper of the module under test.

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

let root: string
let sessionRoot: string
let workspaceRoot: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'purescience-working-file-'))
  // The observer's own precondition is that the watched data root sits inside or EQUAL to the session
  // root (working-file-observer.ts: isPathInside(sessionRoot, dataRoot)), so the fixture uses one root
  // for both instead of inventing a layout the observer would refuse as 'observation-unavailable'.
  sessionRoot = root
  workspaceRoot = join(root, 'workspace')
  await mkdir(workspaceRoot, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// The watcher delivers asynchronously, so the test waits a beat after the write instead of assuming its
// own write was observed instantly (a bare assertion here goes red only under parallel load).
const settle = async (ms = 250): Promise<void> => new Promise((done) => setTimeout(done, ms))

const observeChange = async (
  write: () => Promise<void>,
  options: { workspaceCwd?: string } = {}
): Promise<NotebookWorkingFile[]> => {
  const observation = await startWorkingFileObservation({
    dataRoot: root,
    notebookSessionRoot: sessionRoot,
    ...(options.workspaceCwd === undefined ? {} : { workspaceCwd: options.workspaceCwd })
  })
  await write()
  await settle()
  return (await observation.finish()).files
}

describe('working file observation content identity', () => {
  it('records the sha256 of a created file without inventing a before side', async () => {
    const files = await observeChange(
      () => writeFile(join(workspaceRoot, 'result.csv'), 'a,b\n1,2\n'),
      {
        workspaceCwd: workspaceRoot
      }
    )

    const entry = files.find((file) => file.relativePath.endsWith('result.csv'))

    expect(entry?.content?.hashes.after).toBe(sha256('a,b\n1,2\n'))
    expect(entry?.content?.states.after).toBe('recorded')
    expect(entry?.content?.hashes.before).toBeUndefined()
  }, 20000)

  it('records a REAL before hash for a file in the workspace it hashed at run start', async () => {
    await writeFile(join(workspaceRoot, 'table.csv'), 'x\n')

    const files = await observeChange(() => writeFile(join(workspaceRoot, 'table.csv'), 'x\ny\n'), {
      workspaceCwd: workspaceRoot
    })
    const entry = files.find((file) => file.relativePath.endsWith('table.csv'))

    // Both sides observed: the only shape in which a change may claim "from these bytes to those".
    expect(entry?.content?.states).toEqual({ before: 'recorded', after: 'recorded' })
    expect(entry?.content?.hashes.before).toBe(sha256('x\n'))
    expect(entry?.content?.hashes.after).toBe(sha256('x\ny\n'))
  }, 20000)

  it('names the before side instead of guessing when the file is outside the hashed workspace', async () => {
    const outside = join(root, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'loose.csv'), 'x\n')

    const files = await observeChange(() => writeFile(join(outside, 'loose.csv'), 'x\ny\n'), {
      workspaceCwd: workspaceRoot
    })
    const entry = files.find((file) => file.relativePath.endsWith('loose.csv'))

    expect(entry?.content?.states.before).toBe('not-recorded')
    expect(entry?.content?.hashes.before).toBeUndefined()
    expect(entry?.content?.hashes.after).toBe(sha256('x\ny\n'))
  }, 20000)

  it('names an oversized file instead of reading it', async () => {
    const oversized = Buffer.alloc(4 * 1024 * 1024 + 1, 0x61)

    const files = await observeChange(() => writeFile(join(workspaceRoot, 'big.bin'), oversized), {
      workspaceCwd: workspaceRoot
    })
    const entry = files.find((file) => file.relativePath.endsWith('big.bin'))

    expect(entry?.content?.states.after).toBe('too-large')
    expect(entry?.content?.hashes.after).toBeUndefined()
  }, 20000)
})
