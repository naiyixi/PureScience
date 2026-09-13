import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { REPRODUCIBILITY_MAX_COMPARE_BYTES } from '../../shared/reproducibility'
import { createReproductionFileObserver } from './reproduction-file-observer'

let root: string | undefined

const createRoot = async (): Promise<string> => {
  root = await mkdtemp(join(tmpdir(), 'purescience-reproduction-observer-'))
  return root
}

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

describe('createReproductionFileObserver', () => {
  it('observes size and SHA-256 of a file inside the authorized roots', async () => {
    const base = await createRoot()
    const file = join(base, 'cos.png')
    await writeFile(file, 'plot bytes', 'utf8')
    const observe = createReproductionFileObserver({ allowedImportRoots: [base] })

    const observation = await observe(file)

    expect(observation).toEqual({
      state: 'observed',
      path: file,
      filename: 'cos.png',
      sizeBytes: 10,
      sha256: createHash('sha256').update('plot bytes').digest('hex')
    })
  })

  it('resolves a relative path against the turn base dirs', async () => {
    const base = await createRoot()
    const dataDir = join(base, 'data')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'cos.png'), 'plot bytes', 'utf8')
    const observe = createReproductionFileObserver({
      allowedImportRoots: [base],
      relativeBaseDirs: [dataDir]
    })

    const observation = await observe('cos.png')

    expect(observation.state).toBe('observed')
    expect(observation.filename).toBe('cos.png')
  })

  it('never reads a file outside the authorized roots', async () => {
    const base = await createRoot()
    const outside = await mkdtemp(join(tmpdir(), 'purescience-reproduction-outside-'))
    const file = join(outside, 'cos.png')
    await writeFile(file, 'plot bytes', 'utf8')
    const observe = createReproductionFileObserver({ allowedImportRoots: [base] })

    const observation = await observe(file)

    await rm(outside, { recursive: true, force: true })
    expect(observation.state).toBe('unreadable')
    if (observation.state !== 'unreadable') throw new Error('expected an unreadable observation')
    expect(observation.reason).toBe('not-allowed')
  })

  it('reports a missing file without inventing a hash', async () => {
    const base = await createRoot()
    const observe = createReproductionFileObserver({ allowedImportRoots: [base] })

    const observation = await observe(join(base, 'missing.png'))

    expect(observation.state).toBe('unreadable')
    if (observation.state !== 'unreadable') throw new Error('expected an unreadable observation')
    expect(observation.reason).toBe('not-found')
  })

  it('rejects a directory as not a file', async () => {
    const base = await createRoot()
    const directory = join(base, 'rerun')
    await mkdir(directory)
    const observe = createReproductionFileObserver({ allowedImportRoots: [base] })

    const observation = await observe(directory)

    expect(observation.state).toBe('unreadable')
    if (observation.state !== 'unreadable') throw new Error('expected an unreadable observation')
    expect(observation.reason).toBe('not-a-file')
  })

  it('reports the size of an oversized file instead of hashing it', async () => {
    const base = await createRoot()
    const file = join(base, 'huge.csv')
    await writeFile(file, '', 'utf8')
    await truncate(file, REPRODUCIBILITY_MAX_COMPARE_BYTES + 1)
    const observe = createReproductionFileObserver({ allowedImportRoots: [base] })

    const observation = await observe(file)

    expect(observation.state).toBe('observed')
    if (observation.state !== 'observed') throw new Error('expected an observed file')
    expect(observation.sizeBytes).toBe(REPRODUCIBILITY_MAX_COMPARE_BYTES + 1)
    expect(observation.sha256).toBe('')
  })
})
