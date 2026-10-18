// Removing a source is two facts: the row leaves the register, and the copy that ONLY it referenced leaves the
// disk. The tests below hold that apart — including the case where two sources carry the same bytes, where
// deleting the file would break the other one's search.

import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { KnowledgeRepository } from './knowledge-repository'

const digestOf = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex')

describe('removing a knowledge source', () => {
  let root: string
  let repository: KnowledgeRepository
  const reader = (
    body: string
  ): { read: (url: string) => Promise<{ body: string; finalUrl: string }> } => ({
    read: async (url: string) => ({ body, finalUrl: url })
  })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-remove-'))
    repository = new KnowledgeRepository({ root, roots: [root], urlReader: reader('shared body') })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const contents = async (): Promise<string[]> => {
    try {
      return await readdir(join(root, 'knowledge', 'contents'))
    } catch {
      return []
    }
  }

  it('drops the row and prunes the copy only it referenced, reporting what was pruned', async () => {
    const [source] = await repository.register({ kind: 'url', url: 'https://example.org/a' })
    expect(await contents()).toEqual([digestOf('shared body')])

    const outcome = await repository.remove(source!.id)

    expect(outcome.removed.id).toBe(source!.id)
    expect(outcome.prunedContents).toEqual([digestOf('shared body')])
    expect(await repository.list()).toEqual([])
    expect(await contents()).toEqual([])
  })

  it('keeps a copy another source still names', async () => {
    // Two URLs that answer with the same bytes: one copy on disk, two rows.
    const [first] = await repository.register({ kind: 'url', url: 'https://example.org/one' })
    const [second] = await repository.register({ kind: 'url', url: 'https://example.org/two' })
    expect(await contents()).toHaveLength(1)

    const outcome = await repository.remove(first!.id)

    expect(outcome.prunedContents).toEqual([])
    expect(await contents()).toEqual([digestOf('shared body')])
    const remaining = await repository.list()
    expect(remaining.map((source) => source.id)).toEqual([second!.id])
  })

  it('never touches the copy store when a local file source is removed', async () => {
    const path = join(root, 'notes.md')
    await writeFile(path, 'local text', 'utf8')
    const [source] = await repository.register({ kind: 'file', path })
    await repository.register({ kind: 'url', url: 'https://example.org/keep' })
    const before = await contents()

    await repository.remove(source!.id)

    expect(await contents()).toEqual(before)
    expect((await repository.list()).map((row) => row.kind)).toEqual(['url'])
  })

  it('refuses an id it does not know, by name', async () => {
    await expect(repository.remove('not-a-source')).rejects.toMatchObject({
      code: 'source-not-found'
    })
  })
})
