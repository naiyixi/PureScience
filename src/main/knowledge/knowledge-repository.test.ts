import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { KnowledgeRepository } from './knowledge-repository'
import { KnowledgeValidationError } from '../../shared/knowledge'

// Registration is where a source either carries a re-derivable fingerprint or is refused by name. The
// cases below pin both halves: what a registered entry records, and what happens when it cannot be honest.
describe('KnowledgeRepository', () => {
  let root: string
  let managed: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-'))
    managed = join(root, 'managed')
    await mkdir(managed, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const repository = (): KnowledgeRepository => new KnowledgeRepository({ root, roots: [managed] })

  it('registers a file with its size and content digest', async () => {
    const path = join(managed, 'notes.md')
    await writeFile(path, '# Notes\n\nEverything here is registered.\n', 'utf8')

    const [source] = await repository().register({ kind: 'file', path })

    expect(source?.kind).toBe('file')
    expect(source?.label).toBe('notes.md')
    expect(source?.fingerprint.algorithm).toBe('sha256')
    expect(source?.fingerprint.bytes).toBe(40)
    expect(source?.fingerprint.value).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is idempotent by location: the same file updates instead of duplicating', async () => {
    const path = join(managed, 'notes.md')
    await writeFile(path, 'first', 'utf8')
    const first = await repository().register({ kind: 'file', path })
    await writeFile(path, 'second', 'utf8')

    const repositoryAfter = repository()
    const second = await repositoryAfter.register({ kind: 'file', path })
    const sources = await repositoryAfter.list()

    expect(sources).toHaveLength(1)
    expect(second[0]?.id).toBe(first[0]?.id)
    expect(second[0]?.fingerprint.value).not.toBe(first[0]?.fingerprint.value)
    expect(second[0]?.registeredAt).toBe(first[0]?.registeredAt)
  })

  it('registers every file in a folder as its own entry, and stays at that count on re-registration', async () => {
    await writeFile(join(managed, 'a.md'), 'a', 'utf8')
    await mkdir(join(managed, 'nested'), { recursive: true })
    await writeFile(join(managed, 'nested', 'b.md'), 'b', 'utf8')

    const first = await repository().register({ kind: 'folder', path: managed })
    expect(first).toHaveLength(2)
    expect(first.every((source) => source.folder === managed)).toBe(true)

    const repositoryAfter = repository()
    await repositoryAfter.register({ kind: 'folder', path: managed })
    expect(await repositoryAfter.list()).toHaveLength(2)
    expect((await repositoryAfter.list()).map((source) => source.label).sort()).toEqual([
      'a.md',
      'b.md'
    ])
  })

  it('records where a URL landed and hashes the body, not the URL', async () => {
    const seen: string[] = []
    const repositoryWithUrl = new KnowledgeRepository({
      root,
      roots: [managed],
      urlReader: {
        read: async (url: string) => {
          seen.push(url)
          return { body: 'the page body', finalUrl: 'https://example.com/final' }
        }
      }
    })

    const [source] = await repositoryWithUrl.register({
      kind: 'url',
      url: 'https://example.com/start'
    })

    expect(seen).toEqual(['https://example.com/start'])
    expect(source?.location).toBe('https://example.com/start')
    expect(source?.finalUrl).toBe('https://example.com/final')
    expect(source?.fingerprint.bytes).toBe(13)
    // Same body through a redirect ⇒ same fingerprint: the digest is of the content, so a moved page is the
    // same source rather than a new one.
    const again = await repositoryWithUrl.register({
      kind: 'url',
      url: 'https://example.com/moved'
    })
    expect(again[0]?.fingerprint.value).toBe(source?.fingerprint.value)
  })

  it('refuses a path outside the managed roots by name and writes nothing', async () => {
    const outside = join(root, 'outside.md')
    await writeFile(outside, 'not managed', 'utf8')

    await expect(repository().register({ kind: 'file', path: outside })).rejects.toThrow(
      KnowledgeValidationError
    )
    await expect(repository().register({ kind: 'file', path: outside })).rejects.toMatchObject({
      code: 'source-outside-roots'
    })
    // Zero writes: a refused registration must not have created the store.
    await expect(readFile(join(root, 'knowledge', 'sources.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('names a missing file and a record it cannot read', async () => {
    await expect(
      repository().register({ kind: 'file', path: join(managed, 'nope.md') })
    ).rejects.toMatchObject({
      code: 'source-not-found'
    })

    await mkdir(join(root, 'knowledge'), { recursive: true })
    await writeFile(join(root, 'knowledge', 'sources.json'), '{ not json', 'utf8')
    const overview = await repository().overview()
    expect(overview.unreadable).toBe(true)
    expect(overview.sources).toEqual([])
  })
})
