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

  it('reclaims duplicates inside a category but never links across two of them', async () => {
    // The storage reading walks every category with its OWN dedup set (its stated assumption is that hard
    // links do not cross data-category boundaries), so a link from uploads to artifacts would save bytes
    // the panel's total never credits: the user would read a reclaimed count the number above it cannot
    // confirm. Keeping the link inside one category is what makes the two numbers checkable against each
    // other, which is why the reclaim is reported in the first place.
    const uploadsCopy = await write('uploads/p/s/one.bin', 'cross-category payload')
    const artifactsCopy = await write('artifacts/same.bin', 'cross-category payload')
    const twinA = await write('artifacts/twin-a.bin', 'twinned inside one category')
    const twinB = await write('artifacts/twin-b.bin', 'twinned inside one category')

    const result = await sweepDuplicateContent({ storageRoot })

    // Inside one category: reclaimed in the same pass…
    expect(result.linked).toBe(1)
    expect(result.bytes).toBe('twinned inside one category'.length)
    expect((await stat(twinB)).ino).toBe((await stat(twinA)).ino)
    // …across two categories: left exactly as it was, still readable under both names.
    expect((await stat(artifactsCopy)).ino).not.toBe((await stat(uploadsCopy)).ino)
    await expect(readFile(uploadsCopy, 'utf8')).resolves.toBe('cross-category payload')
    await expect(readFile(artifactsCopy, 'utf8')).resolves.toBe('cross-category payload')
  })
})
