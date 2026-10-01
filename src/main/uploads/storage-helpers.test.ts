import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { moveToUniqueUploadFile } from './storage-helpers'

// The move is where uploaded bytes become content, so this is the seam that has to hold: the same bytes
// arriving twice must end up as one inode with two names, not two copies.
let storageRoot: string
let stagingDir: string
let targetDir: string

const stage = async (name: string, content: string): Promise<string> => {
  const path = join(stagingDir, name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  return path
}

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'upload-move-'))
  stagingDir = join(storageRoot, 'uploads', 'staging')
  targetDir = join(storageRoot, 'uploads', 'project', 'session')
  await mkdir(stagingDir, { recursive: true })
  await mkdir(targetDir, { recursive: true })
})

afterEach(async () => {
  await rm(storageRoot, { recursive: true, force: true })
})

describe('moveToUniqueUploadFile', () => {
  it('keeps distinct names for distinct content and deletes the staged source', async () => {
    const staged = await stage('first.part', 'first payload')

    const moved = await moveToUniqueUploadFile(staged, targetDir, 'report.pdf', storageRoot)

    expect(moved.filename).toBe('report.pdf')
    expect(moved.filePath).toBe(join(targetDir, 'report.pdf'))
    expect(await readFile(moved.filePath, 'utf8')).toBe('first payload')
    await expect(stat(staged)).rejects.toThrow()
  })

  it('stores the same bytes arriving twice under two names that share one inode', async () => {
    const first = await moveToUniqueUploadFile(
      await stage('a.part', 'identical payload'),
      targetDir,
      'one.pdf',
      storageRoot
    )
    const second = await moveToUniqueUploadFile(
      await stage('b.part', 'identical payload'),
      targetDir,
      'two.pdf',
      storageRoot
    )

    // Both names still exist and still read correctly...
    expect(second.filename).toBe('two.pdf')
    expect(await readFile(first.filePath, 'utf8')).toBe('identical payload')
    expect(await readFile(second.filePath, 'utf8')).toBe('identical payload')

    // ...and they are one copy of the bytes, not two: the second arrival found the content already on disk.
    const firstInfo = await stat(first.filePath)
    const secondInfo = await stat(second.filePath)
    expect(secondInfo.ino).toBe(firstInfo.ino)
    expect(firstInfo.nlink).toBeGreaterThanOrEqual(2)
  })
})
