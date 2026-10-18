// Housekeeping that has to be safe by construction: deleting bytes nobody references is easy, and deleting bytes
// somebody referenced because the register could not be read is data loss. Every case below is about that line.

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { KnowledgeRepository } from './knowledge-repository'

const digest = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex')

describe('sweeping stored copies', () => {
  let root: string
  let repository: KnowledgeRepository
  const body = 'a page body'

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-sweep-'))
    repository = new KnowledgeRepository({
      root,
      roots: [root],
      urlReader: { read: async (url: string) => ({ body, finalUrl: url }) }
    })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const contents = async (): Promise<string[]> => readdir(join(root, 'knowledge', 'contents'))

  it('deletes a copy no source references and keeps the one that is referenced', async () => {
    await repository.register({ kind: 'url', url: 'https://example.org/kept' })
    const orphan = digest('an old page nobody points at')
    await writeFile(join(root, 'knowledge', 'contents', orphan), 'an old page nobody points at', 'utf8')

    const outcome = await repository.sweepContents()

    expect(outcome.pruned).toEqual([orphan])
    expect(await contents()).toEqual([digest(body)])
  })

  it('aborts on an unreadable register instead of treating it as "nothing is referenced"', async () => {
    await repository.register({ kind: 'url', url: 'https://example.org/kept' })
    const before = await contents()
    // A truncated write, a hand edit, a restore that landed half a file.
    await writeFile(join(root, 'knowledge', 'sources.json'), '{ "sources": [', 'utf8')

    await expect(repository.sweepContents()).rejects.toMatchObject({ code: 'record-unreadable' })

    // The decisive reading: not one copy was deleted on the way to that error.
    expect(await contents()).toEqual(before)
  })

  it('reports an empty sweep when no copies exist yet', async () => {
    expect(await repository.sweepContents()).toEqual({ scanned: 0, pruned: [] })
  })

  it('leaves files it did not write alone', async () => {
    await mkdir(join(root, 'knowledge', 'contents'), { recursive: true })
    await writeFile(join(root, 'knowledge', 'contents', '.DS_Store'), 'junk', 'utf8')

    const outcome = await repository.sweepContents()

    expect(outcome.pruned).toEqual([])
    expect(await contents()).toContain('.DS_Store')
  })
})
