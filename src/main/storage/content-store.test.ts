import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { digestOfFile, installContent, measureSpace, pruneUnreferencedContent } from './content-store'

let storageRoot: string

const writeBytes = async (name: string, content: string): Promise<string> => {
  const target = join(storageRoot, name)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
  return target
}

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'content-store-'))
})

afterEach(async () => {
  await rm(storageRoot, { recursive: true, force: true })
})

describe('content store', () => {
  it('gives the first copy a second name without copying the bytes', async () => {
    const first = await writeBytes('uploads/a.bin', 'same bytes')

    expect(await installContent({ path: first, storageRoot })).toBe('registered')

    const digest = await digestOfFile(first)
    const canonical = await stat(join(storageRoot, '.content', digest))
    const uploaded = await stat(first)
    expect(canonical.ino).toBe(uploaded.ino)
    // Two names, one inode: the file gained a canonical name, it did not become two files.
    expect(uploaded.nlink).toBe(2)
  })

  it('points a second copy of the same bytes at the first, and the measurement says so', async () => {
    const first = await writeBytes('uploads/a.bin', 'same bytes')
    const second = await writeBytes('uploads/b.bin', 'different length bytes')

    // Two files with identical bytes, each its own inode: the duplicate the store is there to remove.
    await writeFile(second, 'same bytes')
    const before = await measureSpace({ storageRoot })
    expect((await stat(first)).ino).not.toBe((await stat(second)).ino)

    expect(await installContent({ path: first, storageRoot })).toBe('registered')
    expect(await installContent({ path: second, storageRoot })).toBe('linked')

    expect((await stat(second)).ino).toBe((await stat(first)).ino)
    expect(await readFile(second, 'utf8')).toBe('same bytes')

    const after = await measureSpace({ storageRoot })
    // Exact, measured equation: the second copy's bytes were released, so unique bytes dropped by exactly
    // one copy of the file while the content stayed readable under both names.
    expect(after.uniqueBytes).toBe(before.uniqueBytes - 'same bytes'.length)
    expect(after.totalBytes).toBeGreaterThan(after.uniqueBytes)
    expect(after.linkedFiles).toBeGreaterThanOrEqual(2)
    expect(after.totalBytes - after.uniqueBytes).toBeGreaterThanOrEqual('same bytes'.length)
  })

  it('keeps content alive while one name remains, and drops it once none does', async () => {
    const first = await writeBytes('uploads/a.bin', 'shared')
    const second = await writeBytes('uploads/b.bin', 'shared')
    await installContent({ path: first, storageRoot })
    await installContent({ path: second, storageRoot })

    // One upload still points at the content: pruning must not touch it.
    await rm(first)
    expect(await pruneUnreferencedContent({ storageRoot })).toEqual({ removed: 0, bytes: 0 })
    expect(await readFile(second, 'utf8')).toBe('shared')

    // Last name gone: the canonical file is now unreachable content, and its size comes back as measured bytes.
    await rm(second)
    const pruned = await pruneUnreferencedContent({ storageRoot })
    expect(pruned.removed).toBe(1)
    expect(pruned.bytes).toBe('shared'.length)
    expect(await measureSpace({ storageRoot })).toEqual({
      uniqueBytes: 0,
      totalBytes: 0,
      files: 0,
      linkedFiles: 0
    })
  })

  it('reports that bytes were not deduplicated instead of claiming a link it could not make', async () => {
    const file = await writeBytes('uploads/a.bin', 'bytes')
    // A storage root that cannot hold the content directory: the same shape as a filesystem that refuses
    // hard links. The file must survive untouched and the outcome must say so.
    const blockedRoot = join(storageRoot, 'blocked')
    await mkdir(blockedRoot)
    await writeFile(join(blockedRoot, '.content'), 'not a directory')

    expect(await installContent({ path: file, storageRoot: blockedRoot })).toBe('unavailable')
    expect(await readFile(file, 'utf8')).toBe('bytes')
  })
})
