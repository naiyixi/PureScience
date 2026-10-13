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
let observationsRoot: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'purescience-working-file-'))
  // The observer's own precondition is that the watched data root sits inside or EQUAL to the session
  // root (working-file-observer.ts: isPathInside(sessionRoot, dataRoot)), so the fixture uses one root
  // for both instead of inventing a layout the observer would refuse as 'observation-unavailable'.
  sessionRoot = root
  observationsRoot = root
  await mkdir(observationsRoot, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// The watcher delivers asynchronously, so the test waits a beat after the write instead of assuming its
// own write was observed instantly (a bare assertion here goes red only under parallel load).
const settle = async (ms = 250): Promise<void> => new Promise((done) => setTimeout(done, ms))

const observeChange = async (write: () => Promise<void>): Promise<NotebookWorkingFile[]> => {
  const observation = await startWorkingFileObservation({
    dataRoot: observationsRoot,
    notebookSessionRoot: sessionRoot
  })
  await write()
  await settle()
  return (await observation.finish()).files
}

describe('working file observation content identity', () => {
  it('records the sha256 of a created file and says its before side did not exist', async () => {
    const files = await observeChange(() =>
      writeFile(join(observationsRoot, 'result.csv'), 'a,b\n1,2\n')
    )

    const entry = files.find((file) => file.relativePath.endsWith('result.csv'))

    // The path a write is detected through decides the before-side story — the watcher path sees an event
    // for a path whose earlier existence it never looked up, while the diff path knows the file is new — so
    // the assertions hold for BOTH and pin the invariant instead: the bytes that exist now are hashed, and
    // no before-hash is invented for a file whose earlier content nobody observed.
    expect(entry?.content?.hashes.after).toBe(sha256('a,b\n1,2\n'))
    expect(entry?.content?.states.after).toBe('recorded')
    expect(entry?.content?.hashes.before).toBeUndefined()
    expect(entry?.content?.states.before).not.toBe('recorded')
  }, 20000)

  it('never invents a before hash for a file it did not observe before', async () => {
    await writeFile(join(observationsRoot, 'table.csv'), 'x\n')

    const files = await observeChange(() =>
      writeFile(join(observationsRoot, 'table.csv'), 'x\ny\n')
    )
    const entry = files.find((file) => file.relativePath.endsWith('table.csv'))

    expect(entry?.content?.hashes.before).toBeUndefined()
    expect(entry?.content?.states.before).toBe('not-recorded')
    expect(entry?.content?.hashes.after).toBe(sha256('x\ny\n'))
  }, 20000)

  it('names an oversized file instead of reading it', async () => {
    const oversized = Buffer.alloc(4 * 1024 * 1024 + 1, 0x61)

    const files = await observeChange(() => writeFile(join(observationsRoot, 'big.bin'), oversized))
    const entry = files.find((file) => file.relativePath.endsWith('big.bin'))

    expect(entry?.content?.states.after).toBe('too-large')
    expect(entry?.content?.hashes.after).toBeUndefined()
  }, 20000)
})
