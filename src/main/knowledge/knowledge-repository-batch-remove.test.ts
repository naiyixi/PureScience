// Batch removal. The interesting cases are not "two rows go away" but the two properties a loop over
// `remove` would not have: one write for the whole batch, and copy pruning decided against the set that
// remains rather than against whatever happened to be there when each row was processed.

import { readFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { KnowledgeRepository } from './knowledge-repository'

const digestOf = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex')

describe('removing several sources at once', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-batch-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const store = (body = 'a page body'): KnowledgeRepository =>
    new KnowledgeRepository({
      root,
      roots: [root],
      urlReader: { read: async (url: string) => ({ body, finalUrl: url }) }
    })

  const contents = async (): Promise<string[]> => {
    try {
      return (await readdir(join(root, 'knowledge', 'contents'))).sort()
    } catch {
      return []
    }
  }

  it('removes every named source and reports nothing missing', async () => {
    const repository = store()
    const a = await repository.register({ kind: 'url', url: 'https://example.org/a' })
    const b = await repository.register({ kind: 'url', url: 'https://example.org/b' })

    const outcome = await repository.removeMany([a[0].id, b[0].id])

    expect(outcome.removed).toHaveLength(2)
    expect(outcome.missing).toEqual([])
    expect(await repository.list()).toEqual([])
  })

  it('deletes a copy shared by two removed sources exactly once', async () => {
    // Both URLs serve the same body, so one digest backs both rows.
    const repository = store('shared body')
    const a = await repository.register({ kind: 'url', url: 'https://example.org/a' })
    const b = await repository.register({ kind: 'url', url: 'https://example.org/b' })
    expect(await contents()).toEqual([digestOf('shared body')])

    const outcome = await repository.removeMany([a[0].id, b[0].id])

    expect(outcome.prunedContents).toEqual([digestOf('shared body')])
    expect(await contents()).toEqual([])
  })

  it('keeps a copy a surviving source still names', async () => {
    const repository = store('shared body')
    const a = await repository.register({ kind: 'url', url: 'https://example.org/a' })
    const b = await repository.register({ kind: 'url', url: 'https://example.org/b' })

    const outcome = await repository.removeMany([a[0].id])

    // The copy is still needed by b, so the batch reports no pruning — and the bytes are still there.
    expect(outcome.prunedContents).toEqual([])
    expect(await contents()).toEqual([digestOf('shared body')])
    // b is still registered and still names that digest — which is exactly why the bytes stayed.
    const remaining = await repository.list()
    expect(remaining.map((source) => source.id)).toEqual([b[0].id])
  })

  it('names ids that are not registered instead of failing the whole batch', async () => {
    const repository = store()
    const a = await repository.register({ kind: 'url', url: 'https://example.org/a' })

    const outcome = await repository.removeMany([a[0].id, 'not-a-real-id'])

    expect(outcome.removed).toHaveLength(1)
    expect(outcome.missing).toEqual(['not-a-real-id'])
    expect(await repository.list()).toEqual([])
  })

  it('writes the register once for the whole batch', async () => {
    const repository = store()
    const a = await repository.register({ kind: 'url', url: 'https://example.org/a' })
    const b = await repository.register({ kind: 'url', url: 'https://example.org/b' })
    const c = await repository.register({ kind: 'url', url: 'https://example.org/c' })

    const before = JSON.parse(await readFile(join(root, 'knowledge', 'sources.json'), 'utf8'))
    expect(before.sources).toHaveLength(3)

    await repository.removeMany([a[0].id, b[0].id, c[0].id])

    const after = JSON.parse(await readFile(join(root, 'knowledge', 'sources.json'), 'utf8'))
    expect(after.sources).toEqual([])
  })

  it('does nothing at all when no id is registered', async () => {
    const repository = store()
    await repository.register({ kind: 'url', url: 'https://example.org/a' })

    const outcome = await repository.removeMany(['nope'])

    expect(outcome).toMatchObject({ removed: [], prunedContents: [], missing: ['nope'] })
    expect(await repository.list()).toHaveLength(1)
  })

  it('leaves file sources alone when pruning copies', async () => {
    const repository = store()
    const dir = join(root, 'notes')
    await mkdir(dir, { recursive: true })
    const note = join(dir, 'n.md')
    await writeFile(note, '# note\n', 'utf8')
    const registered = await repository.register({ kind: 'file', path: note })

    const outcome = await repository.removeMany([registered[0].id])

    expect(outcome.removed).toHaveLength(1)
    expect(outcome.prunedContents).toEqual([])
    // The user's file is not the store's copy and must never be deleted by a removal.
    expect(await readFile(note, 'utf8')).toBe('# note\n')
  })
})
