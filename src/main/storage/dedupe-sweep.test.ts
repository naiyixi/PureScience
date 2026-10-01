import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sweepDuplicateContent } from './dedupe-sweep'

let storageRoot: string

const write = async (relativePath: string, content: string): Promise<string> => {
  const target = join(storageRoot, relativePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
  return target
}

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'dedupe-sweep-'))
})

afterEach(async () => {
  await rm(storageRoot, { recursive: true, force: true })
})

describe('sweepDuplicateContent', () => {
  it('links a verified duplicate to the copy already on disk and leaves both readable', async () => {
    const first = await write('uploads/p/s/one.bin', 'duplicated payload')
    const second = await write('uploads/p/s/two.bin', 'duplicated payload')

    const result = await sweepDuplicateContent({ storageRoot })

    expect(result.linked).toBe(1)
    expect(result.bytes).toBe('duplicated payload'.length)
    expect((await stat(second)).ino).toBe((await stat(first)).ino)
    await expect(readFile(first, 'utf8')).resolves.toBe('duplicated payload')
    await expect(readFile(second, 'utf8')).resolves.toBe('duplicated payload')
  })

  it('lets the hash decide: equal size with different bytes is not a duplicate', async () => {
    const first = await write('artifacts/a.bin', 'AAAA')
    const second = await write('artifacts/b.bin', 'BBBB')

    const result = await sweepDuplicateContent({ storageRoot })

    expect(result.linked).toBe(0)
    expect(result.bytes).toBe(0)
    expect(result.distinct).toBe(2)
    expect((await stat(second)).ino).not.toBe((await stat(first)).ino)
    await expect(readFile(first, 'utf8')).resolves.toBe('AAAA')
    await expect(readFile(second, 'utf8')).resolves.toBe('BBBB')
  })

  it('is idempotent: a second pass finds nothing left to reclaim', async () => {
    await write('uploads/p/s/one.bin', 'same')
    await write('uploads/p/s/two.bin', 'same')

    const firstPass = await sweepDuplicateContent({ storageRoot })
    const secondPass = await sweepDuplicateContent({ storageRoot })

    expect(firstPass.linked).toBe(1)
    expect(secondPass.linked).toBe(0)
    // The already-shared name is reported, not silently skipped: the count says what the pass saw.
    expect(secondPass.alreadyShared).toBeGreaterThanOrEqual(1)
  })
})
